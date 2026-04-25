import React from 'react';
import EventTimeline from './EventTimeline.jsx';
import { renderMarkdown } from '../lib/markdown.jsx';

// "Thinking…" indicator shown before the first content/event lands. Claude
// Desktop uses an 8-point asterisk that breathes and rotates — we mirror
// that here with an inline SVG so it scales and colours crisply. The dots
// after "Thinking" walk L→R (see .thinking-dots in index.css).
function ThinkingIndicator() {
  return (
    <span className="inline-flex items-center gap-2 text-ink-400 text-sm italic">
      <svg
        className="thinking-star"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 2 L13.5 9 L20 10.5 L13.5 12 L12 22 L10.5 12 L4 10.5 L10.5 9 Z" />
        <path d="M12 6 L13 10 L17 11 L13 12 L12 18 L11 12 L7 11 L11 10 Z" opacity="0.55" />
      </svg>
      <span>Thinking</span>
      <span className="thinking-dots" aria-hidden="true">
        <span /><span /><span />
      </span>
    </span>
  );
}

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

  // Only the event kinds the timeline actually renders should surface the
  // timeline UI. Meta events like `session` produce no visible row.
  const VISIBLE_EVENTS = new Set([
    'tool_use', 'tool_result', 'file_event', 'stderr', 'error', 'claude_event',
  ]);
  const hasVisibleEvents = events.some((e) => VISIBLE_EVENTS.has(e.event));

  const hasContent = !!message.content;

  // Show the "Thinking…" pill whenever the turn is live but nothing is
  // currently streaming to the bubble — that covers the initial delay AND
  // every gap between tool calls until text starts arriving. Once the model
  // emits text, the cursor-pulse takes over and the pill steps aside.
  const showThinking = !isUser && streaming && !hasContent;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[78ch] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-2 w-full`}>
        {/* Live event timeline above the assistant bubble. While streaming,
            steps update in place. After the turn ends we keep them visible
            (no collapse) so the user can audit what happened. */}
        {!isUser && hasVisibleEvents && (
          <EventTimeline events={events} streaming={streaming} />
        )}

        {(isUser || hasContent || (!streaming && !hasError)) && (
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
              <div className={streaming && hasContent ? 'cursor-pulse' : ''}>
                {hasContent
                  ? renderMarkdown(message.content)
                  : hasError
                    ? null /* error block below */
                    : <span className="text-ink-500 text-sm italic">(empty response)</span>}
              </div>
            )}
          </div>
        )}

        {showThinking && <ThinkingIndicator />}

        {!isUser && hasError && (
          <div className="w-full max-w-[78ch] rounded-lg border border-red-500/40 bg-red-900/20 text-red-200 text-xs px-3 py-2 whitespace-pre-wrap font-mono">
            {errorMessages.join('\n\n')}
          </div>
        )}
      </div>
    </div>
  );
}
