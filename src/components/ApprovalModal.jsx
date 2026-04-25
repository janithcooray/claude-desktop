import React, { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeApprovals, answerApproval, getPendingApprovals } from '../lib/api.js';

// Pops up whenever the Claude CLI hits a permission gate. The CLI's request
// is forwarded by the stdio MCP shim (electron/approval-mcp.cjs) into the
// Cowork backend's broker (electron/approval.cjs); from there it fans out to
// every connected renderer via SSE plus a native DE notification fired by the
// Electron main process.
//
// This component:
//   1. Subscribes to /approval/events on mount and snapshots pending requests
//      so a freshly-loaded UI catches up instantly.
//   2. Renders a modal for the head of the pending queue. Allow / Deny calls
//      /approval/answer; the head is dropped optimistically and the next
//      pending request takes its place.
//   3. Stays out of the way when there's nothing pending — returns null.
//
// We deliberately don't auto-allow anything here. The whole point of the
// surface is to put the user in the driver's seat.

export default function ApprovalModal({ backendReady }) {
  // Map<id, request> so we can dedupe SSE events vs the snapshot frame and
  // remove resolved entries by id even if the user has been switching modals.
  const [pending, setPending] = useState(() => new Map());
  // Optimistic guard so double-clicks on Allow/Deny don't fire two requests.
  const [submitting, setSubmitting] = useState(false);
  // Remember the most recent request id we already processed in onPending so
  // we don't ping main twice for the same id when SSE replays after a reconnect.
  const seenRef = useRef(new Set());

  useEffect(() => {
    if (!backendReady) return;
    let cancelled = false;
    let unsubscribe = null;

    (async () => {
      // Initial snapshot — covers the case where an approval landed before
      // the SSE stream connected (rare; SSE sends its own snapshot too).
      try {
        const snap = await getPendingApprovals();
        if (cancelled) return;
        applyPending(snap?.pending || []);
      } catch { /* SSE will catch up */ }

      unsubscribe = await subscribeApprovals(({ event, data }) => {
        if (cancelled || !data) return;
        if (event === 'snapshot') {
          applyPending(data.pending || []);
        } else if (event === 'approval_pending') {
          applyPending([data], { merge: true });
          // Fire native DE notification + window focus via main. The broker
          // already triggers this server-side, but doing it from the
          // renderer too means the notification fires even if main's hook
          // isn't wired yet (defensive — and the OS dedupes by tag).
          notifyDE(data);
        } else if (event === 'approval_resolved') {
          setPending((m) => {
            if (!m.has(data.id)) return m;
            const n = new Map(m);
            n.delete(data.id);
            return n;
          });
        }
      });
    })();

    return () => {
      cancelled = true;
      try { unsubscribe?.(); } catch {}
    };
    function applyPending(list, { merge = false } = {}) {
      setPending((m) => {
        const next = merge ? new Map(m) : new Map();
        for (const req of list) {
          if (!req || !req.id) continue;
          next.set(req.id, req);
        }
        return next;
      });
    }
    function notifyDE(req) {
      if (seenRef.current.has(req.id)) return;
      seenRef.current.add(req.id);
      try {
        window.cowork?.approvals?.notify?.({
          id: req.id,
          toolName: req.toolName,
          summary: summarizeInput(req.toolName, req.input),
        });
      } catch { /* main may not have wired the IPC yet */ }
    }
  }, [backendReady]);

  // Pick the oldest pending request for display. Stable order keeps the user
  // from being whipsawed if a second request lands while the first is still
  // up.
  const queue = useMemo(
    () => Array.from(pending.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)),
    [pending],
  );
  const head = queue[0] || null;
  const remaining = Math.max(0, queue.length - 1);

  // Reset the submitting guard whenever the head changes — a stale "submitting"
  // flag would otherwise lock out the user on the next prompt.
  useEffect(() => { setSubmitting(false); }, [head?.id]);

  if (!head) return null;

  const onDecision = async (behavior) => {
    if (submitting) return;
    setSubmitting(true);
    // Drop optimistically so the modal doesn't flicker on slow networks. If
    // the POST fails we put it back so the user can retry.
    const id = head.id;
    setPending((m) => {
      if (!m.has(id)) return m;
      const n = new Map(m);
      n.delete(id);
      return n;
    });
    try {
      await answerApproval(id, { behavior });
    } catch (err) {
      // Network blip — restore the request so the user can try again. The
      // broker's auto-deny timer is the safety net if this also fails.
      setPending((m) => {
        if (m.has(id)) return m;
        const n = new Map(m);
        n.set(id, head);
        return n;
      });
      // eslint-disable-next-line no-console
      console.warn('[approvals] answer failed:', err);
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/80 backdrop-blur-sm">
      <div className="w-[560px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto bg-ink-900 border border-ink-700 rounded-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-ink-700 flex items-center gap-3">
          <span className="text-base leading-none">⚠</span>
          <div className="flex-1 min-w-0">
            <div className="text-ink-50 text-sm font-semibold">
              Claude wants to use a tool
            </div>
            <div className="text-ink-400 text-[11.5px] mt-0.5">
              {summarizeTool(head.toolName)}
            </div>
          </div>
          {remaining > 0 && (
            <span
              title={`${remaining} more request${remaining === 1 ? '' : 's'} queued`}
              className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink-700/60 text-ink-200 border border-ink-600/60"
            >
              +{remaining}
            </span>
          )}
        </div>

        <div className="px-5 py-4 space-y-3 text-[12.5px] text-ink-200 leading-relaxed">
          <div className="text-ink-300">
            Review the request below before allowing. Denying tells the model{' '}
            <em>why</em> the call was rejected so it can adapt.
          </div>
          <ToolPreview toolName={head.toolName} input={head.input || {}} />
        </div>

        <div className="px-5 py-3 border-t border-ink-700 bg-ink-900/60 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => onDecision('deny')}
            className="text-xs font-medium px-3.5 py-1.5 rounded-md bg-ink-800 text-ink-100 hover:bg-ink-700 border border-ink-700 disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onDecision('allow')}
            className="text-xs font-medium px-3.5 py-1.5 rounded-md bg-accent-500 text-ink-950 hover:bg-accent-400 disabled:opacity-50"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

// Try to render the input nicely. Bash → command in a code block, file ops →
// path + a peek at the content, everything else → JSON dump. Truncated so a
// huge Write payload doesn't push the buttons off-screen.
function ToolPreview({ toolName, input }) {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return (
      <div>
        <Field label="Command" />
        <pre className="mt-1 px-3 py-2 rounded bg-ink-950/70 border border-ink-700 text-[11.5px] text-ink-100 whitespace-pre-wrap break-all font-mono max-h-60 overflow-auto">
          {input.command}
        </pre>
        {input.description && (
          <div className="mt-2 text-[11.5px] text-ink-300">
            <span className="text-ink-400">Why: </span>{input.description}
          </div>
        )}
      </div>
    );
  }
  if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && (input.file_path || input.path)) {
    const filePath = input.file_path || input.path;
    const body = input.content || input.new_string || input.new_text || '';
    return (
      <div>
        <Field label="File" />
        <div className="mt-1 px-3 py-1.5 rounded bg-ink-950/70 border border-ink-700 text-[11.5px] font-mono text-ink-100 break-all">
          {filePath}
        </div>
        {body && (
          <>
            <Field label={toolName === 'Write' ? 'Contents' : 'New text'} className="mt-3" />
            <pre className="mt-1 px-3 py-2 rounded bg-ink-950/70 border border-ink-700 text-[11.5px] text-ink-100 whitespace-pre-wrap font-mono max-h-60 overflow-auto">
              {truncate(String(body), 2000)}
            </pre>
          </>
        )}
      </div>
    );
  }
  // Fallback — show the raw JSON. Keeps the modal useful for unknown / new
  // tools without us having to special-case every one.
  let pretty;
  try { pretty = JSON.stringify(input, null, 2); } catch { pretty = String(input); }
  return (
    <div>
      <Field label="Input" />
      <pre className="mt-1 px-3 py-2 rounded bg-ink-950/70 border border-ink-700 text-[11.5px] text-ink-100 whitespace-pre-wrap font-mono max-h-60 overflow-auto">
        {truncate(pretty, 2000)}
      </pre>
    </div>
  );
}

