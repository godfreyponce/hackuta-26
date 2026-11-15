import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';

// Fakes: mock vision ("frying pan", "black iron"), no 3D provider, no Mongo (in-memory store). Real env wins over .env.local.
Object.assign(process.env, { VISION_PROVIDER: 'mock', MODEL3D_PROVIDER: 'prefab', MONGODB_URI: '' });
const { forge, forgeDone, forgePipeline } = await import('../src/forge');
const { findRecentGlb, findWeapon, insertWeapon } = await import('../src/db/weapons');

const HOUR = 60 * 60 * 1000;
const frame = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer();

function cachedPan(over: { pipeline?: string; color?: string } = {}) {
  return insertWeapon({
    sessionId: 'old', playerId: null, friendName: 'Telemachus', objectName: 'frying pan', displayName: 'The Pan',
    weaponClass: 'blunt', quip: '', vision: { provider: 'mock', model: 'mock', confidence: 1, bbox: [0, 0, 1, 1] },
    pipeline: forgePipeline(), color: 'black iron', ...over,
    glbFileId: new ObjectId(), thumbFileId: new ObjectId(), fallback: false, kills: 0, createdAt: new Date(),
  });
}

async function forgeOnce(sessionId: string) {
  const res = await forge(frame, sessionId, 'test');
  assert.equal(res.status, 202);
  if (res.status !== 202) throw new Error('not detected');
  const spawn = await forgeDone.get(res.body.forgeId)!;
  return { spawn, doc: await findWeapon(spawn.weaponId) };
}

test('findRecentGlb matches only the same object, pipeline and color', async () => {
  const doc = await insertWeapon({
    sessionId: 's', playerId: null, friendName: 'T', objectName: 'pen', displayName: 'P', weaponClass: 'sword', quip: '',
    vision: { provider: 'mock', model: 'mock', confidence: 1, bbox: [0, 0, 1, 1] },
    pipeline: 'fast/clean=cutout/tex=1024', color: 'black plastic',
    glbFileId: new ObjectId(), fallback: false, kills: 0, createdAt: new Date(),
  });
  const key = { objectName: 'pen', pipeline: 'fast/clean=cutout/tex=1024', color: 'black plastic' };
  assert.equal((await findRecentGlb(key, HOUR))?._id, doc._id);
  assert.equal(await findRecentGlb({ ...key, pipeline: 'fast/clean=1/tex=512' }, HOUR), null);
  assert.equal(await findRecentGlb({ ...key, color: 'silver metal' }, HOUR), null);
});

test('a GLB from another pipeline is not reused', async () => {
  await cachedPan({ pipeline: 'fast/clean=1/tex=512' });
  const { spawn } = await forgeOnce('s-pipeline');
  assert.equal(spawn.fallback, true); // no 3D provider in this test, so a miss ends in the prefab
});

test('a GLB of another color is not reused', async () => {
  await cachedPan({ color: 'red enamel' });
  const { spawn } = await forgeOnce('s-color');
  assert.equal(spawn.fallback, true);
});

test('a reused GLB carries the cached thumb, not the new crop thumb', async () => {
  const cached = await cachedPan();
  const { spawn, doc } = await forgeOnce('s-hit');
  assert.equal(spawn.fallback, false);
  assert.ok(doc);
  assert.ok(doc.reusedFrom?.equals(cached._id));
  assert.ok(doc.glbFileId?.equals(cached.glbFileId!));
  assert.ok(doc.thumbFileId?.equals(cached.thumbFileId!), 'thumb must be the cached one');
  assert.equal(doc.pipeline, forgePipeline());
  assert.equal(doc.color, 'black iron');
});
