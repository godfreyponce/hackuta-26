// C.7 recordings: {t, poseWorld, poseImage, hands} per frame, as JSON.
import type { InputEvent } from '@ithaca/shared';
import { Engine } from './engine';
import type { Profile } from './profile';
import type { RawFrame, RawHand, RawLandmark, Recording } from './types';

/** 5 min at 60 fps. Older frames are dropped beyond this. */
const MAX_FRAMES = 18000;

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3;

function packLandmarks(lm: RawLandmark[] | null): RawLandmark[] | null {
  if (!lm) return null;
  return lm.map((p) =>
    p.visibility === undefined
      ? { x: r4(p.x), y: r4(p.y), z: r4(p.z) }
      : { x: r4(p.x), y: r4(p.y), z: r4(p.z), visibility: r3(p.visibility) },
  );
}

function packHand(h: RawHand): RawHand {
  return {
    image: packLandmarks(h.image) ?? [],
    world: packLandmarks(h.world),
    label: h.label,
    score: r3(h.score),
  };
}

/** Copies + rounds frames (MediaPipe result objects must not be kept around). */
export class Recorder {
  private frames: RawFrame[] = [];
  private t0 = -1;
  private active = false;
  private meta: Recording['meta'] | null = null;

  get recording(): boolean {
    return this.active;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get durationMs(): number {
    const last = this.frames[this.frames.length - 1];
    return last ? last.t : 0;
  }

  start(meta: Omit<Recording['meta'], 'createdAt'>): void {
    this.frames = [];
    this.t0 = -1;
    this.active = true;
    this.meta = { ...meta, createdAt: new Date().toISOString() };
  }

  push(f: RawFrame): void {
    if (!this.active) return;
    if (this.t0 < 0) this.t0 = f.t;
    this.frames.push({
      t: Math.round((f.t - this.t0) * 10) / 10,
      poseWorld: packLandmarks(f.poseWorld),
      poseImage: packLandmarks(f.poseImage),
      hands: f.hands ? f.hands.map(packHand) : null,
    });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  stop(): Recording | null {
    if (!this.active || !this.meta) return null;
    this.active = false;
    const rec: Recording = { version: 1, meta: this.meta, frames: this.frames };
    this.frames = [];
    return rec;
  }
}

export function parseRecording(input: string | unknown): Recording {
  const data: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  const rec = data as Partial<Recording> | null;
  if (!rec || rec.version !== 1 || !Array.isArray(rec.frames) || !rec.meta) {
    throw new Error('Not an ITHACA motion recording (expected { version: 1, meta, frames }).');
  }
  if (typeof rec.meta.aspect !== 'number' || !(rec.meta.aspect > 0)) throw new Error('Recording meta.aspect missing.');
  for (const f of rec.frames) {
    if (typeof f?.t !== 'number') throw new Error('Recording frame without t.');
  }
  return rec as Recording;
}

export interface ReplayRunResult {
  events: { t: number; event: InputEvent }[];
  durationMs: number;
  engine: Engine;
}

/**
 * Runs a recording through a fresh Engine as fast as possible — deterministic, for tuning and tests.
 * `config` overrides are not applied here; mutate `config` before calling.
 */
export function runReplay(recording: Recording, profile?: Profile | null): ReplayRunResult {
  const engine = new Engine(profile ?? null);
  engine.aspect = recording.meta.aspect;
  const events: ReplayRunResult['events'] = [];
  let now = 0;
  engine.on((event) => events.push({ t: now, event }));
  engine.begin();
  for (const f of recording.frames) {
    now = f.t;
    engine.push(f, f.t);
  }
  return { events, durationMs: recording.frames[recording.frames.length - 1]?.t ?? 0, engine };
}

/** Browser helper: save a recording as a .json download. */
export function downloadRecording(rec: Recording, name?: string): void {
  const label = (name ?? rec.meta.label ?? 'motion').replace(/[^\w-]+/g, '_');
  const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${label}-${rec.meta.createdAt.replace(/[:.]/g, '-')}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
