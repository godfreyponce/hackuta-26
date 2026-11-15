// Pre-populates the Armory and warms the objectName GLB cache by running photos in scripts/seed/
// through the real /api/forge. Server must be running. Usage: pnpm --filter @ithaca/server seed:armory
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/env';

const base = process.env.SERVER_HTTP_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const dir = fileURLToPath(new URL('../../../scripts/seed/', import.meta.url));
const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.(jpe?g|png)$/i.test(f));
if (!files.length) { console.error(`no photos in ${dir}`); process.exit(1); }

const { sessionId } = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { sessionId: string };
for (const f of files) {
  const fd = new FormData();
  fd.append('sessionId', sessionId);
  fd.append('source', 'test');
  fd.append('image', new Blob([new Uint8Array(await readFile(join(dir, f)))], { type: 'image/jpeg' }), f);
  const t = performance.now();
  const r = await fetch(`${base}/api/forge`, { method: 'POST', body: fd });
  const j = await r.json() as Record<string, unknown>;
  console.log(f, r.status, Math.round(performance.now() - t), 'ms', j.detected ? `${j.objectName} → ${j.displayName}` : j.reason);
  if (r.status === 202) {
    // wait for the async half (one in-flight forge per session)
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const arm = await (await fetch(`${base}/api/armory?limit=1`)).json() as Array<{ objectName: string }>;
      if (arm[0]?.objectName === j.objectName) break;
    }
  }
}
