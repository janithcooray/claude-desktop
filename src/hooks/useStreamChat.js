import { useCallback, useRef, useState } from 'react';
import { resolveBaseUrl } from '../lib/api.js';

// Consume the /sessions/:id/messages SSE stream. We need POST with a body, so
// this uses fetch + a ReadableStream reader (EventSource can't POST).
//
// onEvent receives every parsed SSE event: { event, data }.
// onFinish fires once with the final collected state.

export function useStreamChat() {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(async ({ apiSessionId, prompt, model, onEvent }) => {
    if (!apiSessionId) throw new Error('apiSessionId required');
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const base = await resolveBaseUrl();

    let text = '';
    const events = [];
    const files = [];
    let claudeSessionId = null;
    let ended = null;

    try {
      const body = { prompt };
      if (model) body.model = model;
      const res = await fetch(`${base}/sessions/${apiSessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`stream open failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames separated by blank lines
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;

          events.push(parsed);
          onEvent?.(parsed);

          switch (parsed.event) {
            case 'session':
              claudeSessionId = parsed.data?.claudeSessionId ?? claudeSessionId;
              break;
            case 'assistant_text':
              text += parsed.data?.text ?? '';
              break;
            case 'file_event':
              if (parsed.data?.kind === 'deleted') {
                const i = files.findIndex((f) => f.path === parsed.data.path);
                if (i >= 0) files.splice(i, 1);
              } else {
                const i = files.findIndex((f) => f.path === parsed.data.path);
                const entry = {
                  path: parsed.data.path,
                  url: parsed.data.url,
                  kind: parsed.data.kind,
                  at: Date.now(),
                };
                if (i >= 0) files[i] = entry; else files.push(entry);
              }
              break;
            case 'end':
              ended = parsed.data;
              break;
            case 'error':
              // surface but keep going until stream actually closes
              break;
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        events.push({ event: 'error', data: { message: String(err?.message || err) } });
        onEvent?.({ event: 'error', data: { message: String(err?.message || err) } });
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }

    return { text, events, files, claudeSessionId, ended };
  }, []);

  return { send, stop, isStreaming };
}

function parseSseFrame(frame) {
  // frame: one or more lines. We only need `event:` and `data:`.
  let eventName = 'message';
  const dataLines = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join('\n');
  let data;
  try { data = JSON.parse(dataStr); } catch { data = dataStr; }
  return { event: eventName, data };
}
