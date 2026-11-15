// Blade & Sorcery-style stabbing for HELD blades and spears.
// A committed thrust that gets through his armour LODGES: the point slides in along the blade and stays in him.
// While it's in, the depth follows your hand along the blade (push deeper / pull out), sideways motion drags him on
// it (or rips it free), and a deep torso stab runs him through — the point comes out of his back. A living man is
// held on the blade (FK: his body is moved to keep the wound on the blade line); a corpse hangs on it (a Rapier fixed
// joint whose anchor slides along the blade). Let go and the blade stays in him until you take it back.
import * as THREE from 'three';
import { RAPIER, GROUPS } from './physics';
import { P, PART_DIM } from './humanoid';
import { combatLog, type Enemy, type EnemyManager, type HitInfo, type HitResult, type Vital } from './enemies';
import type { Fx } from './fx';
import { audio } from './audio';
import { BladeBlood } from './wounds';
import type { WeaponEnt } from './weapons';
import { segSegDist2 } from './math';

type World = InstanceType<typeof RAPIER.World>;
type Joint = InstanceType<typeof RAPIER.ImpulseJoint>;

export interface StabProfile {
  /** the point, along the weapon's local +Y (m from the grip) */
  tipY: number;
  /** how far the blade can go in before the guard (sword) or your hand (spear) meets him */
  maxDepth: number;
}

/** Only pointed, end-gripped weapons stab: the xiphos and the spear (and forged ones of those classes). */
export function stabProfile(w: WeaponEnt): StabProfile | null {
  if (!w.spec.sharp || (w.cls !== 'sword' && w.cls !== 'spear')) return null;
  const tipY = w.segB.y / 0.98;
  if (w.cls === 'spear') return { tipY, maxDepth: Math.max(0.3, tipY - 0.35) };
  return { tipY, maxDepth: Math.max(0.2, tipY - Math.max(0.1, w.spec.lengthM * 0.17) + 0.02) };
}

export interface StabHooks {
  hitstop(ms: number): void;
  shake(v: number): void;
  /** the weapon was left in a man who has now pulled it out (or his body is gone): it falls free */
  freeWeapon(w: WeaponEnt, vel: THREE.Vector3): void;
  speedScale(): number;
}

interface Lodge {
  w: WeaponEnt;
  e: Enemy;
  part: number;
  vital: Vital;
  prof: StabProfile;
  /** entry point, blade axis and wound normal in the tracking frame: the skin bone under the wound while he's alive
   *  (that's what his visible skin and the wound decal follow), else the part's frame (pose c/q = ragdoll body) */
  entryL: THREE.Vector3;
  axisL: THREE.Vector3;
  normalL: THREE.Vector3;
  /** the realistic body's bone the wound rides on (null: tracked in the part frame) */
  bone: THREE.Object3D | null;
  /** body depth along the blade (entry → back surface) */
  thick: number;
  depth: number;
  deepest: number;
  age: number;
  /** held in your hand (the body follows the blade) or left in him (the blade follows the body) */
  hand: boolean;
  joint: Joint | null;
  /** lateral anchor offset on the blade (weapon local x/z) for the corpse joint */
  lat: THREE.Vector3;
  rel: { p: THREE.Vector3; q: THREE.Quaternion } | null;
  /** his tear-out time before you let go (restored if you take the blade back) */
  freeAtBefore?: number;
  prevC: THREE.Vector3;
  exited: boolean;
  leftAt: number;
  dripAcc: number;
  squelchT: number;
  /** re-grab: the blade eases from where it sits in him into your hand */
  blend: number;
  blendP: THREE.Vector3;
  blendQ: THREE.Quaternion;
}

const Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _C = new THREE.Vector3();
const _u = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const _o = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _pc = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _s = new THREE.Vector3();

