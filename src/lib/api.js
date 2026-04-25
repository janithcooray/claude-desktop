// Thin fetch helpers for the in-process Electron backend (see
// electron/backend.cjs). The base URL is resolved at runtime from the preload
// bridge so we can use whatever free port the backend grabbed.

let BASE_URL = null;
let ready = null;

export async function setBaseUrl(url) {
  BASE_URL = url;
}

export async function resolveBaseUrl() {
  if (BASE_URL) return BASE_URL;
  if (!ready) {
    ready = (async () => {
      // Wait for the preload to have an answer.
      for (let i = 0; i < 200; i++) {
        const info = await window.cowork?.getBackendInfo?.();
        if (info?.url) { BASE_URL = info.url; return BASE_URL; }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('Backend did not come up in time');
    })();
  }
  return ready;
}

export async function createApiSession(opts = {}) {
  const base = await resolveBaseUrl();
  const body = {};
  if (opts.cwd) body.cwd = opts.cwd;
  if (opts.mode) body.mode = opts.mode;
  if (opts.model) body.model = opts.model;
  if (opts.claudeSessionId) body.claudeSessionId = opts.claudeSessionId;
  if (Array.isArray(opts.addDirs) && opts.addDirs.length) body.addDirs = opts.addDirs;
  if (opts.permissionMode) body.permissionMode = opts.permissionMode;
  if (opts.allowedTools) body.allowedTools = opts.allowedTools;
  if (opts.disallowedTools) body.disallowedTools = opts.disallowedTools;
  if (opts.shellMode) body.shellMode = opts.shellMode;
  if (opts.dockerImage) body.dockerImage = opts.dockerImage;
  // Optional stable key (typically the chat id). Lets the backend derive a
  // stable ephemeral cwd so the CLI's session jsonl stays findable across
  // restarts when the user hasn't attached a folder.
  if (opts.clientRef) body.clientRef = opts.clientRef;
  const r = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`create session failed (${r.status}): ${text}`);
  }
  return r.json();
}

export async function getHealth() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/health`);
  return r.json();
}

// Environment info for the Settings modal: claude bin path, version, login.
export async function getBackendEnvInfo() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/info`);
  if (!r.ok) throw new Error(`/info failed (${r.status})`);
  return r.json();
}

export async function deleteApiSession(id) {
  const base = await resolveBaseUrl();
  await fetch(`${base}/sessions/${id}`, { method: 'DELETE' });
}

