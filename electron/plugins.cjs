// Cowork plugin manager.
//
// A "plugin" here is a host-side helper process the Electron main spawns to
// manage a resource the sandbox deliberately hides. The bwrap sandbox strips
// $DISPLAY / Wayland socket / dbus / the user's browser profile etc., which
// is what makes it safe — but it also means certain tools (Chrome, native
// notifications, system trays, clipboard bridges) cannot be driven from
// inside a chat turn directly. Plugins are the escape hatch: they run on the
// host, and sandboxed claude reaches them over loopback.
//
// Current roster:
//   chrome-controller — launches Chrome with --remote-debugging-port. An MCP
//                       server like chrome-devtools-mcp can then attach via
//                       --browserUrl=http://127.0.0.1:<port> without needing
//                       any display plumbing inside the sandbox.
//
// Settings persist in ~/.cowork/plugins.json (mode 0600). We deliberately do
// NOT put them in ~/.claude.json — that file is owned by the Claude CLI and
// a future CLI release could normalise/strip keys it doesn't recognise.
// Keeping our own file avoids that risk and keeps concerns clean.
//
// Runtime state (pid, started_at, endpoint, last_error, ring-buffered logs)
// is in-memory only. Plugins start stopped on every app launch — we don't
// auto-resurrect them, because a silently-running Chrome on a dev's machine
// would be confusing. The user flips Start in Settings → Plugins and the
// backend owns the child from then until app exit or explicit Stop.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const CATALOG_PATH = path.join(__dirname, '..', 'website', 'supported-plugins.json');

function coworkDir() {
  return path.join(os.homedir(), '.cowork');
}

function pluginsConfigPath() {
  return path.join(coworkDir(), 'plugins.json');
}

function readCatalog() {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  return JSON.parse(raw);
}

function findPlugin(id) {
  const cat = readCatalog();
  const p = (cat.plugins || []).find((x) => x.id === id);
  if (!p) throw new Error(`unknown plugin: ${id}`);
  return p;
}

