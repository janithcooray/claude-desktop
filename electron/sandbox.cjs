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

// Walk the full execution chain of a binary (symlinks, one hop at a time,
// plus `#!` interpreters) and return the list of directories that must be
// bind-mounted for the kernel to successfully execvp() it inside the
// sandbox. Canonical failure modes this handles:
//
//   1. `claudeBin` is a *multi-hop* symlink, any intermediate step of which
//      lives under `$HOME` (hidden by our --tmpfs on $HOME). Real example
//      from the claude.ai installer combined with a distro-packaged shim:
//         /usr/local/bin/claude
//           → /home/$USER/.local/bin/claude
//           → /home/$USER/.local/share/claude/versions/<ver>
//      Binding only the final realpath's dir fails because the kernel
//      resolves symlinks hop-by-hop and the MIDDLE hop is ENOENT in the
//      sandbox.
//   2. `claudeBin` is a shell/node script whose shebang points at an
//      interpreter outside /usr/bin (e.g. `#!/home/$USER/.nvm/.../node`).
//   3. An intermediate directory component (e.g. /usr/local on some distros)
//      is itself a symlink to a path not otherwise exposed.
//
// Implementation: we use `lstat` + `readlink` so we can walk each symlink
// one step at a time, rather than jumping to the end with `realpath`. Every
// step's parent directory is added to the bind list, and scripts have their
// shebang interpreter queued back through the same walk.
function execChainDirs(binPath) {
  const dirs = new Set();
  const seen = new Set();
  const queue = [binPath];

  // Add JUST the immediate parent dir of a path (plus its realpath, in case
  // an intermediate component of the parent is itself a symlink — e.g. some
  // distros symlink /usr/local → elsewhere). We deliberately do NOT walk
  // ancestors up to `/`: that would pull in broad dirs like `/home/nova`,
  // which would OVERLAY the --tmpfs on $HOME and re-expose everything we
  // tried to hide.
  const addParent = (p) => {
    const d = path.dirname(p);
    if (!d || d === '/') return;
    dirs.add(d);
    try {
      const real = fs.realpathSync(d);
      if (real && real !== d) dirs.add(real);
    } catch { /* missing / unreadable — whatever, we tried */ }
  };

  while (queue.length) {
    const p = queue.shift();
    if (!p || seen.has(p)) continue;
    seen.add(p);

    addParent(p);

    // Walk the symlink chain explicitly, one hop at a time. Each hop's
    // parent dir must be bound so the kernel can resolve it inside the
    // sandbox — `realpath` alone would skip straight to the end and miss
    // any middle hop that lives under the tmpfs'd HOME. Cap at 40 to match
    // POSIX SYMLOOP_MAX and avoid pathological loops.
    let cursor = p;
    for (let i = 0; i < 40; i++) {
      let lst;
      try { lst = fs.lstatSync(cursor); } catch { break; }
      if (!lst.isSymbolicLink()) break;
      let link;
      try { link = fs.readlinkSync(cursor); } catch { break; }
      const next = path.isAbsolute(link) ? link : path.resolve(path.dirname(cursor), link);
      if (seen.has(next)) break;
      seen.add(next);
      addParent(next);
      cursor = next;
    }

    // `cursor` is now the final real file (or the last step we could stat).
    // Shebang probe: if it starts with `#!`, queue the interpreter too.
    try {
      const fd = fs.openSync(cursor, 'r');
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      fs.closeSync(fd);
      if (n >= 2 && buf[0] === 0x23 /* # */ && buf[1] === 0x21 /* ! */) {
        const firstLine = buf.slice(2, n).toString('utf8').split('\n')[0].trim();
        const interp = firstLine.split(/\s+/)[0];
        if (interp && path.isAbsolute(interp) && !seen.has(interp)) {
          queue.push(interp);
        }
      }
    } catch { /* binary / unreadable — parent bind above already covers it */ }
  }

  return Array.from(dirs);
}

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
  // Caller-provided directories that need to be visible read-only inside the
  // sandbox (e.g. the dir holding our approval MCP shim — backend.cjs binds
  // it so the CLI can spawn `node <APPROVAL_MCP_PATH>` from within bwrap).
  // Each path is bind-mounted at the same location it has on the host so
  // absolute paths in --mcp-config work without translation.
  const extraReadOnlyDirs = Array.isArray(opts.extraReadOnlyDirs)
    ? opts.extraReadOnlyDirs
    : [];

  // Resolve every directory the kernel needs to exec `claudeBin` — the
  // symlink target's dir, the shebang interpreter's dir, and any intermediate
  // component that's itself a symlink. See `execChainDirs` above for the full
  // rationale; the short version is that every observed variant of the "bwrap:
  // execvp <path>: No such file or directory" error has been a missing link
  // in that chain, and the old narrow fix (symlink target only) wasn't
  // catching the shebang / intermediate-symlink cases.
  const chainDirs = execChainDirs(claudeBin);

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

  // DNS: on modern Linux (systemd-resolved, NetworkManager, resolvconf),
  // /etc/resolv.conf is a symlink into /run — which our --tmpfs /run just
  // hid. Inside the sandbox, DNS resolution then fails, and the CLI bubbles
  // that up as "Unable to connect to API (ConnectionRefused)" because its
  // HTTPS stack can't resolve api.anthropic.com.
  //
  // Fix: resolve the symlink on the host and bind the target directory
  // read-only on top of the /run tmpfs. We deliberately do NOT also bind
  // /etc/resolv.conf directly: the `--ro-bind /etc /etc` above already
  // exposes the symlink, and adding a second bind on top of ro-bound /etc
  // trips bwrap with "Can't create file at /etc/resolv.conf: No such file
  // or directory" on distros where the symlink can't be replaced.
  try {
    const resolvTarget = fs.realpathSync('/etc/resolv.conf');
    if (resolvTarget && resolvTarget !== '/etc/resolv.conf') {
      const resolvDir = path.dirname(resolvTarget);
      args.push('--ro-bind-try', resolvDir, resolvDir);
    }
  } catch { /* no /etc/resolv.conf or dangling — let the CLI surface it */ }

  // Certificate trust stores: covered by our --ro-bind /etc bind above
  // (/etc/ssl, /etc/pki, /etc/ca-certificates/...) but some distros put the
  // actual cert blobs under /usr/share (NixOS) or /var/lib/ca-certificates
  // (openSUSE). /usr is already bound; /var/lib/ca-certificates isn't.
  args.push('--ro-bind-try', '/var/lib/ca-certificates', '/var/lib/ca-certificates');

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

  // `~/.claude.json` lives *beside* `~/.claude/`, not inside it. It stores
  // the CLI's top-level settings (theme, defaults, feature flags) and the
  // tool auto-writes it on first run. Without this bind the CLI crashes
  // inside the sandbox with "Claude configuration file not found at:
  // /home/<user>/.claude.json" because our --tmpfs HOME hid it.
  //
  // Defensive: `--bind-try` silently skips if the source is missing, and the
  // CLI would still crash because a tmpfs-write on first run evaporates when
  // the sandbox exits — so create an empty file on the host if absent, and
  // the CLI can then populate it persistently on the next write.
  if (home) {
    const claudeJson = path.join(home, '.claude.json');
    try {
      if (!fs.existsSync(claudeJson)) fs.writeFileSync(claudeJson, '{}\n', { flag: 'wx' });
    } catch { /* race / perms — fall through, worst case --bind-try skips */ }
    args.push('--bind-try', claudeJson, claudeJson);
  }

  // Bind every directory the exec chain touches. `--ro-bind-try` silently
  // skips anything already covered by an earlier bind (e.g. dirs under /usr)
  // or that doesn't exist on this host. Using -try keeps this forgiving
  // across distro layouts — NixOS stores, Homebrew cellars, Nix-on-*,
  // Gentoo stowed trees, and hermetic installers all land here.
  const chainSet = new Set(chainDirs);
  chainSet.add(binDir); // always expose the original binary's dir verbatim
  for (const d of chainSet) {
    if (!d) continue;
    args.push('--ro-bind-try', d, d);
  }

  // One-line diagnostic: which dirs did the exec-chain walk decide to bind?
  // Prints on every spawn so a user hitting "bwrap: execvp ... No such file"
  // can immediately see whether a needed hop is missing. If this line is
  // absent from stderr, the sandbox.cjs changes aren't loaded — restart the
  // Electron main process (Ctrl+C `npm run dev`, then rerun).
  process.stderr.write(
    `[sandbox] claudeBin=${JSON.stringify(claudeBin)} chainDirs=${JSON.stringify([...chainSet])}\n`,
  );

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

  // Caller-provided read-only directories. These are framework-internal —
  // currently just the dir holding electron/approval-mcp.cjs so the CLI can
  // spawn the shim — and must not overlap with user-writable paths. We
  // dedupe against the rw set so a user who happened to pick the Electron
  // resources dir as their working folder doesn't get it silently demoted.
  for (const p of extraReadOnlyDirs) {
    if (!p || exposed.has(p)) continue;
    args.push('--ro-bind-try', p, p);
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
