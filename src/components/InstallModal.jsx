import React, { useEffect, useRef, useState } from 'react';
import { installClaudeCli } from '../lib/api.js';

// Shown on first launch when the `claude` CLI isn't installed. Explains what
// the installer will do, then runs it inline with a streamed log so the user
// doesn't have to dig into Settings to see progress.
//
// On success we don't dismiss the modal; we call `onInstalled()` and let the
// parent decide what to do next (today: transition into the sign-in
// explainer). The modal stays up until the parent unmounts it, which keeps
// the hand-off visually continuous.
export default function InstallModal({ onClose, onInstalled }) {
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState('');
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null); // { exitCode, info }
  const logRef = useRef(null);

  // Keep the log pane pinned to the newest line as output streams in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const run = async () => {
    if (installing) return;
    setInstalling(true);
    setLog('');
    setErr(null);
    setDone(null);
    try {
      const result = await installClaudeCli({
        onLog: (line) => setLog((prev) => prev + line),
        onError: (msg) => setErr(msg),
      });
      setDone(result);
      if (result?.exitCode === 0) onInstalled?.(result);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setInstalling(false);
    }
  };

  const success = done?.exitCode === 0;
  const failed = done && done.exitCode !== 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/80 backdrop-blur-sm">
      <div className="w-[620px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] overflow-y-auto bg-ink-900 border border-ink-700 rounded-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-ink-700">
          <div className="text-ink-50 text-sm font-semibold">Install the Claude CLI</div>
          <div className="text-ink-400 text-[11.5px] mt-0.5">
            This app drives the official <code className="font-mono text-[11px]">claude</code>{' '}
            binary. We&rsquo;ll install it for you — no terminal needed.
          </div>
        </div>

        <div className="px-5 py-4 space-y-3 text-[12.5px] text-ink-200 leading-relaxed">
          {!installing && !log && !done && (
            <>
              <p className="text-ink-300">
                When you click <span className="text-ink-100 font-medium">Install now</span>,
                here&rsquo;s what happens:
              </p>

              <Step title="We run the official installer">
                Exactly the same one-liner Anthropic documents:{' '}
                <code className="font-mono text-[11px]">curl -fsSL claude.ai/install.sh | bash</code>.
                Takes roughly 30 seconds on a normal connection.
              </Step>

              <Step title="It installs under your home directory">
                The installer drops the <code className="font-mono text-[11px]">claude</code>{' '}
                binary into <code className="font-mono text-[11px]">~/.local/bin</code>{' '}
                (or the equivalent per platform). Nothing is written outside your home folder
                and no sudo prompt appears.
              </Step>

              <Step title="Output streams here, live">
                You&rsquo;ll see the installer&rsquo;s log below as it runs, so you can watch
                for problems. No separate terminal window opens.
              </Step>

              <Step title="Next up: sign in">
                Once the binary is in place, we&rsquo;ll hand you straight to the sign-in
                step. You can close this modal at any point and run things manually from
                Settings instead.
              </Step>
            </>
          )}

          {(installing || log) && (
            <div>
              <div className="text-[11.5px] text-ink-300 mb-1.5">
                {installing ? 'Installing…' : (success ? 'Installed.' : 'Install finished.')}
              </div>
              <div
                ref={logRef}
                className="font-mono text-[11px] text-ink-300 bg-ink-950 border border-ink-700/60 rounded-md p-2 h-44 overflow-y-auto whitespace-pre-wrap break-all"
              >
                {log || 'Starting installer…\n'}
              </div>
            </div>
          )}

          {err && (
            <div className="px-3 py-2 rounded-md bg-accent-500/10 border border-accent-500/30 text-accent-500 text-[11.5px] break-all">
              {err}
            </div>
          )}

          {success && (
            <div className="px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11.5px]">
              Claude CLI is installed. Next: sign in so the app can make API calls on
              your behalf.
            </div>
          )}

          {failed && !err && (
            <div className="px-3 py-2 rounded-md bg-accent-500/10 border border-accent-500/30 text-accent-500 text-[11.5px]">
              Installer exited with code {done.exitCode}. Check the log above for details.
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-ink-700 bg-ink-900/60 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={installing}
            className="text-xs font-medium px-3 py-1.5 rounded-md text-ink-300 hover:text-ink-100 hover:bg-ink-800 disabled:opacity-50"
          >
            {success ? 'Close' : installing ? 'Close' : 'Not now'}
          </button>
          {!success && (
            <button
              type="button"
              onClick={run}
              disabled={installing}
              className={`text-xs font-medium px-3.5 py-1.5 rounded-md transition-colors
                ${installing
                  ? 'bg-ink-800 text-ink-500 cursor-wait'
                  : 'bg-accent-500 text-ink-950 hover:bg-accent-400'}`}
            >
              {installing ? 'Installing…' : (failed ? 'Retry install' : 'Install now')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ title, children }) {
  return (
    <div className="px-3 py-2 rounded-md bg-ink-800/50 border border-ink-700/60">
      <div className="text-ink-100 text-[12px] font-medium mb-0.5">{title}</div>
      <div className="text-ink-300 text-[11.5px]">{children}</div>
    </div>
  );
}
