// Bubblewrap-based sandbox for the default shellMode.
//
// Problem: the `claude` CLI's Bash tool can execute arbitrary shell commands.
// In "default" shellMode the CLI's permission prompts are the only gate
// between Claude and the user's $HOME. A rogue prompt, a compromised tool
// call, or a mis-click can lose data. Docker mode solves this but requires
// the daemon running; Jailbroken explicitly disables guardrails. We need a
// sandbox that works out of the box on Linux without Docker.
//
// Solution: bubblewrap (`bwrap`). Unprivileged sandbox via user namespaces,
// shipped with Flatpak runtimes and packaged on every major distro. We wrap
// the `claude` spawn in a bwrap invocation that:
//   - Hides $HOME behind a tmpfs so random dotfiles aren't readable.
//   - Bind-mounts ~/.claude (credentials + session history) read-write so
//     auth and --resume keep working.
//   - Bind-mounts the user-attached cwd and addDirs read-write so Claude
//     can actually do the work it was asked to do.
//   - Bind-mounts the `claude` binary's dir read-only (PATH resolution).
//   - Read-only binds /usr /bin /sbin /lib* /etc /opt /nix for libs and
//     subtool binaries (node, python, git, etc.).
//   - tmpfs for /tmp /run /var/tmp for ephemeral writes.
//   - Unshares PID/IPC/UTS; tries user namespace (falls back gracefully on
//     hardened kernels that restrict user NS creation).
//   - Leaves the network namespace alone — the CLI must reach the API.
//
// Fail-closed on Linux: if bwrap isn't on PATH, `wrapWithSandbox()` throws
// with per-distro install instructions. The backend caller surfaces this as
// an SSE error; there is NO silent fallback to host execution in default
// mode on Linux.
//
// Non-Linux platforms (macOS, Windows): sandboxing isn't implemented here
// yet. `detectSandbox()` reports the reason so the UI can warn, but
// `wrapWithSandbox()` returns null so the caller falls back to host spawn —
// matching today's behaviour on those platforms. Users on macOS/Windows
// should prefer Docker mode if they want real isolation.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Find an executable on $PATH without invoking a shell. Returns the full
// path to the first hit, or null.
function onPath(prog) {
  const p = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of p.split(sep)) {
    if (!dir) continue;
    const full = path.join(dir, prog);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch { /* keep searching */ }
  }
  return null;
}

function bwrapVersion(binPath) {
  try {
    const out = execFileSync(binPath, ['--version'], {
      timeout: 2000,
      encoding: 'utf8',
    });
    const m = out.match(/bubblewrap\s+([0-9.]+)/i);
    return m ? m[1] : out.trim().split('\n')[0];
  } catch {
    return null;
  }
}

// Distro-agnostic: we expose the install command for every major family and
// let the user pick the one that matches their box. Having them all listed
// in the error message is cheap and spares users a web search.
const INSTALL_HINTS = {
  'Debian / Ubuntu / Mint': 'sudo apt install bubblewrap',
  'Fedora / RHEL / CentOS': 'sudo dnf install bubblewrap',
  'Arch / Manjaro':          'sudo pacman -S bubblewrap',
  'openSUSE':                'sudo zypper install bubblewrap',
  'Gentoo':                  'sudo emerge --ask sys-apps/bubblewrap',
  'Alpine':                  'sudo apk add bubblewrap',
  'Void':                    'sudo xbps-install -S bubblewrap',
};

// Describe the current sandbox situation. The backend exposes this over
// /sandbox-status so the Settings UI can show a live status pill.
function detectSandbox() {
  if (process.platform !== 'linux') {
    return {
      available: false,
      platform: process.platform,
      tool: null,
      reason:
        `Sandboxing is only implemented on Linux in this build. ` +
        `On ${process.platform}, Default mode runs on the host. ` +
        `Use Docker mode for isolation.`,
    };
  }
  const bin = onPath('bwrap');
  if (!bin) {
    return {
      available: false,
      platform: 'linux',
      tool: 'bwrap',
      reason: 'bubblewrap (bwrap) is not installed or not on PATH.',
      installHints: INSTALL_HINTS,
    };
  }
  return {
    available: true,
    platform: 'linux',
    tool: 'bwrap',
    path: bin,
    version: bwrapVersion(bin),
  };
}

