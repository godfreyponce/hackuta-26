import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { timingSafeEqual } from 'node:crypto';
import { env, isDev } from './env';
import { redactPaths, scrub } from './log';
import { hub } from './hub';
import { apiRoutes } from './routes/api';
import { devRoutes } from './routes/dev';
import { prefabRoutes } from './routes/prefabs';

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: redactPaths, censor: '[redacted]' },
      serializers: {
        // Never log query secrets (e.g. /ws?role=agent&key=…) or client IPs/ports.
        req: (r: { method: string; url: string }) => ({ method: r.method, url: scrub(r.url) }),
      },
    },
    bodyLimit: 1024 * 1024,
    disableRequestLogging: false,
  });

  await app.register(cors, { origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()) });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.role === 'agent') {
      if (!env.AGENT_SHARED_SECRET || !q.key || !safeEq(q.key, env.AGENT_SHARED_SECRET)) {
        socket.close(4401, 'unauthorized');
        return;
      }
      hub.attachAgent(socket);
      return;
    }
    if (q.role === 'web' && q.sessionId && /^[0-9a-f]{24}$/i.test(q.sessionId)) {
      hub.attachWeb(socket, q.sessionId);
      return;
    }
    socket.close(4400, 'role=web&sessionId=<24 hex> or role=agent&key=<secret> required');
  });

  await app.register(apiRoutes);
  await app.register(prefabRoutes);
  if (isDev) await app.register(devRoutes);
  return app;
}
