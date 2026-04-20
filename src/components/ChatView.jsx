import React, { useCallback, useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';
import Composer from './Composer.jsx';

function basenameOf(p) {
  if (!p) return '';
  return p.split('/').filter(Boolean).pop() || p;
}

// ChatView is a view-only component now. The whole turn lifecycle (SSE
// stream, live draft, persistence) lives in App.jsx so it survives this
// component being remounted when the user switches chats. We just render
// the messages + whatever draft the parent hands us, and forward submits /
// stops back up.
export default function ChatView({
  chat,
  messages,
  liveMessage,
  isStreaming,
  onSubmit,
  onStop,
  onEnsureApiSession,
  onModelChange,
  onAddFolders,
  onRemoveFolder,
  backendReady,
}) {
  const scrollRef = useRef(null);
  const endRef = useRef(null);

  const hasChat = !!chat;
  const isChatMode = chat?.mode === 'chat';

  // Autoscroll to bottom when messages / live text change
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, liveMessage?.content, liveMessage?.events?.length]);

  const handleEnsureSession = useCallback(async () => {
    if (!chat) return null;
    const updated = await onEnsureApiSession(chat);
    return updated?.apiSessionId || null;
  }, [chat, onEnsureApiSession]);

  const handleSubmit = useCallback(async ({ prompt, userDisplay }) => {
    if (!chat) return;
    await onSubmit?.({ chat, prompt, userDisplay });
  }, [chat, onSubmit]);

  const apiSessionId = chat?.apiSessionId || null;

  const empty = !hasChat;

  return (
    <main className="flex-1 min-w-0 flex flex-col bg-ink-900">
      {/* Header */}
      <div className="h-12 shrink-0 border-b border-ink-700/60 px-4 flex items-center gap-3">
        <div className="text-ink-100 font-medium truncate">
          {hasChat ? (chat.title || 'Untitled') : 'No chat selected'}
        </div>
        {hasChat && (
          <div
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0
              ${isChatMode
                ? 'bg-ink-700/70 text-ink-300 border border-ink-600/50'
                : 'bg-accent-500/15 text-accent-500 border border-accent-500/30'}`}
            title={isChatMode ? 'Chat mode — no tools, pure conversation' : 'Cowork mode — Claude has tool access'}
          >
            {isChatMode ? 'CHAT' : 'COWORK'}
          </div>
        )}
        {hasChat && chat.claudeSessionId && (
          <div className="text-[11px] font-mono text-ink-500 truncate">
            {chat.claudeSessionId.slice(0, 8)}
          </div>
        )}
        <div className="flex-1" />
        {hasChat && !isChatMode && (
          <FolderBar chat={chat} onAdd={() => onAddFolders?.(chat)} onRemove={(p) => onRemoveFolder?.(chat, p)} />
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
          {empty && (
            <div className="text-center py-24 text-ink-400">
              <div className="text-2xl text-ink-200 mb-2">Welcome to Cowork</div>
              <div className="text-sm">Create a chat on the left to get started.</div>
            </div>
          )}
          {!empty && messages.length === 0 && !liveMessage && (
            <div className="text-center py-16 text-ink-400">
              <div className="text-ink-200">Send a message to begin.</div>
              {isChatMode ? (
                <div className="text-xs mt-2">
                  Chat mode — pure conversation, no file access or tools.
                </div>
              ) : chat.sandboxPath ? (
                <div className="text-xs mt-2 font-mono text-ink-500 truncate max-w-[60ch] mx-auto" title={chat.sandboxPath}>
                  Working in <span className="text-ink-300">{chat.sandboxPath}</span>
                  {chat.sandboxPaths?.length > 0 && (
                    <span className="text-ink-500"> + {chat.sandboxPaths.length} more</span>
                  )}
                </div>
              ) : (
                <div className="text-xs mt-2 text-ink-500">
                  No folders attached — Claude will work in a fresh sandbox.
                  <br />
                  <button
                    type="button"
                    onClick={() => onAddFolders?.(chat)}
                    className="mt-2 inline-flex items-center gap-1.5 text-accent-500 hover:text-accent-400"
                  >
                    <span>📁</span>
                    <span>Attach a folder…</span>
                  </button>
                  <span className="text-ink-600"> · or just send a message</span>
                </div>
              )}
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {liveMessage && (
            <MessageBubble key={liveMessage.id} message={liveMessage} streaming />
          )}
          <div ref={endRef} />
        </div>
      </div>

      {/* Composer */}
      {hasChat && (
        <div className="shrink-0 border-t border-ink-700/60 bg-ink-900">
          <div className="max-w-3xl mx-auto">
            <Composer
              onSubmit={handleSubmit}
              disabled={!backendReady}
              apiSessionId={apiSessionId}
              isStreaming={isStreaming}
              onStop={onStop}
              onEnsureSession={handleEnsureSession}
              model={chat.model || ''}
              onModelChange={onModelChange}
            />
          </div>
        </div>
      )}
    </main>
  );
}

// Folder pillbar in the cowork chat header. Always shows an "Add folder" button;
// any attached folders show as removable pills. Empty state reads "No folder"
// (matches the existing Claude desktop affordance).
function FolderBar({ chat, onAdd, onRemove }) {
  const primary = chat.sandboxPath;
  const extras = Array.isArray(chat.sandboxPaths) ? chat.sandboxPaths : [];
  const all = primary ? [primary, ...extras] : [];

  return (
    <div className="flex items-center gap-1.5 max-w-[60ch] overflow-hidden">
      {all.length === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          className="text-xs px-2 py-1 rounded-md border border-ink-700/70 bg-ink-800/40 text-ink-300 hover:bg-ink-700/60 hover:text-ink-100 flex items-center gap-1.5"
          title="Optionally attach a working folder so Claude can read & edit your files"
        >
          <span>📁</span>
          <span>Add folder</span>
        </button>
      ) : (
        <>
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {all.map((p, i) => (
              <span
                key={p}
                className={`group text-xs px-2 py-1 rounded-md border flex items-center gap-1.5 shrink-0
                  ${i === 0
                    ? 'border-accent-500/40 bg-accent-500/10 text-accent-500'
                    : 'border-ink-700/70 bg-ink-800/60 text-ink-200'}`}
                title={p + (i === 0 ? '  (primary cwd)' : '  (--add-dir)')}
              >
                <span>📁</span>
                <span className="truncate max-w-[18ch]">{basenameOf(p)}</span>
                <button
                  type="button"
                  onClick={() => onRemove?.(p)}
                  className="opacity-50 hover:opacity-100 hover:text-accent-500 ml-0.5"
                  title="Remove this folder"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={onAdd}
            className="text-xs px-1.5 py-1 rounded-md border border-dashed border-ink-700/70 text-ink-400 hover:text-ink-100 hover:border-ink-500"
            title="Add another folder"
          >
            +
          </button>
        </>
      )}
    </div>
  );
}
