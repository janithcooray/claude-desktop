import { Chakra_Petch, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import {
  SITE_URL,
  SITE_NAME,
  SITE_TITLE,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  REPO_URL,
  softwareApplicationJsonLd,
} from '../lib/seo.js';

// Display font: Chakra Petch — angular, subtly cyber-techno, distinctive
// against the usual Inter/Space-Grotesk landing-page defaults.
const display = Chakra_Petch({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

// Mono for code / UI chrome.
const mono = JetBrains_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

// ---- SEO metadata ----------------------------------------------------
// Everything rendered into <head>. Next 14's metadata API handles the
// canonical URL, Open Graph, Twitter card, robots directives, and the
// `<title>` template so interior pages (if you add any) inherit cleanly.
export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: '%s · Claude Desktop for Linux',
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: SITE_NAME,
  authors: [{ name: 'community build', url: REPO_URL }],
  creator: 'community build',
  publisher: 'community build',
  category: 'technology',
  alternates: {
    canonical: '/',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-snippet': -1,
      'max-image-preview': 'large',
      'max-video-preview': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: SITE_URL,
    siteName: SITE_NAME,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
  other: {
    // A few search engines still read these.
    'format-detection':     'telephone=no',
    'apple-mobile-web-app-title': SITE_NAME,
  },
};

export const viewport = {
  themeColor: '#ff6a1a',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <head>
        {/* JSON-LD: SoftwareApplication — helps Google show install cards,
            star ratings, and platform info in search results. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(softwareApplicationJsonLd()),
          }}
        />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
