# Compliance & Transparency Notice

**Build:** Claude Desktop replica (unofficial community build)
**Status:** Alpha / beta — testing software, expect breakage

This document exists so that anyone running, forking, or auditing this project
can see exactly what relationship (if any) it has to Anthropic, what it does
and does not do with your data, and what responsibilities fall on you as the
person running it. If you believe any of the claims below are inaccurate, open
an issue.

## 1. No affiliation with Anthropic

This project is an independent, community-built desktop front-end that drives
the official `claude` command-line interface. The developer of this replica:

- is **not** employed by, contracted to, or otherwise affiliated with Anthropic,
- **did not** request or receive permission from Anthropic or the Claude team
  to build a replica of the Claude desktop experience,
- **does not** speak for Anthropic, and nothing in this app should be taken
  as an official Anthropic product, statement, or endorsement.

"Claude", "Anthropic", and related marks are trademarks of Anthropic, PBC.
They appear in this project solely to describe what the app interoperates
with — this is nominative, descriptive use only.

If you are from Anthropic's legal or brand team and would like changes to the
name, visuals, or framing of this project, please open an issue and the
developer will respond in good faith.

## 2. The app itself runs offline

The app binary — the Electron shell, the renderer, the local HTTP loopback
backend — does not, on its own, send your prompts, files, settings, or
account data anywhere on the public internet.

All outbound network traffic you may observe originates from one of:

- the official `claude` CLI talking to Anthropic's API under **your own**
  account and credentials,
- tools that the agent invokes at your request (e.g. `WebSearch`, `WebFetch`,
  `Bash` commands that hit a network), or
- the optional installer flow, which downloads the official `claude` CLI
  from its canonical upstream location.

No telemetry, analytics, or crash reporting is wired into this app. If you
see network traffic you cannot attribute to the above, treat it as a bug and
report it.

## 3. Authentication is delegated to the official CLI

Login, session refresh, and credential storage are handled end-to-end by the
official `claude` binary installed on your machine. Specifically:

- This app **never** prompts you for your Anthropic password, API key, or
  OAuth token directly.
- When a sign-in is required, the app opens a real terminal window running
  `claude` and the CLI performs the interactive OAuth flow on its own.
- Credentials live wherever the CLI stores them (typically under
  `~/.claude/`). This app reads account *status* (email, plan, logged-in
  boolean) by running `claude auth status --json` — it does not read or
  copy the credential material itself.
- Uninstalling this app does not log you out of the CLI, and vice versa.

## 4. You are responsible for your own environment

This is an alpha developer tool, not a polished consumer app. Running it
requires a working local toolchain. In particular, you are responsible for:

- installing Node.js and whatever Electron prerequisites your OS needs,
- installing the official `claude` CLI and keeping it up to date,
- the behavior of any shell commands or tools the agent runs on your
  machine — especially in **Docker shell** or **Jailbroken** mode,
- reviewing and understanding the permission model before approving tool
  calls.

The developer cannot provide support for environment setup, Electron build
errors, operating-system-specific issues, or anything downstream of the
official CLI. Debugging those is on you.

## 5. Alpha / beta software

Everything in this repository should be treated as pre-release:

- Expect bugs, rough edges, UI jitter, and occasional data loss.
- Chat history is stored in a local SQLite file and is not backed up.
- Breaking changes can land at any time with no migration path.
- The "Jailbroken" shell mode deliberately removes safety guardrails and
  permission prompts. Use it only on throw-away sandboxes or VMs.
- The Docker shell mode is best-effort containment; it is not a hardened
  sandbox and should not be treated as a security boundary against
  motivated attackers.

Do not use this app for anything you cannot afford to lose, and always
review what an agent is about to do before you approve it.

## 6. Reporting issues

Open an issue on the project repository. For anything you believe rises to
a legal, trademark, or privacy concern, please mark the issue accordingly
and the developer will prioritize it.
