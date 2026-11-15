// Procedural capsule humanoids ("wooers"): forward-kinematics alive poses, Rapier ragdolls,
// and one shared instanced renderer (≈7 draw calls for every wooer on screen).
import * as THREE from 'three';
import { RAPIER, GROUPS } from './physics';
import { faceTexture } from './textures';

export const enum P { Pelvis, Torso, Head, UArmL, LArmL, UArmR, LArmR, ULegL, LLegL, ULegR, LLegR }
export const PART_COUNT = 11;
export type Zone = 'head' | 'torso' | 'limb';
export const PART_ZONE: Zone[] = ['torso', 'torso', 'head', 'limb', 'limb', 'limb', 'limb', 'limb', 'limb', 'limb', 'limb'];

/** capsule half-height (cylindrical part) and radius per part, at scale 1 */
export const PART_DIM: { hh: number; r: number; mass: number }[] = [
  { hh: 0.05, r: 0.15, mass: 12 },   // pelvis
  { hh: 0.12, r: 0.17, mass: 24 },   // torso
  { hh: 0.02, r: 0.12, mass: 5 },    // head
  { hh: 0.09, r: 0.055, mass: 2.4 }, { hh: 0.1, r: 0.05, mass: 1.8 },
  { hh: 0.09, r: 0.055, mass: 2.4 }, { hh: 0.1, r: 0.05, mass: 1.8 },
  { hh: 0.14, r: 0.075, mass: 7 }, { hh: 0.15, r: 0.065, mass: 4.5 },
  { hh: 0.14, r: 0.075, mass: 7 }, { hh: 0.15, r: 0.065, mass: 4.5 },
];
const L_UARM = 0.29, L_LARM = 0.3, L_ULEG = 0.43, L_LLEG = 0.43;

export interface PartPose { c: THREE.Vector3; q: THREE.Quaternion; a: THREE.Vector3; b: THREE.Vector3 }
export const newPose = (): PartPose[] => Array.from({ length: PART_COUNT }, () => ({
  c: new THREE.Vector3(), q: new THREE.Quaternion(), a: new THREE.Vector3(), b: new THREE.Vector3(),
}));

/** Joint angles driving the FK pose. Angles in radians; "fwd" positive = toward the wooer's front. */
export interface Anim {
  armL: [number, number, number]; // fwd swing, abduction, elbow bend
  armR: [number, number, number];
  legL: [number, number];         // fwd swing, knee bend
  legR: [number, number];
  lean: number; twist: number; bob: number; headPitch: number;
}
export const newAnim = (): Anim => ({ armL: [0, 0.12, 0.2], armR: [0, 0.12, 0.2], legL: [0, 0.05], legR: [0, 0.05], lean: 0, twist: 0, bob: 0, headPitch: 0 });

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qT = new THREE.Quaternion();
const _root = new THREE.Quaternion();
const LEATHER = new THREE.Color('#4a3424');
const WHITE = new THREE.Color(1, 1, 1);
const FLASH = new THREE.Color(1, 0.85, 0.6);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler();
const DOWN = new THREE.Vector3(0, -1, 0);
const X = new THREE.Vector3(1, 0, 0);

function setPart(p: PartPose, a: THREE.Vector3, b: THREE.Vector3, q: THREE.Quaternion) {
  p.a.copy(a); p.b.copy(b); p.c.addVectors(a, b).multiplyScalar(0.5); p.q.copy(q);
}

/**
 * Forward kinematics: root at (pos, yaw), uniform scale s. Writes world-space part poses.
 * Wooer local frame: +Z forward, +X = their left.
 */