export async function uploadFiles(apiSessionId, files) {
  const base = await resolveBaseUrl();
  const saved = [];
  // One request per file — keeps the backend free of a multipart parser
  // dependency while preserving the same response shape the Composer expects.
  for (const f of files) {
    const name = f.name || 'file';
    const r = await fetch(`${base}/sessions/${apiSessionId}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': f.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(name),
      },
      body: f,
    });
    if (!r.ok) throw new Error(`upload failed: ${r.status}`);
    const j = await r.json();
    for (const rec of (j.files || [])) saved.push(rec);
  }
  return { files: saved };
}

export function fileUrl(apiSessionId, relPath) {
  if (!BASE_URL) return '';
  return `${BASE_URL}/sessions/${apiSessionId}/files/${encodeURI(relPath).replace(/#/g, '%23')}`;
}

// Chat-keyed file URL — stable across app restarts. Unlike `fileUrl` (which
// bakes in an ephemeral session id that the backend forgets on restart),
// this routes through `/chats/:chatId/files/:path`; the backend resolves it
// against the deterministic `<sandboxRoot>/c-<chatId>` cwd plus any live
// session's attached folders. Use this for every file-preview URL — it
// "just works" whether or not a session is currently alive.
export function chatFileUrl(chatId, relPath) {
  if (!BASE_URL || !chatId) return '';
  return `${BASE_URL}/chats/${encodeURIComponent(chatId)}/files/${encodeURI(relPath).replace(/#/g, '%23')}`;
}

// Register the chat's cwd + addDirs with the backend so the chat-keyed file
// route can find files under user-attached folders without needing a live
// CLI session. Called whenever a chat becomes active. Passing `null`/empty
// clears the registration on the backend.
export async function registerChatRoots(chatId, { cwd, addDirs } = {}) {
  if (!chatId) return null;
  const base = await resolveBaseUrl();
  const body = {};
  if (cwd) body.cwd = cwd;
  if (Array.isArray(addDirs) && addDirs.length) body.addDirs = addDirs;
  try {
    const r = await fetch(`${base}/chats/${encodeURIComponent(chatId)}/roots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

// Some backend snapshot responses carry `url` as a *relative* path
// (`/sessions/abc/files/foo.html`). Loading that directly into an iframe or
// fetch() resolves it against the renderer's origin (Vite in dev, file:// in
// prod), which is not where the backend lives — in dev the SPA fallback
// serves the app's index.html into the iframe, which looks like "another
// instance of the app". Pipe every URL through this helper so the backend
// origin is always explicit.
export function absolutizeFileUrl(u) {
  if (!u) return '';
  if (/^(https?|blob|data):/i.test(u)) return u;
  if (!BASE_URL) return '';
  if (u.startsWith('/')) return `${BASE_URL}${u}`;
  return `${BASE_URL}/${u}`;
}

// Kick off the official `claude` CLI installer on the user's machine. The
// endpoint streams the install script's stdout/stderr back as SSE `log` events,
// finishing with `end { exitCode, info }` (refreshed /info payload). The
// caller gets the same (event, data) callback shape the chat stream uses.
export async function installClaudeCli({ onLog, onError, signal } = {}) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/install-claude`, {
    method: 'POST',
    signal,
    headers: { Accept: 'text/event-stream' },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`install failed (${r.status}): ${text}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let result = { exitCode: -1, info: null };
  const flush = (frame) => {
    // Frame format:  event: name\ndata: json\n\n
    const lines = frame.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    let parsed = null;
    try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { raw: data }; }
    if (event === 'log') onLog?.(parsed?.line || '');
    else if (event === 'error') onError?.(parsed?.message || 'Unknown error');
    else if (event === 'end') result = parsed || result;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (frame.trim()) flush(frame);
    }
  }
  return result;
}

// Ask the backend to open a real terminal window running `claude` so the user
// can complete interactive OAuth sign-in. Returns which terminal app was used.
export async function openClaudeSignInTerminal() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/open-claude-terminal`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(j.error || `open-claude-terminal failed (${r.status})`);
  }
  return j;
}

// Call `claude auth status --json` in the backend and return the parsed
// output. Shape: { bin, binExists, loggedIn, raw, parsed, stderr, exitCode }.
// `parsed` is the JSON the CLI emits (e.g. { account: { email, ... } }) when
// available. `loggedIn` is true only when the CLI exited 0 and the payload
// looked authenticated.
export async function getAuthStatus() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/auth-status`);
  if (!r.ok) throw new Error(`/auth-status failed (${r.status})`);
  return r.json();
}

// Fetch one of the slash-command usage reports via `claude -p "/<cmd>"`.
// cmd ∈ {'cost','usage','stats'}. Returns { ok, cmd, text, stderr, exitCode }.
export async function getUsageBlob(cmd) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/usage?cmd=${encodeURIComponent(cmd)}`);
  if (!r.ok) throw new Error(`/usage?cmd=${cmd} failed (${r.status})`);
  return r.json();
}

// Check whether Docker is installed on the host and whether the daemon is
// reachable. Shape: { installed, running, serverVersion, clientVersion, error }.
// `running === true` means we can actually `docker run` things; `installed`
// without `running` typically means the daemon is stopped.
export async function getDockerStatus() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/docker-status`);
  if (!r.ok) throw new Error(`/docker-status failed (${r.status})`);
  return r.json();
}

// Check whether the host can run the Default-mode sandbox. On Linux this means
// bubblewrap (`bwrap`) is on PATH. Shape:
//   available: boolean
//   platform:  'linux' | 'darwin' | 'win32' | ...
//   tool:      'bwrap' | null
//   reason?:   string (when available === false)
//   installHints?: { [distroFamily: string]: installCommand }
//   path?:     string (when available)
//   version?:  string (when available)
export async function getSandboxStatus() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/sandbox-status`);
  if (!r.ok) throw new Error(`/sandbox-status failed (${r.status})`);
  return r.json();
}

// Cowork's curated list of installable MCP servers. Shape:
// { version, updatedAt, servers: [{ id, name, description, iconUrl,
//   homepage, spec, params, env, prerequisites }] }
export async function getCuratedMcpServers() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/mcp-curated/servers`);
  if (!r.ok) throw new Error(`/mcp-curated/servers failed (${r.status})`);
  return r.json();
}

// Servers currently configured in ~/.claude.json. Cross-referenced with the
// curated catalog so familiar ids render with their proper title/icon.
// Shape: { servers: [{ id, name, description, iconUrl, transport, url,
//   command, curated }] }
export async function getInstalledMcpServers() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/mcp-installed`);
  if (!r.ok) throw new Error(`/mcp-installed failed (${r.status})`);
  return r.json();
}

// Install a curated server by id. `params` are runtime args; `env` are the
// secret/config env vars for the MCP subprocess. Returns the written spec.
export async function installCuratedMcpServer({ id, params = {}, env = {} }) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/mcp-curated/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, params, env }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(j.error || `install failed (${r.status})`);
  }
  return j;
}

export async function uninstallMcpServer(id) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/mcp-installed/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`uninstall failed (${r.status})`);
  return r.json();
}

