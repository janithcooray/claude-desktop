import React, { useEffect, useMemo, useState } from 'react';
import { absolutizeFileUrl, chatFileUrl, fileUrl } from '../lib/api.js';

// Resolve a file's preview URL to an *absolute* backend URL.
//
// Prefer the chat-keyed endpoint (`/chats/:chatId/files/:path`) — that URL
// survives app restarts because the backend resolves it against a
// deterministic per-chat cwd plus any live session's attached folders.
// Session-keyed URLs stored on old messages reference in-memory session ids
// that evaporate on restart, so those always 404 once the app has been
// closed and reopened. Fall back to them only as a last resort.
function resolveUrl(file, chat) {
  if (chat?.id && file?.path) {
    return chatFileUrl(chat.id, file.path);
  }
  if (chat?.apiSessionId && file?.path) {
    return fileUrl(chat.apiSessionId, file.path);
  }
  const abs = absolutizeFileUrl(file?.url);
  if (abs) return abs;
  return '';
}
import { renderMarkdown } from '../lib/markdown.jsx';

// Right-side panel listing every file Claude has touched in this chat, plus
// a type-aware preview for common file kinds. "Save As…" uses the Electron
// save dialog via the preload bridge.

// Pick a renderer strategy per file extension. The goal is that each type
// previews as the *rendered* thing (webpage, formatted markdown, table, PDF
// viewer, image) rather than its source text — with a "View source" toggle
// available where it makes sense.
function guessKind(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'].includes(ext)) return 'image';
  if (ext === 'svg') return 'svg';
  if (ext === 'pdf') return 'pdf';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (ext === 'json') return 'json';
  if (['csv', 'tsv'].includes(ext)) return 'table';
  if (['txt', 'log', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return 'text';
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'css', 'scss', 'sass', 'less', 'sh', 'bash', 'zsh', 'fish', 'sql', 'lua', 'php', 'swift', 'kt', 'dart'].includes(ext)) return 'code';
  return 'blob';
}

// Truncate giant files so a 500MB log doesn't nuke the renderer.
const TEXT_PREVIEW_LIMIT = 200_000;

function mergeFileEvents(messages, liveFiles) {
  const map = new Map();
  // First, files collected from finalized messages
  for (const m of messages) {
    for (const f of (m.files || [])) map.set(f.path, { ...f });
  }
  // Then, overlay live files from the turn in progress
  for (const f of (liveFiles || [])) map.set(f.path, { ...f });
  return Array.from(map.values()).sort((a, b) => (b.at || 0) - (a.at || 0));
}

