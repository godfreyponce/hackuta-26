export const PROTOCOL_VERSION = 1;

export type WeaponClass =
  | 'spear' | 'sword' | 'blunt' | 'throwable' | 'shield' | 'bomb' | 'potion';

export type CallState =
  | 'idle' | 'dialing' | 'ringing' | 'connected' | 'ending' | 'ended' | 'failed';

export type ScanState =
  | 'idle' | 'looking' | 'detected' | 'forging' | 'done' | 'failed';

export type TrickshotKind =
  | 'pin' | 'ricochet' | 'multi_kill' | 'airborne' | 'long_shot'
  | 'headshot' | 'friend_assist' | 'return_to_sender';

export type GameEventKind =
  | 'match_start' | 'wave_start' | 'wave_cleared' | 'player_hit' | 'health_low'
  | 'player_pinned' | 'enemy_killed' | 'trickshot' | 'item_kill' | 'boss_spawn'
  | 'weapon_broken' | 'match_end';

export interface GameEvent {
  kind: GameEventKind;
  t: number;                 // ms since match start
  data?: {
    health?: number;         // 0..100
    wave?: number;
    enemiesLeft?: number;
    trickshot?: TrickshotKind;
    weaponName?: string;     // e.g. "Frying Pan of Ithaca"
    weaponId?: string;
    score?: number;
    combo?: number;
    killer?: 'player';
  };
}

export interface WeaponSpawn {
  weaponId: string;          // Mongo ObjectId hex, or "prefab-<class>"
  glbUrl: string;            // "/api/weapons/<id>/model.glb" or "/prefabs/<class>.glb"
  weaponClass: WeaponClass;
  objectName: string;        // raw: "frying pan"
  displayName: string;       // flavored: "The Pan of Telemachus"
  friendName: string;        // "Telemachus" or the friend's actual name
  fallback: boolean;         // true = prefab used (3D gen failed/slow)
  thumbUrl?: string;         // cropped photo of the real object
}

type Envelope<T extends string, P> = { v: 1; type: T; sessionId: string; ts: number } & P;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type Empty = {};

// ── Web → Server ───────────────────────────────────────────────
export type WebToServer =
  | Envelope<'hello', { role: 'web' }>
  | Envelope<'call.request', { friendId: string }>
  | Envelope<'call.end', Empty>
  | Envelope<'game.event', { event: GameEvent }>
  | Envelope<'scan.request', Empty>;          // player wants a weapon from Telemachus

// ── Agent → Server ─────────────────────────────────────────────
export type AgentToServer =
  | Envelope<'hello', { role: 'agent' }>   // sessionId = "*" for agent hello
  | Envelope<'call.status', { state: CallState; reason?: string; callId?: string; elapsedMs?: number }>
  | Envelope<'scan.status', { state: ScanState; objectName?: string; displayName?: string; reason?: string }>
  | Envelope<'narration', { text: string; priority: number }>;   // subtitles for HUD

// ── Server → Web ───────────────────────────────────────────────
export type ServerToWeb =
  | Envelope<'call.status', { state: CallState; reason?: string; elapsedMs?: number }>
  | Envelope<'scan.status', { state: ScanState; objectName?: string; displayName?: string; reason?: string }>
  | Envelope<'forge.progress', { forgeId: string; stage: 'vision' | 'crop' | '3d' | 'store'; pct: number }>
  | Envelope<'weapon.spawn', { weapon: WeaponSpawn }>
  | Envelope<'narration', { text: string; priority: number }>
  | Envelope<'armory.new', { weaponId: string; displayName: string; thumbUrl?: string }>
  | Envelope<'error', { code: string; message: string }>;

// ── Server → Agent ─────────────────────────────────────────────
export type ServerToAgent =
  | Envelope<'call.start', { friend: { id: string; name: string; phoneE164: string }; gameRoom: string }>
  | Envelope<'call.end', { reason: string }>
  | Envelope<'game.event', { event: GameEvent }>
  | Envelope<'scan.request', Empty>
  | Envelope<'weapon.spawn', { weapon: WeaponSpawn }>;
