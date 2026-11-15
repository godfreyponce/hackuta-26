// Checks the prefab fallback end to end, with no network and no MongoDB (weapons go to the in-memory store).
// Usage: pnpm --filter @ithaca/server prefabs:test
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WEAPON_CLASSES } from '@ithaca/shared';
import { buildApp } from '../src/app';
import { insertWeapon } from '../src/db/weapons';

function checkGlb(buf: Buffer, label: string): void {
  assert.equal(buf.toString('ascii', 0, 4), 'glTF', `${label}: magic`);
  assert.equal(buf.readUInt32LE(4), 2, `${label}: version`);
  assert.equal(buf.readUInt32LE(8), buf.length, `${label}: header length`);
  const jsonLen = buf.readUInt32LE(12);
  assert.equal(buf.toString('ascii', 16, 20), 'JSON', `${label}: first chunk`);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)) as {
    buffers: { byteLength: number }[];
    bufferViews: { byteOffset?: number; byteLength: number }[];
    accessors: { bufferView: number; count: number; min?: number[]; max?: number[] }[];
  };
  const binAt = 20 + jsonLen;
  assert.equal(buf.toString('ascii', binAt + 4, binAt + 8), 'BIN\0', `${label}: second chunk`);
  assert.equal(buf.readUInt32LE(binAt), json.buffers[0]!.byteLength, `${label}: BIN length matches buffer`);
  for (const a of json.accessors) {
    const view = json.bufferViews[a.bufferView]!;
    assert.equal(a.count * 12, view.byteLength, `${label}: accessor fills its view`);
    assert.ok((view.byteOffset ?? 0) + view.byteLength <= json.buffers[0]!.byteLength, `${label}: view inside buffer`);
  }
  const { min, max } = json.accessors[0]!;
  assert.ok(min && max, `${label}: POSITION bounds`);
  const longest = Math.max(...max.map((m, i) => m - min[i]!));
  assert.ok(longest > 0.8 && longest < 1.2, `${label}: longest axis ${longest} is about 1 unit`);
  assert.ok(min.every((m, i) => m <= 0 && max[i]! >= 0), `${label}: origin inside the model`);
}

const classes = Object.keys(WEAPON_CLASSES) as (keyof typeof WEAPON_CLASSES)[];
for (const cls of classes) {
  const buf = await readFile(new URL(`../prefabs/${cls}.glb`, import.meta.url));
  checkGlb(buf, cls);
  console.log(`ok   ${cls}.glb is a valid GLB v2, ${buf.length} bytes`);
}

const app = await buildApp();
try {
  const blunt = await app.inject({ method: 'GET', url: '/prefabs/blunt.glb' });
  assert.equal(blunt.statusCode, 200);
  assert.equal(blunt.headers['content-type'], 'model/gltf-binary');
  checkGlb(blunt.rawPayload, 'GET /prefabs/blunt.glb');
  console.log('ok   GET /prefabs/blunt.glb -> 200 model/gltf-binary');

  for (const url of ['/prefabs/nope.glb', '/prefabs/..%2Fpackage.json', '/prefabs/../package.json', '/prefabs/%2E%2E%2Fsrc%2Fapp.ts', '/prefabs/blunt']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 404, url);
    console.log(`ok   GET ${url} -> 404`);
  }

  const w = await insertWeapon({
    sessionId: 'a'.repeat(24), playerId: null, friendName: 'Test', objectName: 'pan', displayName: 'The Pan of Ithaca',
    weaponClass: 'sword', quip: '', vision: { provider: 'mock', model: 'mock', confidence: 1, bbox: [0, 0, 1, 1] },
    fallback: true, kills: 0, createdAt: new Date(),
  });
  const model = await app.inject({ method: 'GET', url: `/api/weapons/${w._id.toHexString()}/model.glb` });
  assert.ok(model.statusCode >= 300 && model.statusCode < 400, `redirect, got ${model.statusCode}`);
  const location = model.headers.location;
  assert.equal(location, '/prefabs/sword.glb');
  const followed = await app.inject({ method: 'GET', url: location });
  assert.equal(followed.statusCode, 200);
  assert.equal(followed.headers['content-type'], 'model/gltf-binary');
  console.log(`ok   weapon without glbFileId: model.glb -> ${model.statusCode} ${location} -> 200`);
} finally {
  await app.close();
}
console.log('all prefab checks passed');
