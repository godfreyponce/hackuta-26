import { ObjectId } from 'mongodb';
import { getStore, toOid, type WeaponDoc } from './mongo';

// Weapons live in Mongo; when Mongo is down we keep a small in-memory list so the demo still works.
const mem: WeaponDoc[] = [];
const MEM_MAX = 200;

export async function insertWeapon(doc: Omit<WeaponDoc, '_id'>): Promise<WeaponDoc> {
  const full: WeaponDoc = { _id: new ObjectId(), ...doc };
  const s = getStore();
  if (s) {
    await s.weapons.insertOne(full);
  } else {
    mem.unshift(full);
    if (mem.length > MEM_MAX) mem.pop();
  }
  return full;
}

export async function findWeapon(id: string): Promise<WeaponDoc | null> {
  const oid = toOid(id);
  if (!oid) return null;
  const s = getStore();
  if (s) return s.weapons.findOne({ _id: oid });
  return mem.find((w) => w._id.equals(oid)) ?? null;
}

export async function listWeapons(limit: number): Promise<WeaponDoc[]> {
  const s = getStore();
  if (s) return s.weapons.find().sort({ createdAt: -1 }).limit(limit).toArray();
  return mem.slice(0, limit);
}

export interface GlbKey { objectName: string; pipeline: string; color: string }

/** A successful, real (non-fallback) GLB for this object, made by this pipeline from this color, in the last `withinMs`. */
export async function findRecentGlb(key: GlbKey, withinMs: number): Promise<WeaponDoc | null> {
  const since = new Date(Date.now() - withinMs);
  const s = getStore();
  const { objectName, pipeline, color } = key;
  const q = { objectName, pipeline, color, fallback: false, glbFileId: { $exists: true }, createdAt: { $gte: since } } as const;
  if (s) return s.weapons.find(q).sort({ createdAt: -1 }).limit(1).next();
  return mem.find((w) => w.objectName === objectName && w.pipeline === pipeline && w.color === color
    && !w.fallback && w.glbFileId && w.createdAt >= since) ?? null;
}

export async function addKills(perWeapon: Record<string, number>): Promise<void> {
  const s = getStore();
  for (const [id, n] of Object.entries(perWeapon)) {
    const oid = toOid(id);
    if (!oid || !Number.isFinite(n) || n <= 0) continue;
    if (s) await s.weapons.updateOne({ _id: oid }, { $inc: { kills: Math.floor(n) } });
    else { const w = mem.find((x) => x._id.equals(oid)); if (w) w.kills += Math.floor(n); }
  }
}
