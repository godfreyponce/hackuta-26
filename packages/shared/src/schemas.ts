import { z } from 'zod';
import type { WebToServer, AgentToServer, ServerToWeb, ServerToAgent } from './protocol';

const weaponClass = z.enum(['spear', 'sword', 'blunt', 'throwable', 'shield', 'bomb', 'potion']);
const callState = z.enum(['idle', 'dialing', 'ringing', 'connected', 'ending', 'ended', 'failed']);
const scanState = z.enum(['idle', 'looking', 'detected', 'forging', 'done', 'failed']);
const trickshot = z.enum([
  'pin', 'ricochet', 'multi_kill', 'airborne', 'long_shot', 'headshot', 'friend_assist', 'return_to_sender',
]);
const gameEventKind = z.enum([
  'match_start', 'wave_start', 'wave_cleared', 'player_hit', 'health_low', 'player_pinned',
  'enemy_killed', 'trickshot', 'item_kill', 'boss_spawn', 'weapon_broken', 'match_end',
]);

export const gameEventSchema = z.object({
  kind: gameEventKind,
  t: z.number(),
  data: z.object({
    health: z.number().optional(),
    wave: z.number().optional(),
    enemiesLeft: z.number().optional(),
    trickshot: trickshot.optional(),
    weaponName: z.string().max(120).optional(),
    weaponId: z.string().max(64).optional(),
    score: z.number().optional(),
    combo: z.number().optional(),
    killer: z.literal('player').optional(),
  }).optional(),
});

export const weaponSpawnSchema = z.object({
  weaponId: z.string(),
  glbUrl: z.string(),
  weaponClass,
  objectName: z.string(),
  displayName: z.string(),
  friendName: z.string(),
  fallback: z.boolean(),
  thumbUrl: z.string().optional(),
});

const env = { v: z.literal(1), sessionId: z.string().min(1).max(128), ts: z.number() };

// ── Web → Server ──
export const webToServerSchema = z.discriminatedUnion('type', [
  z.object({ ...env, type: z.literal('hello'), role: z.literal('web') }),
  z.object({ ...env, type: z.literal('call.request'), friendId: z.string().min(1).max(64) }),
  z.object({ ...env, type: z.literal('call.end') }),
  z.object({ ...env, type: z.literal('game.event'), event: gameEventSchema }),
  z.object({ ...env, type: z.literal('scan.request') }),
]);

// ── Agent → Server ──
export const agentToServerSchema = z.discriminatedUnion('type', [
  z.object({ ...env, type: z.literal('hello'), role: z.literal('agent') }),
  z.object({
    ...env, type: z.literal('call.status'), state: callState,
    reason: z.string().optional(), callId: z.string().optional(), elapsedMs: z.number().optional(),
  }),
  z.object({
    ...env, type: z.literal('scan.status'), state: scanState,
    objectName: z.string().optional(), displayName: z.string().optional(), reason: z.string().optional(),
  }),
  z.object({ ...env, type: z.literal('narration'), text: z.string().max(400), priority: z.number() }),
]);

// ── Outbound (server → web / agent) — used for tests and the fake clients ──
export const serverToWebSchema = z.discriminatedUnion('type', [
  z.object({
    ...env, type: z.literal('call.status'), state: callState,
    reason: z.string().optional(), elapsedMs: z.number().optional(),
  }),
  z.object({
    ...env, type: z.literal('scan.status'), state: scanState,
    objectName: z.string().optional(), displayName: z.string().optional(), reason: z.string().optional(),
  }),
  z.object({
    ...env, type: z.literal('forge.progress'), forgeId: z.string(),
    stage: z.enum(['vision', 'crop', '3d', 'store']), pct: z.number(),
  }),
  z.object({ ...env, type: z.literal('weapon.spawn'), weapon: weaponSpawnSchema }),
  z.object({ ...env, type: z.literal('narration'), text: z.string(), priority: z.number() }),
  z.object({
    ...env, type: z.literal('armory.new'), weaponId: z.string(), displayName: z.string(),
    thumbUrl: z.string().optional(),
  }),
  z.object({ ...env, type: z.literal('error'), code: z.string(), message: z.string() }),
]);

export const serverToAgentSchema = z.discriminatedUnion('type', [
  z.object({
    ...env, type: z.literal('call.start'),
    friend: z.object({ id: z.string(), name: z.string(), phoneE164: z.string() }),
    gameRoom: z.string(),
  }),
  z.object({ ...env, type: z.literal('call.end'), reason: z.string() }),
  z.object({ ...env, type: z.literal('game.event'), event: gameEventSchema }),
  z.object({ ...env, type: z.literal('scan.request') }),
  z.object({ ...env, type: z.literal('weapon.spawn'), weapon: weaponSpawnSchema }),
]);

// Compile-time guard: schemas must stay assignable to the protocol types.
type _Check = [
  z.infer<typeof webToServerSchema> extends WebToServer ? true : never,
  z.infer<typeof agentToServerSchema> extends AgentToServer ? true : never,
  z.infer<typeof serverToWebSchema> extends ServerToWeb ? true : never,
  z.infer<typeof serverToAgentSchema> extends ServerToAgent ? true : never,
];
export type _SchemaCheck = _Check;

export const E164_RE = /^\+[1-9]\d{7,14}$/;
