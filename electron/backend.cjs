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
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

const { detectSandbox, wrapWithSandbox } = require('./sandbox.cjs');

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

// Scan ~/.claude/projects/*/<session-id>.jsonl for past CLI sessions so the
// Chats tab can show the user's recent claude conversations. We read only the
// head of each JSONL file for a title, and stat for the timestamp. Failures
// are swallowed so a malformed file never breaks the listing.
//
// Each --resume turn writes a fresh jsonl file for the same conversation,
// so a chat with N turns produces N sibling files under the same project dir.
// We collapse those here: within a project, files whose preview yields the
// same first user message are treated as one chain, and only the newest
// (mtime) entry is shown. Files with no user message in the head window
// (pure continuations whose first line is a summary/init) are dropped —
// they'd render as an "empty" duplicate right next to the real chat.
function listClaudeHistory(limit) {
  const home = process.env.HOME || '';
  if (!home) return [];
  const root = path.join(home, '.claude', 'projects');
  let projects;
  try { projects = fs.readdirSync(root); } catch { return []; }

  const out = [];
  for (const proj of projects) {
    const projDir = path.join(root, proj);
    let files;
    try { files = fs.readdirSync(projDir); } catch { continue; }
    // Collapse continuation chains: key by (projectPath, firstUserMessage),
    // keep only the most recent jsonl per key.
    const byChain = new Map();
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(projDir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      const id = f.replace(/\.jsonl$/, '');
      const projectPath = '/' + proj.replace(/^-/, '').split('-').join('/');
      const preview = readHistoryPreview(full);
      // Drop entries with no identifiable user message — these are almost
      // always mid-chain continuation files and would render as a confusing
      // "(no messages)" duplicate of the real chat above them.
      if (!preview.firstUserMessage) continue;
      const entry = {
        id,
        file: full,
        project: proj,
        projectPath,
        updatedAt: st.mtimeMs,
        title: preview.title,
        firstUserMessage: preview.firstUserMessage,
        messageCount: preview.messageCount,
      };
      const chainKey = `${projectPath}::${preview.firstUserMessage}`;
      const existing = byChain.get(chainKey);
      if (!existing || existing.updatedAt < entry.updatedAt) {
        byChain.set(chainKey, entry);
      }
    }
    for (const entry of byChain.values()) out.push(entry);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}

// Parse a small slice of a JSONL session file to derive a readable title and
// the first user message. The CLI writes one JSON object per line; layout
// varies across versions so we handle a few shapes.
function readHistoryPreview(file) {
  let firstUserMessage = '';
  let messageCount = 0;
  try {
    // Read up to ~128KB — enough for the first user turn in every session
    // shape I've seen without blowing memory on giant transcripts.
    const fd = fs.openSync(file, 'r');
    try {
      const max = 128 * 1024;
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      const head = buf.slice(0, n).toString('utf8');
      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        messageCount += 1;
        if (firstUserMessage) continue;
        // Common shapes:
        //   { type: 'user', message: { role:'user', content: 'hi' | [...] } }
        //   { role: 'user', content: 'hi' }
        const role = obj?.message?.role || obj?.role || obj?.type;
        if (role !== 'user') continue;
        const content = obj?.message?.content ?? obj?.content;
        const txt = toolResultText(content);
        if (typeof txt === 'string' && txt.trim()) {
          firstUserMessage = txt.trim();
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* ignore */ }

  const title = firstUserMessage
    ? firstUserMessage.slice(0, 80).replace(/\s+/g, ' ')
    : '(no messages)';
  return { title, firstUserMessage, messageCount };
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

function startClaude({ prompt, cwd, resumeId, mode, model, addDirs, permissionMode, allowedTools, disallowedTools, shellMode, dockerImage }) {
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
  if (mode === 'chat') {
    // General-purpose assistant: a tight allow-list of retrieval tools, plus
    // an explicit disallow-list for everything filesystem / shell related.
    // We also reframe the persona so Claude stops introducing itself as a
    // software engineering assistant.
    claudeArgs.push('--allowed-tools', CHAT_MODE_ALLOWED_TOOLS);
    claudeArgs.push('--disallowed-tools', CHAT_MODE_DISALLOWED_TOOLS);
    claudeArgs.push('--append-system-prompt', CHAT_MODE_APPEND_SYSTEM_PROMPT);
  } else {
    claudeArgs.push('--allowed-tools', effAllowed);
    claudeArgs.push('--permission-mode', effPerm);
    if (effDisallowed) claudeArgs.push('--disallowed-tools', effDisallowed);
    // Extra working folders the user attached. The CLI's --add-dir flag widens
    // the allow-list of paths Read/Edit/Bash can touch beyond cwd. We pass it
    // once per dir; chat mode skips this since it has no FS access anyway.
    for (const d of (addDirs || [])) {
      if (d && typeof d === 'string') claudeArgs.push('--add-dir', d);
    }
  }
  if (model) claudeArgs.push('--model', model);
  if (resumeId) claudeArgs.push('--resume', resumeId);

  // Log what we're actually running so failures are diagnosable.
  const toolPolicy = mode === 'chat'
    ? `allowed=${CHAT_MODE_ALLOWED_TOOLS} disallowed=${CHAT_MODE_DISALLOWED_TOOLS}`
    : `allowed-tools=${effAllowed} permission-mode=${effPerm}` +
      (effDisallowed ? ` disallowed-tools=${effDisallowed}` : '');
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
  const wrapped = wrapWithSandbox(bin, claudeArgs, {
    cwd,
    addDirs: addDirs || [],
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
              url: `/sessions/${session.id}/files/${encodeURI(rel)}`,
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
              url: `/sessions/${session.id}/files/${encodeURI(abs)}`,
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
          url: `/sessions/${session.id}/files/${encodeURI(p)}`,
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

function handleFileGet(req, res, session, relEncoded) {
  let rel;
  try { rel = decodeURIComponent(relEncoded); } catch { return end(res, 400); }

  // A file may live under session.cwd OR any of the --add-dir extras the user
  // attached — plus the path could be absolute or relative. Walk every
  // allowed root and serve the first hit. Absolute paths that don't live
  // under any root end up here too; safeRelInSandbox rejects them per-root
  // so traversal (`../`) can't escape.
  const roots = [session.cwd, ...(session.addDirs || [])];
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

  // Also accept a bare absolute path as a last resort: if the CLI wrote to a
  // folder that isn't currently attached (e.g. the user removed it), we still
  // want a preview so the FilesPanel entry isn't a dead link. Only allow it
  // if the absolute path was previously emitted during this session — that
  // set lives on the session so we don't open the door to arbitrary reads.
  if (path.isAbsolute(rel) && session.emittedAbsPaths?.has(path.resolve(rel))) {
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

  // Log the miss so we can tell from backend stderr whether the path is simply
  // outside every root, or the file really doesn't exist on disk.
  process.stderr.write(
    `[files] 404 rel=${JSON.stringify(rel)} roots=${JSON.stringify(roots)} tried=${JSON.stringify(tried)}\n`,
  );
  return end(res, 404);
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

  if (req.method === 'GET' && p === '/claude-history') {
    const limit = Number(url.searchParams.get('limit') || 100);
    return json(res, 200, { sessions: listClaudeHistory(Math.max(1, Math.min(500, limit))) });
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

async function startBackend({ sandboxRoot } = {}) {
  if (!sandboxRoot) throw new Error('sandboxRoot required');
  fs.mkdirSync(sandboxRoot, { recursive: true });

  const port = await pickFreePort();
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
