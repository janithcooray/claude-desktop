import React, { useEffect, useMemo, useState } from 'react';
import { getClaudeHistory } from '../lib/api.js';

function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Top-level tab switcher: Chats vs Cowork.
//   Chats — direct Claude conversation, no tools. Also surfaces CLI history
//           (sessions previously run via the `claude` binary), which can be
//           resumed as a new cowork chat.
//   Cowork — agentic; each chat has a sandbox folder picked at creation.
export default function Sidebar({
  chats,
  activeChatId,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
  onResumeHistory,
  account,
}) {
  // The tab is purely a user-controlled view filter. It no longer follows the
  // active chat — if the user parks on "Chats" we don't want opening a cowork
  // chat (e.g. from resumed CLI history) to yank them over to the Cowork tab.
  // Seed once from whatever chat happens to be active at mount, then leave it
  // alone.
  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [chats, activeChatId]
  );
  const [tab, setTab] = useState(() => (activeChat?.mode === 'chat' ? 'chat' : 'cowork'));

  const chatList = useMemo(() => chats.filter((c) => c.mode === 'chat'), [chats]);
  const coworkList = useMemo(() => chats.filter((c) => c.mode !== 'chat'), [chats]);
  const items = tab === 'chat' ? chatList : coworkList;

  // When the user clicks a tab manually, also snap the active chat to the
  // most recent one in that tab. Without this, switching tabs leaves the
  // right pane showing the wrong chat — which makes the tab feel broken.
  const switchTab = (next) => {
    if (next === tab) return;
    setTab(next);
    const list = next === 'chat' ? chatList : coworkList;
    if (list.length > 0 && (!activeChat || activeChat.mode !== (next === 'chat' ? 'chat' : 'cowork'))) {
      onSelect?.(list[0].id);
    }
  };

  return (
    <aside className="w-64 shrink-0 border-r border-ink-700/60 bg-ink-900 flex flex-col">
      <div className="px-3 py-3 border-b border-ink-700/60 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-ink-100 font-medium text-[13px] leading-tight truncate">
            Claude Desktop replica
          </div>
          <div className="text-[10px] text-ink-500 leading-tight">unofficial · community build</div>
        </div>
        <span
          className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-500/20 text-accent-500 border border-accent-500/40"
          title="Alpha testing build — expect rough edges"
        >
          Alpha
        </span>
      </div>

      {/* Top-level tabs */}
      <div className="px-2 pt-2 grid grid-cols-2 gap-1">
        <TabButton active={tab === 'chat'} onClick={() => switchTab('chat')} count={chatList.length}>
          Chats
        </TabButton>
        <TabButton active={tab === 'cowork'} onClick={() => switchTab('cowork')} count={coworkList.length}>
          Cowork
        </TabButton>
      </div>

      <div className="px-3 pt-3 pb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onNew(tab === 'chat' ? 'chat' : 'cowork')}
          className={`flex-1 text-xs px-2 py-1.5 rounded-md border transition-colors flex items-center justify-center gap-1
            ${tab === 'cowork'
              ? 'bg-accent-500/15 hover:bg-accent-500/25 text-accent-500 border-accent-500/40'
              : 'bg-ink-800/80 hover:bg-ink-700 text-ink-100 border-ink-700/60'}`}
          title={tab === 'chat' ? 'Start a direct Claude conversation' : 'Start a new agentic session'}
        >
          <span>+</span>
          <span>{tab === 'chat' ? 'New chat' : 'New cowork'}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {items.length === 0 && tab !== 'chat' && (
          <div className="px-3 py-3 text-[11px] text-ink-500">
            No cowork sessions yet. Each session has its own working folder.
          </div>
        )}
        {items.length === 0 && tab === 'chat' && (
          <div className="px-3 py-3 text-[11px] text-ink-500">
            Direct Claude conversation, no tools or files. Local CLI history below can be resumed.
          </div>
        )}
        {items.map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            active={chat.id === activeChatId}
            onSelect={onSelect}
            onDelete={onDelete}
            showFolder={tab !== 'chat'}
          />
        ))}

        {tab === 'chat' && (
          <ClaudeHistorySection onResume={onResumeHistory} />
        )}
      </div>

      <div className="border-t border-ink-700/60 px-2 py-2">
        <AccountBadge account={account} />
        <button
          type="button"
          onClick={onOpenSettings}
          className="w-full text-xs px-2 py-1.5 rounded-md text-ink-300 hover:bg-ink-800 hover:text-ink-100 transition-colors flex items-center gap-2"
          title="Settings"
        >
          <span>⚙</span>
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

