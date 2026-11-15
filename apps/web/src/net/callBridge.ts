// Glue between Part A and Part B's browser LiveKit module (apps/web/src/call/, owned by B).
// The module is optional at build time: until B lands it, the glob is empty and calls are UI-only.
import type { Api } from './types';

/** Spec §B.8 — implemented by Part B in apps/web/src/call/index.ts */
export interface CallMedia {
  connect(opts: { url: string; token: string }): Promise<void>;
  publishFriendView(stream: MediaStream): Promise<void>;
  publishMic(): Promise<void>;
  setMicEnabled(on: boolean): void;
  onFriendCam(cb: (el: HTMLVideoElement | null) => void): () => void;
  onFriendAudio(cb: (playing: boolean) => void): () => void;
  disconnect(): Promise<void>;
  /** optional (B.8 autoplay note): resume audio after a user gesture */
  startAudio?(): Promise<void>;
}

type CallModule = { createCallMedia?: () => CallMedia };
const callModules = import.meta.glob<CallModule>('../call/index.ts');

export type MediaStatus = 'absent' | 'connecting' | 'live' | 'failed';

export interface CallBridge {
  status: MediaStatus;
  error?: string;
  media: CallMedia | null;
}

let bridge: CallBridge = { status: 'absent', media: null };
const subs = new Set<(b: CallBridge) => void>();
const set = (b: Partial<CallBridge>) => { bridge = { ...bridge, ...b }; subs.forEach((cb) => cb(bridge)); };

export const getCallBridge = () => bridge;
export const onCallBridge = (cb: (b: CallBridge) => void) => { subs.add(cb); cb(bridge); return () => { subs.delete(cb); }; };

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

/**
 * Join the game room and publish friend-view + player-mic. Safe to call repeatedly; never throws.
 */
export async function connectCallMedia(api: Api, sessionId: string, friendView: MediaStream): Promise<CallBridge> {
  if (bridge.status === 'live' || bridge.status === 'connecting') return bridge;
  const loader = Object.values(callModules)[0];
  if (!loader || api.mode === 'mock') { set({ status: 'absent' }); return bridge; }
  set({ status: 'connecting', error: undefined });
  try {
    const mod = await loader();
    if (!mod.createCallMedia) throw new Error('call module has no createCallMedia');
    const media = mod.createCallMedia();
    const tok = await api.livekitToken(sessionId);
    await withTimeout(media.connect({ url: tok.url, token: tok.token }), 10000, 'LiveKit connect');
    await withTimeout(media.publishFriendView(friendView), 8000, 'publish friend-view');
    await withTimeout(media.publishMic(), 8000, 'publish mic').catch((err) => console.warn('[call] mic publish failed', err));
    set({ status: 'live', media });
  } catch (err) {
    console.warn('[call] media unavailable', err);
    set({ status: 'failed', error: (err as Error).message, media: null });
  }
  return bridge;
}

export async function disconnectCallMedia() {
  const m = bridge.media;
  set({ status: 'absent', media: null });
  try { await m?.disconnect(); } catch { /* ignore */ }
}
