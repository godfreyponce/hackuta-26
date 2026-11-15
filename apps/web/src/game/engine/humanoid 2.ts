// Procedural capsule humanoids ("wooers"): forward-kinematics alive poses, Rapier ragdolls,
// and one shared instanced renderer (≈7 draw calls for every wooer on screen).
import * as THREE from 'three';
import { RAPIER, GROUPS } from './physics';

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
/** Rig proportions (meters, scale 1). Re-measured from the realistic body model when it loads (setRig). */
export const RIG = {
  pelvisY: 0.95, spineY: 1.06, torsoC: 0.28, torsoA: 0.1, torsoB: 0.46, headY: 0.7, headZ: 0.01,
  shoulderX: 0.23, shoulderY: 0.47, hipX: 0.1, hipY: 0.9,
  uarm: 0.29, larm: 0.3, uleg: 0.43, lleg: 0.43,
};
/** Adopt measured proportions; capsule half-heights follow the limb lengths. */
export function setRig(m: Partial<typeof RIG>) {
  Object.assign(RIG, m);
  const hh = (len: number, r: number) => Math.max(0.02, len / 2 - r * 0.6);
  PART_DIM[P.UArmL].hh = PART_DIM[P.UArmR].hh = hh(RIG.uarm, PART_DIM[P.UArmL].r);
  PART_DIM[P.LArmL].hh = PART_DIM[P.LArmR].hh = hh(RIG.larm, PART_DIM[P.LArmL].r);
  PART_DIM[P.ULegL].hh = PART_DIM[P.ULegR].hh = hh(RIG.uleg, PART_DIM[P.ULegL].r);
  PART_DIM[P.LLegL].hh = PART_DIM[P.LLegR].hh = hh(RIG.lleg, PART_DIM[P.LLegL].r);
}

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
  const pc = W(0, RIG.pelvisY, 0, _v);
  out[P.Pelvis].c.copy(pc); out[P.Pelvis].q.copy(pelvisQ);
  out[P.Pelvis].a.set(-0.12 * s, 0, 0).applyQuaternion(pelvisQ).add(pc);
  out[P.Pelvis].b.set(0.12 * s, 0, 0).applyQuaternion(pelvisQ).add(pc);

  const torsoQ = _q2.copy(root).multiply(_qT.setFromEuler(_e.set(an.lean, an.twist, 0, 'YXZ')));
  const spine = W(0, RIG.spineY, 0, new THREE.Vector3());
  const tLocal = (lx: number, ly: number, lz: number, o: THREE.Vector3) => o.set(lx * s, ly * s, lz * s).applyQuaternion(torsoQ).add(spine);
  const tc = tLocal(0, RIG.torsoC, 0, out[P.Torso].c);
  out[P.Torso].q.copy(torsoQ);
  tLocal(0, RIG.torsoA, 0, out[P.Torso].a); tLocal(0, RIG.torsoB, 0, out[P.Torso].b);
  void tc;

  // head
  const headQ = new THREE.Quaternion().copy(torsoQ).multiply(_qT.setFromAxisAngle(X, an.headPitch));
  tLocal(0, RIG.headY, RIG.headZ, out[P.Head].c);
  out[P.Head].q.copy(headQ);
  out[P.Head].a.copy(out[P.Head].c).addScaledVector(_v.set(0, -0.02 * s, 0).applyQuaternion(headQ), 1);
  out[P.Head].b.copy(out[P.Head].c).addScaledVector(_v.set(0, 0.02 * s, 0).applyQuaternion(headQ), 1);

  // arms (side: +1 = left (+X), -1 = right)
  const arm = (side: 1 | -1, ang: [number, number, number], up: P, lo: P) => {
    const sh = tLocal(RIG.shoulderX * side, RIG.shoulderY, 0, new THREE.Vector3());
    const uq = new THREE.Quaternion().copy(torsoQ)
      .multiply(_qT.setFromEuler(_e.set(-ang[0], 0, ang[1] * side, 'ZXY')));
    const el = _v.copy(DOWN).applyQuaternion(uq).multiplyScalar(RIG.uarm * s).add(sh);
    setPart(out[up], sh, el, uq);
    const lq = new THREE.Quaternion().copy(uq).multiply(_qT.setFromAxisAngle(X, -ang[2]));
    const wr = _v2.copy(DOWN).applyQuaternion(lq).multiplyScalar(RIG.larm * s).add(el);
    setPart(out[lo], el, wr, lq);
  };
  arm(1, an.armL, P.UArmL, P.LArmL);
  arm(-1, an.armR, P.UArmR, P.LArmR);

  const leg = (side: 1 | -1, ang: [number, number], up: P, lo: P) => {
    const hip = W(RIG.hipX * side, RIG.hipY, 0, new THREE.Vector3());
    const uq = new THREE.Quaternion().copy(root).multiply(_qT.setFromAxisAngle(X, -ang[0]));
    const kn = _v.copy(DOWN).applyQuaternion(uq).multiplyScalar(RIG.uleg * s).add(hip);
    setPart(out[up], hip, kn, uq);
    const lq = new THREE.Quaternion().copy(uq).multiply(_qT.setFromAxisAngle(X, ang[1]));
    const ft = _v2.copy(DOWN).applyQuaternion(lq).multiplyScalar(RIG.lleg * s).add(kn);
    setPart(out[lo], kn, ft, lq);
  };
  leg(1, an.legL, P.ULegL, P.LLegL);
  leg(-1, an.legR, P.ULegR, P.LLegR);
}

