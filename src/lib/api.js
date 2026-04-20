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
