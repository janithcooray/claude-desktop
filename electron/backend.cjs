// In-process HTTP backend. Replaces the previous claude-api subprocess.
//
// Implements the minimum API the renderer expects:
//   GET    /health
//   POST   /sessions
//   GET    /sessions/:id
//   DELETE /sessions/:id
//   POST   /sessions/:id/upload        raw body, X-Filename header, one file
//   GET    /sessions/:id/files/:path*  stream file from the session sandbox
//   POST   /sessions/:id/messages      JSON { prompt }, SSE response
//
// The SSE stream emits the same event names the renderer already parses:
//   session        { claudeSessionId }
//   assistant_text { text }
//   file_event     { path, kind, url? }
//   end            { exitCode }
//   error          { message }
//
// The `claude` CLI is spawned per turn with --output-format stream-json, and
// its stdout is parsed and translated into the SSE events above. Per-chat
// continuity is preserved via --resume with the session_id reported by the
// CLI's first `system/init` event.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const { detectSandbox, wrapWithSandbox } = require('./sandbox.cjs');
const plugins = require('./plugins.cjs');
const approval = require('./approval.cjs');

// Filled in by startBackend() once we've grabbed a port. The approval MCP
// shim (spawned inside the sandbox by the Claude CLI) needs to know it so it
// can POST decisions back to /approval/request.
let BACKEND_PORT = 0;

// Absolute path to the stdio MCP shim that fronts the approval broker. We
// bind-mount the directory containing it into the sandbox so the spawned CLI
// can `node <path>` it. In packaged builds the shim is asar-unpacked (see
// package.json's build.asarUnpack) so spawn can read it as a real file.
const APPROVAL_MCP_PATH = path.join(__dirname, 'approval-mcp.cjs').replace(
  `${path.sep}app.asar${path.sep}`,
  `${path.sep}app.asar.unpacked${path.sep}`,
);
const APPROVAL_MCP_DIR = path.dirname(APPROVAL_MCP_PATH);
const APPROVAL_TOOL_NAME = 'mcp__cowork-approval__prompt';

const ALLOWED_TOOLS_DEFAULT = 'Read,Write,Edit,Bash,Glob,Grep';
const PERMISSION_MODE_DEFAULT = 'acceptEdits';

// In 'chat' mode Claude should behave like a general-purpose assistant, not a
// coding agent. Block everything that touches the host filesystem or runs
// commands, but leave basic retrieval tools (web search / fetch) in place so
// Claude can actually answer "nearest barista in Colombo", cite fresh news,
// render an image reference, etc.
const CHAT_MODE_DISALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'Bash', 'BashOutput', 'KillBash',
  'Glob', 'Grep', 'Task',
].join(',');

// Which tools chat mode explicitly allows. Keeping this small and auditable.
// WebSearch and WebFetch cover the vast majority of "general assistant"
// queries; TodoWrite is a scratchpad tool that can't reach outside Claude.
const CHAT_MODE_ALLOWED_TOOLS = 'WebSearch,WebFetch,TodoWrite';

// System prompt appended in chat mode. Reframes Claude away from Claude Code's
// default "software engineering assistant" persona — users on the Chat tab are
// here for general help, not code review. `--append-system-prompt` is additive
// so Claude Code's safety rules and structured-output rules still apply.
const CHAT_MODE_APPEND_SYSTEM_PROMPT = [
  'You are a general-purpose assistant in this conversation, not a software engineering assistant.',
  'Help with any topic the user asks about — travel, cooking, writing, math, trivia, local recommendations, current events — not just coding.',
  'You have WebSearch and WebFetch tools. Use WebSearch proactively for anything location-specific, time-sensitive, or involving real businesses, prices, opening hours, news, or current events.',
  'You do not have access to the user\'s filesystem or a shell in this mode; don\'t offer to run commands or edit files here. If the user needs those, they can switch to a Cowork chat.',
  'Be concise by default; expand when the question warrants it. Use Markdown sparingly and only when it genuinely aids readability.',
].join(' ');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function guessMime(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const m = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', json: 'application/json', html: 'text/html',
    css: 'text/css', js: 'application/javascript', mjs: 'application/javascript',
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv',
    yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml',
  };
  return m[ext] || 'application/octet-stream';
}

function safeRelInSandbox(cwd, rel) {
  const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(cwd, rel);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  const out = path.relative(root, abs);
  // POSIX-style forward slashes for URL paths
  return out.split(path.sep).join('/');
}

// Directories we never descend into when snapshotting a user-picked folder.
// Keeps the pre/post-turn diff fast even on real projects.
const SNAPSHOT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv',
  '.mypy_cache', '.pytest_cache', '.cache', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'out', 'target', '.gradle', '.idea', '.vscode',
]);
const SNAPSHOT_MAX_FILES = 5000;

function snapshotFiles(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  const walk = (dir, base) => {
    if (map.size >= SNAPSHOT_MAX_FILES) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (SNAPSHOT_IGNORE_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const rel = base ? `${base}/${name}` : name;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, rel);
      else map.set(rel, { mtime: st.mtimeMs, size: st.size });
      if (map.size >= SNAPSHOT_MAX_FILES) return;
    }
  };
  walk(root, '');
  return map;
}

// ---------- session registry ----------

// Map<string, { id, cwd, managed, createdAt, claudeSessionId? }>
//   managed === true  → backend created the dir, DELETE should rm it
//   managed === false → user picked an existing folder, DELETE leaves it alone
const sessions = new Map();

// Map<clientRef, { cwd, addDirs }> — lightweight chat→roots registry the
// renderer populates whenever a chat becomes active. Lets the chat-keyed
// file route (`/chats/:clientRef/files/...`) resolve files that live under
// user-attached folders *without* requiring a live CLI session. Cleared on
// every backend restart (the renderer re-registers on chat switch).
const chatRoots = new Map();

// ---------- tiny response helpers ----------

function end(res, code, body) {
  res.statusCode = code;
  if (body !== undefined) res.end(body); else res.end();
}
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---------- claude CLI streaming ----------

// Detect whether the user appears to be signed in to the `claude` CLI.
// The CLI stores credentials somewhere under ~/.claude (path/name varies
// by version and platform). We best-effort scan for a credentials-looking
// file and report what we found. Nothing here is authoritative — the real
// test is whether a turn actually completes — but it's enough for a
// Settings page heads-up.
function detectLoginState() {
  const home = process.env.HOME || '';
  if (!home) return { status: 'unknown', detail: 'HOME not set' };
  const dir = path.join(home, '.claude');
  let dirExists = false;
  try { dirExists = fs.statSync(dir).isDirectory(); } catch {}
  if (!dirExists) {
    return { status: 'logged_out', detail: `${dir} does not exist` };
  }
  const probes = [
    '.credentials.json', 'credentials.json', 'credentials',
    'auth.json', 'session.json',
  ];
  for (const name of probes) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) {
        return { status: 'logged_in', detail: p };
      }
    } catch {}
  }
  // Dir exists but no obvious credentials file — the CLI may keep them in
  // the macOS keychain (Claude Code on macOS does this). Treat as a soft
  // "maybe" rather than either extreme.
  return { status: 'unknown', detail: `${dir} exists but no credentials file found (may be in keychain)` };
}

function getClaudeVersion(bin) {
  return runClaude(bin, ['--version'], { timeoutMs: 3000 }).then((r) =>
    r.ok
      ? { ok: true, version: r.stdout.trim() || r.stderr.trim() }
      : { ok: false, error: (r.stderr || r.stdout).trim() || `exit ${r.code}` },
  );
}

