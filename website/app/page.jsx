// Landing page for the community Claude Desktop build for Linux.
// Single scroll, fully static. All content and links are driven from
// lib/seo.js so the SITE_URL / DOWNLOAD_URL change in one place.

import {
  DOWNLOAD_URL,
  REPO_URL,
  README_URL,
  NOTES_URL,
  APP_VERSION,
  faqJsonLd,
} from '../lib/seo.js';

// On-page FAQ. Mirrored into JSON-LD below so Google can render it as a
// rich-result block — this is specifically the content search engines
// will index for queries like "is Claude Desktop on Linux", "how to
// install Claude Desktop on Ubuntu", etc.
const FAQS = [
  {
    q: 'Is Claude Desktop available for Linux?',
    a: 'Yes — this is Claude Desktop for Linux, a community-built Electron app that wraps the official claude CLI. Download the AppImage for x86_64 and run it on Ubuntu, Debian, Fedora, Arch, Gentoo, openSUSE, Alpine, Void, or any other modern Linux distribution.',
  },
  {
    q: 'Is there a macOS or Windows version?',
    a: 'No. This build is Linux-only by design. The whole point of the project is to be a proper Linux-native desktop window for Claude, with real bubblewrap sandboxing. If you are on macOS or Windows, use the official claude CLI or Claude web app instead.',
  },
  {
    q: 'How do I install Claude Desktop on Linux?',
    a: 'Download the AppImage from the Releases page, mark it executable with chmod +x Claude-Desktop-0.1.0.AppImage, and double-click it. No package manager, no sudo, no build tools. On first launch the app will install the claude CLI for you and walk you through OAuth sign-in.',
  },
  {
    q: 'Is Claude Desktop sandboxed on Linux?',
    a: 'Yes, by default. Cowork-mode turns run inside a bubblewrap sandbox that hides $HOME and only exposes the folders you explicitly attach plus ~/.claude for credentials. Docker and fully unrestricted (“jailbroken”) modes are available in Settings → Security.',
  },
  {
    q: 'Is this the official Anthropic Claude Desktop app?',
    a: 'No. This is an unofficial community build. It is not affiliated with Anthropic. The app drives the real claude CLI, so your account, billing, and rate limits are identical to using claude in a terminal.',
  },
  {
    q: 'Which Linux distributions are supported?',
    a: 'x86_64 Linux is the primary target. Tested on Gentoo; reported to work on Ubuntu, Debian, Fedora, Arch, Manjaro, openSUSE, Alpine, and Void. aarch64 Linux should build from source but is untested in this alpha.',
  },
  {
    q: 'What is Cowork mode?',
    a: 'Cowork is the agentic mode. Attach one or more folders to a chat and Claude can read, edit, and run code inside them — while the rest of your home directory stays hidden behind the bubblewrap sandbox.',
  },
  {
    q: 'Do I need to install the claude CLI first?',
    a: 'No. If claude is not on your PATH the app will offer to install it for you on first launch via the official one-liner from claude.ai/install.sh. No terminal window pops up; the install log streams inside the app.',
  },
  {
    q: 'Where are my chats stored?',
    a: 'Locally. Chats, messages, and per-chat sandboxes live in a SQLite database under the OS user-data directory (~/.config/Cowork on Linux). Nothing is uploaded anywhere other than the API calls the claude CLI already makes.',
  },
];

// Linux distros we have install commands for. Drives the "Runs on" section
// below the hero and the platform-support block further down.
const DISTROS = [
  { name: 'Ubuntu / Debian / Mint', install: 'sudo apt install bubblewrap' },
  { name: 'Fedora / RHEL / CentOS', install: 'sudo dnf install bubblewrap' },
  { name: 'Arch / Manjaro',         install: 'sudo pacman -S bubblewrap' },
  { name: 'openSUSE',               install: 'sudo zypper install bubblewrap' },
  { name: 'Gentoo',                 install: 'sudo emerge --ask sys-apps/bubblewrap' },
  { name: 'Alpine',                 install: 'sudo apk add bubblewrap' },
  { name: 'Void',                   install: 'sudo xbps-install -S bubblewrap' },
];

