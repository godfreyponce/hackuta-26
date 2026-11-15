import { randomUUID } from 'node:crypto';
import type { WeaponClass, WeaponSpawn } from '@ithaca/shared';
import { analyzeWithRetry, vision, type VisionResult } from './ai/vision';
import { cropForModel } from './ai/image';
import { generateGlb } from './ai/model3d';
import { getStore, putFile, toOid } from './db/mongo';
import { findRecentGlb, insertWeapon } from './db/weapons';
import { hub } from './hub';
import { env } from './env';
import { log } from './log';
import { errMsg, withTimeout } from './util';

export type ForgeSource = 'facetime' | 'upload' | 'test';

export type ForgeResponse =
  | { status: 200; body: { detected: false; reason: string; vision?: VisionResult } }
  | { status: 202; body: { detected: true; forgeId: string; objectName: string; displayName: string; weaponClass: WeaponClass; quip: string; vision?: VisionResult } };

const inFlight = new Set<string>();
const REUSE_WITHIN_MS = 2 * 60 * 60 * 1000;
const MIN_CONFIDENCE = 0.6;

/** Lets tests/CLI await the async part of a forge. */
export const forgeDone = new Map<string, Promise<WeaponSpawn>>();

async function sessionContext(sessionId: string): Promise<{ friendName: string; playerId: ReturnType<typeof toOid> }> {
  const s = getStore();
  const sid = toOid(sessionId);
  if (!s || !sid) return { friendName: 'Telemachus', playerId: null };
  try {
    const sess = await s.sessions.findOne({ _id: sid });
    const friend = sess?.friendId ? await s.friends.findOne({ _id: sess.friendId }, { projection: { name: 1 } }) : null;
    return { friendName: friend?.name ?? 'Telemachus', playerId: sess?.playerId ?? null };
  } catch {
    return { friendName: 'Telemachus', playerId: null };
  }
}

export async function forge(jpeg: Buffer, sessionId: string, source: ForgeSource, opts: { debug?: boolean } = {}): Promise<ForgeResponse> {
  if (inFlight.has(sessionId)) return { status: 200, body: { detected: false, reason: 'busy' } };
  inFlight.add(sessionId);
  let handedOff = false;
  try {
    const forgeId = randomUUID();
    hub.sendWeb(sessionId, { type: 'forge.progress', forgeId, stage: 'vision', pct: 5 });
    let v: VisionResult;
    try {
      v = await analyzeWithRetry(jpeg);
    } catch (e) {
      log.warn({ sessionId, err: errMsg(e) }, 'vision failed');
      return { status: 200, body: { detected: false, reason: 'vision_error' } };
    }
    const dbg = opts.debug ? { vision: v } : {};
    if (!v.is_object || v.rejected || v.confidence < MIN_CONFIDENCE || !v.object_name) {
      const reason = v.rejected ?? (v.confidence < MIN_CONFIDENCE ? 'low_confidence' : 'no_object');
      log.info({ sessionId, source, reason, confidence: v.confidence }, 'forge: nothing detected');
      return { status: 200, body: { detected: false, reason, ...dbg } };
    }
    const displayName = v.display_name || `The ${v.object_name} of Ithaca`;
    log.info({ sessionId, source, object: v.object_name, cls: v.weapon_class, conf: v.confidence }, 'forge: detected');

    handedOff = true;
    const done = runPipeline(forgeId, jpeg, sessionId, v, displayName)
      .finally(() => { inFlight.delete(sessionId); setTimeout(() => forgeDone.delete(forgeId), 60_000); });
    forgeDone.set(forgeId, done);
    done.catch(() => undefined);

    return {
      status: 202,
      body: { detected: true, forgeId, objectName: v.object_name, displayName, weaponClass: v.weapon_class, quip: v.quip, ...dbg },
    };
  } finally {
    if (!handedOff) inFlight.delete(sessionId);
  }
}