/** Ray vs capsule (a–b, radius r): distance along the ray to the first surface hit, or null. */
function rayCapsule(o: THREE.Vector3, d: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, r: number, far: number): number | null {
  // march (capsules are small and convex: 1 cm steps, then bisect)
  const p = new THREE.Vector3(), s1 = new THREE.Vector3(), s2 = new THREE.Vector3();
  const inside = (t: number) => segSegDist2(p.copy(o).addScaledVector(d, t), p, a, b, s1, s2) <= r * r;
  let prev = 0;
  if (inside(0)) return 0;
  for (let t = 0.01; t <= far; t += 0.01) {
    if (inside(t)) {
      let lo = prev, hi = t;
      for (let i = 0; i < 6; i++) { const m = (lo + hi) / 2; if (inside(m)) hi = m; else lo = m; }
      return hi;
    }
    prev = t;
  }
  return null;
}

export class StabSystem {
  readonly blood = new BladeBlood();
  private lodges: Lodge[] = [];
  private drips: { w: WeaponEnt; until: number; acc: number; tipY: number }[] = [];
  private t = 0;

  constructor(private world: World, private enemies: EnemyManager, private fx: Fx, private hooks: StabHooks) {}

  lodgeOf(w: WeaponEnt) { return this.lodges.find((l) => l.w === w); }
  isLodged(w: WeaponEnt) { return this.lodges.some((l) => l.w === w); }
  /** for tests / HUD */
  get active(): readonly { w: WeaponEnt; e: Enemy; depth: number; thick: number; exited: boolean; vital: Vital; hand: boolean }[] { return this.lodges; }

  /** A thrust isn't forgiven its reach: the point itself has to be at his skin before it counts. */
  tipReached(e: Enemy, part: number, tip: THREE.Vector3) {
    const p = e.pose[part];
    const r = PART_DIM[part].r * e.look.scale;
    return segSegDist2(tip, tip, p.a, p.b, _a, _b) <= (r + 0.05) ** 2;
  }

  private bladeFrame(w: WeaponEnt, prof: StabProfile) {
    const r = w.body.rotation(), t = w.body.translation();
    _q.set(r.x, r.y, r.z, r.w);
    _C.set(t.x, t.y, t.z);
    _u.copy(Y).applyQuaternion(_q);
    _tip.copy(_C).addScaledVector(_u, prof.tipY);
  }

  /** the part's current frame: the ragdoll body if it has one, else the FK pose */
  private partFrame(e: Enemy, part: number, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    const body = e.ragdoll?.bodies[part];
    if (body && (e.dead || e.state === 'down')) {
      const t = body.translation(), r = body.rotation();
      outP.set(t.x, t.y, t.z); outQ.set(r.x, r.y, r.z, r.w);
    } else { outP.copy(e.pose[part].c); outQ.copy(e.pose[part].q); }
  }

  /** the frame the wound is tracked in (see Lodge.entryL) */
  private entryFrame(L: Lodge, outP: THREE.Vector3, outQ: THREE.Quaternion) {
    if (L.bone) { this.enemies.skinOf(L.e); L.bone.matrixWorld.decompose(outP, outQ, _s); }
    else this.partFrame(L.e, L.part, outP, outQ);
  }
  private entryWorld(L: Lodge, out: THREE.Vector3) {
    this.entryFrame(L, _pc, _pq);
    return out.copy(L.entryL).applyQuaternion(_pq).add(_pc);
  }
  /** he's a ragdoll now: from here on the wound is tracked on the part's physics body */
  private toPartFrame(L: Lodge) {
    if (!L.bone) return;
    this.entryFrame(L, _pc, _pq);
    const ew = L.entryL.clone().applyQuaternion(_pq).add(_pc);
    const aw = L.axisL.clone().applyQuaternion(_pq), nw = L.normalL.clone().applyQuaternion(_pq);
    const rw = L.rel ? { p: L.rel.p.clone().applyQuaternion(_pq).add(_pc), q: _pq.clone().multiply(L.rel.q) } : null;
    L.bone = null;
    this.partFrame(L.e, L.part, _pc, _pq);
    const inv = _q2.copy(_pq).invert();
    L.entryL.copy(ew.sub(_pc).applyQuaternion(inv)); L.axisL.copy(aw.applyQuaternion(inv)); L.normalL.copy(nw.applyQuaternion(inv));
    if (rw && L.rel) { L.rel.p.copy(rw.p.sub(_pc).applyQuaternion(inv)); L.rel.q.copy(inv.clone().multiply(rw.q)); }
  }

