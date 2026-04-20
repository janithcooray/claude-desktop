import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatView from './components/ChatView.jsx';
import FilesPanel from './components/FilesPanel.jsx';
import StatusBar from './components/StatusBar.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import DisclaimerModal from './components/DisclaimerModal.jsx';
import SignInModal from './components/SignInModal.jsx';
import InstallModal from './components/InstallModal.jsx';
import { createApiSession, getBackendEnvInfo, getHealth, setBaseUrl, getAuthStatus } from './lib/api.js';
import { streamChat } from './hooks/useStreamChat.js';

export default function App() {
  const [backendUrl, setBackendUrl] = useState(null);
  const [backendError, setBackendError] = useState(null);
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]); // messages for the active chat
  // In-flight streaming state, keyed by chatId so it survives ChatView
  // remounts when the user switches chats mid-turn.
  //   liveByChat[id]      — current assistant draft (content/events/files)
  //   liveFilesByChat[id] — files emitted so far for the FilesPanel overlay
  //   streamingIds        — which chats currently have an open stream
  // Abort controllers are tracked on a ref because they're not render data.
  const [liveByChat, setLiveByChat] = useState({});
  const [liveFilesByChat, setLiveFilesByChat] = useState({});
  const [streamingIds, setStreamingIds] = useState(() => new Set());
  const streamAbortersRef = useRef(new Map());
  // Shadow of `activeChatId` for use inside async callbacks that outlive the
  // chat switch (e.g. the stream handler checking "am I still the visible
  // chat?" before reloading messages for it).
  const activeChatIdRef = useRef(null);
  const [graphOk, setGraphOk] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // /info snapshot — whether the CLI is installed and signed in. Drives the
  // onboarding banner that prompts the user to install / sign in on first run.
  const [cliEnv, setCliEnv] = useState(null);
  const [cliBannerDismissed, setCliBannerDismissed] = useState(false);
  // Controls the sign-in explainer modal. Auto-opens once per app run when we
  // first see the CLI is installed-but-signed-out (and the disclaimer has been
  // acknowledged). `autoOpened` keeps us from re-opening it after the user
  // dismisses, even if /info still reports logged_out on the next poll.
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInAutoOpened, setSignInAutoOpened] = useState(false);
  // Controls the install explainer modal. Same auto-open-once discipline as
  // sign-in, but install takes priority: if the bin is missing, we don't show
  // the sign-in modal at all until the install completes.
  const [installOpen, setInstallOpen] = useState(false);
  const [installAutoOpened, setInstallAutoOpened] = useState(false);
  // Parsed `claude auth status` output. Used for the sidebar's account badge
  // so the user sees which email + plan their Claude chats are running as.
  const [account, setAccount] = useState(null);
  // First-launch disclaimer gate. `null` = still checking prefs; `true` =
  // already acknowledged; `false` = show the blocking modal. We start the
  // app hidden behind the modal so the user can't poke at anything until
  // they've seen the notice.
  const [disclaimerOk, setDisclaimerOk] = useState(null);

  // Check the stored ack on mount. Once true, we never re-show.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await window.cowork?.prefs?.get?.();
        if (cancelled) return;
        setDisclaimerOk(!!p?.disclaimerAcknowledged);
      } catch {
        // If prefs are unreadable, err on the side of showing the modal so
        // the disclaimer is never silently skipped.
        if (!cancelled) setDisclaimerOk(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Wait for backend URL from the preload, then refresh chat list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await window.cowork?.getBackendInfo?.();
        if (info?.url) {
          setBaseUrl(info.url);
          setBackendUrl(info.url);
        }
        const off = window.cowork?.onBackendReady?.((info) => {
          if (cancelled) return;
          setBaseUrl(info.url);
          setBackendUrl(info.url);
        });
        // Poll for up to ~20s in case the 'ready' event was missed.
        for (let i = 0; i < 200 && !backendUrl; i++) {
          const info = await window.cowork?.getBackendInfo?.();
          if (info?.url) { setBaseUrl(info.url); setBackendUrl(info.url); break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        const list = await window.cowork.db.listChats();
        if (!cancelled) {
          setChats(list);
          setActiveChatId(list[0]?.id ?? null);
        }
        return () => off?.();
      } catch (err) {
        if (!cancelled) setBackendError(String(err?.message || err));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Health ping for status bar
  useEffect(() => {
    if (!backendUrl) return;
    let stopped = false;
    const tick = async () => {
      try {
        const h = await getHealth();
        if (!stopped) setGraphOk(!!h?.graph);
      } catch {
        if (!stopped) setGraphOk(false);
      }
    };
    tick();
    const t = setInterval(tick, 10000);
    return () => { stopped = true; clearInterval(t); };
  }, [backendUrl]);

  // Poll /info for binary + login state. Used to drive the onboarding banner
  // — if the user's first launch has no CLI, we want to surface the installer
  // right up front rather than let chats fail with "spawn claude ENOENT".
  useEffect(() => {
    if (!backendUrl) return;
    let stopped = false;
    const refresh = async () => {
      try {
        const info = await getBackendEnvInfo();
        if (!stopped) setCliEnv(info);
      } catch {
        /* backend might be mid-restart after an install; try again later */
      }
    };
    refresh();
    // Re-poll every time the Settings modal closes (most obvious moment the
    // user would have just installed or signed in).
    const t = setInterval(refresh, 20000);
    return () => { stopped = true; clearInterval(t); };
  }, [backendUrl, settingsOpen]);

  // First-thing install prompt. If the CLI binary isn't on the user's machine,
  // nothing else works — sign-in, chatting, all of it fails with ENOENT — so
  // the install modal takes priority over the sign-in modal. Fires once per
  // app run, gated on the disclaimer being acknowledged.
  useEffect(() => {
    if (disclaimerOk !== true) return;
    if (installAutoOpened) return;
    if (!cliEnv) return;
    if (cliEnv.binExists !== false) return; // bin exists or unknown: nothing to do
    setInstallAutoOpened(true);
    setInstallOpen(true);
  }, [cliEnv, disclaimerOk, installAutoOpened]);

  // First-thing sign-in prompt. When the CLI is installed but the user is
  // signed out, auto-open the explainer modal once — but only after the
  // disclaimer is out of the way, so we never stack two modals. We flip
  // `signInAutoOpened` the first time it triggers so dismissing doesn't cause
  // the modal to pop right back the moment /info re-polls.
  //
  // We check `account.loggedIn` (from `claude auth status`) because it's the
  // authoritative signal — `cliEnv.login.status` can report 'unknown' when
  // ~/.claude exists but credentials live in the keychain or haven't been
  // written yet, which would hide the modal for users who need it most.
  useEffect(() => {
    if (disclaimerOk !== true) return;
    if (signInAutoOpened) return;
    if (installOpen) return; // install modal is active; don't stack
    // Need both signals loaded before deciding — otherwise we'd flash the
    // modal open then immediately close it when the real state arrives.
    if (!cliEnv || !account) return;
    if (cliEnv.binExists === false) return; // install flow owns this case
    if (account.loggedIn !== false) return; // true or indeterminate: leave alone
    setSignInAutoOpened(true);
    setSignInOpen(true);
  }, [cliEnv, account, disclaimerOk, signInAutoOpened, installOpen]);

  // Separately fetch the richer `claude auth status` output for the sidebar
  // badge. Throttled to once per backend-ready / settings-close cycle so we
  // don't spawn the CLI on a timer.
  useEffect(() => {
    if (!backendUrl) return;
    let stopped = false;
    (async () => {
      try {
        const s = await getAuthStatus();
        if (!stopped) setAccount(s);
      } catch { /* the Account tab will surface the error if it matters */ }
    })();
    return () => { stopped = true; };
  }, [backendUrl, settingsOpen]);

  // Keep the ref in sync with state so async callbacks see the current value.
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  // Load messages when active chat changes. We deliberately DON'T touch
  // liveByChat / liveFilesByChat here — those are per-chat and must survive
  // chat-switching (that's the whole reason they exist). Only the DB-backed
  // `messages` list is chat-scoped active state.
  useEffect(() => {
    if (!activeChatId) { setMessages([]); return; }
    let cancelled = false;
    (async () => {
      const list = await window.cowork.db.listMessages(activeChatId);
      if (!cancelled) setMessages(list);
    })();
    return () => { cancelled = true; };
  }, [activeChatId]);

  const activeChat = useMemo(
    () => chats.find((c) => c.id === activeChatId) || null,
    [chats, activeChatId]
  );

  const refreshChats = useCallback(async () => {
    const list = await window.cowork.db.listChats();
    setChats(list);
    return list;
  }, []);

  // mode is 'chat' (pure conversation, no tools) or 'cowork' (agentic).
  // No folder dialog at creation — folders are optional and added explicitly
  // from the chat itself, just like a fresh Claude conversation.
  // `seed` lets callers prefill fields (e.g. resuming from CLI history sets
  // claudeSessionId + a title). When `seed.model` isn't provided we seed the
  // new chat with the user's app-wide default model from prefs so the
  // composer's picker reflects the right choice from the start.
  const handleNewChat = useCallback(async (mode = 'cowork', seed = {}) => {
    const normMode = mode === 'chat' ? 'chat' : 'cowork';
    let seededModel = seed.model ?? null;
    if (seededModel == null) {
      try {
        const p = await window.cowork?.prefs?.get?.();
        if (p?.defaultModel) seededModel = p.defaultModel;
      } catch { /* prefs optional */ }
    }
    const chat = await window.cowork.db.createChat({
      title: seed.title || (normMode === 'chat' ? 'New chat' : 'New cowork'),
      mode: normMode,
      model: seededModel,
      sandboxPath: seed.sandboxPath ?? null,
      sandboxPaths: seed.sandboxPaths ?? [],
      claudeSessionId: seed.claudeSessionId ?? null,
    });
    await refreshChats();
    setActiveChatId(chat.id);
  }, [refreshChats]);

  // Update the per-chat model. Persists to DB and refreshes local state.
  const handleModelChange = useCallback(async (chatId, model) => {
    const updated = await window.cowork.db.updateChat(chatId, { model: model || null });
    setChats((cs) => cs.map((c) => c.id === chatId ? updated : c));
  }, []);

  // Open the OS folder picker (multi-select where the platform allows it) and
  // append whatever the user picked to the chat. The first folder added becomes
  // the primary cwd if none is set; the rest are tracked as --add-dir extras.
  // Re-picking is always allowed; users can attach 0, 1, or many.
  const handleAddFolders = useCallback(async (chat) => {
    if (!chat) return;
    const picked = await (window.cowork.pickFolders?.() || window.cowork.pickFolder().then((p) => p ? [p] : []));
    if (!picked || picked.length === 0) return;
    const dedupe = (arr) => Array.from(new Set(arr.filter(Boolean)));
    let primary = chat.sandboxPath;
    let extras = Array.isArray(chat.sandboxPaths) ? chat.sandboxPaths.slice() : [];
    const incoming = picked.slice();
    if (!primary) primary = incoming.shift();
    extras = dedupe([...extras, ...incoming]).filter((p) => p !== primary);
    // Tear down any live session so the next send picks up the new folder set.
    if (chat.apiSessionId && backendUrl) {
      try { await fetch(`${backendUrl}/sessions/${chat.apiSessionId}`, { method: 'DELETE' }); } catch {}
    }
    const updated = await window.cowork.db.updateChat(chat.id, {
      sandboxPath: primary,
      sandboxPaths: extras,
      apiSessionId: null,
    });
    setChats((cs) => cs.map((c) => c.id === chat.id ? updated : c));
  }, [backendUrl]);

  // Remove one folder. If it was the primary cwd, the first extra is promoted;
  // if the chat ends up with nothing, we go back to ephemeral.
  const handleRemoveFolder = useCallback(async (chat, folder) => {
    if (!chat || !folder) return;
    let primary = chat.sandboxPath;
    let extras = (chat.sandboxPaths || []).filter((p) => p !== folder);
    if (primary === folder) primary = extras.shift() || null;
    if (chat.apiSessionId && backendUrl) {
      try { await fetch(`${backendUrl}/sessions/${chat.apiSessionId}`, { method: 'DELETE' }); } catch {}
    }
    const updated = await window.cowork.db.updateChat(chat.id, {
      sandboxPath: primary,
      sandboxPaths: extras,
      apiSessionId: null,
    });
    setChats((cs) => cs.map((c) => c.id === chat.id ? updated : c));
  }, [backendUrl]);

  const handleDeleteChat = useCallback(async (id) => {
    const chat = chats.find((c) => c.id === id);
    if (chat?.apiSessionId && backendUrl) {
      try {
        await fetch(`${backendUrl}/sessions/${chat.apiSessionId}`, { method: 'DELETE' });
      } catch { /* backend might already have GC'd it */ }
    }
    await window.cowork.db.deleteChat(id);
    const remaining = await refreshChats();
    if (activeChatId === id) setActiveChatId(remaining[0]?.id ?? null);
  }, [chats, activeChatId, backendUrl, refreshChats]);

  // Ensure the current chat has a live backend session; create one if not.
  // chat.sandboxPath is only set when the user explicitly picked a working
  // folder. When unset, the backend spins up an ephemeral sandbox.
  const ensureApiSession = useCallback(async (chat) => {
    if (chat.apiSessionId) {
      // Verify the backend still knows about it (it may have GC'd after TTL).
      try {
        const r = await fetch(`${backendUrl}/sessions/${chat.apiSessionId}`);
        if (r.ok) return chat;
      } catch { /* fall through */ }
    }
    const mode = chat.mode === 'chat' ? 'chat' : 'cowork';
    // Chat mode never takes a cwd — the backend gives it an ephemeral one it
    // never touches. Cowork mode passes the user-picked folder if any, plus
    // any additional folders as --add-dir extras.
    const opts = { mode };
    if (mode === 'cowork' && chat.sandboxPath) opts.cwd = chat.sandboxPath;
    if (mode === 'cowork' && Array.isArray(chat.sandboxPaths) && chat.sandboxPaths.length) {
      opts.addDirs = chat.sandboxPaths;
    }
    if (chat.model) opts.model = chat.model;
    if (chat.claudeSessionId) opts.claudeSessionId = chat.claudeSessionId;
    // Stable key: tells the backend to keep using the same ephemeral cwd for
    // this chat across restarts. Without this, the CLI's `--resume` lookup
    // breaks because it's keyed by cwd and the backend would otherwise mint a
    // new random cwd every time the session registry was lost.
    opts.clientRef = chat.id;

    // Fold in app-wide Claude Code defaults for cowork sessions. Chat mode
    // hard-locks the tool surface already, so permission-mode / tool lists
    // are irrelevant there. Model default is applied only if the chat row
    // itself has no model (defensive — handleNewChat also seeds from prefs).
    if (mode === 'cowork') {
      try {
        const prefs = await window.cowork?.prefs?.get?.();
        if (prefs) {
          if (!opts.model && prefs.defaultModel) opts.model = prefs.defaultModel;
          if (prefs.defaultPermissionMode) opts.permissionMode = prefs.defaultPermissionMode;
          if (prefs.defaultAllowedTools) opts.allowedTools = prefs.defaultAllowedTools;
          if (prefs.defaultDisallowedTools) opts.disallowedTools = prefs.defaultDisallowedTools;
          // Security posture: docker wraps the spawn in a container,
          // jailbroken strips the tool guardrails. Default leaves current
          // behaviour unchanged.
          if (prefs.shellMode && prefs.shellMode !== 'default') {
            opts.shellMode = prefs.shellMode;
          }
          if (prefs.shellMode === 'docker' && prefs.dockerImage) {
            opts.dockerImage = prefs.dockerImage;
          }
        }
      } catch { /* prefs optional */ }
    }

    const s = await createApiSession(opts);
    // Only persist sandboxPath if it was user-picked (server reports managed).
    // Managed sandboxes are ephemeral and shouldn't pollute the chat row.
    const patch = { apiSessionId: s.id };
    if (!s.managed) patch.sandboxPath = s.cwd;
    const updated = await window.cowork.db.updateChat(chat.id, patch);
    setChats((cs) => cs.map((c) => c.id === chat.id ? updated : c));
    return updated;
  }, [backendUrl]);

  // Owns the whole turn lifecycle: persist user message, open the SSE stream,
  // accumulate the assistant draft in `liveByChat[chat.id]`, and on stream
  // close persist the final assistant message and title-from-prompt.
  //
  // State lives here (not in ChatView) so switching chats mid-turn doesn't
  // throw away the draft. The user message is persisted to the DB up front
  // rather than only-after-the-turn — that way if the user switches away and
  // back, their own input is still visible even before the assistant replies.
  const handleSend = useCallback(async ({ chat, prompt, userDisplay }) => {
    if (!chat) return;
    const chatId = chat.id;
    // Prevent two concurrent turns on the same chat — the backend would
    // handle it (each turn is its own POST), but the UI isn't set up to show
    // two drafts at once.
    if (streamAbortersRef.current.has(chatId)) return;

    const updated = await ensureApiSession(chat);
    const apiSessionId = updated?.apiSessionId;
    if (!apiSessionId) return;

    // Persist the user message immediately so it survives any remount /
    // navigation away from this chat.
    const userContent = userDisplay || prompt;
    await window.cowork.db.appendMessage(chatId, { role: 'user', content: userContent });
    // If this chat is currently displayed, reload so the user sees the real
    // persisted row (with a real id) right away.
    if (activeChatIdRef.current === chatId) {
      const list = await window.cowork.db.listMessages(chatId);
      setMessages(list);
    }

    // Seed the draft under this chat.
    const draft = {
      id: 'tmp-a-' + Date.now(),
      chatId,
      role: 'assistant',
      content: '',
      events: [],
      files: [],
      createdAt: Date.now(),
    };
    setLiveByChat((m) => ({ ...m, [chatId]: draft }));
    setLiveFilesByChat((m) => ({ ...m, [chatId]: [] }));
    setStreamingIds((s) => { const n = new Set(s); n.add(chatId); return n; });

    const controller = new AbortController();
    streamAbortersRef.current.set(chatId, controller);

    let accText = '';
    const accEvents = [];
    const accFiles = [];

    try {
      const result = await streamChat({
        apiSessionId,
        prompt,
        model: chat.model || null,
        signal: controller.signal,
        onEvent: (evt) => {
          accEvents.push(evt);
          if (evt.event === 'assistant_text') {
            accText += evt.data?.text ?? '';
          } else if (evt.event === 'file_event') {
            const d = evt.data || {};
            if (d.kind === 'deleted') {
              const i = accFiles.findIndex((f) => f.path === d.path);
              if (i >= 0) accFiles.splice(i, 1);
            } else {
              const i = accFiles.findIndex((f) => f.path === d.path);
              const entry = { path: d.path, url: d.url, kind: d.kind, at: Date.now() };
              if (i >= 0) accFiles[i] = entry; else accFiles.push(entry);
            }
            setLiveFilesByChat((m) => ({ ...m, [chatId]: accFiles.slice() }));
          }
          setLiveByChat((m) => ({
            ...m,
            [chatId]: { ...draft, content: accText, events: accEvents.slice(), files: accFiles.slice() },
          }));
        },
      });

      // Persist the assistant message and any session-id update from the CLI.
      await window.cowork.db.appendMessage(chatId, {
        role: 'assistant',
        content: result.text,
        events: result.events,
        files: result.files,
      });
      if (result.claudeSessionId) {
        await window.cowork.db.updateChat(chatId, {
          claudeSessionId: result.claudeSessionId,
        });
      }
      // Title-from-prompt if the chat still has the default.
      const cur = await window.cowork.db.getChat(chatId);
      const defaultTitles = new Set(['New chat', 'New cowork']);
      if (cur && defaultTitles.has(cur.title) && userContent.trim()) {
        const title = userContent.trim().slice(0, 48).replace(/\s+/g, ' ');
        await window.cowork.db.updateChat(chatId, { title });
      }
      await refreshChats();
      // If the user is still looking at this chat, refresh messages so they
      // see the persisted assistant row (with a real id).
      if (activeChatIdRef.current === chatId) {
        const list = await window.cowork.db.listMessages(chatId);
        setMessages(list);
      }
    } finally {
      // Clear the per-chat stream state regardless of success/abort/error.
      streamAbortersRef.current.delete(chatId);
      setLiveByChat((m) => { const n = { ...m }; delete n[chatId]; return n; });
      setLiveFilesByChat((m) => { const n = { ...m }; delete n[chatId]; return n; });
      setStreamingIds((s) => { const n = new Set(s); n.delete(chatId); return n; });
    }
  }, [ensureApiSession, refreshChats]);

  // Stop the in-flight turn for a specific chat (the composer's stop button).
  const handleStop = useCallback((chatId) => {
    const c = streamAbortersRef.current.get(chatId);
    if (c) c.abort();
  }, []);

  if (backendError) {
    return (
      <div className="h-full w-full flex items-center justify-center p-8 text-center">
        <div>
          <div className="text-lg text-accent-500 mb-2">Backend error</div>
          <div className="text-ink-300 text-sm whitespace-pre-wrap">{backendError}</div>
        </div>
      </div>
    );
  }

  const cliBinMissing = cliEnv && cliEnv.binExists === false;
  const cliNotSignedIn = cliEnv?.login?.status === 'logged_out';
  const showCliBanner = !cliBannerDismissed && (cliBinMissing || cliNotSignedIn);

  return (
    <div className="h-full w-full flex flex-col">
      {showCliBanner && (
        <div className="shrink-0 border-b border-accent-500/40 bg-accent-500/10 text-accent-500 px-4 py-2 text-xs flex items-center gap-3">
          <span className="text-base leading-none">⚡</span>
          <div className="flex-1 min-w-0">
            {cliBinMissing ? (
              <>
                <span className="font-medium">Claude CLI isn&rsquo;t installed.</span>{' '}
                <span className="opacity-90 text-ink-200">
                  Cowork needs the local <code className="font-mono">claude</code> binary to talk to Claude. Install it now to get started.
                </span>
              </>
            ) : (
              <>
                <span className="font-medium">You&rsquo;re not signed in to the Claude CLI.</span>{' '}
                <span className="opacity-90 text-ink-200">
                  Sign in once so Cowork can send messages on your behalf.
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              // Both flows have dedicated explainer modals now.
              if (cliBinMissing) setInstallOpen(true);
              else setSignInOpen(true);
            }}
            className="text-[11px] font-medium px-2.5 py-1 rounded bg-accent-500 text-ink-950 hover:bg-accent-400"
          >
            {cliBinMissing ? 'Install' : 'Sign in'}
          </button>
          <button
            type="button"
            onClick={() => setCliBannerDismissed(true)}
            className="text-ink-300 hover:text-ink-100 text-base leading-none px-1"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <Sidebar
          chats={chats}
          activeChatId={activeChatId}
          onSelect={setActiveChatId}
          onNew={handleNewChat}
          onDelete={handleDeleteChat}
          onOpenSettings={() => setSettingsOpen(true)}
          account={account}
        />
        <ChatView
          key={activeChatId || 'empty'}
          chat={activeChat}
          messages={messages}
          liveMessage={activeChatId ? (liveByChat[activeChatId] || null) : null}
          isStreaming={activeChatId ? streamingIds.has(activeChatId) : false}
          onSubmit={handleSend}
          onStop={() => activeChatId && handleStop(activeChatId)}
          onEnsureApiSession={ensureApiSession}
          onModelChange={(model) => activeChatId && handleModelChange(activeChatId, model)}
          onAddFolders={handleAddFolders}
          onRemoveFolder={handleRemoveFolder}
          backendReady={!!backendUrl}
        />
        {activeChat?.mode !== 'chat' && (
          <FilesPanel
            chat={activeChat}
            messages={messages}
            liveFiles={activeChatId ? (liveFilesByChat[activeChatId] || []) : []}
          />
        )}
      </div>
      <StatusBar backendUrl={backendUrl} graphOk={graphOk} chat={activeChat} />
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onRequestSignIn={() => {
            // Close Settings first so the explainer isn't stacked on top of
            // another modal — user sees a clean single-modal flow.
            setSettingsOpen(false);
            setSignInOpen(true);
          }}
        />
      )}
      {disclaimerOk === false && (
        <DisclaimerModal onAcknowledge={() => setDisclaimerOk(true)} />
      )}
      {signInOpen && (
        <SignInModal onClose={() => setSignInOpen(false)} />
      )}
      {installOpen && (
        <InstallModal
          onClose={() => setInstallOpen(false)}
          onInstalled={(result) => {
            // Fold the fresh /info payload into state immediately so the sign-in
            // effect has current data (the 20s poll is too slow for a good
            // hand-off). Then close Install, open Sign-in.
            if (result?.info) setCliEnv(result.info);
            setInstallOpen(false);
            // If the installer's post-run /info says already signed in, skip
            // straight past the sign-in modal — rare but possible if the user
            // had credentials from a previous install.
            const alreadySignedIn = result?.info?.login?.status === 'logged_in';
            if (!alreadySignedIn) {
              setSignInAutoOpened(true); // claim the auto-open slot
              setSignInOpen(true);
            }
          }}
        />
      )}
    </div>
  );
}
