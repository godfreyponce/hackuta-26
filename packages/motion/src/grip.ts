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

/** Hand-world landmarks (metric 3D) when present, else image landmarks. Thumb / palm-normal input. */
export function curlInput(lm: { world: RawLandmark[] | null; image: RawLandmark[] }): RawLandmark[] {
  return lm.world ?? lm.image;
}

const imgBuf: RawLandmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
const curlI = [0, 0, 0, 0];
const curlW = [0, 0, 0, 0];

/**
 * Per-finger curl that holds up at webcam distance. Hand-world landmarks are a learned 3D guess: an open
 * hand whose fingers point at / away from the camera reads 0.4-0.8 "curled" there (throw + bow fixtures),
 * so the hand never opens. A projection can only shorten a finger, so when the IMAGE landmarks
 * (aspect-corrected; MediaPipe's image z uses x's scale) show the tip well past the knuckle, the finger is
 * extended. When the image shows it short, it is curled OR foreshortened, and hand-world decides (max).
 */
export function fusedCurls(hd: { world: RawLandmark[] | null; image: RawLandmark[] }, aspect: number, out: number[]): number[] {
  for (let i = 0; i < 21; i++) {
    const p = hd.image[i], q = imgBuf[i] as RawLandmark;
    if (!p) continue;
    q.x = p.x * aspect;
    q.y = p.y;
    q.z = p.z * aspect;
  }
  fingerCurls(imgBuf, curlI);
  if (hd.world) fingerCurls(hd.world, curlW);
  const lo = config.gripImgOpenCurl, span = Math.max(config.gripImgShortCurl - lo, 0.01);
  for (let f = 0; f < 4; f++) {
    const ci = curlI[f] ?? 0;
    const cw = hd.world ? (curlW[f] ?? 0) : ci;
    const k = clamp((ci - lo) / span, 0, 1);
    out[f] = ci + (Math.max(ci, cw) - ci) * k;
  }
  return out;
}

/** v = filtered 3D hand velocity; s = max(|v|, image-plane wrist speed). */
interface VelSample { t: number; x: number; y: number; z: number; s: number }

class HandGrip {
  readonly filter = new OneEuro(4, 0);
  gripping = false;
  above = 0;
  below = 0;
  lostSince = -1;
  /** body.t of the last frame the hand model saw this hand (the grip filter runs at the hand rate). */
  lastSeenT = -1;
  /** Ring buffer of recent velocities for release.vel. */
  readonly hist: VelSample[] = Array.from({ length: 64 }, () => ({ t: -1e9, x: 0, y: 0, z: 0, s: 0 }));
  head = 0;
  /** Last stretch where the hand model lost this hand (motion blur during a throw). */
  lastLostFrom = -1;
  lastLostTo = -1;

  push(t: number, v: Vec3, imgSpeed: number): void {
    const s = this.hist[this.head] as VelSample;
    s.t = t; s.x = v.x; s.y = v.y; s.z = v.z;
    s.s = Math.max(Math.hypot(v.x, v.y, v.z), imgSpeed);
    this.head = (this.head + 1) % this.hist.length;
  }