function FilePreview({ file, chat }) {
  const [text, setText] = useState(null);
  const [err, setErr] = useState(null);
  const [showSource, setShowSource] = useState(false);
  // Liveness check for the file URL — lets us show a clear error for the
  // binary-rendered kinds (iframe, img, object) that would otherwise just
  // display the backend's blank 404 body.
  const [urlStatus, setUrlStatus] = useState(null); // 'ok' | number (http code) | 'error'
  const kind = guessKind(file.path);
  const url = resolveUrl(file, chat);

  // Reset toggle when navigating between files.
  useEffect(() => { setShowSource(false); }, [file.path]);

  // Liveness-check the URL so iframe/image/pdf/svg kinds can show an error
  // instead of rendering a blank 404 body. Try HEAD first (cheap), but fall
  // back to a tiny ranged GET if the server rejects HEAD with 405 — older
  // builds of the backend only allowed GET on this route.
  useEffect(() => {
    let cancel = false;
    setUrlStatus(null);
    if (!url) return;
    (async () => {
      const probe = async (method, init = {}) => {
        try { return await fetch(url, { method, ...init }); } catch { return null; }
      };
      let r = await probe('HEAD');
      if (cancel) return;
      // 405 / 501 → server doesn't support HEAD. Re-probe with a 0-byte
      // ranged GET so we still learn the status without slurping the file.
      if (r && (r.status === 405 || r.status === 501)) {
        r = await probe('GET', { headers: { Range: 'bytes=0-0' } });
        if (cancel) return;
      }
      if (!r) { setUrlStatus('error'); return; }
      // Treat 200, 206 (partial), and 304 (not modified) all as "the file is
      // there" — the iframe / img will figure out the rest.
      const ok = r.status === 200 || r.status === 206 || r.status === 304;
      setUrlStatus(ok ? 'ok' : r.status);
    })();
    return () => { cancel = true; };
  }, [url]);

  // Pull the raw text for any kind that benefits from in-memory inspection
  // (markdown rendering, JSON pretty-print, CSV table, code, source toggles).
  // Binary kinds (image/pdf) skip the fetch — they're streamed straight into
  // their respective elements.
  const wantsText = kind === 'markdown' || kind === 'json' || kind === 'table'
    || kind === 'text' || kind === 'code' || kind === 'svg'
    || (kind === 'html' && showSource);

  useEffect(() => {
    let cancel = false;
    setText(null);
    setErr(null);
    if (!wantsText || !url) return;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        if (cancel) return;
        setText(t.length > TEXT_PREVIEW_LIMIT
          ? t.slice(0, TEXT_PREVIEW_LIMIT) + '\n\n…truncated'
          : t);
      } catch (e) {
        if (!cancel) setErr(String(e?.message || e));
      }
    })();
    return () => { cancel = true; };
  }, [url, wantsText]);

  // Unavailable URL (404 / network error). Show a concrete error instead of
  // the blank iframe / missing image the browser would render by default.
  const unreachable = urlStatus !== null && urlStatus !== 'ok';

  // Type-specific renderers. Each branch returns a complete preview, and a few
  // (html, markdown, svg) include a "View source" / "Open in browser" toggle.
  if (kind === 'image') {
    if (unreachable) return <UrlErrorPane status={urlStatus} file={file} />;
    return (
      <div className="flex items-center justify-center bg-ink-800/40 rounded-md border border-ink-700/70 p-2">
        <img src={url} alt={file.path} className="max-w-full max-h-[60vh] rounded" />
      </div>
    );
  }

  if (kind === 'pdf') {
    if (unreachable) return <UrlErrorPane status={urlStatus} file={file} />;
    return (
      <iframe
        src={url}
        title={file.path}
        className="w-full h-[60vh] rounded-md border border-ink-700/70 bg-white"
      />
    );
  }

  if (kind === 'html') {
    return (
      <div>
        <PreviewToolbar
          showSource={showSource}
          onToggle={() => setShowSource((s) => !s)}
        />
        {showSource ? (
          <SourcePane text={text} err={err} />
        ) : unreachable ? (
          <UrlErrorPane status={urlStatus} file={file} />
        ) : (
          <iframe
            src={url}
            title={file.path}
            // sandbox keeps a malicious page from reaching the renderer's APIs,
            // but allows-scripts + allow-same-origin so a normal page (with
            // its own JS, fonts, sibling assets) renders the way the user
            // expects when they say "open the html".
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            className="w-full h-[60vh] rounded-md border border-ink-700/70 bg-white"
          />
        )}
      </div>
    );
  }

  if (kind === 'svg') {
    return (
      <div>
        <PreviewToolbar
          showSource={showSource}
          onToggle={() => setShowSource((s) => !s)}
        />
        {showSource ? (
          <SourcePane text={text} err={err} />
        ) : unreachable ? (
          <UrlErrorPane status={urlStatus} file={file} />
        ) : (
          <div className="flex items-center justify-center bg-ink-800/40 rounded-md border border-ink-700/70 p-3">
            {/* Use <object> so the SVG's intrinsic sizing is respected and
                inline scripts/animations work as authored. */}
            <object data={url} type="image/svg+xml" className="max-w-full max-h-[60vh]">
              <img src={url} alt={file.path} className="max-w-full max-h-[60vh]" />
            </object>
          </div>
        )}
      </div>
    );
  }

  if (kind === 'markdown') {
    if (text === null) return <PreviewLoading err={err} />;
    return (
      <div>
        <PreviewToolbar
          showSource={showSource}
          onToggle={() => setShowSource((s) => !s)}
        />
        {showSource ? (
          <SourcePane text={text} err={err} />
        ) : (
          <div className="bg-ink-800/40 rounded-md border border-ink-700/70 p-4 max-h-[60vh] overflow-auto prose-invert text-ink-100 text-sm">
            <div className="prose-cw">{renderMarkdown(text)}</div>
          </div>
        )}
      </div>
    );
  }

  if (kind === 'json') {
    if (text === null) return <PreviewLoading err={err} />;
    let pretty = text;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* leave as-is if malformed */ }
    return <SourcePane text={pretty} err={err} />;
  }

  if (kind === 'table') {
    if (text === null) return <PreviewLoading err={err} />;
    return <CsvTable text={text} delimiter={file.path.endsWith('.tsv') ? '\t' : ','} />;
  }

  if (text !== null) {
    return <SourcePane text={text} err={err} />;
  }
  if (err) {
    return <div className="text-xs text-red-400">Preview failed: {err}</div>;
  }
  return (
    <div className="text-xs text-ink-400">
      No inline preview for this file type.{' '}
      <a href={url} onClick={(e) => { e.preventDefault(); window.cowork?.openExternal?.(url); }}
         className="text-accent-500 hover:text-accent-400 underline">
        Open externally
      </a>.
    </div>
  );
}

