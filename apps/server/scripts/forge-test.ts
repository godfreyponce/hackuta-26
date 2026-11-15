// Runs the full forge pipeline on one photo, no game or agent needed. Writes out/<name>.glb + .json
// Usage: pnpm --filter @ithaca/server forge:test path/to/photo.jpg
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import sharp from 'sharp';
import { env } from '../src/env';
import { analyzeWithRetry, vision } from '../src/ai/vision';
import { cropForModel } from '../src/ai/image';
import { generateGlb } from '../src/ai/model3d';

const path = process.argv[2];
if (!path) { console.error('usage: forge:test <photo.jpg>'); process.exit(1); }
const raw = await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), path));
const jpeg = await sharp(raw).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
const name = basename(path, extname(path));
await mkdir('out', { recursive: true });

let t = performance.now();
const v = await analyzeWithRetry(jpeg);
const visionMs = Math.round(performance.now() - t);
console.log(`vision (${vision.name}/${vision.model}) ${visionMs} ms`, v);
if (!v.is_object) process.exit(0);

const { png1024, thumbJpeg } = await cropForModel(jpeg, v.bbox);
await writeFile(`out/${name}-crop.png`, png1024);
await writeFile(`out/${name}-thumb.jpg`, thumbJpeg);

let model3dMs: number | null = null;
if (env.MODEL3D_PROVIDER === 'stability') {
  t = performance.now();
  const glb = await generateGlb(png1024, v.object_name);
  model3dMs = Math.round(performance.now() - t);
  await writeFile(`out/${name}.glb`, glb);
  console.log(`3d ${model3dMs} ms → out/${name}.glb`);
} else console.log('MODEL3D_PROVIDER=prefab — skipped 3D');
await writeFile(`out/${name}.json`, JSON.stringify({ vision: v, visionMs, model3dMs }, null, 2));
