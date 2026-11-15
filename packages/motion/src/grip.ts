// C.4 grip detection: finger curl → grip 0..1, hysteresis grab/release, release velocity.
import type { Hand, InputEvent, PlayerInputState, Vec3 } from '@ithaca/shared';
import { config } from './config';
import { clamp } from './math';
import { HANDS, type Body } from './mapping';
import { OneEuro } from './oneEuro';
import type { Profile } from './profile';
import type { RawLandmark } from './types';

/** [tip, mcp] per finger: index, middle, ring, pinky. */
export const FINGERS = [[8, 5], [12, 9], [16, 13], [20, 17]] as const;

const d3 = (a: RawLandmark | undefined, b: RawLandmark | undefined): number =>
  a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0;

/** curl = 1 − clamp(dist(tip, wrist) / dist(mcp, wrist) − 1, 0, 1), per finger. */
export function fingerCurls(lm: RawLandmark[], out: number[]): number[] {
  const w = lm[0];
  for (let f = 0; f < 4; f++) {
    const [tip, mcp] = FINGERS[f] as readonly [number, number];
    const dm = d3(lm[mcp], w);
    out[f] = dm > 1e-6 ? 1 - clamp(d3(lm[tip], w) / dm - 1, 0, 1) : 0;
  }
  return out;
}

/** Thumb tip distance from the index MCP, relative to palm size. ≳0.6 = thumb sticking out. */
export function thumbExtension(lm: RawLandmark[]): number {
  const palm = d3(lm[0], lm[5]);
  return palm > 1e-6 ? d3(lm[4], lm[5]) / palm : 0;
}

/** Hand-world landmarks are metric 3D, so they are the better input; image landmarks are a fallback. */
export function curlInput(lm: { world: RawLandmark[] | null; image: RawLandmark[] }): RawLandmark[] {
  return lm.world ?? lm.image;
}

interface VelSample { t: number; x: number; y: number; z: number }

class HandGrip {
  readonly filter = new OneEuro(4, 0);
  gripping = false;
  above = 0;
  below = 0;
  lostSince = -1;
  /** Ring buffer of recent velocities for release.vel. */
  readonly hist: VelSample[] = Array.from({ length: 32 }, () => ({ t: -1e9, x: 0, y: 0, z: 0 }));
  head = 0;

  push(t: number, v: Vec3): void {
    const s = this.hist[this.head] as VelSample;
    s.t = t; s.x = v.x; s.y = v.y; s.z = v.z;
    this.head = (this.head + 1) % this.hist.length;
  }

  /** Mean velocity over [now − lag − window, now − lag]. Falls back to the newest sample. */
  releaseVel(now: number): Vec3 {
    const hi = now - config.releaseLagMs;
    const lo = hi - config.releaseWindowMs;
    let n = 0, x = 0, y = 0, z = 0;
    for (const s of this.hist) {
      if (s.t >= lo && s.t <= hi) {
        n++; x += s.x; y += s.y; z += s.z;
      }
    }
    if (!n) {
      const last = this.hist[(this.head + this.hist.length - 1) % this.hist.length] as VelSample;
      return { x: last.x, y: last.y, z: last.z };
    }
    return { x: x / n, y: y / n, z: z / n };
  }
}

export class GripTracker {
  readonly hand: Record<Hand, HandGrip> = { left: new HandGrip(), right: new HandGrip() };

  reset(): void {
    for (const h of HANDS) {
      const g = this.hand[h];
      g.filter.reset();
      g.gripping = false;
      g.above = g.below = 0;
      g.lostSince = -1;
      for (const s of g.hist) s.t = -1e9;
    }
  }

  isGripping(h: Hand): boolean {
    return this.hand[h].gripping;
  }

  /**
   * @param handsSkipped  hand model didn't run this frame (perf mode) — hold everything.
   */
  update(
    body: Body,
    handsSkipped: boolean,
    profile: Profile,
    state: PlayerInputState,
    emit: (e: InputEvent) => void,
  ): void {
    const t = body.t;
    for (const h of HANDS) {
      const g = this.hand[h];
      const hs = state.hands[h];
      if (hs.visible) g.push(t, hs.vel);
      if (handsSkipped) continue;

      const hd = body.hand[h];
      if (!hd || !body.handFresh[h]) {
        // Hand landmarker lost this hand. Never drop a weapon on a tracking blip: hold the last grip
        // for gripHoldMs, then keep treating a closed hand as gripping until the hand comes back.
        if (g.lostSince < 0) g.lostSince = t;
        if (g.gripping && t - g.lostSince > config.gripHoldMs) hs.grip = 1;
        g.above = g.below = 0;
        continue;
      }
      g.lostSince = -1;

      const lm = curlInput(hd);
      const curls = fingerCurls(lm, body.curls[h]);
      const raw = ((curls[0] ?? 0) + (curls[1] ?? 0) + (curls[2] ?? 0) + (curls[3] ?? 0)) / 4;
      body.gripRaw[h] = raw;
      body.thumbExt[h] = thumbExtension(lm);
      const range = profile.grip[h];
      const norm = clamp((raw - range.min) / Math.max(range.max - range.min, 0.05), 0, 1);
      g.filter.minCutoff = config.gripMinCutoff;
      hs.grip = clamp(g.filter.filter(norm, body.dt), 0, 1);

      // Hysteresis: > gripOn for N frames → grab; < gripOff for N frames → release.
      const frames = Math.max(1, Math.round(config.gripFrames));
      if (!g.gripping) {
        g.above = hs.grip > config.gripOn ? g.above + 1 : 0;
        if (g.above >= frames) {
          g.gripping = true;
          g.above = 0;
          emit({ type: 'grab', hand: h });
        }
      } else {
        g.below = hs.grip < config.gripOff ? g.below + 1 : 0;
        if (g.below >= frames) {
          g.gripping = false;
          g.below = 0;
          emit({ type: 'release', hand: h, vel: g.releaseVel(t) });
        }
      }
    }
  }
}
