// Weapon skins: procedural PBR texture sets (albedo + packed AO/roughness/metalness + normal) for Late Bronze Age
// arms, generated once at runtime from seeded noise and canvas strokes (no downloads), and the shared materials
// built on them. weaponGeo.ts names each part's material ('bronze-blade', 'ash-wood', 'leather-wrap', …) and lays
// out its UVs; dressWeapon() swaps those placeholders for the shared skins. One material per skin is shared by
// every weapon (and by the wooers' instanced props), so the textures are uploaded once.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;

// ── deterministic noise ───────────────────────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Field = Float32Array;

/** Tileable value-noise fBm on a w×h grid; (cx, cy) lattice cells in the first octave (integers → seamless). */
function fbm(w: number, h: number, cx: number, cy: number, oct: number, seed: number, gain = 0.5): Field {
  const out = new Float32Array(w * h);
  const R = rng(seed);
  let amp = 1, norm = 0;
  const x0s = new Int32Array(w), x1s = new Int32Array(w), fxs = new Float32Array(w);
  for (let o = 0; o < oct; o++) {
    const gx = cx << o, gy = cy << o;
    const lat = new Float32Array(gx * gy);
    for (let i = 0; i < lat.length; i++) lat[i] = R();
    for (let i = 0; i < w; i++) {
      const fx = (i / w) * gx, x0 = Math.floor(fx), f = fx - x0;
      x0s[i] = x0 % gx; x1s[i] = (x0 + 1) % gx; fxs[i] = f * f * (3 - 2 * f);
    }
    for (let j = 0; j < h; j++) {
      const fy = (j / h) * gy, y0 = Math.floor(fy);
      let f = fy - y0; f = f * f * (3 - 2 * f);
      const r0 = (y0 % gy) * gx, r1 = ((y0 + 1) % gy) * gx;
      const row = j * w;
      for (let i = 0; i < w; i++) {
        const t = fxs[i], xa = x0s[i], xb = x1s[i];
        const top = lat[r0 + xa] + (lat[r0 + xb] - lat[r0 + xa]) * t;
        const bot = lat[r1 + xa] + (lat[r1 + xb] - lat[r1 + xa]) * t;
        out[row + i] += (top + (bot - top) * f) * amp;
      }
    }
    norm += amp; amp *= gain;
  }
  return stretch(out, norm);
}

/** Remap a field to fill [0, 1] (fBm clusters around the middle). */
function stretch(f: Field, div = 1): Field {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { const v = f[i] / div; f[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Paint strokes with the 2D canvas and read them back as a mask (alpha, 0..1). Canvas top = v 1, so a
 * drawing appears upright in UV space. With `tile`, every stroke is repeated across the 8 neighbours (seamless).
 */
function paint(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, tile = false): Field {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (tile) {
    for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) { ctx.save(); ctx.translate(dx, dy); draw(ctx); ctx.restore(); }
  } else draw(ctx);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const src = (h - 1 - j) * w;
    for (let i = 0; i < w; i++) out[j * w + i] = d[(src + i) * 4 + 3] / 255;
  }
  return out;
}

function strokes(ctx: CanvasRenderingContext2D, R: () => number, n: number, o: { x0: number; x1: number; y0: number; y1: number; len: [number, number]; ang: () => number; width: [number, number]; alpha: [number, number] }) {
  ctx.lineCap = 'round';
  for (let k = 0; k < n; k++) {
    const x = mix(o.x0, o.x1, R()), y = mix(o.y0, o.y1, R());
    const L = mix(o.len[0], o.len[1], R()), a = o.ang();
    ctx.strokeStyle = `rgba(255,255,255,${mix(o.alpha[0], o.alpha[1], R())})`;
    ctx.lineWidth = mix(o.width[0], o.width[1], R());
    ctx.beginPath();
    ctx.moveTo(x, y);
    // a faint wobble so scratches don't read as ruled lines
    const mx = x + Math.cos(a) * L * 0.5 + (R() - 0.5) * L * 0.04, my = y + Math.sin(a) * L * 0.5 + (R() - 0.5) * L * 0.04;
    ctx.quadraticCurveTo(mx, my, x + Math.cos(a) * L, y + Math.sin(a) * L);
    ctx.stroke();
  }
}

function dots(ctx: CanvasRenderingContext2D, R: () => number, n: number, w: number, h: number, r: [number, number], alpha: [number, number], soft = false) {
  for (let k = 0; k < n; k++) {
    const x = R() * w, y = R() * h, rr = mix(r[0], r[1], R()), a = mix(alpha[0], alpha[1], R());
    if (soft) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
    } else ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
  }
}

// ── surface → textures ────────────────────────────────────────────────────
interface Surface {
  w: number; h: number;
  /** sRGB albedo, 0..1 */
  r: Field; g: Field; b: Field;
  rough: Field; metal: Field; height: Field; ao: Field;
  alpha?: Field;
}
function surface(w: number, h: number): Surface {
  const n = w * h;
  return { w, h, r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), rough: new Float32Array(n).fill(0.5), metal: new Float32Array(n), height: new Float32Array(n).fill(0.5), ao: new Float32Array(n).fill(1) };
}

export interface TexSet { map: THREE.Texture; orm: THREE.Texture; normal: THREE.Texture }

