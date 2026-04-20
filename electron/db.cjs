// SQLite storage for chats + messages. Runs in the Electron main process and
// is exposed to the renderer over IPC (see preload.cjs).
//
// Schema:
//   chats(id, title, mode, model, api_session_id, claude_session_id,
//         sandbox_path, sandbox_paths_json, created_at, updated_at)
//   messages(id, chat_id, role, content, events_json, files_json, created_at)
//
// mode is 'chat' (pure conversation, no tools) or 'cowork' (agentic, with
// filesystem + bash access).
// model is the Claude model string (e.g. 'claude-sonnet-4-6'). NULL means
// "use the CLI's default — no --model flag".
// api_session_id is the backend session id (short, assigned when the
// sandbox is created).
// claude_session_id is the UUID the `claude` CLI picks on first turn.
// sandbox_path holds the primary working folder (or NULL for ephemeral).
// sandbox_paths_json is a JSON array of additional folders the CLI gets via
// --add-dir. The full list of working folders is [sandbox_path, ...extras].

const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

let db = null;

function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

function init(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const dbPath = path.join(userDataDir, 'cowork.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id                  TEXT PRIMARY KEY,
      title               TEXT NOT NULL DEFAULT 'New chat',
      mode                TEXT NOT NULL DEFAULT 'cowork',
      model               TEXT,
      api_session_id      TEXT,
      claude_session_id   TEXT,
      sandbox_path        TEXT,
      sandbox_paths_json  TEXT NOT NULL DEFAULT '[]',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role         TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content      TEXT NOT NULL DEFAULT '',
      events_json  TEXT NOT NULL DEFAULT '[]',
      files_json   TEXT NOT NULL DEFAULT '[]',
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
  `);

  // Migration: add mode column to existing installs that predate it.
  // CREATE TABLE IF NOT EXISTS doesn't alter existing tables, so older DBs
  // need this explicit ALTER. Default 'cowork' preserves prior behaviour.
  if (!columnExists('chats', 'mode')) {
    db.exec(`ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'cowork'`);
  }
  // Migration: add model column. NULL = use CLI default (no --model flag).
  if (!columnExists('chats', 'model')) {
    db.exec(`ALTER TABLE chats ADD COLUMN model TEXT`);
  }
  // Migration: add sandbox_paths_json (additional --add-dir folders).
  if (!columnExists('chats', 'sandbox_paths_json')) {
    db.exec(`ALTER TABLE chats ADD COLUMN sandbox_paths_json TEXT NOT NULL DEFAULT '[]'`);
  }

  return db;
}

const now = () => Date.now();
const newId = () => `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function rowToChat(r) {
  if (!r) return null;
  const extras = safeParse(r.sandbox_paths_json, []);
  return {
    id: r.id,
    title: r.title,
    mode: r.mode || 'cowork',
    model: r.model || null,
    apiSessionId: r.api_session_id,
    claudeSessionId: r.claude_session_id,
    sandboxPath: r.sandbox_path,
    sandboxPaths: Array.isArray(extras) ? extras : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMessage(r) {
  return {
    id: r.id,
    chatId: r.chat_id,
    role: r.role,
    content: r.content,
    events: safeParse(r.events_json, []),
    files: safeParse(r.files_json, []),
    createdAt: r.created_at,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

const api = {
  listChats() {
    return db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all().map(rowToChat);
  },
  getChat(id) {
    return rowToChat(db.prepare('SELECT * FROM chats WHERE id = ?').get(id));
  },
  createChat({
    title = 'New chat', mode = 'cowork', model = null,
    sandboxPath = null, sandboxPaths = [], claudeSessionId = null,
  } = {}) {
    const id = newId();
    const t = now();
    const normMode = mode === 'chat' ? 'chat' : 'cowork';
    const extras = JSON.stringify(Array.isArray(sandboxPaths) ? sandboxPaths : []);
    db.prepare(`INSERT INTO chats (id, title, mode, model, claude_session_id, sandbox_path, sandbox_paths_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, title, normMode, model || null, claudeSessionId || null, sandboxPath || null, extras, t, t);
    return this.getChat(id);
  },
  updateChat(id, patch) {
    const existing = this.getChat(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, updatedAt: now() };
    const mode = next.mode === 'chat' ? 'chat' : 'cowork';
    const extras = JSON.stringify(Array.isArray(next.sandboxPaths) ? next.sandboxPaths : []);
    db.prepare(`UPDATE chats
                SET title = ?, mode = ?, model = ?, api_session_id = ?, claude_session_id = ?,
                    sandbox_path = ?, sandbox_paths_json = ?, updated_at = ?
                WHERE id = ?`)
      .run(next.title, mode, next.model ?? null, next.apiSessionId ?? null, next.claudeSessionId ?? null,
           next.sandboxPath ?? null, extras, next.updatedAt, id);
    return this.getChat(id);
  },
  deleteChat(id) {
    db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    return { ok: true };
  },
  listMessages(chatId) {
    return db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
      .all(chatId).map(rowToMessage);
  },
  appendMessage(chatId, { role, content = '', events = [], files = [] }) {
    const id = newId();
    const t = now();
    db.prepare(`INSERT INTO messages (id, chat_id, role, content, events_json, files_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chatId, role, content, JSON.stringify(events), JSON.stringify(files), t);
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(t, chatId);
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  },
  updateMessage(id, patch) {
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!row) return null;
    const content = patch.content ?? row.content;
    const events = patch.events !== undefined ? JSON.stringify(patch.events) : row.events_json;
    const files = patch.files !== undefined ? JSON.stringify(patch.files) : row.files_json;
    db.prepare('UPDATE messages SET content = ?, events_json = ?, files_json = ? WHERE id = ?')
      .run(content, events, files, id);
    return rowToMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  },
};

module.exports = { init, api };
