import type { Api, ArmoryItem, FriendPublic, Health, LeaderRow, LiveKitToken, MatchSubmit, SessionInfo } from './types';
import { ApiError } from './types';

const DEFAULT_TIMEOUT = 6000;

async function req<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetch(path, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    if (!res.ok) {
      const b = (body ?? {}) as { code?: string; message?: string; error?: string };
      throw new ApiError(b.code ?? `http_${res.status}`, b.message ?? b.error ?? res.statusText, res.status);
    }
    return body as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError') throw new ApiError('timeout', `${path} timed out`);
    throw new ApiError('network', (err as Error).message || 'network error');
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function createLiveApi(): Api {
  return {
    mode: 'live',
    health: () => req<Health>('/api/health', { timeoutMs: 2500 }),
    createPlayer: (name) => req('/api/players', json({ name })),
    addFriend: (body) => req<FriendPublic>('/api/friends', json(body)),
    listFriends: (playerId) => req<FriendPublic[]>(`/api/friends?playerId=${encodeURIComponent(playerId)}`),
    createSession: (playerId) => req<SessionInfo>('/api/sessions', json({ playerId })),
    livekitToken: (sessionId) => req<LiveKitToken>('/api/livekit/token', json({ sessionId })),
    armory: (limit = 50) => req<ArmoryItem[]>(`/api/armory?limit=${limit}`),
    submitMatch: (body: MatchSubmit) => req('/api/matches', json(body)),
    leaderboard: (limit = 10) => req<LeaderRow[]>(`/api/leaderboard?limit=${limit}`),
    uploadKillcam: (video, sessionId, trickshot, weaponId) => {
      const fd = new FormData();
      fd.append('video', video, `killcam-${trickshot}.webm`);
      fd.append('sessionId', sessionId);
      fd.append('trickshot', trickshot);
      if (weaponId) fd.append('weaponId', weaponId);
      return req('/api/killcams', { method: 'POST', body: fd, timeoutMs: 20000 });
    },
  };
}