function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean, wrap: boolean, aniso: number) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/** Bake a surface into albedo (sRGB, alpha), ORM (R = AO, G = roughness, B = metalness) and a tangent-space normal map. */
function bake(s: Surface, o: { normal: number; wrap: boolean; aniso?: number }): TexSet {
  const { w, h } = s, n = w * h;
  const col = new Uint8Array(n * 4), orm = new Uint8Array(n * 4), nrm = new Uint8Array(n * 4);
  const H = s.height;
  const at = (i: number, j: number) => {
    if (o.wrap) { i = (i + w) % w; j = (j + h) % h; } else { i = i < 0 ? 0 : i >= w ? w - 1 : i; j = j < 0 ? 0 : j >= h ? h - 1 : j; }
    return H[j * w + i];
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const p = j * w + i, q = p * 4;
    col[q] = clamp01(s.r[p]) * 255; col[q + 1] = clamp01(s.g[p]) * 255; col[q + 2] = clamp01(s.b[p]) * 255;
    col[q + 3] = s.alpha ? clamp01(s.alpha[p]) * 255 : 255;
    orm[q] = clamp01(s.ao[p]) * 255; orm[q + 1] = clamp01(s.rough[p]) * 255; orm[q + 2] = clamp01(s.metal[p]) * 255; orm[q + 3] = 255;
    // Sobel; texture rows run with +V (DataTexture is not flipped), OpenGL-style +Y normal map
    const dx = (at(i + 1, j - 1) + 2 * at(i + 1, j) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i - 1, j) + at(i - 1, j + 1));
    const dy = (at(i - 1, j + 1) + 2 * at(i, j + 1) + at(i + 1, j + 1)) - (at(i - 1, j - 1) + 2 * at(i, j - 1) + at(i + 1, j - 1));
    let nx = -dx * o.normal, ny = -dy * o.normal, nz = 1;
    const l = 1 / Math.hypot(nx, ny, nz);
    nx *= l; ny *= l; nz *= l;
    nrm[q] = (nx * 0.5 + 0.5) * 255; nrm[q + 1] = (ny * 0.5 + 0.5) * 255; nrm[q + 2] = (nz * 0.5 + 0.5) * 255; nrm[q + 3] = 255;
  }
  const a = o.aniso ?? 8;
  return { map: dataTex(col, w, h, true, o.wrap, a), orm: dataTex(orm, w, h, false, o.wrap, a), normal: dataTex(nrm, w, h, false, o.wrap, a) };
}

// ── the sets ──────────────────────────────────────────────────────────────

/** Polished leaf blade: warm bronze, bright honed bevels, tarnish + verdigris in the fullers, polish and whetstone scratches, pits and edge nicks. */
function bladeSet(): TexSet {
  const W = 256, H = 1024;
  const s = surface(W, H);
  const tone = fbm(W, H, 2, 8, 5, 11);
  const blot = fbm(W, H, 6, 24, 4, 12);
  const fine = fbm(W, H, 32, 128, 2, 13);
  const R = rng(14);
  const pits = paint(W, H, (c) => dots(c, R, 700, W, H, [0.5, 1.4], [0.35, 0.9]));
  const scratch = paint(W, H, (c) => {
    // polishing: long faint strokes running along the blade
    strokes(c, R, 140, { x0: 0, x1: W, y0: 0, y1: H, len: [60, 320], ang: () => Math.PI / 2 + (R() - 0.5) * 0.06, width: [0.5, 0.8], alpha: [0.08, 0.28] });
    // whetstone: short oblique strokes across the bevels
    strokes(c, R, 380, { x0: 0, x1: W * 0.16, y0: 0, y1: H, len: [8, 26], ang: () => -0.55 + (R() - 0.5) * 0.3, width: [0.5, 0.9], alpha: [0.2, 0.55] });
    strokes(c, R, 380, { x0: W * 0.84, x1: W, y0: 0, y1: H, len: [8, 26], ang: () => Math.PI + 0.55 + (R() - 0.5) * 0.3, width: [0.5, 0.9], alpha: [0.2, 0.55] });
    // a few deeper gouges from parried blows
    strokes(c, R, 26, { x0: W * 0.1, x1: W * 0.9, y0: H * 0.15, y1: H * 0.9, len: [14, 70], ang: () => R() * TAU, width: [1, 2.2], alpha: [0.5, 0.9] });
  });
  const nicks = paint(W, H, (c) => {
    c.fillStyle = '#fff';
    for (let k = 0; k < 14; k++) {
      const left = R() < 0.5, y = H * (0.2 + R() * 0.7), d = 2 + R() * 5, L = 3 + R() * 7;
      c.beginPath();
      if (left) { c.moveTo(0, y - L); c.lineTo(d, y); c.lineTo(0, y + L); } else { c.moveTo(W, y - L); c.lineTo(W - d, y); c.lineTo(W, y + L); }
      c.fill();
    }
  });
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      const sAbs = Math.abs((i + 0.5) / W - 0.5) * 2;
      const bevel = sstep(0.8, 0.88, sAbs);
      const fuller = sstep(0.17, 0.26, sAbs) * (1 - sstep(0.4, 0.5, sAbs));
      const rib = 1 - sstep(0.06, 0.14, sAbs);
      const t = tone[p] - 0.5;
      let r = 0.66 + t * 0.09, g = 0.45 + t * 0.07, b = 0.26 + t * 0.045;
      // copper-rich warm streaks from the casting
      const warm = sstep(0.55, 0.9, blot[p]) * 0.35;
      r += warm * 0.05; g -= warm * 0.03; b -= warm * 0.03;
      // honed bevel and the polished crest of the midrib: paler, brighter
      r = mix(r, 0.88, bevel * 0.8); g = mix(g, 0.69, bevel * 0.8); b = mix(b, 0.47, bevel * 0.8);
      r = mix(r, 0.78, rib * 0.35); g = mix(g, 0.58, rib * 0.35); b = mix(b, 0.37, rib * 0.35);
      // tarnish settles in the fullers and toward the hilt
      const tarn = clamp01(fuller * (0.45 + 0.55 * blot[p]) + (1 - bevel) * sstep(0.62, 0.9, blot[p]) * 0.35 + (1 - v) * (1 - bevel) * 0.12);
      r = mix(r, 0.34, tarn * 0.7); g = mix(g, 0.23, tarn * 0.7); b = mix(b, 0.13, tarn * 0.7);
      // light verdigris crust, mostly in the fullers
      const verd = sstep(0.6, 0.8, blot[p] * 0.7 + fine[p] * 0.3) * (0.18 + 0.82 * fuller) * (1 - bevel) * (0.7 + 0.3 * (1 - v));
      r = mix(r, 0.33, verd); g = mix(g, 0.52, verd); b = mix(b, 0.42, verd);
      const sc = scratch[p] * (1 - verd);
      r += sc * 0.1; g += sc * 0.08; b += sc * 0.06;
      const pt = pits[p] * (1 - bevel * 0.6);
      r *= 1 - pt * 0.45; g *= 1 - pt * 0.5; b *= 1 - pt * 0.5;
      const nk = nicks[p];
      r = mix(r, 0.95, nk * 0.6); g = mix(g, 0.78, nk * 0.6); b = mix(b, 0.58, nk * 0.6); // fresh bright metal in the nick
      s.r[p] = r; s.g[p] = g; s.b[p] = b;
      s.rough[p] = 0.3 + t * 0.08 + (fine[p] - 0.5) * 0.06 - bevel * 0.15 - rib * 0.05 + tarn * 0.24 + verd * 0.5 + sc * 0.14 + pt * 0.2;
      s.metal[p] = 1 - verd * 0.9 - tarn * 0.12;
      s.height[p] = 0.5 + t * 0.05 - sc * 0.32 - pt * 0.55 - nk * 0.5 + verd * 0.12;
      s.ao[p] = 1 - fuller * 0.1 - verd * 0.25 - pt * 0.3;
    }
  }
  return bake(s, { normal: 2.4, wrap: false, aniso: 8 });
}

