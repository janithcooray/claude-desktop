import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The renderer runs at http://localhost:5173 in dev and from dist/index.html
// when packaged. `base: './'` makes the build output work with file:// URLs.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