async function runPipeline(forgeId: string, jpeg: Buffer, sessionId: string, v: VisionResult, displayName: string): Promise<WeaponSpawn> {
  const started = Date.now();
  const ctx = await sessionContext(sessionId);
  const progress = (stage: 'crop' | '3d' | 'store', pct: number) =>
    hub.sendWeb(sessionId, { type: 'forge.progress', forgeId, stage, pct });

  const base = {
    sessionId, playerId: ctx.playerId, friendName: ctx.friendName, objectName: v.object_name, displayName,
    weaponClass: v.weapon_class, quip: v.quip,
    vision: { provider: vision.name, model: vision.model, confidence: v.confidence, bbox: v.bbox },
    kills: 0, createdAt: new Date(),
  };

  let thumbFileId: string | undefined;
  const fallback = async (why: string): Promise<WeaponSpawn> => {
    if (spawned) throw new Error('already spawned');
    log.warn({ sessionId, forgeId, why }, 'forge: using prefab fallback');
    let weaponId = `prefab-${v.weapon_class}`;
    try {
      const thumbOid = toOid(thumbFileId);
      const doc = await insertWeapon({ ...base, fallback: true, ...(thumbOid ? { thumbFileId: thumbOid } : {}) });
      weaponId = doc._id.toHexString();
    } catch (e) { log.warn({ err: errMsg(e) }, 'insert fallback weapon failed'); }
    const spawn: WeaponSpawn = {
      weaponId, glbUrl: `/prefabs/${v.weapon_class}.glb`, weaponClass: v.weapon_class,
      objectName: v.object_name, displayName, friendName: ctx.friendName, fallback: true,
      ...(thumbFileId && !weaponId.startsWith('prefab-') ? { thumbUrl: `/api/weapons/${weaponId}/thumb.jpg` } : {}),
    };
    finish(spawn);
    return spawn;
  };

  let spawned = false;
  const finish = (spawn: WeaponSpawn) => {
    if (spawned) return; // the deadline fallback may race the real pipeline
    spawned = true;
    hub.spawnWeapon(sessionId, spawn);
    if (!getStore() || !changeStreamActive) {
      hub.broadcastWeb({
        type: 'armory.new', weaponId: spawn.weaponId, displayName: spawn.displayName,
        ...(spawn.thumbUrl ? { thumbUrl: spawn.thumbUrl } : {}),
      });
    }
    log.info({ sessionId, forgeId, ms: Date.now() - started, fallback: spawn.fallback }, 'forge: weapon.spawn');
  };

  // Hard guarantee: a weapon arrives by SF3D_TIMEOUT_MS + a few seconds no matter what.
  const deadline = env.SF3D_TIMEOUT_MS + 5000;
  try {
    return await withTimeout((async () => {
      progress('crop', 15);
      const { png1024, thumbJpeg } = await cropForModel(jpeg, v.bbox);
      thumbFileId = await putFile('thumbs', thumbJpeg, `${forgeId}.jpg`, 'image/jpeg');
      progress('crop', 30);

      let glbFileId: string;
      let reusedFrom: WeaponDocId | undefined;
      const cached = await findRecentGlb(v.object_name, REUSE_WITHIN_MS).catch(() => null);
      if (cached?.glbFileId) {
        glbFileId = cached.glbFileId.toHexString();
        reusedFrom = cached._id;
        log.info({ object: v.object_name }, 'forge: reusing cached GLB');
        progress('3d', 90);
      } else {
        progress('3d', 40);
        const tick = setInterval(() => progress('3d', 60), 1500);
        let glb: Buffer;
        try { glb = await generateGlb(png1024, v.object_name); } finally { clearInterval(tick); }
        progress('3d', 90);
        glbFileId = await putFile('models', glb, `${forgeId}.glb`, 'model/gltf-binary');
      }

      if (spawned) throw new Error('deadline already hit; discarding late GLB');
      progress('store', 95);
      const glbOid = toOid(glbFileId), thumbOid = toOid(thumbFileId);
      const doc = await insertWeapon({
        ...base, fallback: false,
        ...(glbOid ? { glbFileId: glbOid } : {}), ...(thumbOid ? { thumbFileId: thumbOid } : {}),
        ...(reusedFrom ? { reusedFrom } : {}),
      });
      const weaponId = doc._id.toHexString();
      progress('store', 100);
      const spawn: WeaponSpawn = {
        weaponId, glbUrl: `/api/weapons/${weaponId}/model.glb`, weaponClass: v.weapon_class,
        objectName: v.object_name, displayName, friendName: ctx.friendName, fallback: false,
        thumbUrl: `/api/weapons/${weaponId}/thumb.jpg`,
      };
      finish(spawn);
      return spawn;
    })(), deadline, 'forge pipeline');
  } catch (e) {
    return fallback(errMsg(e));
  }
}

type WeaponDocId = NonNullable<Awaited<ReturnType<typeof findRecentGlb>>>['_id'];

let changeStreamActive = false;
export function setChangeStreamActive(v: boolean): void { changeStreamActive = v; }