/** Cast / hammered bronze (fittings, pommels, sockets, rims, mace heads): planishing dimples, tarnish, verdigris in the hollows. */
function castSet(): TexSet {
  const W = 512, H = 512;
  const s = surface(W, H);
  const n1 = fbm(W, H, 4, 4, 5, 21);
  const n2 = fbm(W, H, 8, 8, 4, 22);
  const fine = fbm(W, H, 64, 64, 2, 23);
  const R = rng(24);
  const dents = paint(W, H, (c) => dots(c, R, 260, W, H, [5, 20], [0.25, 0.6], true), true);
  const scratch = paint(W, H, (c) => strokes(c, R, 240, { x0: 0, x1: W, y0: 0, y1: H, len: [10, 90], ang: () => R() * TAU, width: [0.5, 1.2], alpha: [0.15, 0.6] }), true);
  const pits = paint(W, H, (c) => dots(c, R, 1100, W, H, [0.5, 1.5], [0.3, 0.8]), true);
  for (let p = 0; p < W * H; p++) {
    const t = n1[p] - 0.5;
    let r = 0.64 + t * 0.1, g = 0.44 + t * 0.08, b = 0.25 + t * 0.05;
    const tarn = sstep(0.42, 0.82, n2[p]) * 0.8;
    r = mix(r, 0.33, tarn * 0.75); g = mix(g, 0.23, tarn * 0.75); b = mix(b, 0.14, tarn * 0.75);
    const verd = sstep(0.62, 0.8, n1[p] * 0.55 + n2[p] * 0.3 + dents[p] * 0.4) * (0.4 + 0.6 * tarn);
    r = mix(r, 0.31, verd); g = mix(g, 0.5, verd); b = mix(b, 0.41, verd);
    const sc = scratch[p] * (1 - verd);
    r += sc * 0.12; g += sc * 0.09; b += sc * 0.06;
    const pt = pits[p];
    r *= 1 - pt * 0.45; g *= 1 - pt * 0.5; b *= 1 - pt * 0.5;
    s.r[p] = r; s.g[p] = g; s.b[p] = b;
    s.rough[p] = 0.32 + (fine[p] - 0.5) * 0.08 + tarn * 0.26 + verd * 0.5 + sc * 0.12 + pt * 0.2;
    s.metal[p] = 1 - verd * 0.88 - tarn * 0.1;
    s.height[p] = 0.5 - dents[p] * 0.35 - sc * 0.2 - pt * 0.4 + t * 0.08 + verd * 0.1;
    s.ao[p] = 1 - dents[p] * 0.15 - verd * 0.25 - pt * 0.3;
  }
  return bake(s, { normal: 2, wrap: true, aniso: 4 });
}

/** Ash: straight, ring-porous grain along V (latewood lines, pore streaks), oiled and hand-worn. Light; tinted per material. */
function woodSet(): TexSet {
  const W = 256, H = 1024;
  const s = surface(W, H);
  const warp = fbm(W, H, 2, 2, 3, 31);
  const streak = fbm(W, H, 48, 3, 3, 32);
  const tone = fbm(W, H, 3, 6, 4, 33);
  const R = rng(34);
  const pores = paint(W, H, (c) => strokes(c, R, 1500, { x0: 0, x1: W, y0: 0, y1: H, len: [5, 34], ang: () => Math.PI / 2 + (R() - 0.5) * 0.04, width: [0.6, 1.3], alpha: [0.25, 0.75] }), true);
  const N = 9; // growth rings across one tile (integer → seamless around the shaft)
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const p = j * W + i, u = i / W;
    const ph = u * N + (warp[p] - 0.5) * 2.4 + (streak[p] - 0.5) * 0.5;
    const ring = ph - Math.floor(ph);
    const late = Math.pow(ring, 5) * (1 - sstep(0.96, 1, ring));
    const t = tone[p] - 0.5;
    let r = 0.66 + t * 0.08, g = 0.5 + t * 0.07, b = 0.33 + t * 0.05;
    r = mix(r, 0.38, late * 0.75); g = mix(g, 0.25, late * 0.75); b = mix(b, 0.15, late * 0.75);
    const st = (streak[p] - 0.5) * 0.1;
    r += st; g += st * 0.8; b += st * 0.6;
    const po = pores[p] * (0.55 + 0.45 * (1 - ring));
    r *= 1 - po * 0.35; g *= 1 - po * 0.4; b *= 1 - po * 0.42;
    s.r[p] = r; s.g[p] = g; s.b[p] = b;
    s.rough[p] = 0.6 + late * 0.1 + po * 0.18 + (streak[p] - 0.5) * 0.1;
    s.metal[p] = 0;
    s.height[p] = 0.5 - late * 0.22 - po * 0.5 + (streak[p] - 0.5) * 0.14;
    s.ao[p] = 1 - po * 0.25;
  }
  return bake(s, { normal: 1.8, wrap: true, aniso: 8 });
}

