// App-wide user preferences — persisted as JSON in userData/prefs.json.
//
// Per-chat settings (model, sandbox folder) continue to live on the chat row
// in SQLite. These prefs are the *defaults* applied when a new chat is
// created or when the CLI is invoked without an explicit override.

const fs = require('node:fs');
const path = require('node:path');

// Keep the shape narrow and explicit. Unknown keys are dropped on read.
const SCHEMA = {
  defaultModel: { type: 'string|null', default: null },
  defaultPermissionMode: { type: 'string', default: 'acceptEdits' },
  defaultAllowedTools: { type: 'string|null', default: null },  // comma list
  defaultDisallowedTools: { type: 'string|null', default: null },

  // Security posture for new cowork chats. See backend startClaude().
  //   'default'    — run claude on the host, permission-mode=acceptEdits
  //   'docker'     — wrap claude inside `docker run` with cwd bind-mounted
  //   'jailbroken' — run on host with bypassPermissions + no tool allow-list
  shellMode: { type: 'string', default: 'default' },
  // Image used when shellMode === 'docker'. Must contain a `claude` binary on
  // $PATH. Defaults to the reference image we document; users can point at
  // their own.
  dockerImage: { type: 'string', default: 'ghcr.io/anthropics/claude-code:latest' },

  // First-launch disclaimer. Gated by the DisclaimerModal in the renderer.
  // Once the user acknowledges the notice (unaffiliated w/ Anthropic, alpha
  // software, login handled by the official CLI, etc.) we flip this and stop
  // blocking the UI on subsequent launches.
  disclaimerAcknowledged: { type: 'boolean', default: false },
};

let filePath = null;
let cached = null;

function init(userDataDir) {
  filePath = path.join(userDataDir, 'prefs.json');
  cached = load();
  return cached;
}

function defaults() {
  const out = {};
  for (const [k, s] of Object.entries(SCHEMA)) out[k] = s.default;
  return out;
}

function normalize(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, s] of Object.entries(SCHEMA)) {
    if (!(k in raw)) continue;
    const v = raw[k];
    // Accept null for every field — the spawn helpers fall back to env/default.
    if (v === null) { out[k] = null; continue; }
    const types = s.type.split('|');
    if (types.includes(typeof v)) out[k] = v;
  }
  return out;
}

function load() {
  if (!filePath) throw new Error('prefs.init() not called');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalize(raw);
  } catch {
    // File missing or malformed — return defaults without touching disk yet.
    return defaults();
  }
}

function save(obj) {
  if (!filePath) throw new Error('prefs.init() not called');
  const next = normalize({ ...(cached || defaults()), ...(obj || {}) });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  cached = next;
  return next;
}

function get() {
  if (!cached) cached = load();
  return cached;
}

module.exports = { init, get, save, defaults };