function PreviewToolbar({ showSource, onToggle }) {
  return (
    <div className="flex items-center gap-2 mb-2 text-[11px]">
      <button
        type="button"
        onClick={onToggle}
        className="px-2 py-0.5 rounded border border-ink-700/70 bg-ink-800/60 text-ink-200 hover:bg-ink-700/70"
      >
        {showSource ? '◐ Rendered view' : '⟨/⟩ View source'}
      </button>
    </div>
  );
}

function PreviewLoading({ err }) {
  if (err) return <div className="text-xs text-red-400">Preview failed: {err}</div>;
  return <div className="text-xs text-ink-500">Loading…</div>;
}

// Shown when the backend can't stream the file (404 / network error). Gives
// the user a concrete next step rather than a blank iframe. 404 is almost
// always "file doesn't exist under any attached root" — often because the
// primary cwd has changed or the file was written outside every attached
// folder; both are recoverable by re-running the step.
function UrlErrorPane({ status, file }) {
  const is404 = status === 404;
  return (
    <div className="bg-ink-800/40 rounded-md border border-accent-500/40 p-4 text-sm text-ink-200">
      <div className="font-medium text-accent-500 mb-1">
        {is404 ? 'File not found on the backend' : `Preview error (${status})`}
      </div>
      <div className="text-xs text-ink-300 mb-2">
        Tried to load <code className="font-mono text-ink-200">{file.path}</code>.
      </div>
      <div className="text-xs text-ink-400">
        {is404
          ? 'The file may have been deleted, or it lives outside the folders currently attached to this chat. Try re-running the step, or attach the folder that contains it.'
          : 'The backend returned an error while streaming the file.'}
      </div>
    </div>
  );
}