// ── Ragdoll ──────────────────────────────────────────────────────────────

/** Physics bodies for a warrior's parts. Any subset can exist (alive warrior with a severed arm,
 *  full ragdoll, ragdoll missing its head). Joints are keyed by the CHILD part, so severing = removing it. */
export interface Ragdoll {
  bodies: (InstanceType<typeof RAPIER.RigidBody> | null)[];
  joints: Map<number, InstanceType<typeof RAPIER.ImpulseJoint>>;
  colliderToPart: Map<number, number>;
  scale: number;
}

type World = InstanceType<typeof RAPIER.World>;

/** parent, child, joint type, revolute limits */
export const JOINTS: { parent: number; child: number; rev?: [number, number] }[] = [
  { parent: P.Pelvis, child: P.Torso },
  { parent: P.Torso, child: P.Head },
  { parent: P.Torso, child: P.UArmL },
  { parent: P.Torso, child: P.UArmR },
  { parent: P.UArmL, child: P.LArmL, rev: [-2.4, 0.05] },
  { parent: P.UArmR, child: P.LArmR, rev: [-2.4, 0.05] },
  { parent: P.Pelvis, child: P.ULegL },
  { parent: P.Pelvis, child: P.ULegR },
  { parent: P.ULegL, child: P.LLegL, rev: [-0.05, 2.4] },
  { parent: P.ULegR, child: P.LLegR, rev: [-0.05, 2.4] },
];
export const PARENT: number[] = (() => { const a = new Array(PART_COUNT).fill(-1); for (const j of JOINTS) a[j.child] = j.parent; return a; })();
/** a part and everything hanging off it (cutting the shoulder takes the forearm too) */
export function subtree(part: number): number[] {
  const out = [part];
  for (const j of JOINTS) if (j.parent === part) out.push(...subtree(j.child));
  return out;
}

/** World position of the joint between child and its parent, from a pose. */
export function jointPoint(pose: PartPose[], child: number, out = new THREE.Vector3()) {
  if (child === P.Torso) return out.copy(pose[P.Pelvis].c).lerp(pose[P.Torso].a, 0.6);
  if (child === P.Head) return out.copy(pose[P.Head].c).lerp(pose[P.Torso].b, 0.5);
  return out.copy(pose[child].a);
}

