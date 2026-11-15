import type { Vec3 } from '@ithaca/shared';

export interface Vec2 { x: number; y: number }

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });

export function set3(o: Vec3, x: number, y: number, z: number): Vec3 {
  o.x = x; o.y = y; o.z = z;
  return o;
}
export function copy3(o: Vec3, a: Vec3): Vec3 {
  o.x = a.x; o.y = a.y; o.z = a.z;
  return o;
}
export function sub3(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  return set3(o, a.x - b.x, a.y - b.y, a.z - b.z);
}
export function len3(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
/** Normalizes in place; leaves `fallback` direction if the vector is ~0. */
export function normalize3(o: Vec3, fallbackX = 0, fallbackY = 0, fallbackZ = -1): Vec3 {
  const l = len3(o);
  return l > 1e-6 ? set3(o, o.x / l, o.y / l, o.z / l) : set3(o, fallbackX, fallbackY, fallbackZ);
}
export function cross3(o: Vec3, a: Vec3, b: Vec3): Vec3 {
  return set3(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
/** o = lerp(o, a, t), then renormalize — cheap smoothing for unit vectors. */
export function slerpish3(o: Vec3, a: Vec3, t: number): Vec3 {
  set3(o, o.x + (a.x - o.x) * t, o.y + (a.y - o.y) * t, o.z + (a.z - o.z) * t);
  return normalize3(o, a.x, a.y, a.z);
}
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Angle at b (degrees) for points a-b-c. */
export function angleDeg(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = a.x - b.x, uy = a.y - b.y, uz = a.z - b.z;
  const wx = c.x - b.x, wy = c.y - b.y, wz = c.z - b.z;
  const d = Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz);
  if (d < 1e-9) return 0;
  return (Math.acos(clamp((ux * wx + uy * wy + uz * wz) / d, -1, 1)) * 180) / Math.PI;
}
