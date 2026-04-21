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

### 1. Download

**Linux (x86_64):**

- ⬇ [Download AppImage](https://github.com/janithcooray/claude-desktop/releases/download/v0.1.0-alpha/Claude-Desktop-0.1.0.AppImage)
- 📖 [Read Me](https://github.com/janithcooray/claude-desktop#readme) — full project docs, sandbox modes, troubleshooting
- 📝 [Release notes](https://github.com/janithcooray/claude-desktop/blob/main/RELEASE_NOTES.md) — what's in v0.1.0-alpha

Double-click the AppImage to run. No install, no build tools, no terminal
required — the app will install the `claude` CLI and walk you through
sign-in on first launch.

> If double-click doesn't work, right-click the file → Properties →
> Permissions → "Allow executing file as program", then open it again.

### 2. First launch

1. **Install the CLI.** If `claude` isn't on your system, a modal offers
   to install it automatically. Streamed log, no terminal needed.
2. **Sign in.** A second modal opens a terminal running `claude auth login`.
   Follow the prompts, then come back to the app.
3. **Start a chat.** Click "New chat" or "New cowork" in the left sidebar.
   In Cowork mode, click the folder button in the header to attach a folder.
4. **Send a message.** That's it.

### 3. Choosing a sandbox mode

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
  `./Claude-Desktop-0.1.0.AppImage --no-sandbox` or set
  `ELECTRON_OZONE_PLATFORM_HINT=auto`.

More in [INFO.md](./INFO.md#troubleshooting).

## Build from source

If you want to run the dev build or package your own AppImage, see
[INFO.md](./INFO.md) — it covers prerequisites, `npm run dev`,
`npm run pack`, and the project layout.

## Learn more

- [`INFO.md`](./INFO.md) — architecture, developer docs, configuration,
  project layout, and a full troubleshooting reference.
- The official Claude Code docs — <https://docs.claude.com/en/docs/claude-code>

## License & disclaimer

This project is an unofficial community build. "Claude" is a trademark of
Anthropic. The app is provided as-is with no warranty; review
[INFO.md](./INFO.md) before using it on machines with sensitive data.