export function solvePose(out: PartPose[], pos: THREE.Vector3, yaw: number, s: number, an: Anim) {
  const root = _root.setFromAxisAngle(_v.set(0, 1, 0), yaw);
  const W = (lx: number, ly: number, lz: number, o: THREE.Vector3) => o.set(lx * s, (ly + an.bob) * s, lz * s).applyQuaternion(root).add(pos);

  // pelvis (static-ish), torso rotates around the spine joint
  const pelvisQ = _q.copy(root);
  const pc = W(0, 0.95, 0, _v);
  out[P.Pelvis].c.copy(pc); out[P.Pelvis].q.copy(pelvisQ);
  out[P.Pelvis].a.set(-0.12 * s, 0, 0).applyQuaternion(pelvisQ).add(pc);
  out[P.Pelvis].b.set(0.12 * s, 0, 0).applyQuaternion(pelvisQ).add(pc);

  const torsoQ = _q2.copy(root).multiply(_qT.setFromEuler(_e.set(an.lean, an.twist, 0, 'YXZ')));
  const spine = W(0, 1.06, 0, new THREE.Vector3());
  const tLocal = (lx: number, ly: number, lz: number, o: THREE.Vector3) => o.set(lx * s, ly * s, lz * s).applyQuaternion(torsoQ).add(spine);
  const tc = tLocal(0, 0.28, 0, out[P.Torso].c);
  out[P.Torso].q.copy(torsoQ);
  tLocal(0, 0.1, 0, out[P.Torso].a); tLocal(0, 0.46, 0, out[P.Torso].b);
  void tc;

  // head
  const headQ = new THREE.Quaternion().copy(torsoQ).multiply(_qT.setFromAxisAngle(X, an.headPitch));
  tLocal(0, 0.7, 0.01, out[P.Head].c);
  out[P.Head].q.copy(headQ);
  out[P.Head].a.copy(out[P.Head].c).addScaledVector(_v.set(0, -0.02 * s, 0).applyQuaternion(headQ), 1);
  out[P.Head].b.copy(out[P.Head].c).addScaledVector(_v.set(0, 0.02 * s, 0).applyQuaternion(headQ), 1);

  // arms (side: +1 = left (+X), -1 = right)
  const arm = (side: 1 | -1, ang: [number, number, number], up: P, lo: P) => {
    const sh = tLocal(0.23 * side, 0.47, 0, new THREE.Vector3());
    const uq = new THREE.Quaternion().copy(torsoQ)
      .multiply(_qT.setFromEuler(_e.set(-ang[0], 0, ang[1] * side, 'ZXY')));
    const el = _v.copy(DOWN).applyQuaternion(uq).multiplyScalar(L_UARM * s).add(sh);
    setPart(out[up], sh, el, uq);
    const lq = new THREE.Quaternion().copy(uq).multiply(_qT.setFromAxisAngle(X, -ang[2]));
    const wr = _v2.copy(DOWN).applyQuaternion(lq).multiplyScalar(L_LARM * s).add(el);
    setPart(out[lo], el, wr, lq);
  };
  arm(1, an.armL, P.UArmL, P.LArmL);
  arm(-1, an.armR, P.UArmR, P.LArmR);

  const leg = (side: 1 | -1, ang: [number, number], up: P, lo: P) => {
    const hip = W(0.1 * side, 0.9, 0, new THREE.Vector3());
    const uq = new THREE.Quaternion().copy(root).multiply(_qT.setFromAxisAngle(X, -ang[0]));
    const kn = _v.copy(DOWN).applyQuaternion(uq).multiplyScalar(L_ULEG * s).add(hip);
    setPart(out[up], hip, kn, uq);
    const lq = new THREE.Quaternion().copy(uq).multiply(_qT.setFromAxisAngle(X, ang[1]));
    const ft = _v2.copy(DOWN).applyQuaternion(lq).multiplyScalar(L_LLEG * s).add(kn);
    setPart(out[lo], kn, ft, lq);
  };
  leg(1, an.legL, P.ULegL, P.LLegL);
  leg(-1, an.legR, P.ULegR, P.LLegR);
}

// ── Ragdoll ──────────────────────────────────────────────────────────────

export interface Ragdoll {
  bodies: InstanceType<typeof RAPIER.RigidBody>[];
  colliderToPart: Map<number, number>;
  joints: InstanceType<typeof RAPIER.ImpulseJoint>[];
  scale: number;
}

type World = InstanceType<typeof RAPIER.World>;

