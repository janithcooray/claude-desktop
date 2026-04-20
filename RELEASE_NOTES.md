# Release Notes

## v0.1.0-alpha — First public alpha

The first tagged build of the community Claude Desktop shell. Everything
below is what's in this build; expect rough edges and breaking changes
between alphas.

> **Not affiliated with Anthropic.** This app drives the official `claude`
> CLI in a subprocess, so billing, rate limits, and account behaviour are
> whatever the CLI gives you.

### Highlights

- **Full chat UI** — sidebar of chats, conversation view, file panel,
  composer with drag-and-drop uploads.
- **Two chat modes:**
  - **Chat** — pure conversation, no tools.
  - **Cowork** — agentic; attach one or more folders and Claude can read,
    edit, and run code inside them.
- **Sandboxed by default on Linux** via bubblewrap. The rest of `$HOME` is
  hidden; only the folders you attach + `~/.claude` for credentials are
  visible to Claude.
- **Guided first-launch** — installs the `claude` CLI for you if missing,
  walks you through OAuth sign-in without leaving the app.
- **Local persistence** — SQLite-backed chat history and per-chat
  sandboxes under the OS user-data dir.

### What's new

#### Onboarding

- **In-app installer** — on first launch, if `claude` isn't on PATH, a
  modal offers to install it via the official one-liner. Streamed log,
  inline retry, no terminal window pops open.
- **Sign-in explainer** — a 4-step modal explains the OAuth flow and
  launches `claude auth login` in a real terminal. Routes every sign-in
  entry point (startup auto-prompt + Settings) through the same flow.
- **Distro-agnostic terminal picker** — tries `x-terminal-emulator`,
  `gnome-terminal`, `konsole`, `alacritty`, `kitty`, `xfce4-terminal`, and
  `xterm` in order. Works out of the box on Gentoo, Arch, Fedora,
  Debian/Ubuntu, and anything Flatpak-flavoured.

#### Security & execution modes

- **Three Execution modes**, selectable in Settings → Security:
  - **Default (Sandboxed)** — bubblewrap sandbox. Fail-closed on Linux
    (refuses to start if `bwrap` isn't installed) with per-distro install
    commands in the error message. Covers Debian/Ubuntu/Mint, Fedora/RHEL,
    Arch/Manjaro, openSUSE, Gentoo, Alpine, and Void.
  - **Docker shell** — `docker run`s the configured image with working
    folders and `~/.claude` bind-mounted.
  - **Jailbroken** — unrestricted host access. Guarded by an explicit
    confirmation step.
- **Live sandbox status pill** in Settings shows `bwrap` presence + version.
- **Network is intentionally not unshared** — Claude needs API access
  and `WebFetch` / `WebSearch` should keep working.

#### Chat reliability

- **Per-chat streaming state** — switching chats mid-turn no longer loses
  the draft. Lifted turn lifecycle out of `ChatView` into `App`, keyed by
  chat id.
- **Stable per-chat cwd** — each chat uses a deterministic ephemeral
  directory name (`c-<chatId>`) under the sandbox root, so
  `claude --resume <id>` keeps working across app restarts.
- **Immediate user-message persistence** — your message is saved to the DB
  before the stream starts, so navigating away and back still shows it.

#### Folders

- **Multi-folder attach** — header pill bar shows attached folders;
  first = primary cwd, rest = `--add-dir` extras.
- **Add / remove without losing the chat** — removing a folder tears down
  the live session but preserves your message history.

#### UI

- **Alpha badge** in the sidebar header so nobody mistakes this for an
  official build.
- **Account badge** above Settings showing the signed-in email and plan,
  extracted from `claude auth status --json`.
- **CHAT / COWORK** mode pill in the chat header.

### Fixes

- `spawn x-terminal-emulator ENOENT` on non-Debian distros — `spawn` emits
  ENOENT asynchronously, so the old try/catch loop always "succeeded" on
  the first attempt. Now probes `$PATH` synchronously before spawning.
- Sign-in no longer dumps you into the first-run TUI (theme picker, etc.)
  — we invoke `claude auth login` directly.
- `No conversation found with session ID` on restart — fixed for all new
  chats via the stable-cwd change above.
- Empty duplicate entries in the Chats list — the "Claude CLI history"
  surface was showing every `.jsonl` under `~/.claude/projects/` including
  mid-chain continuation files. Section removed entirely.

### Known issues

- **macOS / Windows sandbox not implemented.** Default mode falls back to
  host spawn on non-Linux platforms. Prefer Docker mode there if you want
  real isolation. A warning pill in Settings flags this.
- **Existing chats from pre-alpha builds can't resume.** Chats created
  before the stable-cwd fix have a random ephemeral cwd that's gone; the
  CLI can't locate their session JSONL. Workaround: start a fresh chat.
- **No automatic recovery from unexpected CLI exits.** If `claude` crashes
  mid-turn, the stream reports the error and stops; you'll need to resend
  the prompt.
- **No tests yet.** Smoke test that launches the window, sends "hi", and
  asserts a stream arrives is high on the list.
- **Tool-call UI is minimal.** Tool uses and results render as a
  timeline block; there's no per-tool detail view or diff yet.

### Upgrading from pre-release builds

If you've been running an untagged commit before this alpha:

1. Pull and `npm install` (rebuilds `better-sqlite3`).
2. Chats you were mid-stream on will show a cancelled turn — just resend.
3. Any chat without an attached folder that relied on `--resume` across
   restarts needs to be recreated (see Known issues).

No DB migration is required; the schema didn't change.

### Platform support

| Platform        | Status     |
|-----------------|------------|
| Linux (x86_64)  | Primary — tested on Gentoo, others expected to work |
| Linux (aarch64) | Untested — should build |
| macOS           | Runs, but Default mode is unsandboxed; prefer Docker |
| Windows         | Runs, but Default mode is unsandboxed; prefer Docker |

### Requirements

- Node 20+
- Build tools (`build-essential` + `python3` on Linux, Xcode CLT on macOS,
  VS Build Tools on Windows) for the `better-sqlite3` native build.
- Bubblewrap for Default sandboxing on Linux (installer prints the
  distro-specific command if missing).

### Acknowledgements

This project wouldn't exist without the official `claude` CLI doing all
the actual hard work. Huge thanks to the team that built it.

---

**Feedback welcome.** Open an issue with your distro, Node version, and
the exact error you hit — alpha means we need your bug reports.
