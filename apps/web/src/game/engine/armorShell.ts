// Armour grown from the realistic body itself — the Blade & Sorcery approach: every piece is skinned to the
// same skeleton as the man, so it fits him and moves with him (and comes off with a severed limb).
//  • muscle cuirass: his own torso offset outward and cast in bronze — the body's normal map supplies the
//    anatomical relief (pecs, abs, serratus), which is exactly what a Greek "muscle cuirass" is
//  • linothorax: the torso inflated, concavities filled so the stiff linen hangs straight from the chest,
//    with a dyed border at the hem and collar
//  • greaves (shaped to the calf), forearm bracers, Antinous's pelt over the shoulders, baggy trousers
// Built once per body template; each warrior gets his own index (which pieces he wears) and vertex colours.
import * as THREE from 'three';
import type { BoneMap } from './skinnedBody';

export type ShellRegion = 'muscle' | 'linen' | 'greaveL' | 'greaveR' | 'bracerL' | 'bracerR' | 'pelt' | 'trouserThigh' | 'trouserCalf';
const REGIONS: ShellRegion[] = ['muscle', 'linen', 'greaveL', 'greaveR', 'bracerL', 'bracerR', 'pelt', 'trouserThigh', 'trouserCalf'];

type Group = 'pelvis' | 'torso' | 'neck' | 'head' | 'uarmL' | 'uarmR' | 'larmL' | 'larmR' | 'hand' | 'thighL' | 'thighR' | 'calfL' | 'calfR' | 'foot';
const KEY_GROUP: Record<string, Group> = {
  hips: 'pelvis', spine0: 'torso', spine1: 'torso', chest: 'torso', neck: 'neck', head: 'head',
  uarmL: 'uarmL', uarmR: 'uarmR', larmL: 'larmL', larmR: 'larmR', handL: 'hand', handR: 'hand',
  thighL: 'thighL', thighR: 'thighR', calfL: 'calfL', calfR: 'calfR', footL: 'foot', footR: 'foot',
};

export interface ShellTemplate {
  /** all regions, each with its own vertices (offsets differ), in the source mesh's bind space */
  geometry: THREE.BufferGeometry;
  index: Uint32Array;
  ranges: Record<ShellRegion, { start: number; count: number }>;
  region: Uint8Array;   // per vertex: REGIONS index
  rim: Float32Array;    // per vertex: 1 on the piece's edge, 0.5 one ring in, 0 inside
  restY: Float32Array;  // per vertex: rest height in metres (bands)
  bottom: Float32Array; // per vertex: 1 near the piece's lower hem
  noise: Float32Array;  // per vertex: stable 0..1 noise (fur, wear)
  primary: Uint8Array;  // per vertex: 1 if its UVs index the primary mesh's normal map
  restX: Float32Array;  // per vertex: rest x (shoulder flaps)
  land: { pelvisY: number; armpitY: number; neckY: number };
  source: string;       // name of the body mesh to bind to
  normalMap: THREE.Texture | null;
}

