import React, { useState } from 'react';

// Live "what Claude is doing" timeline. Renders inline above the assistant
// text bubble so the user sees real work as it streams: tool calls (Bash,
// Read, Edit, etc.) paired with their outputs.
//
// Event sources we consume:
//   tool_use    — backend emits one per tool the model invokes
//   tool_result — backend emits one per tool result (paired by tool_use_id)
//   file_event  — Write/Edit short-circuit (also redundantly emitted)
//   stderr      — raw stderr lines from the CLI
//   error       — backend-side errors
//   claude_event — legacy raw event (older persisted messages); we still try
//                  to surface tool_use blocks from inside it.

function legacyToolUses(evt) {
  const m = evt?.data;
  if (!m) return [];
  const content = m?.message?.content || [];
  return content
    .filter((c) => c.type === 'tool_use')
    .map((t) => ({ kind: 'tool_use', id: t.id, name: t.name, input: t.input }));
}

function legacyToolResults(evt) {
  const m = evt?.data;
  if (!m) return [];
  const content = m?.message?.content || [];
  return content
    .filter((c) => c.type === 'tool_result')
    .map((t) => ({
      kind: 'tool_result',
      tool_use_id: t.tool_use_id,
      content: typeof t.content === 'string' ? t.content
               : Array.isArray(t.content) ? t.content.map((x) => x.text || '').join('\n')
               : JSON.stringify(t.content),
      isError: !!t.is_error,
    }));
}

// Walk the event log in arrival order, building an ordered list of "steps".
// Each step is either a tool invocation (with optional resolved result) or a
// terminal-style stderr/error/file row.
function buildSteps(events) {
  const steps = [];
  const byToolId = new Map(); // tool_use_id -> step index in `steps`

  const pushToolUse = (tu) => {
    const idx = steps.length;
    steps.push({
      kind: 'tool',
      id: tu.id,
      name: tu.name,
      input: tu.input,
      result: null,
      isError: false,
    });
    if (tu.id) byToolId.set(tu.id, idx);
  };

  const pushToolResult = (tr) => {
    const idx = byToolId.get(tr.tool_use_id);
    if (idx != null) {
      steps[idx].result = tr.content;
      steps[idx].isError = !!tr.isError;
    } else {
      // Orphan result — render standalone.
      steps.push({
        kind: 'tool',
        id: tr.tool_use_id,
        name: '(result)',
        input: null,
        result: tr.content,
        isError: !!tr.isError,
      });
    }
  };

  for (const e of events) {
    switch (e.event) {
      case 'tool_use':
        pushToolUse(e.data || {});
        break;
      case 'tool_result':
        pushToolResult(e.data || {});
        break;
      case 'file_event':
        // File events are usually redundant with tool_use of Write/Edit. Only
        // surface them when no matching tool_use exists (e.g. external edits).
        steps.push({ kind: 'file', file: e.data });
        break;
      case 'stderr':
        steps.push({ kind: 'stderr', line: e.data?.line });
        break;
      case 'error':
        steps.push({ kind: 'error', message: e.data?.message });
        break;
      case 'claude_event':
        // Legacy events from older persisted messages.
        legacyToolUses(e).forEach(pushToolUse);
        legacyToolResults(e).forEach(pushToolResult);
        break;
      default:
        break;
    }
  }

  // Drop file rows that duplicate a Write/Edit tool_use we already showed.
  return steps.filter((s, i) => {
    if (s.kind !== 'file') return true;
    const path = s.file?.path;
    return !steps.some((o, j) =>
      j !== i &&
      o.kind === 'tool' &&
      (o.name === 'Write' || o.name === 'Edit') &&
      o.input?.file_path === path
    );
  });
}

