// Generates /robots.txt at build time. Allow everything, point to sitemap.
import { SITE_URL } from '../lib/seo.js';

export default function robots() {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