interface Spec {
  off: number; fill: number; smooth: number; flare?: number; flareBand?: number;
  /** which body skin the piece may cover (bone weights only) */
  wt: (v: number) => boolean;
  /** the cut: hem / collar heights (vertex-dependent); the ring just past the cut is clamped onto it */
  yMin?: (v: number) => number;
  yMax?: (v: number) => number;
  /** extra non-height cut (e.g. along the forearm) */
  core?: (v: number) => boolean;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * `srcs[0]` is the body mesh the shell binds to (its skeleton, its normal map). Other meshes on the same rig
 * (Rocketbox splits the neck and a V of upper chest into the head mesh) are merged in through world space,
 * with their bone indices remapped onto the primary skeleton.
 */
export function buildShellTemplate(srcs: THREE.SkinnedMesh[], map: BoneMap): ShellTemplate | null {
  const src = srcs[0];
  const bones = src.skeleton.bones;
  src.updateMatrixWorld(true);
  const M = src.matrixWorld.clone();
  const Minv = M.clone().invert();
  const NMinv = new THREE.Matrix3().setFromMatrix4(M).transpose(); // local normal = Mᵀ · world normal
  // combined vertex data in world space
  const Pa: number[] = [], NWa: number[] = [], UVa: number[] = [], SIa: number[] = [], SWa: number[] = [], PRa: number[] = [];
  const idxA: number[] = [];
  for (const [mi, mesh] of srcs.entries()) {
    const g = mesh.geometry;
    const pos = g.attributes.position as THREE.BufferAttribute, nor = g.attributes.normal as THREE.BufferAttribute | undefined;
    const si = g.attributes.skinIndex as THREE.BufferAttribute, sw = g.attributes.skinWeight as THREE.BufferAttribute;
    const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
    if (!pos || !si || !sw || !nor) { if (mi === 0) return null; continue; }
    mesh.updateMatrixWorld(true);
    const Mm = mesh.matrixWorld, NMm = new THREE.Matrix3().getNormalMatrix(Mm);
    const remap = mesh.skeleton.bones.map((b) => bones.indexOf(b));
    const base = Pa.length / 3;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(Mm); Pa.push(_v.x, _v.y, _v.z);
      _n.fromBufferAttribute(nor, i).applyMatrix3(NMm).normalize(); NWa.push(_n.x, _n.y, _n.z);
      UVa.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      for (let k = 0; k < 4; k++) {
        const b = remap[si.getComponent(i, k)];
        SIa.push(b < 0 ? 0 : b); SWa.push(b < 0 ? 0 : sw.getComponent(i, k));
      }
      PRa.push(mi === 0 ? 1 : 0);
    }
    const ix = g.index ? (g.index.array as ArrayLike<number>) : null;
    const n = ix ? ix.length : pos.count;
    for (let t = 0; t < n; t++) idxA.push(base + (ix ? ix[t] : t));
  }
  const N = Pa.length / 3;
  const P = new Float32Array(Pa), NW = new Float32Array(NWa);

