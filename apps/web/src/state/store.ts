import { create } from 'zustand';
import type { CallState, ScanState, TrickshotKind, WeaponSpawn, WeaponClass } from '@ithaca/shared';
import type { FriendPublic, HubStatus } from '../net/types';
import type { InputKind } from '../input';

export type Screen = 'title' | 'setup' | 'calibration' | 'lobby' | 'game' | 'results' | 'armory' | 'leaderboard';
export type Difficulty = 'easy' | 'normal';

export interface Toast { id: number; kind: 'trickshot' | 'info' | 'gift' | 'wave' | 'warn'; title: string; sub?: string; points?: number; at: number }
export interface Narration { id: number; text: string; at: number; priority: number }
export interface KillcamClip { url: string; trickshot: TrickshotKind; at: number; weaponName?: string }
export interface ForgedUse { weaponId: string; displayName: string; objectName: string; weaponClass: WeaponClass; thumbUrl?: string; kills: number; fallback: boolean }

export interface MatchResults {
  score: number; kills: number; durationMs: number; victory: boolean;
  trickshots: Record<TrickshotKind, number>;
  forged: ForgedUse[];
  bestCombo: number;
  wave: number;
}

export interface Hud {
  health: number; wave: number; waveTitle: string; enemiesLeft: number;
  score: number; combo: number; kills: number;
  blocking: boolean; bowDraw: number; slowmo: boolean;
  pinnedPrompt: boolean; boss: { name: string; hp: number; shield: number; posture?: number } | null;
  bossIntro: { name: string; epithet: string; at: number } | null;
  tally: { total: number; killed: number };
  posture: number;
  matchTimeMs: number; intermission: string | null;
}

const emptyTrick = (): Record<TrickshotKind, number> => ({
  pin: 0, ricochet: 0, multi_kill: 0, airborne: 0, long_shot: 0, headshot: 0, friend_assist: 0, return_to_sender: 0,
});
export const emptyTrickshots = emptyTrick;

export const initialHud = (): Hud => ({
  health: 100, wave: 0, waveTitle: '', enemiesLeft: 0, score: 0, combo: 1, kills: 0,
  blocking: false, bowDraw: 0, slowmo: false, pinnedPrompt: false, boss: null, bossIntro: null, tally: { total: 0, killed: 0 }, posture: 0, matchTimeMs: 0, intermission: null,
});

export interface AppState {
  screen: Screen;
  prevScreen: Screen;
  go: (s: Screen) => void;

  netMode: 'live' | 'mock' | 'pending';
  netReason?: string;
  hubStatus: HubStatus;

  player: { id: string; name: string } | null;
  friend: FriendPublic | null;
  session: { id: string; gameRoom: string } | null;
  difficulty: Difficulty;

  inputKind: InputKind;
  inputFallback?: string;
  tracking: 'ok' | 'degraded' | 'lost' | 'calibrating' | 'off';
  pendingGesture: { name: string; progress: number } | null;
  bowMode: boolean;

  call: { state: CallState; reason?: string; connectedAt?: number; elapsedMs?: number };
  mediaStatus: 'absent' | 'connecting' | 'live' | 'failed';
  friendCam: HTMLVideoElement | null;
  micEnabled: boolean;

  scan: { state: ScanState; objectName?: string; displayName?: string; reason?: string; pct: number; stage?: string; at: number };
  lastForged: WeaponSpawn | null;
  incoming: WeaponSpawn | null;  // forge overlay card content

  narration: Narration[];
  toasts: Toast[];
  hud: Hud;
  paused: boolean;
  killcams: KillcamClip[];
  results: MatchResults | null;
  submitted: { rank: number } | null;
  armoryPulse: number;
  newestWeaponId: string | null;
}

let toastId = 1;
let narrId = 1;

export const useApp = create<AppState>()(() => ({
  screen: 'title',
  prevScreen: 'title',
  go: (s) => useApp.setState((st) => ({ screen: s, prevScreen: st.screen })),

  netMode: 'pending',
  hubStatus: 'idle',

  player: null,
  friend: null,
  session: null,
  difficulty: 'normal',

  inputKind: (import.meta.env.VITE_INPUT as InputKind | undefined) ?? 'keyboard_mouse',
  tracking: 'ok',
  pendingGesture: null,
  bowMode: false,

  call: { state: 'idle' },
  mediaStatus: 'absent',
  friendCam: null,
  micEnabled: true,

  scan: { state: 'idle', pct: 0, at: 0 },
  lastForged: null,
  incoming: null,

  narration: [],
  toasts: [],
  hud: initialHud(),
  paused: false,
  killcams: [],
  results: null,
  submitted: null,
  armoryPulse: 0,
  newestWeaponId: null,
}));

export function pushToast(t: Omit<Toast, 'id' | 'at'>, ttlMs = 1700) {
  const toast: Toast = { ...t, id: toastId++, at: performance.now() };
  useApp.setState((s) => ({ toasts: [...s.toasts.slice(-4), toast] }));
  setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== toast.id) })), ttlMs);
}

export function pushNarration(text: string, priority: number) {
  const n: Narration = { id: narrId++, text, priority, at: performance.now() };
  useApp.setState((s) => ({ narration: [...s.narration.slice(-3), n] }));
}

/** Subtitle display duration per accessibility guidance: max(1s, chars/17) + 0.3s, capped at 7s. */
export const subtitleMs = (text: string) => Math.min(7000, Math.max(1000, (text.length / 17) * 1000) + 300);

export const setHud = (patch: Partial<Hud>) => useApp.setState((s) => ({ hud: { ...s.hud, ...patch } }));

export const isCallLive = (s: CallState) => s === 'dialing' || s === 'ringing' || s === 'connected';