  /** The point got through: put it in him. Returns false if it can't lodge (no surface in reach, etc.). */
  tryLodge(w: WeaponEnt, e: Enemy, part: number, info: HitInfo, res: HitResult | null): boolean {
    const prof = stabProfile(w);
    if (!prof || this.isLodged(w) || e.kind === 'hero' || e.state === 'down') return false;
    if (e.dead && !e.ragdoll?.bodies[part]) return false;
    this.bladeFrame(w, prof);
    const u = _u.clone(), tip = _tip.clone();
    // entry: the first surface of that part along the blade, searched from behind the point
    const origin = tip.clone().addScaledVector(u, -0.55);
    let entry: THREE.Vector3 | null = null, normal: THREE.Vector3 | null = null, bone: THREE.Object3D | null = null;
    const t0 = performance.now();
    const hit = this.enemies.surfaceRay(e, part, origin, u, 0.85);
    if (hit) { entry = hit.point; normal = hit.normal; bone = hit.bone; }
    const p = e.pose[part];
    const r = PART_DIM[part].r * e.look.scale;
    if (!entry) {
      const d = rayCapsule(origin, u, p.a, p.b, r * 0.92, 0.85);
      if (d === null) return false;
      entry = origin.clone().addScaledVector(u, d);
      segSegDist2(entry, entry, p.a, p.b, _a, _b);
      normal = entry.clone().sub(_b).normalize();
    }
    let depth0 = _o.subVectors(tip, entry).dot(u);
    if (depth0 < -0.14) return false; // the point never got there
    // the far side of him along the blade (for running him through)
    const far = entry.clone().addScaledVector(u, 0.9);
    const back = this.enemies.surfaceRay(e, part, far, u.clone().negate(), 0.88);
    let thick = back ? 0.9 - back.point.distanceTo(far) : 0;
    let exitN = back?.normal ?? null;
    let exitBone = back?.bone ?? null;
    if (!back || thick < 0.04) {
      const d = rayCapsule(far, u.clone().negate(), p.a, p.b, r * 0.92, 0.88);
      thick = d === null ? r * 1.6 : 0.9 - d;
      exitN = u.clone();
      exitBone = bone;
    }
    const rayMs = performance.now() - t0;
    // a hair short of his skin: the thrust's momentum carries him onto the point
    if (!e.dead && depth0 < 0.03) {
      const k = 0.03 - depth0;
      this.enemies.moveImpaled(e, -u.x * k, -u.z * k, 0, 0);
      entry.x -= u.x * k; entry.z -= u.z * k;
      depth0 = _o.subVectors(tip, entry).dot(u);
    }
    // into the tracking frame: the skin bone under the wound (alive), else the part
    const trackBone = !e.dead && bone ? bone : null;
    if (trackBone) { this.enemies.skinOf(e); trackBone.matrixWorld.decompose(_pc, _pq, _s); } else this.partFrame(e, part, _pc, _pq);
    const inv = _q2.copy(_pq).invert();
    const L: Lodge = {
      w, e, part, prof, bone: trackBone,
      vital: this.enemies.vitalOf(e, part, entry, !!res?.neck),
      entryL: entry.clone().sub(_pc).applyQuaternion(inv),
      axisL: u.clone().applyQuaternion(inv),
      normalL: normal!.clone().applyQuaternion(inv),
      thick: Math.max(0.05, thick), depth: depth0, deepest: Math.max(0, depth0), age: 0, hand: w.state === 'held',
      joint: null, lat: new THREE.Vector3(), rel: null, prevC: _C.clone(), exited: false, leftAt: 0, dripAcc: 0, squelchT: 0,
      blend: 1, blendP: new THREE.Vector3(), blendQ: new THREE.Quaternion(),
    };
    (L as Lodge & { exitN?: THREE.Vector3 | null; exitBone?: THREE.Object3D | null }).exitN = exitN;
    (L as Lodge & { exitBone?: THREE.Object3D | null }).exitBone = exitBone;
    this.lodges.push(L);
    e.lodged++;
    // nothing of the lodged blade collides any more (it's inside him)
    w.collider.setCollisionGroups(GROUPS.none);
    // the wound: a slit along the blade's width
    // the wound: a slit (the blade held flat), the blood running down from it
    this.enemies.woundDecals.add(e, part, bone, entry, normal!, Y, w.cls === 'spear' ? 0.12 : 0.11, 'entry', this.enemies.t, 6);
    this.fx.spurt(entry, _n.copy(normal!).multiplyScalar(0.7).addScaledVector(u, -0.5), 16, 2.4, 0.55);
    if (!e.dead) this.enemies.impaleStart(e, w.id, part, L.vital);
    else if (!res?.penetrated) audio.stabIn(0.6, res?.armor ?? 'gap', audio.pan(entry), part === P.Torso); // a corpse
    combatLog({ kind: 'stab', id: e.id, part, vital: L.vital, depth: +depth0.toFixed(3), thick: +L.thick.toFixed(3), speed: +info.speed.toFixed(2), armor: res?.armor, dead: e.dead, rayMs: +rayMs.toFixed(1) });
    void info;
    return true;
  }