function shortInput(name, input) {
  if (!input) return '';
  if (name === 'Bash') return input.command || '';
  if (name === 'Read') return input.file_path || '';
  if (name === 'Write') return input.file_path || '';
  if (name === 'Edit') return input.file_path || '';
  if (name === 'Glob') return input.pattern || '';
  if (name === 'Grep') return `${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`;
  if (name === 'WebFetch' || name === 'WebSearch') return input.url || input.query || '';
  try { return JSON.stringify(input); } catch { return ''; }
}

const ICONS = {
  Bash: '$',
  Read: '◇',
  Write: '✎',
  Edit: '✎',
  Glob: '⁂',
  Grep: '⌕',
  WebFetch: '⌬',
  WebSearch: '⌕',
};

function ToolStep({ step, streaming }) {
  const [open, setOpen] = useState(false);
  const icon = ICONS[step.name] || '▸';
  const label = shortInput(step.name, step.input);
  const result = step.result || '';
  const hasResult = result && result.length > 0;
  const truncated = result.length > 160;
  const preview = truncated ? result.slice(0, 160) + '…' : result;
  const isPending = !hasResult && streaming;

  // Bash gets a terminal-style block when the result is opened.
  const isBash = step.name === 'Bash';

  return (
    <div className={`rounded-md border ${step.isError ? 'border-red-500/40 bg-red-900/10' : 'border-ink-700/60 bg-ink-800/40'} text-xs overflow-hidden`}>
      <button
        type="button"
        onClick={() => hasResult && setOpen((v) => !v)}
        className={`w-full px-2.5 py-1.5 flex items-start gap-2 text-left ${hasResult ? 'hover:bg-ink-800/70 cursor-pointer' : 'cursor-default'}`}
      >
        <span className={`shrink-0 mt-[1px] font-mono ${step.isError ? 'text-red-400' : 'text-accent-500'}`}>{icon}</span>
        <span className="text-ink-200 font-medium shrink-0">{step.name}</span>
        <span className="text-ink-400 truncate flex-1 min-w-0 font-mono">{label}</span>
        {isPending && (
          <span className="shrink-0 text-ink-500 italic">running…</span>
        )}
        {hasResult && (
          <span className="shrink-0 text-ink-500">{open ? '▾' : '▸'}</span>
        )}
      </button>
      {open && hasResult && (
        <div className={`border-t border-ink-700/50 ${isBash ? 'bg-black/40' : 'bg-ink-900/40'}`}>
          <pre className={`m-0 px-3 py-2 text-[11.5px] whitespace-pre-wrap break-words font-mono max-h-72 overflow-auto ${isBash ? 'text-emerald-200' : 'text-ink-300'}`}>
            {result}
          </pre>
        </div>
      )}
      {!open && hasResult && truncated && (
        <div className="px-3 pb-1.5 text-[11px] text-ink-500 font-mono truncate">{preview}</div>
      )}
    </div>
  );
}

export default function EventTimeline({ events, streaming }) {
  const steps = buildSteps(events);
  if (steps.length === 0) return null;

  return (
    <div className="w-full max-w-[78ch] space-y-1.5">
      {steps.map((s, i) => {
        if (s.kind === 'tool') {
          return <ToolStep key={`t-${i}-${s.id || ''}`} step={s} streaming={streaming} />;
        }
        if (s.kind === 'file') {
          return (
            <div key={`f-${i}`} className="text-[11px] font-mono text-ink-400 px-2.5 py-1 rounded-md border border-ink-700/40 bg-ink-800/30 flex gap-2">
              <span className="text-emerald-400 shrink-0">◆</span>
              <span className="text-ink-200">{s.file?.kind}</span>
              <span className="truncate">{s.file?.path}</span>
            </div>
          );
        }
        if (s.kind === 'stderr') {
          return (
            <div key={`s-${i}`} className="text-[11px] font-mono text-ink-500 px-2.5 truncate">{s.line}</div>
          );
        }
        if (s.kind === 'error') {
          return (
            <div key={`e-${i}`} className="text-xs px-2.5 py-1.5 rounded-md border border-red-500/40 bg-red-900/20 text-red-200">
              error: {s.message}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
