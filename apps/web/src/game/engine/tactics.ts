// What the wooers learn about Odysseus while they fight him: the line and height of his last ~10 cuts, whether he
// thrusts, how long he hides behind his guard, and which of their own blows he answers well. Their guards, their
// choice of blow, feints and shield bashes read from this (see EnemyManager) — Mordhau / Blade & Sorcery style
// pressure that punishes the same cut spammed over and over, without ever reading the input itself.
import * as THREE from 'three';
import type { AttackDir, Outcome } from './enemies';
import { clamp } from './math';

/** one of his cuts as the wooers saw it: from his left (L) / right (R), an overhead, a thrust, or a low cut */
export type SwingKind = 'L' | 'R' | 'top' | 'thrust' | 'low';
export type Height = 'high' | 'mid' | 'low';
export type GuardZone = 'none' | 'high' | 'left' | 'right' | 'low';
export interface SwingRec { t: number; kind: SwingKind; height: Height; speed: number }

interface Track { active: boolean; t0: number; lastFast: number; peak: number; start: THREE.Vector3; last: THREE.Vector3; minY: number; maxY: number }
const newTrack = (): Track => ({ active: false, t0: 0, lastFast: 0, peak: 0, start: new THREE.Vector3(), last: new THREE.Vector3(), minY: 0, maxY: 0 });

const MAX_SWINGS = 10;

interface Blade { tip: THREE.Vector3; vel: THREE.Vector3; base?: THREE.Vector3; side?: 'left' | 'right' }
const TRACK_SIDE = ['right', 'left'] as const;
/** each hand keeps its own track (picking up or dropping a sword in one hand never joins two hands' points into one
 *  cut); blades without a side (older callers) go by position */
function bladeFor(blades: Blade[], i: number): Blade | undefined {
  let sided = false;
  for (const b of blades) {
    if (!b.side) continue;
    sided = true;
    if (b.side === TRACK_SIDE[i]) return b;
  }
  return sided ? undefined : blades[i];
}
const _d = new THREE.Vector3();

export class PlayerHabits {
  readonly swings: SwingRec[] = [];
  /** seconds the guard has been up without a break */
  guardHeld = 0;
  /** share of the last ~4 s spent behind the guard */
  guardFrac = 0;
  /** while he guards: how often his blade is held high (≈ head height) */
  guardHigh = 0.5;
  sinceGuard = 99;
  sinceSwing = 99;
  /** his blade hangs low and still (or he holds none): an open man */
  bladeLow = true;
  /** how well he answers each line of their attack (EMA: 1 = always stopped, 0 = always lands) */
  readonly defended: Record<AttackDir, number> = { left: 0.5, right: 0.5, top: 0.5, thrust: 0.5 };
  private tracks: Track[] = [newTrack(), newTrack()];
  t = 0;

  reset() {
    this.swings.length = 0;
    this.guardHeld = 0; this.guardFrac = 0; this.guardHigh = 0.5; this.sinceGuard = 99; this.sinceSwing = 99; this.bladeLow = true;
    for (const k of Object.keys(this.defended) as AttackDir[]) this.defended[k] = 0.5;
    for (const tr of this.tracks) tr.active = false;
  }

  /**
   * Watch his blades for one frame. `yaw` is his view (+ = turned left); `ss` the input's speed scale (mouse 0.65).
   */
  update(dt: number, t: number, blades: Blade[], head: THREE.Vector3, yaw: number, guardUp: boolean, ss: number) {
    this.t = t;
    // guard
    if (guardUp) { this.guardHeld += dt; this.sinceGuard = 0; } else { this.guardHeld = 0; this.sinceGuard += dt; }
    this.guardFrac += ((guardUp ? 1 : 0) - this.guardFrac) * (1 - Math.exp(-dt / 4));
    this.sinceSwing += dt;
    let low = true;
    const vOn = 3.0 * ss;
    for (let i = 0; i < this.tracks.length; i++) {
      const tr = this.tracks[i];
      const b = bladeFor(blades, i);
      if (!b) { if (tr.active) this.finish(tr, head, yaw, vOn); continue; }
      if (b.tip.y > head.y - 0.55 || b.vel.lengthSq() > 1) low = false;
      if (guardUp) this.guardHigh += ((b.tip.y > head.y - 0.25 ? 1 : 0) - this.guardHigh) * (1 - Math.exp(-dt / 1.5));
      const sp = b.vel.length();
      if (!tr.active) {
        if (sp >= vOn) {
          tr.active = true; tr.t0 = t; tr.lastFast = t; tr.peak = sp;
          tr.start.copy(b.tip).addScaledVector(b.vel, -dt); tr.last.copy(b.tip);
          tr.minY = tr.maxY = b.base ? (b.base.y + b.tip.y) / 2 : b.tip.y;
        }
        continue;
      }
      tr.last.copy(b.tip);
      // height: where the middle of the blade passes (the edge that meets him), not the point held up above it
      const y = b.base ? (b.base.y + b.tip.y) / 2 : b.tip.y;
      tr.minY = Math.min(tr.minY, y); tr.maxY = Math.max(tr.maxY, y);
      if (sp >= vOn * 0.6) { tr.lastFast = t; tr.peak = Math.max(tr.peak, sp); }
      if (t - tr.lastFast > 0.07 || t - tr.t0 > 1.0) this.finish(tr, head, yaw, vOn);
    }
    this.bladeLow = low;
  }

