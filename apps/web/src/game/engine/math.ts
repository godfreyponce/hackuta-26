import * as THREE from 'three';
import type { Vec3 } from '@ithaca/shared';

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const toV3 = (v: Vec3, out = new THREE.Vector3()) => out.set(v.x, v.y, v.z);
export const fromV3 = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();

/**
 * Squared distance between segments p1q1 and p2q2 (Ericson, RTCD 5.1.9).
 * Writes closest points into c1/c2 when provided.
 */
export function segSegDist2(
  p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3,
  c1?: THREE.Vector3, c2?: THREE.Vector3,
): number {
  const d1 = _d1.subVectors(q1, p1);
  const d2 = _d2.subVectors(q2, p2);
  const r = _r.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let t = 0;
  const EPS = 1e-9;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0; s = clamp(-c / a, 0, 1);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const cx1 = p1.x + d1.x * s, cy1 = p1.y + d1.y * s, cz1 = p1.z + d1.z * s;
  const cx2 = p2.x + d2.x * t, cy2 = p2.y + d2.y * t, cz2 = p2.z + d2.z * t;
  if (c1) c1.set(cx1, cy1, cz1);
  if (c2) c2.set(cx2, cy2, cz2);
  const dx = cx1 - cx2, dy = cy1 - cy2, dz = cz1 - cz2;
  return dx * dx + dy * dy + dz * dz;
}

/** Quaternion that maps local +Y onto `fwd` and local +Z (roughly) onto `up`. */
export function basisQuat(fwd: THREE.Vector3, up: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  const y = _d1.copy(fwd).normalize();
  const z = _d2.copy(up);
  z.addScaledVector(y, -z.dot(y));
  if (z.lengthSq() < 1e-6) z.set(0, 0, 1).addScaledVector(y, -y.z);
  z.normalize();
  const x = _r.crossVectors(y, z).normalize();
  const m = _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(m);
}
const _m = new THREE.Matrix4();

/** Rotate unit vector `dir` toward `target` by at most `maxAngle` radians, in place. */
export function rotateToward(dir: THREE.Vector3, target: THREE.Vector3, maxAngle: number): THREE.Vector3 {
  const t = _d1.copy(target).normalize();
  const ang = dir.angleTo(t);
  if (ang < 1e-5) return dir;
  const k = Math.min(1, maxAngle / ang);
  return dir.lerp(t, k).normalize();
}

/**
 * Low-arc ballistic launch direction from `from` to `to` at `speed` under gravity `g`.
 * Returns null when out of range.
 */
export function ballisticDir(from: THREE.Vector3, to: THREE.Vector3, speed: number, g: number, out = new THREE.Vector3()) {
  const dx = to.x - from.x, dz = to.z - from.z, dy = to.y - from.y;
  const horiz = Math.hypot(dx, dz);
  if (horiz < 0.01 || g <= 0.001) return out.set(dx, dy, dz).normalize();
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * horiz * horiz + 2 * dy * v2);
  if (disc < 0) return null;
  const tanTheta = (v2 - Math.sqrt(disc)) / (g * horiz);
  const theta = Math.atan(tanTheta);
  const c = Math.cos(theta);
  return out.set((dx / horiz) * c, Math.sin(theta), (dz / horiz) * c).normalize();
}

/** Exponential moving average for vectors. */
export class EmaVec {
  v = new THREE.Vector3();
  primed = false;
  push(x: THREE.Vector3, alpha: number) {
    if (!this.primed) { this.v.copy(x); this.primed = true; return this.v; }
    this.v.lerp(x, alpha);
    return this.v;
  }
}
