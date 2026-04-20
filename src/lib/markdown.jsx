// Small markdown renderer that produces real React nodes — no innerHTML, no
// outside dependency. Covers the cases Claude actually emits: headings,
// bold/italic, inline code, fenced code, lists (incl. nested), blockquotes,
// tables, links, and horizontal rules.
//
// Intentionally not a full CommonMark — it does enough for chat output to
// look right.

import React from 'react';

// ---------- inline pass ----------
//
// We tokenize once, then emit React nodes. The order of patterns matters:
// code → bold → italic → links so "**foo `bar` baz**" works.

const INLINE_RULES = [
  { name: 'code',   re: /`([^`\n]+)`/ },
  { name: 'bold',   re: /\*\*([^*\n]+)\*\*/ },
  { name: 'boldU',  re: /__([^_\n]+)__/ },
  { name: 'italic', re: /\*([^*\n]+)\*/ },
  { name: 'italU',  re: /_([^_\n]+)_/ },
  { name: 'link',   re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { name: 'strike', re: /~~([^~\n]+)~~/ },
];

function renderInline(text, keyPrefix = 'i') {
  if (!text) return null;
  const out = [];
  let cursor = 0;
  let n = 0;

  while (cursor < text.length) {
    let best = null;
    for (const rule of INLINE_RULES) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(text.slice(cursor));
      if (m && (best == null || m.index < best.m.index)) {
        best = { rule, m };
      }
    }
    if (!best) {
      out.push(text.slice(cursor));
      break;
    }
    const { rule, m } = best;
    const absoluteIdx = cursor + m.index;
    if (absoluteIdx > cursor) out.push(text.slice(cursor, absoluteIdx));
    const k = `${keyPrefix}-${n++}`;
    if (rule.name === 'code') {
      out.push(<code key={k} className="px-1 py-0.5 rounded bg-ink-800/80 text-ink-100 font-mono text-[0.92em]">{m[1]}</code>);
    } else if (rule.name === 'bold' || rule.name === 'boldU') {
      out.push(<strong key={k} className="font-semibold text-ink-50">{renderInline(m[1], k)}</strong>);
    } else if (rule.name === 'italic' || rule.name === 'italU') {
      out.push(<em key={k}>{renderInline(m[1], k)}</em>);
    } else if (rule.name === 'strike') {
      out.push(<span key={k} className="line-through opacity-70">{renderInline(m[1], k)}</span>);
    } else if (rule.name === 'link') {
      out.push(
        <a
          key={k}
          href={m[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent-500 hover:underline break-all"
          onClick={(e) => {
            // Prefer the Electron shell (opens in default browser instead
            // of trying to navigate the renderer chrome).
            if (window.cowork?.openExternal) {
              e.preventDefault();
              window.cowork.openExternal(m[2]);
            }
          }}
        >
          {m[1]}
        </a>
      );
    }
    cursor = absoluteIdx + m[0].length;
  }
  return out;
}

// ---------- block pass ----------

const HEADING_RE   = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR_RE        = /^\s*([-*_])\s*\1\s*\1[\s\1]*$/;
const FENCE_RE     = /^```\s*(\S*)\s*$/;
const QUOTE_RE     = /^>\s?(.*)$/;
const ULIST_RE     = /^(\s*)[-*+]\s+(.*)$/;
const OLIST_RE     = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // Split on '|' but not on '\|' (escaped pipes).
  const cells = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { buf += '|'; i++; continue; }
    if (c === '|') { cells.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  cells.push(buf.trim());
  return cells;
}