export default function Page() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-carbon-900 text-white/90 scanlines">
      {/* FAQ JSON-LD — matched to the FAQ section below so Google can render
          the rich-result block for queries like "Claude Desktop Linux". */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd(FAQS)) }}
      />

      {/* --- Ambient backdrop ----------------------------------------- */}
      <div className="pointer-events-none absolute inset-0 bg-grid opacity-60" />
      <div className="pointer-events-none absolute inset-0 vignette" />
      <div
        className="pointer-events-none absolute left-1/2 top-[40%] -translate-x-1/2 -translate-y-1/2
                   h-[900px] w-[900px] rounded-full bg-ember-500/[0.08] blur-3xl"
      />

      <Header />

      {/* --- Hero ----------------------------------------------------- */}
      <section className="relative z-10 flex flex-col items-center px-6 pt-16 pb-24 md:pt-24 md:pb-32 text-center">
        <div className="flex flex-wrap items-center justify-center gap-3">
          <AlphaBadge />
          <LinuxBadge />
        </div>

        <h1 className="mt-8 font-display font-bold leading-[0.95] tracking-tight
                       text-6xl md:text-8xl lg:text-9xl">
          <span className="block text-white/95">Claude</span>
          <span className="block text-ember-gradient">Desktop</span>
        </h1>

        {/* Linux-first tagline — visible H2, not just meta. */}
        <h2 className="mt-6 font-mono text-xs md:text-sm uppercase tracking-[0.34em] text-ember-400">
          built for linux · linux only
        </h2>

        <p className="mt-8 max-w-2xl text-base md:text-lg text-white/70 leading-relaxed">
          <strong className="text-white/90">Claude Desktop for Linux</strong> — a proper
          Linux-native desktop window for Claude AI. Drives the official{' '}
          <code className="font-mono text-ember-400 bg-ember-500/10 px-1.5 py-0.5 rounded">
            claude
          </code>{' '}
          CLI under the hood. Attach folders, chat in Cowork mode, sandboxed by
          default via <strong className="text-white/90">bubblewrap</strong> on
          Ubuntu, Debian, Fedora, Arch, Gentoo, and every other modern Linux
          distribution.
        </p>

        <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.32em] text-white/35">
          unofficial · community build · not affiliated with anthropic
        </p>

        {/* Centred download button */}
        <div className="mt-14">
          <DownloadButton />
          <p className="mt-5 font-mono text-[11px] text-white/45">
            Linux · x86_64 · AppImage · v{APP_VERSION} &nbsp;·&nbsp;{' '}
            <a
              href={`${REPO_URL}/releases/latest`}
              className="underline decoration-white/20 hover:decoration-ember-500 hover:text-ember-400 transition-colors"
            >
              all releases →
            </a>
          </p>
        </div>

        <TerminalPreview />
      </section>

      {/* --- Features ------------------------------------------------- */}
      <section id="features" className="relative z-10 mx-auto max-w-6xl px-6 py-16">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-ember-500 mb-8 bracketed">
          what you get
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          <FeatureCard
            glyph="◉"
            title="Chat + Cowork"
            body="Two modes per chat. Chat for pure Claude conversation, Cowork for agentic work — attach folders and Claude can read, edit, and run code inside them."
          />
          <FeatureCard
            glyph="▣"
            title="Sandboxed by default"
            body="Bubblewrap wraps every Cowork turn. Only the folders you attach are visible to Claude; the rest of $HOME stays hidden. Fail-closed: refuses to start if bwrap isn't installed."
          />
          <FeatureCard
            glyph="⌘"
            title="Local-first chat history"
            body="SQLite-backed chats and per-chat sandboxes under your user-data dir. Close the app, re-open — your conversations are right where you left them."
          />
          <FeatureCard
            glyph="↺"
            title="Resumable sessions"
            body="Each chat maps to a claude --resume session with a stable working directory, so long-running conversations survive restarts intact."
          />
          <FeatureCard
            glyph="⏻"
            title="Guided first launch"
            body="Missing the claude CLI? The app installs it for you via the official installer and walks you through OAuth sign-in — no terminal required."
          />
          <FeatureCard
            glyph="⎆"
            title="Three execution modes"
            body="Default sandboxed (bwrap), Docker shell, or fully unrestricted. Switch per-install in Settings → Security."
          />
        </div>
      </section>

      {/* --- Alpha warning ------------------------------------------- */}
      <section className="relative z-10 mx-auto max-w-4xl px-6 py-16">
        <div className="relative rounded-lg border border-ember-500/30 bg-ember-500/[0.04] p-6 md:p-8">
          <div className="absolute -top-3 left-6 px-2 bg-carbon-900 font-mono text-[10px] uppercase tracking-[0.3em] text-ember-500">
            · alpha notice ·
          </div>
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-ember-500 mb-3">
            expect rough edges
          </p>
          <ul className="space-y-2 text-sm text-white/70 leading-relaxed">
            <li>— No automatic recovery from unexpected CLI exits. If <span className="font-mono text-ember-400">claude</span> crashes mid-turn, resend the prompt.</li>
            <li>— Tool-call UI is minimal. Timeline rendering only, no per-tool detail view.</li>
            <li>— aarch64 Linux builds from source but is untested in this alpha.</li>
            <li>— No test suite yet. Bug reports with distro + Node version are gold.</li>
          </ul>
        </div>
      </section>

      {/* --- Runs on (Linux distros) --------------------------------- */}
      <section id="distros" className="relative z-10 mx-auto max-w-5xl px-6 py-16">
        <div className="flex items-baseline justify-between flex-wrap gap-3 mb-8">
          <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-ember-500 bracketed">
            runs on linux
          </h2>
          <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-white/40">
            x86_64 · appimage · no install
          </span>
        </div>

        <p className="text-white/65 max-w-3xl leading-relaxed mb-8 text-[15px]">
          The AppImage is self-contained — no package manager, no root, no
          dependencies to chase. The only thing the app asks of your system is{' '}
          <span className="font-mono text-ember-400">bubblewrap</span>
          {' '}for the Default sandbox mode, and it will print the exact command
          for your distro if it isn't installed.
        </p>

        <div className="overflow-hidden rounded-lg border border-white/10 font-mono text-sm">
          {DISTROS.map((d) => (
            <DistroRow key={d.name} name={d.name} install={d.install} />
          ))}
        </div>

        <p className="mt-4 font-mono text-[11px] text-white/35 text-center">
          not on this list? chances are it works — open an issue on github if it doesn't.
        </p>
      </section>

      {/* --- FAQ (keyword-rich, mirrored into FAQ JSON-LD) ----------- */}
      <section id="faq" className="relative z-10 mx-auto max-w-4xl px-6 py-16">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-ember-500 mb-10 bracketed">
          frequently asked
        </h2>
        <div className="space-y-4">
          {FAQS.map(({ q, a }) => (
            <details
              key={q}
              className="group rounded-lg border border-white/10 bg-white/[0.02] open:border-ember-500/50 open:bg-ember-500/[0.03] transition-colors"
            >
              <summary className="cursor-pointer list-none px-5 py-4 flex items-start justify-between gap-4">
                <span className="font-display text-[15px] md:text-base font-semibold text-white/95">
                  {q}
                </span>
                <span className="shrink-0 mt-1 font-mono text-ember-500 group-open:rotate-45 transition-transform">
                  +
                </span>
              </summary>
              <p className="px-5 pb-5 text-[14px] leading-relaxed text-white/65">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <Footer />
    </main>
  );
}

/* =================================================================== */
/*  Components                                                          */
/* =================================================================== */

function Header() {
  return (
    <header className="relative z-20 flex items-center justify-between px-6 py-5 border-b border-white/5 backdrop-blur-sm">
      <div className="flex items-center gap-3 font-mono text-[13px]">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-sm bg-ember-500/70 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-sm bg-ember-500" />
        </span>
        <span className="tracking-[0.18em] text-white/90">claude://desktop</span>
      </div>
      <nav className="hidden md:flex items-center gap-7 font-mono text-[11px] uppercase tracking-[0.22em] text-white/50">
        <a className="hover:text-ember-400 transition-colors" href="#features">features</a>
        <a className="hover:text-ember-400 transition-colors" href="#faq">faq</a>
        <a className="hover:text-ember-400 transition-colors" href={README_URL}>readme</a>
        <a className="hover:text-ember-400 transition-colors" href={NOTES_URL}>notes</a>
        <a className="hover:text-ember-400 transition-colors" href={REPO_URL}>github</a>
        <a
          className="px-3 py-1.5 border border-ember-500/50 text-ember-400 hover:bg-ember-500 hover:text-carbon-900 transition-colors rounded-sm"
          href={DOWNLOAD_URL}
        >
          download
        </a>
      </nav>
    </header>
  );
}

function AlphaBadge() {
  return (
    <div className="inline-flex items-center gap-2.5 rounded-full border border-ember-500/50 bg-ember-500/10 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.28em] text-ember-400">
      <span className="h-1.5 w-1.5 rounded-full bg-ember-500 blink" />
      alpha · v{APP_VERSION}
      <span className="text-ember-500/60">//</span>
      <span className="text-white/50">rough edges ahead</span>
    </div>
  );
}

// Linux-only badge next to the alpha pill. The small tux glyph + uppercase
// "LINUX ONLY" is the single most important visual signal on the page —
// this isn't "works on Linux", it's a Linux-native project by design.
function LinuxBadge() {
  return (
    <div className="inline-flex items-center gap-2.5 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.28em] text-white/80">
      <TuxGlyph />
      linux only
      <span className="text-white/30">//</span>
      <span className="text-white/50">x86_64</span>
    </div>
  );
}

// Simple, tiny penguin silhouette in SVG so we don't pull in an icon lib.
function TuxGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true" fill="currentColor">
      <path d="M12 2.5c-2.2 0-4 1.8-4 4 0 .9.3 1.7.8 2.4C7.3 10.2 6 12.8 6 15.5c0 1.4.4 2.6 1.1 3.5L5.4 20.6c-.3.3-.3.8 0 1.1.3.3.8.3 1.1 0l1.6-1.6c.9.6 2.1.9 3.9.9s3-.3 3.9-.9l1.6 1.6c.3.3.8.3 1.1 0 .3-.3.3-.8 0-1.1l-1.7-1.6c.7-.9 1.1-2.1 1.1-3.5 0-2.7-1.3-5.3-2.8-6.6.5-.7.8-1.5.8-2.4 0-2.2-1.8-4-4-4zm-1.5 4a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zm3 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zM12 9.6c.5 0 1 .3 1.3.7l.6.9-2 .6-1.8-.6.6-.9c.3-.4.8-.7 1.3-.7z"/>
    </svg>
  );
}

