import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :4000 and is proxied, so the browser sees a
// single origin (same as production on Vercel, where /api is served by the
// serverless function on the same domain).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
  },
});