/** Leather thong wound in a helix (4 turns per tile, seamless around the grip): ridged strips, dark gaps, worn shiny crowns. */
function wrapSet(): TexSet {
  const W = 256, H = 256, K = 4;
  const s = surface(W, H);
  const grain = fbm(W, H, 32, 32, 3, 41);
  const crease = fbm(W, H, 8, 8, 4, 42);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const p = j * W + i, u = i / W, v = j / H;
    const x = K * v - u, ph = x - Math.floor(x);
    const gap = 1 - sstep(0.0, 0.08, ph) * (1 - sstep(0.94, 1.0, ph));
    const crown = sstep(0.2, 0.5, ph) * (1 - sstep(0.75, 0.95, ph));
    const hgt = sstep(0, 0.14, ph) * (0.82 + 0.18 * (1 - ph)) * (1 - sstep(0.94, 1, ph));
    const t = grain[p] - 0.5;
    let r = 0.42 + t * 0.08, g = 0.27 + t * 0.06, b = 0.16 + t * 0.04;
    r += crown * 0.05; g += crown * 0.035; b += crown * 0.02;
    r *= 1 - gap * 0.6; g *= 1 - gap * 0.62; b *= 1 - gap * 0.62;
    const cr = sstep(0.62, 0.8, crease[p]) * 0.3;
    r *= 1 - cr * 0.4; g *= 1 - cr * 0.4; b *= 1 - cr * 0.4;
    s.r[p] = r; s.g[p] = g; s.b[p] = b;
    s.rough[p] = 0.66 - crown * 0.18 + gap * 0.25 + t * 0.12;
    s.height[p] = hgt * 0.85 + t * 0.06 - cr * 0.05;
    s.ao[p] = 1 - gap * 0.55;
  }
  return bake(s, { normal: 3, wrap: true, aniso: 4 });
}

/** Plain vegetable-tanned leather (straps, armbands): pebbled grain, creases, scuffs. */
function leatherSet(): TexSet {
  const W = 256, H = 256;
  const s = surface(W, H);
  const grain = fbm(W, H, 48, 48, 2, 51);
  const tone = fbm(W, H, 4, 4, 4, 52);
  const crease = fbm(W, H, 6, 16, 4, 53);
  const R = rng(54);
  const scuff = paint(W, H, (c) => strokes(c, R, 50, { x0: 0, x1: W, y0: 0, y1: H, len: [6, 40], ang: () => R() * TAU, width: [0.8, 2.4], alpha: [0.15, 0.5] }), true);
  for (let p = 0; p < W * H; p++) {
    const t = tone[p] - 0.5, gr = grain[p] - 0.5;
    const cr = Math.abs(crease[p] - 0.5) < 0.02 ? 1 : 0;
    let r = 0.38 + t * 0.1 + gr * 0.04, g = 0.24 + t * 0.07 + gr * 0.03, b = 0.14 + t * 0.05 + gr * 0.02;
    r *= 1 - cr * 0.3; g *= 1 - cr * 0.3; b *= 1 - cr * 0.3;
    r += scuff[p] * 0.08; g += scuff[p] * 0.06; b += scuff[p] * 0.04;
    s.r[p] = r; s.g[p] = g; s.b[p] = b;
    s.rough[p] = 0.72 + gr * 0.2 + scuff[p] * 0.12 - t * 0.1;
    s.height[p] = 0.5 + gr * 0.3 - cr * 0.3 - scuff[p] * 0.15;
    s.ao[p] = 1 - cr * 0.3;
  }
  return bake(s, { normal: 2.2, wrap: true, aniso: 4 });
}

/** Horn lamination (the bow's belly): streaky amber-to-slate bands along the limb, glossy. */
function hornSet(): TexSet {
  const W = 128, H = 512;
  const s = surface(W, H);
  const band = fbm(W, H, 16, 2, 4, 61);
  const tone = fbm(W, H, 2, 4, 3, 62);
  for (let p = 0; p < W * H; p++) {
    const k = sstep(0.25, 0.75, band[p] * 0.7 + tone[p] * 0.3);
    s.r[p] = mix(0.2, 0.58, k); s.g[p] = mix(0.16, 0.44, k); s.b[p] = mix(0.13, 0.28, k);
    s.rough[p] = 0.3 + (1 - k) * 0.08;
    s.height[p] = 0.5 + (band[p] - 0.5) * 0.12;
  }
  return bake(s, { normal: 1.2, wrap: true, aniso: 4 });
}

/** Terracotta (wheel-thrown): u around, v up the profile — throwing rings, fire clouds, chips. */
function claySet(): TexSet {
  const W = 512, H = 256;
  const s = surface(W, H);
  const tone = fbm(W, H, 6, 3, 5, 71);
  const cloud = fbm(W, H, 3, 2, 4, 72);
  const fine = fbm(W, H, 64, 32, 2, 73);
  const R = rng(74);
  const chips = paint(W, H, (c) => dots(c, R, 60, W, H, [1, 3.5], [0.6, 1]), true);
  for (let j = 0; j < H; j++) {
    const v = j / H;
    for (let i = 0; i < W; i++) {
      const p = j * W + i, t = tone[p] - 0.5;
      const rings = Math.sin(v * 170 + (tone[p] - 0.5) * 7) * 0.5 + 0.5;
      let r = 0.7 + t * 0.08, g = 0.41 + t * 0.06, b = 0.25 + t * 0.04;
      r += (rings - 0.5) * 0.03; g += (rings - 0.5) * 0.02;
      const fc = sstep(0.62, 0.9, cloud[p]) * 0.7;
      r = mix(r, 0.26, fc); g = mix(g, 0.18, fc); b = mix(b, 0.13, fc);
      const ch = chips[p];
      r = mix(r, 0.82, ch * 0.5); g = mix(g, 0.62, ch * 0.5); b = mix(b, 0.46, ch * 0.5);
      s.r[p] = r; s.g[p] = g; s.b[p] = b;
      s.rough[p] = 0.82 + (fine[p] - 0.5) * 0.1 - fc * 0.08;
      s.height[p] = 0.5 + (rings - 0.5) * 0.04 + (fine[p] - 0.5) * 0.08 - ch * 0.4;
      s.ao[p] = 1 - ch * 0.2;
    }
  }
  return bake(s, { normal: 1.6, wrap: true, aniso: 4 });
}