function parseAlign(sepLine) {
  return splitTableRow(sepLine).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

// Render a flat list of lines into block-level React nodes.
export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing ```
      out.push(
        <pre key={`f${key++}`} className="my-2 rounded-md bg-ink-950/80 border border-ink-700/60 overflow-x-auto p-3 text-[12.5px] leading-snug">
          <code className="font-mono text-ink-100" data-lang={lang || undefined}>
            {codeLines.join('\n')}
          </code>
        </pre>
      );
      continue;
    }

    // Heading
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const Tag = `h${Math.min(level, 6)}`;
      const sizeCls =
        level === 1 ? 'text-[1.5em] font-semibold mt-4 mb-2'
        : level === 2 ? 'text-[1.3em] font-semibold mt-4 mb-2'
        : level === 3 ? 'text-[1.15em] font-semibold mt-3 mb-1.5'
        : 'text-[1.05em] font-semibold mt-2 mb-1';
      out.push(React.createElement(Tag, { key: `h${key++}`, className: `${sizeCls} text-ink-50` }, renderInline(text, `h${key}`)));
      i++;
      continue;
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      out.push(<hr key={`hr${key++}`} className="my-3 border-ink-700/60" />);
      i++;
      continue;
    }

    // Table — header row + sep row + body rows
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const aligns = parseAlign(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(
        <div key={`tbl${key++}`} className="my-2 overflow-x-auto rounded-md border border-ink-700/60">
          <table className="w-full text-[13px] border-collapse">
            <thead className="bg-ink-800/60 text-ink-100">
              <tr>
                {headerCells.map((c, j) => (
                  <th key={j}
                    className={`px-3 py-1.5 text-left font-semibold border-b border-ink-700/60 ${alignCls(aligns[j])}`}>
                    {renderInline(c, `th-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rIdx) => (
                <tr key={rIdx} className={rIdx % 2 ? 'bg-ink-900/40' : ''}>
                  {row.map((c, j) => (
                    <td key={j}
                      className={`px-3 py-1.5 border-t border-ink-700/40 align-top ${alignCls(aligns[j])}`}>
                      {renderInline(c, `td-${rIdx}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoted.push(QUOTE_RE.exec(lines[i])[1]);
        i++;
      }
      out.push(
        <blockquote key={`bq${key++}`} className="my-2 pl-3 border-l-2 border-ink-600 text-ink-300">
          {renderMarkdown(quoted.join('\n'))}
        </blockquote>
      );
      continue;
    }

    // List (unordered or ordered) — collect contiguous list lines
    if (ULIST_RE.test(line) || OLIST_RE.test(line)) {
      const ordered = OLIST_RE.test(line);
      const items = [];
      while (i < lines.length && (ULIST_RE.test(lines[i]) || OLIST_RE.test(lines[i]))) {
        const m = ordered ? OLIST_RE.exec(lines[i]) : ULIST_RE.exec(lines[i]);
        const content = ordered ? m[3] : m[2];
        items.push(content);
        i++;
        // Continuation lines (indented) belong to the previous item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !ULIST_RE.test(lines[i]) && !OLIST_RE.test(lines[i])) {
          items[items.length - 1] += '\n' + lines[i].replace(/^\s+/, '');
          i++;
        }
      }
      const Tag = ordered ? 'ol' : 'ul';
      const listCls = ordered
        ? 'list-decimal pl-6 my-2 space-y-0.5'
        : 'list-disc pl-6 my-2 space-y-0.5';
      out.push(
        React.createElement(
          Tag,
          { key: `l${key++}`, className: listCls },
          items.map((it, idx) => (
            <li key={idx} className="text-ink-100">{renderInline(it, `li-${idx}`)}</li>
          ))
        )
      );
      continue;
    }

    // Blank line: skip
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph: gather lines until blank/break
    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(
      <p key={`p${key++}`} className="my-2 leading-relaxed text-ink-100 whitespace-pre-wrap">
        {renderInline(paraLines.join(' '), `p${key}`)}
      </p>
    );
  }

  return out;
}

function startsBlock(line, next) {
  if (FENCE_RE.test(line)) return true;
  if (HEADING_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  if (ULIST_RE.test(line)) return true;
  if (OLIST_RE.test(line)) return true;
  if (TABLE_ROW_RE.test(line) && next && TABLE_SEP_RE.test(next)) return true;
  return false;
}

function alignCls(a) {
  if (a === 'center') return 'text-center';
  if (a === 'right')  return 'text-right';
  return 'text-left';
}
