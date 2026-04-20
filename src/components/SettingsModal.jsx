import React, { useEffect, useRef, useState } from 'react';
import {
  getBackendEnvInfo,
  installClaudeCli,
  openClaudeSignInTerminal,
  getAuthStatus,
  openClaudeConfigTerminal,
  getDockerStatus,
} from '../lib/api.js';

// Two-pane settings modal with a left nav. Sections grow as we wire up more
// of the CLI's surface area — each one owns its own data loading so switching
// tabs never blocks the main modal open.
const SECTIONS = [
  { id: 'general',     label: 'General' },
  { id: 'account',     label: 'Account' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'security',    label: 'Security' },
];

export default function SettingsModal({ onClose }) {
  const [section, setSection] = useState('general');
  const [env, setEnv] = useState(null);
  const [app, setApp] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    setErr(null);
    try {
      const [e, a] = await Promise.all([
        getBackendEnvInfo().catch((x) => ({ __error: String(x?.message || x) })),
        window.cowork?.getAppInfo?.().catch(() => null),
      ]);
      if (e && e.__error) {
        setErr(e.__error);
        setEnv(null);
      } else {
        setEnv(e);
      }
      setApp(a || null);
    } catch (x) {
      setErr(String(x?.message || x));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl h-[80vh] max-h-[720px] bg-ink-900 border border-ink-700/60 rounded-xl shadow-2xl overflow-hidden flex"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left nav */}
        <nav className="w-52 shrink-0 border-r border-ink-700/60 bg-ink-900/60 flex flex-col">
          <div className="px-4 py-3 border-b border-ink-700/60">
            <div className="text-ink-100 font-medium text-sm">Settings</div>
          </div>
          <div className="flex-1 overflow-y-auto py-2">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={`w-full text-left text-sm px-4 py-2 transition-colors
                  ${section === s.id
                    ? 'bg-ink-700/60 text-ink-50 border-l-2 border-accent-500'
                    : 'text-ink-300 hover:bg-ink-800 border-l-2 border-transparent'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </nav>

        {/* Right pane */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 px-6 py-3 border-b border-ink-700/60">
            <div className="text-ink-100 font-medium">
              {SECTIONS.find((s) => s.id === section)?.label || 'Settings'}
            </div>
            <div className="flex-1" />
            {section === 'general' && (
              <button
                type="button"
                onClick={load}
                disabled={refreshing}
                className="text-xs text-ink-400 hover:text-ink-100 disabled:opacity-50 px-2 py-1 rounded hover:bg-ink-800"
                title="Refresh"
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-ink-400 hover:text-ink-100 text-lg leading-none px-2 py-1 rounded hover:bg-ink-800"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {section === 'general' && (
              <GeneralSection env={env} app={app} err={err} onRefresh={load} />
            )}
            {section === 'account' && <AccountSection />}
            {section === 'claude-code' && <ClaudeCodeSection />}
            {section === 'security' && <SecuritySection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralSection({ env, app, err, onRefresh }) {
  const login = env?.login;
  const loginStatus = login?.status || 'unknown';
  const loginBadgeClass =
    loginStatus === 'logged_in'
      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
      : loginStatus === 'logged_out'
        ? 'bg-accent-500/15 text-accent-500 border-accent-500/40'
        : 'bg-ink-700/60 text-ink-300 border-ink-600/60';
  const loginLabel =
    loginStatus === 'logged_in' ? 'Signed in'
      : loginStatus === 'logged_out' ? 'Not signed in'
        : 'Unknown';

  // 404 on /info is usually a stale main-process backend — /info didn't exist
  // in older builds. Call it out so the user knows a restart fixes it.
  const is404 = err && /\(404\)/.test(err);

  return (
    <div className="space-y-6 text-sm max-w-2xl">
      {err && (
        <div className="rounded-md bg-accent-500/10 border border-accent-500/40 text-accent-500 px-3 py-2 text-xs">
          <div className="font-medium mb-0.5">Backend info unavailable</div>
          <div className="opacity-90">{err}</div>
          {is404 && (
            <div className="mt-2 text-ink-300">
              This endpoint was added recently. Fully quit and relaunch the app so the backend picks up the new route.
            </div>
          )}
        </div>
      )}

      <Card title="Claude CLI" subtitle="Binary and login the app uses to talk to Claude">
        <Row label="Binary">
          {env?.bin
            ? <code className="font-mono text-ink-200 break-all">{env.bin}</code>
            : <span className="text-ink-500">—</span>}
          {env && env.binExists === false && (
            <span className="ml-2 text-[11px] text-accent-500">(not found on disk)</span>
          )}
        </Row>
        <Row label="Version">
          {env?.version
            ? <code className="font-mono text-ink-200">{env.version}</code>
            : env?.versionError
              ? <span className="text-accent-500 text-xs break-all">{env.versionError}</span>
              : <span className="text-ink-500">—</span>}
        </Row>
        <Row label="Login">
          <span className={`inline-block text-[11px] px-2 py-0.5 rounded border ${loginBadgeClass}`}>
            {loginLabel}
          </span>
          {login?.detail && (
            <div className="mt-1 text-[11px] text-ink-500 break-all">{login.detail}</div>
          )}
        </Row>

        <ClaudeBootstrap env={env} onRefresh={onRefresh} />

        <Hint>
          Override the binary by setting <code className="font-mono text-ink-300">CLAUDE_BIN</code> in your shell before launching.
        </Hint>
      </Card>

      <Card title="App" subtitle="Runtime and platform info for bug reports">
        <Row label="Version">
          <code className="font-mono text-ink-200">{app?.appVersion ?? '—'}</code>
        </Row>
        <Row label="Platform">
          <code className="font-mono text-ink-200">
            {app ? `${app.platform}/${app.arch}` : '—'}
          </code>
        </Row>
        <Row label="Electron">
          <code className="font-mono text-ink-200">{app?.electronVersion ?? '—'}</code>
        </Row>
        <Row label="Node">
          <code className="font-mono text-ink-200">{app?.nodeVersion ?? '—'}</code>
        </Row>
        <Row label="Chrome">
          <code className="font-mono text-ink-200">{app?.chromeVersion ?? '—'}</code>
        </Row>
        {app?.userDataPath && (
          <Row label="Data">
            <code className="font-mono text-ink-300 text-[11px] break-all">{app.userDataPath}</code>
          </Row>
        )}
      </Card>
    </div>
  );
}

// --- Account --------------------------------------------------------------

function AccountSection() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await getAuthStatus();
      setStatus(r);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const signedIn = !!status?.loggedIn;
  const parsed = status?.parsed || null;

  // The CLI doesn't publish a stable schema for `claude auth status --json`, so
  // we try a handful of field names for the common bits and fall back to the
  // raw JSON block for anything else the user might want to see.
  const pick = (obj, keys) => {
    if (!obj) return null;
    for (const k of keys) {
      const v = walk(obj, k);
      if (v != null && v !== '') return v;
    }
    return null;
  };
  const email = pick(parsed, ['account.email', 'email', 'user.email']);
  const name = pick(parsed, ['account.name', 'name', 'user.name', 'user.full_name']);
  const plan = pick(parsed, ['account.plan', 'plan', 'subscription', 'tier', 'account.subscription']);
  const org = pick(parsed, ['organization.name', 'org.name', 'workspace.name']);
  const expires = pick(parsed, ['expiresAt', 'expires_at', 'expiry', 'tokenExpiry']);

  return (
    <div className="space-y-6 text-sm max-w-2xl">
      <Card
        title="Signed-in account"
        subtitle="From `claude auth status` — whatever the CLI reports about your login"
      >
        <div className="flex items-center gap-2">
          <StatusPill ok={signedIn} loading={loading} okLabel="Signed in" badLabel="Not signed in" />
          <div className="flex-1" />
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-xs text-ink-400 hover:text-ink-100 disabled:opacity-50 px-2 py-1 rounded hover:bg-ink-800"
          >
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>

        <div className="mt-3 space-y-2.5">
          {email && <Row label="Email"><code className="font-mono text-ink-200 break-all">{email}</code></Row>}
          {name && <Row label="Name"><span className="text-ink-200">{String(name)}</span></Row>}
          {plan && <Row label="Plan"><span className="text-ink-200">{String(plan)}</span></Row>}
          {org && <Row label="Org"><span className="text-ink-200">{String(org)}</span></Row>}
          {expires && <Row label="Expires"><code className="font-mono text-ink-300 text-[11px]">{String(expires)}</code></Row>}
          {status?.bin && (
            <Row label="Binary">
              <code className="font-mono text-ink-300 text-[11px] break-all">{status.bin}</code>
            </Row>
          )}
        </div>

        {!signedIn && status?.binExists && (
          <div className="mt-4 pt-3 border-t border-ink-700/40">
            <SignInButton onDone={load} />
          </div>
        )}

        {err && (
          <div className="mt-3 text-[11px] text-accent-500 break-all">{err}</div>
        )}
      </Card>
    </div>
  );
}

// --- Claude Code (app-wide defaults) -------------------------------------

const PERMISSION_MODES = [
  { value: 'acceptEdits',      label: 'Accept edits (default)', hint: 'Auto-approve file edits; prompt for other actions.' },
  { value: 'default',          label: 'Default',                hint: 'Prompt on every tool invocation.' },
  { value: 'plan',             label: 'Plan only',              hint: 'Read-only plan; no edits or commands.' },
  { value: 'bypassPermissions',label: 'Bypass permissions',     hint: 'Skip every prompt. Use with care.' },
];

// The model choices Claude Code accepts via --model. Short aliases map to the
// current generation server-side, which is what we want for a default that
// ages gracefully. Full IDs are available under "Pinned".
const MODEL_CHOICES = [
  { value: '',       label: 'Let Claude pick (default)' },
  { group: 'Aliases' },
  { value: 'sonnet', label: 'Sonnet — balanced, general purpose' },
  { value: 'opus',   label: 'Opus — most capable, slower' },
  { value: 'haiku',  label: 'Haiku — fastest, cheapest' },
  { group: 'Pinned' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-opus-4-6',   label: 'claude-opus-4-6' },
  { value: 'claude-haiku-4-5',  label: 'claude-haiku-4-5' },
];

function ClaudeCodeSection() {
  const [prefs, setPrefs] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState(null);
  const [err, setErr] = useState(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [configDetail, setConfigDetail] = useState(null);
  const [configErr, setConfigErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [p, d] = await Promise.all([
          window.cowork?.prefs?.get?.() ?? Promise.resolve(null),
          window.cowork?.prefs?.defaults?.() ?? Promise.resolve(null),
        ]);
        setPrefs(p);
        setDefaults(d);
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
  }, []);

  const set = (patch) => setPrefs((p) => ({ ...(p || {}), ...patch }));

  const save = async () => {
    setSaving(true);
    setSaveNote(null);
    setErr(null);
    try {
      const next = await window.cowork?.prefs?.save?.(prefs || {});
      setPrefs(next);
      setSaveNote('Saved');
      setTimeout(() => setSaveNote(null), 1500);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = () => {
    if (!defaults) return;
    setPrefs({ ...defaults });
  };

  const openConfig = async () => {
    setConfigBusy(true);
    setConfigDetail(null);
    setConfigErr(null);
    try {
      const j = await openClaudeConfigTerminal();
      setConfigDetail(`Opened in ${j.terminal}. Type \`/config\` in the new terminal.`);
    } catch (e) {
      setConfigErr(String(e?.message || e));
    } finally {
      setConfigBusy(false);
    }
  };

  if (!prefs) {
    return (
      <div className="text-sm text-ink-500">Loading preferences…</div>
    );
  }

  return (
    <div className="space-y-6 text-sm max-w-2xl">
      <div className="rounded-md bg-ink-800/40 border border-ink-700/60 px-3 py-2.5 text-[12px] text-ink-400">
        App-wide defaults the CLI inherits when a chat doesn&rsquo;t override them. Per-chat settings
        (like the working folder and model picker in the composer) still win.
      </div>

      <Card title="Defaults" subtitle="Model, permissions, and tool policy for new chats">
        <Field label="Default model" hint="Aliases roll forward with new model releases; pinned IDs don't.">
          <select
            value={prefs.defaultModel ?? ''}
            onChange={(e) => set({ defaultModel: e.target.value || null })}
            className="w-full bg-ink-950 border border-ink-700/60 rounded-md px-2 py-1.5 text-ink-100 text-xs font-mono focus:outline-none focus:border-accent-500/60"
          >
            {MODEL_CHOICES.map((c, i) => (
              c.group
                ? <option key={`g-${i}`} disabled>── {c.group} ──</option>
                : <option key={c.value || 'auto'} value={c.value}>{c.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Permission mode" hint="How the CLI handles tool-use approvals.">
          <div className="space-y-1.5">
            {PERMISSION_MODES.map((m) => (
              <label
                key={m.value}
                className="flex items-start gap-2 p-2 rounded-md border border-ink-700/40 bg-ink-950/40 cursor-pointer hover:border-ink-700"
              >
                <input
                  type="radio"
                  name="permMode"
                  value={m.value}
                  checked={(prefs.defaultPermissionMode || 'acceptEdits') === m.value}
                  onChange={() => set({ defaultPermissionMode: m.value })}
                  className="mt-0.5 accent-accent-500"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-ink-100">{m.label}</div>
                  <div className="text-[11px] text-ink-500">{m.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>

        <Field
          label="Allowed tools"
          hint={<>Comma-separated. Example: <code className="font-mono text-ink-300">Read,Edit,Bash(git:*)</code>. Leave blank for the CLI&rsquo;s default allow-list.</>}
        >
          <textarea
            rows={2}
            value={prefs.defaultAllowedTools ?? ''}
            onChange={(e) => set({ defaultAllowedTools: e.target.value || null })}
            placeholder="Read,Edit,Bash(git:*)"
            className="w-full bg-ink-950 border border-ink-700/60 rounded-md px-2 py-1.5 text-ink-100 text-xs font-mono focus:outline-none focus:border-accent-500/60 resize-none"
          />
        </Field>

        <Field
          label="Disallowed tools"
          hint="Comma-separated. These override the allow-list."
        >
          <textarea
            rows={2}
            value={prefs.defaultDisallowedTools ?? ''}
            onChange={(e) => set({ defaultDisallowedTools: e.target.value || null })}
            placeholder="Bash(rm:*),WebFetch"
            className="w-full bg-ink-950 border border-ink-700/60 rounded-md px-2 py-1.5 text-ink-100 text-xs font-mono focus:outline-none focus:border-accent-500/60 resize-none"
          />
        </Field>

        <div className="flex items-center gap-2 pt-3 border-t border-ink-700/40">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save defaults'}
          </button>
          <button
            type="button"
            onClick={resetDefaults}
            disabled={saving || !defaults}
            className="text-xs px-3 py-1.5 rounded-md bg-ink-800 text-ink-200 hover:bg-ink-700 disabled:opacity-60"
          >
            Reset to defaults
          </button>
          {saveNote && <span className="text-[11px] text-emerald-400">{saveNote}</span>}
          {err && <span className="text-[11px] text-accent-500 break-all">{err}</span>}
        </div>
      </Card>

      <Card
        title="Native config"
        subtitle="Edit anything else in the CLI&rsquo;s own /config screen"
      >
        <div className="text-xs text-ink-300 mb-3">
          The CLI has a richer config surface (theme, MCP servers, hooks, environment) that only lives
          inside its TUI. This opens a terminal where you can type <code className="font-mono text-ink-100">/config</code>.
        </div>
        <button
          type="button"
          onClick={openConfig}
          disabled={configBusy}
          className="text-xs px-3 py-1.5 rounded-md bg-ink-800 text-ink-100 hover:bg-ink-700 disabled:opacity-60"
        >
          {configBusy ? 'Opening terminal…' : 'Open /config in terminal'}
        </button>
        {configDetail && (
          <div className="mt-2 text-[11px] text-ink-400">{configDetail}</div>
        )}
        {configErr && (
          <div className="mt-2 text-[11px] text-accent-500 break-all">{configErr}</div>
        )}
      </Card>
    </div>
  );
}

// --- Security (sandboxing / jailbreak) -----------------------------------

function SecuritySection() {
  const [prefs, setPrefs] = useState(null);
  const [docker, setDocker] = useState(null);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState(null);
  const [err, setErr] = useState(null);
  const [confirmJail, setConfirmJail] = useState(false);

  const refreshDocker = async () => {
    setDockerLoading(true);
    try {
      const d = await getDockerStatus();
      setDocker(d);
    } catch (e) {
      setDocker({ installed: false, running: false, error: String(e?.message || e) });
    } finally {
      setDockerLoading(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const p = await window.cowork?.prefs?.get?.();
        setPrefs(p);
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
    refreshDocker();
  }, []);

  if (!prefs) return <div className="text-sm text-ink-500">Loading…</div>;

  const set = (patch) => setPrefs((p) => ({ ...(p || {}), ...patch }));

  const currentMode = prefs.shellMode || 'default';

  const selectMode = (mode) => {
    if (mode === 'jailbroken' && currentMode !== 'jailbroken' && !confirmJail) {
      // Require an explicit "yes I know" click before the radio actually flips.
      setConfirmJail(true);
      return;
    }
    if (mode !== 'jailbroken') setConfirmJail(false);
    set({ shellMode: mode });
  };

  const save = async () => {
    setSaving(true);
    setSaveNote(null);
    setErr(null);
    try {
      const next = await window.cowork?.prefs?.save?.(prefs || {});
      setPrefs(next);
      setSaveNote('Saved');
      setTimeout(() => setSaveNote(null), 1500);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const dockerAvailable = !!docker?.running;
  const dockerInstalledNotRunning = !!docker?.installed && !docker?.running;

  return (
    <div className="space-y-6 text-sm max-w-2xl">
      <div className="rounded-md bg-ink-800/40 border border-ink-700/60 px-3 py-2.5 text-[12px] text-ink-400">
        These modes apply to new <em>cowork</em> sessions. Existing live chats keep whatever mode
        they were spawned with — delete and re-open a chat to switch.
      </div>

      <Card title="Execution mode" subtitle="Where and how `claude` actually runs">
        <ModeOption
          value="default"
          current={currentMode}
          onSelect={selectMode}
          title="Default (recommended)"
          badge={<span className="text-[10.5px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/40">Safe</span>}
        >
          Runs on your host with the CLI&rsquo;s permission prompts. Tool calls honour the allow-list
          configured in <em>Claude Code</em> settings.
        </ModeOption>

        <ModeOption
          value="docker"
          current={currentMode}
          onSelect={(m) => dockerAvailable && selectMode(m)}
          disabled={!dockerAvailable}
          title="Docker shell"
          badge={
            dockerLoading
              ? <Pill tone="muted">Checking…</Pill>
              : dockerAvailable
                ? <Pill tone="ok">Docker {docker?.serverVersion || 'ready'}</Pill>
                : dockerInstalledNotRunning
                  ? <Pill tone="warn">Daemon stopped</Pill>
                  : <Pill tone="bad">Not installed</Pill>
          }
        >
          <div>
            Each cowork session spins up a container from your chosen image, bind-mounts the
            working folder, and runs <code className="font-mono text-ink-200">claude</code> inside.
            Bash and file edits are contained to the container&rsquo;s view of those mounts.
          </div>
          {currentMode === 'docker' && (
            <div className="mt-3 space-y-2">
              <label className="block text-[11px] text-ink-400">Image</label>
              <input
                type="text"
                value={prefs.dockerImage ?? ''}
                onChange={(e) => set({ dockerImage: e.target.value })}
                placeholder="ghcr.io/anthropics/claude-code:latest"
                className="w-full bg-ink-950 border border-ink-700/60 rounded-md px-2 py-1.5 text-ink-100 text-xs font-mono focus:outline-none focus:border-accent-500/60"
              />
              <div className="text-[11px] text-ink-500">
                The image must have <code className="font-mono text-ink-300">claude</code> on $PATH.
                Your <code className="font-mono text-ink-300">~/.claude</code> directory (credentials +
                history) is bind-mounted into the container.
              </div>
            </div>
          )}
          <div className="mt-3">
            <button
              type="button"
              onClick={refreshDocker}
              disabled={dockerLoading}
              className="text-[11px] text-ink-400 hover:text-ink-100 disabled:opacity-50 px-2 py-1 rounded hover:bg-ink-800"
            >
              {dockerLoading ? 'Checking Docker…' : 'Re-check Docker'}
            </button>
            {docker?.error && !dockerAvailable && (
              <div className="mt-1 text-[11px] text-accent-500/80 break-all">{docker.error}</div>
            )}
          </div>
        </ModeOption>

        <ModeOption
          value="jailbroken"
          current={currentMode}
          onSelect={selectMode}
          title="Jailbroken"
          badge={<Pill tone="bad">Dangerous</Pill>}
        >
          <div>
            Drops every guardrail. <strong>No permission prompts, no tool allow-list.</strong> Claude
            can run arbitrary shell commands, modify any file it can reach, and call any tool — on
            your real host, with your real credentials. Use only for throwaway sandboxes you control.
          </div>
          {currentMode !== 'jailbroken' && confirmJail && (
            <div className="mt-3 rounded-md bg-accent-500/10 border border-accent-500/40 px-3 py-2">
              <div className="text-[12px] text-accent-500 font-medium mb-1">Are you sure?</div>
              <div className="text-[11px] text-ink-200 mb-2">
                Jailbroken mode cannot undo destructive commands. Claude will not ask before running{' '}
                <code className="font-mono text-ink-100">rm</code>,{' '}
                <code className="font-mono text-ink-100">curl | sh</code>,{' '}
                <code className="font-mono text-ink-100">git push --force</code>, or anything else.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setConfirmJail(false); set({ shellMode: 'jailbroken' }); }}
                  className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400"
                >
                  Enable jailbroken mode
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmJail(false)}
                  className="text-xs px-3 py-1.5 rounded-md bg-ink-800 text-ink-200 hover:bg-ink-700"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </ModeOption>

        <div className="flex items-center gap-2 pt-3 border-t border-ink-700/40">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => { setConfirmJail(false); set({ shellMode: 'default' }); }}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded-md bg-ink-800 text-ink-200 hover:bg-ink-700 disabled:opacity-60"
          >
            Reset to Default
          </button>
          {saveNote && <span className="text-[11px] text-emerald-400">{saveNote}</span>}
          {err && <span className="text-[11px] text-accent-500 break-all">{err}</span>}
        </div>
      </Card>
    </div>
  );
}

function ModeOption({ value, current, onSelect, disabled, title, badge, children }) {
  const active = current === value;
  return (
    <label
      className={`block p-3 rounded-md border cursor-pointer transition-colors
        ${active
          ? 'border-accent-500/60 bg-accent-500/5'
          : 'border-ink-700/50 bg-ink-950/30 hover:border-ink-700'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="flex items-center gap-2">
        <input
          type="radio"
          name="shellMode"
          value={value}
          checked={active}
          disabled={disabled}
          onChange={() => !disabled && onSelect(value)}
          className="accent-accent-500"
        />
        <div className="text-xs text-ink-100 font-medium">{title}</div>
        {badge && <div className="ml-auto">{badge}</div>}
      </div>
      <div className="mt-1.5 text-[11.5px] text-ink-400 pl-6">{children}</div>
    </label>
  );
}

function Pill({ tone, children }) {
  const cls = tone === 'ok'
    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
    : tone === 'warn'
      ? 'bg-amber-500/15 text-amber-400 border-amber-500/40'
      : tone === 'bad'
        ? 'bg-accent-500/15 text-accent-500 border-accent-500/40'
        : 'bg-ink-700/60 text-ink-300 border-ink-600/60';
  return (
    <span className={`text-[10.5px] px-1.5 py-0.5 rounded border ${cls}`}>{children}</span>
  );
}

// --- shared ---------------------------------------------------------------

function Card({ title, subtitle, children }) {
  return (
    <section className="rounded-lg border border-ink-700/60 bg-ink-800/30 overflow-hidden">
      <header className="px-4 py-3 border-b border-ink-700/60">
        <div className="text-ink-100 font-medium text-sm">{title}</div>
        {subtitle && <div className="text-[11px] text-ink-500 mt-0.5">{subtitle}</div>}
      </header>
      <div className="p-4 space-y-2.5">{children}</div>
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline gap-4">
      <div className="w-24 shrink-0 text-ink-400 text-xs">{label}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-ink-300">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-ink-500">{hint}</div>}
    </div>
  );
}

function Hint({ children }) {
  return (
    <div className="text-[11px] text-ink-500 pt-2 mt-2 border-t border-ink-700/40">
      {children}
    </div>
  );
}

function StatusPill({ ok, loading, okLabel, badLabel }) {
  const cls = loading
    ? 'bg-ink-700/60 text-ink-300 border-ink-600/60'
    : ok
      ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40'
      : 'bg-accent-500/15 text-accent-500 border-accent-500/40';
  const label = loading ? 'Checking…' : (ok ? okLabel : badLabel);
  return (
    <span className={`inline-block text-[11px] px-2 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  );
}

// Walk "a.b.c" against a nested object, returning undefined for missing paths.
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

// Inline sign-in button reused by the Account section when the user isn't
// logged in. Mirrors the General > ClaudeBootstrap button.
function SignInButton({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const run = async () => {
    setBusy(true);
    setDetail(null);
    setErr(null);
    try {
      const j = await openClaudeSignInTerminal();
      setDetail(`Opened in ${j.terminal}. Follow the prompts, then come back and hit Refresh.`);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
      onDone?.();
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:opacity-60"
      >
        {busy ? 'Opening terminal…' : 'Sign in to Claude'}
      </button>
      {detail && <div className="mt-2 text-[11px] text-ink-400">{detail}</div>}
      {err && <div className="mt-2 text-[11px] text-accent-500 break-all">{err}</div>}
    </div>
  );
}

// Inline install + sign-in affordances. Rendered inside the Claude CLI card so
// the user can recover in one click if the binary is missing or not logged in.
function ClaudeBootstrap({ env, onRefresh }) {
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [installErr, setInstallErr] = useState(null);
  const [installDone, setInstallDone] = useState(null); // { exitCode }
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInDetail, setSignInDetail] = useState(null);
  const [signInErr, setSignInErr] = useState(null);
  const logRef = useRef(null);

  const binMissing = env && env.binExists === false;
  const notSignedIn = env?.login?.status === 'logged_out';

  // Scroll the log to the bottom as new lines arrive.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [installLog]);

  const runInstall = async () => {
    setInstalling(true);
    setInstallLog('');
    setInstallErr(null);
    setInstallDone(null);
    try {
      const result = await installClaudeCli({
        onLog: (line) => setInstallLog((prev) => prev + line),
        onError: (msg) => setInstallErr(msg),
      });
      setInstallDone(result);
      // Refresh /info so the Binary / Version rows update.
      onRefresh?.();
    } catch (e) {
      setInstallErr(String(e?.message || e));
    } finally {
      setInstalling(false);
    }
  };

  const runSignIn = async () => {
    setSignInBusy(true);
    setSignInDetail(null);
    setSignInErr(null);
    try {
      const j = await openClaudeSignInTerminal();
      setSignInDetail(`Opened in ${j.terminal}. Follow the prompts, then come back and hit Refresh.`);
    } catch (e) {
      setSignInErr(String(e?.message || e));
    } finally {
      setSignInBusy(false);
    }
  };

  // Nothing to do — binary present and signed in. Hide the block entirely so
  // the card stays clean in the happy path.
  if (!binMissing && !notSignedIn && !installing && !installLog && !signInDetail) {
    return null;
  }

  return (
    <div className="pt-3 mt-2 border-t border-ink-700/40 space-y-3">
      {binMissing && (
        <div>
          <div className="text-xs text-ink-300 mb-2">
            The <code className="font-mono text-ink-200">claude</code> binary wasn&rsquo;t found on your machine.
            Install it with one click — runs the official installer from <code className="font-mono text-ink-300">claude.ai/install.sh</code>.
          </div>
          <button
            type="button"
            onClick={runInstall}
            disabled={installing}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:opacity-60"
          >
            {installing ? 'Installing…' : 'Install Claude CLI'}
          </button>
        </div>
      )}

      {notSignedIn && !binMissing && (
        <div>
          <div className="text-xs text-ink-300 mb-2">
            You&rsquo;re not signed in to the Claude CLI. Sign in once in a terminal window and you&rsquo;re set.
          </div>
          <button
            type="button"
            onClick={runSignIn}
            disabled={signInBusy}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:opacity-60"
          >
            {signInBusy ? 'Opening terminal…' : 'Sign in to Claude'}
          </button>
          {signInDetail && (
            <div className="mt-2 text-[11px] text-ink-400">{signInDetail}</div>
          )}
          {signInErr && (
            <div className="mt-2 text-[11px] text-accent-500 break-all">{signInErr}</div>
          )}
        </div>
      )}

      {(installing || installLog) && (
        <div>
          <div
            ref={logRef}
            className="font-mono text-[11px] text-ink-300 bg-ink-950 border border-ink-700/60 rounded-md p-2 h-40 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {installLog || 'Starting installer…\n'}
          </div>
          {installErr && (
            <div className="mt-2 text-[11px] text-accent-500 break-all">{installErr}</div>
          )}
          {installDone && (
            <div className="mt-2 text-[11px]">
              {installDone.exitCode === 0 ? (
                <span className="text-emerald-400">
                  Installed. You can close this panel — the binary is ready.
                </span>
              ) : (
                <span className="text-accent-500">
                  Installer exited with code {installDone.exitCode}. Check the log above for details.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Once installed, offer sign-in in the same block so the user doesn't
          have to hunt for it. */}
      {installDone?.exitCode === 0 && installDone?.info?.login?.status !== 'logged_in' && (
        <div>
          <button
            type="button"
            onClick={runSignIn}
            disabled={signInBusy}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:opacity-60"
          >
            {signInBusy ? 'Opening terminal…' : 'Sign in to Claude'}
          </button>
          {signInDetail && (
            <div className="mt-2 text-[11px] text-ink-400">{signInDetail}</div>
          )}
          {signInErr && (
            <div className="mt-2 text-[11px] text-accent-500 break-all">{signInErr}</div>
          )}
        </div>
      )}
    </div>
  );
}