/** Black-glaze band with a reserved running meander and border lines (u around, v across the band), lightly chipped. */
function glazeSet(): TexSet {
  const W = 512, H = 64;
  const s = surface(W, H);
  const n = 16, U = W / n;
  const key = paint(W, H, (c) => {
    c.strokeStyle = '#fff'; c.lineWidth = 3.2; c.lineJoin = 'miter'; c.lineCap = 'butt';
    const yt = 16, yb = 48;
    c.beginPath();
    for (let k = 0; k <= n; k++) {
      const x = k * U;
      c.moveTo(x, yb); c.lineTo(x, yt); c.lineTo(x + U * 0.78, yt); c.lineTo(x + U * 0.78, yb - 8); c.lineTo(x + U * 0.3, yb - 8); c.lineTo(x + U * 0.3, yt + 8);
      c.moveTo(x, yb); c.lineTo(x + U, yb);
    }
    c.stroke();
    c.fillStyle = '#fff';
    c.fillRect(0, 4, W, 3); c.fillRect(0, H - 7, W, 3);
  }, true);
  const R = rng(81);
  const chip = paint(W, H, (c) => dots(c, R, 40, W, H, [0.8, 2.4], [0.7, 1]), true);
  const fine = fbm(W, H, 64, 8, 2, 82);
  for (let p = 0; p < W * H; p++) {
    const res = clamp01(key[p] + chip[p]);
    s.r[p] = mix(0.05 + fine[p] * 0.02, 0.72, res); s.g[p] = mix(0.04 + fine[p] * 0.015, 0.42, res); s.b[p] = mix(0.035 + fine[p] * 0.01, 0.26, res);
    s.rough[p] = mix(0.3 + fine[p] * 0.1, 0.82, res);
    s.metal[p] = 0;
    s.height[p] = 0.5 + (1 - res) * 0.15 - chip[p] * 0.3;
  }
  return bake(s, { normal: 1.2, wrap: true, aniso: 4 });
}

/** Pomegranate rind: deep red with a yellow-pink blush, lenticel specks, leathery. */
function fruitSet(): TexSet {
  const W = 256, H = 256;
  const s = surface(W, H);
  const blush = fbm(W, H, 3, 3, 4, 91);
  const fine = fbm(W, H, 32, 32, 3, 92);
  const R = rng(93);
  const specks = paint(W, H, (c) => dots(c, R, 500, W, H, [0.5, 1.4], [0.4, 0.9]), true);
  for (let p = 0; p < W * H; p++) {
    const k = sstep(0.45, 0.85, blush[p]);
    let r = mix(0.55, 0.74, k), g = mix(0.1, 0.4, k), b = mix(0.08, 0.24, k);
    r *= 1 - specks[p] * 0.4; g *= 1 - specks[p] * 0.2; b *= 1 - specks[p] * 0.2;
    r += (fine[p] - 0.5) * 0.05;
    s.r[p] = r; s.g[p] = g; s.b[p] = b;
    s.rough[p] = 0.48 + (fine[p] - 0.5) * 0.15;
    s.height[p] = 0.5 + (fine[p] - 0.5) * 0.3 - specks[p] * 0.2;
  }
  return bake(s, { normal: 1.5, wrap: true, aniso: 4 });
}

/** Cast iron (the dev frying pan): dark, mottled, rust blooms. */
function ironSet(): TexSet {
  const W = 256, H = 256;
  const s = surface(W, H);
  const tone = fbm(W, H, 6, 6, 4, 101);
  const rust = fbm(W, H, 5, 5, 5, 102);
  const fine = fbm(W, H, 64, 64, 2, 103);
  for (let p = 0; p < W * H; p++) {
    const t = tone[p] - 0.5, rs = sstep(0.66, 0.86, rust[p]);
    s.r[p] = mix(0.22 + t * 0.06, 0.4, rs); s.g[p] = mix(0.21 + t * 0.06, 0.2, rs); s.b[p] = mix(0.2 + t * 0.05, 0.1, rs);
    s.rough[p] = 0.55 + (fine[p] - 0.5) * 0.2 + rs * 0.35;
    s.metal[p] = 0.85 - rs * 0.8;
    s.height[p] = 0.5 + (fine[p] - 0.5) * 0.3 + rs * 0.1;
  }
  return bake(s, { normal: 2, wrap: true, aniso: 4 });
}

/** Barred flight feather (u = 0 at the shaft, v = 0 at the nock end) with an alpha cut-out of the trimmed vane. */
function featherSet(): TexSet {
  const W = 128, H = 256;
  const s = surface(W, H);
  s.alpha = new Float32Array(W * H);
  const ragged = fbm(W, H, 4, 24, 3, 111);
  const bars = fbm(W, H, 2, 6, 3, 112);
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    // trimmed profile: full height behind, a long straight taper to the front
    const prof = v < 0.06 ? 0 : 0.96 * Math.pow(1 - sstep(0.12, 0.98, v), 0.7);
    for (let i = 0; i < W; i++) {
      const p = j * W + i, u = (i + 0.5) / W;
      const rachis = u < 0.07 ? 1 : 0;
      const edge = prof - (ragged[p] - 0.5) * 0.08;
      s.alpha[p] = rachis ? (v > 0.03 && v < 0.99 ? 1 : 0) : u < edge ? 1 : 0;
      // barbs sweep back toward the nock; dark bars across the vane
      const barb = Math.sin((v * 90 + u * 30) * TAU * 0.5) * 0.5 + 0.5;
      const bar = sstep(0.55, 0.75, Math.sin((v * 7 + bars[p] * 1.5) * TAU) * 0.5 + 0.5) * 0.85;
      let r = mix(0.74, 0.34, bar), g = mix(0.64, 0.24, bar), b = mix(0.5, 0.16, bar);
      r *= 0.88 + barb * 0.12; g *= 0.88 + barb * 0.12; b *= 0.88 + barb * 0.12;
      if (rachis) { r = 0.86; g = 0.83; b = 0.76; }
      s.r[p] = r; s.g[p] = g; s.b[p] = b;
      s.rough[p] = 0.8;
      s.height[p] = 0.5 + barb * 0.15 + rachis * 0.3;
    }
  }
  return bake(s, { normal: 1, wrap: false, aniso: 4 });
}