function Field({ label, className = '' }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-wider text-ink-400 ${className}`}>
      {label}
    </div>
  );
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n…[truncated ${s.length - n} more chars]`;
}

// Map raw tool ids to a human-readable subtitle. Falls back to the raw id —
// MCP tools come through as `mcp__<server>__<tool>` and we want the user to
// see exactly what's running, not a polished-but-wrong label.
function summarizeTool(name) {
  if (!name) return 'Unknown tool';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) return `MCP: ${parts[1]} → ${parts.slice(2).join('__')}`;
  }
  const known = {
    Bash: 'Run a shell command',
    Write: 'Create or overwrite a file',
    Edit: 'Modify a file',
    MultiEdit: 'Apply multiple file edits',
    Read: 'Read a file',
    Glob: 'Search for files by name',
    Grep: 'Search inside files',
    WebFetch: 'Fetch a URL',
    WebSearch: 'Run a web search',
  };
  return known[name] || name;
}

// Used as the OS notification body — short and identifying, since the user
// might see this outside the Cowork window.
function summarizeInput(toolName, input) {
  if (!input) return toolName;
  if (toolName === 'Bash' && input.command) return truncate(String(input.command), 120);
  if ((toolName === 'Write' || toolName === 'Edit') && (input.file_path || input.path)) {
    return String(input.file_path || input.path);
  }
  try { return truncate(JSON.stringify(input), 120); }
  catch { return toolName; }
}