// Small block above the Settings button showing which account the Claude CLI
// is signed in as. We fish the email + plan out of whatever shape
// `claude auth status --json` happens to use — the CLI's schema isn't
// stable, so we try a few common field names and fall back gracefully.
function AccountBadge({ account }) {
  if (!account) return null;
  const parsed = account.parsed || {};
  const email = walk(parsed, 'account.email')
    ?? walk(parsed, 'email')
    ?? walk(parsed, 'user.email');
  const plan = walk(parsed, 'account.plan')
    ?? walk(parsed, 'plan')
    ?? walk(parsed, 'subscription')
    ?? walk(parsed, 'tier');
  const loggedIn = !!account.loggedIn;

  // Nothing to show if we're signed out and have no info. The install/sign-in
  // banner in App.jsx already covers that case up top.
  if (!loggedIn && !email) return null;

  return (
    <div className="mb-1 px-2 py-1.5 rounded-md bg-ink-800/40 border border-ink-700/60">
      <div className="flex items-center gap-2 min-w-0">
        <div
          className={`h-1.5 w-1.5 rounded-full shrink-0 ${loggedIn ? 'bg-emerald-400' : 'bg-accent-500'}`}
          title={loggedIn ? 'Signed in' : 'Not signed in'}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[11.5px] text-ink-100 truncate" title={email || ''}>
            {email || (loggedIn ? 'Signed in' : 'Not signed in')}
          </div>
          {plan && (
            <div className="text-[10.5px] text-ink-400 truncate capitalize">{String(plan)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Walk "a.b.c" into a nested object, returning undefined for missing paths.
function walk(obj, dottedKey) {
  if (!obj) return undefined;
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function TabButton({ active, onClick, count, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2 py-1.5 rounded-md transition-colors border flex items-center justify-center gap-1.5
        ${active
          ? 'bg-ink-700/80 text-ink-50 border-ink-600/70'
          : 'bg-transparent text-ink-400 hover:text-ink-100 hover:bg-ink-800 border-transparent'}`}
    >
      <span>{children}</span>
      {typeof count === 'number' && (
        <span className={`text-[10px] px-1 rounded ${active ? 'bg-ink-900/60 text-ink-300' : 'bg-ink-800 text-ink-500'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function ChatRow({ chat, active, onSelect, onDelete, showFolder }) {
  return (
    <div
      className={`group mx-2 my-0.5 px-2.5 py-2 rounded-md cursor-pointer flex items-start gap-2 transition-colors
        ${active ? 'bg-ink-700/80' : 'hover:bg-ink-800'}`}
      onClick={() => onSelect(chat.id)}
    >
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${active ? 'text-ink-50' : 'text-ink-100'}`}>
          {chat.title || 'Untitled'}
        </div>
        <div className="text-[11px] text-ink-400 truncate">
          {formatRelative(chat.updatedAt)}
          {showFolder && chat.sandboxPath && (
            <span className="ml-1 text-ink-500" title={chat.sandboxPath}>
              · {chat.sandboxPath.split('/').filter(Boolean).pop()}
            </span>
          )}
          {chat.claudeSessionId && <span className="ml-1">· live</span>}
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); if (confirm('Delete this chat?')) onDelete(chat.id); }}
        className="opacity-0 group-hover:opacity-100 text-ink-400 hover:text-accent-500 text-xs"
        title="Delete"
      >
        ✕
      </button>
    </div>
  );
}

// Reads the local CLI's saved sessions from ~/.claude/projects/. These are
// the same chats the `claude` binary keeps for --resume. Resuming creates a
// new cowork chat seeded with the session UUID + project cwd.
function ClaudeHistorySection({ onResume }) {
  const [items, setItems] = useState(null); // null = loading, [] = empty
  const [err, setErr] = useState(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getClaudeHistory(50);
        if (!cancelled) setItems(r?.sessions || []);
      } catch (x) {
        if (!cancelled) {
          setErr(String(x?.message || x));
          setItems([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="mt-3 pt-2 border-t border-ink-700/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-1 flex items-center text-[11px] uppercase tracking-wider text-ink-500 hover:text-ink-300"
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span className="ml-1">Claude CLI history</span>
        <div className="flex-1" />
        {items && <span className="text-ink-600 normal-case tracking-normal">{items.length}</span>}
      </button>
      {expanded && (
        <div className="px-1">
          {items === null && (
            <div className="px-3 py-2 text-[11px] text-ink-500">Loading…</div>
          )}
          {err && (
            <div className="px-3 py-2 text-[11px] text-accent-500/80 break-all">{err}</div>
          )}
          {items && items.length === 0 && !err && (
            <div className="px-3 py-2 text-[11px] text-ink-500">
              No local sessions found in <code className="font-mono">~/.claude/projects</code>.
            </div>
          )}
          {items && items.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onResume?.(s)}
              className="group block w-full text-left mx-1 px-2.5 py-1.5 rounded-md hover:bg-ink-800 transition-colors"
              title={`Resume session ${s.id}\n${s.projectPath || ''}`}
            >
              <div className="text-[12.5px] text-ink-200 truncate">{s.title || s.id.slice(0, 8)}</div>
              <div className="text-[10.5px] text-ink-500 truncate">
                {formatRelative(s.updatedAt)}
                {s.projectPath && (
                  <span className="ml-1 text-ink-600">· {s.projectPath.split('/').filter(Boolean).pop()}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
