// Procedural low-poly weapon models. DOM-free so scripts/make-prefabs.ts can export them to GLB in Node.
// Canonical frame: long axis +Y, grip at the origin ('end' grip: blade toward +Y; 'center': centered).
// Shields: face normal +Y (the thin axis), so "forward" when held.
//
// Materials here are named placeholders: the browser swaps each one (by `material.name`) for a shared,
// textured PBR skin in weaponSkins.ts. Every part carries UVs laid out for those skins — in metres for the
// tiling ones (wood grain along +V, cast bronze, leather wrap) and edge-to-edge across the blade for 'bronze-blade'.
import * as THREE from 'three';
import type { WeaponClass } from '@ithaca/shared';

const std = (name: string, color: string, metalness: number, roughness: number) =>
  new THREE.MeshStandardMaterial({ name, color, metalness, roughness });

export const MAT = {
  /** polished leaf blade / spearhead (UV: u edge→edge across, v base→tip) */
  blade: () => std('bronze-blade', '#B08048', 0.95, 0.3),
  bronze: () => std('bronze', '#9C7442', 0.92, 0.34),
  bronzeDark: () => std('bronze-oxidized', '#5E4930', 0.85, 0.52),
  brass: () => std('brass', '#C49A4A', 1, 0.28),
  wood: () => std('ash-wood', '#6A4A2C', 0, 0.82),
  woodDark: () => std('dark-wood', '#3B2A1C', 0, 0.85),
  bowWood: () => std('bow-wood', '#3B2A1C', 0, 0.6),
  horn: () => std('horn', '#5A4630', 0, 0.35),
  leather: () => std('leather', '#3A2618', 0, 0.9),
  leatherWrap: () => std('leather-wrap', '#3A2618', 0, 0.8),
  gripCord: () => std('grip-cord', '#7A2420', 0, 0.8),
  clay: () => std('terracotta', '#B5562E', 0, 0.88),
  glaze: () => std('black-glaze', '#16110D', 0.1, 0.35),
  linen: () => std('linen', '#D6CCBA', 0, 0.95),
  iron: () => std('cast-iron', '#2A2724', 0.75, 0.55),
  fruit: () => std('pomegranate', '#8E2A1F', 0, 0.55),
  shieldFace: () => std('shield-face', '#9C7442', 0.9, 0.36),
  shieldCore: () => std('shield-core', '#5a3e26', 0, 0.85),
  arrowShaft: () => std('arrow-shaft', '#cdbf9e', 0, 0.7),
  feather: () => { const m = std('feather', '#d8cfc0', 0, 0.85); m.side = THREE.DoubleSide; return m; },
  ember: () => new THREE.MeshStandardMaterial({ name: 'ember', color: '#3A1A0A', emissive: '#FF7A22', emissiveIntensity: 2.2, roughness: 1 }),
  sinew: () => std('sinew', '#D9C9A6', 0, 0.7),
};

const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
  const o = new THREE.Mesh(g, m);
  o.name = name;
  o.castShadow = true;
  return o;
};

// ── UV helpers ────────────────────────────────────────────────────────────
/** Scale every UV (texture tiles are laid out in metres by the caller). */
function scaleUV<G extends THREE.BufferGeometry>(g: G, su: number, sv: number): G {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return g;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return g;
}
/** Cylinder: u once around (an integer number of tiles, so no seam), v along the height, in `tile`-metre tiles. */
function cylUV<G extends THREE.BufferGeometry>(g: G, r: number, h: number, tileU: number, tileV: number): G {
  return scaleUV(g, Math.max(1, Math.round((Math.PI * 2 * r) / tileU)), h / tileV);
}
/** Swap u↔v (tubes run u along the curve; the skins want grain along v). */
function swapUV<G extends THREE.BufferGeometry>(g: G): G {
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return g;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
  uv.needsUpdate = true;
  return g;
}
/** Box/cube projection from the vertex normal, `tile` metres per texture repeat (consistent texel density). */
export function cubeUV<G extends THREE.BufferGeometry>(g: G, tile: number): G {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u: number, v: number;
    if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); } else if (ay >= az) { u = p.getX(i); v = p.getZ(i); } else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u / tile; uv[i * 2 + 1] = v / tile;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
