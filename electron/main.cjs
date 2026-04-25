// Electron main process.
//
// Responsibilities:
//   1. Start the in-process HTTP backend (see backend.cjs) on a free loopback
//      port. The backend drives the `claude` CLI directly — no subprocess
//      server.
//   2. Open the BrowserWindow pointing at Vite (dev) or dist/index.html (prod).
//   3. Own the SQLite store and expose it via IPC.
//   4. Handle native dialogs (file picker, save-as) and shell actions.
//   5. Clean everything up on quit.

const { app, BrowserWindow, Notification, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { startBackend } = require('./backend.cjs');
const dbModule = require('./db.cjs');
const prefs = require('./prefs.cjs');

// Track the most recent notification per approval id so a duplicate signal
// (broker hook + renderer IPC) doesn't fire two pop-ups for the same prompt.
const recentApprovalNotices = new Map();

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

let mainWindow = null;
let backend = null; // { url, stop, getLogs }
let dbApi = null;

function resolveUserDataDir() {
  // app.getPath('userData') defaults to e.g. ~/.config/Cowork on Linux
  return app.getPath('userData');
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#17150f',
    title: 'Cowork',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  // Open links targeting _blank in the system browser, not a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function registerIpc() {
  ipcMain.handle('backend:info', () => backend ? { url: backend.url, port: backend.port, backendDir: backend.backendDir } : null);
  ipcMain.handle('backend:logs', () => backend ? backend.getLogs() : []);

  ipcMain.handle('app:info', () => ({
    appVersion: app.getVersion(),
    appName: app.getName(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    userDataPath: app.getPath('userData'),
  }));

  ipcMain.handle('db:listChats', () => dbApi.listChats());
  ipcMain.handle('db:getChat', (_e, id) => dbApi.getChat(id));
  ipcMain.handle('db:createChat', (_e, opts) => dbApi.createChat(opts || {}));
  ipcMain.handle('db:updateChat', (_e, { id, patch }) => dbApi.updateChat(id, patch || {}));
  ipcMain.handle('db:deleteChat', (_e, id) => dbApi.deleteChat(id));
  ipcMain.handle('db:listMessages', (_e, chatId) => dbApi.listMessages(chatId));
  ipcMain.handle('db:appendMessage', (_e, { chatId, msg }) => dbApi.appendMessage(chatId, msg));
  ipcMain.handle('db:updateMessage', (_e, { id, patch }) => dbApi.updateMessage(id, patch || {}));

  // Global preferences (default model, permission mode, allow/disallow tool
  // lists). These are the app-wide fallbacks the CLI inherits when a chat
  // doesn't override them.
  ipcMain.handle('prefs:get', () => prefs.get());
  ipcMain.handle('prefs:save', (_e, patch) => prefs.save(patch || {}));
  ipcMain.handle('prefs:defaults', () => prefs.defaults());

  ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('shell:showItemInFolder', (_e, p) => { shell.showItemInFolder(p); return true; });

  ipcMain.handle('dialog:pickFiles', async () => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return [];
    return res.filePaths;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a working folder',
    });
    if (res.canceled || !res.filePaths?.[0]) return null;
    return res.filePaths[0];
  });

  // Multi-select variant. macOS allows picking many directories at once;
  // Linux/Windows file dialogs only let you pick one even when multiSelections
  // is requested — that's a platform limitation, not ours.
  ipcMain.handle('dialog:pickFolders', async () => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
      title: 'Add working folders',
    });
    if (res.canceled || !res.filePaths?.length) return [];
    return res.filePaths;
  });

  // Renderer-side hint: the ApprovalModal calls this whenever it sees a new
  // approval request. Same path as the broker hook below — both go through
  // surfaceApproval() which dedupes on id. Belt-and-suspenders so a missed
  // server-side hook still produces a desktop notification.
  ipcMain.handle('approvals:notify', (_e, req) => {
    surfaceApproval(req);
    return true;
  });

  ipcMain.handle('dialog:saveFileAs', async (_e, { url, suggestedName } = {}) => {
    if (!mainWindow || !url) return { ok: false };
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedName || 'file',
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const r = await fetch(url);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(res.filePath, buf);
    return { ok: true, path: res.filePath };
  });
}

