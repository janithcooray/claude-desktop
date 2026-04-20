import React, { useState } from 'react';
import { openClaudeSignInTerminal } from '../lib/api.js';

// Shown when the Claude CLI is installed but the user hasn't signed in yet.
// This is the explainer step before we spawn a terminal window — users who
// are new to the CLI-auth dance need a heads-up that a separate window is
// about to pop open and a browser tab will follow.
//
// The actual sign-in happens in the official `claude auth login` flow; this
// app never touches credentials. Once the user finishes, `/info` polling in
// App.jsx will pick up the signed-in state and the modal can be dismissed.
export default function SignInModal({ onClose, onStarted }) {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);

  const onSignIn = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setDetail(null);
    try {
      const j = await openClaudeSignInTerminal();
      setDetail(`A terminal opened in ${j.terminal}. Finish the prompts there, then come back.`);
      onStarted?.();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur-sm">
      <div className="w-[560px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto bg-ink-900 border border-ink-700 rounded-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-ink-700">
          <div className="text-ink-50 text-sm font-semibold">Sign in to Claude</div>
          <div className="text-ink-400 text-[11.5px] mt-0.5">
            One-time setup. The official <code className="font-mono text-[11px]">claude</code> CLI
            handles the OAuth flow — this app never sees your credentials.
          </div>
        </div>

        <div className="px-5 py-4 space-y-3 text-[12.5px] text-ink-200 leading-relaxed">
          <p className="text-ink-300">
            When you click <span className="text-ink-100 font-medium">Open sign-in terminal</span>{' '}
            below, here&rsquo;s what will happen:
          </p>

          <Step n={1} title="A terminal window opens">
            A new terminal pops up running{' '}
            <code className="font-mono text-[11px]">claude auth login</code>. Leave this app
            open — you&rsquo;ll come back to it when you&rsquo;re done.
          </Step>

          <Step n={2} title="Your browser takes over">
            The CLI prints a URL and opens it in your default browser. Sign in to your
            Anthropic account the normal way.
          </Step>

          <Step n={3} title="Paste the code back">
            The browser will show a short code after you approve. Copy it, switch back to
            the terminal window, and paste it at the prompt.
          </Step>

          <Step n={4} title="Close the terminal">
            The CLI confirms you&rsquo;re signed in. Close the terminal window and return
            to this app — your account will show up in the sidebar within a few seconds.
          </Step>

          {detail && (
            <div className="px-3 py-2 rounded-md bg-accent-500/10 border border-accent-500/30 text-accent-500 text-[11.5px]">
              {detail}
            </div>
          )}
          {err && (
            <div className="px-3 py-2 rounded-md bg-accent-500/10 border border-accent-500/30 text-accent-500 text-[11.5px] break-all">
              {err}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-ink-700 bg-ink-900/60 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-xs font-medium px-3 py-1.5 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-800 disabled:opacity-50"
          >
            {detail ? 'Close' : 'Not now'}
          </button>
          {!detail && (
            <button
              type="button"
              onClick={onSignIn}
              disabled={busy}
              className={`text-xs font-medium px-3.5 py-1.5 rounded-md transition-colors
                ${busy
                  ? 'bg-ink-800 text-ink-500 cursor-wait'
                  : 'bg-accent-500 text-ink-950 hover:bg-accent-400'}`}
            >
              {busy ? 'Opening terminal…' : 'Open sign-in terminal'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <div className="flex gap-3 px-3 py-2 rounded-md bg-ink-800/50 border border-ink-700/60">
      <div className="shrink-0 w-5 h-5 rounded-full bg-accent-500/20 text-accent-500 text-[10.5px] font-semibold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-ink-100 text-[12px] font-medium mb-0.5">{title}</div>
        <div className="text-ink-300 text-[11.5px]">{children}</div>
      </div>
    </div>
  );
}
