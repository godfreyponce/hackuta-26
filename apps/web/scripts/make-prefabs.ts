// Generates public/prefabs/<class>.glb (D's forge fallback depends on these) and public/dev/sample-weapon.glb.
// Run: pnpm --filter @ithaca/web prefabs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { PREFAB_BUILDERS, buildFryingPan } from '../src/game/engine/weaponGeo';

// GLTFExporter uses FileReader for binary output; Node only has Blob.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  onload: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    blob.arrayBuffer().then((buf) => { this.result = buf; this.onload?.(); this.onloadend?.(); });
  }
  readAsDataURL(blob: Blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
      this.onload?.(); this.onloadend?.();
    });
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, '../public');

async function exportGlb(obj: THREE.Object3D, file: string) {
  const exporter = new GLTFExporter();
  const scene = new THREE.Scene();
  scene.add(obj);
  const out = await exporter.parseAsync(scene, { binary: true });
  if (!(out instanceof ArrayBuffer)) throw new Error('expected binary glTF');
  const buf = Buffer.from(out);
  if (buf.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error('bad magic');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  console.log(`  ${file.replace(pub, 'public')}  ${(buf.length / 1024).toFixed(1)} KB`);
}

console.log('Exporting prefabs…');
for (const [cls, build] of Object.entries(PREFAB_BUILDERS)) {
  await exportGlb(build(), resolve(pub, 'prefabs', `${cls}.glb`));
}
await exportGlb(buildFryingPan(0.5), resolve(pub, 'dev', 'sample-weapon.glb'));
console.log('Done.');
