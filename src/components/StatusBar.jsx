import React from 'react';

export default function StatusBar({ backendUrl, graphOk, chat }) {
  const connected = !!backendUrl;
  return (
    <div className="h-6 shrink-0 border-t border-ink-700/60 bg-ink-900 text-[11px] text-ink-500 px-3 flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span>{connected ? `backend: ${backendUrl}` : 'backend: starting…'}</span>
      </div>
      {graphOk != null && (
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${graphOk ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          <span>MS Graph: {graphOk ? 'configured' : 'off'}</span>
        </div>
      )}
      <div className="flex-1" />
      {chat?.sandboxPath && (
        <div className="font-mono truncate max-w-[55%]" title={chat.sandboxPath}>
          sandbox: {chat.sandboxPath}
        </div>
      )}
    </div>
  );
}