function readConfig() {
  try {
    const raw = fs.readFileSync(pluginsConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(coworkDir(), { recursive: true, mode: 0o700 });
  const target = pluginsConfigPath();
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function defaultSettings(plugin) {
  const out = {};
  for (const s of plugin.settings || []) {
    out[s.key] = s.default === undefined ? '' : s.default;
  }
  return out;
}

function getSettings(id) {
  const plugin = findPlugin(id);
  const cfg = readConfig();
  return { ...defaultSettings(plugin), ...((cfg[id] && cfg[id].settings) || {}) };
}

// Patch-merge: only keys present in `patch` are updated. Missing keys fall
// back to whatever was already persisted (or the catalog default). Unknown
// keys are dropped so a stale UI can't write garbage into the config.
function setSettings(id, patch) {
  const plugin = findPlugin(id);
  const known = new Set((plugin.settings || []).map((s) => s.key));
  const cfg = readConfig();
  const existing = (cfg[id] && cfg[id].settings) || {};
  const merged = { ...defaultSettings(plugin), ...existing };
  for (const [k, v] of Object.entries(patch || {})) {
    if (known.has(k)) merged[k] = v;
  }
  cfg[id] = { ...(cfg[id] || {}), settings: merged };
  writeConfig(cfg);
  return merged;
}

// ---------- runtime state ----------
//
// One record per plugin id. `state` is a short string the UI renders as a
// pill; `endpoint` is the localhost URL callers should use (null until we
// confirm it's up). `logs` is a small ring buffer of the child's stdout +
// stderr lines so users hitting an error can see why.

const runtime = new Map();
const LOG_MAX = 100;

function emptyStatus() {
  return { state: 'stopped', pid: null, startedAt: null, endpoint: null, lastError: null, logs: [] };
}

function publicStatus(id) {
  const r = runtime.get(id);
  if (!r) return emptyStatus();
  return {
    state: r.state,
    pid: r.pid || null,
    startedAt: r.startedAt || null,
    endpoint: r.endpoint || null,
    lastError: r.lastError || null,
    logs: (r.logs || []).slice(-30),
    adopted: !!r.adopted,
  };
}

function pushLog(id, line) {
  const r = runtime.get(id);
  if (!r) return;
  r.logs = r.logs || [];
  r.logs.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (r.logs.length > LOG_MAX) r.logs = r.logs.slice(-LOG_MAX);
}

// ---------- chrome-controller handler ----------

// Well-known install locations across distros, packages, and upstream
// installers. We check these regardless of $PATH because Electron's PATH
// (especially when launched from a .desktop file) is usually narrower than
// an interactive shell's, so a binary the user can run from their terminal
// is sometimes invisible to us unless we look directly.
const CHROME_CANDIDATE_PATHS = [
  // Distro packages
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome-beta',
  '/usr/bin/google-chrome-unstable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chrome',
  '/usr/local/bin/google-chrome',
  '/usr/local/bin/google-chrome-stable',
  '/usr/local/bin/chromium',
  // Upstream DEB/RPM
  '/opt/google/chrome/google-chrome',
  '/opt/google/chrome/chrome',
  '/opt/google/chrome-beta/google-chrome-beta',
  '/opt/google/chrome-unstable/google-chrome-unstable',
  // Snap / Flatpak bridges
  '/snap/bin/chromium',
  '/snap/bin/google-chrome',
  '/var/lib/flatpak/exports/bin/com.google.Chrome',
  '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
  // macOS bundles (harmless on Linux — accessSync just returns ENOENT)
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const CHROME_BIN_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'google-chrome-beta',
  'google-chrome-unstable',
  'chromium',
  'chromium-browser',
  'chrome',
];

// Return every Chrome-family binary we can find on this machine. Dedupes by
// resolved realpath so `/usr/bin/google-chrome` and its symlink target under
// `/opt/google/chrome/` don't both show up. Surfaced to the UI so the user
// can see what auto-detect chose and switch to a sibling with one click.
function scanChromeBinaries() {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      let key = p;
      try { key = fs.realpathSync(p); } catch { /* dangling symlink — use literal */ }
      if (seen.has(key)) return;
      seen.add(key);
      out.push(p);
    } catch { /* not there / not executable */ }
  };

  for (const c of CHROME_CANDIDATE_PATHS) add(c);

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of CHROME_BIN_NAMES) add(path.join(d, n));
  }

  return out;
}

function resolveChromeBinary(preferred) {
  // Absolute path: trust it verbatim. This is what the user sets when they
  // have a non-standard install (Chrome-for-Testing under /opt, Nix store, …).
  if (preferred && path.isAbsolute(preferred)) {
    try { fs.accessSync(preferred, fs.constants.X_OK); return preferred; } catch { return null; }
  }

  // Bare name override: honour it by scanning $PATH only, so a user who
  // wants "google-chrome" doesn't silently fall through to whatever we'd
  // pick otherwise.
  if (preferred) {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const d of dirs) {
      const full = path.join(d, preferred);
      try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* keep looking */ }
    }
    return null;
  }

  // No preference: pick whatever the broader scan found first.
  const all = scanChromeBinaries();
  return all[0] || null;
}

// Poll /json/version (CDP's metadata endpoint) until either it answers 200 or
// the deadline passes. Returns true on first success.
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Probe whether a TCP port on loopback is free. Used to distinguish "another
// Chrome is already serving CDP here" (adopt it) from "some unrelated process
// is squatting on the port" (fail loudly).
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    try { s.listen(port, '127.0.0.1'); } catch { resolve(false); }
  });
}