// Build a human-readable error message for the fail-closed case. Kept here
// (not at call site) so the format stays consistent between the spawn error
// path and any UI status surface that wants to render it.
function sandboxUnavailableMessage(info) {
  const lines = [
    'Default (Sandboxed) mode cannot start: ' + (info.reason || 'sandbox unavailable') + '.',
  ];
  if (info.installHints) {
    lines.push('');
    lines.push('Install bubblewrap for your distribution:');
    for (const [family, cmd] of Object.entries(info.installHints)) {
      lines.push(`  ${family.padEnd(26)} ${cmd}`);
    }
  }
  lines.push('');
  lines.push('Alternatively, switch Execution mode in Settings:');
  lines.push('  • Docker     — real container isolation (requires Docker daemon running).');
  lines.push('  • Jailbroken — no sandbox; Claude has full host access. Use at your own risk.');
  return lines.join('\n');
}

// Wrap a planned `claude` spawn in a sandbox. Returns `{ cmd, args }` ready
// for child_process.spawn, or null if this platform doesn't sandbox (caller
// falls back to host spawn). Throws with a helpful message if the platform
// DOES sandbox but the tool is missing.
//
// `claudeBin` is the absolute path to the CLI executable.
// `claudeArgs` is the argv we would have passed to claude directly.
// `opts.cwd`     — user-picked working directory (may be null).
// `opts.addDirs` — extra directories the user attached via --add-dir.
function wrapWithSandbox(claudeBin, claudeArgs, opts = {}) {
  const info = detectSandbox();

  // Non-Linux: no sandbox implementation yet. Caller spawns on the host as
  // before. The UI can render a "not sandboxed on this OS" notice based on
  // detectSandbox() so the user knows the risk.
  if (!info.available && info.platform !== 'linux') {
    return null;
  }

  // Linux without bwrap: fail-closed. Default mode's whole promise is that
  // it's safe; degrading silently to host execution breaks that.
  if (!info.available) {
    const err = new Error(sandboxUnavailableMessage(info));
    err.code = 'SANDBOX_UNAVAILABLE';
    throw err;
  }

  const home = process.env.HOME || '';
  const claudeHome = home ? path.join(home, '.claude') : null;
  const binDir = path.dirname(claudeBin);
  const cwd = opts.cwd || null;
  const addDirs = Array.isArray(opts.addDirs) ? opts.addDirs : [];

  // Resolve the symlink chain of the claude binary. The current CLI installer
  // (claude.ai/install.sh) on Debian/Ubuntu/Fedora/Arch ships the binary as:
  //
  //   ~/.local/bin/claude  →  ~/.local/share/claude/versions/<version>
  //
  // We already expose binDir (~/.local/bin) below, but the SYMLINK TARGET
  // lives elsewhere under $HOME — which our --tmpfs HOME step hides. Without
  // resolving this, bwrap's execvp dies with:
  //   bwrap: execvp /home/$USER/.local/bin/claude: No such file or directory
  // even though the symlink itself is present in the sandbox. We capture the
  // realpath here so we can bind-mount the target directory too.
  let claudeRealBin = claudeBin;
  try {
    claudeRealBin = fs.realpathSync(claudeBin);
  } catch {
    // realpath can fail if the symlink is dangling on the host — leave
    // claudeRealBin === claudeBin and let the spawn fail with its own error.
  }
  const realBinDir = path.dirname(claudeRealBin);

  // Build the bwrap argv. Order matters: later binds overlay earlier ones,
  // which is how we hide $HOME and then re-expose specific subdirs on top.
  const args = [
    // Lifecycle: die when the backend exits; new session so Ctrl-C in the
    // parent doesn't propagate through ptty groups.
    '--die-with-parent',
    '--new-session',

    // Namespaces. --unshare-user-try degrades gracefully on kernels that
    // restrict unprivileged user-NS creation (e.g. some hardened distros
    // flip kernel.unprivileged_userns_clone=0). We still get PID/IPC/UTS.
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--unshare-user-try',
    // Network: deliberately NOT unshared. The CLI needs to reach the
    // Anthropic API and any tool that does WebFetch/WebSearch.

    // Minimal procfs/devfs. bwrap's --dev gives us a stub /dev/null /dev/tty
    // /dev/random etc. without exposing host devices.
    '--proc', '/proc',
    '--dev',  '/dev',

    // System dirs read-only so subtool binaries and shared libs resolve.
    // Use -try variants for paths that may be absent on some distros (e.g.
    // NixOS has no /usr/bin; Alpine may skip /lib64; Gentoo lacks /lib32 on
    // single-ABI profiles).
    '--ro-bind',     '/usr',     '/usr',
    '--ro-bind-try', '/bin',     '/bin',
    '--ro-bind-try', '/sbin',    '/sbin',
    '--ro-bind-try', '/lib',     '/lib',
    '--ro-bind-try', '/lib32',   '/lib32',
    '--ro-bind-try', '/lib64',   '/lib64',
    '--ro-bind-try', '/libx32',  '/libx32',
    '--ro-bind-try', '/etc',     '/etc',
    '--ro-bind-try', '/opt',     '/opt',
    // NixOS / Nix-on-other-distros: binaries and libs live here.
    '--ro-bind-try', '/nix',     '/nix',

    // Writable tmpfs for ephemeral state. Node and many CLIs expect these.
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--tmpfs', '/var/tmp',
  ];

  // Hide the rest of $HOME behind a tmpfs, then selectively re-expose the
  // directories Claude actually needs. Dotfiles (.ssh, .gnupg, .aws, browser
  // profiles, …) disappear from the sandbox's view.
  if (home) {
    args.push('--tmpfs', home);
  }

  // Credentials + session history. Must be rw so OAuth refresh and
  // projects/*.jsonl writes keep working.
  if (claudeHome) {
    args.push('--bind-try', claudeHome, claudeHome);
  }

  // The claude binary's directory, read-only. Covers installs under
  // ~/.local/bin, /usr/local/bin, /opt/claude/bin, /nix/store/..., etc.
  // Some of these already fall under /usr or /opt (which we ro-bound above)
  // but binding the exact dir is harmless and covers home-relative installs.
  args.push('--ro-bind', binDir, binDir);

  // If claudeBin is a symlink whose target lives outside binDir, expose the
  // target's directory too. The canonical case is the claude.ai installer on
  // Debian/Ubuntu/Fedora/Arch, which plants:
  //   ~/.local/bin/claude  →  ~/.local/share/claude/versions/<ver>
  // Our --tmpfs HOME hides ~/.local/share entirely, so the symlink resolves
  // to nothing inside the sandbox. Re-binding the real dir fixes execvp
  // without re-exposing the rest of ~/.local.
  if (realBinDir !== binDir) {
    args.push('--ro-bind-try', realBinDir, realBinDir);
  }

  // User-attached working folders, read-write. The cwd and each addDir get
  // their own bind — if they live under $HOME they override the tmpfs; if
  // they live elsewhere (/mnt/work, /srv/...) they're added on top of the
  // empty root. Deduped so we don't bind the same path twice.
  const exposed = new Set();
  if (cwd) exposed.add(cwd);
  for (const d of addDirs) if (d) exposed.add(d);
  for (const p of exposed) {
    args.push('--bind-try', p, p);
  }

  // Environment. bwrap clears the child's env unless we pass it through,
  // so whitelist what the CLI and its subtools need. Passing the full
  // process.env would defeat part of the isolation (API keys for unrelated
  // services etc.) so we're deliberate.
  args.push('--setenv', 'HOME', home || '/tmp');
  args.push('--setenv', 'PATH', `${binDir}:/usr/local/bin:/usr/bin:/bin`);
  args.push('--setenv', 'TERM', 'dumb');
  args.push('--setenv', 'NO_COLOR', '1');
  args.push('--setenv', 'FORCE_COLOR', '0');
  args.push('--setenv', 'PYTHONUNBUFFERED', '1');
  args.push('--setenv', 'NODE_DISABLE_COLORS', '1');
  // TLS trust store — the exact var depends on which lib the subtool uses,
  // so we set the common ones.
  args.push('--setenv', 'SSL_CERT_DIR', '/etc/ssl/certs');
  args.push('--setenv', 'SSL_CERT_FILE', '/etc/ssl/certs/ca-certificates.crt');
  // Locale — inherit if set, otherwise default to C.UTF-8 so subtools don't
  // trip over missing locale data.
  const lang = process.env.LANG || 'C.UTF-8';
  args.push('--setenv', 'LANG', lang);
  if (process.env.LC_ALL) args.push('--setenv', 'LC_ALL', process.env.LC_ALL);

  // Working directory inside the sandbox.
  if (cwd) args.push('--chdir', cwd);

  // End of bwrap args; what follows is the command to run inside.
  args.push('--');
  args.push(claudeBin, ...claudeArgs);

  return { cmd: info.path, args };
}

module.exports = { detectSandbox, wrapWithSandbox, sandboxUnavailableMessage };
