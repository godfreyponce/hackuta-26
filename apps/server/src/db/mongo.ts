import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { MongoClient, GridFSBucket, ObjectId, type Db, type Collection } from 'mongodb';
import type { WeaponClass, CallState, TrickshotKind } from '@ithaca/shared';
import { env } from '../env';
import { log, scrub } from '../log';
import { errMsg } from '../util';

// ── Documents ─────────────────────────────────────────────────
export interface PlayerDoc { _id: ObjectId; name: string; createdAt: Date }
export interface FriendDoc {
  _id: ObjectId; playerId: ObjectId; name: string; phoneE164: string; phoneMasked: string;
  consent: true; consentAt: Date; createdAt: Date;
}
export interface SessionDoc {
  _id: ObjectId; playerId: ObjectId | null; friendId?: ObjectId; gameRoom: string;
  call: { state: CallState; callId?: string; startedAt?: Date; endedAt?: Date; reason?: string };
  createdAt: Date; endedAt?: Date;
}
export interface WeaponDoc {
  _id: ObjectId; sessionId: string; playerId: ObjectId | null; friendName: string;
  objectName: string; displayName: string; weaponClass: WeaponClass; quip: string;
  vision: { provider: string; model: string; confidence: number; bbox: [number, number, number, number] };
  /** How the GLB was made (3D model, clean-image mode, texture size) and the object color vision saw; the GLB reuse key. */
  pipeline?: string; color?: string;
  glbFileId?: ObjectId; thumbFileId?: ObjectId; fallback: boolean; reusedFrom?: ObjectId;
  kills: number; createdAt: Date;
}
export interface MatchDoc {
  _id: ObjectId; sessionId: string; playerId: ObjectId | null; playerName: string; score: number; kills: number;
  trickshots: Partial<Record<TrickshotKind, number>>; durationMs: number; forgedWeaponIds: ObjectId[]; createdAt: Date;
}
export interface KillcamDoc {
  _id: ObjectId; sessionId: string; trickshot: string; weaponId?: ObjectId; fileId: ObjectId; createdAt: Date;
}

export type BucketName = 'models' | 'thumbs' | 'clips';

export interface Store {
  db: Db;
  players: Collection<PlayerDoc>;
  friends: Collection<FriendDoc>;
  sessions: Collection<SessionDoc>;
  weapons: Collection<WeaponDoc>;
  matches: Collection<MatchDoc>;
  killcams: Collection<KillcamDoc>;
  buckets: Record<BucketName, GridFSBucket>;
}

let client: MongoClient | null = null;
let store: Store | null = null;

/** null when Mongo is not configured or unreachable. Callers must degrade gracefully. */
export function getStore(): Store | null { return store; }
export function mongoOk(): boolean { return store !== null; }

export async function connectMongo(): Promise<Store | null> {
  if (!env.MONGODB_URI) {
    log.warn('MONGODB_URI not set — running without persistence (forge files kept in memory)');
    return null;
  }
  try {
    client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, appName: 'ithaca-server' });
    await client.connect();
    const db = client.db(env.MONGODB_DB);
    store = {
      db,
      players: db.collection('players'),
      friends: db.collection('friends'),
      sessions: db.collection('sessions'),
      weapons: db.collection('weapons'),
      matches: db.collection('matches'),
      killcams: db.collection('killcams'),
      buckets: {
        models: new GridFSBucket(db, { bucketName: 'models' }),
        thumbs: new GridFSBucket(db, { bucketName: 'thumbs' }),
        clips: new GridFSBucket(db, { bucketName: 'clips' }),
      },
    };
    await Promise.all([
      store.players.createIndex({ createdAt: 1 }),
      store.friends.createIndex({ playerId: 1 }),
      store.sessions.createIndex({ createdAt: 1 }),
      store.weapons.createIndex({ createdAt: -1 }),
      store.weapons.createIndex({ objectName: 1, createdAt: -1 }),
      store.matches.createIndex({ score: -1 }),
      store.killcams.createIndex({ createdAt: -1 }),
    ]);
    log.info({ db: env.MONGODB_DB }, 'mongo connected, indexes ensured');
    return store;
  } catch (e) {
    log.error({ err: scrub(errMsg(e)) }, 'mongo connect failed — running without persistence');
    store = null;
    return null;
  }
}

export async function closeMongo(): Promise<void> {
  await client?.close().catch(() => undefined);
}

// ── Files: GridFS when Mongo is up, in-memory LRU otherwise ───
const memFiles = new Map<string, { buf: Buffer; contentType: string }>();
const MEM_MAX = 64;

export async function putFile(bucket: BucketName, buf: Buffer, filename: string, contentType: string): Promise<string> {
  const s = getStore();
  if (!s) {
    const id = randomBytes(12).toString('hex');
    memFiles.set(`${bucket}:${id}`, { buf, contentType });
    while (memFiles.size > MEM_MAX) {
      const oldest = memFiles.keys().next().value;
      if (oldest === undefined) break;
      memFiles.delete(oldest);
    }
    return id;
  }
  const up = s.buckets[bucket].openUploadStream(filename, { metadata: { contentType } });
  await new Promise<void>((res, rej) => {
    Readable.from(buf).pipe(up).on('finish', () => res()).on('error', rej);
  });
  return up.id.toString();
}

export async function getFile(bucket: BucketName, id: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const mem = memFiles.get(`${bucket}:${id}`);
  if (mem) return mem;
  const s = getStore();
  if (!s || !ObjectId.isValid(id)) return null;
  const oid = new ObjectId(id);
  const file = await s.buckets[bucket].find({ _id: oid }).next();
  if (!file) return null;
  const chunks: Buffer[] = [];
  for await (const c of s.buckets[bucket].openDownloadStream(oid)) chunks.push(c as Buffer);
  const ct = (file.metadata as { contentType?: string } | undefined)?.contentType ?? 'application/octet-stream';
  return { buf: Buffer.concat(chunks), contentType: ct };
}

export function toOid(id: string | undefined | null): ObjectId | null {
  return id && ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}