export function emptyBodies(s: number): Ragdoll {
  return { bodies: new Array(PART_COUNT).fill(null), joints: new Map(), colliderToPart: new Map(), scale: s };
}

/** Create dynamic bodies for `parts` (skipping any that already exist) and joint them to each other. */
export function addBodies(world: World, r: Ragdoll, pose: PartPose[], parts: number[], linvel: THREE.Vector3) {
  const s = r.scale;
  const created = new Set<number>();
  for (const i of parts) {
    if (r.bodies[i]) continue;
    const d = PART_DIM[i];
    const p = pose[i];
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.c.x, p.c.y, p.c.z)
      .setRotation({ x: p.q.x, y: p.q.y, z: p.q.z, w: p.q.w })
      .setLinvel(linvel.x, linvel.y, linvel.z)
      .setLinearDamping(0.05)
      .setAngularDamping(1.6)
      .setCanSleep(true));
    const cd = (i === P.Pelvis
      ? RAPIER.ColliderDesc.capsule(d.hh * s, d.r * s).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
      : RAPIER.ColliderDesc.capsule(d.hh * s, d.r * s))
      .setMass(d.mass * s * s * s).setFriction(0.9).setRestitution(0.05).setCollisionGroups(GROUPS.ragdoll);
    const col = world.createCollider(cd, body);
    r.colliderToPart.set(col.handle, i);
    r.bodies[i] = body;
    created.add(i);
  }
  const local = (idx: number, wp: THREE.Vector3) => {
    const p = pose[idx];
    const v = _v.copy(wp).sub(p.c).applyQuaternion(_q.copy(p.q).invert());
    return { x: v.x, y: v.y, z: v.z };
  };
  for (const j of JOINTS) {
    if (!created.has(j.child) || !created.has(j.parent) || r.joints.has(j.child)) continue;
    const wp = jointPoint(pose, j.child, _v2).clone();
    const a = r.bodies[j.parent]!, b = r.bodies[j.child]!;
    const jd = j.rev
      ? RAPIER.JointData.revolute(local(j.parent, wp), local(j.child, wp), { x: 1, y: 0, z: 0 })
      : RAPIER.JointData.spherical(local(j.parent, wp), local(j.child, wp));
    const joint = world.createImpulseJoint(jd, a, b, true);
    joint.setContactsEnabled(false);
    if (j.rev) (joint as unknown as { setLimits?: (a: number, b: number) => void }).setLimits?.(j.rev[0], j.rev[1]);
    r.joints.set(j.child, joint);
  }
}

/** Cut the joint above `child` (decapitation, severed arm...). */
export function severJoint(world: World, r: Ragdoll, child: number) {
  const j = r.joints.get(child);
  if (j) { try { world.removeImpulseJoint(j, true); } catch { /* gone */ } r.joints.delete(child); }
}

/** Back-compat: full ragdoll from a pose, minus already-severed parts. */
export function createRagdoll(world: World, pose: PartPose[], s: number, linvel: THREE.Vector3, existing?: Ragdoll, skip?: Set<number>): Ragdoll {
  const r = existing ?? emptyBodies(s);
  const parts: number[] = [];
  for (let i = 0; i < PART_COUNT; i++) if (!skip?.has(i)) parts.push(i);
  addBodies(world, r, pose, parts, linvel);
  return r;
}

/** Copy body transforms into the pose for parts that have bodies. */
export function readRagdoll(r: Ragdoll, out: PartPose[]) {
  for (let i = 0; i < PART_COUNT; i++) {
    const b = r.bodies[i];
    if (!b) continue;
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
  for (const j of r.joints.values()) { try { world.removeImpulseJoint(j, false); } catch { /* removed with body */ } }
  for (const b of r.bodies) { if (b) try { world.removeRigidBody(b); } catch { /* already gone */ } }
  r.bodies.fill(null);
  r.joints.clear();
  r.colliderToPart.clear();
}

// Rendering lives in armoredRenderer.ts (layered Greek panoply over this skeleton).
