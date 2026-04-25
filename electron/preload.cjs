// Preload: the tiny bridge the renderer uses to talk to the main process.
// Renderer code lives in a sandboxed context — no Node APIs, no direct fs.
// All mutations (DB writes, backend URL, file pickers) flow through here.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('cowork', {
  // Backend info. Filled in once the in-process HTTP server is ready.
  getBackendInfo: () => invoke('backend:info'),
  getBackendLogs: () => invoke('backend:logs'),

  // App metadata — versions, paths, platform. Used by the Settings modal.
  getAppInfo: () => invoke('app:info'),

  // SQLite-backed chat store
  db: {
    listChats: () => invoke('db:listChats'),
    getChat: (id) => invoke('db:getChat', id),
    createChat: (opts) => invoke('db:createChat', opts),
    updateChat: (id, patch) => invoke('db:updateChat', { id, patch }),
    deleteChat: (id) => invoke('db:deleteChat', id),
    listMessages: (chatId) => invoke('db:listMessages', chatId),
    appendMessage: (chatId, msg) => invoke('db:appendMessage', { chatId, msg }),
    updateMessage: (id, patch) => invoke('db:updateMessage', { id, patch }),
  },

  // App-wide defaults (model, permission mode, tool allow/deny lists).
  // Per-chat overrides still live on the chat row; these are the fallbacks.
  prefs: {
    get: () => invoke('prefs:get'),
    save: (patch) => invoke('prefs:save', patch),
    defaults: () => invoke('prefs:defaults'),
  },

  // Native helpers
  openExternal: (url) => invoke('shell:openExternal', url),
  showItemInFolder: (localPath) => invoke('shell:showItemInFolder', localPath),
  pickFiles: () => invoke('dialog:pickFiles'),
  pickFolder: () => invoke('dialog:pickFolder'),
  pickFolders: () => invoke('dialog:pickFolders'),
  saveFileAs: (opts) => invoke('dialog:saveFileAs', opts), // { url, suggestedName }

  // App lifecycle niceties
  onBackendReady: (cb) => {
    const handler = (_evt, info) => cb(info);
    ipcRenderer.on('backend:ready', handler);
    return () => ipcRenderer.removeListener('backend:ready', handler);
  },

  // Approval-gate side-channel. The renderer's ApprovalModal also fires this
  // on every new approval (in addition to the broker's own server-side hook)
  // so the OS notification + window-focus path runs even before main has
  // wired up its broker listener — defensive belt-and-suspenders.
  approvals: {
    notify: (req) => invoke('approvals:notify', req),
  },
});
