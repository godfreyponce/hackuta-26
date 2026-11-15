import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// dev only: src/dev/playLog.ts posts a play session's events here; they land in apps/web/playlog.log
// (git-ignored by *.log). Local file, cleared when the dev server starts.
function playLog(): Plugin {
  const file = fileURLToPath(new URL('./playlog.log', import.meta.url));
  return {
    name: 'ithaca-playlog',
    apply: 'serve',
    configureServer(server) {
      writeFileSync(file, '');
      server.middlewares.use('/__playlog', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c: Buffer) => { body += c; if (body.length > 1_000_000) req.destroy(); });
        req.on('end', () => {
          try {
            const lines = JSON.parse(body) as unknown[];
            if (Array.isArray(lines) && lines.length) appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
          } catch { /* a bad batch is dropped */ }
          res.statusCode = 204; res.end();
        });
      });
    },
  };
}

// Web on 5173; /api and /ws proxy to the hub (Part D) on 8787.
export default defineConfig({
  plugins: [react(), playLog()],
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