function SourcePane({ text, err }) {
  if (err) return <div className="text-xs text-red-400">Preview failed: {err}</div>;
  if (text === null || text === undefined) return <PreviewLoading />;
  return (
    <pre className="text-[12px] leading-relaxed font-mono bg-ink-800/60 text-ink-100 rounded-md p-3 border border-ink-700/70 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

// Cheap, single-quote-aware CSV/TSV parser. Good enough for previewing — it's
// not meant to round-trip exotic spreadsheet exports. Truncates to MAX_ROWS so
// a million-row file doesn't lock the tab.
const MAX_TABLE_ROWS = 500;
function parseDelimited(src, delim) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; if (rows.length > MAX_TABLE_ROWS) break; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function CsvTable({ text, delimiter }) {
  const rows = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  if (!rows.length) return <div className="text-xs text-ink-500">Empty file.</div>;
  const [header, ...body] = rows;
  return (
    <div className="bg-ink-800/40 rounded-md border border-ink-700/70 max-h-[60vh] overflow-auto">
      <table className="w-full text-[12px] border-collapse">
        <thead className="sticky top-0 bg-ink-800/95 backdrop-blur">
          <tr>
            {header.map((h, i) => (
              <th key={i} className="text-left px-2 py-1 border-b border-ink-700/70 text-ink-200 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className={ri % 2 ? 'bg-ink-900/30' : ''}>
              {r.map((cell, ci) => (
                <td key={ci} className="px-2 py-1 border-b border-ink-700/40 text-ink-100 align-top whitespace-pre-wrap break-words">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_TABLE_ROWS && (
        <div className="text-[11px] text-ink-500 px-2 py-1 border-t border-ink-700/70">
          Showing first {MAX_TABLE_ROWS} rows.
        </div>
      )}
    </div>
  );
}

export default function FilesPanel({ chat, messages, liveFiles }) {
  const files = useMemo(() => mergeFileEvents(messages, liveFiles), [messages, liveFiles]);
  const [selected, setSelected] = useState(null);

  // Auto-select most recent file
  useEffect(() => {
    if (!files.length) { setSelected(null); return; }
    if (!selected || !files.find((f) => f.path === selected.path)) {
      setSelected(files[0]);
    }
  }, [files, selected]);

  const handleOpen = async () => {
    if (!selected) return;
    const url = resolveUrl(selected, chat);
    if (url) await window.cowork.openExternal(url);
  };

  const handleSaveAs = async () => {
    if (!selected) return;
    const url = resolveUrl(selected, chat);
    const suggestedName = selected.path.split('/').pop();
    await window.cowork.saveFileAs({ url, suggestedName });
  };

  return (
    <aside className="w-80 shrink-0 border-l border-ink-700/60 bg-ink-900/80 flex flex-col">
      <div className="px-3 py-3 border-b border-ink-700/60">
        <div className="text-xs uppercase tracking-wide text-ink-400">Files</div>
        <div className="text-[11px] text-ink-500 mt-0.5">
          {chat ? `${files.length} in this chat` : 'No chat selected'}
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto border-b border-ink-700/60">
        {files.length === 0 && (
          <div className="p-3 text-xs text-ink-500">
            Files Claude creates or edits will show up here.
          </div>
        )}
        {files.map((f) => {
          const active = selected?.path === f.path;
          return (
            <button
              key={f.path}
              onClick={() => setSelected(f)}
              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs border-l-2 transition-colors
                ${active ? 'border-accent-500 bg-ink-800/70 text-ink-50' : 'border-transparent hover:bg-ink-800/40 text-ink-200'}`}
            >
              <span className="shrink-0">
                {f.kind === 'deleted' ? '🗑' : f.kind === 'added' ? '＋' : '●'}
              </span>
              <span className="truncate flex-1">{f.path}</span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-auto p-3 min-h-0">
        {selected ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <div className="text-[11px] text-ink-400 truncate flex-1">{selected.path}</div>
              <button onClick={handleOpen} className="text-[11px] px-2 py-1 rounded bg-ink-700/70 hover:bg-ink-600 text-ink-100">Open</button>
              <button onClick={handleSaveAs} className="text-[11px] px-2 py-1 rounded bg-ink-700/70 hover:bg-ink-600 text-ink-100">Save as…</button>
            </div>
            <FilePreview file={selected} chat={chat} />
          </>
        ) : (
          <div className="text-xs text-ink-500">Select a file to preview it.</div>
        )}
      </div>
    </aside>
  );
}