/** A black-figure boar for the aspis (Odysseus' scar is from a boar on Parnassus). Drawn at ±100 units, centred. */
function boarPath(c: CanvasRenderingContext2D) {
  c.beginPath();
  c.moveTo(-70, 10); c.quadraticCurveTo(-72, -22, -40, -30); c.quadraticCurveTo(-6, -46, 26, -26);
  c.quadraticCurveTo(48, -16, 62, -6); c.lineTo(88, 2); c.lineTo(86, 12); c.lineTo(60, 14);
  c.quadraticCurveTo(30, 26, -10, 24); c.quadraticCurveTo(-50, 26, -70, 10); c.closePath(); c.fill();
  for (let k = -50; k < 34; k += 7) { const y0 = -30 - Math.sin(((k + 50) / 84) * Math.PI) * 14; c.beginPath(); c.moveTo(k, y0 + 6); c.lineTo(k + 3, y0 - 9); c.lineTo(k + 7, y0 + 6); c.fill(); }
  c.lineCap = 'round'; c.lineWidth = 8;
  for (const [x0, x1] of [[-52, -60], [-36, -28], [30, 22], [46, 54]] as const) { c.beginPath(); c.moveTo(x0, 18); c.quadraticCurveTo((x0 + x1) / 2, 40, x1, 58); c.stroke(); }
  c.lineWidth = 4; c.beginPath(); c.moveTo(-70, 4); c.quadraticCurveTo(-84, -4, -80, -16); c.stroke();
}

/** Aspis front: planished bronze facing (planar UV, centre = boss) with a painted, chipped boar and a tongue border; dents and scars from blows. */
function shieldSet(): TexSet {
  const W = 768, H = 768;
  const s = surface(W, H);
  const tone = fbm(W, H, 4, 4, 5, 121);
  const blot = fbm(W, H, 8, 8, 4, 122);
  const fine = fbm(W, H, 96, 96, 2, 123);
  const chipN = fbm(W, H, 24, 24, 3, 124);
  const R = rng(125);
  const dimples = paint(W, H, (c) => dots(c, R, 420, W, H, [6, 16], [0.12, 0.3], true));
  const dents = paint(W, H, (c) => {
    for (let k = 0; k < 6; k++) {
      const a = R() * TAU, rr = (0.3 + R() * 0.16) * W, x = W / 2 + Math.cos(a) * rr, y = H / 2 + Math.sin(a) * rr, d = 16 + R() * 26;
      const g = c.createRadialGradient(x, y, 0, x, y, d);
      g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, d, 0, TAU); c.fill();
    }
  });
  const scratch = paint(W, H, (c) => {
    strokes(c, R, 160, { x0: 0, x1: W, y0: 0, y1: H, len: [12, 80], ang: () => R() * TAU, width: [0.6, 1.1], alpha: [0.08, 0.3] });
    strokes(c, R, 6, { x0: W * 0.2, x1: W * 0.8, y0: H * 0.2, y1: H * 0.8, len: [30, 90], ang: () => R() * TAU, width: [1, 1.8], alpha: [0.35, 0.7] });
  });
  const device = paint(W, H, (c) => { c.save(); c.translate(W / 2 + 6, H / 2 + 14); c.scale(2.15, 2.15); c.fillStyle = '#fff'; c.strokeStyle = '#fff'; boarPath(c); c.restore(); });
  const eye = paint(W, H, (c) => { c.fillStyle = '#fff'; c.beginPath(); c.arc(W / 2 + 6 + 56 * 2.15, H / 2 + 14 - 6 * 2.15, 6, 0, TAU); c.fill(); });
  const tusk = paint(W, H, (c) => {
    c.save(); c.translate(W / 2 + 6, H / 2 + 14); c.scale(2.15, 2.15); c.strokeStyle = '#fff'; c.lineWidth = 4; c.lineCap = 'round';
    c.beginPath(); c.moveTo(74, 10); c.quadraticCurveTo(80, -4, 70, -12); c.stroke(); c.restore();
  });
  // painted border just inside the rim: two black rules with a row of black tongues between (black-figure on bronze)
  const band = paint(W, H, (c) => {
    c.strokeStyle = '#fff'; c.lineWidth = W * 0.007;
    for (const rr of [0.4, 0.45]) { c.beginPath(); c.arc(W / 2, H / 2, W * rr, 0, TAU); c.stroke(); }
  });
  const tongues = paint(W, H, (c) => {
    c.fillStyle = '#fff';
    for (let k = 0; k < 40; k++) {
      const a = (k / 40) * TAU;
      c.save(); c.translate(W / 2 + Math.cos(a) * W * 0.425, H / 2 + Math.sin(a) * W * 0.425); c.rotate(a);
      c.beginPath(); c.ellipse(0, 0, W * 0.018, W * 0.0085, 0, 0, TAU); c.fill(); c.restore();
    }
  });
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const p = j * W + i;
    const dx = (i + 0.5) / W - 0.5, dy = (j + 0.5) / H - 0.5, rad = Math.hypot(dx, dy) * 2; // 0 centre → 1 rim edge
    const t = tone[p] - 0.5;
    // planished bronze sheet: concentric spinning/planishing marks
    const rings = Math.sin(rad * 160 + (blot[p] - 0.5) * 6) * 0.5 + 0.5;
    let r = 0.66 + t * 0.08 + (rings - 0.5) * 0.01, g = 0.46 + t * 0.065 + (rings - 0.5) * 0.008, b = 0.27 + t * 0.04;
    const tarn = clamp01(sstep(0.45, 0.85, blot[p]) * 0.7 + sstep(0.7, 0.98, rad) * 0.45);
    r = mix(r, 0.32, tarn * 0.7); g = mix(g, 0.22, tarn * 0.7); b = mix(b, 0.13, tarn * 0.7);
    const verd = sstep(0.62, 0.82, blot[p] * 0.5 + tone[p] * 0.25 + dents[p] * 0.45) * (0.3 + 0.7 * tarn);
    r = mix(r, 0.31, verd); g = mix(g, 0.5, verd); b = mix(b, 0.41, verd);
    // paint, chipped where the metal flexed and scraped through by blows
    const chip = sstep(0.6, 0.68, chipN[p] * 0.75 + fine[p] * 0.25 + scratch[p] * 0.6 + dents[p] * 0.3);
    const black = clamp01(device[p] + tongues[p] + band[p]) * (1 - chip);
    const ivory = clamp01(tusk[p] + eye[p]) * (1 - chip);
    r = mix(r, 0.05, black * 0.94); g = mix(g, 0.045, black * 0.94); b = mix(b, 0.04, black * 0.94);
    r = mix(r, 0.82, ivory); g = mix(g, 0.74, ivory); b = mix(b, 0.6, ivory);
    const paintAmt = clamp01(black + ivory);
    const sc = scratch[p] * (1 - verd);
    r += sc * 0.1 * (1 - paintAmt * 0.5); g += sc * 0.08 * (1 - paintAmt * 0.5); b += sc * 0.05 * (1 - paintAmt * 0.5);
    s.r[p] = r; s.g[p] = g; s.b[p] = b;
    s.rough[p] = mix(0.3 + t * 0.08 + (fine[p] - 0.5) * 0.06 + tarn * 0.24 + verd * 0.5 + sc * 0.12 + dimples[p] * 0.08, 0.62 + (fine[p] - 0.5) * 0.15, paintAmt);
    s.metal[p] = mix(1 - verd * 0.88 - tarn * 0.1, 0, paintAmt);
    s.height[p] = 0.5 - dimples[p] * 0.18 - dents[p] * 0.45 - sc * 0.15 + paintAmt * 0.06;
    s.ao[p] = 1 - dents[p] * 0.2 - verd * 0.2;
  }
  return bake(s, { normal: 1.7, wrap: false, aniso: 8 });
}