export function createRagdoll(world: World, pose: PartPose[], s: number, linvel: THREE.Vector3): Ragdoll {
  const bodies: Ragdoll['bodies'] = [];
  const colliderToPart = new Map<number, number>();
  for (let i = 0; i < PART_COUNT; i++) {
    const d = PART_DIM[i];
    const p = pose[i];
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.c.x, p.c.y, p.c.z)
      .setRotation({ x: p.q.x, y: p.q.y, z: p.q.z, w: p.q.w })
      .setLinvel(linvel.x, linvel.y, linvel.z)
      .setLinearDamping(0.05)
      .setAngularDamping(1.6)
      .setCanSleep(true);
    const body = world.createRigidBody(desc);
    const cd = (i === P.Pelvis
      ? RAPIER.ColliderDesc.capsule(d.hh * s, d.r * s).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
      : RAPIER.ColliderDesc.capsule(d.hh * s, d.r * s))
      .setMass(d.mass * s * s * s)
      .setFriction(0.9)
      .setRestitution(0.05)
      .setCollisionGroups(GROUPS.ragdoll);
    const col = world.createCollider(cd, body);
    colliderToPart.set(col.handle, i);
    bodies.push(body);
  }
  const joints: Ragdoll['joints'] = [];
  const local = (bodyIdx: number, wp: THREE.Vector3) => {
    const p = pose[bodyIdx];
    const inv = _q.copy(p.q).invert();
    const v = _v.copy(wp).sub(p.c).applyQuaternion(inv);
    return { x: v.x, y: v.y, z: v.z };
  };
  const sph = (a: number, b: number, wp: THREE.Vector3) => {
    const j = world.createImpulseJoint(RAPIER.JointData.spherical(local(a, wp), local(b, wp)), bodies[a], bodies[b], true);
    j.setContactsEnabled(false);
    joints.push(j);
  };
  const rev = (a: number, b: number, wp: THREE.Vector3, min: number, max: number) => {
    const j = world.createImpulseJoint(RAPIER.JointData.revolute(local(a, wp), local(b, wp), { x: 1, y: 0, z: 0 }), bodies[a], bodies[b], true);
    j.setContactsEnabled(false);
    (j as unknown as { setLimits?: (a: number, b: number) => void }).setLimits?.(min, max);
    joints.push(j);
  };
  const spine = _v2.copy(pose[P.Pelvis].c).lerp(pose[P.Torso].a, 0.6).clone();
  sph(P.Pelvis, P.Torso, spine);
  sph(P.Torso, P.Head, pose[P.Head].c.clone().lerp(pose[P.Torso].b, 0.5));
  sph(P.Torso, P.UArmL, pose[P.UArmL].a.clone());
  sph(P.Torso, P.UArmR, pose[P.UArmR].a.clone());
  rev(P.UArmL, P.LArmL, pose[P.LArmL].a.clone(), -2.4, 0.05);
  rev(P.UArmR, P.LArmR, pose[P.LArmR].a.clone(), -2.4, 0.05);
  sph(P.Pelvis, P.ULegL, pose[P.ULegL].a.clone());
  sph(P.Pelvis, P.ULegR, pose[P.ULegR].a.clone());
  rev(P.ULegL, P.LLegL, pose[P.LLegL].a.clone(), -0.05, 2.4);
  rev(P.ULegR, P.LLegR, pose[P.LLegR].a.clone(), -0.05, 2.4);
  return { bodies, colliderToPart, joints, scale: s };
}

/** Read ragdoll body transforms back into a pose (for rendering and hit tests). */
export function readRagdoll(r: Ragdoll, out: PartPose[]) {
  for (let i = 0; i < PART_COUNT; i++) {
    const b = r.bodies[i];
    const t = b.translation();
    const q = b.rotation();
    const p = out[i];
    p.c.set(t.x, t.y, t.z);
    p.q.set(q.x, q.y, q.z, q.w);
    const d = PART_DIM[i];
    const axis = i === P.Pelvis ? _v.set(1, 0, 0) : _v.set(0, 1, 0);
    axis.applyQuaternion(p.q).multiplyScalar((i === P.Pelvis ? 0.12 : d.hh) * r.scale);
    p.a.copy(p.c).sub(axis);
    p.b.copy(p.c).add(axis);
  }
}

export function destroyRagdoll(world: World, r: Ragdoll) {
  for (const j of r.joints) { try { world.removeImpulseJoint(j, false); } catch { /* removed with body */ } }
  for (const b of r.bodies) { try { world.removeRigidBody(b); } catch { /* already gone */ } }
  r.bodies.length = 0;
  r.joints.length = 0;
}

// ── Instanced renderer ───────────────────────────────────────────────────

export type PropKind = 'none' | 'knife' | 'spear' | 'bow';
export type ShieldKind = 'none' | 'round' | 'table';

