import { resolveBaseUrl } from '../lib/api.js';

// One-shot stream runner. POSTs to /sessions/:id/messages, parses the SSE body
// line-by-line, and invokes onEvent for every frame. Resolves with the final
// accumulated { text, events, files, claudeSessionId, ended }.
//
// This lives in /hooks for historical reasons but it's a plain async function
// now — state lifecycle (which chats are streaming, their drafts, aborts) is
// owned by App.jsx so that state survives ChatView remounts when the user
// switches chats mid-turn.
//
// Pass an AbortSignal via `signal` to cancel. AbortError is swallowed and
// reported as a final { text, events, files, ... } with whatever arrived
// before the cancel.
export async function streamChat({ apiSessionId, prompt, model, signal, onEvent }) {
  if (!apiSessionId) throw new Error('apiSessionId required');

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
      signal,
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
  }

  return { text, events, files, claudeSessionId, ended };
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
