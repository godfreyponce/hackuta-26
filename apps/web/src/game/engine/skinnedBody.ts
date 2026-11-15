// Realistic skinned bodies (Microsoft Rocketbox, MIT) driven by our 11-part skeleton — FK while alive,
// Rapier ragdoll after. Direction-based retargeting: each bone's rest direction (bone → child) is swung
// onto our part's axis, so the A-pose bind works. Severed limbs collapse on the body and a snapshot of the
// actual deformed skin follows the gib body (Blade & Sorcery–style dismemberment).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { P, RIG, setRig, type PartPose } from './humanoid';
import { buildShellTemplate, paintShell, shellMaterial, type ShellLook, type ShellTemplate } from './armorShell';

type Key = 'hips' | 'spine0' | 'spine1' | 'chest' | 'neck' | 'head'
  | 'uarmL' | 'larmL' | 'handL' | 'uarmR' | 'larmR' | 'handR'
  | 'thighL' | 'calfL' | 'footL' | 'thighR' | 'calfR' | 'footR';

const B = (s: string) => new RegExp(`^bip0?1[_ ]${s}$`, 'i'); // 3ds Max Biped (Rocketbox)
const PATTERNS: Record<Key, RegExp[]> = {
  hips: [B('pelvis'), /^(mixamorig[:_]?)?hips$/i, /^pelvis$/i],
  spine0: [B('spine'), /^(mixamorig[:_]?)?spine$/i, /^spine_?0?1$/i],
  spine1: [B('spine1'), /^(mixamorig[:_]?)?spine1$/i, /^spine_?0?2$/i],
  chest: [B('spine2'), /^(mixamorig[:_]?)?spine2$/i, /^spine_?0?3$/i, /^chest$/i],
  neck: [B('neck'), /^(mixamorig[:_]?)?neck$/i, /^neck_?0?1$/i],
  head: [B('head'), /^(mixamorig[:_]?)?head$/i],
  uarmL: [B('l[_ ]upperarm'), /^(mixamorig[:_]?)?leftarm$/i, /^upperarm_l$/i],
  larmL: [B('l[_ ]forearm'), /^(mixamorig[:_]?)?leftforearm$/i, /^lowerarm_l$/i],
  handL: [B('l[_ ]hand'), /^(mixamorig[:_]?)?lefthand$/i, /^hand_l$/i],
  uarmR: [B('r[_ ]upperarm'), /^(mixamorig[:_]?)?rightarm$/i, /^upperarm_r$/i],
  larmR: [B('r[_ ]forearm'), /^(mixamorig[:_]?)?rightforearm$/i, /^lowerarm_r$/i],
  handR: [B('r[_ ]hand'), /^(mixamorig[:_]?)?righthand$/i, /^hand_r$/i],
  thighL: [B('l[_ ]thigh'), /^(mixamorig[:_]?)?leftupleg$/i, /^thigh_l$/i],
  calfL: [B('l[_ ]calf'), /^(mixamorig[:_]?)?leftleg$/i, /^calf_l$/i],
  footL: [B('l[_ ]foot'), /^(mixamorig[:_]?)?leftfoot$/i, /^foot_l$/i],
  thighR: [B('r[_ ]thigh'), /^(mixamorig[:_]?)?rightupleg$/i, /^thigh_r$/i],
  calfR: [B('r[_ ]calf'), /^(mixamorig[:_]?)?rightleg$/i, /^calf_r$/i],
  footR: [B('r[_ ]foot'), /^(mixamorig[:_]?)?rightfoot$/i, /^foot_r$/i],
};

export type BoneMap = Partial<Record<Key, THREE.Bone>>;

export function mapBones(root: THREE.Object3D): BoneMap {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
  const out: BoneMap = {};
  for (const key of Object.keys(PATTERNS) as Key[]) {
    for (const re of PATTERNS[key]) {
      const b = bones.find((x) => re.test(x.name) || re.test(x.name.replace(/^.*[:|]/, '')));
      if (b) { out[key] = b; break; }
    }
  }
  return out;
}

