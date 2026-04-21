// Generates /sitemap.xml at build time. Single-page site for now.
import { SITE_URL } from '../lib/seo.js';

export default function sitemap() {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1.0,
    },
  ];
}