  /** Re-grabbing a blade you left in him: it eases into your hand and the lodge goes on. */
  regrab(w: WeaponEnt) {
    const L = this.lodgeOf(w);
    if (!L) return;
    const r = w.body.rotation(), t = w.body.translation();
    L.blendP.set(t.x, t.y, t.z); L.blendQ.set(r.x, r.y, r.z, r.w);
    L.blend = 0;
    L.hand = true;
    L.rel = null;
    L.prevC.set(t.x, t.y, t.z);
    // taking it back cancels his wrench-out
    if (L.e.impale && L.freeAtBefore !== undefined) { L.e.impale.freeAt = L.freeAtBefore; L.e.impale.wantFree = false; L.freeAtBefore = undefined; }
    w.collider.setCollisionGroups(GROUPS.none);
  }

  /** While re-grabbing, the held blade's kinematic target eases in from where it sits in him. */
  blendHeld(w: WeaponEnt, p: THREE.Vector3, q: THREE.Quaternion, realDt: number) {
    const L = this.lodgeOf(w);
    if (!L || L.blend >= 1) return;
    L.blend = Math.min(1, L.blend + realDt / 0.16);
    const k = L.blend * L.blend * (3 - 2 * L.blend);
    p.lerpVectors(L.blendP, p, k);
    q.slerpQuaternions(L.blendQ, q, k);
  }

  /**
   * The hand let go of a lodged blade. A throw rips it out; otherwise it stays in him (returns true: the weapon
   * manager parks it as 'lodged').
   */
  onRelease(w: WeaponEnt, vel: THREE.Vector3): boolean {
    const L = this.lodgeOf(w);
    if (!L) return false;
    if (vel.length() > 2.5) { this.end(L, 'tear'); return false; }
    if (L.joint) { this.removeJoint(L); }
    this.entryFrame(L, _pc, _pq);
    const r = w.body.rotation(), t = w.body.translation();
    const inv = _q2.copy(_pq).invert();
    L.rel = { p: new THREE.Vector3(t.x, t.y, t.z).sub(_pc).applyQuaternion(inv), q: inv.clone().multiply(_q.set(r.x, r.y, r.z, r.w)) };
    L.hand = false;
    L.leftAt = L.age;
    // a living man with a blade left in him tears it out after a moment (unless it kills him first)
    if (L.e.impale) { L.freeAtBefore = L.e.impale.freeAt; L.e.impale.freeAt = Math.min(L.e.impale.freeAt, this.enemies.t + 1.3); }
    return true;
  }

