import { defineConfig } from 'vite';

// Port 3902 claimed as scahn-viewer-dev in /home/user/Projects/PORTS.md.
// Relay is 3105 (scahn-relay).
const RELAY = process.env.SCAHN_RELAY || 'http://127.0.0.1:3105';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 3902,
    strictPort: true,
    proxy: {
      // Same-origin WS in dev too, so the client never needs a separate WS host.
      '/ws': { target: RELAY, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
});