  private finish(tr: Track, head: THREE.Vector3, yaw: number, vOn: number) {
    tr.active = false;
    const d = _d.subVectors(tr.last, tr.start);
    const len = d.length();
    if (len < 0.22 || tr.peak < vOn * 1.15) return;
    // in his view: right = (cos yaw, 0, −sin yaw), ahead = (−sin yaw, 0, −cos yaw)
    const lat = d.x * Math.cos(yaw) - d.z * Math.sin(yaw);
    const fwd = -d.x * Math.sin(yaw) - d.z * Math.cos(yaw);
    const up = d.y;
    const midY = (tr.minY + tr.maxY) / 2;
    // (eye ≈ 1.65 m: high = his neck and head, low = hips and legs, mid = the body between)
    const height: Height = midY < head.y - 0.75 ? 'low' : midY > head.y - 0.2 ? 'high' : 'mid';
    let kind: SwingKind;
    if (fwd > 0.55 * len && fwd > Math.abs(lat) && fwd > Math.abs(up)) kind = 'thrust';
    else if (up < -0.55 * len && Math.abs(lat) < Math.abs(up)) kind = 'top';
    else if (height === 'low') kind = 'low';
    else kind = lat > 0 ? 'L' : 'R';
    this.swings.push({ t: this.t, kind, height, speed: tr.peak });
    if (this.swings.length > MAX_SWINGS) this.swings.shift();
    this.sinceSwing = 0;
  }

  /** the guard zone — in the frame of a wooer facing him — that meets a cut like this one */
  static zoneFor(s: SwingRec): GuardZone {
    if (s.kind === 'top' || (s.height === 'high' && s.kind !== 'thrust')) return 'high';
    if (s.kind === 'low') return 'low';
    // his left (L) comes in on the wooer's right; a thrust is met across the body with the sword
    return s.kind === 'R' ? 'left' : 'right';
  }

  private recent(win: number, n: number) {
    const out: SwingRec[] = [];
    for (let i = this.swings.length - 1; i >= 0 && out.length < n; i--) if (this.t - this.swings[i].t <= win) out.push(this.swings[i]);
    return out;
  }

  /** where his cuts have been going (≥ 3 of them in the last 12 s): the zone and its share */
  habitZone(): { zone: GuardZone; share: number; n: number } | null {
    const r = this.recent(12, MAX_SWINGS);
    if (r.length < 3) return null;
    const c: Partial<Record<GuardZone, number>> = {};
    for (const s of r) { const z = PlayerHabits.zoneFor(s); c[z] = (c[z] ?? 0) + 1; }
    let best: GuardZone = 'none', bn = 0;
    for (const [z, n] of Object.entries(c) as [GuardZone, number][]) if (n > bn) { bn = n; best = z; }
    return { zone: best, share: bn / r.length, n: r.length };
  }

  /** 0…1: the same cut over and over (the most common of his last ≤ 6 cuts in 10 s, from a 50% share up) */
  spam(): number {
    const r = this.recent(10, 6);
    if (r.length < 4) return 0;
    const c = new Map<string, number>();
    let bn = 0;
    for (const s of r) { const k = PlayerHabits.zoneFor(s) + (s.kind === 'thrust' ? 't' : ''); const n = (c.get(k) ?? 0) + 1; c.set(k, n); bn = Math.max(bn, n); }
    return clamp((bn / r.length - 0.5) / 0.4, 0, 1);
  }

  /** hiding behind his guard (a body player is given longer before it counts) */
  turtling(body: boolean): boolean {
    return this.guardHeld >= (body ? 1.8 : 1.0) || this.guardFrac >= (body ? 0.8 : 0.62);
  }

  /** guard down: no guard for a while, his blade low and still, not cutting. With the body (webcam) the guard is a
   *  two-handed gesture and a resting arm reads as a low blade, so it takes longer to count as open */
  open(body = false): boolean { return this.sinceGuard > (body ? 2.5 : 1.5) && this.sinceSwing > 0.8 && this.bladeLow; }

  /** he answered (or failed to answer) one of their blows */
  noteOutcome(dir: AttackDir, o: Outcome) {
    const v = o === 'hit' ? 0 : o === 'guard' ? 0.5 : 1;
    this.defended[dir] += (v - this.defended[dir]) * 0.3;
  }

  /**
   * A line of attack: the usual mix (top, left, right twice as often as a thrust), tilted by `adapt` (0…1) away from
   * the lines he answers well and toward the ones that land; against a raised guard a thrust or the other side.
   */
  chooseDir(adapt: number, guardUp: boolean, rnd = Math.random): AttackDir {
    const dirs: AttackDir[] = ['top', 'left', 'right', 'thrust'];
    const base: Record<AttackDir, number> = { top: 2, left: 2, right: 2, thrust: 1 };
    let sum = 0;
    const w = dirs.map((d) => {
      let x = base[d] * clamp(1 + adapt * 1.6 * (0.55 - this.defended[d]), 0.35, 2);
      if (guardUp && d === 'thrust') x *= 1 + adapt;
      sum += x;
      return x;
    });
    let r = rnd() * sum;
    for (let i = 0; i < dirs.length; i++) { r -= w[i]; if (r <= 0) return dirs[i]; }
    return 'top';
  }
}
