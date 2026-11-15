// Armored wooers: steering, directional attacks with telegraphs, deflection outcomes, posture,
// zone armor (glance vs. penetrate), Blade & Sorcery–style dismemberment, ragdolls, archers.
// Numbers follow the research briefs (see apps/web/DESIGN.md → Combat).
import * as THREE from 'three';
import { RAPIER } from './physics';
import {
  P, PART_COUNT, PART_DIM, PART_ZONE, PARENT, addBodies, destroyRagdoll, emptyBodies, jointPoint, newAnim, newPose,
  readRagdoll, severJoint, solvePose, subtree, type Anim, type PartPose, type Ragdoll, type Zone,
} from './humanoid';
import { ArmoredRenderer, type SlotLook, type ShieldKind } from './armoredRenderer';
import { lookFor } from './panoply';
import { HALL } from './hall';
import { ballisticDir, clamp, damp, pick, rand, segSegDist2 } from './math';
import type { Fx } from './fx';
import { audio } from './audio';

export type EnemyKind = 'suitor' | 'archer' | 'boss' | 'hero';

/** QA log (window.__combatLog when ?debug=1 or in dev) */
export function combatLog(entry: Record<string, unknown>) {
  const w = window as unknown as { __combatLog?: Record<string, unknown>[] };
  if (!w.__combatLog) return;
  w.__combatLog.push({ t: +performance.now().toFixed(0), ...entry });
  if (w.__combatLog.length > 400) w.__combatLog.shift();
}
export type AttackDir = 'left' | 'right' | 'top' | 'thrust';
type EState = 'idle' | 'approach' | 'wait' | 'windup' | 'strike' | 'recover' | 'recoil' | 'stagger' | 'broken' | 'block'
  | 'aim' | 'shoot' | 'down' | 'getup' | 'maimed' | 'dead';

/** What happened when a wooer's blow arrived (decided by the engine from the player's blade, lean and guard). */
export type Outcome = 'perfect' | 'beat' | 'block' | 'shield' | 'guard' | 'perfectDodge' | 'dodge' | 'hit';

export interface Attack {
  dir: AttackDir;
  unblockable: boolean;
  windup: number;       // s
  startT: number;
  impactAt: number;     // sim time of contact
  lane: THREE.Vector3;  // world point the blow passes through (locked 250 ms before impact)
  locked: boolean;
  glinted: boolean;
  whooshed: boolean;
  resolved: boolean;
}

export interface Stump { part: number; local: THREE.Vector3; until: number }

export interface Enemy {
  id: number;
  kind: EnemyKind;
  slot: number;
  look: SlotLook;
  hp: number;
  maxHp: number;
  shieldHp: number;
  posture: number;
  postureT: number;
  pos: THREE.Vector3;
  yaw: number;
  vel: THREE.Vector3;
  speed: number;
  state: EState;
  stateT: number;
  stateDur: number;
  phase: number;
  anim: Anim;
  pose: PartPose[];
  /** physics bodies: severed limbs while alive, the whole ragdoll after death/knockdown */
  ragdoll: Ragdoll | null;
  severed: Set<number>;
  stumps: Stump[];
  armed: boolean;        // still has a weapon in hand
  dead: boolean;
  diedAt: number;
  ring: number | null;
  attack: Attack | null;
  nextAttackAt: number;
  spot: THREE.Vector3 | null;
  lastHit: Map<number, number>;
  spawnT: number;
  name?: string;
  pinned: boolean;
  feastSeed: number;
  forward: THREE.Vector3;
  charging: boolean;
  blockTimes: number[];
  flinch: { t: number; dir: THREE.Vector3; amount: number };
  bleedUntil: number;
}

export interface HitInfo {
  amount: number;          // legacy/explicit damage (bombs); melee/thrown use speed
  zone: Zone;
  part: number;
  point: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  sharp: boolean;
  source: 'melee' | 'thrown' | 'arrow' | 'bomb' | 'fist';
  impulse: number;
  weaponEntId: number | null;
  /** unit blade axis (grip → tip) when known: thrust vs. cut */
  bladeAxis?: THREE.Vector3;
  massKg?: number;
  classDamage?: number;
}

export type HitKind = 'flesh' | 'glance' | 'blocked' | 'shield' | 'kill';
export interface HitResult {
  blocked: boolean;          // shield/parry stopped it (player blade should recoil)
  parried: boolean;          // wooer actively blocked with sword/shield
  glanced: boolean;          // bounced off armor
  killed: boolean;
  shieldBroke: boolean;
  severed: number | null;    // part index cut off
  decapitated: boolean;
  finisher: boolean;
  damage: number;
  enemy: Enemy;
}

export interface EnemyArrow { pos: THREE.Vector3; vel: THREE.Vector3; prev: THREE.Vector3; alive: boolean; stuck: number; fromId: number }

export interface EnemyHooks {
  onKill(e: Enemy, info: HitInfo, rag: Ragdoll, how: { decapitated: boolean; finisher: boolean; severed: number | null }): void;
  onPlayerHit(dmg: number, source: 'melee' | 'arrow', from: THREE.Vector3, heavy: boolean): void;
  /** decide the outcome of a blow at its impact moment */
  resolveIncoming(e: Enemy, a: Attack): Outcome;
  onOutcome(e: Enemy, a: Attack, o: Outcome, at: THREE.Vector3): void;
  onAttackStart(e: Enemy, a: Attack): void;
  onSever(e: Enemy, part: number, alive: boolean): void;
  onDropWeapon(kind: 'sword' | 'spear' | 'shield', pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, look: SlotLook): void;
  onArrowBlocked(pos: THREE.Vector3): void;
  playerHead(): THREE.Vector3;
  blocking(): boolean;
  shieldHeld(): boolean;
  parryCheck(p0: THREE.Vector3, p1: THREE.Vector3): boolean;
  hitstop(ms: number): void;
  shake(v: number): void;
  difficultyMult(): number;
  /** mouse swings are slower than real arms: thresholds scale (kb 0.65, webcam 1.0) */
  speedScale(): number;
  /** body-frame → world (camera yaw) for attack lanes */
  laneOffset(dir: AttackDir, out: THREE.Vector3): THREE.Vector3;
}

const RING_ANGLES = [-0.6, 0, 0.6];
const RING_R = 1.35;
const MAX_RAGDOLLS = 12;
const RAGDOLL_TTL = 14;

