#!/usr/bin/env node
// Cross-platform (Windows/macOS/Linux) model + WASM fetcher for @ithaca/motion.
// Usage:  pnpm --filter @ithaca/motion fetch-models [--force]
// Puts everything in apps/web/public/models/ so the game works offline at the venue.
import { createWriteStream } from 'node:fs';
import { cp, mkdir, rename, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const outDir = resolve(pkgDir, '../../apps/web/public/models');
const wasmSrc = join(pkgDir, 'node_modules/@mediapipe/tasks-vision/wasm');
const force = process.argv.includes('--force');
const TIMEOUT_MS = 120_000;

const BASE = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = [
  { file: 'pose_landmarker_full.task', url: `${BASE}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`, minBytes: 5_000_000 },
  { file: 'pose_landmarker_lite.task', url: `${BASE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`, minBytes: 3_000_000 },
  { file: 'hand_landmarker.task', url: `${BASE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`, minBytes: 4_000_000 },
];

async function size(path) {
  try { return (await stat(path)).size; } catch { return -1; }
}

async function download({ file, url, minBytes }) {
  const dest = join(outDir, file);
  const have = await size(dest);
  if (!force && have >= minBytes) {
    console.log(`✓ ${file} already present (${(have / 1e6).toFixed(1)} MB)`);
    return;
  }
  const tmp = `${dest}.part`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    process.stdout.write(`↓ ${file} … `);
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const got = await size(tmp);
    if (got < minBytes) throw new Error(`too small (${got} bytes) — truncated download?`);
    await rename(tmp, dest);
    console.log(`${(got / 1e6).toFixed(1)} MB`);
  } catch (err) {
    await rm(tmp, { force: true });
    console.log('FAILED');
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)} (${url})`);
  } finally {
    clearTimeout(timer);
  }
}

async function copyWasm() {
  const files = await readdir(wasmSrc).catch(() => null);
  if (!files) throw new Error(`WASM not found at ${wasmSrc} — run "pnpm install" first.`);
  const dest = join(outDir, 'wasm');
  await mkdir(dest, { recursive: true });
  await cp(wasmSrc, dest, { recursive: true, force: true });
  console.log(`✓ wasm/ copied (${files.join(', ')})`);
}

await mkdir(outDir, { recursive: true });
console.log(`Models dir: ${outDir}`);
let failed = 0;
for (const m of MODELS) {
  try { await download(m); } catch (e) { failed++; console.error(`  ${e.message}`); }
}
try { await copyWasm(); } catch (e) { failed++; console.error(`  ${e.message}`); }
if (failed) {
  console.error(`\n${failed} item(s) failed. Re-run when the network is back; existing files are kept.`);
  process.exit(1);
}
console.log('\nAll models ready. They are git-ignored; every machine runs this once.');