  // bone → body group: nearest mapped ancestor
  const keyOf = new Map<THREE.Object3D, Group>();
  for (const [k, b] of Object.entries(map)) if (b) keyOf.set(b, KEY_GROUP[k]);
  const boneGroup: (Group | null)[] = bones.map((b) => {
    for (let o: THREE.Object3D | null = b; o; o = o.parent) { const k = keyOf.get(o); if (k) return k; }
    return null;
  });
  const W: Record<Group, Float32Array> = {} as Record<Group, Float32Array>;
  for (const k of new Set(Object.values(KEY_GROUP))) W[k] = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 4; k++) {
      const w = SWa[i * 4 + k];
      const grp = boneGroup[SIa[i * 4 + k]];
      if (w > 0 && grp) W[grp][i] += w;
    }
  }
  const X = (i: number) => P[i * 3], Y = (i: number) => P[i * 3 + 1], Z = (i: number) => P[i * 3 + 2];
  const bw = (b?: THREE.Object3D) => (b ? b.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3());
  const pelvisY = bw(map.hips).y, neckY = bw(map.neck ?? map.head).y, armpitY = bw(map.uarmL).y - 0.1;
  const along = (i: number, a?: THREE.Object3D, b?: THREE.Object3D) => {
    if (!a || !b) return 0;
    const pa = bw(a), d = bw(b).sub(pa);
    return _v.set(X(i), Y(i), Z(i)).sub(pa).dot(d) / Math.max(1e-6, d.lengthSq());
  };
  const kneeY = bw(map.calfL).y, ankleY = bw(map.footL).y;

  // weld UV seams: one canonical vertex per position so smoothing doesn't tear the shell open
  const canon = new Int32Array(N);
  const seen = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const key = `${Math.round(X(i) * 2000)},${Math.round(Y(i) * 2000)},${Math.round(Z(i) * 2000)}`;
    const c = seen.get(key);
    canon[i] = c === undefined ? i : c;
    if (c === undefined) seen.set(key, i);
  }

  const trunk = (i: number) => W.torso[i] + W.pelvis[i] + W.neck[i];
  const arm = (i: number) => W.uarmL[i] + W.uarmR[i];
  const legs = (i: number) => W.thighL[i] + W.thighR[i] + W.calfL[i] + W.calfR[i];
  // shoulder caps: the top of the upper arm near the joint belongs to the torso pieces
  const shoulderCap = (i: number) => (W.uarmL[i] >= 0.3 && along(i, map.uarmL, map.larmL) < 0.12) || (W.uarmR[i] >= 0.3 && along(i, map.uarmR, map.larmR) < 0.12);
  const collar = () => neckY - 0.035;
  const SPECS: Record<ShellRegion, Spec> = {
    muscle: { off: 0.017, fill: 3, smooth: 1, flare: 0.014, flareBand: 0.06,
      wt: (i) => (trunk(i) >= 0.5 || shoulderCap(i)) && W.head[i] < 0.2 && legs(i) < 0.5, yMin: () => pelvisY + 0.05, yMax: collar },
    linen: { off: 0.03, fill: 40, smooth: 5, flare: 0.024, flareBand: 0.09,
      wt: (i) => (trunk(i) >= 0.5 || shoulderCap(i)) && W.head[i] < 0.2 && legs(i) < 0.5, yMin: () => pelvisY - 0.03, yMax: collar },
    greaveL: { off: 0.012, fill: 3, smooth: 1, wt: (i) => W.calfL[i] >= 0.5, yMin: () => ankleY + 0.07, yMax: () => kneeY + 0.06 },
    greaveR: { off: 0.012, fill: 3, smooth: 1, wt: (i) => W.calfR[i] >= 0.5, yMin: () => ankleY + 0.07, yMax: () => kneeY + 0.06 },
    bracerL: { off: 0.01, fill: 2, smooth: 2, wt: (i) => W.larmL[i] + W.hand[i] >= 0.5,
      core: (i) => W.larmL[i] >= 0.5 && along(i, map.larmL, map.handL) >= 0.42 && along(i, map.larmL, map.handL) <= 0.95 },
    bracerR: { off: 0.01, fill: 2, smooth: 2, wt: (i) => W.larmR[i] + W.hand[i] >= 0.5,
      core: (i) => W.larmR[i] >= 0.5 && along(i, map.larmR, map.handR) >= 0.42 && along(i, map.larmR, map.handR) <= 0.95 },
    // mantle over the shoulders, longer down the back
    pelt: { off: 0.042, fill: 10, smooth: 4,
      wt: (i) => W.head[i] < 0.25 && (trunk(i) >= 0.4 || ((W.uarmL[i] >= 0.4 || W.uarmR[i] >= 0.4) && Math.min(along(i, map.uarmL, map.larmL), along(i, map.uarmR, map.larmR)) < 0.35)),
      yMin: (i) => (Z(i) < -0.03 ? armpitY - 0.18 : Z(i) < 0.04 ? armpitY + 0.02 : armpitY + 0.07), yMax: () => neckY + 0.005 },
    trouserThigh: { off: 0.02, fill: 6, smooth: 3,
      wt: (i) => W.thighL[i] + W.thighR[i] + W.pelvis[i] >= 0.5, yMin: () => kneeY - 0.02, yMax: () => pelvisY + 0.05 },
    trouserCalf: { off: 0.018, fill: 5, smooth: 3,
      wt: (i) => W.calfL[i] + W.calfR[i] >= 0.5, yMin: () => ankleY + 0.07, yMax: () => kneeY + 0.02 },
  };

  const idx = idxA;
  const triCount = idx.length / 3;

  const outPos: number[] = [], outNor: number[] = [], outUv: number[] = [], outSi: number[] = [], outSw: number[] = [];
  const outPrimary: number[] = [], outX: number[] = [], outPat: number[] = [];
  const outIdx: number[] = [], outRegion: number[] = [], outRim: number[] = [], outY: number[] = [], outBottom: number[] = [], outNoise: number[] = [];
  const ranges = {} as ShellTemplate['ranges'];

  REGIONS.forEach((name, ri) => {
    const spec = SPECS[name];
    // a triangle is kept if all its corners may be covered and at least one lies inside the cut;
    // corners just past the cut are then clamped onto it → a clean hem / collar line, not a sawtooth
    const loose = new Uint8Array(N), core = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const y = Y(i);
      // corners far past the cut would fold into a flat shelf when clamped — leave those triangles out
      const over = Math.max(0, spec.yMin ? spec.yMin(i) - y : 0, spec.yMax ? y - spec.yMax(i) : 0);
      loose[i] = spec.wt(i) && over < 0.03 ? 1 : 0;
      core[i] = loose[i] && (!spec.yMin || y >= spec.yMin(i)) && (!spec.yMax || y <= spec.yMax(i)) && (!spec.core || spec.core(i)) ? 1 : 0;
    }
    const tris: number[] = [];
    for (let t = 0; t < triCount; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      if (loose[a] && loose[b] && loose[c] && (core[a] + core[b] + core[c]) >= (spec.core ? 2 : 1)) tris.push(a, b, c);
    }
    const start = outIdx.length;
    if (!tris.length) { ranges[name] = { start, count: 0 }; return; }
    // region-local vertex list (source ids) and welded canonical ids
    const local = new Map<number, number>();
    const srcOf: number[] = [];
    for (const s of tris) if (!local.has(s)) { local.set(s, srcOf.length); srcOf.push(s); }
    const cid = new Map<number, number>();
    const cOf: number[] = srcOf.map((s) => { const c = canon[s]; if (!cid.has(c)) cid.set(c, cid.size); return cid.get(c)!; });
    const C = cid.size;
    const cp = new Float32Array(C * 3);
    srcOf.forEach((s, li) => {
      let y = Y(s);
      if (spec.yMin) y = Math.max(y, spec.yMin(s));
      if (spec.yMax) y = Math.min(y, spec.yMax(s));
      cp.set([X(s), y, Z(s)], cOf[li] * 3);
    });
    // welded triangles + adjacency + edge use counts
    const ct: number[] = tris.map((s) => cOf[local.get(s)!]);
    const nb: Set<number>[] = Array.from({ length: C }, () => new Set());
    const edgeUse = new Map<number, number>();
    for (let t = 0; t < ct.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = ct[t + e], b = ct[t + ((e + 1) % 3)];
        nb[a].add(b); nb[b].add(a);
        const k = a < b ? a * 65536 + b : b * 65536 + a;
        edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      }
    }
    const cn = new Float32Array(C * 3);
    const normals = () => {
      cn.fill(0);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let t = 0; t < ct.length; t += 3) {
        a.fromArray(cp, ct[t] * 3); b.fromArray(cp, ct[t + 1] * 3); c.fromArray(cp, ct[t + 2] * 3);
        const fn = b.sub(a).cross(c.sub(a)); // area-weighted
        for (let e = 0; e < 3; e++) { const o = ct[t + e] * 3; cn[o] += fn.x; cn[o + 1] += fn.y; cn[o + 2] += fn.z; }
      }
      for (let i = 0; i < C; i++) { _n.fromArray(cn, i * 3).normalize(); cn.set([_n.x, _n.y, _n.z], i * 3); }
    };
    // face normals point outward if they agree with the artist's normals (robust against winding)
    normals();
    let agree = 0;
    srcOf.forEach((s, li) => {
      const o = cOf[li] * 3;
      agree += NW[s * 3] * cn[o] + NW[s * 3 + 1] * cn[o + 1] + NW[s * 3 + 2] * cn[o + 2];
    });
    const flip = agree < 0 ? -1 : 1;
    const outward = () => { normals(); if (flip < 0) for (let i = 0; i < cn.length; i++) cn[i] = -cn[i]; };
    outward();
    for (let i = 0; i < C; i++) for (let k = 0; k < 3; k++) cp[i * 3 + k] += cn[i * 3 + k] * spec.off;
    // outward-only fill: concave dips (between pecs, abs, spine groove) rise to meet their neighbours
    const tmp = new Float32Array(C * 3);
    for (let it = 0; it < spec.fill; it++) {
      if (it % 3 === 0) outward();
      tmp.set(cp);
      for (let i = 0; i < C; i++) {
        if (!nb[i].size) continue;
        let ax = 0, ay = 0, az = 0;
        for (const j of nb[i]) { ax += cp[j * 3]; ay += cp[j * 3 + 1]; az += cp[j * 3 + 2]; }
        const m = nb[i].size;
        const dx = ax / m - cp[i * 3], dy = ay / m - cp[i * 3 + 1], dz = az / m - cp[i * 3 + 2];
        const d = dx * cn[i * 3] + dy * cn[i * 3 + 1] + dz * cn[i * 3 + 2];
        if (d > 0) for (let k = 0; k < 3; k++) tmp[i * 3 + k] += cn[i * 3 + k] * d * 0.7;
      }
      cp.set(tmp);
    }
    // Taubin smoothing (λ/μ) — irons the surface without shrinking it
    for (let it = 0; it < spec.smooth * 2; it++) {
      const f = it % 2 === 0 ? 0.5 : -0.53;
      tmp.set(cp);
      for (let i = 0; i < C; i++) {
        if (!nb[i].size) continue;
        let ax = 0, ay = 0, az = 0;
        for (const j of nb[i]) { ax += cp[j * 3]; ay += cp[j * 3 + 1]; az += cp[j * 3 + 2]; }
        const m = nb[i].size;
        tmp[i * 3] += f * (ax / m - cp[i * 3]); tmp[i * 3 + 1] += f * (ay / m - cp[i * 3 + 1]); tmp[i * 3 + 2] += f * (az / m - cp[i * 3 + 2]);
      }
      cp.set(tmp);
    }
    outward();
    // rim rings (edges used by one triangle) and the lower hem
    const rim = new Float32Array(C);
    for (const [k, n] of edgeUse) if (n === 1) { rim[Math.floor(k / 65536)] = 1; rim[k % 65536] = 1; }
    const ring1 = new Float32Array(C);
    for (let i = 0; i < C; i++) if (rim[i] === 1) for (const j of nb[i]) if (rim[j] !== 1) ring1[j] = 0.5;
    let minY = Infinity;
    for (let i = 0; i < C; i++) minY = Math.min(minY, cp[i * 3 + 1]);
    const band = spec.flareBand ?? 0.06;
    if (spec.flare) {
      // the hem flares out over the hips
      for (let i = 0; i < C; i++) {
        const t = 1 - Math.min(1, (cp[i * 3 + 1] - minY) / band);
        if (t <= 0) continue;
        const hx = cn[i * 3], hz = cn[i * 3 + 2], hl = Math.hypot(hx, hz) || 1;
        cp[i * 3] += (hx / hl) * spec.flare * t * t; cp[i * 3 + 2] += (hz / hl) * spec.flare * t * t;
      }
      outward();
    }
    // emit region vertices (unwelded, so UVs stay intact) in the source mesh's local space
    const base = outPos.length / 3;
    srcOf.forEach((s, li) => {
      const c = cOf[li];
      _v.fromArray(cp, c * 3);
      outY.push(_v.y);
      outX.push(_v.x);
      outBottom.push(1 - Math.min(1, (_v.y - minY) / 0.07));
      _v.applyMatrix4(Minv);
      outPos.push(_v.x, _v.y, _v.z);
      _n.fromArray(cn, c * 3).applyMatrix3(NMinv).normalize();
      outNor.push(_n.x, _n.y, _n.z);
      outUv.push(UVa[s * 2], UVa[s * 2 + 1]);
      outSi.push(SIa[s * 4], SIa[s * 4 + 1], SIa[s * 4 + 2], SIa[s * 4 + 3]);
      outSw.push(SWa[s * 4], SWa[s * 4 + 1], SWa[s * 4 + 2], SWa[s * 4 + 3]);
      outPrimary.push(PRa[s]);
      outRegion.push(ri);
      outRim.push(Math.max(rim[c], ring1[c]));
      const h = Math.sin(X(s) * 127.1 + Y(s) * 311.7 + Z(s) * 74.7) * 43758.5453;
      outNoise.push(h - Math.floor(h));
    });
    // pattern UVs (linen only): wrapped around the torso, 0 at the hem → 1 at the collar, seam at the back
    const pat = name === 'linen';
    const y0 = spec.yMin ? spec.yMin(0) : minY, y1 = spec.yMax ? spec.yMax(0) : minY + 1;
    srcOf.forEach((_, li) => {
      if (!pat) { outPat.push(0, 0); return; }
      const c = cOf[li];
      outPat.push(Math.atan2(cp[c * 3], cp[c * 3 + 2]) / (Math.PI * 2) + 0.5, Math.min(1, Math.max(0, (cp[c * 3 + 1] - y0) / (y1 - y0))));
    });
    const dup = (vi: number, du: number) => {
      const n = outPos.length / 3;
      const cp3 = (a: number[], k: number) => { for (let j = 0; j < k; j++) a.push(a[vi * k + j]); };
      cp3(outPos, 3); cp3(outNor, 3); cp3(outUv, 2); cp3(outSi, 4); cp3(outSw, 4);
      for (const a of [outPrimary, outRegion, outRim, outY, outX, outBottom, outNoise]) a.push(a[vi]);
      outPat.push(outPat[vi * 2] + du, outPat[vi * 2 + 1]);
      return n;
    };
    for (let k = 0; k < tris.length; k += 3) {
      const v = [base + local.get(tris[k])!, base + local.get(tris[k + 1])!, base + local.get(tris[k + 2])!];
      if (pat) {
        const us = v.map((x) => outPat[x * 2]);
        if (Math.max(...us) - Math.min(...us) > 0.5) for (let j = 0; j < 3; j++) if (us[j] < 0.5) v[j] = dup(v[j], 1);
      }
      outIdx.push(v[0], v[1], v[2]);
    }
    ranges[name] = { start, count: outIdx.length - start };
  });

  if (!outIdx.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(outSi, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(outSw, 4));
  geometry.setAttribute('aPat', new THREE.Float32BufferAttribute(outPat, 2));
  const mat = src.material as THREE.MeshStandardMaterial;
  return {
    geometry, index: new Uint32Array(outIdx), ranges,
    region: new Uint8Array(outRegion), rim: new Float32Array(outRim), restY: new Float32Array(outY),
    bottom: new Float32Array(outBottom), noise: new Float32Array(outNoise), primary: new Uint8Array(outPrimary),
    restX: new Float32Array(outX), land: { pelvisY, armpitY, neckY },
    source: src.name, normalMap: mat.normalMap ?? null,
  };
}

