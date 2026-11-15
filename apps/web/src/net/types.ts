import type { ServerToWeb, WebToServer, WeaponClass, TrickshotKind } from '@ithaca/shared';

/** A WebToServer message without its envelope fields (the hub adds v/sessionId/ts). */
export type Outgoing = WebToServer extends infer M
  ? M extends { type: string } ? Omit<M, 'v' | 'sessionId' | 'ts'> : never
  : never;

export type HubStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Hub {
  readonly mode: 'live' | 'mock';
  connect(sessionId: string): void;
  send(msg: Outgoing): void;
  on(cb: (m: ServerToWeb) => void): () => void;
  onStatus(cb: (s: HubStatus) => void): () => void;
  status(): HubStatus;
  close(): void;
}

export interface Health { ok: boolean; mongo: boolean; agentConnected: boolean }
export interface FriendPublic { friendId: string; name: string; phoneMasked: string }
export interface SessionInfo { sessionId: string; gameRoom: string }
export interface LiveKitToken { url: string; token: string; room: string; identity: string }
export interface ArmoryItem {
  weaponId: string; displayName: string; objectName: string; weaponClass: WeaponClass;
  friendName: string; thumbUrl?: string; glbUrl: string; createdAt: string; kills: number;
}
export interface LeaderRow { playerName: string; score: number; trickshots: Partial<Record<TrickshotKind, number>>; createdAt: string }
export interface MatchSubmit {
  sessionId: string; score: number; kills: number;
  trickshots: Record<TrickshotKind, number>; durationMs: number; forgedWeaponIds: string[];
  /** additive (A): per-forged-weapon kill counts so D can $inc weapons.kills */
  weaponKills?: Record<string, number>;
  playerName?: string;
}

export interface Api {
  readonly mode: 'live' | 'mock';
  health(): Promise<Health>;
  createPlayer(name: string): Promise<{ playerId: string }>;
  addFriend(body: { playerId: string; name: string; phoneE164: string; consent: true }): Promise<FriendPublic>;
  listFriends(playerId: string): Promise<FriendPublic[]>;
  createSession(playerId: string): Promise<SessionInfo>;
  livekitToken(sessionId: string): Promise<LiveKitToken>;
  armory(limit?: number): Promise<ArmoryItem[]>;
  submitMatch(body: MatchSubmit): Promise<{ matchId: string; rank: number }>;
  leaderboard(limit?: number): Promise<LeaderRow[]>;
  uploadKillcam(video: Blob, sessionId: string, trickshot: TrickshotKind, weaponId?: string): Promise<{ killcamId: string; url: string }>;
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message); }
}