// Armor penetration (m/s): cut / thrust — research brief §5
type ArmorClass = 'bronze' | 'linen' | 'thigh' | 'gap';
const VPEN: Record<ArmorClass, [number, number]> = { bronze: [9, 6], linen: [5, 3.5], thigh: [3, 2], gap: [1.5, 1.5] };
const BLUNT_ABSORB: Record<ArmorClass, number> = { bronze: 0.45, linen: 0.3, thigh: 0.15, gap: 0 };
// Sever speed (m/s) for an edge cut through a joint gap
// B&S needs 12 m/s in VR; scaled to mouse/webcam swing speeds. Head = the NECK only (helmets stop head cuts).
const SEVER: Partial<Record<number, number>> = {
  [P.Head]: 5.5, [P.UArmL]: 6.0, [P.UArmR]: 6.0, [P.LArmL]: 5.0, [P.LArmR]: 5.0,
  [P.ULegL]: 7.5, [P.ULegR]: 7.5, [P.LLegL]: 6.0, [P.LLegR]: 6.0,
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

type World = InstanceType<typeof RAPIER.World>;

export class EnemyManager {
  readonly renderer: ArmoredRenderer;
  readonly list: Enemy[] = [];
  readonly arrows: EnemyArrow[] = [];
  private freeSlots: number[];
  private nextId = 1;
  private ringOwner: (number | null)[] = [null, null, null];
  private lastImpactAt = -99;
  melanthius = false;
  t = 0;

  constructor(private world: World, private fx: Fx, private hooks: EnemyHooks, capacity = 24) {
    this.renderer = new ArmoredRenderer(capacity);
    this.freeSlots = Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
  }

  get alive() { return this.list.filter((e) => !e.dead && e.kind !== 'hero'); }
  get aliveCount() { let n = 0; for (const e of this.list) if (!e.dead && e.kind !== 'hero') n++; return n; }

  spawn(kind: EnemyKind, at: THREE.Vector3, opts: { idle?: boolean; shield?: boolean } = {}): Enemy | null {
    if (!this.freeSlots.length) this.evictOldestRagdoll();
    const slot = this.freeSlots.pop();
    if (slot === undefined) return null;
    const boss = kind === 'boss';
    const shield: ShieldKind = boss || kind === 'hero' ? 'round'
      : opts.shield || (this.melanthius && kind === 'suitor' && Math.random() < 0.55) ? 'round' : 'none';
    const look: SlotLook = lookFor(kind, this.melanthius, shield);
    const maxHp = boss ? 360 : kind === 'archer' ? 70 : 100;
    const e: Enemy = {
      id: this.nextId++, kind, slot, look, hp: maxHp, maxHp,
      shieldHp: boss ? 150 : shield === 'round' ? 70 : 0, posture: 0, postureT: -9,
      pos: at.clone(), yaw: Math.PI, vel: new THREE.Vector3(), speed: boss ? 1.25 : kind === 'archer' ? 2.0 : rand(1.9, 2.5),
      state: opts.idle ? 'idle' : 'approach', stateT: 0, stateDur: 0, phase: Math.random() * 6,
      anim: newAnim(), pose: newPose(), ragdoll: null, severed: new Set(), stumps: [], armed: look.prop !== 'none',
      dead: false, diedAt: 0, ring: null, attack: null, nextAttackAt: 0, spot: null, lastHit: new Map(), spawnT: this.t,
      name: boss ? 'Antinous' : undefined, pinned: false, feastSeed: Math.random() * 10, forward: new THREE.Vector3(0, 0, 1),
      charging: false, blockTimes: [], flinch: { t: -9, dir: new THREE.Vector3(), amount: 0 }, bleedUntil: 0,
    };
    if (kind === 'archer') {
      const side = Math.random() < 0.5 ? -1 : 1;
      e.spot = new THREE.Vector3(side * rand(1.6, 2.5), 0, rand(-19, -11.5));
      if (Math.abs(e.spot.z - HALL.hearth.z) < 2.4) e.spot.x = side * 2.5;
    }
    solvePose(e.pose, e.pos, e.yaw, e.look.scale, e.anim);
    this.list.push(e);
    return e;
  }

  clear() {
    for (const e of this.list) this.release(e);
    this.list.length = 0;
    this.arrows.length = 0;
    this.ringOwner = [null, null, null];
    this.melanthius = false;
  }

  private release(e: Enemy) {
    if (e.ragdoll) { destroyRagdoll(this.world, e.ragdoll); e.ragdoll = null; }
    this.renderer.hide(e.slot);
    if (e.ring !== null) this.ringOwner[e.ring] = null;
    this.freeSlots.push(e.slot);
  }

  private evictOldestRagdoll() {
    let oldest: Enemy | null = null;
    for (const e of this.list) if (e.dead && (!oldest || e.diedAt < oldest.diedAt)) oldest = e;
    if (oldest) { this.release(oldest); this.list.splice(this.list.indexOf(oldest), 1); }
  }

  countNear(r: number) {
    let n = 0;
    for (const e of this.list) if (!e.dead && e.state !== 'idle' && e.kind !== 'hero' && Math.hypot(e.pos.x, e.pos.z) < r) n++;
    return n;
  }

  nearestTorso(origin: THREE.Vector3, dir: THREE.Vector3, maxAngle: number, out: THREE.Vector3): Enemy | null {
    let best: Enemy | null = null;
    let bestAng = maxAngle;
    for (const e of this.list) {
      if (e.dead || e.state === 'idle' || e.kind === 'hero') continue;
      const c = e.pose[P.Torso].c;
      _v.subVectors(c, origin);
      if (_v.lengthSq() < 0.25) continue;
      const ang = _v.angleTo(dir);
      if (ang < bestAng) { bestAng = ang; best = e; out.copy(c); }
    }
    return best;
  }

  /** Active wind-ups for the HUD (direction arcs, glints, chevrons). */
  telegraphs() {
    const out: { e: Enemy; a: Attack; progress: number; tip: THREE.Vector3 }[] = [];
    for (const e of this.list) {
      if (!e.attack || e.dead || (e.state !== 'windup' && e.state !== 'strike')) continue;
      const a = e.attack;
      const progress = clamp((this.t - a.startT) / Math.max(0.05, a.impactAt - a.startT), 0, 1);
      const tip = new THREE.Vector3();
      this.renderer.swordSegment(e.pose, e.look, _v, tip);
      out.push({ e, a, progress, tip });
    }
    return out;
  }

  // ── update ──────────────────────────────────────────────────────────────
  update(dt: number) {
    this.t += dt;
    const head = this.hooks.playerHead();
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      this.renderer.flash[e.slot] = Math.max(0, this.renderer.flash[e.slot] - dt * 5);
      if (e.dead) {
        const pel = e.ragdoll?.bodies[P.Pelvis]?.translation();
        const tooClose = !!pel && !e.pinned && Math.hypot(pel.x, pel.z) < 1.8 && this.t - e.diedAt > 3;
        if (this.t - e.diedAt > RAGDOLL_TTL || tooClose) {
          if (tooClose && pel) this.fx.dust(new THREE.Vector3(pel.x, pel.y, pel.z), 10);
          this.release(e);
          this.list.splice(i, 1);
        }
        this.bleed(e, dt);
        continue;
      }
      e.stateT += dt;
      // posture regen 10/s after 1.5 s without posture damage (halved below 50% hp)
      if (this.t - e.postureT > 1.5 && e.state !== 'broken') e.posture = Math.max(0, e.posture - dt * (e.hp < e.maxHp * 0.5 ? 5 : 10));
      if (e.state === 'idle') { this.updateIdle(e, dt); continue; }
      if (e.state === 'down') { this.updateDown(e); continue; }
      this.updateAI(e, dt, head);
      this.bleed(e, dt);
    }
    let rags = 0;
    for (const e of this.list) if (e.dead) rags++;
    if (rags > MAX_RAGDOLLS) this.evictOldestRagdoll();
    this.updateArrows(dt, head);
  }

  private bleed(e: Enemy, dt: number) {
    for (const s of e.stumps) {
      if (this.t > s.until) continue;
      if (Math.random() < dt * 40) {
        const p = e.pose[s.part];
        const w = _v.copy(s.local).applyQuaternion(p.q).add(p.c);
        const d = _v2.copy(s.local).normalize().applyQuaternion(p.q);
        this.fx.blood(w, d, 2);
      }
    }
  }

  private updateIdle(e: Enemy, dt: number) {
    e.phase += dt;
    const a = e.anim;
    if (e.kind === 'hero') {
      // Odysseus at rest: bow lowered, shield on the arm, weight on the back foot
      a.armL = [0.35, 0.08, 0.45]; a.armR = [0.15, 0.12, 0.35];
      a.legL = [0.12, 0.08]; a.legR = [-0.08, 0.12];
      a.lean = Math.sin(e.phase * 0.6) * 0.015; a.twist = 0.08; a.bob = Math.sin(e.phase * 1.2) * 0.004; a.headPitch = 0.05;
    } else {
      const cup = Math.max(0, Math.sin(e.phase * 0.6 + e.feastSeed));
      a.armR = [cup * 1.9, 0.15, cup * 1.6];
      a.armL = [0.2, 0.18, 0.5];
      a.legL = [0, 0.05]; a.legR = [0, 0.05];
      a.lean = Math.sin(e.phase * 0.5 + e.feastSeed) * 0.06;
      a.headPitch = -cup * 0.3;
      a.twist = Math.sin(e.phase * 0.3 + e.feastSeed) * 0.2;
      a.bob = 0;
    }
    solvePose(e.pose, e.pos, e.yaw, e.look.scale, a);
  }

  private assignRing(e: Enemy) {
    if (e.ring !== null) return;
    let best = -1, bestD = Infinity;
    for (let k = 0; k < RING_ANGLES.length; k++) {
      if (this.ringOwner[k] !== null) continue;
      const sx = Math.sin(RING_ANGLES[k]) * RING_R, sz = -Math.cos(RING_ANGLES[k]) * RING_R;
      const d = Math.hypot(e.pos.x - sx, e.pos.z - sz);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best >= 0) { e.ring = best; this.ringOwner[best] = e.id; e.nextAttackAt = Math.max(e.nextAttackAt, this.t + 1.2); }
  }

  private windupOwner(): Enemy | null {
    for (const e of this.list) if (!e.dead && (e.state === 'windup' || e.state === 'strike')) return e;
    return null;
  }

  private setState(e: Enemy, s: EState, dur = 0) { e.state = s; e.stateT = 0; e.stateDur = dur; }

  private updateAI(e: Enemy, dt: number, head: THREE.Vector3) {
    const a = e.anim;
    const toPlayer = _v.set(head.x - e.pos.x, 0, head.z - e.pos.z);
    const distPlayer = toPlayer.length();
    let target: THREE.Vector3 | null = null;
    let moving = false;
    const meleeCapable = e.armed && !(e.kind === 'archer' && !e.charging);

    if (e.kind === 'archer' && !e.charging) target = e.spot;
    else {
      if (distPlayer < 10 || e.ring !== null) this.assignRing(e);
      if (e.ring !== null) {
        const ang = RING_ANGLES[e.ring];
        const r = RING_R * (e.kind === 'boss' ? 1.08 : 1);
        target = _v3.set(Math.sin(ang) * r, 0, -Math.cos(ang) * r);
      } else {
        const ang = ((e.id * 0.618) % 1) * 2.2 - 1.1;
        target = _v3.set(Math.sin(ang) * 4.6, 0, -Math.cos(ang) * 4.6 - 0.5);
      }
    }

    const rooted = ['windup', 'strike', 'recover', 'recoil', 'stagger', 'broken', 'block', 'aim', 'shoot', 'getup', 'maimed'].includes(e.state);
    if (!rooted && target) {
      const goal = _v2.copy(target);
      if (e.pos.z < HALL.hearth.z + 2.3 && e.pos.z > HALL.hearth.z - 2.6 && Math.abs(e.pos.x) < 2.15) goal.set(e.pos.x >= 0 ? 2.25 : -2.25, 0, HALL.hearth.z + 2.4);
      else if (e.pos.z < HALL.hearth.z - 2.6 && target.z > HALL.hearth.z) goal.set(e.pos.x >= 0 ? 2.25 : -2.25, 0, HALL.hearth.z - 1.0);
      const d = _c1.subVectors(goal, e.pos).setY(0);
      const dist = d.length();
      if (dist > 0.12) {
        d.multiplyScalar(1 / dist);
        for (const o of this.list) {
          if (o === e || o.dead || o.state === 'idle') continue;
          const sx = e.pos.x - o.pos.x, sz = e.pos.z - o.pos.z;
          const sd = Math.hypot(sx, sz);
          if (sd < 0.85 && sd > 1e-3) { d.x += (sx / sd) * (0.85 - sd) * 2.2; d.z += (sz / sd) * (0.85 - sd) * 2.2; }
        }
        for (const z of HALL.columnZ) for (const x of [-HALL.columnX, HALL.columnX]) {
          const sx = e.pos.x - x, sz = e.pos.z - z, sd = Math.hypot(sx, sz);
          if (sd < 1.0) { d.x += (sx / sd) * (1.0 - sd) * 3; d.z += (sz / sd) * (1.0 - sd) * 3; }
        }
        const hx = e.pos.x - HALL.hearth.x, hz = e.pos.z - HALL.hearth.z, hd = Math.hypot(hx, hz);
        if (hd < 2.0) { d.x += (hx / hd) * (2.0 - hd) * 4; d.z += (hz / hd) * (2.0 - hd) * 4; }
        d.normalize();
        const sp = e.speed * Math.min(1, dist / 0.6 + 0.25);
        e.vel.x = damp(e.vel.x, d.x * sp, 6, dt);
        e.vel.z = damp(e.vel.z, d.z * sp, 6, dt);
        moving = true;
      } else { e.vel.x = damp(e.vel.x, 0, 8, dt); e.vel.z = damp(e.vel.z, 0, 8, dt); }
    } else { e.vel.x = damp(e.vel.x, 0, 10, dt); e.vel.z = damp(e.vel.z, 0, 10, dt); }
    e.pos.addScaledVector(e.vel, dt);
    e.pos.x = clamp(e.pos.x, -2.75, 2.75);
    e.pos.z = clamp(e.pos.z, HALL.zFar + 0.8, -1.25);
    const r0 = Math.hypot(e.pos.x, e.pos.z);
    if (r0 < 1.3) { e.pos.x *= 1.3 / r0; e.pos.z *= 1.3 / r0; }

    const speed = Math.hypot(e.vel.x, e.vel.z);
    const faceYaw = (moving && speed > 0.5 && distPlayer > 3.2 && !(e.kind === 'archer' && !e.charging))
      ? Math.atan2(e.vel.x, e.vel.z) : Math.atan2(toPlayer.x, toPlayer.z);
    let dy = faceYaw - e.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    // attacks track until 250 ms before impact, then lock
    const locked = e.attack?.locked;
    if (!locked) e.yaw += dy * (1 - Math.exp(-8 * dt));
    e.forward.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));

    // base locomotion pose
    e.phase += speed * dt * 4.0;
    const sw = Math.sin(e.phase) * Math.min(1, speed / 1.5);
    a.legL = [sw * 0.55, Math.max(0, -Math.cos(e.phase)) * 0.7 * Math.min(1, speed) + 0.06];
    a.legR = [-sw * 0.55, Math.max(0, Math.cos(e.phase)) * 0.7 * Math.min(1, speed) + 0.06];
    a.bob = Math.abs(Math.sin(e.phase)) * 0.035 * Math.min(1, speed);
    a.lean = 0.08 * Math.min(1, speed / 2);
    a.twist = 0;
    a.headPitch = 0;
    a.armL = [-sw * 0.4, 0.12, 0.3];
    a.armR = e.armed ? [0.32 + sw * 0.2, 0.24, 0.7] : [sw * 0.4, 0.12, 0.3]; // low guard: blade forward at the hip, throat open
    if (e.look.shield !== 'none' && e.shieldHp > 0 && !e.severed.has(P.LArmL)) a.armL = [1.15, 0.05, 1.3];

    const atRing = e.ring !== null && target && Math.hypot(e.pos.x - target.x, e.pos.z - target.z) < 0.4;
    const diff = this.hooks.difficultyMult();

    switch (e.state) {
      case 'approach':
      case 'wait':
        if (e.kind === 'archer' && !e.charging) {
          if (target && Math.hypot(e.pos.x - target.x, e.pos.z - target.z) < 0.5 && this.t > e.nextAttackAt) this.setState(e, 'aim');
        } else if (meleeCapable && atRing && this.t > e.nextAttackAt && !this.windupOwner() && this.t - this.lastImpactAt > 0.35) {
          this.beginAttack(e, head);
        }
        break;
      case 'windup':
      case 'strike':
        this.updateAttack(e, dt, head);
        break;
      case 'recover':
        a.armR = [0.4, 0.2, 0.5];
        if (e.stateT > 0.5) { e.nextAttackAt = this.t + rand(1.6, 2.8) / diff; this.setState(e, 'wait'); }
        break;
      case 'recoil': {
        // blow turned aside: sword arm thrown back, open
        const k = 1 - e.stateT / Math.max(0.1, e.stateDur);
        a.armR = [2.0 * k + 0.3, 0.6 * k, 0.4];
        a.lean = -0.18 * k; a.twist = 0.4 * k;
        if (e.stateT > e.stateDur) { e.nextAttackAt = this.t + rand(0.9, 1.6) / diff; this.setState(e, 'wait'); }
        break;
      }
      case 'stagger': {
        const k = 1 - e.stateT / Math.max(0.1, e.stateDur);
        a.lean = -0.32 * k; a.headPitch = -0.3 * k;
        a.armL = [-0.5 * k, 1.0 * k, 0.4]; a.armR = [-0.6 * k, 1.1 * k, 0.5]; // arms flung back: guard open
        a.legL = [0.25 * k, 0.3 * k]; a.legR = [-0.15 * k, 0.2 * k];
        if (e.stateT > e.stateDur) { e.nextAttackAt = this.t + rand(0.8, 1.4) / diff; this.setState(e, 'wait'); }
        break;
      }
      case 'broken':
        // posture broken: dropped to a knee, guard down — finisher window
        a.lean = 0.45; a.headPitch = 0.35; a.armL = [0.2, 0.3, 0.2]; a.armR = [0.1, 0.25, 0.2];
        a.legL = [1.2, 1.9]; a.legR = [-0.2, 0.3]; a.bob = -0.32;
        if (e.stateT > e.stateDur) { e.posture = 40; e.nextAttackAt = this.t + 0.8; this.setState(e, 'wait'); }
        break;
      case 'block': {
        const k = Math.sin(Math.min(1, e.stateT / e.stateDur) * Math.PI);
        a.armR = [1.6, -0.2 * k, 1.5]; a.twist = -0.25 * k;
        if (e.look.shield !== 'none') a.armL = [1.35, 0.05, 1.0];
        if (e.stateT > e.stateDur) { e.nextAttackAt = Math.min(e.nextAttackAt, this.t + 0.35); this.setState(e, 'wait'); }
        break;
      }
      case 'maimed':
        // lost the sword arm: sinks, bleeds out
        a.lean = 0.35 + Math.min(0.4, e.stateT * 0.2); a.headPitch = 0.45; a.legL = [0.9, 1.6]; a.legR = [-0.1, 0.4]; a.bob = -0.25 - Math.min(0.2, e.stateT * 0.1);
        a.armL = [0.9, 0.3, 1.6];
        if (this.t > e.bleedUntil) {
          this.kill(e, { amount: 999, zone: 'torso', part: P.Torso, point: e.pose[P.Torso].c.clone(), dir: e.forward.clone().negate(), speed: 1, sharp: false, source: 'melee', impulse: 40, weaponEntId: null }, { decapitated: false, finisher: false, severed: null });
          return;
        }
        break;
      case 'aim': {
        const k = Math.min(1, e.stateT / 1.15);
        a.armL = [1.55, 0.05, 0.05]; a.armR = [1.45, -0.35, 1.6 + 0.8 * k]; a.twist = 0.45;
        a.legL = [0.15, 0.1]; a.legR = [-0.2, 0.15];
        if (e.stateT > 0.75 && e.stateT - dt <= 0.75) this.fx.sparks(e.pose[P.LArmL].b, null, 5, '#ffe6b0');
        if (e.stateT >= 1.15) { this.fireArrow(e, head); this.setState(e, 'shoot'); }
        break;
      }
      case 'shoot':
        a.armL = [1.55, 0.05, 0.05]; a.armR = [1.2, -0.5, 0.6];
        if (e.stateT > 0.5) {
          e.nextAttackAt = this.t + rand(2.6, 3.8) / diff;
          if (Math.random() < 0.4 && e.spot) e.spot.set(-e.spot.x, 0, clamp(e.spot.z + rand(-2, 2), -19, -10.5));
          this.setState(e, 'approach');
        }
        break;
      case 'getup':
        a.lean = 0.5 * (1 - e.stateT / 0.6);
        if (e.stateT > 0.6) this.setState(e, 'approach');
        break;
      default: break;
    }
    // additive flinch (200 ms spring) — the hit reads even when nothing else changes
    const ft = this.t - e.flinch.t;
    if (ft < 0.25) {
      const k = Math.sin((ft / 0.25) * Math.PI) * e.flinch.amount;
      const side = e.flinch.dir.dot(_v.set(e.forward.z, 0, -e.forward.x));
      a.twist += side * 0.45 * k;
      a.lean -= 0.3 * k;
      a.headPitch -= 0.35 * k;
    }
    solvePose(e.pose, e.pos, e.yaw, e.look.scale, a);
    if (e.ragdoll) readRagdoll(e.ragdoll, e.pose); // severed limbs follow their own bodies
  }

  // ── attacks ─────────────────────────────────────────────────────────────
  private beginAttack(e: Enemy, head: THREE.Vector3) {
    const boss = e.kind === 'boss';
    const unblockable = boss && Math.random() < 0.3;
    const dir: AttackDir = unblockable ? 'thrust' : pick(['top', 'left', 'right', 'top', 'left', 'right', 'thrust'] as AttackDir[]);
    const windup = boss ? (unblockable ? 1.1 : 0.85) : e.look.armor === 'muscle' ? 0.8 : 0.9;
    const a: Attack = {
      dir, unblockable, windup, startT: this.t, impactAt: this.t + windup + 0.12, lane: new THREE.Vector3(), locked: false,
      glinted: false, whooshed: false, resolved: false,
    };
    this.hooks.laneOffset(dir, a.lane).add(head);
    e.attack = a;
    this.setState(e, 'windup');
    this.hooks.onAttackStart(e, a);
    audio.metal(0.22, 900); // bronze scrape on the draw
  }

  private updateAttack(e: Enemy, dt: number, head: THREE.Vector3) {
    const at = e.attack;
    const an = e.anim;
    if (!at) { this.setState(e, 'wait'); return; }
    const toImpact = at.impactAt - this.t;
    // pose: wind-up poses per direction, then the strike arc through the lane
    const w = clamp((this.t - at.startT) / at.windup, 0, 1);
    const s = clamp(1 - toImpact / 0.12, 0, 1);
    const ease = w * w * (3 - 2 * w);
    switch (at.dir) {
      case 'top':
        an.armR = [2.75 * ease - 2.3 * s, 0.25 * ease, 0.5 + 0.4 * ease - 0.7 * s];
        an.twist = -0.2 * ease + 0.3 * s; an.lean = -0.1 * ease + 0.3 * s; break;
      case 'left': // from the wooer's right → arrives on the player's left
        an.armR = [1.25 + 0.2 * s, 1.35 * ease - 1.6 * s, 1.4 * ease - 0.8 * s];
        an.twist = -0.65 * ease + 1.0 * s; break;
      case 'right': // backhand from the wooer's left → arrives on the player's right
        an.armR = [1.3, -0.35 * ease + 1.2 * s, 1.7 * ease - 1.2 * s];
        an.twist = 0.55 * ease - 0.9 * s; break;
      case 'thrust':
        an.armR = [0.4 + 1.1 * s, 0.2, 2.2 * ease - 2.1 * s];
        an.lean = -0.12 * ease + 0.35 * s; an.twist = -0.25 * ease + 0.25 * s; break;
    }
    if (!at.locked) {
      this.hooks.laneOffset(at.dir, at.lane).add(head);
      if (toImpact <= 0.25) at.locked = true;
    }
    if (!at.glinted && toImpact <= (at.unblockable ? 0.7 : 0.6)) {
      at.glinted = true;
      const tip = new THREE.Vector3();
      this.renderer.swordSegment(e.pose, e.look, _c1, tip);
      this.fx.sparks(tip, null, 8, at.unblockable ? '#ff6a4a' : '#fff1c4');
      if (at.unblockable) audio.gong(98, 1.2, 0.25); else audio.metal(0.35, 2600);
    }
    if (!at.whooshed && toImpact <= 0.25) { at.whooshed = true; audio.whoosh(6); }
    if (toImpact <= 0.12 && e.state === 'windup') { e.state = 'strike'; }
    if (toImpact <= 0 && !at.resolved) {
      at.resolved = true;
      this.lastImpactAt = this.t;
      this.resolveAttack(e, at, head);
    }
    void dt;
  }

  private resolveAttack(e: Enemy, at: Attack, head: THREE.Vector3) {
    const reach = Math.hypot(head.x - e.pos.x, head.z - e.pos.z) < 2.5;
    let o: Outcome = reach ? this.hooks.resolveIncoming(e, at) : 'dodge';
    combatLog({ kind: 'incoming', dir: at.dir, outcome: o, unblockable: at.unblockable });
    if (at.unblockable && (o === 'perfect' || o === 'beat' || o === 'block' || o === 'shield' || o === 'guard')) o = 'hit';
    const contact = at.lane.clone();
    this.hooks.onOutcome(e, at, o, contact);
    const base = e.kind === 'boss' ? (at.unblockable ? 30 : 22) : 12;
    switch (o) {
      case 'perfect':
        this.addPosture(e, 40);
        if (e.state !== 'broken') this.setState(e, 'stagger', 0.9);
        break;
      case 'beat':
        this.addPosture(e, 25);
        if (e.state !== 'broken') this.setState(e, 'recoil', 0.5);
        break;
      case 'block':
      case 'shield':
        this.addPosture(e, 8);
        if (e.state !== 'broken') this.setState(e, 'recoil', 0.3);
        break;
      case 'guard':
        this.hooks.onPlayerHit(base * 0.2, 'melee', e.pos, false);
        this.setState(e, 'recover');
        break;
      case 'dodge':
      case 'perfectDodge':
        this.setState(e, 'recover', 0.5);
        break;
      case 'hit':
        this.hooks.onPlayerHit(base, 'melee', e.pos, base > 15);
        this.setState(e, 'recover');
        break;
    }
    e.attack = null;
  }

  private addPosture(e: Enemy, amt: number) {
    e.posture = Math.min(100, e.posture + amt);
    e.postureT = this.t;
    if (e.posture >= 100 && e.state !== 'broken' && !e.dead) {
      e.attack = null;
      this.setState(e, 'broken', 2.0);
      audio.gong(110, 2.5, 0.35);
      this.renderer.flash[e.slot] = 1;
    }
  }

  /** Player blade struck the wooer's sword during his wind-up: the attack is cancelled (chamber). */
  chamber(e: Enemy, point: THREE.Vector3) {
    if (e.state !== 'windup' || !e.attack) return false;
    e.attack = null;
    this.addPosture(e, 20);
    if ((e.state as EState) !== 'broken') this.setState(e, 'recoil', 0.45);
    this.fx.sparks(point, null, 18, '#ffe2a0');
    audio.metal(0.9, 2100);
    return true;
  }

  /** Swept test of the player's blade against wooers' swords (for chambers). */
  testSwords(a: THREE.Vector3, b: THREE.Vector3, radius: number): { e: Enemy; point: THREE.Vector3 } | null {
    for (const e of this.list) {
      if (e.dead || !e.armed || e.state !== 'windup') continue;
      this.renderer.swordSegment(e.pose, e.look, _c1, _c2);
      if (segSegDist2(a, b, _c1, _c2, _v, _v2) < (radius + 0.04) ** 2) return { e, point: _v2.clone() };
    }
    return null;
  }

  // ── archers ─────────────────────────────────────────────────────────────
  private fireArrow(e: Enemy, head: THREE.Vector3) {
    const from = e.pose[P.LArmL].b.clone();
    const speed = 13;
    const aim = _v2.copy(head);
    aim.y -= 0.05;
    const dir = ballisticDir(from, aim, speed, 4) ?? _v.subVectors(aim, from).normalize();
    this.arrows.push({ pos: from, prev: from.clone(), vel: dir.clone().multiplyScalar(speed), alive: true, stuck: 0, fromId: e.id });
    audio.bowRelease(0.6);
  }

  private updateArrows(dt: number, head: THREE.Vector3) {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const ar = this.arrows[i];
      if (!ar.alive) { ar.stuck -= dt; if (ar.stuck <= 0) this.arrows.splice(i, 1); continue; }
      ar.prev.copy(ar.pos);
      ar.vel.y -= 4 * dt;
      ar.pos.addScaledVector(ar.vel, dt);
      if (Math.random() < 0.8) this.fx.trail(ar.pos, '#ff9a4a', 0.035);
      if (this.hooks.parryCheck(ar.prev, ar.pos)) { ar.alive = false; ar.stuck = 0.01; continue; }
      if (segSegDist2(ar.prev, ar.pos, head, head) < 0.27 * 0.27) {
        ar.alive = false; ar.stuck = 0.01;
        if (this.hooks.blocking() || this.hooks.shieldHeld()) { this.hooks.onArrowBlocked(ar.pos); this.hooks.onPlayerHit(8 * 0.2, 'arrow', ar.prev, false); }
        else this.hooks.onPlayerHit(8, 'arrow', ar.prev, false);
        continue;
      }
      if (ar.prev.z < head.z && ar.pos.z >= head.z) audio.arrowWhiz();
      if (ar.pos.y < 0.03 || Math.abs(ar.pos.x) > HALL.halfWidth - 0.05 || ar.pos.z > HALL.zNear - 0.05) {
        ar.alive = false; ar.stuck = 4; ar.pos.y = Math.max(ar.pos.y, 0.03); this.fx.dust(ar.pos, 3);
      }
    }
  }

  catchArrow(p: THREE.Vector3, r: number): EnemyArrow | null {
    for (const ar of this.arrows) if (ar.alive && ar.pos.distanceTo(p) < r) { ar.alive = false; ar.stuck = 0; return ar; }
    return null;
  }

  private updateDown(e: Enemy) {
    if (!e.ragdoll) return;
    readRagdoll(e.ragdoll, e.pose);
    const pel = e.ragdoll.bodies[P.Pelvis];
    if (!pel) return;
    const v = pel.linvel();
    if ((e.stateT > 2.4 && Math.hypot(v.x, v.y, v.z) < 0.6) || e.stateT > 5) {
      const t = pel.translation();
      e.pos.set(clamp(t.x, -2.7, 2.7), 0, clamp(t.z, HALL.zFar + 1, -1.3));
      // keep severed limbs as loose bodies; drop the rest of the ragdoll
      for (let i = 0; i < PART_COUNT; i++) {
        if (e.severed.has(i) || !e.ragdoll.bodies[i]) continue;
        const j = e.ragdoll.joints.get(i);
        if (j) { try { this.world.removeImpulseJoint(j, false); } catch { /* */ } e.ragdoll.joints.delete(i); }
        try { this.world.removeRigidBody(e.ragdoll.bodies[i]!); } catch { /* */ }
        e.ragdoll.bodies[i] = null;
      }
      this.setState(e, 'getup');
    }
  }

  // ── hit testing ─────────────────────────────────────────────────────────
  /** Swept capsule test (+0.05 m inflation) of a weapon segment against every live or knocked-down wooer. */
  testSegment(a: THREE.Vector3, b: THREE.Vector3, radius: number, sweepA?: THREE.Vector3, sweepB?: THREE.Vector3, magnet = 0):
    { enemy: Enemy; part: number; point: THREE.Vector3 } | null {
    let best: { enemy: Enemy; part: number; point: THREE.Vector3 } | null = null;
    let bestD = Infinity;
    for (const e of this.list) {
      if (e.dead || e.state === 'idle' || e.kind === 'hero') continue;
      const c = e.pose[P.Torso].c;
      const mx = (a.x + b.x) / 2 - c.x, mz = (a.z + b.z) / 2 - c.z;
      if (mx * mx + mz * mz > 9) continue;
      for (let i = 0; i < PART_COUNT; i++) {
        if (e.severed.has(i)) continue;
        const p = e.pose[i];
        const r = PART_DIM[i].r * e.look.scale + radius + 0.05 + magnet;
        let d2 = segSegDist2(a, b, p.a, p.b, _c1, _c2);
        if (sweepA && sweepB) {
          const d2s = segSegDist2(sweepA, sweepB, p.a, p.b, _v, _v2);
          if (d2s < d2) { d2 = d2s; _c1.copy(_v); _c2.copy(_v2); }
        }
        if (d2 < r * r) {
          const score = d2 - (i === P.Head ? 0.002 : 0);
          if (score < bestD) { bestD = score; best = { enemy: e, part: i, point: _c2.clone() }; }
        }
      }
    }
    return best;
  }

  private armorAt(e: Enemy, part: number, point: THREE.Vector3): { cls: ArmorClass; neck: boolean } {
    const L = e.look;
    switch (part) {
      case P.Head: {
        // throat/jaw under the cheek guards is a gap; the bell of the helmet is bronze
        const neck = point.y < e.pose[P.Head].c.y - 0.03 * L.scale;
        if (neck) return { cls: 'gap', neck: true };
        return { cls: L.helmet === 'corinthian' ? 'bronze' : L.helmet === 'pilos' ? 'linen' : 'gap', neck: false };
      }
      case P.Torso: {
        if (point.y > e.pose[P.Torso].b.y + 0.06 * L.scale) return { cls: 'gap', neck: true };
        return { cls: L.armor === 'muscle' ? 'bronze' : L.armor === 'linothorax' ? 'linen' : 'gap', neck: false };
      }
      case P.Pelvis: return { cls: L.armor !== 'none' ? 'thigh' : 'gap', neck: false };
      case P.LArmL: case P.LArmR: return { cls: L.bracers ? 'linen' : 'gap', neck: false };
      case P.LLegL: case P.LLegR: return { cls: L.greaves ? 'bronze' : 'gap', neck: false };
      case P.ULegL: case P.ULegR: return { cls: 'thigh', neck: false };
      default: return { cls: 'gap', neck: false };
    }
  }

  private tierOf(speed: number) { return speed < 1.5 ? 0 : speed < 3.5 ? 1 : speed < 7 ? 2 : 3; }

  /** Apply a hit: wooer block → shield → armor glance → flesh (+ dismemberment) → death. */
  damage(e: Enemy, info: HitInfo): HitResult {
    const res: HitResult = { blocked: false, parried: false, glanced: false, killed: false, shieldBroke: false, severed: null, decapitated: false, finisher: false, damage: 0, enemy: e };
    if (e.kind === 'hero') return res;
    if (e.dead) {
      // B&S: corpses can be dismembered too
      if (info.sharp && info.source === 'melee' && info.speed > 4 && e.ragdoll) {
        const sv = SEVER[info.part];
        if (sv !== undefined && !e.severed.has(info.part)) {
          const cut = info.part === P.Torso && this.armorAt(e, info.part, info.point).neck ? P.Head : info.part;
          if (this.sever(e, cut, info)) { res.severed = cut; res.decapitated = cut === P.Head; }
        }
      }
      return res;
    }
    const tier = this.tierOf(info.speed);
    const alive = !e.ragdoll || e.state !== 'down';
    const frontal = info.dir.dot(e.forward) < -0.15;
    const vulnerable = ['windup', 'strike', 'stagger', 'broken', 'recoil', 'maimed', 'down', 'getup'].includes(e.state);
    const broken = e.state === 'broken';

    // 1) active block with sword or shield (melee only)
    if (info.source === 'melee' && alive && frontal && !vulnerable && tier >= 2) {
      const hasShield = e.look.shield !== 'none' && e.shieldHp > 0 && !e.severed.has(P.LArmL);
      const hasSword = e.armed && !e.severed.has(P.LArmR);
      const legSwing = info.part === P.ULegL || info.part === P.ULegR || info.part === P.LLegL || info.part === P.LLegR;
      let chance = hasShield && !legSwing ? 0.55 : hasSword ? (e.kind === 'boss' ? 0.4 : 0.3) : 0;
      if (e.posture > 70) chance *= 0.5;
      e.blockTimes = e.blockTimes.filter((t) => this.t - t < 1);
      if (e.blockTimes.length < 2 && Math.random() < chance) {
        e.blockTimes.push(this.t);
        res.blocked = true; res.parried = true;
        this.addPosture(e, e.kind === 'boss' ? 8 : tier === 3 ? 22 : 14);
        if (e.state !== 'broken') this.setState(e, 'block', 0.3);
        if (hasShield && tier === 3 && info.massKg && info.massKg > 2) this.setState(e, 'stagger', 0.6); // heavy blow staggers through the shield
        this.fx.sparks(info.point, info.dir.clone().negate(), hasShield ? 16 : 22, '#ffe2a0');
        audio.parry();
        this.renderer.flash[e.slot] = 0.3;
        return res;
      }
    }

    // 2) passive shield coverage (thrown, arrows, slow swings)
    if (alive && e.shieldHp > 0 && e.look.shield !== 'none' && !e.severed.has(P.LArmL) && info.source !== 'bomb' && info.zone !== 'head' && frontal && !broken) {
      const sc = _v.copy(e.pose[P.LArmL].c).addScaledVector(e.forward, 0.12 * e.look.scale);
      const off = _v2.subVectors(info.point, sc);
      off.addScaledVector(e.forward, -off.dot(e.forward));
      const rad = (e.kind === 'boss' ? 0.55 : 0.45) * e.look.scale;
      if (off.length() < rad) {
        res.blocked = true;
        e.shieldHp -= (info.amount || this.rawDamage(info)) * (info.sharp ? 0.6 : 1.4);
        this.addPosture(e, 6);
        this.fx.sparks(info.point, info.dir.clone().negate(), 12);
        audio.block();
        if (e.shieldHp <= 0) {
          res.shieldBroke = true;
          this.fx.dust(info.point, 14);
          this.fx.sparks(info.point, null, 24, '#ffcf8a');
          audio.thunk(1.4);
          this.dropShield(e);
        }
        this.renderer.flash[e.slot] = 0.4;
        return res;
      }
    }

    // 3) armor: glance or penetrate
    const arm = this.armorAt(e, info.part, info.point);
    const thrust = !!info.bladeAxis && Math.abs(info.bladeAxis.dot(info.dir)) > 0.8 || info.source === 'arrow';
    combatLog({ kind: 'hit', part: info.part, speed: +info.speed.toFixed(2), cls: arm.cls, neck: arm.neck, thrust, source: info.source, state: e.state });
    let dmg: number;
    if (info.source === 'bomb') dmg = info.amount;
    else if (info.sharp) {
      const need = VPEN[arm.cls][thrust ? 1 : 0] * (arm.cls === 'gap' ? 1 : this.hooks.speedScale());
      if (info.speed < need && !broken) {
        // glance: 20% as blunt, posture, sparks, bounce
        res.glanced = true;
        dmg = this.rawDamage(info) * 0.2;
        this.addPosture(e, tier >= 3 ? 30 : tier === 2 ? 20 : 12);
        this.fx.sparks(info.point, info.dir.clone().negate(), 10, '#ffd28a');
        audio.metal(0.55, 3000);
      } else dmg = this.rawDamage(info);
    } else dmg = this.rawDamage(info) * (1 - BLUNT_ABSORB[arm.cls]);
    if (!res.glanced) dmg *= this.zoneMult(info.part, arm.neck);
    if (broken) dmg *= 3;
    else if (e.state === 'stagger' || e.state === 'recoil') dmg *= 1.5; // riposte window
    if (tier === 0 && info.source === 'melee') {
      // touch: never silent
      audio.metal(0.15, 2400);
      e.flinch = { t: this.t, dir: info.dir.clone(), amount: 0.25 };
      return res;
    }
    // 4) dismemberment (edge cuts through gaps) — B&S rules: slash only, gaps only, speed threshold
    let severPart: number | null = null;
    // edge leading (≥55° off the blade axis), like B&S's slash cone; stabs never sever
    const edgeCut = !info.bladeAxis || Math.abs(info.bladeAxis.dot(info.dir)) < 0.57;
    const cutCapable = info.sharp && !thrust && edgeCut && (info.source === 'melee' || info.source === 'thrown') && !res.glanced;
    if (cutCapable) {
      const target = arm.neck ? P.Head : info.part;
      const need = SEVER[target];
      const headBlocked = info.part === P.Head && !arm.neck; // the bronze bell of the helmet
      const greaved = (target === P.LLegL || target === P.LLegR) && e.look.greaves;
      const armored = arm.cls === 'linen' ? 1.3 : 1;          // leather bracers / linen
      if (need !== undefined && !headBlocked && !greaved && !e.severed.has(target) && info.speed >= need * armored * this.hooks.speedScale()) severPart = target;
    }
    if (broken && info.sharp && (info.part === P.Head || arm.neck)) severPart = P.Head; // finisher: off with his head
    res.damage = dmg;
    e.hp -= dmg;
    e.lastHit.set(-99, this.t);
    this.renderer.flash[e.slot] = Math.min(1, 0.5 + dmg / 60);
    if (!res.glanced) this.fx.hitPuff(info.point, info.dir, dmg);
    if (severPart === P.Head || ((severPart === P.ULegL || severPart === P.ULegR || severPart === P.LLegL || severPart === P.LLegR))) e.hp = Math.min(e.hp, 0);
    if (!res.glanced && tier >= 1) this.addPosture(e, tier === 3 ? 18 : 10);

    if (e.hp <= 0) {
      res.killed = true;
      res.decapitated = severPart === P.Head;
      res.finisher = broken;
      res.severed = severPart;
      this.kill(e, info, { decapitated: res.decapitated, finisher: broken, severed: severPart });
      if (severPart !== null) this.sever(e, severPart, info);
      return res;
    }
    if (severPart !== null) {
      // living wooer loses a limb
      this.sever(e, severPart, info);
      res.severed = severPart;
      if (severPart === P.UArmR || severPart === P.LArmR) {
        // sword arm gone → weapon drops, he sinks and bleeds out
        this.setState(e, 'maimed');
        e.attack = null;
        e.bleedUntil = this.t + 2.6;
        if (e.ring !== null) { this.ringOwner[e.ring] = null; e.ring = null; }
      } else if (severPart === P.UArmL || severPart === P.LArmL) {
        this.addPosture(e, 30);
        if (e.state !== 'broken') this.setState(e, 'stagger', 0.8);
      }
      audio.grunt();
      this.hooks.hitstop(90);
      return res;
    }
    if (!res.glanced) {
      audio.grunt();
      // hit reaction: flinch (light) or directional stagger (solid/heavy)
      e.flinch = { t: this.t, dir: info.dir.clone(), amount: tier >= 2 ? 1 : 0.6 };
      if (tier >= 2 && e.state !== 'broken' && e.state !== 'maimed') {
        if (e.state === 'windup' && this.t > (e.attack?.impactAt ?? 0) - 0.2) { /* super-armor in the last 200 ms of his swing */ }
        else {
          e.attack = null;
          this.setState(e, 'stagger', tier === 3 ? 1.0 : 0.6);
          e.pos.addScaledVector(_v.copy(info.dir).setY(0).normalize(), tier === 3 ? 0.35 : 0.15);
        }
      }
      this.hooks.hitstop(tier === 3 ? 120 : tier === 2 ? 80 : 45);
      if (e.kind !== 'boss' && (info.source === 'bomb' || info.impulse > 220)) this.knockdown(e, info);
    } else this.hooks.hitstop(30);
    return res;
  }

  /** 20·(v/5)^1.2 scaled by weapon mass/class (research brief) */
  private rawDamage(info: HitInfo) {
    if (info.source === 'bomb') return info.amount;
    const v = Math.min(info.source === 'arrow' ? 22 : 26, info.speed);
    const mass = Math.sqrt((info.massKg ?? 1.1) / 1.1);
    const cls = (info.classDamage ?? 1.3) / 1.3;
    return 20 * Math.pow(Math.max(0, v) / 5, 1.2) * mass * cls;
  }
  private zoneMult(part: number, neck: boolean) {
    if (neck) return 2.5;
    if (part === P.Head) return 2;
    if (part === P.Torso || part === P.Pelvis) return 1;
    return 0.6;
  }

  /** Cut `part` (and everything below it) free. Works on living and dead wooers. */
  private sever(e: Enemy, part: number, info: HitInfo): boolean {
    if (e.severed.has(part)) return false;
    const pieces = subtree(part);
    if (!e.ragdoll) e.ragdoll = emptyBodies(e.look.scale);
    const vel = e.vel.clone();
    if (!e.dead) addBodies(this.world, e.ragdoll, e.pose, pieces, vel); // alive: only the limb becomes physical
    severJoint(this.world, e.ragdoll, part);
    for (const p of pieces) e.severed.add(p);
    // fling the piece along the cut
    const body = e.ragdoll.bodies[part];
    if (body) {
      const m = PART_DIM[part].mass;
      const imp = _v.copy(info.dir).multiplyScalar(Math.min(9, info.speed) * m * 0.55);
      imp.y += m * 2.2;
      body.applyImpulse({ x: imp.x, y: imp.y, z: imp.z }, true);
      body.applyTorqueImpulse({ x: rand(-0.3, 0.3) * m, y: rand(-0.3, 0.3) * m, z: rand(-0.3, 0.3) * m }, true);
    }
    // wound caps (stumps) on both sides of the cut
    const parent = PARENT[part];
    const jp = jointPoint(e.pose, part, new THREE.Vector3());
    const toLocal = (idx: number) => jp.clone().sub(e.pose[idx].c).applyQuaternion(_q.copy(e.pose[idx].q).invert());
    e.stumps.push({ part, local: toLocal(part), until: this.t + 1.6 });
    if (parent >= 0) e.stumps.push({ part: parent, local: toLocal(parent), until: this.t + 2.2 });
    this.fx.blood(jp, info.dir, 26);
    audio.thunk(1.1);
    audio.metal(0.3, 700);
    // weapons in a severed hand fall free (can be picked up)
    if (pieces.includes(P.LArmR) && e.armed) {
      e.armed = false;
      const q = new THREE.Quaternion();
      this.renderer.swordSegment(e.pose, e.look, _c1, _c2);
      q.setFromUnitVectors(UP, _v.subVectors(_c2, _c1).normalize());
      this.hooks.onDropWeapon(e.look.prop === 'spear' ? 'spear' : 'sword', _c1.clone(), q, info.dir.clone().multiplyScalar(1.5), e.look);
    }
    if (pieces.includes(P.LArmL) && e.shieldHp > 0 && e.look.shield !== 'none') this.dropShield(e);
    this.hooks.onSever(e, part, !e.dead);
    return true;
  }

  private dropShield(e: Enemy) {
    if (e.look.shield === 'none') return;
    const c = new THREE.Vector3().copy(e.pose[P.LArmL].c).addScaledVector(e.forward, 0.12 * e.look.scale);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, e.forward);
    e.shieldHp = 0;
    this.hooks.onDropWeapon('shield', c, q, e.forward.clone().multiplyScalar(-0.5).setY(0.5), e.look);
  }

  private toRagdoll(e: Enemy, info: HitInfo) {
    if (!e.ragdoll) e.ragdoll = emptyBodies(e.look.scale);
    const parts: number[] = [];
    for (let i = 0; i < PART_COUNT; i++) if (!e.severed.has(i)) parts.push(i);
    addBodies(this.world, e.ragdoll, e.pose, parts, e.vel);
    if (e.ring !== null) { this.ringOwner[e.ring] = null; e.ring = null; }
    const body = e.ragdoll.bodies[info.part] ?? e.ragdoll.bodies[P.Torso];
    const imp = _v.copy(info.dir).multiplyScalar(info.impulse);
    imp.y += info.impulse * 0.25;
    body?.applyImpulse({ x: imp.x, y: imp.y, z: imp.z }, true);
    e.ragdoll.bodies[P.Torso]?.applyImpulse({ x: imp.x * 0.5, y: imp.y * 0.5, z: imp.z * 0.5 }, true);
    return e.ragdoll;
  }

  private knockdown(e: Enemy, info: HitInfo) {
    e.attack = null;
    this.toRagdoll(e, info);
    this.setState(e, 'down');
  }

  private kill(e: Enemy, info: HitInfo, how: { decapitated: boolean; finisher: boolean; severed: number | null }) {
    const pelvisY = e.ragdoll?.bodies[P.Pelvis]?.translation().y ?? 0.95;
    const wasDown = e.state === 'down';
    e.attack = null;
    const rag = this.toRagdoll(e, info);
    e.dead = true;
    e.diedAt = this.t;
    e.state = 'dead';
    (info as HitInfo & { airborne?: boolean }).airborne = wasDown && pelvisY >= 0.8;
    this.hooks.hitstop(info.source === 'bomb' ? 120 : 120);
    this.hooks.shake(how.decapitated ? 0.4 : 0.25);
    audio.thunk(1.3);
    if (e.armed && !e.severed.has(P.LArmR)) {
      // the dead man's sword falls from his hand
      e.armed = false;
      this.renderer.swordSegment(e.pose, e.look, _c1, _c2);
      const q = new THREE.Quaternion().setFromUnitVectors(UP, _v.subVectors(_c2, _c1).normalize());
      this.hooks.onDropWeapon(e.look.prop === 'spear' ? 'spear' : 'sword', _c1.clone(), q, info.dir.clone(), e.look);
    }
    this.hooks.onKill(e, info, rag, how);
  }

  /** Radial Greek-fire blast. Returns wooers killed. */
  explode(center: THREE.Vector3, radius: number, maxDamage: number, weaponEntId: number | null): Enemy[] {
    const killed: Enemy[] = [];
    for (const e of [...this.list]) {
      if (e.dead || e.state === 'idle' || e.kind === 'hero') continue;
      const c = e.pose[P.Torso].c;
      const d = c.distanceTo(center);
      if (d > radius) continue;
      const fall = 1 - d / radius;
      const dir = _v3.subVectors(c, center).normalize();
      dir.y = Math.max(dir.y, 0.35);
      dir.normalize();
      const r = this.damage(e, {
        amount: maxDamage * fall, zone: 'torso', part: P.Torso, point: c.clone(), dir: dir.clone(), speed: 20, sharp: false,
        source: 'bomb', impulse: 380 * fall + 120, weaponEntId,
      });
      if (r.killed) killed.push(e);
      if (!r.killed && e.ragdoll?.bodies[P.Pelvis]) e.ragdoll.bodies[P.Pelvis]!.applyImpulse({ x: dir.x * 60 * fall, y: 220 * fall, z: dir.z * 60 * fall }, true);
    }
    return killed;
  }

  zoneOf(part: number): Zone { return PART_ZONE[part]; }

  chargeAll() {
    for (const e of this.list) {
      if (e.dead || e.state === 'idle' || e.charging || e.kind === 'hero') continue;
      e.charging = true;
      e.speed = Math.max(e.speed, 2.4);
      if (e.kind === 'archer' && !e.armed) { e.armed = true; e.look.prop = 'xiphos'; }
      if (e.state === 'aim' || e.state === 'shoot') this.setState(e, 'approach');
    }
  }

  render() {
    for (const e of this.list) {
      if (e.ragdoll && (e.dead || e.state === 'down')) readRagdoll(e.ragdoll, e.pose);
      this.renderer.write(e.slot, e.pose, e.look, {
        shieldBroken: e.shieldHp <= 0,
        forward: e.dead || e.state === 'down' ? undefined : e.forward,
        propVisible: e.armed && !e.severed.has(P.LArmR),
        stumps: e.stumps,
        broken: e.state === 'broken',
      });
    }
    this.renderer.commit();
  }
}
