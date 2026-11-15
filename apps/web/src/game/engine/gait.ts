// Procedural footwork for the wooers: feet placed by a small two-bone IK, stepping in whatever direction the man
// actually moves (forward, back, strafing sideways), a fighting stance when he stands, and his weight shifting
// between his feet when he waits. Writes the legs, bob and pelvis sway of an Anim.
import { RIG, type Anim } from './humanoid';
import { clamp } from './math';

export interface GaitState {
  phase: number;
  /** smoothed velocity in his own frame (m/s): + = toward his left / forward */
  vl: number;
  vf: number;
  /** position last frame (world x/z) — the gait follows how he really moved, steering or not */
  px: number;
  pz: number;
}
export const newGait = (x = 0, z = 0): GaitState => ({ phase: Math.random() * 6, vl: 0, vf: 0, px: x, pz: z });

/** where his feet rest when he isn't stepping (his frame, rig metres): x = his left, z = forward */
export interface Stance { lx: number; lz: number; rx: number; rz: number; crouch: number }
/** square, relaxed: walking or jogging in */
export const STANCE_WALK: Stance = { lx: 0.1, lz: 0, rx: -0.1, rz: 0, crouch: 0.015 };
/** on guard: shield-side (left) foot leading, knees soft */
export const STANCE_GUARD: Stance = { lx: 0.14, lz: 0.16, rx: -0.13, rz: -0.15, crouch: 0.05 };
/** committed to a blow: a long lunge onto the front foot */
export const STANCE_LUNGE: Stance = { lx: 0.13, lz: 0.3, rx: -0.12, rz: -0.24, crouch: 0.09 };

/** Two-bone leg IK in the leg's own plane: ankle at (z forward, h below the hip) → [thigh swing, knee bend]. */
function legIK(z: number, h: number, out: [number, number, number?]) {
  const L1 = RIG.uleg, L2 = RIG.lleg;
  const D = clamp(Math.hypot(z, h), Math.abs(L1 - L2) + 0.05, (L1 + L2) * 0.999);
  const knee = Math.acos(clamp((D * D - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1));
  const alpha = Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
  out[0] = Math.atan2(z, h) + alpha;
  out[1] = knee;
}

/** Put one ankle at (fx, fy above the ground, fz) in his frame; the hip is shifted by bob/sway. */
function placeFoot(side: 1 | -1, fx: number, fy: number, fz: number, bob: number, sway: number, out: [number, number, number?]) {
  const ankleRest = Math.max(0.02, RIG.hipY - RIG.uleg - RIG.lleg);
  const hv = Math.max(0.2, RIG.hipY + bob - (ankleRest + fy));
  const o = (fx - (RIG.hipX * side + sway)) * side; // + = out from the midline
  const abd = Math.atan2(o, hv);
  legIK(fz, Math.hypot(o, hv), out);
  out[2] = abd;
}

/**
 * Step the gait. `vx, vz` are his world velocity, `yaw` his facing; `stance` the rest footing; `t` and `seed` drive
 * the idle weight shift. Writes a.legL / a.legR / a.bob / a.sway.
 */
export function stepGait(g: GaitState, dt: number, vx: number, vz: number, yaw: number, stance: Stance, a: Anim, t: number, seed: number) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const vfRaw = vx * fx + vz * fz;
  const vlRaw = vx * fz - vz * fx; // his left = (cos yaw, 0, −sin yaw)
  const k0 = 1 - Math.exp(-10 * dt);
  g.vl += (vlRaw - g.vl) * k0;
  g.vf += (vfRaw - g.vf) * k0;
  const v = Math.hypot(g.vl, g.vf);
  // 0 standing … 1 walking: below ~0.06 m/s the feet stay planted
  const k = clamp((v - 0.06) / 0.25, 0, 1);
  const omega = 5.5 + 2.4 * Math.min(v, 3);
  g.phase += omega * dt * k;
  const A = Math.min(0.42, (Math.PI * v) / (2 * omega)) * k;
  const dl = v > 1e-3 ? g.vl / v : 0, df = v > 1e-3 ? g.vf / v : 1;
  const liftH = (0.05 + 0.05 * Math.min(1, v / 2)) * k;
  // weight: over the planted foot as he steps, a slow shift from foot to foot while he waits
  const idle = 1 - k;
  // (a guard stance — knees soft — shifts more than a man standing square)
  const guarded = clamp((stance.crouch - STANCE_WALK.crouch) / (STANCE_GUARD.crouch - STANCE_WALK.crouch), 0, 1);
  const sway = -0.022 * k * Math.cos(g.phase) + 0.028 * idle * Math.sin(t * 0.85 + seed) * (0.4 + 0.6 * guarded);
  const bob = -stance.crouch - 0.016 * k * (0.5 + 0.5 * Math.cos(2 * g.phase)) - 0.006 * idle * (0.5 + 0.5 * Math.sin(t * 1.7 + seed * 3)); // breathing
  for (const side of [1, -1] as const) {
    const ph = g.phase + (side === 1 ? 0 : Math.PI);
    const s = Math.sin(ph);
    const lift = Math.max(0, Math.cos(ph)) * liftH;
    const bx = side === 1 ? stance.lx : stance.rx;
    const bz = side === 1 ? stance.lz : stance.rz;
    // a sideways step keeps the feet from crossing: the stance narrows a little toward the travel side instead
    const out = side === 1 ? a.legL : a.legR;
    placeFoot(side, bx + dl * A * s, lift, bz + df * A * s, bob, sway, out);
  }
  a.bob = bob;
  a.sway = sway;
}

/** Legs that a state poses by hand (kneeling, sinking, aiming): no gait, no sway. */
export function resetGait(g: GaitState, x: number, z: number, a: Anim) {
  g.px = x; g.pz = z; g.vl = 0; g.vf = 0;
  a.sway = 0;
}
