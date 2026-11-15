// zod schemas mirroring protocol.ts. Keep in lockstep (additive only).
import { z } from 'zod';

export const WeaponClassSchema = z.enum(['spear', 'sword', 'blunt', 'throwable', 'shield', 'bomb', 'potion']);
export const CallStateSchema = z.enum(['idle', 'dialing', 'ringing', 'connected', 'ending', 'ended', 'failed']);
export const ScanStateSchema = z.enum(['idle', 'looking', 'detected', 'forging', 'done', 'failed']);
export const TrickshotKindSchema = z.enum([
  'pin', 'ricochet', 'multi_kill', 'airborne', 'long_shot', 'headshot', 'friend_assist', 'return_to_sender',
]);
export const GameEventKindSchema = z.enum([
  'match_start', 'wave_start', 'wave_cleared', 'player_hit', 'health_low', 'player_pinned',
  'enemy_killed', 'trickshot', 'item_kill', 'boss_spawn', 'weapon_broken', 'match_end',
]);

export const GameEventSchema = z.object({
  kind: GameEventKindSchema,
  t: z.number(),
  data: z
    .object({
      health: z.number().optional(),
      wave: z.number().optional(),
      enemiesLeft: z.number().optional(),
      trickshot: TrickshotKindSchema.optional(),
      weaponName: z.string().optional(),
      weaponId: z.string().optional(),
      score: z.number().optional(),
      combo: z.number().optional(),
      killer: z.literal('player').optional(),
    })
    .optional(),
});

export const WeaponSpawnSchema = z.object({
  weaponId: z.string(),
  glbUrl: z.string(),
  weaponClass: WeaponClassSchema,
  objectName: z.string(),
  displayName: z.string(),
  friendName: z.string(),
  fallback: z.boolean(),
  thumbUrl: z.string().optional(),
});

const env = <T extends string>(type: T) =>
  z.object({ v: z.literal(1), type: z.literal(type), sessionId: z.string(), ts: z.number() });

// ── Web → Server ──
export const WebToServerSchema = z.discriminatedUnion('type', [
  env('hello').extend({ role: z.literal('web') }),
  env('call.request').extend({ friendId: z.string() }),
  env('call.end'),
  env('game.event').extend({ event: GameEventSchema }),
  env('scan.request'),
]);

// ── Agent → Server ──
export const AgentToServerSchema = z.discriminatedUnion('type', [
  env('hello').extend({ role: z.literal('agent') }),
  env('call.status').extend({
    state: CallStateSchema, reason: z.string().optional(), callId: z.string().optional(), elapsedMs: z.number().optional(),
  }),
  env('scan.status').extend({
    state: ScanStateSchema, objectName: z.string().optional(), displayName: z.string().optional(), reason: z.string().optional(),
  }),
  env('narration').extend({ text: z.string(), priority: z.number() }),
]);

// ── Server → Web ──
export const ServerToWebSchema = z.discriminatedUnion('type', [
  env('call.status').extend({ state: CallStateSchema, reason: z.string().optional(), elapsedMs: z.number().optional() }),
  env('scan.status').extend({
    state: ScanStateSchema, objectName: z.string().optional(), displayName: z.string().optional(), reason: z.string().optional(),
  }),
  env('forge.progress').extend({
    forgeId: z.string(), stage: z.enum(['vision', 'crop', '3d', 'store']), pct: z.number(),
  }),
  env('weapon.spawn').extend({ weapon: WeaponSpawnSchema }),
  env('narration').extend({ text: z.string(), priority: z.number() }),
  env('armory.new').extend({ weaponId: z.string(), displayName: z.string(), thumbUrl: z.string().optional() }),
  env('error').extend({ code: z.string(), message: z.string() }),
]);

// ── Server → Agent ──
export const ServerToAgentSchema = z.discriminatedUnion('type', [
  env('call.start').extend({
    friend: z.object({ id: z.string(), name: z.string(), phoneE164: z.string() }),
    gameRoom: z.string(),
  }),
  env('call.end').extend({ reason: z.string() }),
  env('game.event').extend({ event: GameEventSchema }),
  env('scan.request'),
  env('weapon.spawn').extend({ weapon: WeaponSpawnSchema }),
]);
