import React, { useCallback, useRef, useState } from 'react';
import { uploadFiles } from '../lib/api.js';

// Autogrow textarea + drag/drop + attach button. Attachments are uploaded to
// the session sandbox before the prompt goes out. We annotate the outgoing
// prompt with the list of attached paths so Claude knows what to look at.

const MAX_ATTACH_LABEL = 28;

function truncate(s) {
  return s.length > MAX_ATTACH_LABEL ? s.slice(0, MAX_ATTACH_LABEL - 1) + '…' : s;
}

// Models the user can pick per chat. `null` means "use the CLI's default —
// don't pass --model at all", which respects whatever the user's CLI is
// configured for.
export const MODEL_OPTIONS = [
  { value: '',                   label: 'Default (CLI)' },
  { value: 'claude-opus-4-6',    label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6',  label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5',   label: 'Haiku 4.5' },
];

export default function Composer({
  onSubmit, disabled, apiSessionId, isStreaming, onStop, onEnsureSession,
  model, onModelChange,
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]); // [{name, size, savedPath, localSourcePath?}]
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef(null);

  const autogrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
  }, []);

  const ensureSession = useCallback(async () => {
    if (apiSessionId) return apiSessionId;
    return await onEnsureSession?.();
  }, [apiSessionId, onEnsureSession]);

  const uploadFileList = useCallback(async (files) => {
    if (!files || files.length === 0) return;
    const sid = await ensureSession();
    if (!sid) return;
    setUploading(true);
    try {
      const res = await uploadFiles(sid, files);
      const saved = (res?.files || []).map((f) => ({
        name: f.name,
        size: f.size,
        savedPath: f.path,
      }));
      setAttachments((a) => [...a, ...saved]);
    } catch (err) {
      console.error('upload failed', err);
    } finally {
      setUploading(false);
    }
  }, [ensureSession]);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) await uploadFileList(files);
  }, [uploadFileList]);

  const handlePaste = useCallback(async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      await uploadFileList(files);
    }
  }, [uploadFileList]);

  const handlePickFiles = useCallback(async () => {
    // We can't get File objects from the native dialog in a sandboxed renderer;
    // rely on <input type=file> for cross-platform simplicity.
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      await uploadFileList(Array.from(input.files || []));
    };
    input.click();
  }, [uploadFileList]);

  const submit = useCallback(async (e) => {
    e?.preventDefault();
    if (disabled || isStreaming) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    // Build the outgoing prompt — mention attached files so Claude sees them.
    let outgoing = trimmed;
    if (attachments.length) {
      const list = attachments.map((a) => `- ${a.savedPath}`).join('\n');
      outgoing = (trimmed ? trimmed + '\n\n' : '') + `Attached files in my sandbox:\n${list}`;
    }
    const displayParts = attachments.map((a) => `📎 ${a.name}`);
    const userDisplay = [trimmed, ...displayParts].filter(Boolean).join('\n');

    setText('');
    setAttachments([]);
    requestAnimationFrame(autogrow);
    await onSubmit?.({ prompt: outgoing, userDisplay });
  }, [text, attachments, disabled, isStreaming, onSubmit, autogrow]);

  return (
    <div className="px-4 pb-4 pt-2">
      <form
        onSubmit={submit}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={`relative rounded-2xl border bg-ink-800/60 backdrop-blur transition-colors
          ${dragging ? 'border-accent-500 bg-accent-500/10' : 'border-ink-700/70 focus-within:border-ink-500'}`}
      >
        {attachments.length > 0 && (
          <div className="px-3 pt-3 pb-1 flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <div key={i} className="text-xs bg-ink-700/80 text-ink-100 rounded-md px-2 py-1 flex items-center gap-1.5">
                <span>📎</span>
                <span title={a.savedPath}>{truncate(a.name)}</span>
                <button
                  type="button"
                  className="text-ink-400 hover:text-accent-500"
                  onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); autogrow(); }}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? 'Starting up…' : 'Message Claude. Drag files, paste, or attach.'}
          rows={1}
          disabled={disabled}
          className="w-full bg-transparent resize-none outline-none px-4 py-3 text-[14.5px] text-ink-50 placeholder:text-ink-500 max-h-[300px]"
        />

        <div className="px-3 pb-2 flex items-center gap-2 text-xs text-ink-400">
          <button
            type="button"
            onClick={handlePickFiles}
            className="px-2 py-1 rounded-md hover:bg-ink-700/70 transition-colors"
            disabled={disabled || uploading}
            title="Attach files"
          >
            {uploading ? 'Uploading…' : '📎 Attach'}
          </button>
          {onModelChange && (
            <select
              value={model || ''}
              onChange={(e) => onModelChange(e.target.value || null)}
              disabled={disabled}
              className="bg-ink-700/60 hover:bg-ink-700 text-ink-200 rounded-md px-2 py-1 text-xs border border-ink-700/70 outline-none focus:border-accent-500/60 disabled:opacity-50"
              title="Model used for this chat"
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          )}
          <span className="opacity-50 hidden sm:inline">Enter to send · Shift+Enter for newline</span>
          <div className="flex-1" />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="px-3 py-1 rounded-md bg-ink-700 hover:bg-ink-600 text-ink-100"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              className="px-3 py-1 rounded-md bg-accent-500 hover:bg-accent-600 text-white disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
