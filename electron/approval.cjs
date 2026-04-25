// Approval broker — surfaces Claude CLI permission requests to the user via
// Cowork's UI and the host's Desktop Environment.
//
// Why this exists:
//   The `claude` CLI gates risky tool calls (Bash, Write, Edit, …) behind a
//   permission prompt. In Cowork we run the CLI headlessly, so a prompt with
//   nowhere to go = a hung turn. Until now we worked around this by either
//   widening --allowed-tools (jailbroken) or auto-allowing every installed
//   MCP server's tools; that's coarse and the user has no say in the moment.
//
//   This module is the missing surface. The CLI is launched with
//   `--permission-prompt-tool mcp__cowork-approval__prompt`, pointed at a
//   tiny stdio MCP server we ship (`approval-mcp.cjs`). When the CLI hits a
//   gated tool it calls that MCP tool, which POSTs to /approval/request on
//   this backend and blocks. The broker then:
//     1. records the pending request,
//     2. fans it out to every SSE subscriber (the Cowork renderer pops a
//        modal),
//     3. fires a native DE notification via the `onPending` hook so the user
//        sees it even when Cowork isn't focused (X11 / Wayland / Hyprland —
//        Electron's Notification API uses libnotify under the hood),
//     4. waits for the user's answer (Allow / Deny), then resolves the
//        promise the MCP shim is awaiting on, which returns the decision
//        back to the CLI so the turn can proceed.
//
//   Pending requests live in-memory only. If the backend restarts mid-turn,
//   the spawned CLI dies with it and the request is moot.

const crypto = require('node:crypto');

// id -> { id, sessionId, toolName, toolUseId, input, createdAt, resolve, timer }
const PENDING = new Map();

// SSE subscribers — each is a function(event, data) the route handler wired up
// against an open HTTP response.
const SUBSCRIBERS = new Set();

// Hook for the Electron main process: when a request arrives, we call this so
// it can fire a native notification, focus the window, etc. Set via init().
let onPendingHook = null;

// 10 minutes. Generous enough for the user to step away from the computer and
// come back; short enough that an abandoned turn doesn't sit in memory forever.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function init({ onPending } = {}) {
  onPendingHook = typeof onPending === 'function' ? onPending : null;
}

function broadcast(event, data) {
  for (const send of SUBSCRIBERS) {
    try { send(event, data); } catch { /* dead subscriber, will be GC'd on next /events */ }
  }
}

// Public-facing shape of a pending request — strips the internal resolver/timer
// so we can broadcast it freely without leaking handles.
function publicShape(p) {
  return {
    id: p.id,
    sessionId: p.sessionId || null,
    toolName: p.toolName,
    toolUseId: p.toolUseId || null,
    input: p.input || {},
    createdAt: p.createdAt,
  };
}

function listPending() {
  return Array.from(PENDING.values()).map(publicShape);
}

// Called by /approval/request (i.e. by the MCP shim). Returns a promise that
// resolves with the user's decision. The shim awaits this and returns the
// decision back to the CLI.
function requestApproval({ toolName, toolUseId, input, sessionId, timeoutMs } = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const t = Math.max(5000, Math.min(60 * 60 * 1000, timeoutMs || DEFAULT_TIMEOUT_MS));

  return new Promise((resolve) => {
    const entry = {
      id,
      sessionId: sessionId || null,
      toolName: toolName || 'unknown',
      toolUseId: toolUseId || null,
      input: input && typeof input === 'object' ? input : {},
      createdAt: Date.now(),
      resolve,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      // Auto-deny on timeout. The CLI surfaces this as a tool error; the user
      // can re-ask if they meant to allow it.
      const pending = PENDING.get(id);
      if (!pending) return;
      PENDING.delete(id);
      broadcast('approval_resolved', { id, behavior: 'deny', reason: 'timeout' });
      pending.resolve({
        behavior: 'deny',
        message: `User did not respond within ${Math.round(t / 1000)}s. Auto-denied.`,
      });
    }, t);
    PENDING.set(id, entry);

    const pub = publicShape(entry);
    broadcast('approval_pending', pub);

    // Native DE surface (notification + window focus). Best-effort; if it
    // throws we still have the in-app modal as the primary path.
    if (onPendingHook) {
      try { onPendingHook(pub); } catch { /* ignore */ }
    }
  });
}

// Called by /approval/answer (i.e. by the renderer). Returns true if a matching
// pending request was found and resolved.
function submitDecision(id, { behavior, message, updatedInput } = {}) {
  const entry = PENDING.get(id);
  if (!entry) return false;
  PENDING.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  const decision = {
    behavior: behavior === 'allow' ? 'allow' : 'deny',
  };
  if (decision.behavior === 'allow' && updatedInput && typeof updatedInput === 'object') {
    decision.updatedInput = updatedInput;
  }
  if (typeof message === 'string' && message.length) decision.message = message;
  broadcast('approval_resolved', { id, behavior: decision.behavior });
  entry.resolve(decision);
  return true;
}

// Called when an SSE client connects. Sends the current snapshot so a freshly-
// loaded UI catches up on any in-flight prompts, then registers the sender for
// future broadcasts. Returns an unsubscribe function the route handler must
// call when the client disconnects.
function subscribeEvents(send) {
  // Snapshot first so the modal can pop immediately on reload.
  try { send('snapshot', { pending: listPending() }); } catch { /* */ }
  SUBSCRIBERS.add(send);
  return () => SUBSCRIBERS.delete(send);
}

// Drop every pending request that belongs to a given session — used when the
// associated chat session is destroyed so the MCP shim's promise doesn't sit
// around waiting for an answer that will never come.
function cancelForSession(sessionId) {
  if (!sessionId) return 0;
  let n = 0;
  for (const [id, entry] of PENDING) {
    if (entry.sessionId !== sessionId) continue;
    PENDING.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    broadcast('approval_resolved', { id, behavior: 'deny', reason: 'session_ended' });
    entry.resolve({ behavior: 'deny', message: 'Session ended before user responded.' });
    n += 1;
  }
  return n;
}

module.exports = {
  init,
  requestApproval,
  submitDecision,
  subscribeEvents,
  listPending,
  cancelForSession,
};
