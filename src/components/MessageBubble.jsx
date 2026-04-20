import React from 'react';
import EventTimeline from './EventTimeline.jsx';
import { renderMarkdown } from '../lib/markdown.jsx';

export default function MessageBubble({ message, streaming }) {
  const isUser = message.role === 'user';
  const events = Array.isArray(message.events) ? message.events : [];
  const hasEvents = events.length > 0;

  // Pull out any error events — we surface them prominently so silent
  // failures can't hide.
  const errorMessages = !isUser && hasEvents
    ? events.filter((e) => e.event === 'error' && e.data?.message).map((e) => e.data.message)
    : [];
  const hasError = errorMessages.length > 0;

  // While streaming, hide the "thinking…" placeholder if we already have
  // real events to show — the timeline IS the live progress display.
  const hasContent = !!message.content;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[78ch] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-2 w-full`}>
        {/* Live event timeline above the assistant bubble. While streaming,
            steps update in place. After the turn ends we keep them visible
            (no collapse) so the user can audit what happened. */}
        {!isUser && hasEvents && (
          <EventTimeline events={events} streaming={streaming} />
        )}

        <div
          className={
            isUser
              ? 'bg-ink-700/90 text-ink-50 rounded-2xl rounded-br-sm px-4 py-2.5 text-[14.5px] leading-relaxed shadow-sm'
              : 'text-ink-100 text-[14.5px] leading-relaxed prose-msg'
          }
        >
          {isUser ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
          ) : (
            <div className={streaming ? 'cursor-blink' : ''}>
              {hasContent
                ? renderMarkdown(message.content)
                : streaming
                  ? (hasEvents
                      ? null /* timeline above is the live indicator */
                      : <span className="text-ink-400 text-sm italic">working…</span>)
                  : hasError
                    ? null /* error block below */
                    : <span className="text-ink-500 text-sm italic">(empty response)</span>}
            </div>
          )}
        </div>

        {!isUser && hasError && (
          <div className="w-full max-w-[78ch] rounded-lg border border-red-500/40 bg-red-900/20 text-red-200 text-xs px-3 py-2 whitespace-pre-wrap font-mono">
            {errorMessages.join('\n\n')}
          </div>
        )}
      </div>
    </div>
  );
}
