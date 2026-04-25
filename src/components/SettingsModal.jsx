import React, { useEffect, useRef, useState } from 'react';
import {
  getBackendEnvInfo,
  installClaudeCli,
  getAuthStatus,
  openClaudeConfigTerminal,
  getDockerStatus,
  getSandboxStatus,
  getMcpRegistryServers,
  getCuratedMcpServers,
  getInstalledMcpServers,
  installCuratedMcpServer,
  uninstallMcpServer,
  listPlugins,
  updatePluginSettings,
  startPlugin,
  stopPlugin,
} from '../lib/api.js';

// Two-pane settings modal with a left nav. Sections grow as we wire up more
// of the CLI's surface area — each one owns its own data loading so switching
// tabs never blocks the main modal open.
const SECTIONS = [
  { id: 'general',     label: 'General' },
  { id: 'account',     label: 'Account' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'mcp-servers', label: 'MCP Servers' },
  { id: 'plugins',     label: 'Plugins' },
  { id: 'security',    label: 'Security' },
];

// `onRequestSignIn` is called when the user clicks any in-modal "Sign in"
// button. It lets the parent own the sign-in explainer flow so the same
// step-by-step popup fires regardless of where the click came from (launch
// banner, account tab, bootstrap card). If not provided, the sign-in CTAs
// are hidden rather than silently no-oping.
export default function SettingsModal({ onClose, onRequestSignIn }) {
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
              <GeneralSection env={env} app={app} err={err} onRefresh={load} onRequestSignIn={onRequestSignIn} />
            )}
            {section === 'account' && <AccountSection onRequestSignIn={onRequestSignIn} />}
            {section === 'claude-code' && <ClaudeCodeSection />}
            {section === 'mcp-servers' && <McpServersSection />}
            {section === 'plugins' && <PluginsSection />}
            {section === 'security' && <SecuritySection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralSection({ env, app, err, onRefresh, onRequestSignIn }) {
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

        <ClaudeBootstrap env={env} onRefresh={onRefresh} onRequestSignIn={onRequestSignIn} />

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

function AccountSection({ onRequestSignIn }) {
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

        {!signedIn && status?.binExists && onRequestSignIn && (
          <div className="mt-4 pt-3 border-t border-ink-700/40">
            <SignInButton onRequestSignIn={onRequestSignIn} />
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

// --- MCP Servers ---------------------------------------------------------
//
// Three views share this section:
//
//   view='installed'  — the user's configured servers (empty for now until we
//                       wire the CLI config file). Shows an "Add more" CTA.
//   view='picker'     — browses the official MCP registry
//                       (https://modelcontextprotocol.io/registry/about). The
//                       registry is only fetched when the user enters this
//                       view — it's a few hundred entries and wasn't worth
//                       paying for on every Settings open.
//   view='detail'     — full card for a single server from the picker: title,
//                       canonical name, description, repo + website links,
//                       remotes, packages, required env vars.
//
// Install/enable flows are still TODO — the buttons on the detail view are
// placeholders. The registry is read-only from our side.

function McpServersSection() {
  // view: 'installed' | 'curated-picker' | 'curated-detail' | 'registry-picker' | 'registry-detail'
  const [view, setView] = useState('installed');
  const [selected, setSelected] = useState(null);
  // Bumped on each install/uninstall so the installed list refetches.
  const [installedTick, setInstalledTick] = useState(0);

  if (view === 'curated-detail' && selected) {
    return (
      <McpCuratedDetail
        server={selected}
        onBack={() => { setSelected(null); setView('curated-picker'); }}
        onInstalled={() => {
          setSelected(null);
          setInstalledTick((t) => t + 1);
          setView('installed');
        }}
      />
    );
  }

  if (view === 'registry-detail' && selected) {
    return (
      <McpRegistryDetail
        server={selected}
        onBack={() => { setSelected(null); setView('registry-picker'); }}
      />
    );
  }

  if (view === 'curated-picker') {
    return (
      <McpCuratedPicker
        onBack={() => setView('installed')}
        onPick={(s) => { setSelected(s); setView('curated-detail'); }}
        onBrowseRegistry={() => setView('registry-picker')}
      />
    );
  }

  if (view === 'registry-picker') {
    return (
      <McpRegistryPicker
        onBack={() => setView('curated-picker')}
        onPick={(s) => { setSelected(s); setView('registry-detail'); }}
      />
    );
  }

  return (
    <McpInstalledList
      refreshKey={installedTick}
      onAddMore={() => setView('curated-picker')}
      onChanged={() => setInstalledTick((t) => t + 1)}
    />
  );
}

// Installed view. Pulls the live set from ~/.claude.json via /mcp-installed.
function McpInstalledList({ refreshKey, onAddMore, onChanged }) {
  const [state, setState] = useState({ loading: true, error: null, servers: [] });

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const out = await getInstalledMcpServers();
      setState({ loading: false, error: null, servers: out.servers || [] });
    } catch (e) {
      setState({ loading: false, error: String(e?.message || e), servers: [] });
    }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const onRemove = async (id) => {
    if (!window.confirm(`Remove MCP server "${id}"? The Claude CLI will stop connecting to it on the next turn.`)) return;
    try {
      await uninstallMcpServer(id);
      onChanged?.();
    } catch (e) {
      window.alert(String(e?.message || e));
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Installed MCP servers"
        subtitle="Active entries from ~/.claude.json. The Claude CLI picks them up automatically on the next chat turn."
      >
        {state.loading && state.servers.length === 0 && (
          <div className="text-center text-xs text-ink-500 py-4">Loading…</div>
        )}
        {state.error && (
          <div className="text-xs text-accent-500">{state.error}</div>
        )}
        {!state.loading && !state.error && state.servers.length === 0 && (
          <div className="py-6 text-center">
            <div className="text-sm text-ink-300">No MCP servers installed.</div>
            <div className="text-[11.5px] text-ink-500 mt-1">
              Browse Cowork's catalog to add one.
            </div>
          </div>
        )}
        <div className="space-y-2">
          {state.servers.map((s) => (
            <InstalledMcpRow key={s.id} server={s} onRemove={() => onRemove(s.id)} />
          ))}
        </div>
      </Card>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onAddMore}
          className="text-xs font-medium px-3 py-1.5 rounded bg-accent-500 text-ink-50 hover:bg-accent-600"
        >
          + Add more
        </button>
      </div>
    </div>
  );
}

function InstalledMcpRow({ server, onRemove }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-ink-700/60 bg-ink-900/30 px-3 py-2.5">
      <McpServerIcon server={{ iconUrl: server.iconUrl, title: server.name, name: server.id }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="text-sm font-medium text-ink-100 truncate">{server.name}</div>
          <div className="text-[11px] text-ink-500 font-mono truncate">{server.id}</div>
          <Pill tone={server.transport === 'http' ? 'ok' : undefined}>{server.transport}</Pill>
          {!server.curated && <Pill tone="warn">unmanaged</Pill>}
        </div>
        {server.description && (
          <div className="text-[12px] text-ink-300 mt-1 line-clamp-2">{server.description}</div>
        )}
        {server.url && (
          <div className="text-[10.5px] text-ink-500 font-mono mt-1 break-all">{server.url}</div>
        )}
        {server.command && (
          <div className="text-[10.5px] text-ink-500 font-mono mt-1 break-all">$ {server.command}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 self-start text-[11px] text-ink-400 hover:text-accent-500 px-2 py-1 rounded hover:bg-ink-800"
        title="Remove from ~/.claude.json"
      >
        Remove
      </button>
    </div>
  );
}

// Cowork-curated picker. This is the primary "Add more" landing. It shows
// only the servers we've vetted and know how to install end-to-end (auth
// flow + config write-through); users looking for something we don't curate
// yet can drop into the full public registry via the footer link.
function McpCuratedPicker({ onBack, onPick, onBrowseRegistry }) {
  const [state, setState] = useState({ loading: true, error: null, servers: [] });

  useEffect(() => {
    (async () => {
      try {
        const out = await getCuratedMcpServers();
        setState({ loading: false, error: null, servers: out.servers || [] });
      } catch (e) {
        setState({ loading: false, error: String(e?.message || e), servers: [] });
      }
    })();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1 rounded hover:bg-ink-800"
        >
          ← Back
        </button>
        <div className="text-ink-100 text-sm font-medium">Add MCP server</div>
      </div>

      <Card
        title="Cowork catalog"
        subtitle="Curated, installable servers. Tap one to review, add credentials if needed, and install."
      >
        {state.loading && (
          <div className="text-center text-xs text-ink-500 py-4">Loading…</div>
        )}
        {state.error && (
          <div className="text-xs text-accent-500">{state.error}</div>
        )}
        {!state.loading && !state.error && state.servers.length === 0 && (
          <div className="text-center text-xs text-ink-500 py-4">
            No curated servers yet.
          </div>
        )}
      </Card>

      <div className="space-y-2">
        {state.servers.map((s) => (
          <McpServerRow
            key={s.id}
            server={{
              ...s,
              title: s.name,
              name: s.registryName || s.id,
            }}
            onClick={() => onPick(s)}
          />
        ))}
      </div>

      <div className="pt-2 border-t border-ink-700/40 text-[11.5px] text-ink-500">
        Looking for something else?{' '}
        <button
          type="button"
          onClick={onBrowseRegistry}
          className="text-accent-500 hover:text-accent-600 underline underline-offset-2"
        >
          Browse the full MCP registry
        </button>
        {' '}(500+ servers, discovery-only — installation via this app is Cowork-catalog only).
      </div>
    </div>
  );
}

// Detail view + install form for a curated server. Collects `params` (args)
// and `env` (secrets) declared on the catalog entry, then hits the backend
// install route. Success bounces back to the installed list.
function McpCuratedDetail({ server, onBack, onInstalled }) {
  const [paramVals, setParamVals] = useState(() => {
    const o = {};
    for (const p of (server.params || [])) o[p.key] = '';
    return o;
  });
  const [envVals, setEnvVals] = useState(() => {
    const o = {};
    for (const e of (server.env || [])) o[e.key] = '';
    return o;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const missingRequired =
    (server.params || []).some((p) => p.required && !paramVals[p.key]?.trim()) ||
    (server.env || []).some((e) => e.required && !envVals[e.key]?.trim());

  const doInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      await installCuratedMcpServer({
        id: server.id,
        params: paramVals,
        env: envVals,
      });
      onInstalled?.();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1 rounded hover:bg-ink-800"
        >
          ← Back
        </button>
        <div className="text-ink-100 text-sm font-medium truncate">{server.name}</div>
      </div>

      <Card title="Overview">
        <div className="flex items-start gap-3">
          <McpServerIcon server={{ ...server, title: server.name, name: server.registryName || server.id }} large />
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold text-ink-50 break-words">{server.name}</div>
            {server.registryName && (
              <div className="text-[11px] text-ink-500 font-mono break-all mt-0.5">{server.registryName}</div>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Pill tone="ok">curated</Pill>
              <Pill>{server.spec?.type || 'stdio'}</Pill>
            </div>
          </div>
        </div>
        <div className="text-[13px] text-ink-200 leading-relaxed whitespace-pre-wrap pt-2">
          {server.description}
        </div>
        {server.homepage && (
          <div className="pt-2 text-[11.5px]">
            <a
              href={server.homepage}
              target="_blank"
              rel="noreferrer"
              className="text-accent-500 hover:text-accent-600 underline underline-offset-2"
            >
              Homepage ↗
            </a>
          </div>
        )}
      </Card>

      {(server.params?.length > 0) && (
        <Card title="Parameters" subtitle="Runtime values baked into the server's launch args.">
          <div className="space-y-3">
            {server.params.map((p) => (
              <Field
                key={p.key}
                label={<>{p.label || p.key} {p.required && <span className="text-accent-500">*</span>}</>}
                hint={p.description}
              >
                <input
                  type="text"
                  value={paramVals[p.key] || ''}
                  onChange={(e) => setParamVals((v) => ({ ...v, [p.key]: e.target.value }))}
                  placeholder={p.placeholder || ''}
                  className="w-full bg-ink-900 border border-ink-700/60 rounded px-2.5 py-1.5 text-xs text-ink-100 placeholder-ink-500 focus:outline-none focus:border-accent-500/60"
                />
              </Field>
            ))}
          </div>
        </Card>
      )}

      {(server.env?.length > 0) && (
        <Card title="Credentials" subtitle="Stored in ~/.claude.json (mode 0600) and passed to the server subprocess as env vars. Never leaves your machine.">
          <div className="space-y-3">
            {server.env.map((e) => (
              <Field
                key={e.key}
                label={<>{e.label || e.key} {e.required && <span className="text-accent-500">*</span>}</>}
                hint={
                  <>
                    {e.description}
                    {e.helpUrl && (
                      <>
                        {' '}
                        <a
                          href={e.helpUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent-500 hover:text-accent-600 underline underline-offset-2"
                        >
                          Get one ↗
                        </a>
                      </>
                    )}
                  </>
                }
              >
                <input
                  type={e.type === 'secret' || e.isSecret ? 'password' : 'text'}
                  value={envVals[e.key] || ''}
                  onChange={(ev) => setEnvVals((v) => ({ ...v, [e.key]: ev.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-ink-900 border border-ink-700/60 rounded px-2.5 py-1.5 text-xs text-ink-100 font-mono placeholder-ink-500 focus:outline-none focus:border-accent-500/60"
                />
              </Field>
            ))}
          </div>
        </Card>
      )}

      {error && (
        <div className="rounded border border-accent-500/40 bg-accent-500/10 text-accent-500 text-[11.5px] px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="text-xs text-ink-300 hover:text-ink-100 disabled:opacity-50 px-3 py-1.5 rounded border border-ink-700/60 hover:bg-ink-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={doInstall}
          disabled={busy || missingRequired}
          className="text-xs font-medium px-3 py-1.5 rounded bg-accent-500 text-ink-50 hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Installing…' : 'Install'}
        </button>
      </div>
    </div>
  );
}

// Registry (full public catalog) browser. Discovery-only — installation
// from here is not supported yet (users can copy the name into `claude mcp
// add` manually). Same shape as the curated picker, with an info banner.
function McpRegistryPicker({ onBack, onPick }) {
  const [state, setState] = useState({ loading: true, error: null, servers: [], cachedAt: 0 });
  const [query, setQuery] = useState('');

  const load = async ({ refresh = false } = {}) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const out = await getMcpRegistryServers({ refresh });
      setState({ loading: false, error: null, servers: out.servers || [], cachedAt: out.cachedAt || 0 });
    } catch (e) {
      setState({ loading: false, error: String(e?.message || e), servers: [], cachedAt: 0 });
    }
  };

  useEffect(() => { load(); }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? state.servers.filter((s) =>
        (s.title || '').toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q))
    : state.servers;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1 rounded hover:bg-ink-800"
        >
          ← Back
        </button>
        <div className="text-ink-100 text-sm font-medium">Add MCP server</div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => load({ refresh: true })}
          disabled={state.loading}
          className="text-xs text-ink-400 hover:text-ink-100 disabled:opacity-50 px-2 py-1 rounded hover:bg-ink-800"
        >
          {state.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <Card
        title="Model Context Protocol registry"
        subtitle="Pick a server to view its details. Install flow coming soon."
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, title, or description…"
          className="w-full bg-ink-900 border border-ink-700/60 rounded px-2.5 py-1.5 text-xs text-ink-100 placeholder-ink-500 focus:outline-none focus:border-accent-500/60"
        />
        <div className="text-[11px] text-ink-500">
          {state.loading && state.servers.length === 0 && 'Loading registry…'}
          {!state.loading && !state.error && (
            <>Showing {filtered.length} of {state.servers.length} server{state.servers.length === 1 ? '' : 's'}.</>
          )}
          {state.error && <span className="text-accent-500">{state.error}</span>}
        </div>
      </Card>

      <div className="space-y-2">
        {filtered.map((s) => (
          <McpServerRow
            key={s.name + ':' + (s.version || '')}
            server={s}
            onClick={() => onPick(s)}
          />
        ))}
        {!state.loading && filtered.length === 0 && !state.error && (
          <div className="text-center text-xs text-ink-500 py-8">
            {q ? 'No servers match your search.' : 'The registry returned no servers.'}
          </div>
        )}
      </div>
    </div>
  );
}

function McpServerRow({ server, onClick }) {
  const label = server.title || server.name;
  const clickable = typeof onClick === 'function';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`w-full text-left flex items-start gap-3 rounded-lg border border-ink-700/60 bg-ink-800/30 px-3 py-3 transition-colors ${clickable ? 'hover:bg-ink-800/60 hover:border-ink-600/60 cursor-pointer' : 'cursor-default'}`}
    >
      <McpServerIcon server={server} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="text-sm font-medium text-ink-100 truncate">{label}</div>
          {server.title && server.name !== server.title && (
            <div className="text-[11px] text-ink-500 font-mono truncate">{server.name}</div>
          )}
          {server.version && (
            <div className="text-[10.5px] text-ink-500 font-mono shrink-0">v{server.version}</div>
          )}
        </div>
        <div className="text-[12px] text-ink-300 mt-1 line-clamp-2">
          {server.description || <span className="italic text-ink-500">No description provided.</span>}
        </div>
      </div>
      {clickable && <div className="shrink-0 self-center text-ink-500 text-lg leading-none">›</div>}
    </button>
  );
}

// Full-page detail for a single registry server — name, description,
// external links, and the technical metadata from the registry entry
// (remotes / packages / env vars). Discovery-only, no install from here.
function McpRegistryDetail({ server, onBack }) {
  const label = server.title || server.name;
  const hasRemotes = Array.isArray(server.remotes) && server.remotes.length > 0;
  const hasPackages = Array.isArray(server.packages) && server.packages.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-ink-300 hover:text-ink-100 px-2 py-1 rounded hover:bg-ink-800"
        >
          ← Back
        </button>
        <div className="text-ink-100 text-sm font-medium truncate">{label}</div>
      </div>

      <Card title="Overview">
        <div className="flex items-start gap-3">
          <McpServerIcon server={server} large />
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold text-ink-50 break-words">{label}</div>
            <div className="text-[11px] text-ink-500 font-mono break-all mt-0.5">{server.name}</div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {server.version && <Pill>v{server.version}</Pill>}
              {server.latest && <Pill tone="ok">latest</Pill>}
            </div>
          </div>
        </div>
        <div className="text-[13px] text-ink-200 leading-relaxed whitespace-pre-wrap pt-2">
          {server.description || <span className="italic text-ink-500">No description provided.</span>}
        </div>
        {(server.websiteUrl || server.repoUrl) && (
          <div className="pt-2 flex items-center gap-3 flex-wrap text-[11.5px]">
            {server.websiteUrl && (
              <a
                href={server.websiteUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent-500 hover:text-accent-600 underline underline-offset-2"
              >
                Website ↗
              </a>
            )}
            {server.repoUrl && (
              <a
                href={server.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent-500 hover:text-accent-600 underline underline-offset-2"
              >
                {server.repoSource === 'github' ? 'GitHub ↗' : 'Repository ↗'}
              </a>
            )}
          </div>
        )}
      </Card>

      {hasRemotes && (
        <Card title="Remote endpoints" subtitle="Hosted URLs this server exposes.">
          <div className="space-y-1.5">
            {server.remotes.map((r, i) => (
              <div key={i} className="text-xs">
                <span className="inline-block text-[10.5px] text-ink-400 font-mono bg-ink-900 border border-ink-700/60 rounded px-1.5 py-0.5 mr-2">
                  {r.type || 'remote'}
                </span>
                <span className="text-ink-200 font-mono break-all">{r.url || '(no url)'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {hasPackages && (
        <Card title="Packages" subtitle="Published artifacts you can install and run locally.">
          <div className="space-y-3">
            {server.packages.map((p, i) => (
              <div key={i} className="rounded border border-ink-700/60 bg-ink-900/30 p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  {p.registryType && <Pill>{p.registryType}</Pill>}
                  {p.transport && <Pill>{p.transport}</Pill>}
                  {p.runtimeHint && <Pill>{p.runtimeHint}</Pill>}
                  {p.version && (
                    <span className="text-[10.5px] text-ink-500 font-mono ml-auto">v{p.version}</span>
                  )}
                </div>
                {p.identifier && (
                  <div className="text-xs text-ink-200 font-mono break-all">{p.identifier}</div>
                )}
                {p.environmentVariables?.length > 0 && (
                  <div className="pt-1 border-t border-ink-700/40 space-y-1">
                    <div className="text-[11px] text-ink-400">Environment variables</div>
                    {p.environmentVariables.map((e) => (
                      <div key={e.name} className="text-[11.5px] leading-snug">
                        <span className="text-ink-200 font-mono">{e.name}</span>
                        {e.isRequired && <span className="ml-1.5 text-[10px] text-accent-500">required</span>}
                        {e.isSecret && <span className="ml-1.5 text-[10px] text-amber-400">secret</span>}
                        {e.description && <div className="text-ink-500 mt-0.5">{e.description}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          disabled
          className="text-xs font-medium px-3 py-1.5 rounded bg-ink-700/60 text-ink-400 cursor-not-allowed"
          title="Install flow coming soon"
        >
          Install (coming soon)
        </button>
      </div>
    </div>
  );
}

// Small avatar for an MCP server. Prefers the GitHub org avatar when the
// server has a repository URL; falls back to a letter tile so every row has
// a consistent visual anchor.
function McpServerIcon({ server, large = false }) {
  const [errored, setErrored] = useState(false);
  const size = large ? 'w-12 h-12 text-base' : 'w-8 h-8 text-xs';
  const px = large ? 48 : 32;
  const hasIcon = server.iconUrl && !errored;
  if (hasIcon) {
    return (
      <img
        src={server.iconUrl}
        alt=""
        width={px}
        height={px}
        className={`shrink-0 ${size} rounded bg-ink-900 border border-ink-700/60 object-cover`}
        onError={() => setErrored(true)}
      />
    );
  }
  // Deterministic letter tile from the first alphanumeric of the label.
  const label = server.title || server.name || '?';
  const letter = (label.match(/[a-zA-Z0-9]/)?.[0] || '?').toUpperCase();
  // Hue derived from the name hash → stable colour per server.
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return (
    <div
      className={`shrink-0 ${size} rounded border border-ink-700/60 flex items-center justify-center font-semibold text-ink-50`}
      style={{ background: `hsl(${hue} 35% 28%)` }}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
}

// --- Security (sandboxing / jailbreak) -----------------------------------

function SecuritySection() {
  const [prefs, setPrefs] = useState(null);
  const [docker, setDocker] = useState(null);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [sandbox, setSandbox] = useState(null);
  const [sandboxLoading, setSandboxLoading] = useState(false);
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

  const refreshSandbox = async () => {
    setSandboxLoading(true);
    try {
      const s = await getSandboxStatus();
      setSandbox(s);
    } catch (e) {
      setSandbox({ available: false, reason: String(e?.message || e) });
    } finally {
      setSandboxLoading(false);
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
    refreshSandbox();
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
          badge={
            sandboxLoading
              ? <Pill tone="muted">Checking…</Pill>
              : sandbox?.available
                ? <Pill tone="ok">Sandboxed{sandbox.tool ? ` (${sandbox.tool})` : ''}</Pill>
                : sandbox?.platform === 'linux'
                  ? <Pill tone="warn">bwrap missing</Pill>
                  : <Pill tone="warn">Host spawn</Pill>
          }
        >
          <div>
            Wraps each cowork session in an unprivileged{' '}
            <code className="font-mono text-ink-200">bubblewrap</code> sandbox. Only the folders you
            attach (plus <code className="font-mono text-ink-200">~/.claude</code> for credentials)
            are visible — the rest of your home directory is hidden behind a tmpfs. The CLI&rsquo;s
            own permission prompts still apply on top.
          </div>
          {!sandboxLoading && sandbox && !sandbox.available && sandbox.platform === 'linux' && (
            <div className="mt-3 rounded-md bg-amber-500/10 border border-amber-500/40 px-3 py-2">
              <div className="text-[12px] text-amber-400 font-medium mb-1">
                Sandbox not available — {sandbox.reason || 'bubblewrap not installed'}
              </div>
              <div className="text-[11px] text-ink-300 mb-2">
                Default mode will refuse to start until <code className="font-mono text-ink-100">bwrap</code>{' '}
                is installed. Pick the command for your distribution:
              </div>
              {sandbox.installHints && (
                <div className="space-y-0.5">
                  {Object.entries(sandbox.installHints).map(([family, cmd]) => (
                    <div key={family} className="flex text-[11px] font-mono">
                      <span className="text-ink-500 w-[24ch] shrink-0">{family}</span>
                      <span className="text-ink-100">{cmd}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {!sandboxLoading && sandbox && !sandbox.available && sandbox.platform !== 'linux' && (
            <div className="mt-3 rounded-md bg-amber-500/10 border border-amber-500/40 px-3 py-2 text-[11.5px] text-amber-400">
              {sandbox.reason || `Sandboxing is not implemented on ${sandbox.platform} yet.`}
              {' '}Default mode still runs, but on the host — prefer Docker mode if you need real isolation.
            </div>
          )}
          {!sandboxLoading && sandbox?.available && (
            <div className="mt-2 text-[11px] text-ink-500 font-mono truncate" title={sandbox.path}>
              {sandbox.path}{sandbox.version ? `  ·  v${sandbox.version}` : ''}
            </div>
          )}
          <div className="mt-2">
            <button
              type="button"
              onClick={refreshSandbox}
              disabled={sandboxLoading}
              className="text-[11px] text-ink-400 hover:text-ink-100 disabled:opacity-50 px-2 py-1 rounded hover:bg-ink-800"
            >
              {sandboxLoading ? 'Checking sandbox…' : 'Re-check sandbox'}
            </button>
          </div>
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
// logged in. Mirrors the General > ClaudeBootstrap button. Delegates the
// actual terminal spawn to the parent-owned SignInModal so the user gets the
// same explainer regardless of entry point.
function SignInButton({ onRequestSignIn }) {
  return (
    <button
      type="button"
      onClick={() => onRequestSignIn?.()}
      className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400"
    >
      Sign in to Claude
    </button>
  );
}

// Inline install + sign-in affordances. Rendered inside the Claude CLI card so
// the user can recover in one click if the binary is missing or not logged in.
// Sign-in is delegated up to the parent (SignInModal explainer); install runs
// inline because it's a long-running streamed operation that needs log output.
function ClaudeBootstrap({ env, onRefresh, onRequestSignIn }) {
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [installErr, setInstallErr] = useState(null);
  const [installDone, setInstallDone] = useState(null); // { exitCode }
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

  // Nothing to do — binary present and signed in. Hide the block entirely so
  // the card stays clean in the happy path.
  if (!binMissing && !notSignedIn && !installing && !installLog) {
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

      {notSignedIn && !binMissing && onRequestSignIn && (
        <div>
          <div className="text-xs text-ink-300 mb-2">
            You&rsquo;re not signed in to the Claude CLI. Sign in once in a terminal window and you&rsquo;re set.
          </div>
          <button
            type="button"
            onClick={() => onRequestSignIn()}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400"
          >
            Sign in to Claude
          </button>
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
      {installDone?.exitCode === 0 && installDone?.info?.login?.status !== 'logged_in' && onRequestSignIn && (
        <div>
          <button
            type="button"
            onClick={() => onRequestSignIn()}
            className="text-xs px-3 py-1.5 rounded-md bg-accent-500 text-ink-950 font-medium hover:bg-accent-400"
          >
            Sign in to Claude
          </button>
        </div>
      )}
    </div>
  );
}

// --- Plugins --------------------------------------------------------------
//
// Host-side helper processes the Electron main spawns outside the sandbox.
// See electron/plugins.cjs for the runtime. Two views:
//   'list'   — every plugin in the catalog with a status pill and Start/Stop.
//   'detail' — full description, live runtime state (endpoint, logs, errors)
//              plus a per-plugin settings form rendered from the catalog's
//              `settingsSchema` field.
// Start/Stop/Save bump `tick` so visible data refetches.

function PluginsSection() {
  const [view, setView] = useState('list');
  const [selected, setSelected] = useState(null);
  const [tick, setTick] = useState(0);

  if (view === 'detail' && selected) {
    return (
      <PluginDetail
        pluginId={selected}
        refreshKey={tick}
        onBack={() => { setSelected(null); setView('list'); }}
        onChanged={() => setTick((t) => t + 1)}
      />
    );
  }

  return (
    <PluginList
      refreshKey={tick}
      onOpen={(id) => { setSelected(id); setView('detail'); }}
      onChanged={() => setTick((t) => t + 1)}
    />
  );
}

function PluginList({ refreshKey, onOpen, onChanged }) {
  const [state, setState] = useState({ loading: true, error: null, plugins: [] });

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const out = await listPlugins();
      setState({ loading: false, error: null, plugins: out.plugins || [] });
    } catch (e) {
      setState({ loading: false, error: String(e?.message || e), plugins: [] });
    }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const onToggle = async (plugin) => {
    try {
      if (plugin.status.state === 'running' || plugin.status.state === 'starting') {
        await stopPlugin(plugin.id);
      } else {
        await startPlugin(plugin.id);
      }
      onChanged?.();
    } catch (e) {
      window.alert(String(e?.message || e));
      onChanged?.();
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Plugins"
        subtitle="Host-side helpers that run outside the sandbox. Use them to give Claude access to resources the sandbox deliberately hides — a real browser, a shared clipboard, system notifications, etc."
      >
        {state.loading && state.plugins.length === 0 && (
          <div className="text-center text-xs text-ink-500 py-4">Loading…</div>
        )}
        {state.error && (
          <div className="text-xs text-accent-500">{state.error}</div>
        )}
        {!state.loading && !state.error && state.plugins.length === 0 && (
          <div className="py-6 text-center text-sm text-ink-300">No plugins available.</div>
        )}
        <div className="space-y-2">
          {state.plugins.map((p) => (
            <PluginRow
              key={p.id}
              plugin={p}
              onOpen={() => onOpen(p.id)}
              onToggle={() => onToggle(p)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

function PluginRow({ plugin, onOpen, onToggle }) {
  const { status } = plugin;
  const running = status.state === 'running';
  const starting = status.state === 'starting';
  const stopping = status.state === 'stopping';
  const busy = starting || stopping;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-ink-700/60 bg-ink-900/30 px-3 py-2.5">
      <McpServerIcon server={{ iconUrl: plugin.iconUrl, title: plugin.name, name: plugin.id }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <button
            type="button"
            onClick={onOpen}
            className="text-sm font-medium text-ink-100 hover:text-accent-400 truncate"
          >
            {plugin.name}
          </button>
          <div className="text-[11px] text-ink-500 font-mono truncate">{plugin.id}</div>
          <PluginStatePill state={status.state} adopted={status.adopted} />
        </div>
        {plugin.description && (
          <div className="text-[12px] text-ink-300 mt-1 line-clamp-2">{plugin.description}</div>
        )}
        {status.state === 'error' && status.lastError && (
          <div className="text-[11.5px] text-accent-500 mt-1">{status.lastError}</div>
        )}
        {running && status.endpoint && (
          <div className="text-[11px] text-ink-500 font-mono mt-1 truncate">{status.endpoint}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onOpen}
          className="text-[11px] px-2 py-1 rounded border border-ink-700/60 text-ink-300 hover:text-ink-100 hover:bg-ink-800"
        >
          Configure
        </button>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={`text-[11px] px-2.5 py-1 rounded font-medium transition-colors disabled:opacity-60
            ${running
              ? 'bg-ink-700/60 text-ink-100 hover:bg-ink-700'
              : 'bg-accent-500 text-ink-950 hover:bg-accent-400'}`}
        >
          {starting ? 'Starting…' : stopping ? 'Stopping…' : running ? 'Stop' : 'Start'}
        </button>
      </div>
    </div>
  );
}

function PluginStatePill({ state, adopted }) {
  if (state === 'running') return <Pill tone="ok">{adopted ? 'running (adopted)' : 'running'}</Pill>;
  if (state === 'starting') return <Pill tone="warn">starting</Pill>;
  if (state === 'stopping') return <Pill tone="warn">stopping</Pill>;
  if (state === 'error') return <Pill tone="bad">error</Pill>;
  return <Pill>stopped</Pill>;
}

function PluginDetail({ pluginId, refreshKey, onBack, onChanged }) {
  const [state, setState] = useState({ loading: true, error: null, plugin: null });
  // `draft` holds unsaved edits. Initialised from the plugin's persisted
  // settings on first load and deliberately NOT overwritten by subsequent
  // status-refresh fetches — otherwise edits would vanish mid-typing.
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = async () => {
    try {
      const out = await listPlugins();
      const plugin = (out.plugins || []).find((p) => p.id === pluginId);
      if (!plugin) throw new Error(`plugin "${pluginId}" not found`);
      setState({ loading: false, error: null, plugin });
      setDraft((d) => d || { ...plugin.settings });
    } catch (e) {
      setState({ loading: false, error: String(e?.message || e), plugin: null });
    }
  };

  useEffect(() => { load(); }, [pluginId, refreshKey]);

  // Poll while the detail view is open so state transitions (starting →
  // running, running → error) show up without user intervention.
  useEffect(() => {
    const t = setInterval(() => { load(); }, 2000);
    return () => clearInterval(t);
  }, [pluginId]);

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updatePluginSettings(pluginId, draft);
      onChanged?.();
    } catch (e) {
      setSaveError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async () => {
    try {
      if (state.plugin?.status.state === 'running' || state.plugin?.status.state === 'starting') {
        await stopPlugin(pluginId);
      } else {
        await startPlugin(pluginId);
      }
      onChanged?.();
    } catch (e) {
      window.alert(String(e?.message || e));
      onChanged?.();
    }
  };

  if (state.loading && !state.plugin) {
    return <div className="text-center text-xs text-ink-500 py-8">Loading…</div>;
  }
  if (state.error) {
    return (
      <div className="space-y-3">
        <BackLink onClick={onBack} />
        <div className="text-xs text-accent-500">{state.error}</div>
      </div>
    );
  }

  const plugin = state.plugin;
  const status = plugin.status;
  const running = status.state === 'running';
  const starting = status.state === 'starting';
  const stopping = status.state === 'stopping';
  const busy = starting || stopping;
  const schema = plugin.settingsSchema || [];
  // Save is enabled only if something in the draft diverges from persisted.
  const dirty = !!draft && Object.keys(draft).some(
    (k) => String(draft[k] ?? '') !== String((plugin.settings || {})[k] ?? ''),
  );

  return (
    <div className="space-y-4">
      <BackLink onClick={onBack} />

      <div className="flex items-start gap-3">
        <McpServerIcon server={{ iconUrl: plugin.iconUrl, title: plugin.name, name: plugin.id }} large />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <div className="text-base font-medium text-ink-100">{plugin.name}</div>
            <div className="text-[11px] text-ink-500 font-mono">{plugin.id}</div>
            <PluginStatePill state={status.state} adopted={status.adopted} />
          </div>
          {plugin.description && (
            <div className="text-[12.5px] text-ink-300 mt-1">{plugin.description}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={`text-xs px-3 py-1.5 rounded font-medium transition-colors disabled:opacity-60
            ${running
              ? 'bg-ink-700/60 text-ink-100 hover:bg-ink-700'
              : 'bg-accent-500 text-ink-950 hover:bg-accent-400'}`}
        >
          {starting ? 'Starting…' : stopping ? 'Stopping…' : running ? 'Stop' : 'Start'}
        </button>
      </div>

      <Card title="Runtime" subtitle="Live status of the plugin process.">
        <Row label="State"><PluginStatePill state={status.state} adopted={status.adopted} /></Row>
        {status.endpoint && (
          <Row label="Endpoint">
            <code className="text-[11.5px] text-ink-200 font-mono break-all">{status.endpoint}</code>
          </Row>
        )}
        {status.pid && (
          <Row label="PID">
            <span className="text-[11.5px] text-ink-300 font-mono">{status.pid}</span>
          </Row>
        )}
        {status.startedAt && (
          <Row label="Started">
            <span className="text-[11.5px] text-ink-300">{new Date(status.startedAt).toLocaleTimeString()}</span>
          </Row>
        )}
        {status.lastError && (
          <Row label="Last error">
            <span className="text-[11.5px] text-accent-500 break-words">{status.lastError}</span>
          </Row>
        )}
        {status.logs && status.logs.length > 0 && (
          <div>
            <div className="text-[11px] text-ink-500 mb-1">Recent log lines</div>
            <div className="font-mono text-[10.5px] text-ink-300 bg-ink-950 border border-ink-700/60 rounded-md p-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
              {status.logs.join('\n')}
            </div>
          </div>
        )}
      </Card>

      {plugin.chrome && (
        <ChromeDetectionCard
          chrome={plugin.chrome}
          currentSetting={(draft?.chromePath ?? plugin.settings?.chromePath ?? '').trim()}
          onPick={(path) => setDraft((d) => ({ ...(d || plugin.settings || {}), chromePath: path }))}
        />
      )}

      {schema.length > 0 && (
        <Card
          title="Settings"
          subtitle={`Stored in ~/.cowork/plugins.json (mode 0600). Changes apply the next time ${plugin.name} starts.`}
        >
          <PluginSettingsForm
            schema={schema}
            values={draft || plugin.settings || {}}
            onChange={(k, v) => setDraft((d) => ({ ...(d || {}), [k]: v }))}
          />
          <div className="flex items-center justify-end gap-3 pt-2">
            {saveError && <div className="text-[11.5px] text-accent-500 flex-1">{saveError}</div>}
            <button
              type="button"
              onClick={() => setDraft({ ...plugin.settings })}
              disabled={!dirty || saving}
              className="text-[11px] px-3 py-1.5 rounded border border-ink-700/60 text-ink-300 hover:text-ink-100 hover:bg-ink-800 disabled:opacity-60"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving}
              className="text-[11px] px-3 py-1.5 rounded bg-accent-500 text-ink-950 font-medium hover:bg-accent-400 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Card>
      )}

      {plugin.notes && (
        <div className="text-[11.5px] text-ink-400 border-l-2 border-ink-700/60 pl-3">{plugin.notes}</div>
      )}
    </div>
  );
}

// Chrome-specific detection panel. Shows which binary auto-detect chose
// (or would choose, given the current draft setting) plus every other
// Chrome-family binary we can see on the machine. Clicking a candidate
// writes it into the draft so the user can Save to lock it in.
function ChromeDetectionCard({ chrome, currentSetting, onPick }) {
  const detected = chrome.detected;
  const candidates = Array.isArray(chrome.candidates) ? chrome.candidates : [];
  const alternatives = candidates.filter((c) => c !== detected);

  return (
    <Card
      title="Chrome binary"
      subtitle="Leave the setting blank to auto-detect, or click a candidate below to lock in a specific install."
    >
      <Row label="Will use">
        {detected ? (
          <code className="text-[11.5px] text-ink-200 font-mono break-all">{detected}</code>
        ) : (
          <span className="text-[11.5px] text-accent-500">
            No Chrome found. Install Google Chrome or Chromium, or set an absolute path in the setting below.
          </span>
        )}
      </Row>
      {currentSetting && (
        <Row label="Setting">
          <code className="text-[11.5px] text-ink-300 font-mono break-all">{currentSetting}</code>
        </Row>
      )}
      {alternatives.length > 0 && (
        <div>
          <div className="text-[11px] text-ink-500 mb-1.5">Other installs detected</div>
          <div className="flex flex-wrap gap-1.5">
            {alternatives.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onPick(c)}
                className="text-[11px] font-mono px-2 py-1 rounded border border-ink-700/60 bg-ink-900/40 text-ink-300 hover:text-ink-100 hover:border-accent-500/60"
                title={`Set Chrome binary to ${c}`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-ink-500 mt-1.5">
            Click one to write it into the settings draft below; then hit Save.
          </div>
        </div>
      )}
    </Card>
  );
}

// Render form inputs from the catalog's `settingsSchema` array. Each entry
// is { key, label, description, type, default, placeholder?, min?, max? }.
// `type` is one of text | number | boolean.
function PluginSettingsForm({ schema, values, onChange }) {
  if (!Array.isArray(schema) || schema.length === 0) {
    return <div className="text-[11px] text-ink-500">This plugin has no settings.</div>;
  }
  return (
    <div className="space-y-3">
      {schema.map((s) => (
        <Field key={s.key} label={s.label} hint={s.description}>
          {s.type === 'boolean' ? (
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!values[s.key]}
                onChange={(e) => onChange(s.key, e.target.checked)}
                className="accent-accent-500"
              />
              <span className="text-xs text-ink-300">{values[s.key] ? 'Enabled' : 'Disabled'}</span>
            </label>
          ) : s.type === 'number' ? (
            <input
              type="number"
              value={values[s.key] ?? ''}
              onChange={(e) => onChange(s.key, e.target.value === '' ? '' : Number(e.target.value))}
              min={s.min}
              max={s.max}
              placeholder={s.placeholder || ''}
              className="w-full bg-ink-900 border border-ink-700/60 rounded px-2 py-1.5 text-sm text-ink-100 focus:outline-none focus:border-accent-500/60"
            />
          ) : (
            <input
              type="text"
              value={values[s.key] ?? ''}
              onChange={(e) => onChange(s.key, e.target.value)}
              placeholder={s.placeholder || ''}
              className="w-full bg-ink-900 border border-ink-700/60 rounded px-2 py-1.5 text-sm text-ink-100 focus:outline-none focus:border-accent-500/60"
            />
          )}
        </Field>
      ))}
    </div>
  );
}

function BackLink({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[11px] text-ink-400 hover:text-ink-100"
    >
      ← Back
    </button>
  );
}