  /** Before world.step: a blade left in a man rides on his body. */
  prestep() {
    for (const L of this.lodges) {
      if (L.hand || !L.rel || L.w.state !== 'lodged') continue;
      if ((L.e.dead || L.e.state === 'down') && L.e.ragdoll?.bodies[L.part]) this.toPartFrame(L);
      this.entryFrame(L, _pc, _pq);
      const p = _o.copy(L.rel.p).applyQuaternion(_pq).add(_pc);
      const q = _q2.copy(_pq).multiply(L.rel.q);
      L.w.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      L.w.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  private makeJoint(L: Lodge) {
    const body = L.e.ragdoll?.bodies[L.part];
    if (!body) return;
    this.toPartFrame(L);
    const bt = body.translation(), br = body.rotation();
    _pq.set(br.x, br.y, br.z, br.w);
    const wr = L.w.body.rotation(), wt = L.w.body.translation();
    const wq = new THREE.Quaternion(wr.x, wr.y, wr.z, wr.w);
    const entryW = L.entryL.clone().applyQuaternion(_pq).add(_pc.set(bt.x, bt.y, bt.z));
    const a1 = entryW.sub(_o.set(wt.x, wt.y, wt.z)).applyQuaternion(wq.clone().invert());
    L.lat.set(a1.x, 0, a1.z);
    L.depth = Math.min(L.prof.maxDepth, Math.max(0, L.prof.tipY - a1.y));
    const relQ = wq.clone().invert().multiply(_pq);
    const jd = RAPIER.JointData.fixed(
      { x: a1.x, y: L.prof.tipY - L.depth, z: a1.z }, { x: relQ.x, y: relQ.y, z: relQ.z, w: relQ.w },
      { x: L.entryL.x, y: L.entryL.y, z: L.entryL.z }, { x: 0, y: 0, z: 0, w: 1 },
    );
    L.joint = this.world.createImpulseJoint(jd, L.w.body, body, true);
    L.joint.setContactsEnabled(false);
  }
  private removeJoint(L: Lodge) {
    if (!L.joint) return;
    try { this.world.removeImpulseJoint(L.joint, true); } catch { /* removed with the body */ }
    L.joint = null;
  }

  /** After world.step (weapons placed): follow the hand, drag him, run him through, pull out. */
  update(dt: number, realDt: number) {
    this.t += dt;
    const ss = this.hooks.speedScale();
    for (const L of [...this.lodges]) {
      const { w, e } = L;
      if (w.state === 'gone' || !this.enemies.list.includes(e)) { this.end(L, 'drop'); continue; }
      if (w.state !== 'held' && w.state !== 'lodged') { this.end(L, 'pull'); continue; } // pulled away (kb pull-grab, …)
      L.age += realDt;
      this.bladeFrame(w, L.prof);
      const physical = (e.dead || e.state === 'down') && !!e.ragdoll?.bodies[L.part];
      if (e.state === 'down' && !e.dead) { this.end(L, 'tear'); continue; } // knocked flat off the blade
      if (physical) this.toPartFrame(L);
      const entryW = this.entryWorld(L, _e);
      if (!L.hand) {
        // left in him: the blade rides his body; a living man wrenches it out
        if (!e.dead && e.impale?.wantFree) { this.end(L, 'selfpull'); continue; }
        if (!e.dead && !e.impale) { this.end(L, 'selfpull'); continue; }
        this.after(L, entryW, realDt);
        L.prevC.copy(_C);
        continue;
      }
      const blending = L.blend < 1;
      const da = _o.subVectors(_C, L.prevC).dot(_u); // the hand's travel along the blade this step
      if (physical) {
        // a corpse on the blade: the joint holds him; the blade slides through him as you push / pull
        if (!L.joint) this.makeJoint(L);
        if (!L.joint) { this.end(L, 'drop'); continue; }
        L.depth = Math.min(L.depth + da * (da > 0 ? 0.75 : 0.92), L.prof.maxDepth);
        L.joint.setAnchor1({ x: L.lat.x, y: L.prof.tipY - L.depth, z: L.lat.z });
        e.ragdoll!.bodies[L.part]!.wakeUp();
        // ripped sideways hard enough, the corpse comes off the blade
        const lat = _n.subVectors(_C, L.prevC).addScaledVector(_u, -da).length() / Math.max(1e-3, realDt);
        if (lat > 7 && L.age > 0.15 && !blending) { combatLog({ kind: 'stabTear', corpse: true, lat: +lat.toFixed(2) }); this.end(L, 'tear'); continue; }
      } else if (!e.dead) {
        // a living man held on the blade. The depth follows your hand along the blade (a push drives him back a
        // little — 75% goes in — a pull draws the blade out); his body is moved so the wound sits on the blade at
        // that depth, whatever his own staggering does
        const want = Math.min(L.prof.maxDepth, L.depth + da * (da > 0 ? 0.75 : 0.92));
        const target = _a.copy(_tip).addScaledVector(_u, -want);
        const off = _n.subVectors(target, entryW);
        // sideways speed of the blade through him: fast enough, it rips out instead of dragging him
        const vLat = _b.copy(off).addScaledVector(_u, -off.dot(_u)).length() / Math.max(1e-3, realDt);
        // his body turns as the blade turns (yaw); twisted too far, it tears out
        const bodyAxis = _b.copy(L.axisL).applyQuaternion(_pq);
        const ang = Math.acos(Math.max(-1, Math.min(1, bodyAxis.dot(_u))));
        const dYaw = Math.atan2(bodyAxis.x * _u.z - bodyAxis.z * _u.x, bodyAxis.x * _u.x + bodyAxis.z * _u.z) * -1;
        const lift = e.impaleLift + off.y;
        const tearV = (e.kind === 'boss' ? 2.4 : 3.4) * ss * (blending ? 3 : 1);
        if (L.age > 0.1 && (vLat > tearV || lift > 0.14 || lift < -0.45 || ang > 1.0)) {
          combatLog({ kind: 'stabTear', vLat: +vLat.toFixed(2), lift: +lift.toFixed(2), ang: +ang.toFixed(2) });
          this.end(L, 'tear'); continue;
        }
        this.enemies.moveImpaled(e, off.x, off.z, off.y, dYaw * Math.min(1, realDt * 12));
        this.entryWorld(L, entryW);
        L.depth = _a.subVectors(_tip, entryW).dot(_u);
        this.enemies.impaleDepth(e, L.depth, L.depth > L.thick + 0.02);
        if (e.impale?.wantFree) { this.end(L, 'tear'); continue; }
      } else { this.end(L, 'drop'); continue; }
      // deeper, fast: the wet sound of it going in further
      if (L.depth - L.deepest > 0.06 && this.t - L.squelchT > 0.15) { L.squelchT = this.t; audio.stabIn(0.4, 'gap', audio.pan(entryW), false); }
      L.deepest = Math.max(L.deepest, L.depth);
      // pulled out along the blade
      if (L.depth < -0.005 && L.age > 0.06) { this.end(L, 'pull'); continue; }
      this.after(L, entryW, realDt);
      L.prevC.copy(_C);
    }
    this.blood.update(realDt);
    for (let i = this.drips.length - 1; i >= 0; i--) {
      const d = this.drips[i];
      if (d.w.state === 'gone' || this.t > d.until) { this.drips.splice(i, 1); continue; }
      d.acc += realDt * (3 + 9 * Math.max(0, (d.until - this.t) / 2.5));
      while (d.acc > 1) {
        d.acc -= 1;
        const r = d.w.body.rotation(), t = d.w.body.translation();
        _q.set(r.x, r.y, r.z, r.w);
        const along = d.tipY * (0.55 + Math.random() * 0.45);
        this.fx.drip(_o.set(0, along, 0).applyQuaternion(_q).add(_a.set(t.x, t.y, t.z)), 1);
      }
    }
  }

  /** shared per-step effects: through-and-out, the blood on the blade, the drips */
  private after(L: Lodge, entryW: THREE.Vector3, realDt: number) {
    const { w, e } = L;
    if (!L.exited && L.depth > L.thick + 0.02) {
      L.exited = true;
      const ex = L as Lodge & { exitN?: THREE.Vector3 | null; exitBone?: THREE.Object3D | null };
      const exitW = entryW.clone().addScaledVector(_u, L.thick);
      this.enemies.skinOf(e); // bones in step with the pose before the wound is pinned to one
      this.enemies.woundDecals.add(e, L.part, ex.exitBone ?? null, exitW, ex.exitN ?? _u, Y, 0.13, 'exit', this.enemies.t, 6);
      this.fx.spurt(exitW, _u, 22, 3.0, 0.5);
      audio.boneCrunch(5, audio.pan(exitW));
      audio.fleshCut(0.7, false, audio.pan(exitW));
      this.hooks.shake(0.15);
      combatLog({ kind: 'runThrough', id: e.id, depth: +L.depth.toFixed(3), thick: +L.thick.toFixed(3) });
    }
    this.blood.bloody(w.id, w.obj, L.prof.tipY, Math.min(L.prof.maxDepth, Math.max(0.02, L.deepest)));
    // the wound runs down the blade, the point drips once it's out of his back
    L.dripAcc += realDt * 7;
    while (L.dripAcc > 1) {
      L.dripAcc -= 1;
      if (L.exited && Math.random() < 0.6) this.fx.drip(_o.copy(_tip), 1);
      else this.fx.drip(_o.copy(entryW).addScaledVector(_u, -0.01 - Math.random() * 0.03), 1);
    }
  }

  /** The blade comes out (or the body is gone). */
  end(L: Lodge, how: 'pull' | 'tear' | 'drop' | 'selfpull') {
    const i = this.lodges.indexOf(L);
    if (i < 0) return;
    this.lodges.splice(i, 1);
    this.removeJoint(L);
    const { w, e } = L;
    e.lodged = Math.max(0, e.lodged - 1);
    const alive = this.enemies.list.includes(e);
    if (alive) {
      const entryW = this.entryWorld(L, new THREE.Vector3());
      const nrm = L.normalL.clone().applyQuaternion(_pq);
      const r = w.body.rotation();
      const u = new THREE.Vector3(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
      if (how !== 'drop') {
        // blood follows the blade out (and out of his back if it went through)
        this.fx.spurt(entryW, nrm.clone().multiplyScalar(0.8).addScaledVector(u, -0.6), how === 'tear' ? 30 : 20, 2.8, 0.55);
        if (L.exited) this.fx.spurt(entryW.clone().addScaledVector(u, L.thick), u, 14, 2.4, 0.5);
        audio.stabOut(Math.min(1, 0.4 + L.deepest * 2), audio.pan(entryW));
        if (how === 'tear') {
          audio.fleshCut(0.9, false, audio.pan(entryW));
          // ripped sideways: the edge opens a gash along the way it tore
          const tear = new THREE.Vector3().subVectors(_C.set(w.body.translation().x, w.body.translation().y, w.body.translation().z), L.prevC);
          if (tear.lengthSq() < 1e-6) tear.set(1, 0, 0);
          this.enemies.woundDecals.add(e, L.part, null, entryW, nrm, tear, 0.13, 'gash', this.enemies.t, 5);
        }
        for (const wd of e.wounds) if (this.enemies.t - wd.bornT < 30) wd.bleedUntil = Math.max(wd.bleedUntil, this.enemies.t + 5);
      }
      if (!e.dead) this.enemies.impaleEnd(e, how === 'tear' ? 'tear' : 'pull', w.id);
    }
    combatLog({ kind: 'stabOut', how, depth: +L.depth.toFixed(3), deepest: +L.deepest.toFixed(3), through: L.exited, dead: e.dead });
    this.blood.bloody(w.id, w.obj, L.prof.tipY, Math.min(L.prof.maxDepth, Math.max(0.03, L.deepest)));
    this.drips.push({ w, until: this.t + 2.5, acc: 0, tipY: L.prof.tipY });
    if (w.state === 'lodged') {
      const v = new THREE.Vector3(0, 0.6, 0);
      if (alive && !e.dead) v.add(e.forward.clone().multiplyScalar(0.8));
      this.hooks.freeWeapon(w, v);
    } else if (w.state === 'held') w.collider.setCollisionGroups(GROUPS.held);
  }

  /** a weapon is being removed / reset: forget its lodge without effects */
  forget(w: WeaponEnt, quiet = false) {
    const L = this.lodgeOf(w);
    if (L) {
      this.lodges.splice(this.lodges.indexOf(L), 1); this.removeJoint(L); L.e.lodged = Math.max(0, L.e.lodged - 1);
      if (L.e.impale?.weaponId === w.id) {
        if (quiet) L.e.impale = null; // match reset: no cries, the wooers are going anyway
        else this.enemies.impaleEnd(L.e, 'pull', w.id); // never leave him stuck 'impaled'
      }
    }
    this.blood.forget(w.id);
  }

  clear() { for (const L of [...this.lodges]) this.forget(L.w, true); this.drips.length = 0; }
}
