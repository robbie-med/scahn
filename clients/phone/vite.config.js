import { defineConfig } from 'vite';

// Port 3903 claimed as scahn-phone-dev in /home/user/Projects/PORTS.md.
const RELAY = process.env.SCAHN_RELAY || 'http://127.0.0.1:3105';

export default defineConfig({
  // Served under /phone by the relay, and by Vite in dev, so the asset base
  // must match in both. Relative base keeps it working either way.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 3903,
    strictPort: true,
    proxy: {
      '/ws': { target: RELAY, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
});