// Generic wrapper around `claude <args>` that collects stdout/stderr and
// enforces a timeout. Used for short one-shot introspection calls (version,
// auth status, /usage via -p, etc.). Intentionally doesn't touch the
// streaming/sse machinery — those stay specific to the chat turn.
function runClaude(bin, args, { timeoutMs = 15000, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: '', error: err.message });
    }
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(killer);
      resolve({ ok: false, code: -1, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({
        ok: code === 0,
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

// `claude auth status` — JSON by default. Returns { loggedIn, raw, parsed, error }.
// Exits 0 if logged in, 1 if not; we use the exit code as the source of truth
// and pass through whatever JSON we can parse alongside the raw text output.
async function getAuthStatus() {
  const bin = resolveClaudeBin();
  let binExists = false;
  try { binExists = fs.statSync(bin).isFile(); } catch {}
  if (!binExists) {
    return { bin, binExists: false, loggedIn: false, raw: null, parsed: null, error: 'claude binary not found' };
  }
  const r = await runClaude(bin, ['auth', 'status'], { timeoutMs: 8000 });
  const raw = (r.stdout || '').trim();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
  return {
    bin,
    binExists: true,
    loggedIn: r.code === 0,
    raw,
    parsed,
    stderr: (r.stderr || '').trim() || null,
    exitCode: r.code,
    error: r.error || null,
  };
}

// ---------- MCP registry --------------------------------------------------
//
// The official registry at https://registry.modelcontextprotocol.io publishes
// a paginated list of servers. We fetch it from the Electron main process so
// the renderer isn't subject to CORS, and keep a short in-memory cache so
// re-opening the Settings tab doesn't hammer the API.
//
// Response fields we care about (per server object):
//   name, title, description, version, websiteUrl
//   repository.url (when backed by a git repo; used for GitHub avatar icon)
//   _meta.io.modelcontextprotocol.registry/official.isLatest
//
// We paginate through `nextCursor` until exhausted or until a safety cap is
// hit, then dedupe to the latest version of each server and normalise to a
// small shape the renderer can render without knowing the schema.

const MCP_REGISTRY_BASE = 'https://registry.modelcontextprotocol.io/v0';
const MCP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let mcpCache = { at: 0, servers: null };

function httpsGetJson(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'cowork-desktop' } }, (r) => {
      if (r.statusCode !== 200) {
        r.resume();
        return reject(new Error(`HTTP ${r.statusCode} for ${url}`));
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout fetching ${url}`)); });
  });
}

// Pull every page of /v0/servers. `max` caps total servers returned to keep
// initial load snappy; the registry has thousands of entries and the UI
// currently just lists them — we don't need them all at once.
async function fetchAllMcpServers({ max = 500 } = {}) {
  const out = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 20; // safety net against cursor loops
  while (pages < MAX_PAGES) {
    const url = new URL(`${MCP_REGISTRY_BASE}/servers`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await httpsGetJson(url.toString());
    const list = Array.isArray(page?.servers) ? page.servers : [];
    for (const entry of list) {
      out.push(entry);
      if (out.length >= max) return out;
    }
    cursor = page?.metadata?.nextCursor || null;
    pages += 1;
    if (!cursor || list.length === 0) break;
  }
  return out;
}

// GitHub avatar URL for a `https://github.com/<org>/<repo>` repository.
// Works without auth and returns an image even if the org doesn't have a
// custom logo (default octocat-style placeholder).
function iconFromRepoUrl(repoUrl) {
  if (!repoUrl) return null;
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== 'github.com') return null;
    const [org] = u.pathname.replace(/^\//, '').split('/');
    if (!org) return null;
    return `https://github.com/${encodeURIComponent(org)}.png?size=64`;
  } catch { return null; }
}

// Normalise one registry entry to the shape the renderer consumes. Collapses
// the nested `server` + `_meta` structure into a flat card-friendly object
// that carries enough fields for both the list row AND the detail view
// (remotes, packages, env vars). Unknown/missing fields become null/[] so
// the renderer can cleanly conditionally render each block.
function normaliseServer(entry) {
  const s = entry?.server || {};
  const repo = s?.repository || null;
  const repoUrl = repo?.url || null;
  const latest = !!entry?._meta?.['io.modelcontextprotocol.registry/official']?.isLatest;
  // Keep only the fields we actually render; dropping everything else keeps
  // the response small (the registry emits a lot of schema scaffolding we
  // don't need in the UI).
  const remotes = Array.isArray(s.remotes) ? s.remotes.map((r) => ({
    type: r.type || null,
    url: r.url || null,
  })) : [];
  const packages = Array.isArray(s.packages) ? s.packages.map((p) => ({
    registryType: p.registryType || null,
    identifier: p.identifier || null,
    version: p.version || null,
    runtimeHint: p.runtimeHint || null,
    transport: p.transport?.type || null,
    environmentVariables: Array.isArray(p.environmentVariables) ? p.environmentVariables.map((e) => ({
      name: e.name,
      description: e.description || '',
      isRequired: !!e.isRequired,
      isSecret: !!e.isSecret,
    })) : [],
  })) : [];
  return {
    name: s.name || '(unnamed)',
    title: s.title || null,
    description: s.description || '',
    version: s.version || null,
    websiteUrl: s.websiteUrl || null,
    repoUrl,
    repoSource: repo?.source || null,
    iconUrl: iconFromRepoUrl(repoUrl),
    latest,
    remotes,
    packages,
  };
}

async function getMcpRegistryServers({ force = false } = {}) {
  const now = Date.now();
  if (!force && mcpCache.servers && (now - mcpCache.at) < MCP_CACHE_TTL_MS) {
    return { servers: mcpCache.servers, cachedAt: mcpCache.at };
  }
  const raw = await fetchAllMcpServers({ max: 500 });
  // Keep only the latest version of each server name — the registry returns
  // one entry per published version, so the same server often appears 3-5x.
  const latestByName = new Map();
  for (const entry of raw) {
    const norm = normaliseServer(entry);
    if (!norm.name) continue;
    const existing = latestByName.get(norm.name);
    if (!existing || (norm.latest && !existing.latest)) {
      latestByName.set(norm.name, norm);
    }
  }
  const servers = Array.from(latestByName.values())
    .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
  mcpCache = { at: now, servers };
  return { servers, cachedAt: now };
}

// ---------- Cowork-supported MCP catalog + install -----------------------
//
// Cowork maintains its own vetted subset of the MCP ecosystem in
// `website/supported-mcp-servers.json`. The full public registry is huge and
// unvetted; this curated list is what we actually know how to install and
// configure end-to-end via the UI.
//
// HOW COWORK TALKS TO AN INSTALLED MCP SERVER
// -------------------------------------------
// Installing a server boils down to writing one entry under
// `mcpServers.<id>` in the user's ~/.claude.json. The Claude CLI reads that
// file every time Cowork spawns it (once per chat turn), auto-connects to
// each configured server, and exposes the server's tools to the model:
//
//   stdio servers   — CLI spawns <command> <args...> with the provided env
//                     and speaks JSON-RPC over stdin/stdout.
//   http servers    — CLI opens a streamable HTTP connection to <url>,
//                     attaching any configured headers (e.g. bearer token).
//
// Our sandbox must allow whatever the server needs: outbound HTTPS for http
// servers (DNS fix + open net namespace — already in place), and the server
// command's binary chain for stdio servers (the sandbox already exposes
// /usr/bin + the claude chain; we'll extend it as we pick up stdio entries).
//
// AUTH / PARAMS
// -------------
// Each curated entry declares:
//   params[] — runtime values (paths, project names, …) substituted into
//              `{placeholder}` tokens inside spec.args. `expand: "split"`
//              splits a comma-separated value into multiple args.
//   env[]    — environment variables, typically API keys / tokens. Values
//              are written into spec.env and passed to the child process.
//              `isSecret` hints the UI to use a password input.
//
// We only store env values on disk inside ~/.claude.json, which is owned
// mode 0600 by the user — the same file the CLI already keeps credentials
// in. We never transmit env values to our backend beyond the install call.

const CURATED_PATH = path.join(__dirname, '..', 'website', 'supported-mcp-servers.json');

// Where user-level MCP config lives. Claude Code reads ~/.claude.json on
// startup and each child spawn; writing there is how we "install" a server.
function claudeJsonPath() {
  return path.join(os.homedir(), '.claude.json');
}

function readCuratedCatalog() {
  const raw = fs.readFileSync(CURATED_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
  return { version: parsed.version || 1, updatedAt: parsed.updatedAt || null, servers };
}

function readClaudeJson() {
  try {
    const raw = fs.readFileSync(claudeJsonPath(), 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function writeClaudeJson(cfg) {
  const p = claudeJsonPath();
  const body = JSON.stringify(cfg, null, 2) + '\n';
  // Tight perms — the file can contain API keys.
  fs.writeFileSync(p, body, { mode: 0o600 });
}

// List MCP servers currently configured in ~/.claude.json. Annotates each
// with the curated metadata (title, description, icon) when we recognise
// the id, so the UI can render a consistent row whether or not the entry
// came through Cowork.
function listInstalledMcpServers() {
  const cfg = readClaudeJson();
  const servers = cfg?.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  let curatedById = new Map();
  try {
    const { servers: cList } = readCuratedCatalog();
    curatedById = new Map(cList.map((s) => [s.id, s]));
  } catch { /* curated JSON missing is non-fatal */ }
  const out = [];
  for (const [id, spec] of Object.entries(servers)) {
    const curated = curatedById.get(id) || null;
    out.push({
      id,
      name: curated?.name || id,
      description: curated?.description || null,
      iconUrl: curated?.iconUrl || null,
      transport: spec?.type || (spec?.url ? 'http' : (spec?.command ? 'stdio' : 'unknown')),
      url: spec?.url || null,
      command: spec?.command || null,
      curated: !!curated,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Substitute `{paramKey}` placeholders in the spec's args with values from
// the install form. `params[].expand === 'split'` turns a single field into
// multiple positional args (e.g. the filesystem server's allowed paths).
function materialiseSpec(curated, paramValues, envValues) {
  const base = JSON.parse(JSON.stringify(curated.spec || {}));
  const paramsDef = Array.isArray(curated.params) ? curated.params : [];
  const envDef = Array.isArray(curated.env) ? curated.env : [];

  if (Array.isArray(base.args)) {
    const expanded = [];
    for (const arg of base.args) {
      if (typeof arg !== 'string') { expanded.push(arg); continue; }
      const m = /^\{([a-zA-Z0-9_]+)\}$/.exec(arg);
      if (!m) { expanded.push(arg); continue; }
      const key = m[1];
      const def = paramsDef.find((p) => p.key === key);
      const v = paramValues?.[key];
      if (v == null || v === '') {
        if (def?.required) throw new Error(`missing required param: ${key}`);
        continue;
      }
      if (def?.expand === 'split') {
        for (const piece of String(v).split(',').map((s) => s.trim()).filter(Boolean)) {
          expanded.push(piece);
        }
      } else {
        expanded.push(String(v));
      }
    }
    base.args = expanded;
  }

  const env = {};
  for (const e of envDef) {
    const v = envValues?.[e.key];
    if (v == null || v === '') {
      if (e.required) throw new Error(`missing required env: ${e.key}`);
      continue;
    }
    env[e.key] = String(v);
  }
  if (Object.keys(env).length) base.env = env;

  return base;
}

function installCuratedMcpServer(id, paramValues, envValues) {
  const { servers } = readCuratedCatalog();
  const curated = servers.find((s) => s.id === id);
  if (!curated) throw new Error(`unknown curated server id: ${id}`);
  const spec = materialiseSpec(curated, paramValues || {}, envValues || {});
  const cfg = readClaudeJson();
  cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
  cfg.mcpServers[id] = spec;
  writeClaudeJson(cfg);
  return { id, spec };
}

function uninstallMcpServer(id) {
  const cfg = readClaudeJson();
  if (!cfg.mcpServers || !(id in cfg.mcpServers)) return { id, removed: false };
  delete cfg.mcpServers[id];
  writeClaudeJson(cfg);
  return { id, removed: true };
}

// Claude Code's tool gate prompts on first use of any tool not in
// --allowed-tools — including MCP tools exposed as `mcp__<id>__<name>`.
// Cowork runs headless, so a prompt = a dead turn. We read the live list of
// installed MCP servers before every spawn and auto-allow all their tools
// by emitting one `mcp__<id>` entry per server (the CLI treats that prefix
// as "all tools from this server").
function installedMcpAllowEntries() {
  try {
    const cfg = readClaudeJson();
    const servers = cfg?.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    return Object.keys(servers).map((id) => `mcp__${id}`);
  } catch {
    return [];
  }
}

// Is Docker installed and reachable? We try `docker version --format json`
// first — that succeeds only when the daemon is running, which is the state
// we actually care about (installed-but-not-running gives confusing errors
// deep inside the spawn chain). Falls back to `--version` so we can at least
// report "installed but daemon down".
async function getDockerStatus() {
  // Probe with a short timeout so a hung daemon doesn't hang the whole UI.
  const running = await runClaude('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 4000 });
  if (running.ok) {
    return {
      installed: true,
      running: true,
      serverVersion: (running.stdout || '').trim() || null,
      clientVersion: null,
      error: null,
    };
  }
  // Daemon not running — try `docker --version` which only needs the client
  // binary on PATH. If that works we at least know Docker is installed.
  const client = await runClaude('docker', ['--version'], { timeoutMs: 4000 });
  if (client.ok) {
    const m = (client.stdout || '').match(/Docker version ([\w.+-]+)/i);
    return {
      installed: true,
      running: false,
      serverVersion: null,
      clientVersion: m ? m[1] : (client.stdout || '').trim(),
      error: (running.stderr || '').trim() || 'Docker daemon is not running.',
    };
  }
  return {
    installed: false,
    running: false,
    serverVersion: null,
    clientVersion: null,
    error: (client.stderr || client.error || 'docker not found on PATH').trim(),
  };
}

// The /cost /usage /stats slash commands are TUI features — they don't have
// top-level subcommand equivalents. Best effort: run `claude -p "/<cmd>"` in
// a managed empty cwd and capture whatever it prints. Output format isn't
// documented; callers should treat this as raw text and just display it.
// `name` is one of 'cost', 'usage', 'stats'.
async function getUsageBlob(name, { sandboxRoot }) {
  const bin = resolveClaudeBin();
  let binExists = false;
  try { binExists = fs.statSync(bin).isFile(); } catch {}
  if (!binExists) {
    return { ok: false, name, text: '', error: 'claude binary not found' };
  }
  // The slash commands want a fresh context; spin up a throwaway cwd.
  const cwd = path.join(sandboxRoot, `usage-${name}-${Date.now()}`);
  try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
  // Force plain output: no colour, no interactive TUI, stream-json so we can
  // parse assistant_text events out the other side. `-p` drops straight to
  // non-interactive, `--output-format text` asks for a plain stdout.
  const env = {
    ...process.env,
    NO_COLOR: '1',
    TERM: 'dumb',
    FORCE_COLOR: '0',
    NODE_DISABLE_COLORS: '1',
  };
  const args = ['-p', `/${name}`, '--output-format', 'text'];
  const r = await runClaude(bin, args, { timeoutMs: 20000, env, cwd });
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  const text = (r.stdout || '').trim();
  return {
    ok: r.code === 0 && !!text,
    name,
    text,
    stderr: (r.stderr || '').trim() || null,
    exitCode: r.code,
    timedOut: !!r.timedOut,
    error: r.error || null,
  };
}

async function getClaudeInfo() {
  const bin = resolveClaudeBin();
  let binExists = false;
  try { binExists = fs.statSync(bin).isFile(); } catch {}
  const version = binExists ? await getClaudeVersion(bin) : { ok: false, error: 'bin not found' };
  const login = detectLoginState();
  return {
    bin,
    binExists,
    version: version.ok ? version.version : null,
    versionError: version.ok ? null : version.error,
    login,
  };
}

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // GUI-launched Electron on macOS has a stripped PATH; fall back to common
  // install locations before giving up.
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(process.env.HOME || '', '.claude/bin/claude'),
    path.join(process.env.HOME || '', '.local/bin/claude'),
    path.join(process.env.HOME || '', '.npm-global/bin/claude'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return 'claude'; // last resort — let spawn search $PATH
}

// Run the official `claude` installer, streaming stdout/stderr over SSE so the
// Settings UI can show progress live. The one-liner is documented at
// https://claude.ai/install and writes the binary to ~/.claude/bin/claude (or
// similar) — we just pipe its output through and re-check /info when done.
function streamInstallClaude(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try { res.flushHeaders?.(); } catch {}
  try { res.socket?.setNoDelay(true); } catch {}
  try { res.socket?.setKeepAlive(true); } catch {}

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client gone */ }
  };

  send('open', { at: Date.now() });
  send('log', { line: '$ curl -fsSL https://claude.ai/install.sh | bash\n' });

  // Use bash with pipefail so a curl failure surfaces as a non-zero exit.
  // Passing through HOME/PATH keeps the installer happy on macOS where the
  // Electron GUI process has a minimal environment.
  const env = {
    ...process.env,
    // The installer itself uses these to decide where to drop the binary.
    HOME: process.env.HOME || '',
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    // Prevent the installer from opening an interactive prompt.
    CI: '1',
    DEBIAN_FRONTEND: 'noninteractive',
  };

  let child;
  try {
    child = spawn(
      'bash',
      ['-lc', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    send('error', { message: `Failed to launch installer: ${err.message}` });
    send('end', { exitCode: -1 });
    res.end();
    return;
  }

  child.stdout.on('data', (c) => send('log', { line: c.toString('utf8') }));
  child.stderr.on('data', (c) => send('log', { line: c.toString('utf8') }));

  child.on('error', (err) => {
    send('error', { message: `Installer error: ${err.message}` });
  });

  child.on('close', async (code) => {
    // Re-resolve the binary so the caller can show the new version without a
    // separate /info round-trip. We swallow errors here — the SSE `end` frame
    // plus exit code is enough for the UI to decide what to show.
    let info = null;
    try { info = await getClaudeInfo(); } catch { /* ignore */ }
    send('end', { exitCode: code ?? -1, info });
    res.end();
  });
}

// Launch a real terminal window running `claude` so the user can complete the
// interactive OAuth login. We don't attempt to pipe auth through our own UI —
// the CLI wants a TTY for the prompt exchange, and spawning Terminal.app (or
// the platform equivalent) is the shortest path that actually works.
//
// `opts.hint` is an optional one-line banner printed above the CLI invocation
// (used by the Claude Code settings button to nudge the user to type /config).
// `opts.args` is an optional argv to pass to the CLI (e.g. `['auth','login']`
// to skip the general TUI onboarding and go straight to the OAuth flow).
function openClaudeTerminal(res, opts = {}) {
  const bin = resolveClaudeBin();
  const platform = process.platform;

  // Build a small shell snippet: run the CLI, pause on exit so the user sees
  // any error messages before the window closes.
  const hint = opts.hint
    ? `echo; echo '${String(opts.hint).replace(/'/g, "'\\''")}'; echo;`
    : '';
  const argv = Array.isArray(opts.args) && opts.args.length
    ? ' ' + opts.args.map(shellQuote).join(' ')
    : '';
  const cmd = `${hint}${shellQuote(bin)}${argv} || true; echo; echo '[press return to close]'; read _`;

  let child;
  let detail = '';
  try {
    if (platform === 'darwin') {
      // AppleScript runs `osascript` which tells Terminal.app to open a new
      // window with our command. Escape any double-quotes inside `cmd` for
      // AppleScript's string literal.
      const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "Terminal" to activate\n` +
        `tell application "Terminal" to do script "${escaped}"`;
      child = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
      detail = 'Terminal.app';
    } else if (platform === 'win32') {
      // `start` opens a new cmd window; /k keeps it open so the user can type.
      child = spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', cmd], {
        stdio: 'ignore', detached: true, windowsHide: false,
      });
      detail = 'Command Prompt';
    } else {
      // Linux: try common terminal emulators in order. First one present on
      // $PATH wins. `spawn` doesn't throw synchronously when the binary is
      // missing — it emits an async `error` event — so we must probe $PATH
      // ourselves instead of relying on try/catch around `spawn`.
      const attempts = [
        ['x-terminal-emulator', ['-e', 'bash', '-lc', cmd]],
        ['gnome-terminal', ['--', 'bash', '-lc', cmd]],
        ['konsole', ['-e', 'bash', '-lc', cmd]],
        ['alacritty', ['-e', 'bash', '-lc', cmd]],
        ['kitty', ['bash', '-lc', cmd]],
        ['xfce4-terminal', ['-e', `bash -lc ${shellQuote(cmd)}`]],
        ['xterm', ['-e', 'bash', '-lc', cmd]],
      ];
      let launched = false;
      for (const [prog, args] of attempts) {
        if (!onPath(prog)) continue;
        try {
          child = spawn(prog, args, { stdio: 'ignore', detached: true });
          detail = prog;
          launched = true;
          break;
        } catch { /* try next */ }
      }
      if (!launched) {
        return json(res, 500, {
          ok: false,
          error: 'No terminal emulator found. Please run `claude` from a shell to sign in.',
        });
      }
    }
    try { child.unref?.(); } catch {}
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }

  return json(res, 200, { ok: true, terminal: detail, bin });
}

// Quote a path for inclusion inside a shell double-quoted string.
function shellQuote(s) {
  if (!s) return '""';
  return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
}

// Return true if `prog` resolves to an executable on $PATH. Used to probe for
// terminal emulators without relying on spawn's async ENOENT behaviour.
function onPath(prog) {
  const p = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of p.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, prog + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return true;
      } catch { /* keep searching */ }
    }
  }
  return false;
}

function startClaude({ prompt, cwd, resumeId, mode, model, addDirs, permissionMode, allowedTools, disallowedTools, shellMode, dockerImage, sessionId }) {
  const bin = resolveClaudeBin();
  // Jailbroken mode: flip the defaults to "no guardrails" before the normal
  // flag assembly below runs. The user's explicit per-session overrides still
  // win — that way they can jailbreak globally but dial it back on one chat.
  const sm = shellMode === 'docker' || shellMode === 'jailbroken' ? shellMode : 'default';
  if (sm === 'jailbroken' && mode !== 'chat') {
    if (!permissionMode) permissionMode = 'bypassPermissions';
    if (!allowedTools) allowedTools = '*';
  }

  const claudeArgs = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  // Per-session overrides win over env vars which win over hardcoded defaults.
  const effAllowed = (allowedTools && allowedTools.trim())
    || process.env.ALLOWED_TOOLS
    || ALLOWED_TOOLS_DEFAULT;
  const effPerm = (permissionMode && permissionMode.trim())
    || process.env.PERMISSION_MODE
    || PERMISSION_MODE_DEFAULT;
  const effDisallowed = disallowedTools && disallowedTools.trim() ? disallowedTools.trim() : null;
  // Fold in the user's installed MCP servers so their tools don't trigger a
  // permission prompt on first use. Cowork can't surface those prompts, so
  // any gated MCP call would hang the turn forever. Conversational Q&A from
  // the model isn't affected — only the CLI's tool-gate prompts are.
  const mcpAllow = installedMcpAllowEntries();
  const withMcp = (base) => mcpAllow.length
    ? [base, ...mcpAllow].filter(Boolean).join(',')
    : base;
  if (mode === 'chat') {
    // General-purpose assistant: a tight allow-list of retrieval tools, plus
    // an explicit disallow-list for everything filesystem / shell related.
    // We also reframe the persona so Claude stops introducing itself as a
    // software engineering assistant.
    claudeArgs.push('--allowed-tools', withMcp(CHAT_MODE_ALLOWED_TOOLS));
    claudeArgs.push('--disallowed-tools', CHAT_MODE_DISALLOWED_TOOLS);
    claudeArgs.push('--append-system-prompt', CHAT_MODE_APPEND_SYSTEM_PROMPT);
  } else {
    claudeArgs.push('--allowed-tools', withMcp(effAllowed));
    claudeArgs.push('--permission-mode', effPerm);
    if (effDisallowed) claudeArgs.push('--disallowed-tools', effDisallowed);
    // Extra working folders the user attached. The CLI's --add-dir flag widens
    // the allow-list of paths Read/Edit/Bash can touch beyond cwd. We pass it
    // once per dir; chat mode skips this since it has no FS access anyway.
    for (const d of (addDirs || [])) {
      if (d && typeof d === 'string') claudeArgs.push('--add-dir', d);
    }
    // Wire the user-approval gate. When the model tries to use a tool that
    // isn't covered by --allowed-tools (Bash with a fresh command, Write to a
    // new path, an MCP tool the user hasn't pre-allowed, …), the CLI calls
    // this MCP tool instead of dying or silently auto-allowing. The shim
    // POSTs to /approval/request, the broker pops a Cowork modal + native DE
    // notification, the user clicks Allow/Deny, and the answer flows back to
    // the CLI. See electron/approval.cjs and electron/approval-mcp.cjs for
    // the full architecture.
    //
    // We only do this in non-chat modes. Chat mode's tool surface is fixed
    // (allow=WebSearch/WebFetch/TodoWrite, disallow=everything else) so a
    // permission gate would never fire there anyway.
    //
    // Docker shell mode is excluded because the shim runs inside the
    // container — `127.0.0.1:<BACKEND_PORT>` from there points at the
    // container, not the host backend, so the POST would fail. Docker users
    // already opt into looser tooling; this is a known gap to revisit if
    // docker mode becomes mainstream.
    if (BACKEND_PORT && sm !== 'docker' && fs.existsSync(APPROVAL_MCP_PATH)) {
      const mcpConfig = {
        mcpServers: {
          'cowork-approval': {
            type: 'stdio',
            command: 'node',
            args: [APPROVAL_MCP_PATH],
            env: {
              COWORK_BACKEND_PORT: String(BACKEND_PORT),
              COWORK_BACKEND_HOST: '127.0.0.1',
              ...(sessionId ? { COWORK_SESSION_ID: sessionId } : {}),
            },
          },
        },
      };
      claudeArgs.push('--mcp-config', JSON.stringify(mcpConfig));
      claudeArgs.push('--permission-prompt-tool', APPROVAL_TOOL_NAME);
    } else if (!fs.existsSync(APPROVAL_MCP_PATH)) {
      process.stderr.write(
        `[claude] WARNING: approval MCP shim missing at ${APPROVAL_MCP_PATH}; permission prompts will hang turns\n`,
      );
    }
  }
  if (model) claudeArgs.push('--model', model);
  if (resumeId) claudeArgs.push('--resume', resumeId);

  // Log what we're actually running so failures are diagnosable.
  const mcpTag = mcpAllow.length ? ` mcp=[${mcpAllow.join(',')}]` : '';
  const toolPolicy = mode === 'chat'
    ? `allowed=${withMcp(CHAT_MODE_ALLOWED_TOOLS)} disallowed=${CHAT_MODE_DISALLOWED_TOOLS}${mcpTag}`
    : `allowed-tools=${withMcp(effAllowed)} permission-mode=${effPerm}` +
      (effDisallowed ? ` disallowed-tools=${effDisallowed}` : '') + mcpTag;
  process.stderr.write(
    `[claude] spawn shell=${sm} bin=${bin} cwd=${cwd} mode=${mode} model=${model || '-'} ` +
    `resume=${resumeId || '-'} addDirs=${(addDirs || []).length} ${toolPolicy}\n`
  );

  // Hint the child (and any node-based subtools it spawns) to avoid block
  // buffering on stdout. Without this, `claude` can hold an entire turn's
  // worth of stream-json output in its pipe buffer and only flush at the end —
  // which presents to the user as a long pause followed by everything at once.
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    NODE_DISABLE_COLORS: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
  };

  if (sm === 'docker') {
    // Wrap the whole invocation in `docker run`. Requirements on the image:
    //   1. It has `claude` on $PATH.
    //   2. Auth carries over — we bind-mount ~/.claude so the container sees
    //      the user's credentials and projects.
    // Everything bind-mounts at the same absolute paths so --add-dir and
    // --resume behave identically to host mode.
    const img = (dockerImage && dockerImage.trim()) || 'ghcr.io/anthropics/claude-code:latest';
    const mounts = new Set();
    if (cwd) mounts.add(cwd);
    for (const d of (addDirs || [])) if (d) mounts.add(d);
    const homeClaude = path.join(process.env.HOME || '', '.claude');
    if (homeClaude && fs.existsSync(homeClaude)) mounts.add(homeClaude);

    const dockerArgs = ['run', '--rm', '-i'];
    for (const m of mounts) dockerArgs.push('-v', `${m}:${m}`);
    if (cwd) dockerArgs.push('-w', cwd);
    // Claude inside the container still needs its config path.
    if (homeClaude && mounts.has(homeClaude)) {
      dockerArgs.push('-e', `HOME=${process.env.HOME}`);
    }
    dockerArgs.push(img, 'claude', ...claudeArgs);

    process.stderr.write(`[claude] docker run image=${img} mounts=${mounts.size}\n`);
    return spawn('docker', dockerArgs, {
      // No cwd option for docker — it uses -w inside the container. Running
      // the docker client itself from the backend process's cwd is fine.
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  if (sm === 'jailbroken') {
    // Explicit opt-out: spawn directly on the host with whatever permissions
    // the user has granted. The jailbroken tool-policy defaults above already
    // widened allowedTools and permissionMode.
    process.stderr.write(`[claude] jailbroken host spawn\n`);
    return spawn(bin, claudeArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  // Default mode: wrap in bubblewrap so the CLI can't reach outside the
  // user-attached folders. wrapWithSandbox returns null on non-Linux (no
  // sandbox implementation → fall back to host spawn as before) and throws
  // SANDBOX_UNAVAILABLE on Linux without bwrap (caller surfaces as SSE error).
  //
  // extraReadOnlyDirs: bind-mount the directory containing approval-mcp.cjs
  // so the CLI can spawn the shim from inside the sandbox. The shim itself
  // POSTs to 127.0.0.1:<BACKEND_PORT>; loopback works because we deliberately
  // don't unshare the network namespace.
  const wrapped = wrapWithSandbox(bin, claudeArgs, {
    cwd,
    addDirs: addDirs || [],
    extraReadOnlyDirs: [APPROVAL_MCP_DIR],
  });
  if (wrapped) {
    process.stderr.write(`[claude] sandbox bwrap cwd=${cwd} addDirs=${(addDirs || []).length}\n`);
    return spawn(wrapped.cmd, wrapped.args, {
      // bwrap handles --chdir internally; omit node's cwd so a missing or
      // relocated host path doesn't kill spawn before bwrap can remap it.
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  // Non-Linux fallback — sandboxing not implemented yet. Note this loudly so
  // the user isn't blindsided; the UI also shows a warning via /sandbox-status.
  process.stderr.write(`[claude] WARNING: no sandbox on ${process.platform}; running on host\n`);
  return spawn(bin, claudeArgs, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return '';
}

function translateCliEvent(evt, session, send, emittedPaths) {
  if (!evt || typeof evt !== 'object') return;

  // First event of a turn — captures the session id.
  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id && evt.session_id !== session.claudeSessionId) {
      session.claudeSessionId = evt.session_id;
      send('session', { claudeSessionId: evt.session_id });
    }
    return;
  }

  // Assistant blocks: text, tool_use.
  if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length) {
        send('assistant_text', { text: block.text });
      } else if (block.type === 'tool_use') {
        // Emit a live tool_use event so the UI can render it as it happens.
        const name = block.name;
        const input = block.input || {};
        send('tool_use', {
          id: block.id,
          name,
          input,
        });

        // Legacy file_event for Write/Edit keeps the FilesPanel populated
        // alongside the new inline tool timeline. Search every attached root
        // (cwd + --add-dir extras) so files written to any of them show up.
        const target = input.file_path || input.path;
        if (target && (name === 'Write' || name === 'Edit')) {
          const roots = [session.cwd, ...(session.addDirs || [])];
          let matched = false;
          for (const root of roots) {
            if (!root) continue;
            const rel = safeRelInSandbox(root, target);
            if (!rel) continue;
            emittedPaths.add(rel);
            const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, rel);
            (session.emittedAbsPaths ||= new Set()).add(abs);
            send('file_event', {
              path: rel,
              kind: name === 'Write' ? 'added' : 'modified',
              url: fileEventUrl(session, rel),
            });
            matched = true;
            break;
          }
          // Fall back: if the target sits outside every root (shouldn't
          // happen under normal permission rules, but handle it anyway),
          // track it via absolute path so handleFileGet can still serve it.
          if (!matched && path.isAbsolute(target)) {
            const abs = path.resolve(target);
            (session.emittedAbsPaths ||= new Set()).add(abs);
            send('file_event', {
              path: abs,
              kind: name === 'Write' ? 'added' : 'modified',
              url: fileEventUrl(session, abs),
            });
          }
        }
      }
    }
    return;
  }

  // Tool results come back as user-role messages with tool_result content blocks.
  // This is where bash stdout, Read file contents, etc., live.
  if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result') {
        send('tool_result', {
          tool_use_id: block.tool_use_id,
          content: toolResultText(block.content),
          isError: !!block.is_error,
        });
      }
    }
    return;
  }

  // evt.type === 'result' — terminal message. We emit `end` after the process
  // actually closes, so nothing to do here.
}

async function streamMessages(res, session, prompt, { model } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Critical for live SSE: send headers immediately, disable Nagle so each
  // small frame is flushed to the renderer the instant we write it.
  try { res.flushHeaders?.(); } catch {}
  try { res.socket?.setNoDelay(true); } catch {}
  try { res.socket?.setKeepAlive(true); } catch {}

  const send = (event, data) => {
    try {
      // Single write per frame so the OS doesn't split header/body across
      // separate TCP packets and stall on Nagle even with NODELAY off.
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client gone */ }
  };

  // Confirm the stream is alive immediately. Useful both for the UI (it can
  // show "connected" instead of "working…") and for diagnosing buffering.
  send('open', { at: Date.now() });

  // In chat mode nothing should touch the filesystem, so skip the snapshot.
  const isChat = session.mode === 'chat';
  const preSnap = isChat ? new Map() : snapshotFiles(session.cwd);
  const emittedPaths = new Set(); // dedupe tool_use and diff-based file events

  let child;
  try {
    child = startClaude({
      prompt,
      cwd: session.cwd,
      resumeId: session.claudeSessionId,
      mode: session.mode,
      model: model || session.model || null,
      addDirs: session.addDirs || [],
      permissionMode: session.permissionMode || null,
      allowedTools: session.allowedTools || null,
      disallowedTools: session.disallowedTools || null,
      shellMode: session.shellMode || 'default',
      dockerImage: session.dockerImage || null,
      sessionId: session.id,
    });
  } catch (err) {
    send('error', { message: `Failed to launch claude CLI: ${err.message}` });
    send('end', { exitCode: -1 });
    res.end();
    return;
  }

  child.on('error', (err) => {
    process.stderr.write(`[claude] spawn error: ${err.message}\n`);
    send('error', {
      message: `Failed to launch claude CLI (${err.code || 'ENOENT'}): ${err.message}. ` +
        `Check that CLAUDE_BIN points to a valid binary, or that 'claude' is on PATH.`,
    });
  });

  // Abort spawn if the client disconnects mid-stream.
  res.on('close', () => {
    if (child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch {}
    }
  });

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      translateCliEvent(parsed, session, send, emittedPaths);
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
    // Also echo for dev debugging.
    process.stderr.write(`[claude] ${chunk}`);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
  });

  process.stderr.write(`[claude] exited code=${exitCode} stderr_bytes=${stderr.length}\n`);

  if (exitCode !== 0) {
    send('error', {
      message: `claude exited with code ${exitCode}` + (stderr ? `:\n${stderr.trim()}` : ''),
    });
  }

  // Diff the sandbox and emit any file changes we didn't catch from tool_use
  // events (e.g. files created via Bash). Paths already emitted via tool_use
  // are skipped to avoid duplicate events. Chat mode skips this entirely —
  // there shouldn't be any file activity to surface.
  if (!isChat) {
    const postSnap = snapshotFiles(session.cwd);
    for (const [p, info] of postSnap) {
      if (emittedPaths.has(p)) continue;
      const prior = preSnap.get(p);
      if (!prior || prior.mtime !== info.mtime || prior.size !== info.size) {
        send('file_event', {
          path: p,
          kind: prior ? 'modified' : 'added',
          url: fileEventUrl(session, p),
        });
      }
    }
    for (const [p] of preSnap) {
      if (!postSnap.has(p)) send('file_event', { path: p, kind: 'deleted' });
    }
  }

  send('end', { exitCode, claudeSessionId: session.claudeSessionId || null });
  res.end();
}

// ---------- upload / file serving ----------

// Build the public URL we emit in `file_event` payloads. When the session was
// created with a stable `clientRef` (the renderer's chat id), we route through
// the chat-keyed endpoint — those URLs stay valid across app restarts because
// they resolve against the deterministic `<sandboxRoot>/c-<clientRef>` cwd +
// any live session's attached folders, rather than an in-memory session id
// that evaporates on restart. Fallback to the session-keyed URL keeps older
// or clientRef-less sessions working.
function fileEventUrl(session, relOrAbs) {
  if (session?.clientRef) {
    return `/chats/${encodeURIComponent(session.clientRef)}/files/${encodeURI(relOrAbs)}`;
  }
  return `/sessions/${session.id}/files/${encodeURI(relOrAbs)}`;
}

async function handleUpload(req, res, session) {
  const rawName = req.headers['x-filename'];
  const name = rawName ? decodeURIComponent(Array.isArray(rawName) ? rawName[0] : rawName).trim() : '';
  if (!name || name.includes('/') || name.includes('\\') || name === '..' || name.startsWith('.')) {
    return json(res, 400, { error: 'invalid filename (X-Filename header required, basename only)' });
  }

  const maxBytes = Number(process.env.UPLOAD_MAX_BYTES || 200 * 1024 * 1024);
  const dstDir = path.join(session.cwd, 'uploads');
  fs.mkdirSync(dstDir, { recursive: true });
  const dst = path.join(dstDir, name);

  let received = 0;
  let aborted = false;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dst);
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        aborted = true;
        req.destroy();
        out.destroy();
        try { fs.unlinkSync(dst); } catch {}
        reject(new Error('upload exceeds UPLOAD_MAX_BYTES'));
      }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', (e) => { if (!aborted) reject(e); });
  });

  const stat = fs.statSync(dst);
  return json(res, 200, {
    files: [{ name, size: stat.size, path: dst }],
  });
}

// Stream a file from the first root that claims it. Shared between
// session-keyed (`/sessions/:id/files/...`) and chat-keyed
// (`/chats/:clientRef/files/...`) routes. `emittedAbsPaths` is an optional
// allow-list of absolute paths that may be served even when they live outside
// every root — used when the CLI wrote to a folder the user later detached.
function serveFileFromRoots(req, res, rel, roots, emittedAbsPaths) {
  const tried = [];
  for (const root of roots) {
    if (!root) continue;
    const safe = safeRelInSandbox(root, rel);
    if (safe === null) continue;
    const full = path.join(root, safe);
    tried.push(full);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    res.writeHead(200, {
      'Content-Type': guessMime(full),
      'Content-Length': String(st.size),
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
    return;
  }

  if (path.isAbsolute(rel) && emittedAbsPaths?.has(path.resolve(rel))) {
    const full = path.resolve(rel);
    let st;
    try { st = fs.statSync(full); } catch {
      process.stderr.write(`[files] 404 (absolute emitted, missing): ${full}\n`);
      return end(res, 404);
    }
    if (!st.isFile()) return end(res, 404);
    res.writeHead(200, {
      'Content-Type': guessMime(full),
      'Content-Length': String(st.size),
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).pipe(res);
    return;
  }

  process.stderr.write(
    `[files] 404 rel=${JSON.stringify(rel)} roots=${JSON.stringify(roots)} tried=${JSON.stringify(tried)}\n`,
  );
  // Include diagnostic JSON in the body so the FilesPanel can show the user
  // *why* the preview failed (which roots the backend walked). HEAD requests
  // still get an empty body.
  if (req.method === 'HEAD') return end(res, 404);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'file not found', rel, roots, tried }));
}

function handleFileGet(req, res, session, relEncoded) {
  let rel;
  try { rel = decodeURIComponent(relEncoded); } catch { return end(res, 400); }

  // A file may live under session.cwd OR any of the --add-dir extras the user
  // attached — plus the path could be absolute or relative. Walk every
  // allowed root and serve the first hit. Absolute paths that don't live
  // under any root end up here too; safeRelInSandbox rejects them per-root
  // so traversal (`../`) can't escape.
  const roots = [session.cwd, ...(session.addDirs || [])];
  return serveFileFromRoots(req, res, rel, roots, session.emittedAbsPaths);
}

// Serve by chat id (clientRef) rather than ephemeral session id. The
// deterministic ephemeral cwd `<sandboxRoot>/c-<clientRef>` is always a
// candidate root; if a live session with this clientRef exists we also walk
// its cwd + addDirs + emittedAbsPaths, so files living under user-attached
// folders still resolve. This URL shape survives app restarts — that's the
// whole point.
function handleChatFileGet(req, res, clientRef, relEncoded, { sandboxRoot }) {
  let rel;
  try { rel = decodeURIComponent(relEncoded); } catch { return end(res, 400); }

  const safeRef = String(clientRef || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  if (!safeRef) return end(res, 404);

  const roots = [path.join(sandboxRoot, `c-${safeRef}`)];
  let emittedAbsPaths;
  // First: any live session that matches this clientRef. Its cwd/addDirs are
  // the current source of truth, plus it carries `emittedAbsPaths` for files
  // that were written outside every attached root during the turn.
  for (const s of sessions.values()) {
    if (s.clientRef !== safeRef) continue;
    if (s.cwd && !roots.includes(s.cwd)) roots.push(s.cwd);
    for (const d of (s.addDirs || [])) {
      if (d && !roots.includes(d)) roots.push(d);
    }
    if (s.emittedAbsPaths) emittedAbsPaths = s.emittedAbsPaths;
  }
  // Second: the chat's registered roots (set when the renderer activates a
  // chat). Covers the common case where the user opens a historical chat,
  // scrolls through past previews, but hasn't sent a new message yet — no
  // session has spun up for this chat, so the `sessions` loop above produced
  // nothing.
  const reg = chatRoots.get(safeRef);
  if (reg) {
    if (reg.cwd && !roots.includes(reg.cwd)) roots.push(reg.cwd);
    for (const d of (reg.addDirs || [])) {
      if (d && !roots.includes(d)) roots.push(d);
    }
  }

  return serveFileFromRoots(req, res, rel, roots, emittedAbsPaths);
}

// ---------- router ----------

async function route(req, res, { sandboxRoot }) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // Permissive CORS — the server only binds to 127.0.0.1, and during dev the
  // renderer is served from http://localhost:5173 (different origin).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Filename');
  if (req.method === 'OPTIONS') return end(res, 204);

  if (req.method === 'GET' && p === '/health') {
    return json(res, 200, { ok: true, graph: false });
  }

  if (req.method === 'GET' && p === '/info') {
    return json(res, 200, await getClaudeInfo());
  }

  // ---------- approval gate ----------
  //
  // Three endpoints, three audiences:
  //
  //   POST /approval/request   — called by the stdio MCP shim that the Claude
  //                              CLI spawns when a permission gate fires.
  //                              Long-polls until the user answers or the
  //                              broker's auto-deny timeout kicks in. Response
  //                              body is `{ behavior: 'allow'|'deny', ... }`.
  //
  //   GET  /approval/events    — SSE stream the renderer subscribes to. Emits
  //                              `snapshot` once on connect, then a stream of
  //                              `approval_pending` and `approval_resolved`
  //                              events. Drives the in-app modal.
  //
  //   POST /approval/answer    — renderer posts the user's decision here.
  //
  // The whole flow is documented in electron/approval.cjs.

  if (req.method === 'POST' && p === '/approval/request') {
    const body = await readJson(req).catch(() => ({}));
    const decision = await approval.requestApproval({
      toolName: typeof body.toolName === 'string' ? body.toolName : 'unknown',
      toolUseId: typeof body.toolUseId === 'string' ? body.toolUseId : null,
      input: (body.input && typeof body.input === 'object') ? body.input : {},
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
    });
    return json(res, 200, decision);
  }

  if (req.method === 'POST' && p === '/approval/answer') {
    const body = await readJson(req).catch(() => ({}));
    const id = typeof body.id === 'string' ? body.id : null;
    if (!id) return json(res, 400, { error: 'id required' });
    const ok = approval.submitDecision(id, {
      behavior: body.behavior,
      message: typeof body.message === 'string' ? body.message : undefined,
      updatedInput: body.updatedInput && typeof body.updatedInput === 'object'
        ? body.updatedInput
        : undefined,
    });
    return json(res, ok ? 200 : 404, { ok, id });
  }

  if (req.method === 'GET' && p === '/approval/pending') {
    return json(res, 200, { pending: approval.listPending() });
  }

  if (req.method === 'GET' && p === '/approval/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try { res.flushHeaders?.(); } catch {}
    try { res.socket?.setNoDelay(true); } catch {}
    try { res.socket?.setKeepAlive(true); } catch {}
    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* client gone */ }
    };
    const unsubscribe = approval.subscribeEvents(send);
    // Heartbeat so proxies / OSes don't reap the idle socket between events.
    const heartbeat = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch {}
    }, 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      try { res.end(); } catch {}
    });
    return; // don't fall through; the connection stays open
  }

  // Account info — `claude auth status` (JSON). Exit 0 = signed in.
  if (req.method === 'GET' && p === '/auth-status') {
    return json(res, 200, await getAuthStatus());
  }

  // Is Docker installed and running on the host? Powers the Security tab's
  // Docker-shell option — we only enable that path when the daemon responds.
  if (req.method === 'GET' && p === '/docker-status') {
    return json(res, 200, await getDockerStatus());
  }

  // Is bubblewrap available? Powers the Security tab's Default-mode status
  // pill. On non-Linux the UI shows "not sandboxed on this OS"; on Linux
  // without bwrap it shows install hints for the current distro family.
  if (req.method === 'GET' && p === '/sandbox-status') {
    return json(res, 200, detectSandbox());
  }

  // MCP registry listing — powers the Settings → MCP Servers tab. Fetched
  // server-side to avoid CORS and cached in-memory for 5 minutes. Pass
  // `?refresh=1` to bypass the cache.
  if (req.method === 'GET' && p === '/mcp-registry/servers') {
    try {
      const force = url.searchParams.get('refresh') === '1';
      const out = await getMcpRegistryServers({ force });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 502, { error: String(e?.message || e) });
    }
  }

  // Cowork's curated subset of the MCP ecosystem — the list of servers we
  // know how to install end-to-end (auth flow + config write-through).
  if (req.method === 'GET' && p === '/mcp-curated/servers') {
    try { return json(res, 200, readCuratedCatalog()); }
    catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
  }

  // MCP servers currently configured in ~/.claude.json (i.e. what the CLI
  // will connect to on its next spawn). Annotated with curated metadata
  // when we recognise the id.
  if (req.method === 'GET' && p === '/mcp-installed') {
    try { return json(res, 200, { servers: listInstalledMcpServers() }); }
    catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
  }

  // Install a curated server. Body: { id, params?, env? } — `params` values
  // get substituted into `{placeholder}` args; `env` values are written to
  // the spec's `env` block and passed to the MCP subprocess by the CLI.
  if (req.method === 'POST' && p === '/mcp-curated/install') {
    try {
      const body = await readJson(req);
      if (!body?.id) return json(res, 400, { error: 'id required' });
      const out = installCuratedMcpServer(body.id, body.params, body.env);
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      return json(res, 400, { error: String(e?.message || e) });
    }
  }

  // Remove a server from ~/.claude.json. No confirmation — the UI handles
  // that before calling.
  {
    const m = p.match(/^\/mcp-installed\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      try { return json(res, 200, uninstallMcpServer(decodeURIComponent(m[1]))); }
      catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
    }
  }

  // ----- Plugins -----
  // Plugins are host-side helper processes (see electron/plugins.cjs). The UI
  // in Settings → Plugins uses these routes to list, configure, and
  // start/stop them. Settings persist in ~/.cowork/plugins.json.

  if (req.method === 'GET' && p === '/plugins/catalog') {
    try { return json(res, 200, plugins.readCatalog()); }
    catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
  }

  if (req.method === 'GET' && p === '/plugins') {
    try { return json(res, 200, { plugins: plugins.listPlugins() }); }
    catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
  }

  {
    const m = p.match(/^\/plugins\/([^/]+)\/settings$/);
    if (m && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const merged = plugins.setSettings(decodeURIComponent(m[1]), body?.settings || {});
        return json(res, 200, { settings: merged });
      } catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
    }
  }

  {
    const m = p.match(/^\/plugins\/([^/]+)\/start$/);
    if (m && req.method === 'POST') {
      try {
        const status = await plugins.startPlugin(decodeURIComponent(m[1]));
        return json(res, 200, status);
      } catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
    }
  }

  {
    const m = p.match(/^\/plugins\/([^/]+)\/stop$/);
    if (m && req.method === 'POST') {
      try {
        const status = await plugins.stopPlugin(decodeURIComponent(m[1]));
        return json(res, 200, status);
      } catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
    }
  }

  // Usage blobs — runs `claude -p "/<name>"` and returns whatever it prints.
  // `name` is one of cost | usage | stats (the three slash commands that
  // surface usage info in the TUI). Output is raw text; the UI just shows it.
  if (req.method === 'GET' && p === '/usage') {
    const name = (url.searchParams.get('cmd') || 'usage').toLowerCase();
    if (!['cost', 'usage', 'stats'].includes(name)) {
      return json(res, 400, { error: `unknown usage cmd: ${name}` });
    }
    return json(res, 200, await getUsageBlob(name, { sandboxRoot }));
  }

  // Open an interactive `claude` terminal so the user can type /config (which
  // is a TUI-only slash command — we can't render it inside our window).
  if (req.method === 'POST' && p === '/open-claude-config') {
    return openClaudeTerminal(res, {
      hint: "Claude is starting. Type `/config` to edit your Claude Code settings.",
    });
  }

  // Install the `claude` CLI on the user's machine. Streams the install
  // script's stdout/stderr over SSE so the UI can show progress live.
  // Uses the official one-liner: `curl -fsSL https://claude.ai/install.sh | bash`.
  if (req.method === 'POST' && p === '/install-claude') {
    return streamInstallClaude(res);
  }

  // Open the user's terminal with `claude auth login` running so they can sign
  // in interactively. Auth is OAuth-based and needs a real TTY for the prompt
  // exchange — easier to lean on the system terminal than to ship a PTY. We
  // invoke the dedicated `auth login` subcommand so the user lands on the
  // OAuth prompt immediately, without going through the first-run TUI
  // onboarding (theme picker, etc.) that plain `claude` triggers.
  if (req.method === 'POST' && p === '/open-claude-terminal') {
    return openClaudeTerminal(res, {
      hint: 'Signing you in to Claude. Follow the prompts below.',
      args: ['auth', 'login'],
    });
  }

  if (req.method === 'POST' && p === '/sessions') {
    const body = await readJson(req).catch(() => ({}));
    const id = newId();
    const mode = body.mode === 'chat' ? 'chat' : 'cowork';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const resumeClaudeSessionId = typeof body.claudeSessionId === 'string' && body.claudeSessionId.trim()
      ? body.claudeSessionId.trim()
      : null;
    // Optional client-side stable key (typically the renderer's chat.id). Used
    // to derive a stable ephemeral cwd so `claude --resume` keeps working
    // across app restarts: the CLI stores session jsonl under a cwd-keyed
    // path in ~/.claude/projects, and that lookup breaks if the cwd differs.
    const clientRef = typeof body.clientRef === 'string'
      ? body.clientRef.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
      : '';

    const sandboxRootResolved = path.resolve(sandboxRoot);
    const underSandboxRoot = (abs) => {
      const r = path.resolve(abs);
      return r === sandboxRootResolved || r.startsWith(sandboxRootResolved + path.sep);
    };

    let cwd;
    let managed;
    if (mode === 'cowork' && typeof body.cwd === 'string' && body.cwd.trim()) {
      const requested = body.cwd.trim();
      if (!path.isAbsolute(requested)) {
        return json(res, 400, { error: 'cwd must be an absolute path' });
      }
      const resolved = path.resolve(requested);
      let st = null;
      try { st = fs.statSync(resolved); } catch { /* missing */ }
      if (!st) {
        // If the cwd lives under sandboxRoot (we created it before, it got
        // GC'd, or the app restarted and the chat is reconnecting), we own
        // that territory and can safely recreate it. Anything outside
        // sandboxRoot must already exist — we don't create user folders.
        if (underSandboxRoot(resolved)) {
          try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) {
            return json(res, 500, { error: `failed to create cwd: ${e.message}` });
          }
        } else {
          return json(res, 400, { error: `cwd does not exist: ${resolved}` });
        }
      } else if (!st.isDirectory()) {
        return json(res, 400, { error: `cwd is not a directory: ${resolved}` });
      }
      cwd = resolved;
      // "managed" means backend owns the directory's lifecycle. Anything we
      // create (or that lives under sandboxRoot) is managed; user-attached
      // folders aren't.
      managed = underSandboxRoot(resolved);
    } else {
      // Chat mode (or cowork-without-folder) uses an ephemeral cwd under
      // sandboxRoot. Derive the directory name from clientRef when provided
      // (stable across restarts, so --resume can locate the session jsonl),
      // otherwise fall back to a fresh per-call id.
      const dirName = clientRef ? `c-${clientRef}` : id;
      cwd = path.join(sandboxRoot, dirName);
      fs.mkdirSync(cwd, { recursive: true });
      managed = true;
    }

    // Optional extra working folders (passed to the CLI as --add-dir). Each
    // must be an existing absolute directory; bad entries are silently skipped
    // so a stale path in the chat row doesn't kill the whole spawn.
    const addDirs = [];
    if (mode === 'cowork' && Array.isArray(body.addDirs)) {
      for (const d of body.addDirs) {
        if (typeof d !== 'string' || !path.isAbsolute(d)) continue;
        if (path.resolve(d) === cwd) continue; // already the cwd
        try {
          if (fs.statSync(d).isDirectory()) addDirs.push(path.resolve(d));
        } catch { /* skip missing dirs */ }
      }
    }

    // Tool-policy overrides, all optional. Anything not passed falls back to
    // env vars / hardcoded defaults inside startClaude().
    const permissionMode = typeof body.permissionMode === 'string' && body.permissionMode.trim()
      ? body.permissionMode.trim()
      : null;
    const allowedTools = typeof body.allowedTools === 'string' && body.allowedTools.trim()
      ? body.allowedTools.trim()
      : null;
    const disallowedTools = typeof body.disallowedTools === 'string' && body.disallowedTools.trim()
      ? body.disallowedTools.trim()
      : null;

    // Security posture: default | docker | jailbroken. See startClaude().
    const rawShell = typeof body.shellMode === 'string' ? body.shellMode.trim() : '';
    const shellMode = (rawShell === 'docker' || rawShell === 'jailbroken') ? rawShell : 'default';
    const dockerImage = typeof body.dockerImage === 'string' && body.dockerImage.trim()
      ? body.dockerImage.trim()
      : null;

    const s = {
      id, cwd, mode, managed, model, addDirs,
      clientRef,
      permissionMode, allowedTools, disallowedTools,
      shellMode, dockerImage,
      createdAt: Date.now(),
      claudeSessionId: resumeClaudeSessionId,
    };
    sessions.set(id, s);
    return json(res, 200, {
      id, cwd, mode, managed, model, addDirs,
      permissionMode, allowedTools, disallowedTools,
      shellMode, dockerImage,
      claudeSessionId: s.claudeSessionId,
    });
  }

  let m;
  if ((m = p.match(/^\/sessions\/([^/]+)$/))) {
    const s = sessions.get(m[1]);
    if (req.method === 'GET') {
      if (!s) return end(res, 404);
      return json(res, 200, {
        id: s.id,
        cwd: s.cwd,
        managed: s.managed,
        claudeSessionId: s.claudeSessionId || null,
      });
    }
    if (req.method === 'DELETE') {
      if (!s) return end(res, 204);
      sessions.delete(s.id);
      // Cancel any approval prompts still waiting on this session — the CLI
      // child is about to die; without this the broker would hold its modal
      // open forever (or until the auto-deny timer).
      approval.cancelForSession(s.id);
      // Only delete the directory if we created it. User-picked folders are
      // left entirely alone — the session just forgets about them.
      if (s.managed) {
        try { await fsp.rm(s.cwd, { recursive: true, force: true }); } catch {}
      }
      return end(res, 204);
    }
  }

  if ((m = p.match(/^\/sessions\/([^/]+)\/upload$/))) {
    if (req.method !== 'POST') return end(res, 405);
    const s = sessions.get(m[1]);
    if (!s) return end(res, 404);
    return handleUpload(req, res, s);
  }

  if ((m = p.match(/^\/sessions\/([^/]+)\/files\/(.+)$/))) {
    // Accept HEAD too — the FilesPanel uses it to probe whether the file
    // exists before rendering into an iframe/img (spares the user a blank
    // 404 body in the preview).
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405);
    const s = sessions.get(m[1]);
    if (!s) return end(res, 404);
    return handleFileGet(req, res, s, m[2]);
  }

  // Chat-keyed file route. Survives app restarts because the resolution is
  // driven by `<sandboxRoot>/c-<clientRef>` (deterministic per chat) plus any
  // live session's attached folders. Prefer this route when emitting URLs so
  // old messages' file links keep working.
  if ((m = p.match(/^\/chats\/([^/]+)\/files\/(.+)$/))) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405);
    return handleChatFileGet(req, res, decodeURIComponent(m[1]), m[2], { sandboxRoot });
  }

  // Diagnostic dump for a chat: which roots are registered, which live
  // sessions are keyed to this clientRef, whether the ephemeral cwd exists
  // on disk. Purely read-only; handy for debugging file-preview 404s.
  if ((m = p.match(/^\/chats\/([^/]+)\/debug$/))) {
    if (req.method !== 'GET') return end(res, 405);
    const safeRef = decodeURIComponent(m[1]).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    if (!safeRef) return json(res, 400, { error: 'invalid clientRef' });
    const ephemeral = path.join(sandboxRoot, `c-${safeRef}`);
    let ephemeralExists = false;
    try { ephemeralExists = fs.statSync(ephemeral).isDirectory(); } catch {}
    const matchingSessions = [];
    for (const s of sessions.values()) {
      if (s.clientRef !== safeRef) continue;
      matchingSessions.push({ id: s.id, cwd: s.cwd, addDirs: s.addDirs || [] });
    }
    return json(res, 200, {
      clientRef: safeRef,
      ephemeralCwd: ephemeral,
      ephemeralExists,
      registeredRoots: chatRoots.get(safeRef) || null,
      matchingSessions,
    });
  }

  // Register (or clear) the chat's roots so the chat-keyed file route can
  // serve files without first spinning up a live CLI session. Renderer calls
  // this when a chat becomes active. Body: { cwd?: string, addDirs?: string[] }.
  // POST with nothing (or `{}`) clears the registration.
  if ((m = p.match(/^\/chats\/([^/]+)\/roots$/))) {
    if (req.method !== 'POST') return end(res, 405);
    const safeRef = decodeURIComponent(m[1]).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    if (!safeRef) return json(res, 400, { error: 'invalid clientRef' });
    const body = await readJson(req).catch(() => ({}));
    const cwd = typeof body.cwd === 'string' && path.isAbsolute(body.cwd) ? path.resolve(body.cwd) : null;
    const addDirs = Array.isArray(body.addDirs)
      ? body.addDirs
          .filter((d) => typeof d === 'string' && path.isAbsolute(d))
          .map((d) => path.resolve(d))
      : [];
    if (!cwd && addDirs.length === 0) {
      chatRoots.delete(safeRef);
      process.stderr.write(`[chats] roots cleared clientRef=${safeRef}\n`);
    } else {
      chatRoots.set(safeRef, { cwd, addDirs });
      process.stderr.write(
        `[chats] roots set clientRef=${safeRef} cwd=${JSON.stringify(cwd)} addDirs=${JSON.stringify(addDirs)}\n`,
      );
    }
    return json(res, 200, { ok: true, cwd, addDirs });
  }

  if ((m = p.match(/^\/sessions\/([^/]+)\/messages$/))) {
    if (req.method !== 'POST') return end(res, 405);
    const s = sessions.get(m[1]);
    if (!s) return end(res, 404);
    const body = await readJson(req).catch(() => ({}));
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) return json(res, 400, { error: 'prompt required' });
    // Allow the client to override the model per-turn; falls back to the
    // session's default. Empty string means "use default — no --model flag".
    const model = typeof body.model === 'string' ? body.model.trim() || null : undefined;
    return streamMessages(res, s, prompt, { model: model ?? s.model });
  }

  return end(res, 404);
}

// ---------- public API ----------

async function startBackend({ sandboxRoot, onApprovalPending } = {}) {
  if (!sandboxRoot) throw new Error('sandboxRoot required');
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const port = await pickFreePort();
  // Stash the port for startClaude → MCP shim env. Has to happen before we
  // start serving, since the very first chat turn could try to spawn a CLI.
  BACKEND_PORT = port;
  // Wire the DE-notification hook (set by main.cjs). The broker will fire
  // this every time a new approval lands, in addition to broadcasting on the
  // SSE channel for in-app modals.
  approval.init({ onPending: onApprovalPending });

  const server = http.createServer((req, res) => {
    route(req, res, { sandboxRoot }).catch((err) => {
      process.stderr.write(`[backend] ${err?.stack || err}\n`);
      if (!res.headersSent) {
        try { res.writeHead(500, { 'Content-Type': 'text/plain' }); } catch {}
      }
      try { res.end(String(err?.message || err)); } catch {}
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;

  async function stop() {
    // Kill any plugin child processes we started (e.g. Chrome launched by the
    // chrome-controller plugin) before we tear down the HTTP server. Best
    // effort — on a successful `app.quit` the children would die with us
    // anyway since we spawn with `detached: false`, but an explicit SIGTERM
    // gives Chrome a chance to flush profile state gracefully.
    await plugins.shutdownAll().catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
    // Best-effort: clear in-memory session registry. Sandboxes on disk stay
    // put — they live under userData so uninstall doesn't clobber them.
    sessions.clear();
  }

  return {
    url,
    port,
    stop,
    getLogs: () => [], // vestigial — kept so main.cjs's IPC handler still works
    backendDir: sandboxRoot,
  };
}

module.exports = { startBackend };
