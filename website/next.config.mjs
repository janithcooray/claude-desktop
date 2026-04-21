/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export — plain HTML/CSS/JS in `out/` that you can drop on
  // GitHub Pages, Netlify, Cloudflare Pages, any static host.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