/** Our part → bone it drives → bone that defines its direction. Parents before children. */
const DRIVE: { key: Key; part: number; child: Key | null; rigid?: boolean }[] = [
  { key: 'chest', part: P.Torso, child: null, rigid: true },
  { key: 'head', part: P.Head, child: null, rigid: true },
  { key: 'uarmL', part: P.UArmL, child: 'larmL' },
  { key: 'larmL', part: P.LArmL, child: 'handL' },
  { key: 'uarmR', part: P.UArmR, child: 'larmR' },
  { key: 'larmR', part: P.LArmR, child: 'handR' },
  { key: 'thighL', part: P.ULegL, child: 'calfL' },
  { key: 'calfL', part: P.LLegL, child: 'footL' },
  { key: 'thighR', part: P.ULegR, child: 'calfR' },
  { key: 'calfR', part: P.LLegR, child: 'footR' },
];

/** bones to hide on the body when a part is cut off (the bone + everything below it) */
const SEVER_KEY: Record<number, Key> = {
  [P.Head]: 'head', [P.UArmL]: 'uarmL', [P.LArmL]: 'larmL', [P.UArmR]: 'uarmR', [P.LArmR]: 'larmR',
  [P.ULegL]: 'thighL', [P.LLegL]: 'calfL', [P.ULegR]: 'thighR', [P.LLegR]: 'calfR',
};

interface Rest { worldQ: THREE.Quaternion; dir: THREE.Vector3 }

export interface BodyTemplate {
  scene: THREE.Object3D;
  /** normalization scale of the model (multiply by the warrior's size variation) */
  scale: number;
  rest: Partial<Record<Key, Rest>>;
  hipsRestQ: THREE.Quaternion;
  hipsY: number;
  spineRest: (THREE.Quaternion | null)[];
  /** armour grown from the body (null if the model couldn't be analysed) */
  shell: ShellTemplate | null;
  /** skull centre at eye height, in the head bone's local space — helmets are fitted to this */
  headAnchor: THREE.Vector3;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const wp = (o: THREE.Object3D, out = new THREE.Vector3()) => o.getWorldPosition(out);

/** Load + measure + scale to `height`, face +Z. Also adopts the model's proportions into RIG. */
export async function loadBodyTemplate(url: string, height = 1.84, timeoutMs = 9000): Promise<BodyTemplate | null> {
  const gltf = await Promise.race([
    new GLTFLoader().loadAsync(url),
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]).catch(() => null);
  if (!gltf) return null;
  const holder = new THREE.Group();
  holder.add(gltf.scene);
  holder.updateMatrixWorld(true);
  let map = mapBones(holder);
  if (!map.hips || !map.head || !map.uarmL || !map.uarmR || !map.thighL || !map.thighR || !map.larmL || !map.larmR) return null;
  // face +Z: the wooer's left shoulder must be on +X
  if (wp(map.uarmL).x < wp(map.uarmR).x) { gltf.scene.rotation.y += Math.PI; holder.updateMatrixWorld(true); }
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const s = height / Math.max(0.5, box.max.y - box.min.y);
  holder.scale.setScalar(s);
  holder.position.y = -box.min.y * s;
  holder.updateMatrixWorld(true);
  map = mapBones(holder);
  holder.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) {
      m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const sm = mat as THREE.MeshStandardMaterial;
        sm.roughness = 0.62; sm.metalness = 0; sm.envMapIntensity = 0.5;
      }
    }
  });
  const rest: BodyTemplate['rest'] = {};
  for (const d of DRIVE) {
    const b = map[d.key];
    if (!b) continue;
    const c = d.child ? map[d.child] : null;
    const dir = c ? wp(c).sub(wp(b)).normalize() : new THREE.Vector3(0, 1, 0);
    rest[d.key] = { worldQ: b.getWorldQuaternion(new THREE.Quaternion()), dir };
  }
  // adopt the real body's proportions so armor, hitboxes and weapons line up with the skin
  const hips = wp(map.hips!), sp = wp(map.spine0 ?? map.hips!), sh = wp(map.uarmL!), th = wp(map.thighL!);
  const head = wp(map.head!), neck = wp(map.neck ?? map.head!);
  const d = (a?: THREE.Bone, b2?: THREE.Bone) => (a && b2 ? wp(a).distanceTo(wp(b2)) : 0.3);
  const spineY = sp.y;
  RIG.pelvisY = hips.y;
  RIG.spineY = spineY;
  RIG.shoulderX = Math.abs(sh.x - hips.x);
  RIG.shoulderY = sh.y - spineY;
  RIG.hipX = Math.abs(th.x - hips.x);
  RIG.hipY = th.y;
  RIG.headY = head.y + 0.09 - spineY;
  RIG.headZ = 0.02;
  RIG.torsoB = neck.y - spineY;
  RIG.torsoC = (RIG.torsoB + 0.04) / 2;
  RIG.torsoA = 0.04;
  setRig({ uarm: d(map.uarmL, map.larmL), larm: d(map.larmL, map.handL) + 0.08, uleg: d(map.thighL, map.calfL), lleg: d(map.calfL, map.footL) });
  const spineRest = [map.spine0, map.spine1].map((b) => (b ? b.getWorldQuaternion(new THREE.Quaternion()) : null));
  // the body mesh = the skinned mesh reaching the floor (feet); the head mesh is separate on Rocketbox
  const skinned: { m: THREE.SkinnedMesh; y: number }[] = [];
  holder.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) skinned.push({ m, y: new THREE.Box3().setFromObject(m).min.y });
  });
  skinned.sort((a, b2) => a.y - b2.y);
  let shell: ShellTemplate | null = null;
  try { shell = skinned.length ? buildShellTemplate(skinned.map((x) => x.m), map) : null; } catch (err) { console.warn('[body] armour shell failed', err); }
  // helmet anchor: between the eyes in height, skull centre in depth
  const eyes: THREE.Vector3[] = [];
  holder.traverse((o) => { if ((o as THREE.Bone).isBone && /(^|[_ ])[LR]_?Eye$|eye_?[lr]$|(left|right)eye$/i.test(o.name)) eyes.push(wp(o)); });
  const eye = eyes.length ? eyes.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / eyes.length) : head.clone().add(new THREE.Vector3(0, 0.1, 0.09));
  const anchorW = new THREE.Vector3(head.x, eye.y, eye.z - 0.06);
  const headAnchor = map.head!.worldToLocal(anchorW.clone());
  return { scene: holder, scale: s, spineRest, rest, hipsRestQ: map.hips!.getWorldQuaternion(new THREE.Quaternion()), hipsY: hips.y, shell, headAnchor };
}

