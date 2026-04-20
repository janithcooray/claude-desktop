# cowork-desktop

A Claude-Desktop-style shell built on Electron. It drives the headless
`claude` CLI directly from the main process and gives you a chat window that
looks and feels like Cowork mode.

```
┌──────────────┬──────────────────────────────┬──────────────────┐
│  Sidebar     │   Chat                       │  Files           │
│              │                              │                  │
│  [+ New]     │   user: …                    │  report.md       │
│  Contracts   │   assistant: …               │  notes.md        │
│  PDFs notes  │   [▸ 3 tool calls]           │  ─────────────   │
│  ⋯           │                              │  [preview]       │
│              │                              │  Open · Save as  │
│              │   ┌──────────────────────┐   │                  │
│              │   │ Message Claude…  ➤   │   │                  │
│              │   └──────────────────────┘   │                  │
└──────────────┴──────────────────────────────┴──────────────────┘
  backend: http://127.0.0.1:NNNNN  |  sandbox: /…
```

## How it works

* **Electron main** starts a tiny in-process HTTP server on a free loopback
  port (see `electron/backend.cjs`), then opens the BrowserWindow. No
  subprocess — the backend is a few hundred lines of Node in the same
  process as Electron.
* **Per-turn**, the backend spawns the `claude` CLI headless
  (`claude -p … --output-format stream-json --verbose`) with its cwd set to
  the session sandbox. Stdout is parsed line-by-line and translated into SSE
  events the renderer already understands (`session`, `assistant_text`,
  `file_event`, `end`, `error`).
* **SQLite** (`better-sqlite3`) holds your chat list and message history.
  Per-chat `apiSessionId` + `claudeSessionId` persist across restarts, so
  Claude resumes the conversation via `--resume`.
* **Sandboxes** live under the OS user-data dir (e.g. `~/.config/Cowork/sandboxes/<sid>/`
  on Linux, `~/Library/Application Support/Cowork/…` on macOS). Uploaded
  files land in `<sandbox>/uploads/`; files Claude writes end up wherever it
  decides — both are visible in the right panel, thanks to a post-turn
  snapshot-diff of the sandbox.
