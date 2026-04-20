# Claude Desktop (community build)

An unofficial desktop app for Claude, built as a thin shell around the
official `claude` CLI. Chat with Claude in a proper window, attach folders
so it can read and edit your files, and keep full conversation history
locally — no browser tab, no copy-paste, no cloud sync.

> **Alpha build · community project.** Not affiliated with Anthropic.
> It drives the real `claude` CLI under the hood, so your account, billing,
> and rate limits are exactly the same as using `claude` in a terminal.

## What it gives you

- **A real chat window.** Sidebar of chats on the left, conversation in the
  middle, file previews on the right — everything you'd expect, nothing you
  wouldn't.
- **Two modes per chat:**
  - **Chat** — plain conversation with Claude. No file access, no shell.
    Good for questions, writing, brainstorming.
  - **Cowork** — agentic mode. Attach one or more folders and Claude can
    read, edit, and run code inside them.
- **Sandboxed by default on Linux.** Cowork turns run inside a bubblewrap
  sandbox that only exposes the folders you attached — the rest of your
  home directory is hidden from Claude. Docker and fully unrestricted
  ("jailbroken") modes are available in Settings for users who want them.
- **Everything local.** Chats, messages, and sandboxes live on your disk
  (SQLite + a per-chat working directory). Close the app, re-open it, your
  conversations are still there.
- **Resumable.** Each chat maps to a `claude --resume` session, so Claude
  remembers the full history of a conversation across restarts.

## Getting started

### Method 1 - Download

- Download — one direct link to (Download)[https://github.com/janithcooray/claude-desktop/releases/download/v0.1.0-alpha/Claude-Desktop-0.1.0.AppImage]
- First launch — app handles CLI install + sign-in for you
- Sandbox mode — Settings → Security

### Method 2 - Build
#### 1. Install the prerequisites

- **Node.js 20 or newer** — <https://nodejs.org>
- **Build tools** for the native SQLite module:
  - Linux: `sudo apt install build-essential python3` (or your distro's
    equivalent)
  - macOS: `xcode-select --install`
  - Windows: Visual Studio Build Tools with the "Desktop development with
    C++" workload
- **Bubblewrap** (Linux only, recommended) — enables the Default sandbox.
  See the distro-specific commands in [INFO.md](./INFO.md#prereqs). The app
  will tell you exactly which command to run if it's missing.

You do **not** need to install the `claude` CLI ahead of time — the app
will offer to install it for you on first launch.

#### 2. Install the app

```bash
git clone <this-repo> claude-desktop
cd claude-desktop
npm install
```

`npm install` also compiles `better-sqlite3` against Electron's Node ABI.
If it fails, re-run it with `--foreground-scripts` to see the native build
log.

#### 3. Run it

**Dev mode** (hot-reload, devtools open):

```bash
npm run dev
```

**Build a standalone app:**

```bash
npm run pack
# Linux: ./release/Cowork-*.AppImage
# macOS: ./release/Cowork-*.dmg
# Windows: ./release/Cowork Setup *.exe
```

### First launch

1. **Install the CLI.** If `claude` isn't on your system, a modal pops up
   offering to install it. It runs the official one-liner
   (`curl -fsSL claude.ai/install.sh | bash`) and streams the log so you
   can see what's happening. No sudo required.
2. **Sign in.** A second modal explains the OAuth flow and opens a
   terminal window running `claude auth login`. Follow the prompts; when
   you're done, close the terminal and come back to the app.
3. **Start a chat.** Click "New chat" (or "New cowork") in the left
   sidebar. In Cowork mode, click the 📁 button in the chat header to
   attach a folder.
4. **Send a message.** That's it.

### 5. Choosing a sandbox mode

The default ("Sandboxed") mode is the right choice for most people. If
you want something different, go to **Settings → Security**:

| Mode | What it does | When to use |
|------|---|---|
| **Default (sandboxed)** | Runs Claude in a bubblewrap sandbox. Only the folders you attach are visible; the rest of `$HOME` is hidden. | Default. Recommended. |
| **Docker shell** | Runs Claude inside a Docker container. Strong isolation; needs Docker running. | If you prefer container-based isolation or are on a distro where bubblewrap is awkward. |
| **Jailbroken** | No sandbox, no permission prompts, full host access. | Throwaway VMs you control. **Not recommended for your daily machine.** |

## Common issues

- **"Default mode cannot start: bubblewrap not installed"** — install
  `bwrap` using the command for your distribution (shown in the error
  dialog), or switch to Docker / Jailbroken in Settings.
- **"Failed to launch claude CLI"** — the `claude` binary isn't on your
  `$PATH`. Open Settings and use the Install button, or install it
  manually and restart the app.
- **AppImage won't launch on Wayland** — try
  `./Cowork-*.AppImage --no-sandbox` or set
  `ELECTRON_OZONE_PLATFORM_HINT=auto`.

More in [INFO.md](./INFO.md#troubleshooting).

## Learn more

- [`INFO.md`](./INFO.md) — architecture, developer docs, configuration,
  project layout, and a full troubleshooting reference.
- The official Claude Code docs — <https://docs.claude.com/en/docs/claude-code>

## License & disclaimer

This project is an unofficial community build. "Claude" is a trademark of
Anthropic. The app is provided as-is with no warranty; review
[INFO.md](./INFO.md) before using it on machines with sensitive data.
