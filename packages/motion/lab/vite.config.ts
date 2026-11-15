import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  // Serve apps/web/public so /models/* resolves to the files fetch-models downloaded.
  publicDir: here('../../../apps/web/public'),
  server: { port: 5174, strictPort: true },
  // MediaPipe's bundle is large and already optimized; don't pre-bundle it.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
});