/** What a warrior wears, as shell pieces + finishes. */
export interface ShellLook {
  armor: 'muscle' | 'linothorax' | 'none';
  armorTint: THREE.Color;
  helmetTint: THREE.Color;
  leather: THREE.Color;
  chiton: THREE.Color;
  greaves: boolean;
  bracers: boolean;
  pelt: THREE.Color | null;
  trousers?: THREE.Color | null;
  trim?: THREE.Color | null;
  boss?: boolean;
}

/**
 * Linen corselet pattern (R weave, G dye mask, B stitch lines), u around the torso, v hem → collar:
 * dyed hem, a Greek-key (meander) girdle band between stitch lines, faint laminations, dyed collar.
 */
let patTex: THREE.Texture | null = null;
function linenPattern(): THREE.Texture {
  if (patTex) return patTex;
  const Wd = 1024, Ht = 512;
  const mk = () => { const c = document.createElement('canvas'); c.width = Wd; c.height = Ht; return c; };
  const g = mk(), b = mk();
  const gx = g.getContext('2d')!, bx = b.getContext('2d')!;
  const yv = (v: number) => (1 - v) * Ht; // canvas top = collar (flipY)
  gx.fillStyle = '#000'; gx.fillRect(0, 0, Wd, Ht);
  bx.fillStyle = '#000'; bx.fillRect(0, 0, Wd, Ht);
  gx.fillStyle = '#fff';
  gx.fillRect(0, yv(0.075), Wd, yv(0) - yv(0.075));      // hem
  gx.fillRect(0, yv(1), Wd, yv(0.955) - yv(1));          // collar
  const bandTop = yv(0.445), bandBot = yv(0.3);
  gx.fillRect(0, bandTop, Wd, bandBot - bandTop);       // girdle band
  // meander drawn as linen showing through the dye
  const h = bandBot - bandTop, unit = h / 12;
  gx.strokeStyle = '#000'; gx.lineWidth = unit * 1.3; gx.lineJoin = 'miter';
  for (let x = -16 * unit; x < Wd + 16 * unit; x += 16 * unit) {
    const y = (k: number) => bandTop + unit * (1 + k); // k in 0..10
    gx.beginPath();
    gx.moveTo(x, y(10)); gx.lineTo(x + 13 * unit, y(10)); gx.lineTo(x + 13 * unit, y(0)); gx.lineTo(x + 3 * unit, y(0));
    gx.lineTo(x + 3 * unit, y(6)); gx.lineTo(x + 9 * unit, y(6)); gx.lineTo(x + 9 * unit, y(3.5)); gx.lineTo(x + 6.5 * unit, y(3.5));
    gx.stroke();
  }
  // stitch lines (dashed) and lamination lines
  bx.strokeStyle = '#fff';
  bx.setLineDash([6, 4]); bx.lineWidth = 3;
  for (const v of [0.085, 0.29, 0.455, 0.945]) { bx.beginPath(); bx.moveTo(0, yv(v)); bx.lineTo(Wd, yv(v)); bx.stroke(); }
  bx.setLineDash([]); bx.lineWidth = 1.5; bx.globalAlpha = 0.35;
  for (const v of [0.56, 0.68, 0.8]) { bx.beginPath(); bx.moveTo(0, yv(v)); bx.lineTo(Wd, yv(v)); bx.stroke(); }
  const G = gx.getImageData(0, 0, Wd, Ht).data, B = bx.getImageData(0, 0, Wd, Ht).data;
  const out = new Uint8ClampedArray(Wd * Ht * 4);
  for (let y = 0; y < Ht; y++) {
    for (let x = 0; x < Wd; x++) {
      const i = (y * Wd + x) * 4;
      // plain weave: alternating warp/weft threads + slub noise
      const weave = 222 + ((x >> 1) % 2 === (y >> 1) % 2 ? 14 : 0) + ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 18;
      out[i] = weave; out[i + 1] = G[i]; out[i + 2] = B[i]; out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, Wd, Ht, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.flipY = false; // row 0 = collar → sampled at 1 − v
  t.needsUpdate = true;
  patTex = t;
  return t;
}

/** Shell material: vertex colour + per-vertex metalness / roughness / normal-map strength / pattern (aMRN). */
export function shellMaterial(normalMap: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 1, normalMap, side: THREE.DoubleSide, envMapIntensity: 1 });
  const uDye = { value: new THREE.Color('#7a2622') };
  const uPat = { value: linenPattern() };
  m.userData.uDye = uDye;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDye = uDye;
    sh.uniforms.uPat = uPat;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMRN;\nattribute vec2 aPat;\nvarying vec4 vMRN;\nvarying vec2 vPat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMRN = aMRN;\nvPat = aPat;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vMRN;\nvarying vec2 vPat;\nuniform sampler2D uPat;\nuniform vec3 uDye;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vMRN.w > 0.5) {
          vec4 p = texture2D(uPat, vec2(vPat.x, 1.0 - vPat.y));
          vec3 cloth = diffuseColor.rgb * (p.r * 1.08);
          cloth = mix(cloth, uDye * (0.8 + 0.25 * p.r), p.g);
          diffuseColor.rgb = cloth * (1.0 - 0.5 * p.b);
        }`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMRN.x;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vMRN.y;')
      .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * vMRN.z;');
  };
  m.customProgramCacheKey = () => 'ithaca-shell-2';
  return m;
}

/** Which triangles + colours a warrior's shell shows. Writes into the per-warrior color / aMRN attributes. */
export function paintShell(t: ShellTemplate, look: ShellLook, color: THREE.BufferAttribute, mrn: THREE.BufferAttribute): { index: Uint32Array; dye: THREE.Color } {
  const on = new Set<ShellRegion>();
  if (look.armor === 'muscle') on.add('muscle');
  if (look.armor === 'linothorax') on.add('linen');
  if (look.greaves) { on.add('greaveL'); on.add('greaveR'); }
  if (look.bracers) { on.add('bracerL'); on.add('bracerR'); }
  if (look.pelt) on.add('pelt');
  if (look.trousers) { on.add('trouserThigh'); if (!look.greaves) on.add('trouserCalf'); }
  let n = 0;
  for (const r of on) n += t.ranges[r].count;
  const out = new Uint32Array(n);
  let o = 0;
  for (const r of on) { const { start, count } = t.ranges[r]; out.set(t.index.subarray(start, start + count), o); o += count; }

  const c = new THREE.Color();
  const leatherLino = look.armor === 'linothorax' && look.armorTint.getHSL({ h: 0, s: 0, l: 0 }).l < 0.3;
  const dye = leatherLino ? look.armorTint.clone().multiplyScalar(0.5) : look.chiton.clone();
  for (let i = 0; i < t.region.length; i++) {
    const reg = REGIONS[t.region[i]];
    const rim = t.rim[i], nz = t.noise[i];
    let m = 0, r = 0.9, ns = 0.15, pw = 0;
    switch (reg) {
      case 'muscle':
        // hammered bronze/tin: rolled rim catches more light; slight patina variation
        c.copy(look.armorTint).multiplyScalar(0.92 + nz * 0.12);
        if (rim >= 1) c.lerp(look.trim ?? look.armorTint, 0.6).multiplyScalar(1.18);
        m = 0.86; r = 0.34 + nz * 0.08; ns = 1.0;
        break;
      case 'linen': {
        // bands, meander and stitching come from the pattern texture; vertex colour = cloth + dyed armholes
        c.copy(look.armorTint).multiplyScalar(0.95 + nz * 0.06);
        if (rim >= 1 && t.bottom[i] < 0.3 && t.restY[i] < t.land.neckY - 0.06) c.copy(dye);
        m = 0; r = leatherLino ? 0.62 : 0.92; ns = leatherLino ? 0.25 : 0; pw = 1;
        break;
      }
      case 'greaveL': case 'greaveR':
        c.copy(look.helmetTint).multiplyScalar(0.95 + nz * 0.1);
        if (rim >= 1) c.multiplyScalar(1.15);
        m = 0.85; r = 0.38; ns = 0.7;
        break;
      case 'bracerL': case 'bracerR':
        if (look.boss && look.trim) { c.copy(look.trim); m = 0.9; r = 0.3; } else { c.copy(look.leather).multiplyScalar(0.9 + nz * 0.2); m = 0.02; r = 0.62; }
        if (rim >= 1) c.multiplyScalar(0.75);
        ns = 0.25;
        break;
      case 'pelt': {
        // tawny hide, dark shaggy mane at the collar and along the edge, mottled
        c.copy(look.pelt ?? look.leather).multiplyScalar(0.62 + nz * 0.55);
        const mane = t.restY[i] > t.land.neckY - 0.07;
        if (mane) c.multiplyScalar(0.5 + nz * 0.2);
        if (rim >= 1) c.multiplyScalar(0.62);
        m = 0; r = 1; ns = 0;
        break;
      }
      default: // trousers
        c.copy(look.trousers ?? look.chiton).multiplyScalar(0.88 + nz * 0.16);
        m = 0; r = 0.95; ns = 0.18;
    }
    color.setXYZ(i, c.r, c.g, c.b);
    mrn.setXYZW(i, m, r, t.primary[i] ? ns : 0, pw);
  }
  color.needsUpdate = true;
  mrn.needsUpdate = true;
  return { index: out, dye };
}