// ---------- Plugins ----------
//
// Plugins are host-side helper processes (not MCP servers). See
// electron/plugins.cjs for the runtime; the UI lives in Settings → Plugins.

// Returns the curated plugin catalog (website/supported-plugins.json).
// Shape: { version, updatedAt, description, plugins: [{ id, name, description,
// iconUrl, categories, settings: [...], notes }] }.
export async function getPluginCatalog() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/plugins/catalog`);
  if (!r.ok) throw new Error(`/plugins/catalog failed (${r.status})`);
  return r.json();
}

// Returns every plugin in the catalog merged with its persisted settings
// and current runtime status. Shape: { plugins: [{ ...catalogEntry,
// settings: {...}, status: { state, pid, startedAt, endpoint, lastError,
// logs: [...] } }] }.
export async function listPlugins() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/plugins`);
  if (!r.ok) throw new Error(`/plugins failed (${r.status})`);
  return r.json();
}

// Patch-merge settings for a plugin. Only keys present in `settings` are
// updated; unknown keys (not in the catalog) are dropped server-side.
export async function updatePluginSettings(id, settings) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/plugins/${encodeURIComponent(id)}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `settings update failed (${r.status})`);
  return j;
}

export async function startPlugin(id) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/plugins/${encodeURIComponent(id)}/start`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `start failed (${r.status})`);
  return j;
}

export async function stopPlugin(id) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/plugins/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `stop failed (${r.status})`);
  return j;
}

// Fetch the list of servers from the official MCP registry via the backend
// (server-side fetch avoids CORS and gives us a 5-minute in-memory cache).
// Shape: { servers: [{ name, title, description, version, websiteUrl,
// repoUrl, iconUrl, latest }], cachedAt }.
export async function getMcpRegistryServers({ refresh = false } = {}) {
  const base = await resolveBaseUrl();
  const qs = refresh ? '?refresh=1' : '';
  const r = await fetch(`${base}/mcp-registry/servers${qs}`);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`/mcp-registry/servers failed (${r.status}): ${text}`);
  }
  return r.json();
}

// ---------- Approval gate ----------
//
// The Claude CLI gates risky tool calls behind a permission prompt. Cowork
// surfaces those prompts via a dedicated MCP shim (electron/approval-mcp.cjs)
// that POSTs to /approval/request and waits for the user's answer. The
// renderer subscribes to the SSE stream below to pop a modal whenever a new
// approval lands; PostingApprovalAnswer resolves the shim's long poll, which
// returns the decision back to the CLI.

// Open an SSE stream of approval events. `handler({ event, data })` fires
// for each frame. Returns a function that closes the stream.
//
// Events emitted:
//   snapshot          { pending: [...] }           — once on connect
//   approval_pending  { id, sessionId, toolName, toolUseId, input, createdAt }
//   approval_resolved { id, behavior, reason? }
export async function subscribeApprovals(handler) {
  const base = await resolveBaseUrl();
  // EventSource lacks AbortController support pre-spec; we manage closure
  // ourselves by holding the reader and cancelling it.
  const controller = new AbortController();
  (async () => {
    try {
      const r = await fetch(`${base}/approval/events`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!r.ok || !r.body) return;
      const reader = r.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!frame.trim() || frame.startsWith(':')) continue; // skip heartbeats
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = { raw: data }; }
          try { handler({ event, data: parsed }); } catch { /* swallow */ }
        }
      }
    } catch (err) {
      // AbortError on intentional close is expected; everything else is logged
      // so we don't silently lose the approval channel.
      if (err?.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.warn('[approvals] stream ended:', err);
      }
    }
  })();
  return () => controller.abort();
}

// Send the user's decision back to the broker. behavior is 'allow' | 'deny'.
// `message` is an optional human-readable reason that surfaces in the CLI's
// tool-result block (helpful when denying — the model sees why).
export async function answerApproval(id, { behavior, message } = {}) {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/approval/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, behavior, message }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `approval answer failed (${r.status})`);
  return j;
}

// Initial-load fetch — useful if the renderer mounts after the SSE snapshot
// would have already fired. Mostly redundant with subscribeApprovals's
// snapshot frame, but spares us a race on first paint.
export async function getPendingApprovals() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/approval/pending`);
  if (!r.ok) throw new Error(`/approval/pending failed (${r.status})`);
  return r.json();
}

// Open an external terminal pointed at `claude /config` so the user can
// interactively edit Claude Code settings (model, permissions, MCP, etc.).
export async function openClaudeConfigTerminal() {
  const base = await resolveBaseUrl();
  const r = await fetch(`${base}/open-claude-config`, { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    throw new Error(j.error || `open-claude-config failed (${r.status})`);
  }
  return j;
}