async function startChromeController() {
  const id = 'chrome-controller';
  const settings = getSettings(id);
  const port = Number(settings.port) || 9222;

  const binary = resolveChromeBinary((settings.chromePath || '').trim() || null);
  if (!binary) {
    throw new Error(
      'Chrome binary not found on $PATH. Install Google Chrome or Chromium, or set an ' +
      'absolute path in the plugin settings.',
    );
  }

  // Adopt existing CDP if something is already serving it (e.g. the user's
  // daily Chrome launched with --remote-debugging-port, or a leaked child
  // from a previous Cowork run).
  if (await waitForCdp(port, 500)) {
    runtime.set(id, {
      state: 'running',
      pid: null,
      startedAt: Date.now(),
      endpoint: `http://127.0.0.1:${port}`,
      lastError: null,
      child: null,
      logs: [`${new Date().toISOString().slice(11, 19)} adopted existing CDP on :${port}`],
      adopted: true,
    });
    return publicStatus(id);
  }

  if (!(await portFree(port))) {
    throw new Error(
      `Port ${port} is in use but not serving CDP. Stop the process holding it, ` +
      `or pick a different port in the plugin settings.`,
    );
  }

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (settings.headless) {
    args.push('--headless=new', '--disable-gpu');
  }

  // Always force a dedicated user-data-dir. Without one, Chrome's singleton
  // lock kicks in: if the user's daily Chrome is already running, our
  // invocation becomes an IPC client that asks the existing process to open
  // a window and then exits code 0 — "Opening in existing browser session.".
  // In that mode `--remote-debugging-port` is ignored, so CDP never comes up
  // and we sit at "error: Chrome did not expose CDP" while the user's real
  // Chrome got a new window. A distinct user-data-dir avoids the singleton
  // entirely and guarantees a standalone process.
  //
  // When the user has explicitly set a path in settings, honour it verbatim
  // — they might *want* to share their real profile (with live logins) and
  // they're on the hook for having closed their daily Chrome first.
  const uddFromSettings = (settings.userDataDir || '').trim();
  const udd = uddFromSettings
    || path.join(os.homedir(), '.cache', 'cowork', `chrome-${port}`);
  try { fs.mkdirSync(udd, { recursive: true }); } catch { /* Chrome will complain if it can't write */ }
  args.push(`--user-data-dir=${udd}`);

  const child = spawn(binary, args, {
    // NOT detached — we want Chrome to die when the backend process dies, so
    // quitting Cowork cleans up any browser we started.
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  runtime.set(id, {
    state: 'starting',
    pid: child.pid,
    startedAt: Date.now(),
    endpoint: null,
    lastError: null,
    child,
    logs: [`${new Date().toISOString().slice(11, 19)} spawn ${binary} (pid ${child.pid})`],
    adopted: false,
  });

  const onOut = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) if (line) pushLog(id, line);
  };
  child.stdout.on('data', onOut);
  child.stderr.on('data', onOut);

  child.on('error', (err) => {
    const r = runtime.get(id);
    if (!r) return;
    r.state = 'error';
    r.lastError = String(err && err.message || err);
    r.child = null;
    r.pid = null;
    pushLog(id, `spawn error: ${r.lastError}`);
  });

  child.on('exit', (code, signal) => {
    const r = runtime.get(id);
    if (!r) return;
    pushLog(id, `exited code=${code == null ? '?' : code} signal=${signal || 'none'}`);
    if (r.state === 'stopping') {
      r.state = 'stopped';
      r.lastError = null;
    } else {
      r.state = 'error';
      r.lastError = r.lastError || `Chrome exited unexpectedly (code=${code}, signal=${signal || 'none'})`;
    }
    r.pid = null;
    r.endpoint = null;
    r.child = null;
  });

  const up = await waitForCdp(port, 15000);
  const r = runtime.get(id);
  if (!up) {
    try { child.kill('SIGTERM'); } catch {}
    if (r) {
      r.state = 'error';
      // If the spawn died clean very quickly, Chrome almost certainly
      // forwarded our invocation to an existing singleton (see the
      // user-data-dir comment above) — surface that specifically so the user
      // doesn't have to guess. We shouldn't hit this now that we always pass
      // a dedicated user-data-dir, but keep the diagnostic in case someone
      // points the setting at their real Chrome profile while that Chrome
      // is already running.
      const childExitedClean = !r.child && r.logs && r.logs.some(
        (l) => /exited code=0/.test(l) || /Opening in existing browser session/.test(l),
      );
      r.lastError = childExitedClean
        ? `Chrome handed our launch off to an existing browser instance (singleton lock) and our --remote-debugging-port was ignored. Close the running Chrome, or point "User data directory" at a path your daily Chrome doesn't use.`
        : `Chrome did not expose CDP on :${port} within 15s. Check the plugin logs below.`;
    }
    throw new Error(r && r.lastError || 'Chrome failed to start');
  }
  if (r) {
    r.state = 'running';
    r.endpoint = `http://127.0.0.1:${port}`;
    pushLog(id, `CDP up on ${r.endpoint}`);
  }
  return publicStatus(id);
}