async function bootstrap() {
  const userData = resolveUserDataDir();
  dbModule.init(userData);
  dbApi = dbModule.api;
  prefs.init(userData);

  registerIpc();
  await createWindow();

  // Start backend in parallel with UI load. Sandboxes live in userData so they
  // persist across app restarts, matching the SQLite data location.
  const sandboxRoot = path.join(userData, 'sandboxes');
  fs.mkdirSync(sandboxRoot, { recursive: true });

  try {
    backend = await startBackend({
      app,
      sandboxRoot,
      // Native DE surface for permission prompts. Fires when the broker
      // (electron/approval.cjs) records a new pending request — i.e. the
      // exact moment the Claude CLI hits a tool gate. We pop a system
      // notification (libnotify on X11/Wayland/Hyprland via Electron) and
      // bring the Cowork window forward so the in-app modal is visible.
      onApprovalPending: (req) => surfaceApproval(req),
    });
  } catch (err) {
    dialog.showErrorBox('Backend failed to start', String(err?.stack || err));
    app.quit();
    return;
  }

  if (mainWindow) {
    mainWindow.webContents.send('backend:ready', { url: backend.url });
  }
}

// Render a permission request as a desktop-environment notification + bring
// the Cowork window to the front. Idempotent on `req.id` — both the broker
// hook and the renderer's preload IPC may call this for the same approval,
// and we only want one notification per id.
function surfaceApproval(req) {
  if (!req || !req.id) return;

  // Bring the window forward so the in-app modal is visible. We deliberately
  // don't use focus() exclusively — on Wayland (and some X11 WMs) windows
  // can't steal focus, but show()+restore() at least pulls them out of the
  // tray / minimized state.
  if (mainWindow) {
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } catch { /* window may be tearing down */ }
  }

  // Dedupe by id with a short TTL so a notification doesn't fire twice in a
  // burst but still rearms if the same id (somehow) recurs later.
  const last = recentApprovalNotices.get(req.id);
  if (last && Date.now() - last < 30_000) return;
  recentApprovalNotices.set(req.id, Date.now());
  // Keep the map from growing unboundedly across long sessions.
  if (recentApprovalNotices.size > 200) {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [id, ts] of recentApprovalNotices) {
      if (ts < cutoff) recentApprovalNotices.delete(id);
    }
  }

  if (!Notification.isSupported()) return;

  const title = describeTool(req.toolName);
  const body = describeInput(req.toolName, req.input || {}, req.summary);

  const n = new Notification({
    title,
    body,
    // urgent so dunst/mako/notify-osd render it persistently rather than as
    // a brief toast — the user might be in another workspace.
    urgency: 'critical',
    silent: false,
  });
  n.on('click', () => {
    if (!mainWindow) return;
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } catch { /* */ }
  });
  try { n.show(); } catch { /* notification daemon offline — modal still works */ }
}

// Friendly name for the notification title.
function describeTool(name) {
  if (!name) return 'Cowork: tool approval needed';
  if (name === 'Bash') return 'Cowork: shell command needs approval';
  if (name === 'Write') return 'Cowork: file write needs approval';
  if (name === 'Edit' || name === 'MultiEdit') return 'Cowork: file edit needs approval';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return `Cowork: ${parts[1] || 'MCP'} tool needs approval`;
  }
  return `Cowork: ${name} needs approval`;
}

// One-line preview of what's being asked. Truncated aggressively so the
// notification daemon doesn't expand into a wall of text.
function describeInput(toolName, input, summary) {
  if (typeof summary === 'string' && summary.length) return summary.slice(0, 200);
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return truncate(input.command, 200);
  }
  if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && (input.file_path || input.path)) {
    return String(input.file_path || input.path);
  }
  try { return truncate(JSON.stringify(input), 200); }
  catch { return 'See Cowork to review and approve.'; }
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (!backend) return;
  e.preventDefault();
  try { await backend.stop(); } catch {}
  backend = null;
  app.exit(0);
});

app.whenReady().then(bootstrap);