function DownloadButton() {
  return (
    <a
      href={DOWNLOAD_URL}
      rel="noopener"
      aria-label="Download Claude Desktop for Linux AppImage"
      className="ember-glow group relative inline-flex items-center gap-4
                 rounded-md bg-ember-500 px-8 py-4 font-mono text-sm
                 uppercase tracking-[0.22em] text-carbon-900
                 transition-transform hover:-translate-y-0.5 hover:bg-ember-400"
    >
      <DownloadIcon />
      <span className="font-semibold">Download AppImage</span>
      <span className="text-carbon-900/60 text-[10px] tracking-[0.3em]">v{APP_VERSION}</span>
      <span className="absolute -inset-px rounded-md ring-1 ring-inset ring-white/20 pointer-events-none" />
    </a>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path d="M12 3v11.17l3.59-3.58L17 12l-5 5-5-5 1.41-1.41L11 14.17V3h1zM5 19h14v2H5z" />
    </svg>
  );
}

function TerminalPreview() {
  return (
    <div className="mt-16 w-full max-w-2xl">
      <div className="rounded-lg border border-white/10 bg-carbon-800/70 backdrop-blur-sm font-mono text-sm text-left overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5 bg-white/[0.02]">
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          <span className="h-2.5 w-2.5 rounded-full bg-ember-500/80" />
          <span className="ml-3 text-[11px] text-white/40 tracking-widest">~ / downloads</span>
        </div>
        <pre className="px-5 py-5 text-[13px] leading-relaxed text-white/80 whitespace-pre-wrap">
<span className="prompt text-white/60">chmod +x Claude-Desktop-0.1.0.AppImage</span>
{'\n'}
<span className="prompt text-white/60">./Claude-Desktop-0.1.0.AppImage</span>
{'\n'}
<span className="text-ember-400">→</span> <span className="text-white/70">backend listening on 127.0.0.1:54891</span>
{'\n'}
<span className="text-ember-400">→</span> <span className="text-white/70">claude CLI: ready · signed in as you@example.com</span>
{'\n'}
<span className="text-ember-400">→</span> <span className="text-white/70">sandbox: bwrap 0.8.0 ok</span>
{'\n'}
<span className="text-white/60">ready_<span className="blink text-ember-500">|</span></span>
        </pre>
      </div>
    </div>
  );
}