/** Planar projection onto XZ (shield faces): the disc of radius `r` maps to the unit square. */
function planarXZ<G extends THREE.BufferGeometry>(g: G, r: number, flipU = false): G {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = 0.5 + ((flipU ? -1 : 1) * p.getX(i)) / (2 * r);
    uv[i * 2 + 1] = 0.5 - p.getZ(i) / (2 * r);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// ── lofted blades ─────────────────────────────────────────────────────────
/** Smooth (Hermite / Catmull-Rom) interpolation through (t, f) control points. */
function spline(T: number[], F: number[]): (t: number) => number {
  const n = T.length;
  const at = (a: number[], i: number) => a[Math.max(0, Math.min(n - 1, i))] ?? 0;
  const slope = (i: number) => (at(F, i + 1) - at(F, i - 1)) / Math.max(1e-6, at(T, i + 1) - at(T, i - 1));
  return (t: number) => {
    let i = 0;
    while (i < n - 2 && t > at(T, i + 1)) i++;
    const t0 = at(T, i), t1 = at(T, i + 1), dt = t1 - t0 || 1;
    const s = Math.max(0, Math.min(1, (t - t0) / dt));
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * at(F, i) + (s3 - 2 * s2 + s) * slope(i) * dt + (-2 * s3 + 3 * s2) * at(F, i + 1) + (s3 - s2) * slope(i + 1) * dt;
  };
}

interface BladeLoft {
  len: number;
  /** max half-width (m) */
  halfW: number;
  /** half-thickness at the midrib (m) */
  zMax: number;
  /** half-width fraction along the blade (t = 0 at the hilt, 1 at the point) */
  prof: (t: number) => number;
  /** one half's cross-section: [s, z] with s = 0 at the midrib → 1 at the edge, z normalized */
  xs: [number, number][];
  /** column groups shaded smooth inside, crisp between (bevel lines, midrib flanks) */
  groups: number[][];
  rows: number;
  /** thickness taper toward the point */
  taper: (t: number) => number;
}

/**
 * A blade lofted along +Y with a real cross-section (midrib, fullers, cutting bevel, sharp edge) and crisp
 * facet lines. UV: u = 0 / 1 at the edges and 0.5 on the midrib, v = 0 at the hilt → 1 at the point.
 */
function loftBlade(L: BladeLoft): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
  for (const side of [1, -1]) for (const sx of [1, -1]) for (const grp of L.groups) {
    const cols = grp.length;
    const p: number[] = [], u: number[] = [], id: number[] = [];
    for (let r = 0; r <= L.rows; r++) {
      const t = r / L.rows;
      const f = Math.max(0, L.prof(t));
      const hw = L.halfW * f;
      const zt = L.zMax * L.taper(t) * Math.min(1, f / 0.35);
      for (const ci of grp) {
        const c = L.xs[ci] ?? [0, 0];
        p.push(sx * c[0] * hw, t * L.len, side * c[1] * zt);
        u.push(0.5 + sx * c[0] * 0.5, t);
      }
    }
    for (let r = 0; r < L.rows; r++) for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, c2 = a + cols + 1, d = a + cols;
      if ((sx > 0) === (side > 0)) id.push(a, b, c2, a, c2, d); else id.push(a, c2, b, a, d, c2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex(id);
    g.computeVertexNormals();
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const base = pos.length / 3;
    for (let i = 0; i < p.length; i++) pos.push(p[i] ?? 0);
    for (let i = 0; i < u.length; i++) uv.push(u[i] ?? 0);
    for (let i = 0; i < n.count; i++) {
      // the point row collapses to one vertex (zero-area faces): give it the face normal instead of (0, 0, 0)
      const x = n.getX(i), y = n.getY(i), z = n.getZ(i), l = Math.hypot(x, y, z);
      if (l > 1e-6) nor.push(x / l, y / l, z / l); else nor.push(0, 0, side);
    }
    for (const k of id) idx.push(base + k);
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Xiphos / Naue II leaf: waisted below the guard, swelling at two-thirds, midrib with shallow fullers, honed bevel. */
function xiphosBlade(len: number, width: number) {
  return loftBlade({
    len, halfW: width / 2, zMax: Math.max(0.0032, width * 0.065), rows: 34,
    prof: spline([0, 0.1, 0.35, 0.62, 0.8, 0.93, 1], [0.6, 0.52, 0.8, 1, 0.86, 0.48, 0]),
    xs: [[0, 1], [0.1, 0.86], [0.2, 0.52], [0.32, 0.42], [0.46, 0.5], [0.62, 0.52], [0.84, 0.36], [1, 0]],
    groups: [[0, 1, 2], [2, 3, 4, 5, 6], [6, 7]],
    taper: (t) => 1 - 0.5 * Math.pow(t, 1.4),
  });
}

/** Mycenaean leaf spearhead: broad shoulders low, long taper, a strong round midrib that runs into the socket. */
function spearheadBlade(len: number, width: number) {
  return loftBlade({
    len, halfW: width / 2, zMax: width * 0.2, rows: 26,
    prof: spline([0, 0.1, 0.3, 0.52, 0.78, 1], [0.3, 0.62, 1, 0.84, 0.44, 0]),
    xs: [[0, 1], [0.12, 0.84], [0.24, 0.3], [0.7, 0.2], [1, 0]],
    groups: [[0, 1, 2], [2, 3], [3, 4]],
    taper: (t) => 1 - 0.75 * t,
  });
}

/** Dory: ash shaft, bronze leaf spearhead, bronze butt-spike (sauroter). Grip at the end. */
export function buildSpear(length = 1.8): THREE.Group {
  const g = new THREE.Group();
  g.name = 'spear';
  const k = length / 1.8;
  const shaftLen = 1.38 * k;
  const shaft = mesh(cylUV(new THREE.CylinderGeometry(0.017 * k, 0.019 * k, shaftLen, 10), 0.018 * k, shaftLen, 0.11, 0.55), MAT.wood(), 'shaft');
  shaft.position.y = shaftLen / 2 - 0.08 * k;
  g.add(shaft);
  // sauroter: a square-sectioned spike with a collar
  const butt = mesh(cubeUV(new THREE.ConeGeometry(0.021 * k, 0.13 * k, 4), 0.1), MAT.bronze(), 'sauroter');
  butt.rotation.set(Math.PI, Math.PI / 4, 0);
  butt.position.y = -0.145 * k;
  g.add(butt);
  const collar = mesh(cubeUV(new THREE.CylinderGeometry(0.021 * k, 0.021 * k, 0.04 * k, 10), 0.1), MAT.bronze(), 'sauroter-collar');
  collar.position.y = -0.08 * k;
  g.add(collar);
  const socket = mesh(cubeUV(new THREE.CylinderGeometry(0.016 * k, 0.022 * k, 0.12 * k, 10), 0.1), MAT.bronze(), 'socket');
  socket.position.y = shaftLen - 0.08 * k + 0.02 * k;
  g.add(socket);
  const ring = mesh(cubeUV(new THREE.TorusGeometry(0.022 * k, 0.004 * k, 5, 14), 0.1), MAT.bronzeDark(), 'socket-ring');
  ring.rotation.x = Math.PI / 2;
  ring.position.y = shaftLen - 0.08 * k - 0.035 * k;
  g.add(ring);
  const head = mesh(spearheadBlade(0.34 * k, 0.085 * k), MAT.blade(), 'spearhead');
  head.position.y = shaftLen - 0.04 * k;
  g.add(head);
  const wrap = mesh(cylUV(new THREE.CylinderGeometry(0.022 * k, 0.022 * k, 0.16 * k, 12), 0.022 * k, 0.16 * k, 0.14, 0.05), MAT.leatherWrap(), 'grip');
  wrap.position.y = 0.02;
  g.add(wrap);
  return g;
}

/** Xiphos-style leaf blade. `length` overall (dagger ≈ 0.45, sword ≈ 0.9). */
export function buildBlade(length = 0.9): THREE.Group {
  const g = new THREE.Group();
  g.name = 'blade';
  const hilt = Math.max(0.1, length * 0.17);
  const bladeLen = length - hilt - 0.03;
  const width = length * 0.085;
  // leather-wrapped grip over the tang, swelling slightly at the middle (a lathe, so the wrap follows it)
  const gr = 0.017;
  // (evenly spaced profile points: lathe v runs uniformly along the grip, u once around)
  const gripGeo = new THREE.LatheGeometry([
    new THREE.Vector2(gr * 0.92, -hilt / 2), new THREE.Vector2(gr * 1.05, -hilt / 6), new THREE.Vector2(gr * 1.05, hilt / 6), new THREE.Vector2(gr * 0.92, hilt / 2),
  ], 12);
  scaleUV(gripGeo, 1, hilt / 0.05);
  const grip = mesh(gripGeo, MAT.gripCord(), 'grip');
  grip.position.y = hilt / 2 - 0.04;
  g.add(grip);
  const pommel = mesh(cubeUV(new THREE.SphereGeometry(0.026, 14, 8), 0.08), MAT.bronze(), 'pommel');
  pommel.scale.set(1.3, 0.7, 1);
  pommel.position.y = -0.045;
  g.add(pommel);
  const pommelCap = mesh(cubeUV(new THREE.CylinderGeometry(0.01, 0.014, 0.012, 10), 0.08), MAT.brass(), 'pommel-cap');
  pommelCap.position.y = -0.06;
  g.add(pommelCap);
  // cross-guard: a bar with rounded ends (lenticular in section)
  const guardGeo = new THREE.CapsuleGeometry(0.011, width * 1.5, 3, 8);
  guardGeo.rotateZ(Math.PI / 2);
  guardGeo.scale(1, 0.85, 1.25);
  cubeUV(guardGeo, 0.08);
  const guard = mesh(guardGeo, MAT.bronze(), 'guard');
  guard.position.y = hilt - 0.035;
  g.add(guard);
  // rivets where the blade's shoulders seat into the hilt
  for (const sx of [-1, 1]) {
    const rv = mesh(cubeUV(new THREE.SphereGeometry(0.0045, 8, 6), 0.05), MAT.brass(), 'rivet');
    rv.position.set(sx * width * 0.28, hilt - 0.012, 0);
    rv.scale.set(1, 1, 1.9);
    g.add(rv);
  }
  const blade = mesh(xiphosBlade(bladeLen, width), MAT.blade(), 'blade');
  blade.position.y = hilt - 0.03;
  g.add(blade);
  return g;
}

/** Bronze-headed club (generic 'blunt' fallback): olive-wood haft, knobbed pear-shaped bronze head. */
export function buildClub(length = 0.5): THREE.Group {
  const g = new THREE.Group();
  g.name = 'club';
  const k = length / 0.5;
  const handle = mesh(cylUV(new THREE.CylinderGeometry(0.02 * k, 0.026 * k, 0.36 * k, 10), 0.023 * k, 0.36 * k, 0.11, 0.5), MAT.woodDark(), 'handle');
  handle.position.y = 0.14 * k;
  g.add(handle);
  const wrap = mesh(cylUV(new THREE.CylinderGeometry(0.0225 * k, 0.0225 * k, 0.12 * k, 12), 0.0225 * k, 0.12 * k, 0.14, 0.05), MAT.leatherWrap(), 'grip');
  wrap.position.y = 0.02 * k;
  g.add(wrap);
  const headGeo = new THREE.LatheGeometry([
    new THREE.Vector2(0.001, -0.06 * k), new THREE.Vector2(0.03 * k, -0.058 * k), new THREE.Vector2(0.055 * k, -0.025 * k),
    new THREE.Vector2(0.064 * k, 0.015 * k), new THREE.Vector2(0.05 * k, 0.05 * k), new THREE.Vector2(0.024 * k, 0.068 * k), new THREE.Vector2(0.001, 0.07 * k),
  ], 16);
  cubeUV(headGeo, 0.1);
  const head = mesh(headGeo, MAT.bronze(), 'head');
  head.position.y = 0.38 * k;
  g.add(head);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const knob = mesh(cubeUV(new THREE.SphereGeometry(0.017 * k, 8, 6), 0.06), MAT.bronze(), 'knob');
    knob.position.set(Math.cos(a) * 0.058 * k, 0.385 * k, Math.sin(a) * 0.058 * k);
    g.add(knob);
  }
  const band = mesh(cubeUV(new THREE.TorusGeometry(0.03 * k, 0.008 * k, 6, 14), 0.06), MAT.brass(), 'band');
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.315 * k;
  g.add(band);
  return g;
}

/** Frying pan (the mock-mode "real object" forged weapon, public/dev/sample-weapon.glb). */
export function buildFryingPan(length = 0.5): THREE.Group {
  const g = new THREE.Group();
  g.name = 'frying-pan';
  const k = length / 0.5;
  const handle = mesh(cubeUV(new THREE.BoxGeometry(0.03 * k, 0.24 * k, 0.016 * k), 0.12), MAT.woodDark(), 'handle');
  handle.position.y = 0.1 * k;
  g.add(handle);
  const neck = mesh(cubeUV(new THREE.CylinderGeometry(0.012 * k, 0.014 * k, 0.05 * k, 6), 0.1), MAT.iron(), 'neck');
  neck.position.y = 0.24 * k;
  g.add(neck);
  const panProfile = [
    new THREE.Vector2(0, 0), new THREE.Vector2(0.11 * k, 0), new THREE.Vector2(0.125 * k, 0.04 * k),
    new THREE.Vector2(0.118 * k, 0.042 * k), new THREE.Vector2(0.104 * k, 0.008 * k), new THREE.Vector2(0, 0.008 * k),
  ];
  const pan = mesh(cubeUV(new THREE.LatheGeometry(panProfile, 18), 0.15), MAT.iron(), 'pan');
  pan.rotation.x = -Math.PI / 2;
  pan.position.set(0, 0.38 * k, -0.01 * k);
  g.add(pan);
  return g;
}

/** Pomegranate (generic 'throwable'). Centered. */
export function buildPomegranate(size = 0.2): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pomegranate';
  const r = size * 0.42;
  const body = mesh(cubeUV(new THREE.IcosahedronGeometry(r, 2), 0.12), MAT.fruit(), 'fruit');
  body.scale.set(1, 0.92, 1);
  g.add(body);
  const crown = mesh(cubeUV(new THREE.CylinderGeometry(r * 0.28, r * 0.18, r * 0.38, 6, 1, true), 0.06), MAT.fruit(), 'crown');
  crown.position.y = r * 1.0;
  g.add(crown);
  return g;
}

/** Aspis: round hoplite shield — bronze-faced wooden core, bronze rim, porpax + antilabe grip. Normal +Y; centered. */
export function buildAspis(diameter = 0.7): THREE.Group {
  const g = new THREE.Group();
  g.name = 'aspis';
  const r = diameter / 2;
  const R = r * 1.04;
  // the bronze facing (dished front) and the wooden core seen from behind are separate shells, so the device
  // painted on the front never shows through on the inside
  // (lathe faces point to the left of the profile's direction: rim → centre on the front, centre → rim behind)
  const front = [
    new THREE.Vector2(R, 0), new THREE.Vector2(r, 0.01), new THREE.Vector2(r * 0.9, 0.025 * diameter), new THREE.Vector2(r * 0.75, 0.039 * diameter),
    new THREE.Vector2(r * 0.55, 0.05 * diameter), new THREE.Vector2(r * 0.3, 0.057 * diameter), new THREE.Vector2(0.0001, 0.06 * diameter),
  ];
  const back = [new THREE.Vector2(0.0001, -0.01), new THREE.Vector2(r * 0.5, -0.011), new THREE.Vector2(r, -0.012), new THREE.Vector2(R, 0)];
  const face = mesh(planarXZ(new THREE.LatheGeometry(front, 40), R), MAT.shieldFace(), 'face');
  g.add(face);
  const coreGeo = new THREE.LatheGeometry(back, 40);
  // wood grain across the core (planks run along Z), ≈ 0.1 m × 0.5 m tiles
  const cp = coreGeo.getAttribute('position') as THREE.BufferAttribute;
  const cuv = new Float32Array(cp.count * 2);
  for (let i = 0; i < cp.count; i++) { cuv[i * 2] = cp.getX(i) / 0.11; cuv[i * 2 + 1] = cp.getZ(i) / 0.55; }
  coreGeo.setAttribute('uv', new THREE.BufferAttribute(cuv, 2));
  g.add(mesh(coreGeo, MAT.shieldCore(), 'core'));
  const rimGeo = new THREE.TorusGeometry(r * 1.0, 0.016 * diameter, 6, 48);
  scaleUV(rimGeo, Math.round((Math.PI * 2 * r) / 0.12), 1);
  const rim = mesh(rimGeo, MAT.bronzeDark(), 'rim');
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  const boss = mesh(cubeUV(new THREE.SphereGeometry(r * 0.13, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0.1), MAT.brass(), 'boss');
  boss.position.y = 0.055 * diameter;
  g.add(boss);
  // porpax: the bronze-lined leather armband at the centre; antilabe: the cord handgrip near the rim
  const strap = mesh(cubeUV(new THREE.BoxGeometry(r * 0.7, 0.02, 0.045), 0.08), MAT.leather(), 'porpax');
  strap.position.y = -0.03;
  g.add(strap);
  for (const sx of [-1, 1]) {
    const lug = mesh(cubeUV(new THREE.BoxGeometry(0.03, 0.03, 0.05), 0.06), MAT.bronze(), 'porpax-lug');
    lug.position.set(sx * r * 0.36, -0.022, 0);
    g.add(lug);
  }
  const antilabe = mesh(cylUV(new THREE.CylinderGeometry(0.009, 0.009, r * 0.32, 8), 0.009, r * 0.32, 0.14, 0.05), MAT.leatherWrap(), 'antilabe');
  antilabe.rotation.x = Math.PI / 2;
  antilabe.position.set(r * 0.8, -0.03, 0);
  g.add(antilabe);
  return g;
}

/** Greek-fire pot (generic 'bomb'): clay belly, black-glaze band, glowing rag wick. Centered. */
export function buildFirePot(size = 0.25): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fire-pot';
  const k = size / 0.25;
  const profile = [
    new THREE.Vector2(0, -0.1 * k), new THREE.Vector2(0.05 * k, -0.1 * k), new THREE.Vector2(0.09 * k, -0.05 * k),
    new THREE.Vector2(0.095 * k, 0.01 * k), new THREE.Vector2(0.06 * k, 0.06 * k), new THREE.Vector2(0.03 * k, 0.08 * k),
    new THREE.Vector2(0.034 * k, 0.1 * k), new THREE.Vector2(0, 0.1 * k),
  ];
  g.add(mesh(new THREE.LatheGeometry(profile, 24), MAT.clay(), 'pot'));
  const band = mesh(new THREE.CylinderGeometry(0.097 * k, 0.093 * k, 0.03 * k, 24, 1, true), MAT.glaze(), 'band');
  band.position.y = -0.005 * k;
  g.add(band);
  const wick = mesh(new THREE.ConeGeometry(0.022 * k, 0.07 * k, 5), MAT.ember(), 'wick');
  wick.position.y = 0.13 * k;
  g.add(wick);
  const rag = mesh(cylUV(new THREE.CylinderGeometry(0.036 * k, 0.03 * k, 0.025 * k, 10), 0.036 * k, 0.025 * k, 0.14, 0.05), MAT.linen(), 'rag');
  rag.position.y = 0.105 * k;
  g.add(rag);
  return g;
}

/** Aryballos flask (generic 'potion'). Centered, upright along +Y. */
export function buildFlask(size = 0.22): THREE.Group {
  const g = new THREE.Group();
  g.name = 'flask';
  const k = size / 0.22;
  const profile = [
    new THREE.Vector2(0, -0.1 * k), new THREE.Vector2(0.055 * k, -0.09 * k), new THREE.Vector2(0.07 * k, -0.04 * k),
    new THREE.Vector2(0.06 * k, 0.01 * k), new THREE.Vector2(0.02 * k, 0.05 * k), new THREE.Vector2(0.018 * k, 0.08 * k),
    new THREE.Vector2(0.034 * k, 0.09 * k), new THREE.Vector2(0, 0.095 * k),
  ];
  g.add(mesh(new THREE.LatheGeometry(profile, 24), MAT.clay(), 'flask'));
  const band = mesh(new THREE.CylinderGeometry(0.071 * k, 0.068 * k, 0.03 * k, 24, 1, true), MAT.glaze(), 'band');
  band.position.y = -0.035 * k;
  g.add(band);
  const cork = mesh(cylUV(new THREE.CylinderGeometry(0.016 * k, 0.014 * k, 0.03 * k, 8), 0.016 * k, 0.03 * k, 0.11, 0.5), MAT.woodDark(), 'stopper');
  cork.position.y = 0.105 * k;
  g.add(cork);
  return g;
}

/** Palintonos (back-curved composite) bow — the bow of Odysseus. Grip at center, limbs along ±Y. */
export function buildBowStave(): { group: THREE.Group; tipTop: THREE.Vector3; tipBottom: THREE.Vector3 } {
  const g = new THREE.Group();
  g.name = 'bow';
  const pts: THREE.Vector3[] = [];
  // Recurve profile in the YZ plane: belly toward the archer (+Z local), tips recurve forward.
  for (let i = 0; i <= 16; i++) {
    const t = i / 16 * 2 - 1;               // -1..1
    const y = t * 0.62;
    const bend = 0.09 * (1 - t * t);        // main curve away from archer
    const recurve = Math.pow(Math.abs(t), 6) * 0.08; // tips flick back
    pts.push(new THREE.Vector3(0, y, -bend + recurve + 0.06));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const L = curve.getLength();
  // wooden core (sinew-backed, lacquered) with the horn belly laminated on the archer's side
  const limb = mesh(scaleUV(swapUV(new THREE.TubeGeometry(curve, 48, 0.014, 8, false)), 1, L / 0.5), MAT.bowWood(), 'stave');
  g.add(limb);
  const horn = mesh(scaleUV(swapUV(new THREE.TubeGeometry(curve, 48, 0.009, 6, false)), 1, L / 0.25), MAT.horn(), 'horn-inlay');
  horn.position.z = 0.008;
  g.add(horn);
  const grip = mesh(cylUV(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 12), 0.02, 0.12, 0.14, 0.05), MAT.leatherWrap(), 'grip');
  grip.position.z = -0.03;
  g.add(grip);
  for (const sgn of [1, -1]) {
    const cap = mesh(cubeUV(new THREE.SphereGeometry(0.014, 10, 6), 0.05), MAT.brass(), 'nock-cap');
    cap.position.copy(pts[sgn > 0 ? 16 : 0] ?? new THREE.Vector3());
    g.add(cap);
  }
  const t0 = pts[16] ?? new THREE.Vector3(), t1 = pts[0] ?? new THREE.Vector3();
  return { group: g, tipTop: t0.clone(), tipBottom: t1.clone() };
}

/** Arrow: reed shaft, bronze head, fletching. Tail at origin, tip at +Y length. */
export function buildArrow(length = 0.78): THREE.Group {
  const g = new THREE.Group();
  g.name = 'arrow';
  const sl = length - 0.06;
  const shaft = mesh(cylUV(new THREE.CylinderGeometry(0.0045, 0.0045, sl, 5), 0.0045, sl, 0.11, 0.55), MAT.arrowShaft(), 'shaft');
  shaft.position.y = sl / 2;
  g.add(shaft);
  // leaf-bladed bronze head (two wings + midrib)
  const headGeo = spearheadBlade(0.07, 0.024);
  headGeo.translate(0, -0.035, 0);
  const head = mesh(headGeo, MAT.blade(), 'head');
  head.position.y = length - 0.035;
  g.add(head);
  for (let i = 0; i < 3; i++) {
    const f = mesh(new THREE.PlaneGeometry(0.022, 0.09), MAT.feather(), 'fletch');
    f.position.y = 0.06;
    f.rotation.y = (i / 3) * Math.PI * 2;
    f.translateX(0.012);
    g.add(f);
  }
  return g;
}

export const PREFAB_BUILDERS: Record<WeaponClass, () => THREE.Group> = {
  spear: () => buildSpear(1.8),
  sword: () => buildBlade(0.9),
  blunt: () => buildClub(0.5),
  throwable: () => buildPomegranate(0.2),
  shield: () => buildAspis(0.7),
  bomb: () => buildFirePot(0.25),
  potion: () => buildFlask(0.22),
};