// ── reflection probe ──────────────────────────────────────────────────────
/**
 * A small HDR equirect "probe" of the megaron as seen from the weapon table — warm firelit walls, the hearth
 * ahead, braziers, a cool smoke-hole of moonlight above, dark floor and rafters. The scene environment is
 * nearly black away from its fire spot, which leaves polished bronze reading as dark plastic; the weapons
 * reflect this instead (three converts it to PMREM on first use).
 */
let probe: THREE.DataTexture | null = null;
export function hallProbe(): THREE.DataTexture {
  if (probe) return probe;
  const W = 128, H = 64;
  const d = new Uint16Array(W * H * 4);
  const lobes: [number, number, number, number, number, number, number][] = [
    // dir xyz, sharpness, rgb (linear radiance)
    [0, -0.1, -1, 900, 9, 4.2, 1.5],       // hearth core, straight ahead and a little low
    [0, -0.05, -1, 18, 0.55, 0.24, 0.08],  // its glow on the hall
    [-0.82, 0.48, -0.32, 500, 4, 1.9, 0.6], // tripod brazier by the table
    [-0.75, 0.2, -0.65, 60, 0.3, 0.14, 0.05],
    [0.55, 0.12, -0.83, 700, 2.4, 1.1, 0.35], // far brazier
    [0.15, 0.93, -0.33, 160, 0.34, 0.4, 0.52], // moonlight through the smoke-hole
    [0, 0.25, 1, 6, 0.06, 0.035, 0.02],      // the doorway wall behind
  ];
  for (const l of lobes) { const n = Math.hypot(l[0], l[1], l[2]); l[0] /= n; l[1] /= n; l[2] /= n; }
  for (let j = 0; j < H; j++) {
    const th = ((j + 0.5) / H - 0.5) * Math.PI, y = Math.sin(th), cy = Math.cos(th);
    for (let i = 0; i < W; i++) {
      const ph = ((i + 0.5) / W - 0.5) * TAU, x = Math.cos(ph) * cy, z = Math.sin(ph) * cy;
      // walls (warm, brighter toward the hearth) between a dark floor and soot-black rafters
      const wall = sstep(-0.35, -0.12, y) * (1 - sstep(0.35, 0.7, y));
      const ahead = 0.7 + 0.3 * Math.max(0, -z);
      let r = mix(0.05, 0.19 * ahead, wall), g = mix(0.034, 0.1 * ahead, wall), b = mix(0.022, 0.052 * ahead, wall);
      const roof = sstep(0.35, 0.9, y);
      r = mix(r, 0.018, roof); g = mix(g, 0.016, roof); b = mix(b, 0.016, roof);
      for (const l of lobes) {
        const c = x * l[0] + y * l[1] + z * l[2];
        if (c <= 0) continue;
        const k = Math.pow(c, l[3]);
        r += l[4] * k; g += l[5] * k; b += l[6] * k;
      }
      const q = (j * W + i) * 4;
      d[q] = THREE.DataUtils.toHalfFloat(r); d[q + 1] = THREE.DataUtils.toHalfFloat(g); d[q + 2] = THREE.DataUtils.toHalfFloat(b); d[q + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  probe = t;
  return t;
}

// ── materials ─────────────────────────────────────────────────────────────
const sets = new Map<string, TexSet>();
const SETS: Record<string, () => TexSet> = {
  blade: bladeSet, cast: castSet, wood: woodSet, wrap: wrapSet, leather: leatherSet, horn: hornSet,
  clay: claySet, glaze: glazeSet, fruit: fruitSet, iron: ironSet, feather: featherSet, shield: shieldSet,
};
function texSet(key: string): TexSet {
  let t = sets.get(key);
  if (!t) {
    const t0 = performance.now();
    t = (SETS[key] ?? castSet)();
    try { performance.measure(`weapon-skin:${key}`, { start: t0 }); } catch { /* timing only */ }
    sets.set(key, t);
  }
  return t;
}

/** A raw texture set by key ('blade', 'cast', 'wood', 'wrap', 'leather', 'horn', 'clay', 'glaze', 'fruit', 'iron', 'feather', 'shield'). */
export function skinSet(key: string): TexSet { return texSet(key); }

interface SkinDef { set: string; color?: string; rough?: number; metal?: number; env?: number; side?: THREE.Side; alphaTest?: number; normal?: number }
/** Placeholder material name (weaponGeo.ts) → skin. */
const DEFS: Record<string, SkinDef> = {
  'bronze-blade': { set: 'blade', env: 1, normal: 0.7 },
  bronze: { set: 'cast', env: 1 },
  'bronze-oxidized': { set: 'cast', color: '#9d8672', rough: 1.35, env: 0.9 },
  brass: { set: 'cast', color: '#ffe7bf', rough: 0.8, env: 1.05 },
  'ash-wood': { set: 'wood', color: '#f2e2c8', env: 0.6 },
  'dark-wood': { set: 'wood', color: '#93705a', env: 0.6 },
  'bow-wood': { set: 'wood', color: '#7f5a43', rough: 0.78, env: 0.6 },
  'shield-core': { set: 'wood', color: '#c4a587', env: 0.9 },
  'arrow-shaft': { set: 'wood', color: '#fff4e0', env: 0.6 },
  horn: { set: 'horn', env: 0.7 },
  leather: { set: 'leather', env: 0.6 },
  'leather-wrap': { set: 'wrap', env: 0.6 },
  'grip-cord': { set: 'wrap', color: '#d7837a', env: 0.6 }, // oxblood-dyed leather on the xiphos grip
  terracotta: { set: 'clay', env: 0.6 },
  'black-glaze': { set: 'glaze', env: 0.7 },
  pomegranate: { set: 'fruit', env: 0.6 },
  'cast-iron': { set: 'iron', env: 0.8 },
  'shield-face': { set: 'shield', env: 1, normal: 0.8 },
  feather: { set: 'feather', side: THREE.DoubleSide, alphaTest: 0.5, env: 0.6 },
  linen: { set: 'leather', color: '#f4e6cc', rough: 1.2, env: 0.6 },
};

const skins = new Map<string, THREE.MeshStandardMaterial>();
/** The shared skin for a placeholder material name (null if that name has none). */
export function weaponSkin(name: string): THREE.MeshStandardMaterial | null {
  const hit = skins.get(name);
  if (hit) return hit;
  const d = DEFS[name];
  if (!d) return null;
  const t = texSet(d.set);
  const m = new THREE.MeshStandardMaterial({
    name: `skin:${name}`,
    color: d.color ?? '#ffffff',
    map: t.map,
    roughnessMap: t.orm, roughness: d.rough ?? 1,
    metalnessMap: t.orm, metalness: d.metal ?? 1,
    aoMap: t.orm, aoMapIntensity: 1,
    normalMap: t.normal, normalScale: new THREE.Vector2(d.normal ?? 1, d.normal ?? 1),
    envMap: hallProbe(), envMapIntensity: d.env ?? 1,
    side: d.side ?? THREE.FrontSide,
    alphaTest: d.alphaTest ?? 0,
  });
  m.userData.shared = true;
  skins.set(name, m);
  return m;
}

/**
 * Swap every placeholder material under `root` for its shared textured skin (idempotent). With `merge`, the
 * parts of a rigid weapon that end up on the same skin are merged into one mesh (one draw call per skin).
 */
export function dressWeapon(root: THREE.Object3D, opts: { merge?: boolean } = {}) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.getAttribute('uv')) return;
    const swap = (m: THREE.Material) => (m.userData.shared ? m : weaponSkin(m.name) ?? m);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  if (opts.merge) mergeBySkin(root);
}

const KEEP = new Set(['position', 'normal', 'uv']);
function mergeBySkin(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const bySkin = new Map<THREE.Material, THREE.Mesh[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || !m.material.userData.shared || (m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
    const list = bySkin.get(m.material) ?? [];
    list.push(m);
    bySkin.set(m.material, list);
  });
  const xf = new THREE.Matrix4();
  for (const [mat, list] of bySkin) {
    if (list.length < 2) continue;
    const geos = list.map((m) => m.geometry.clone().applyMatrix4(xf.multiplyMatrices(inv, m.matrixWorld)));
    const flat = geos.some((g) => !g.index);
    const ready = geos.map((g) => {
      const h = flat && g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(h.attributes)) if (!KEEP.has(k)) h.deleteAttribute(k);
      return h;
    });
    if (ready.some((g) => Object.keys(g.attributes).length !== 3)) continue;
    const merged = mergeGeometries(ready);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = list.map((m) => m.name).join('+');
    mesh.castShadow = list.some((m) => m.castShadow);
    for (const m of list) m.parent?.remove(m);
    root.add(mesh);
  }
}