async function stopChromeController() {
  const id = 'chrome-controller';
  const r = runtime.get(id);
  if (!r) return emptyStatus();

  // Adopted CDP = not our process. Just forget about it; killing someone
  // else's Chrome would be rude.
  if (r.adopted) {
    runtime.delete(id);
    return emptyStatus();
  }

  if (!r.child) {
    runtime.delete(id);
    return emptyStatus();
  }

  r.state = 'stopping';
  const child = r.child;
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
  runtime.delete(id);
  return emptyStatus();
}

// ---------- dispatch ----------

const handlers = {
  'chrome-controller': { start: startChromeController, stop: stopChromeController },
};

async function startPlugin(id) {
  const h = handlers[id];
  if (!h) throw new Error(`unknown plugin: ${id}`);
  const cur = runtime.get(id);
  if (cur && (cur.state === 'running' || cur.state === 'starting')) {
    return publicStatus(id);
  }
  try {
    return await h.start();
  } catch (err) {
    // `start` may have created a runtime entry for logging; make sure the
    // caller gets a status payload with the error embedded so the UI can
    // render it without a second round-trip.
    const r = runtime.get(id);
    if (r) {
      r.state = 'error';
      r.lastError = String(err && err.message || err);
    }
    throw err;
  }
}

async function stopPlugin(id) {
  const h = handlers[id];
  if (!h) throw new Error(`unknown plugin: ${id}`);
  return h.stop();
}

// Plugin-specific extras for the list payload. Lets a given plugin attach
// extra data that only makes sense for it (e.g. chrome-controller exposing
// its binary scan). Called for every plugin when building the /plugins
// response; kept deliberately small so it stays fast to call on the 2s poll.
function pluginExtras(id, values) {
  if (id === 'chrome-controller') {
    const candidates = scanChromeBinaries();
    const preferred = (values.chromePath || '').trim() || null;
    return {
      chrome: {
        // What we'd spawn right now with the current settings. `null` means
        // no binary found; the UI renders that as an error-pill hint.
        detected: resolveChromeBinary(preferred),
        // Every Chrome-family binary we can see. UI lists them as
        // "click to select" chips so the user can switch between installs.
        candidates,
      },
    };
  }
  return {};
}

function listPlugins() {
  const catalog = readCatalog();
  const cfg = readConfig();
  return (catalog.plugins || []).map((p) => {
    const values = { ...defaultSettings(p), ...((cfg[p.id] && cfg[p.id].settings) || {}) };
    // Pull the schema out from under the `settings` key so the UI has both:
    //   settingsSchema — the catalog's input schema (array of field descriptors)
    //   settings       — the current persisted values (object keyed by field key)
    // If we left both as `settings`, one would overwrite the other on the wire.
    const { settings: schema, ...meta } = p;
    return {
      ...meta,
      settingsSchema: schema || [],
      settings: values,
      status: publicStatus(p.id),
      ...pluginExtras(p.id, values),
    };
  });
}

async function shutdownAll() {
  const ids = Array.from(runtime.keys());
  for (const id of ids) {
    try { await stopPlugin(id); } catch { /* best effort */ }
  }
}

module.exports = {
  readCatalog,
  listPlugins,
  getSettings,
  setSettings,
  startPlugin,
  stopPlugin,
  shutdownAll,
};
