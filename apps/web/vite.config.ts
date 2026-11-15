import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web on 5173; /api and /ws proxy to the hub (Part D) on 8787.
export default defineConfig({
  plugins: [react()],
  envDir: '../..',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
