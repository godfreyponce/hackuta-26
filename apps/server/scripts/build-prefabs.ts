// Builds one low-poly placeholder GLB per weapon class into apps/server/prefabs/.
// Y up, origin at the grip, longest axis about 1 unit, flat shaded, one color per class.
// Usage: pnpm --filter @ithaca/server prefabs:build
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { WeaponClass } from '@ithaca/shared';

type V3 = [number, number, number];
type Tri = [V3, V3, V3];
interface Part { tris: Tri[]; center: V3 }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

const circle = (r: number, y: number, segs: number): V3[] =>
  Array.from({ length: segs }, (_, i): V3 => { const a = (i / segs) * Math.PI * 2; return [r * Math.cos(a), y, r * Math.sin(a)]; });

function fan(apex: V3, loop: V3[]): Tri[] {
  return loop.map((p, i) => [apex, p, loop[(i + 1) % loop.length]!]);
}
function band(lo: V3[], hi: V3[]): Tri[] {
  return lo.flatMap((p, i): Tri[] => {
    const j = (i + 1) % lo.length;
    return [[p, hi[i]!, lo[j]!], [lo[j]!, hi[i]!, hi[j]!]];
  });
}

// All parts are convex, so each triangle is wound to face away from the part's center.
function part(tris: Tri[], center: V3): Part {
  const outward = ([a, b, c]: Tri) => dot(cross(sub(b, a), sub(c, a)), sub([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], center)) > 0;
  return { center, tris: tris.map(([a, b, c]): Tri => (outward([a, b, c]) ? [a, b, c] : [a, c, b])) };
}

function cylinder(r: number, y0: number, y1: number, segs = 8): Part {
  const lo = circle(r, y0, segs), hi = circle(r, y1, segs);
  return part([...band(lo, hi), ...fan([0, y0, 0], lo), ...fan([0, y1, 0], hi)], [0, (y0 + y1) / 2, 0]);
}
function cone(r: number, y0: number, y1: number, segs = 8): Part {
  const base = circle(r, y0, segs);
  return part([...fan([0, y1, 0], base), ...fan([0, y0, 0], base)], [0, (y0 + y1) / 2, 0]);
}
function sphere(r: number, cy: number, segs = 10, rings = 6): Part {
  const loops = Array.from({ length: rings - 1 }, (_, k) => {
    const phi = ((k + 1) / rings) * Math.PI;
    return circle(r * Math.sin(phi), cy + r * Math.cos(phi), segs);
  });
  const tris = [...fan([0, cy + r, 0], loops[0]!), ...fan([0, cy - r, 0], loops.at(-1)!)];
  for (let k = 0; k + 1 < loops.length; k++) tris.push(...band(loops[k + 1]!, loops[k]!));
  return part(tris, [0, cy, 0]);
}
function box([sx, sy, sz]: V3, [cx, cy, cz]: V3): Part {
  const c = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z): V3 => [cx + (x * sx) / 2, cy + (y * sy) / 2, cz + (z * sz) / 2])));
  const q = (a: number, b: number, d: number, e: number): Tri[] => [[c[a]!, c[b]!, c[d]!], [c[a]!, c[d]!, c[e]!]];
  return part([...q(0, 1, 3, 2), ...q(4, 6, 7, 5), ...q(0, 4, 5, 1), ...q(2, 3, 7, 6), ...q(0, 2, 6, 4), ...q(1, 5, 7, 3)], [cx, cy, cz]);
}
function map(p: Part, f: (v: V3) => V3): Part {
  return part(p.tris.map((t) => t.map(f) as Tri), f(p.center));
}
const scaleZ = (s: number) => (v: V3): V3 => [v[0], v[1], v[2] * s];
const faceZ = (z: number) => (v: V3): V3 => [v[0], -v[2], v[1] + z]; // rotate +90° about X: a Y-axis disc now faces Z

type Rgb = [number, number, number];
const PREFABS: Record<WeaponClass, { color: Rgb; parts: Part[] }> = {
  spear: { color: [0.55, 0.36, 0.16], parts: [cylinder(0.022, -0.1, 0.82), cone(0.055, 0.82, 1.0)] },
  sword: {
    color: [0.72, 0.74, 0.78],
    parts: [
      sphere(0.035, -0.1, 8, 4), cylinder(0.025, -0.08, 0.08),
      box([0.24, 0.04, 0.05], [0, 0.1, 0]), box([0.07, 0.66, 0.015], [0, 0.45, 0]),
      map(cone(0.035, 0.78, 0.9, 4), scaleZ(0.21)),
    ],
  },
  blunt: { color: [0.36, 0.22, 0.12], parts: [cylinder(0.03, -0.15, 0.55), sphere(0.17, 0.65)] },
  throwable: { color: [0.8, 0.16, 0.1], parts: [sphere(0.5, 0, 12, 8)] },
  shield: {
    color: [0.76, 0.55, 0.2],
    parts: [map(cylinder(0.5, -0.03, 0.03, 16), faceZ(-0.07)), map(sphere(0.09, 0, 8, 4), faceZ(-0.1)), box([0.04, 0.22, 0.06], [0, 0, -0.01])],
  },
  bomb: { color: [0.13, 0.13, 0.15], parts: [sphere(0.35, 0), cylinder(0.1, 0.3, 0.45), cylinder(0.02, 0.45, 0.6, 6)] },
  potion: { color: [0.2, 0.7, 0.36], parts: [sphere(0.3, -0.15), cylinder(0.09, 0.1, 0.4), cylinder(0.11, 0.4, 0.5)] },
};

function glb(name: string, color: Rgb, parts: Part[]): Buffer {
  const tris = parts.flatMap((p) => p.tris);
  const pos = new Float32Array(tris.length * 9), nrm = new Float32Array(tris.length * 9);
  tris.forEach(([a, b, c], i) => {
    const n = unit(cross(sub(b, a), sub(c, a)));
    [a, b, c].forEach((v, k) => { pos.set(v, i * 9 + k * 3); nrm.set(n, i * 9 + k * 3); });
  });
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { min[i % 3] = Math.min(min[i % 3]!, pos[i]!); max[i % 3] = Math.max(max[i % 3]!, pos[i]!); }
  const count = tris.length * 3;
  const json = {
    asset: { version: '2.0', generator: 'ithaca build-prefabs' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [{ name, pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: pos.byteLength * 2 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nrm.byteLength, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
    ],
  };
  const pad4 = (b: Buffer, fill: number) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(nrm.buffer)]);
  const chunkHeader = (len: number, type: number) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  return Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binChunk.length, 0x004e4942), binChunk]);
}

const outDir = fileURLToPath(new URL('../prefabs/', import.meta.url));
await mkdir(outDir, { recursive: true });
for (const [name, { color, parts }] of Object.entries(PREFABS)) {
  const buf = glb(name, color, parts);
  await writeFile(`${outDir}${name}.glb`, buf);
  console.log(`${name}.glb ${buf.length} bytes`);
}