function FeatureCard({ glyph, title, body }) {
  return (
    <div className="group relative rounded-lg border border-white/10 bg-white/[0.02] p-6
                    transition-colors hover:border-ember-500/50 hover:bg-ember-500/[0.03]">
      <div className="font-mono text-2xl text-ember-500 mb-3 leading-none">{glyph}</div>
      <h3 className="font-display text-lg font-semibold text-white mb-2 tracking-tight">{title}</h3>
      <p className="text-[13.5px] leading-relaxed text-white/60">{body}</p>
      <span className="pointer-events-none absolute top-2 right-2 text-[10px] font-mono text-ember-500/0 group-hover:text-ember-500/80 transition-colors">◤</span>
    </div>
  );
}

// One row per Linux distro, with the distro's bubblewrap install command
// printed as a monospace shell snippet. The dot is always green — this
// section is strictly "distros we have a tested path for".
function DistroRow({ name, install }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_1.6fr] items-center gap-3 md:gap-6 px-5 py-3 border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors">
      <div className="flex items-center gap-3 text-white/90">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        <span>{name}</span>
      </div>
      <code className="text-[12.5px] text-ember-400 bg-ember-500/[0.06] px-3 py-1.5 rounded border border-ember-500/15 overflow-x-auto">
        {install}
      </code>
    </div>
  );
}

function Footer() {
  return (
    <footer className="relative z-10 border-t border-white/5 mt-8">
      <div className="mx-auto max-w-6xl px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4 font-mono text-[11px] text-white/35 uppercase tracking-[0.22em]">
        <span>© community build · drives the official claude cli</span>
        <div className="flex items-center gap-5">
          <a className="hover:text-ember-400 transition-colors" href={README_URL}>readme</a>
          <a className="hover:text-ember-400 transition-colors" href={NOTES_URL}>release notes</a>
          <a className="hover:text-ember-400 transition-colors" href={REPO_URL}>github</a>
        </div>
      </div>
    </footer>
  );
}
