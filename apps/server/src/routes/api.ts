import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { z } from 'zod';
import { E164_RE } from '@ithaca/shared';
import { env } from '../env';
import { getFile, getStore, mongoOk, putFile, toOid } from '../db/mongo';
import { addKills, findWeapon, listWeapons } from '../db/weapons';
import { forge, type ForgeSource } from '../forge';
import { hub } from '../hub';
import { log, maskPhone } from '../log';
import { errMsg } from '../util';

const bad = (reply: FastifyReply, code: string, message: string, status = 400) =>
  reply.code(status).send({ error: code, message });
const noDb = (reply: FastifyReply) => bad(reply, 'db_offline', 'database unavailable', 503);

const trickshotKeys = ['pin', 'ricochet', 'multi_kill', 'airborne', 'long_shot', 'headshot', 'friend_assist', 'return_to_sender'] as const;

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true, mongo: mongoOk(), agentConnected: hub.agentConnected }));

  // ── Players & friends ──────────────────────────────────────
  app.post('/api/players', async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(40) }).safeParse(req.body);
    if (!b.success) return bad(reply, 'invalid_body', 'name required (1–40 chars)');
    const s = getStore(); if (!s) return noDb(reply);
    const r = await s.players.insertOne({ name: b.data.name, createdAt: new Date() } as never);
    return { playerId: r.insertedId.toHexString() };
  });

  app.post('/api/friends', async (req, reply) => {
    const b = z.object({
      playerId: z.string(), name: z.string().trim().min(1).max(40),
      phoneE164: z.string().regex(E164_RE, 'phone must be E.164, e.g. +15551234567'),
      consent: z.literal(true, { message: 'consent must be true' }),
    }).safeParse(req.body);
    if (!b.success) return bad(reply, 'invalid_body', b.error.issues[0]?.message ?? 'invalid');
    const s = getStore(); if (!s) return noDb(reply);
    const playerId = toOid(b.data.playerId);
    if (!playerId || !(await s.players.findOne({ _id: playerId }))) return bad(reply, 'player_not_found', 'unknown playerId', 404);
    const phoneMasked = maskPhone(b.data.phoneE164);
    const now = new Date();
    const r = await s.friends.insertOne({
      playerId, name: b.data.name, phoneE164: b.data.phoneE164, phoneMasked, consent: true, consentAt: now, createdAt: now,
    } as never);
    return { friendId: r.insertedId.toHexString(), name: b.data.name, phoneMasked };
  });

  app.get('/api/friends', async (req, reply) => {
    const q = z.object({ playerId: z.string() }).safeParse(req.query);
    const playerId = toOid(q.success ? q.data.playerId : null);
    if (!playerId) return bad(reply, 'invalid_query', 'playerId required');
    const s = getStore(); if (!s) return noDb(reply);
    const rows = await s.friends.find({ playerId, consent: true }, { projection: { name: 1, phoneMasked: 1 } })
      .sort({ createdAt: -1 }).toArray();
    return rows.map((f) => ({ friendId: f._id.toHexString(), name: f.name, phoneMasked: f.phoneMasked }));
  });

  // ── Sessions & LiveKit ─────────────────────────────────────
  app.post('/api/sessions', async (req, reply) => {
    const b = z.object({ playerId: z.string().optional() }).safeParse(req.body ?? {});
    if (!b.success) return bad(reply, 'invalid_body', 'invalid');
    const s = getStore();
    if (!s) {
      // Degraded mode: sessions still work for LiveKit + hub, just aren't persisted.
      const sessionId = randomBytes(12).toString('hex');
      return { sessionId, gameRoom: `game-${sessionId}` };
    }
    const sessionId = randomBytes(12).toString('hex');
    const _id = toOid(sessionId)!;
    await s.sessions.insertOne({
      _id, playerId: toOid(b.data.playerId), gameRoom: `game-${sessionId}`, call: { state: 'idle' }, createdAt: new Date(),
    });
    return { sessionId, gameRoom: `game-${sessionId}` };
  });

  app.post('/api/livekit/token', async (req, reply) => {
    const b = z.object({ sessionId: z.string().regex(/^[0-9a-f]{24}$/i) }).safeParse(req.body);
    if (!b.success) return bad(reply, 'invalid_body', 'sessionId required');
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return bad(reply, 'livekit_unconfigured', 'LiveKit not configured', 503);
    const room = `game-${b.data.sessionId}`; // only game rooms — never ft-* from here
    const identity = `web-${b.data.sessionId}`;
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity, ttl: '1h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
    return { url: env.LIVEKIT_URL, token: await at.toJwt(), room, identity };
  });

  // ── Forge ──────────────────────────────────────────────────
  app.post('/api/forge', {
    config: { rateLimit: { max: 3, timeWindow: 1000, keyGenerator: (req) => (req.headers['x-session-id'] as string | undefined) ?? req.ip } },
  }, async (req, reply) => {
    let image: Buffer | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts({ limits: { fileSize: 4 * 1024 * 1024, files: 1 } })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'image') { await part.toBuffer(); continue; }
          image = await part.toBuffer();
          if (part.file.truncated) return bad(reply, 'too_large', 'image must be ≤ 4 MB', 413);
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (e) {
      return bad(reply, 'bad_multipart', errMsg(e), 400);
    }
    if (!image?.length) return bad(reply, 'no_image', 'multipart field "image" (jpeg) required');
    const sessionId = fields.sessionId;
    if (!sessionId) return bad(reply, 'no_session', 'sessionId required');
    const src = z.enum(['facetime', 'upload', 'test']).safeParse(fields.source ?? 'upload');
    const source: ForgeSource = src.success ? src.data : 'upload';
    const r = await forge(image, sessionId, source, { debug: fields.debug === '1' });
    return reply.code(r.status).send(r.body);
  });

  // ── Weapons & armory ───────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/weapons/:id/model.glb', async (req, reply) => {
    const w = await findWeapon(req.params.id).catch(() => null);
    if (!w) return bad(reply, 'not_found', 'weapon not found', 404);
    if (!w.glbFileId) return reply.redirect(`/prefabs/${w.weaponClass}.glb`);
    const f = await getFile('models', w.glbFileId.toHexString());
    if (!f) return bad(reply, 'not_found', 'model missing', 404);
    return reply.header('content-type', 'model/gltf-binary').header('cache-control', 'public, max-age=86400').send(f.buf);
  });

  app.get<{ Params: { id: string } }>('/api/weapons/:id/thumb.jpg', async (req, reply) => {
    const w = await findWeapon(req.params.id).catch(() => null);
    if (!w?.thumbFileId) return bad(reply, 'not_found', 'thumb not found', 404);
    const f = await getFile('thumbs', w.thumbFileId.toHexString());
    if (!f) return bad(reply, 'not_found', 'thumb missing', 404);
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=86400').send(f.buf);
  });

  app.get('/api/armory', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(req.query);
    const rows = await listWeapons(q.success ? q.data.limit : 50);
    return rows.map((w) => {
      const id = w._id.toHexString();
      return {
        weaponId: id, displayName: w.displayName, objectName: w.objectName, weaponClass: w.weaponClass,
        friendName: w.friendName, thumbUrl: w.thumbFileId ? `/api/weapons/${id}/thumb.jpg` : undefined,
        glbUrl: w.glbFileId ? `/api/weapons/${id}/model.glb` : `/prefabs/${w.weaponClass}.glb`,
        fallback: w.fallback, quip: w.quip, createdAt: w.createdAt, kills: w.kills,
      };
    });
  });

  // ── Matches & leaderboard ──────────────────────────────────
  app.post('/api/matches', async (req, reply) => {
    const b = z.object({
      sessionId: z.string(),
      playerName: z.string().trim().max(40).optional(),
      score: z.number().int().min(0).max(10_000_000),
      kills: z.number().int().min(0).max(10_000),
      trickshots: z.partialRecord(z.enum(trickshotKeys), z.number().int().min(0)).default({}),
      durationMs: z.number().int().min(0).max(60 * 60 * 1000),
      forgedWeaponIds: z.array(z.string()).max(50).default([]),
      weaponKills: z.record(z.string(), z.number().int().min(0)).optional(), // additive: per-weapon kills
    }).safeParse(req.body);
    if (!b.success) return bad(reply, 'invalid_body', b.error.issues[0]?.message ?? 'invalid');
    const s = getStore(); if (!s) return noDb(reply);
    const d = b.data;
    const sess = toOid(d.sessionId) ? await s.sessions.findOne({ _id: toOid(d.sessionId)! }) : null;
    const player = sess?.playerId ? await s.players.findOne({ _id: sess.playerId }) : null;
    const r = await s.matches.insertOne({
      sessionId: d.sessionId, playerId: sess?.playerId ?? null, playerName: player?.name ?? d.playerName ?? 'Odysseus',
      score: d.score, kills: d.kills, trickshots: d.trickshots, durationMs: d.durationMs,
      forgedWeaponIds: d.forgedWeaponIds.map(toOid).filter((x): x is NonNullable<typeof x> => x !== null),
      createdAt: new Date(),
    } as never);
    if (d.weaponKills) await addKills(d.weaponKills).catch((e) => log.warn({ err: errMsg(e) }, 'addKills failed'));
    if (sess) await s.sessions.updateOne({ _id: sess._id }, { $set: { endedAt: new Date() } });
    const rank = (await s.matches.countDocuments({ score: { $gt: d.score } })) + 1;
    return { matchId: r.insertedId.toHexString(), rank };
  });

  app.get('/api/leaderboard', async (req, reply) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) }).safeParse(req.query);
    const s = getStore(); if (!s) return noDb(reply);
    const limit = q.success ? q.data.limit : 10;
    // Best score per player (anonymous matches grouped by name).
    const rows = await s.matches.aggregate<{ playerName: string; score: number; trickshots: Record<string, number>; createdAt: Date }>([
      { $sort: { score: -1, createdAt: 1 } },
      { $group: { _id: { $ifNull: ['$playerId', '$playerName'] }, doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { score: -1, createdAt: 1 } },
      { $limit: limit },
      { $project: { _id: 0, playerName: 1, score: 1, trickshots: 1, createdAt: 1 } },
    ]).toArray();
    return rows;
  });

  // ── Killcams ───────────────────────────────────────────────
  app.post('/api/killcams', async (req, reply) => {
    const s = getStore(); if (!s) return noDb(reply);
    let video: Buffer | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of req.parts({ limits: { fileSize: 15 * 1024 * 1024, files: 1 } })) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          if (part.file.truncated) return bad(reply, 'too_large', 'video must be ≤ 15 MB', 413);
          if (part.fieldname === 'video') video = buf;
        } else if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      }
    } catch (e) {
      return bad(reply, 'bad_multipart', errMsg(e), 400);
    }
    if (!video?.length) return bad(reply, 'no_video', 'multipart field "video" (webm) required');
    if (!fields.sessionId || !fields.trickshot) return bad(reply, 'invalid_body', 'sessionId and trickshot required');
    const fileId = toOid(await putFile('clips', video, `${fields.sessionId}-${Date.now()}.webm`, 'video/webm'))!;
    const weaponId = toOid(fields.weaponId);
    const r = await s.killcams.insertOne({
      sessionId: fields.sessionId, trickshot: fields.trickshot.slice(0, 32), fileId,
      ...(weaponId ? { weaponId } : {}), createdAt: new Date(),
    } as never);
    const id = r.insertedId.toHexString();
    return { killcamId: id, url: `/api/killcams/${id}.webm` };
  });

  app.get<{ Params: { file: string } }>('/api/killcams/:file', async (req, reply) => {
    const id = toOid(req.params.file.replace(/\.webm$/, ''));
    const s = getStore();
    if (!s) return noDb(reply);
    const k = id ? await s.killcams.findOne({ _id: id }) : null;
    if (!k) return bad(reply, 'not_found', 'killcam not found', 404);
    const f = await getFile('clips', k.fileId.toHexString());
    if (!f) return bad(reply, 'not_found', 'clip missing', 404);
    return reply.header('content-type', 'video/webm').header('cache-control', 'public, max-age=86400').send(f.buf);
  });
}
