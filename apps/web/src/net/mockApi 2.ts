import type { WeaponClass, WeaponSpawn } from '@ithaca/shared';
import type { Api, ArmoryItem, FriendPublic, LeaderRow } from './types';
import { ApiError } from './types';
import { MOCK_OBJECTS, mockThumb } from './mockCatalog';

const LS_KEY = 'ithaca.mock.v1';

interface MockDb {
  players: Record<string, string>;
  friends: Record<string, FriendPublic & { playerId: string }>;
  leaderboard: LeaderRow[];
}

function load(): MockDb {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as MockDb;
  } catch { /* storage unavailable */ }
  return { players: {}, friends: {}, leaderboard: [] };
}
function save(db: MockDb) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch { /* ignore */ }
}

const id = () => Math.random().toString(16).slice(2, 14).padEnd(12, '0');
const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export const maskPhone = (e164: string) => `${e164.slice(0, 2)}•••••${e164.slice(-4)}`;

// Seeded "event armory" so the gallery is never empty in mock mode.
const SEED_FRIENDS = ['Telemachus', 'Eumaeus', 'Philoetius', 'Eurycleia', 'Mentor', 'Penelope'];
const armory: ArmoryItem[] = MOCK_OBJECTS.slice(0, 6).map((o, i) => ({
  weaponId: `seed-${i}`,
  displayName: o.displayName,
  objectName: o.objectName,
  weaponClass: o.weaponClass,
  friendName: SEED_FRIENDS[i % SEED_FRIENDS.length],
  thumbUrl: mockThumb(o.objectName, o.weaponClass),
  glbUrl: o.glbUrl,
  createdAt: new Date(Date.now() - (i + 1) * 47 * 60_000).toISOString(),
  kills: [7, 12, 3, 9, 1, 5][i] ?? 0,
}));

export function mockArmoryPush(w: WeaponSpawn) {
  armory.unshift({
    weaponId: w.weaponId,
    displayName: w.displayName,
    objectName: w.objectName,
    weaponClass: w.weaponClass as WeaponClass,
    friendName: w.friendName,
    thumbUrl: w.thumbUrl,
    glbUrl: w.glbUrl,
    createdAt: new Date().toISOString(),
    kills: 0,
  });
}

const SEED_BOARD: LeaderRow[] = [
  { playerName: 'Eurycleia', score: 14250, trickshots: { pin: 4, headshot: 6 }, createdAt: new Date().toISOString() },
  { playerName: 'Mentor', score: 9800, trickshots: { multi_kill: 2, long_shot: 5 }, createdAt: new Date().toISOString() },
  { playerName: 'Eumaeus', score: 6400, trickshots: { headshot: 3 }, createdAt: new Date().toISOString() },
];

export function createMockApi(): Api {
  const db = load();
  return {
    mode: 'mock',
    health: () => delay({ ok: true, mongo: false, agentConnected: false }),
    async createPlayer(name) {
      const playerId = id();
      db.players[playerId] = name;
      save(db);
      return delay({ playerId });
    },
    async addFriend({ playerId, name, phoneE164, consent }) {
      if (consent !== true) throw new ApiError('consent_required', 'Consent is required');
      if (!/^\+[1-9]\d{7,14}$/.test(phoneE164)) throw new ApiError('invalid_phone', 'Phone must be E.164, e.g. +15551234567');
      const f = { friendId: id(), name, phoneMasked: maskPhone(phoneE164), playerId };
      db.friends[f.friendId] = f;
      save(db);
      return delay({ friendId: f.friendId, name: f.name, phoneMasked: f.phoneMasked });
    },
    listFriends: (playerId) =>
      delay(Object.values(db.friends).filter((f) => f.playerId === playerId).map(({ friendId, name, phoneMasked }) => ({ friendId, name, phoneMasked }))),
    createSession: () => { const sid = id(); return delay({ sessionId: sid, gameRoom: `game-${sid}` }); },
    livekitToken: () => Promise.reject(new ApiError('mock', 'No LiveKit in mock mode')),
    armory: (limit = 50) => delay(armory.slice(0, limit)),
    async submitMatch(body) {
      const row: LeaderRow = { playerName: body.playerName ?? 'Odysseus', score: body.score, trickshots: body.trickshots, createdAt: new Date().toISOString() };
      db.leaderboard.push(row);
      db.leaderboard.sort((a, b) => b.score - a.score);
      db.leaderboard = db.leaderboard.slice(0, 50);
      save(db);
      const all = [...db.leaderboard, ...SEED_BOARD].sort((a, b) => b.score - a.score);
      return delay({ matchId: id(), rank: all.findIndex((r) => r === row) + 1 });
    },
    leaderboard: (limit = 10) => delay([...db.leaderboard, ...SEED_BOARD].sort((a, b) => b.score - a.score).slice(0, limit)),
    uploadKillcam: (video) => delay({ killcamId: id(), url: URL.createObjectURL(video) }, 300),
  };
}