/**
 * Bake a weapon group into one geometry with a group per skin (for InstancedMesh props: one draw call per
 * material). `xf` is applied after the parts' own transforms.
 */
export function bakeWeapon(root: THREE.Object3D, xf?: THREE.Matrix4): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
  root.updateMatrixWorld(true);
  const byMat = new Map<string, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    let g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    if (xf) g.applyMatrix4(xf);
    g = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    const key = m.material.name.replace(/^skin:/, '');
    const list = byMat.get(key) ?? [];
    list.push(g);
    byMat.set(key, list);
  });
  const parts: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const [name, list] of byMat) {
    const merged = list.length === 1 ? list[0]! : mergeGeometries(list);
    if (!merged) continue;
    parts.push(merged);
    materials.push(weaponSkin(name) ?? new THREE.MeshStandardMaterial({ color: '#8a6a44', metalness: 0.8, roughness: 0.4 }));
  }
  const geometry = mergeGeometries(parts, true) ?? new THREE.BufferGeometry();
  geometry.computeBoundingSphere();
  return { geometry, materials };
}

/** Generate the remaining texture sets in idle time so a forged gift doesn't hitch the fight when it lands. */
export function prewarmWeaponSkins() {
  const names = Object.keys(DEFS);
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const step = () => {
    const n = names.shift();
    if (!n) return;
    weaponSkin(n);
    if (ric) ric(step, { timeout: 2000 }); else setTimeout(step, 30);
  };
  if (ric) ric(step, { timeout: 2000 }); else setTimeout(step, 200);
}
