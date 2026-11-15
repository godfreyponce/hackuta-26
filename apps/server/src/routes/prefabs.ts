import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { WEAPON_CLASSES } from '@ithaca/shared';

// GET /prefabs/<class>.glb — the fallback model per weapon class (built by scripts/build-prefabs.ts).
// Files load once at startup into a map keyed by "<class>.glb", so any other name is a 404 and no path reaches the disk.
export async function prefabRoutes(app: FastifyInstance): Promise<void> {
  const files = new Map<string, Buffer>();
  for (const cls of Object.keys(WEAPON_CLASSES)) {
    files.set(`${cls}.glb`, await readFile(new URL(`../../prefabs/${cls}.glb`, import.meta.url)));
  }
  app.get<{ Params: { name: string } }>('/prefabs/:name', async (req, reply) => {
    const buf = files.get(req.params.name);
    if (!buf) return reply.code(404).send({ error: 'not_found', message: 'prefab not found' });
    return reply.header('content-type', 'model/gltf-binary').header('cache-control', 'public, max-age=86400').send(buf);
  });
}