* **Renderer** is React + Vite + Tailwind. It talks to the backend over
  plain HTTP + SSE; POST-body SSE is consumed with `fetch` + a reader
  (EventSource can't POST).
* **Tool allowlist is static** — passed to the CLI via `--allowedTools`.
  Default: `Read,Write,Edit,Bash,Glob,Grep`. Override with `ALLOWED_TOOLS`.

## Execution modes

Three security postures, selectable per install in Settings → Security:

* **Default (sandboxed)** — wraps each cowork turn in an unprivileged
  [bubblewrap](https://github.com/containers/bubblewrap) sandbox. `$HOME` is
  hidden behind a tmpfs; only `~/.claude` (credentials) and the folders the
  user attached are visible. System binaries (`/usr`, `/bin`, `/etc`, `/nix`,
  …) are bind-mounted read-only so subtools still resolve. Fail-closed: if
  `bwrap` isn't installed on Linux, Default mode refuses to start and prints
  per-distro install instructions.
* **Docker shell** — `docker run`s the configured image with the working
  folder(s) and `~/.claude` bind-mounted at identical paths. Container must
  have `claude` on `$PATH`.
* **Jailbroken** — no sandbox, no permission prompts, full host access.
  Guarded by a confirmation dialog. Use only for throwaway boxes.

See `electron/sandbox.cjs` for the bubblewrap argv construction.

## Prereqs

* Node 20+
* The `claude` CLI installed and on your `$PATH` (or set `CLAUDE_BIN`). The
  app can also install it for you on first launch via the official
  `curl -fsSL claude.ai/install.sh | bash` one-liner.
* Build deps for `better-sqlite3` native rebuild:
  * Linux: `build-essential` and `python3` (`sudo apt install build-essential python3`)
  * macOS: Xcode Command Line Tools (`xcode-select --install`)
* For Default-mode sandboxing on Linux: `bubblewrap`. Install commands by
  distro:
  * Debian/Ubuntu/Mint: `sudo apt install bubblewrap`
  * Fedora/RHEL/CentOS: `sudo dnf install bubblewrap`
  * Arch/Manjaro:       `sudo pacman -S bubblewrap`
  * openSUSE:           `sudo zypper install bubblewrap`
  * Gentoo:             `sudo emerge --ask sys-apps/bubblewrap`
  * Alpine:             `sudo apk add bubblewrap`
  * Void:               `sudo xbps-install -S bubblewrap`

## Run in dev

```bash
cd desktop
npm install     # also compiles better-sqlite3 against Electron's ABI
npm run dev     # starts Vite + Electron with HMR
```

Vite serves the renderer at http://localhost:5173 with full HMR. Electron
loads that URL and boots the backend HTTP server in-process. Dev tools open
automatically in a detached window.

Stopping with Ctrl-C kills Vite; closing the window triggers a clean
backend shutdown via `before-quit`.

## Build a Linux AppImage

```bash
cd desktop
npm run pack
# → desktop/release/Cowork-0.1.0.AppImage
chmod +x release/Cowork-*.AppImage
./release/Cowork-0.1.0.AppImage
```

`electron-builder` packages `dist/` (the built renderer) and `electron/`
(the main process + in-process backend). `better-sqlite3` is rebuilt
against Electron's embedded Node ABI by the `postinstall` hook.

> ⚠️ If you change native deps, re-run `npm install` in `desktop/`.

## Configuration

Env vars you can set before launching (or bake into a launcher script):

| Var                | Meaning                                         | Default                   |
|--------------------|-------------------------------------------------|---------------------------|
| `CLAUDE_BIN`       | Absolute path to `claude` CLI                   | PATH lookup               |
| `ALLOWED_TOOLS`    | Comma list passed to `--allowedTools`           | `Read,Write,Edit,Bash,Glob,Grep` |
| `PERMISSION_MODE`  | `--permission-mode` value                       | `acceptEdits`             |
| `UPLOAD_MAX_BYTES` | Per-file upload cap                             | 200 MB                    |

Per-user data lives at the OS user-data dir — SQLite DB and sandboxes both
go there, so uninstalling doesn't clobber your chat history.

## Troubleshooting

* **"Failed to launch claude CLI"** — the `claude` binary isn't on PATH.
  Use the in-app installer, install manually, or point `CLAUDE_BIN` at the
  absolute path.
* **"Default (Sandboxed) mode cannot start: bubblewrap not installed"** —
  install `bwrap` using the per-distro command above, or switch Execution
  mode in Settings → Security to Docker or Jailbroken.
* **"No conversation found with session ID …"** on resume — the chat was
  created before the stable-cwd fix and its old ephemeral cwd is gone.
  Start a fresh chat; existing ones with attached folders are unaffected.
* **Uploads fail with 400 "invalid filename"** — the filename contained a
  slash or `..`. The backend accepts basenames only.
* **`better-sqlite3` import error after `npm install`** — run
  `npx electron-builder install-app-deps` (also what `postinstall` does).
* **Electron fails to install at runtime** — `node_modules/electron/dist/`
  is missing, meaning the postinstall download never completed. Delete
  `node_modules/electron` and run `npm install electron --foreground-scripts`
  to see the real error.
* **AppImage won't launch on Wayland** — try
  `./Cowork-*.AppImage --no-sandbox` or set
  `ELECTRON_OZONE_PLATFORM_HINT=auto`.

## Project layout

```
desktop/
├── electron/
│   ├── main.cjs        ← app lifecycle, window, IPC
│   ├── preload.cjs     ← contextBridge → renderer
│   ├── backend.cjs     ← in-process HTTP server + claude CLI driver
│   ├── sandbox.cjs     ← bubblewrap wrapper for Default mode
│   └── db.cjs          ← better-sqlite3 schema + API
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   ├── components/
│   │   ├── Sidebar.jsx
│   │   ├── ChatView.jsx
│   │   ├── Composer.jsx      ← drag/drop, paste, upload
│   │   ├── MessageBubble.jsx
│   │   ├── EventTimeline.jsx ← tool calls & file events
│   │   ├── FilesPanel.jsx    ← right panel + previews
│   │   ├── SettingsModal.jsx ← defaults, security, account
│   │   ├── SignInModal.jsx   ← OAuth explainer + terminal launcher
│   │   ├── InstallModal.jsx  ← streamed claude-CLI installer
│   │   └── StatusBar.jsx
│   ├── hooks/
│   │   └── useStreamChat.js  ← POST-body SSE consumer
│   └── lib/
│       └── api.js
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── package.json              ← electron-builder config inline
```

## Not done yet

* Error retry / reconnect for the CLI on unexpected exit.
* Sandbox implementation on macOS / Windows (Default mode currently falls
  back to host spawn there).
* Tests. A smoke test that opens the window, creates a chat, sends "hi",
  and asserts a stream was received would pay for itself quickly.