/** One warrior's skinned body. */
export class SkinnedBody {
  readonly root: THREE.Object3D;
  private map: BoneMap;
  private meshes: THREE.SkinnedMesh[] = [];
  private collapsed = new Set<Key>();
  private shell: THREE.SkinnedMesh | null = null;
  private shellMat: THREE.MeshStandardMaterial | null = null;

  get baseScale() { return this.tpl.scale; }
  get hasShell() { return !!this.shell; }

  constructor(private tpl: BodyTemplate) {
    this.root = cloneSkinned(tpl.scene);
    this.root.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) { m.frustumCulled = false; m.castShadow = false; this.meshes.push(m); }
    });
    this.map = mapBones(this.root);
    const t = tpl.shell;
    const src = t ? this.meshes.find((m) => m.name === t.source) : undefined;
    if (t && src) {
      // per-warrior geometry: shared vertex data, own index (which pieces) and own colours/finishes
      const g = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight', 'aPat']) g.setAttribute(k, t.geometry.getAttribute(k));
      const n = t.region.length;
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('aMRN', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(0), 1));
      this.shellMat = shellMaterial(t.normalMap);
      const sm = new THREE.SkinnedMesh(g, this.shellMat);
      sm.name = 'armour-shell';
      sm.position.copy(src.position); sm.quaternion.copy(src.quaternion); sm.scale.copy(src.scale);
      sm.bind(src.skeleton, src.bindMatrix);
      sm.frustumCulled = false;
      sm.castShadow = false;
      src.parent!.add(sm);
      this.shell = sm;
      this.meshes.push(sm);
    }
  }

  /** Dress this warrior: which shell pieces he wears and their finishes. */
  setLook(look: ShellLook) {
    const t = this.tpl.shell;
    if (!t || !this.shell) return;
    const g = this.shell.geometry;
    const { index, dye } = paintShell(t, look, g.getAttribute('color') as THREE.BufferAttribute, g.getAttribute('aMRN') as THREE.BufferAttribute);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    (this.shellMat!.userData.uDye as { value: THREE.Color }).value.copy(dye);
    this.shell.visible = index.length > 0;
  }

  /** Hit flash on the armour (warm bloom, decays from the renderer's per-slot flash). */
  setFlash(f: number) {
    if (this.shellMat) this.shellMat.emissive.setRGB(f * 0.55, f * 0.32, f * 0.16);
  }

  /** Skull centre at eye height, world space (valid after apply()). */
  headAnchor(out: THREE.Vector3): THREE.Vector3 | null {
    const h = this.map.head;
    if (!h || this.collapsed.has('head')) return null;
    return out.copy(this.tpl.headAnchor).applyMatrix4(h.matrixWorld);
  }

  reset() {
    for (const k of this.collapsed) this.map[k]?.scale.setScalar(1);
    this.collapsed.clear();
  }

  /** Keep these bones collapsed for good (the first-person body: no head before the camera, gauntlets for hands). */
  hideBones(keys: ('head' | 'neck' | 'handL' | 'handR')[]) { for (const k of keys) this.collapsed.add(k); }

  /** Pose the bones from our part poses (world space). */
  apply(pose: PartPose[]) {
    this.root.updateWorldMatrix(true, false);
    const hips = this.map.hips!;
    const pel = pose[P.Pelvis];
    this.setWorld(hips, _v.copy(pel.c).setY(pel.c.y + (this.tpl.hipsY - RIG.pelvisY)), _q.copy(pel.q).multiply(this.tpl.hipsRestQ));
    // spread the torso's lean/twist down the spine (1/3, 2/3) so the skin follows the armour
    const tq = pose[P.Torso].q;
    [this.map.spine0, this.map.spine1].forEach((b, i) => {
      const r = this.tpl.spineRest[i];
      if (!b || !r) return;
      this.setWorldRot(b, _q.copy(pel.q).slerp(tq, (i + 1) / 3).multiply(r));
    });
    for (const d of DRIVE) {
      const b = this.map[d.key];
      const r = this.tpl.rest[d.key];
      if (!b || !r) continue;
      const p = pose[d.part];
      if (d.rigid) _q.copy(p.q).multiply(r.worldQ);
      else {
        const want = _v.subVectors(p.b, p.a).normalize();
        _q.copy(_q2.setFromUnitVectors(r.dir, want)).multiply(r.worldQ);
      }
      this.setWorldRot(b, _q);
    }
    for (const k of this.collapsed) { const b = this.map[k]; if (b) b.scale.setScalar(0.001); }
  }

  private setWorld(b: THREE.Bone, pos: THREE.Vector3, q: THREE.Quaternion) {
    b.parent!.updateWorldMatrix(true, false);
    _m.copy(b.parent!.matrixWorld).invert();
    b.position.copy(pos).applyMatrix4(_m);
    this.setWorldRot(b, q);
  }
  // only the parent chain is refreshed per bone; the renderer's scene pass updates the rest once
  private setWorldRot(b: THREE.Bone, q: THREE.Quaternion) {
    b.parent!.updateWorldMatrix(true, false);
    _q2.setFromRotationMatrix(_m.extractRotation(b.parent!.matrixWorld));
    b.quaternion.copy(_q2.invert().multiply(q));
    b.updateMatrix();
    b.matrixWorld.multiplyMatrices(b.parent!.matrixWorld, b.matrix);
  }

  // ── surface rays (stab entry / exit points on the actual skin or armour) ──
  private partBones = new Map<number, Set<THREE.Object3D>>();
  private domBone = new Map<THREE.SkinnedMesh, Uint16Array>();

  /** bones whose skin belongs to a part (dominant influence) */
  private bonesFor(part: number): Set<THREE.Object3D> {
    const hit = this.partBones.get(part);
    if (hit) return hit;
    const s = new Set<THREE.Object3D>();
    const M = this.map;
    const add = (b: THREE.Object3D | undefined, deep = true) => { if (!b) return; if (deep) b.traverse((o) => { if ((o as THREE.Bone).isBone) s.add(o); }); else s.add(b); };
    const cut = (b: THREE.Object3D | undefined) => { b?.traverse((o) => s.delete(o)); };
    const limb = (upper: THREE.Bone | undefined, lower: THREE.Bone | undefined) => { add(upper); cut(lower); add(lower, false); };
    switch (part) {
      case P.Torso: add(M.spine0 ?? M.hips); cut(M.head); cut(M.uarmL); cut(M.uarmR); cut(M.thighL); cut(M.thighR); add(M.neck, false); add(M.head, false); add(M.uarmL, false); add(M.uarmR, false); break;
      case P.Pelvis: add(M.hips, false); add(M.spine0, false); add(M.spine1, false); add(M.thighL, false); add(M.thighR, false); break;
      case P.Head: add(M.head); add(M.neck, false); break;
      case P.UArmL: limb(M.uarmL, M.larmL); break;
      case P.UArmR: limb(M.uarmR, M.larmR); break;
      case P.LArmL: add(M.larmL); break;
      case P.LArmR: add(M.larmR); break;
      case P.ULegL: limb(M.thighL, M.calfL); break;
      case P.ULegR: limb(M.thighR, M.calfR); break;
      case P.LLegL: add(M.calfL); break;
      case P.LLegR: add(M.calfR); break;
    }
    this.partBones.set(part, s);
    return s;
  }
  private domFor(mesh: THREE.SkinnedMesh): Uint16Array {
    let d = this.domBone.get(mesh);
    if (d) return d;
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    d = new Uint16Array(si.count);
    for (let i = 0; i < si.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
      d[i] = best;
    }
    this.domBone.set(mesh, d);
    return d;
  }

  /**
   * First front-facing surface of the given part's skin (or the armour grown on it) along a ray, in the current
   * pose. Only triangles whose skin belongs to that part are tested, and vertices are skinned once each.
   */
  surfaceRay(part: number, origin: THREE.Vector3, dir: THREE.Vector3, far: number): { point: THREE.Vector3; normal: THREE.Vector3; bone: THREE.Object3D; mesh?: string } | null {
    this.root.updateMatrixWorld(true);
    const allowed = this.bonesFor(part);
    const ray = new THREE.Ray(origin.clone(), dir.clone().normalize());
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), pt = new THREE.Vector3();
    let best = far;
    let out: { point: THREE.Vector3; normal: THREE.Vector3; bone: THREE.Object3D; mesh?: string } | null = null;
    for (const mesh of this.meshes) {
      const g = mesh.geometry;
      const index = g.index;
      if (!mesh.visible || (index && index.count === 0)) continue;
      const bones = mesh.skeleton.bones;
      const ok = new Uint8Array(bones.length);
      bones.forEach((bn, i) => { if (allowed.has(bn)) ok[i] = 1; });
      const dom = this.domFor(mesh);
      // double-sided layers (the armour shell) are hit from either side: the first surface along the ray is what shows
      const both = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material).side === THREE.DoubleSide;
      const n = g.attributes.position.count;
      const cache = new Float32Array(n * 3);
      const have = new Uint8Array(n);
      const get = (vi: number, o: THREE.Vector3) => {
        if (have[vi]) return o.fromArray(cache, vi * 3);
        mesh.getVertexPosition(vi, o).applyMatrix4(mesh.matrixWorld);
        o.toArray(cache, vi * 3); have[vi] = 1;
        return o;
      };
      const tris = index ? index.count / 3 : n / 3;
      for (let t = 0; t < tris; t++) {
        const ia = index ? index.getX(t * 3) : t * 3, ib = index ? index.getX(t * 3 + 1) : t * 3 + 1, ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        if (!ok[dom[ia]] && !ok[dom[ib]] && !ok[dom[ic]]) continue;
        if (ray.distanceSqToPoint(get(ia, a)) > 0.05) continue; // > 22 cm from the ray
        get(ib, b); get(ic, c);
        const p = ray.intersectTriangle(a, b, c, !both, pt);
        if (!p) continue;
        const d = p.distanceTo(ray.origin);
        if (d < best) {
          best = d;
          const nrm = new THREE.Vector3().subVectors(b, a).cross(c.clone().sub(a)).normalize();
          if (nrm.dot(ray.direction) > 0) nrm.negate();
          out = { point: p.clone(), normal: nrm, bone: bones[dom[ia]], mesh: mesh.name };
        }
      }
    }
    return out;
  }

  /**
   * Cut a limb: snapshot the deformed skin belonging to that bone subtree into a static mesh expressed in
   * the frame of `framePose` (the severed part's pose), then collapse those bones on the body.
   */
  sever(part: number, framePose: PartPose): THREE.Mesh | null {
    const key = SEVER_KEY[part];
    const bone = key ? this.map[key] : undefined;
    if (!bone || this.collapsed.has(key)) return null;
    const sub = new Set<THREE.Object3D>();
    bone.traverse((o) => sub.add(o));
    const inv = _m.compose(framePose.c, framePose.q, new THREE.Vector3(1, 1, 1)).clone().invert();
    const geos: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    for (const mesh of this.meshes) {
      const g = mesh.geometry;
      if (!mesh.visible || (g.index && g.index.count === 0)) continue;
      const pos = g.attributes.position, uv = g.attributes.uv, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      const extra = (['color', 'aMRN', 'aPat'] as const).map((k) => g.attributes[k] as THREE.BufferAttribute | undefined);
      const bones = mesh.skeleton.bones;
      const inSub = new Uint8Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (sub.has(bones[si.getComponent(i, k)])) w += sw.getComponent(i, k);
        inSub[i] = w > 0.5 ? 1 : 0;
      }
      const index = g.index;
      const tri: number[] = [];
      const triCount = index ? index.count / 3 : pos.count / 3;
      for (let t = 0; t < triCount; t++) {
        const a = index ? index.getX(t * 3) : t * 3, b2 = index ? index.getX(t * 3 + 1) : t * 3 + 1, c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        if (inSub[a] && inSub[b2] && inSub[c]) tri.push(a, b2, c);
      }
      if (!tri.length) continue;
      const p = new Float32Array(tri.length * 3);
      const u = new Float32Array(tri.length * 2);
      const ex = extra.map((a) => (a ? new Float32Array(tri.length * a.itemSize) : null));
      const tmp = new THREE.Vector3();
      mesh.updateMatrixWorld(true);
      for (let i = 0; i < tri.length; i++) {
        mesh.getVertexPosition(tri[i], tmp);
        tmp.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
        p.set([tmp.x, tmp.y, tmp.z], i * 3);
        if (uv) u.set([uv.getX(tri[i]), uv.getY(tri[i])], i * 2);
        extra.forEach((a, k) => { const e = ex[k]; if (a && e) for (let j = 0; j < a.itemSize; j++) e[i * a.itemSize + j] = a.getComponent(tri[i], j); });
      }
      const ng = new THREE.BufferGeometry();
      ng.setAttribute('position', new THREE.BufferAttribute(p, 3));
      ng.setAttribute('uv', new THREE.BufferAttribute(u, 2));
      extra.forEach((a, k) => { const e = ex[k]; if (a && e) ng.setAttribute(['color', 'aMRN', 'aPat'][k], new THREE.BufferAttribute(e, a.itemSize)); });
      ng.computeVertexNormals();
      geos.push(ng);
      mats.push(mesh.material as THREE.Material);
    }
    this.collapsed.add(key);
    if (!geos.length) return null;
    const group = new THREE.Group();
    geos.forEach((g, i) => { const m = new THREE.Mesh(g, mats[i]); m.frustumCulled = false; group.add(m); });
    return group as unknown as THREE.Mesh;
  }
}
