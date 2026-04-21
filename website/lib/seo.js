// Centralised SEO / site config. Update SITE_URL to match wherever this
// ends up hosted (GitHub Pages, Netlify, Cloudflare Pages, custom domain).
// Every meta tag, canonical, OG URL, JSON-LD entry, robots.txt entry, and
// sitemap entry reads from the constants below, so you change one place.

export const SITE_URL   = 'https://janithcooray.github.io/claude-desktop';
export const SITE_NAME  = 'Claude Desktop';
export const SITE_TITLE = 'Claude Desktop for Linux — community build (alpha)';

export const SITE_DESCRIPTION =
  'Claude Desktop for Linux — built for Linux, Linux only. An unofficial ' +
  'community Electron app that drives the official claude CLI. Chat mode + ' +
  'agentic Cowork mode with attached folders, sandboxed by default via ' +
  'bubblewrap. Download the AppImage for x86_64 Linux — v0.1.0-alpha. Tested ' +
  'on Ubuntu, Debian, Fedora, Arch, Manjaro, openSUSE, Gentoo, Alpine, and Void.';

// Search keywords — Google ignores the meta tag, but Bing and smaller engines
// still read it, and putting the phrases here keeps them in one place for
// reuse inside body copy / JSON-LD.
export const SITE_KEYWORDS = [
  'Claude Desktop',
  'Claude Desktop Linux',
  'Claude Desktop AppImage',
  'Claude for Linux',
  'Claude AI desktop app',
  'Claude Code Linux',
  'Claude Code desktop',
  'Claude CLI desktop wrapper',
  'Claude Desktop Ubuntu',
  'Claude Desktop Fedora',
  'Claude Desktop Arch Linux',
  'Claude Desktop Debian',
  'Claude Desktop Gentoo',
  'Anthropic Claude Linux app',
  'Claude agent desktop',
  'Claude Cowork',
  'Claude sandbox bubblewrap',
  'unofficial Claude Desktop',
  'community Claude Desktop build',
];

// Download / project links used across the UI.
export const DOWNLOAD_URL =
  'https://github.com/janithcooray/claude-desktop/releases/download/v0.1.0-alpha/Claude-Desktop-0.1.0.AppImage';
export const REPO_URL    = 'https://github.com/janithcooray/claude-desktop';
export const README_URL  = `${REPO_URL}#readme`;
export const NOTES_URL   = `${REPO_URL}/blob/main/RELEASE_NOTES.md`;
export const APP_VERSION = '0.1.0-alpha';

// ----- JSON-LD structured data ----------------------------------------
// Two blobs: a SoftwareApplication describing the download, plus an FAQPage
// mirroring the on-page FAQ so Google can pull rich results.

export function softwareApplicationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Claude Desktop',
    alternateName: ['Claude Desktop for Linux', 'Claude Desktop community build'],
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'AI chat client',
    operatingSystem: 'Linux (x86_64)',
    softwareVersion: APP_VERSION,
    releaseNotes: NOTES_URL,
    downloadUrl: DOWNLOAD_URL,
    installUrl: DOWNLOAD_URL,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    fileSize: '160 MB',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    author: {
      '@type': 'Organization',
      name: 'community build',
      url: REPO_URL,
    },
    featureList: [
      'Chat mode (pure Claude conversation)',
      'Cowork mode (agentic work on attached folders)',
      'Bubblewrap sandbox by default on Linux',
      'Docker and unrestricted execution modes',
      'Local SQLite chat history',
      'Resumable sessions via claude --resume',
      'Multi-folder attach with --add-dir',
      'Guided first-launch installer for the claude CLI',
    ],
    keywords: SITE_KEYWORDS.join(', '),
  };
}

export function faqJsonLd(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}