  /**
   * Throw velocity. The open hand is usually detected after the arm has already stopped (grip
   * filter + hysteresis lag, and the hand landmarker loses a fast-moving hand to motion blur), so
   * the last 80 ms are near zero. Instead: find the PEAK speed in the last releasePeakWindowMs —
   * extended back over a recent hand-lost stretch — and average releaseWindowMs around that peak.
   * Speed also counts image-plane wrist motion, so a throw the depth axis under-reads still registers;
   * the direction comes from the 3D velocity (or the forearm if that is ~0).
   */
  releaseVel(now: number, forward: Vec3): Vec3 {
    const hi = now - config.releaseLagMs;
    let lo = hi - config.releasePeakWindowMs;
    if (this.lastLostTo >= 0 && now - this.lastLostTo < config.releasePeakWindowMs) {
      lo = Math.max(Math.min(lo, this.lastLostFrom - 50), hi - config.releaseMaxLookbackMs);
    }
    let peak: VelSample | null = null;
    for (const s of this.hist) if (s.t >= lo && s.t <= hi && (!peak || s.s > peak.s)) peak = s;
    if (!peak) {
      const last = this.hist[(this.head + this.hist.length - 1) % this.hist.length] as VelSample;
      return { x: last.x, y: last.y, z: last.z };
    }
    const half = config.releaseWindowMs / 2;
    let n = 0, x = 0, y = 0, z = 0, sp = 0;
    for (const s of this.hist) {
      if (s.t >= lo && s.t <= hi && Math.abs(s.t - peak.t) <= half) {
        n++; x += s.x; y += s.y; z += s.z; sp += s.s;
      }
    }
    x /= n; y /= n; z /= n; sp /= n;
    const m = Math.hypot(x, y, z);
    const mag = Math.max(m, sp);
    if (m > 0.3) return { x: (x / m) * mag, y: (y / m) * mag, z: (z / m) * mag };
    const fl = Math.hypot(forward.x, forward.y, forward.z) || 1;
    return { x: (forward.x / fl) * mag, y: (forward.y / fl) * mag, z: (forward.z / fl) * mag };
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
      g.lostSince = g.lastLostFrom = g.lastLostTo = g.lastSeenT = -1;
      for (const s of g.hist) s.t = -1e9;
    }
  }

  /**
   * Start fresh but with the latch set to what the game actually holds: `keep[h]` true = the game holds
   * something in that hand, so the next open hand releases it; false = the next fist is a new grab.
   */
  resync(keep: Record<Hand, boolean>): void {
    this.reset();
    for (const h of HANDS) this.hand[h].gripping = !!keep[h];
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
      if (hs.visible) g.push(t, hs.vel, body.wristImgSpeed[h]);
      if (handsSkipped || !body.handRan[h]) continue;

      const hd = body.hand[h];
      if (!hd || !body.handFresh[h]) {
        // Hand landmarker lost this hand. Never drop a weapon on a tracking blip: hold the last grip
        // for gripHoldMs, then keep treating a closed hand as gripping until the hand comes back.
        if (g.lostSince < 0) g.lostSince = t;
        if (g.gripping && t - g.lostSince > config.gripHoldMs) hs.grip = 1;
        // A missed detection is no evidence either way: keep the debounce counts.
        continue;
      }
      if (g.lostSince >= 0) {
        g.lastLostFrom = g.lostSince;
        g.lastLostTo = t;
      }
      g.lostSince = -1;

      const lm = curlInput(hd);
      const curls = fusedCurls(hd, body.aspect, body.curls[h]);
      const raw = ((curls[0] ?? 0) + (curls[1] ?? 0) + (curls[2] ?? 0) + (curls[3] ?? 0)) / 4;
      body.gripRaw[h] = raw;
      body.thumbExt[h] = thumbExtension(lm);
      const range = profile.grip[h];
      const lo = Math.min(range.min, config.gripRangeMaxMin);
      const hi = Math.max(range.max, config.gripRangeMinMax);
      const norm = clamp((raw - lo) / Math.max(hi - lo, 0.05), 0, 1);
      // Filter at the hand rate: with hands every 2nd frame, body.dt is half the real sample spacing.
      const dt = g.lastSeenT >= 0 ? clamp((t - g.lastSeenT) / 1000, 1 / 240, 0.25) : body.dt;
      g.lastSeenT = t;
      g.filter.minCutoff = config.gripMinCutoff;
      hs.grip = clamp(g.filter.filter(norm, dt), 0, 1);

      // Hysteresis on the UNFILTERED grip: > gripOn for N hand frames -> grab; < gripOff for N -> release.
      // A clear reading (strong threshold, wrist tracked by the pose, confident hand) fires on its first frame.
      const frames = Math.max(1, Math.round(config.gripFrames));
      const clear = body.wristVis[h] >= config.gripStrongMinWristVis && hd.score >= config.gripStrongMinScore;
      if (!g.gripping) {
        g.above = norm > config.gripOn ? g.above + 1 : 0;
        if (g.above >= frames || (clear && norm >= config.gripStrongOn)) {
          g.gripping = true;
          g.above = g.below = 0;
          emit({ type: 'grab', hand: h });
        }
      } else {
        g.below = norm < config.gripOff ? g.below + 1 : 0;
        if (g.below >= frames || (clear && norm <= config.gripStrongOff)) {
          g.gripping = false;
          g.above = g.below = 0;
          emit({ type: 'release', hand: h, vel: g.releaseVel(t, hs.forward) });
        }
      }
    }
  }
}
