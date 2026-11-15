// Zod mirror of ServerToAgent (spec 4.1). Swap to @ithaca/shared/schemas when Part D pushes it.
import { z } from 'zod';
import type { ServerToAgent } from './protocol.ts';

const env = { v: z.literal(1), sessionId: z.string(), ts: z.number() };

const weaponClass = z.enum(['spear', 'sword', 'blunt', 'throwable', 'shield', 'bomb', 'potion']);

const gameEvent = z.object({
  kind: z.enum([
    'match_start', 'wave_start', 'wave_cleared', 'player_hit', 'health_low', 'player_pinned',
    'enemy_killed', 'trickshot', 'item_kill', 'boss_spawn', 'weapon_broken', 'match_end',
  ]),
  t: z.number(),
  data: z.object({
    health: z.number().optional(),
    wave: z.number().optional(),
    enemiesLeft: z.number().optional(),
    trickshot: z.enum([
      'pin', 'ricochet', 'multi_kill', 'airborne', 'long_shot', 'headshot', 'friend_assist', 'return_to_sender',
    ]).optional(),
    weaponName: z.string().optional(),
    weaponId: z.string().optional(),
    score: z.number().optional(),
    combo: z.number().optional(),
    killer: z.literal('player').optional(),
  }).optional(),
});

const weaponSpawn = z.object({
  weaponId: z.string(),
  glbUrl: z.string(),
  weaponClass,
  objectName: z.string(),
  displayName: z.string(),
  friendName: z.string(),
  fallback: z.boolean(),
  thumbUrl: z.string().optional(),
});

export const serverToAgent = z.discriminatedUnion('type', [
  z.object({
    ...env, type: z.literal('call.start'),
    friend: z.object({ id: z.string(), name: z.string(), phoneE164: z.string() }),
    gameRoom: z.string(),
  }),
  // Web sends call.end {} and the hub forwards it unchanged, so reason can be missing.
  z.object({ ...env, type: z.literal('call.end'), reason: z.string().default('web_ended') }),
  z.object({ ...env, type: z.literal('game.event'), event: gameEvent }),
  z.object({ ...env, type: z.literal('scan.request') }),
  z.object({ ...env, type: z.literal('weapon.spawn'), weapon: weaponSpawn }),
]);

// Compile-time check that the schema and the spec type agree.
type Parsed = z.infer<typeof serverToAgent>;
const _sameShape: (x: Parsed) => ServerToAgent = (x) => x;
void _sameShape;