export interface SlotLook {
  toga: THREE.Color; trim: THREE.Color; skin: THREE.Color; scale: number;
  prop: PropKind; shield: ShieldKind; boss: boolean;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class HumanoidRenderer {
  readonly group = new THREE.Group();
  private limbs: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private torsos: THREE.InstancedMesh;
  private skirts: THREE.InstancedMesh;
  private belts: THREE.InstancedMesh;
  private props: THREE.InstancedMesh;
  private spears: THREE.InstancedMesh;
  private shields: THREE.InstancedMesh;
  private tables: THREE.InstancedMesh;
  private bows: THREE.InstancedMesh;
  readonly capacity: number;
  private m = new THREE.Matrix4();
  private sc = new THREE.Vector3();
  private tq = new THREE.Quaternion();
  private tv = new THREE.Vector3();
  private tint = new THREE.Color();
  flash: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.flash = new Float32Array(capacity);
    const skinMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7 });
    const clothMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92 });
    const brassMat = new THREE.MeshStandardMaterial({ color: '#C49A4A', metalness: 1, roughness: 0.3 });
    const headMat = new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.75 });

    const capsule = new THREE.CapsuleGeometry(1, 2, 3, 8);
    this.limbs = new THREE.InstancedMesh(capsule, skinMat, capacity * 8);
    const headGeo = new THREE.SphereGeometry(1, 14, 10);
    headGeo.scale(0.9, 1.05, 0.95);
    headGeo.rotateY(Math.PI); // face texture center (u=.75, −Z by default) → +Z
    this.heads = new THREE.InstancedMesh(headGeo, headMat, capacity);
    const torsoGeo = new THREE.CapsuleGeometry(0.17, 0.26, 3, 10);
    torsoGeo.scale(1.2, 1, 0.78);
    this.torsos = new THREE.InstancedMesh(torsoGeo, clothMat, capacity);
    const skirtGeo = new THREE.CylinderGeometry(0.17, 0.27, 0.46, 12, 1, true);
    skirtGeo.translate(0, -0.14, 0);
    this.skirts = new THREE.InstancedMesh(skirtGeo, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.92, side: THREE.DoubleSide }), capacity);
    const beltGeo = new THREE.TorusGeometry(0.175, 0.025, 5, 14);
    beltGeo.rotateX(Math.PI / 2);
    beltGeo.translate(0, 0.08, 0);
    this.belts = new THREE.InstancedMesh(beltGeo, brassMat, capacity);
    const knifeGeo = new THREE.BoxGeometry(0.03, 0.32, 0.015);
    knifeGeo.translate(0, -0.2, 0);
    this.props = new THREE.InstancedMesh(knifeGeo, brassMat, capacity);
    const spearGeo = new THREE.CylinderGeometry(0.014, 0.014, 2.0, 5);
    spearGeo.translate(0, -0.5, 0);
    this.spears = new THREE.InstancedMesh(spearGeo, new THREE.MeshStandardMaterial({ color: '#5a4026', roughness: 0.8 }), capacity);
    const shGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.04, 18);
    shGeo.rotateX(Math.PI / 2);
    this.shields = new THREE.InstancedMesh(shGeo, new THREE.MeshStandardMaterial({ color: '#9C7442', metalness: 0.9, roughness: 0.35 }), capacity);
    const arc: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10 * 2 - 1; arc.push(new THREE.Vector3(0, t * 0.55, -0.12 * (1 - t * t))); }
    const bowGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arc), 16, 0.016, 5, false);
    this.bows = new THREE.InstancedMesh(bowGeo, new THREE.MeshStandardMaterial({ color: '#3b2a1c', roughness: 0.7 }), capacity);
    const tGeo = new THREE.BoxGeometry(1.1, 1.0, 0.07);
    this.tables = new THREE.InstancedMesh(tGeo, new THREE.MeshStandardMaterial({ color: '#4a3826', roughness: 0.85 }), 2);

    const casters = new Set<THREE.InstancedMesh>([this.limbs, this.torsos, this.skirts, this.tables]);
    for (const im of [this.limbs, this.heads, this.torsos, this.skirts, this.belts, this.props, this.spears, this.shields, this.tables, this.bows]) {
      im.frustumCulled = false;
      im.castShadow = casters.has(im);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, ZERO);
      this.group.add(im);
    }
    // init instance colors
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < capacity * 8; i++) this.limbs.setColorAt(i, white);
    for (let i = 0; i < capacity; i++) { this.torsos.setColorAt(i, white); this.skirts.setColorAt(i, white); this.heads.setColorAt(i, white); }
  }

  hide(slot: number) {
    for (let k = 0; k < 8; k++) this.limbs.setMatrixAt(slot * 8 + k, ZERO);
    this.heads.setMatrixAt(slot, ZERO);
    this.torsos.setMatrixAt(slot, ZERO);
    this.skirts.setMatrixAt(slot, ZERO);
    this.belts.setMatrixAt(slot, ZERO);
    this.props.setMatrixAt(slot, ZERO);
    this.spears.setMatrixAt(slot, ZERO);
    this.shields.setMatrixAt(slot, ZERO);
    this.bows.setMatrixAt(slot, ZERO);
  }

  hideTable(i: number) { this.tables.setMatrixAt(i, ZERO); }

  write(slot: number, pose: PartPose[], look: SlotLook, opts: { shieldBroken?: boolean; tableIdx?: number; forward?: THREE.Vector3; propVisible?: boolean; fade?: number }) {
    const s = look.scale * (opts.fade ?? 1);
    const fl = this.flash[slot];
    const flashMix = (c: THREE.Color) => (fl > 0 ? this.tint.copy(c).lerp(FLASH, fl * 0.7) : c);
    // limbs
    const limbParts = [P.UArmL, P.LArmL, P.UArmR, P.LArmR, P.ULegL, P.LLegL, P.ULegR, P.LLegR];
    for (let k = 0; k < 8; k++) {
      const pi = limbParts[k];
      const d = PART_DIM[pi];
      const p = pose[pi];
      this.sc.set(d.r * s, ((d.hh + d.r) / 2) * s, d.r * s);
      this.m.compose(p.c, p.q, this.sc);
      this.limbs.setMatrixAt(slot * 8 + k, this.m);
      const isLower = pi === P.LLegL || pi === P.LLegR;
      this.limbs.setColorAt(slot * 8 + k, flashMix(isLower ? LEATHER : look.skin));
    }
    const head = pose[P.Head];
    this.sc.setScalar(PART_DIM[P.Head].r * s * 1.05);
    this.heads.setMatrixAt(slot, this.m.compose(head.c, head.q, this.sc));
    this.heads.setColorAt(slot, flashMix(WHITE));
    const torso = pose[P.Torso];
    this.sc.setScalar(s);
    this.torsos.setMatrixAt(slot, this.m.compose(torso.c, torso.q, this.sc));
    this.torsos.setColorAt(slot, flashMix(look.toga));
    const pel = pose[P.Pelvis];
    // skirt hangs from the pelvis; ragdoll pelvis capsule is rotated so use its quaternion as-is
    this.skirts.setMatrixAt(slot, this.m.compose(pel.c, pel.q, this.sc));
    this.skirts.setColorAt(slot, flashMix(look.trim));
    this.belts.setMatrixAt(slot, this.m.compose(pel.c, pel.q, this.sc));

    const handR = pose[P.LArmR];
    if (look.prop === 'knife' && opts.propVisible !== false) {
      this.tv.copy(handR.b);
      this.props.setMatrixAt(slot, this.m.compose(this.tv, handR.q, this.sc));
    } else this.props.setMatrixAt(slot, ZERO);
    if (look.prop === 'spear' && opts.propVisible !== false) {
      this.tq.copy(handR.q).multiply(new THREE.Quaternion().setFromAxisAngle(X, -Math.PI / 2 + 0.3));
      this.spears.setMatrixAt(slot, this.m.compose(handR.b, this.tq, this.sc));
    } else this.spears.setMatrixAt(slot, ZERO);

    const armL = pose[P.LArmL];
    if (look.prop === 'bow' && opts.propVisible !== false) {
      // bow held upright in the left fist, string toward the archer
      const fwd = opts.forward ?? this.tv.set(0, 0, 1);
      this.tq.setFromUnitVectors(new THREE.Vector3(0, 0, -1), fwd);
      this.bows.setMatrixAt(slot, this.m.compose(armL.b, this.tq, this.sc));
    } else this.bows.setMatrixAt(slot, ZERO);
    if (look.shield === 'round' && !opts.shieldBroken) {
      const fwd = opts.forward ?? this.tv.set(0, 0, 1).applyQuaternion(pose[P.Pelvis].q);
      const c = this.tv.copy(armL.c).addScaledVector(fwd, 0.1 * s);
      this.tq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
      this.shields.setMatrixAt(slot, this.m.compose(c, this.tq, this.sc));
    } else this.shields.setMatrixAt(slot, ZERO);
    if (look.shield === 'table' && opts.tableIdx !== undefined) {
      if (opts.shieldBroken) this.tables.setMatrixAt(opts.tableIdx, ZERO);
      else {
        const fwd = opts.forward ?? this.tv.set(0, 0, 1);
        const c = new THREE.Vector3().copy(torso.c).addScaledVector(fwd, 0.42 * s);
        c.y -= 0.12 * s;
        this.tq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
        this.tables.setMatrixAt(opts.tableIdx, this.m.compose(c, this.tq, this.sc));
      }
    }
  }

  commit() {
    for (const im of [this.limbs, this.heads, this.torsos, this.skirts, this.belts, this.props, this.spears, this.shields, this.tables, this.bows]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }
}
