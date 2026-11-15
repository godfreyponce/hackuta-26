import * as THREE from 'three';
import { RAPIER } from './physics';
import {
  HumanoidRenderer, P, PART_COUNT, PART_DIM, PART_ZONE, createRagdoll, destroyRagdoll, newAnim, newPose, readRagdoll, solvePose,
  type Anim, type PartPose, type Ragdoll, type SlotLook, type Zone,
} from './humanoid';
import { HALL } from './hall';
import { ballisticDir, clamp, damp, pick, rand, segSegDist2 } from './math';
import type { Fx } from './fx';
import { audio } from './audio';

export type EnemyKind = 'suitor' | 'archer' | 'boss';
type EState = 'idle' | 'approach' | 'wait' | 'windup' | 'strike' | 'recover' | 'aim' | 'shoot' | 'stagger' | 'down' | 'getup' | 'dead';

export interface Enemy {
  id: number;
  kind: EnemyKind;
  slot: number;
  look: SlotLook;
  hp: number;
  maxHp: number;
  shieldHp: number;
  pos: THREE.Vector3;
  yaw: number;
  vel: THREE.Vector3;
  speed: number;
  state: EState;
  stateT: number;
  phase: number;
  anim: Anim;
  pose: PartPose[];
  ragdoll: Ragdoll | null;
  dead: boolean;
  diedAt: number;
  ring: number | null;
  windupHead: THREE.Vector3;
  nextAttackAt: number;
  spot: THREE.Vector3 | null;
  tableIdx?: number;
  lastHit: Map<number, number>;
  spawnT: number;
  name?: string;
  pinned: boolean;
  feastSeed: number;
  forward: THREE.Vector3;
  /** archers/stragglers ordered to charge into melee */
  charging: boolean;
}

export interface HitInfo {
  amount: number;
  zone: Zone;
  part: number;
  point: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  sharp: boolean;
  source: 'melee' | 'thrown' | 'arrow' | 'bomb' | 'fist';
  impulse: number;
  weaponEntId: number | null;
}
export interface HitResult { blocked: boolean; killed: boolean; shieldBroke: boolean; enemy: Enemy }

export interface EnemyArrow { pos: THREE.Vector3; vel: THREE.Vector3; prev: THREE.Vector3; alive: boolean; stuck: number; fromId: number }

export interface EnemyHooks {
  onKill(e: Enemy, info: HitInfo, rag: Ragdoll): void;
  onPlayerHit(dmg: number, source: 'melee' | 'arrow', from: THREE.Vector3): void;
  onDodge(): void;
  onBlock(source: 'melee' | 'arrow', pos: THREE.Vector3): void;
  playerHead(): THREE.Vector3;
  blocking(): boolean;
  shieldHeld(): boolean;
  /** returns true if a held blade parries an arrow at this point */
  parryCheck(p0: THREE.Vector3, p1: THREE.Vector3): boolean;
  hitstop(ms: number): void;
  shake(v: number): void;
  difficultyMult(): number;
}

const TOGAS = ['#D6CCBA', '#7A2622', '#233554', '#A89F8E', '#5C3B2A', '#3E5B50', '#8A6A40', '#6E2B3A'];
const SKINS = ['#b98a68', '#a77656', '#c79a7a', '#8f6448', '#d1a888'];
const RING_ANGLES = [-0.6, 0, 0.6];
const RING_R = 1.35;
const MAX_RAGDOLLS = 12;
const RAGDOLL_TTL = 12;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();

export class EnemyManager {
  readonly renderer: HumanoidRenderer;
  readonly list: Enemy[] = [];
  readonly arrows: EnemyArrow[] = [];
  private freeSlots: number[];
  private nextId = 1;
  private ringOwner: (number | null)[] = [null, null, null];
  melanthius = false;
  t = 0;

  constructor(private world: InstanceType<typeof RAPIER.World>, private fx: Fx, private hooks: EnemyHooks, capacity = 24) {
    this.renderer = new HumanoidRenderer(capacity);
    this.freeSlots = Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
  }

  get alive() { return this.list.filter((e) => !e.dead); }
  get aliveCount() { let n = 0; for (const e of this.list) if (!e.dead) n++; return n; }

  spawn(kind: EnemyKind, at: THREE.Vector3, opts: { idle?: boolean; shield?: boolean } = {}): Enemy | null {
    if (!this.freeSlots.length) this.evictOldestRagdoll();
    const slot = this.freeSlots.pop();
    if (slot === undefined) return null;
    const boss = kind === 'boss';
    const shield = boss ? 'table' : opts.shield || (this.melanthius && kind === 'suitor' && Math.random() < 0.5) ? 'round' : 'none';
    const look: SlotLook = {
      toga: new THREE.Color(boss ? '#4a1a1e' : kind === 'archer' ? '#2c2a26' : pick(TOGAS)),
      trim: new THREE.Color(boss ? '#C49A4A' : pick(TOGAS)),
      skin: new THREE.Color(pick(SKINS)),
      scale: boss ? 1.22 : rand(0.94, 1.04),
      prop: kind === 'archer' ? 'bow' : this.melanthius || boss ? 'spear' : 'knife',
      shield,
      boss,
    };
    const maxHp = boss ? 420 : kind === 'archer' ? 70 : 100;
    const e: Enemy = {
      id: this.nextId++, kind, slot, look, hp: maxHp, maxHp,
      shieldHp: shield === 'table' ? 170 : shield === 'round' ? 60 : 0,
      pos: at.clone(), yaw: Math.PI, vel: new THREE.Vector3(), speed: boss ? 1.05 : kind === 'archer' ? 2.0 : rand(1.9, 2.5),
      state: opts.idle ? 'idle' : 'approach', stateT: 0, phase: Math.random() * 6,
      anim: newAnim(), pose: newPose(), ragdoll: null, dead: false, diedAt: 0, ring: null,
      windupHead: new THREE.Vector3(), nextAttackAt: 0, spot: null, lastHit: new Map(), spawnT: this.t,
      name: boss ? 'Antinous' : undefined, pinned: false, feastSeed: Math.random() * 10, forward: new THREE.Vector3(0, 0, 1), charging: false,
      tableIdx: boss ? 0 : undefined,
    };
    if (kind === 'archer') {
      const side = Math.random() < 0.5 ? -1 : 1;
      e.spot = new THREE.Vector3(side * rand(1.6, 2.5), 0, rand(-19, -11.5));
      if (Math.abs(e.spot.z - HALL.hearth.z) < 2.4) e.spot.x = side * 2.5;
    }
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
    if (e.tableIdx !== undefined) this.renderer.hideTable(e.tableIdx);
    if (e.ring !== null) this.ringOwner[e.ring] = null;
    this.freeSlots.push(e.slot);
  }

  private evictOldestRagdoll() {
    let oldest: Enemy | null = null;
    for (const e of this.list) if (e.dead && (!oldest || e.diedAt < oldest.diedAt)) oldest = e;
    if (oldest) { this.release(oldest); this.list.splice(this.list.indexOf(oldest), 1); }
  }

  /** Enemies within radius of the player (for "pinned" detection). */
  countNear(r: number) {
    let n = 0;
    for (const e of this.list) if (!e.dead && e.state !== 'idle' && Math.hypot(e.pos.x, e.pos.z) < r) n++;
    return n;
  }

  nearestTorso(origin: THREE.Vector3, dir: THREE.Vector3, maxAngle: number, out: THREE.Vector3): Enemy | null {
    let best: Enemy | null = null;
    let bestAng = maxAngle;
    for (const e of this.list) {
      if (e.dead || e.state === 'idle') continue;
      const c = e.ragdoll ? e.pose[P.Torso].c : e.pose[P.Torso].c;
      _v.subVectors(c, origin);
      if (_v.lengthSq() < 0.25) continue;
      const ang = _v.angleTo(dir);
      if (ang < bestAng) { bestAng = ang; best = e; out.copy(c); }
    }
    return best;
  }

  // ── per-step update ────────────────────────────────────────────
  update(dt: number) {
    this.t += dt;
    const head = this.hooks.playerHead();
    let windups = 0;
    for (const e of this.list) if (e.state === 'windup') windups++;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      this.renderer.flash[e.slot] = Math.max(0, this.renderer.flash[e.slot] - dt * 6);
      if (e.dead) {
        // corpses that land on the rack / in the player's face are cleared early so the view stays readable
        const pel = e.ragdoll?.bodies[P.Pelvis].translation();
        const tooClose = !!pel && !e.pinned && Math.hypot(pel.x, pel.z) < 1.8 && this.t - e.diedAt > 3;
        if (this.t - e.diedAt > RAGDOLL_TTL || tooClose) {
          if (tooClose && pel) this.fx.dust(new THREE.Vector3(pel.x, pel.y, pel.z), 10);
          this.release(e);
          this.list.splice(i, 1);
        }
        continue;
      }
      e.stateT += dt;
      if (e.state === 'down') { this.updateDown(e); continue; }
      if (e.state === 'idle') { this.updateIdle(e, dt); continue; }
      this.updateAI(e, dt, head, windups);
      if (e.state === 'windup' && e.stateT < dt * 1.5) windups++;
    }
    // ragdoll budget
    let rags = 0;
    for (const e of this.list) if (e.ragdoll) rags++;
    if (rags > MAX_RAGDOLLS) this.evictOldestRagdoll();
    this.updateArrows(dt, head);
  }

  private updateIdle(e: Enemy, dt: number) {
    // feasting in the menu backdrop: sway, raise the cup now and then
    e.phase += dt;
    const a = e.anim;
    const cup = Math.max(0, Math.sin(e.phase * 0.6 + e.feastSeed)) ;
    a.armR = [cup * 1.9, 0.15, cup * 1.6];
    a.armL = [0.2, 0.18, 0.5];
    a.legL = [0, 0.05]; a.legR = [0, 0.05];
    a.lean = Math.sin(e.phase * 0.5 + e.feastSeed) * 0.06;
    a.headPitch = -cup * 0.3;
    a.twist = Math.sin(e.phase * 0.3 + e.feastSeed) * 0.2;
    a.bob = 0;
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
    if (best >= 0) { e.ring = best; this.ringOwner[best] = e.id; e.nextAttackAt = Math.max(e.nextAttackAt, this.t + 1.4); }
  }

  private updateAI(e: Enemy, dt: number, head: THREE.Vector3, windups: number) {
    const a = e.anim;
    const toPlayer = _v.set(head.x - e.pos.x, 0, head.z - e.pos.z);
    const distPlayer = toPlayer.length();
    let target: THREE.Vector3 | null = null;
    let moving = false;

    if (e.kind === 'archer' && !e.charging) {
      target = e.spot;
    } else {
      if (distPlayer < 10 || e.ring !== null) this.assignRing(e);
      if (e.ring !== null) {
        const ang = RING_ANGLES[e.ring];
        target = _v3.set(Math.sin(ang) * RING_R * (e.kind === 'boss' ? 1.1 : 1), 0, -Math.cos(ang) * RING_R * (e.kind === 'boss' ? 1.1 : 1));
      } else {
        // wait in a loose arc
        const ang = ((e.id * 0.618) % 1) * 2.2 - 1.1;
        target = _v3.set(Math.sin(ang) * 4.6, 0, -Math.cos(ang) * 4.6 - 0.5);
      }
    }

    const busy = e.state === 'windup' || e.state === 'strike' || e.state === 'recover' || e.state === 'aim' || e.state === 'shoot' || e.state === 'stagger' || e.state === 'getup';
    if (!busy && target) {
      // route around the hearth: before passing it, steer to a side lane
      const goal = _v2.copy(target);
      if (e.pos.z < HALL.hearth.z + 2.3 && e.pos.z > HALL.hearth.z - 2.6 && Math.abs(e.pos.x) < 2.15) {
        goal.set(e.pos.x >= 0 ? 2.25 : -2.25, 0, HALL.hearth.z + 2.4);
      } else if (e.pos.z < HALL.hearth.z - 2.6 && target.z > HALL.hearth.z) {
        goal.set(e.pos.x >= 0 ? 2.25 : -2.25, 0, HALL.hearth.z - 1.0);
      }
      const d = _c1.subVectors(goal, e.pos).setY(0);
      const dist = d.length();
      if (dist > 0.12) {
        d.multiplyScalar(1 / dist);
        // separation
        for (const o of this.list) {
          if (o === e || o.dead || o.state === 'idle') continue;
          const sx = e.pos.x - o.pos.x, sz = e.pos.z - o.pos.z;
          const sd = Math.hypot(sx, sz);
          if (sd < 0.85 && sd > 1e-3) { d.x += (sx / sd) * (0.85 - sd) * 2.2; d.z += (sz / sd) * (0.85 - sd) * 2.2; }
        }
        // columns
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
      } else {
        e.vel.x = damp(e.vel.x, 0, 8, dt);
        e.vel.z = damp(e.vel.z, 0, 8, dt);
      }
    } else {
      e.vel.x = damp(e.vel.x, 0, 10, dt);
      e.vel.z = damp(e.vel.z, 0, 10, dt);
    }
    e.pos.addScaledVector(e.vel, dt);
    e.pos.x = clamp(e.pos.x, -2.75, 2.75);
    e.pos.z = clamp(e.pos.z, HALL.zFar + 0.8, -1.25);
    if (Math.hypot(e.pos.x, e.pos.z) < 1.35) { const k = 1.35 / Math.hypot(e.pos.x, e.pos.z); e.pos.x *= k; e.pos.z *= k; }

    // facing: toward velocity while walking far, toward the player when close/attacking
    const speed = Math.hypot(e.vel.x, e.vel.z);
    const faceYaw = (moving && speed > 0.5 && distPlayer > 3.2 && e.kind !== 'archer')
      ? Math.atan2(e.vel.x, e.vel.z)
      : Math.atan2(toPlayer.x, toPlayer.z);
    let dy = faceYaw - e.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    e.yaw += dy * (1 - Math.exp(-8 * dt));
    e.forward.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));

    // walk cycle
    e.phase += speed * dt * 4.0;
    const sw = Math.sin(e.phase) * Math.min(1, speed / 1.5);
    a.legL = [sw * 0.55, Math.max(0, -Math.cos(e.phase)) * 0.7 * Math.min(1, speed) + 0.06];
    a.legR = [-sw * 0.55, Math.max(0, Math.cos(e.phase)) * 0.7 * Math.min(1, speed) + 0.06];
    a.bob = Math.abs(Math.sin(e.phase)) * 0.035 * Math.min(1, speed);
    a.lean = 0.08 * Math.min(1, speed / 2);
    a.twist = 0;
    a.headPitch = 0;
    a.armL = [-sw * 0.4, 0.12, 0.3];
    a.armR = [sw * 0.4, 0.12, 0.3];
    if (e.look.shield !== 'none') a.armL = [1.15, 0.05, 1.3];

    const atRing = e.ring !== null && target && Math.hypot(e.pos.x - target.x, e.pos.z - target.z) < 0.4;
    const diff = this.hooks.difficultyMult();

    switch (e.state) {
      case 'approach':
      case 'wait':
        if (e.kind === 'archer' && !e.charging) {
          if (target && Math.hypot(e.pos.x - target.x, e.pos.z - target.z) < 0.5 && this.t > e.nextAttackAt) this.setState(e, 'aim');
        } else if (atRing && this.t > e.nextAttackAt && windups < 2) {
          this.setState(e, 'windup');
          e.windupHead.copy(head);
          windups++;
        }
        break;
      case 'windup': {
        const T = e.kind === 'boss' ? 1.0 : 0.75;
        const k = Math.min(1, e.stateT / T);
        a.armR = [2.7 * k, 0.25 * k, 0.4 + 0.4 * k];
        a.twist = -0.35 * k;
        a.lean = -0.08 * k;
        if (e.stateT > T * 0.55 && e.stateT - dt <= T * 0.55) {
          // telegraph glint on the weapon
          this.fx.sparks(e.pose[P.LArmR].b, null, 6, '#fff4d0');
          audio.metal(0.25, 2600);
        }
        if (e.stateT >= T) this.setState(e, 'strike');
        break;
      }
      case 'strike': {
        const k = Math.min(1, e.stateT / 0.12);
        a.armR = [2.7 - 2.4 * k, 0.25, 0.8 - 0.6 * k];
        a.twist = -0.35 + 0.7 * k;
        a.lean = 0.2 * k;
        if (e.stateT >= 0.12) {
          this.resolveMelee(e, head);
          this.setState(e, 'recover');
        }
        break;
      }
      case 'recover': {
        a.armR = [0.3, 0.2, 0.4];
        a.twist = 0.35 * (1 - e.stateT / 0.5);
        if (e.stateT > 0.5) {
          e.nextAttackAt = this.t + rand(1.9, 3.2) / diff;
          this.setState(e, 'wait');
        }
        break;
      }
      case 'aim': {
        // visible draw ≥ 700 ms before release
        const k = Math.min(1, e.stateT / 1.15);
        a.armL = [1.55, 0.05, 0.05];
        a.armR = [1.45, -0.35, 1.6 + 0.8 * k];
        a.twist = 0.45;
        a.legL = [0.15, 0.1]; a.legR = [-0.2, 0.15];
        if (e.stateT > 0.75 && e.stateT - dt <= 0.75) this.fx.sparks(e.pose[P.LArmL].b, null, 5, '#ffe6b0');
        if (e.stateT >= 1.15) { this.fireArrow(e, head); this.setState(e, 'shoot'); }
        break;
      }
      case 'shoot':
        a.armL = [1.55, 0.05, 0.05];
        a.armR = [1.2, -0.5, 0.6];
        if (e.stateT > 0.5) {
          e.nextAttackAt = this.t + rand(2.6, 3.8) / diff;
          // reposition sometimes
          if (Math.random() < 0.4 && e.spot) e.spot.set(-e.spot.x, 0, clamp(e.spot.z + rand(-2, 2), -19, -10.5));
          this.setState(e, 'approach');
        }
        break;
      case 'stagger':
        a.lean = -0.35 * (1 - e.stateT / 0.45);
        a.armL = [0.8, 0.6, 0.4]; a.armR = [0.8, 0.6, 0.4];
        if (e.stateT > 0.45) this.setState(e, 'approach');
        break;
      case 'getup':
        a.lean = 0.5 * (1 - e.stateT / 0.6);
        if (e.stateT > 0.6) this.setState(e, 'approach');
        break;
      default: break;
    }
    solvePose(e.pose, e.pos, e.yaw, e.look.scale, a);
  }

  private setState(e: Enemy, s: EState) { e.state = s; e.stateT = 0; }

  private resolveMelee(e: Enemy, head: THREE.Vector3) {
    const reach = Math.hypot(head.x - e.pos.x, head.z - e.pos.z) < 2.4;
    if (!reach) return;
    const moved = head.distanceTo(e.windupHead);
    if (moved > 0.36) { this.hooks.onDodge(); audio.whoosh(4); return; }
    const base = e.kind === 'boss' ? 25 : 12;
    if (this.hooks.blocking() || this.hooks.shieldHeld()) {
      this.hooks.onBlock('melee', _v.copy(head).lerp(e.pose[P.LArmR].b, 0.5));
      this.hooks.onPlayerHit(base * 0.2, 'melee', e.pos);
    } else {
      this.hooks.onPlayerHit(base, 'melee', e.pos);
    }
  }

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
      if (!ar.alive) {
        ar.stuck -= dt;
        if (ar.stuck <= 0) this.arrows.splice(i, 1);
        continue;
      }
      ar.prev.copy(ar.pos);
      ar.vel.y -= 4 * dt;
      ar.pos.addScaledVector(ar.vel, dt);
      if (Math.random() < 0.8) this.fx.trail(ar.pos, '#ff9a4a', 0.035);
      // player hit (head sphere r=0.24)
      const d2 = segSegDist2(ar.prev, ar.pos, head, head);
      if (this.hooks.parryCheck(ar.prev, ar.pos)) {
        ar.alive = false; ar.stuck = 0.01;
        continue;
      }
      if (d2 < 0.27 * 0.27) {
        ar.alive = false; ar.stuck = 0.01;
        if (this.hooks.blocking() || this.hooks.shieldHeld()) {
          this.hooks.onBlock('arrow', ar.pos);
          this.hooks.onPlayerHit(8 * 0.2, 'arrow', ar.prev);
        } else this.hooks.onPlayerHit(8, 'arrow', ar.prev);
        continue;
      }
      // passed the player → whiz
      if (ar.prev.z < head.z && ar.pos.z >= head.z) audio.arrowWhiz();
      if (ar.pos.y < 0.03 || Math.abs(ar.pos.x) > HALL.halfWidth - 0.05 || ar.pos.z > HALL.zNear - 0.05) {
        ar.alive = false; ar.stuck = 4;
        ar.pos.y = Math.max(ar.pos.y, 0.03);
        this.fx.dust(ar.pos, 3);
      }
    }
  }

  /** Remove the nearest live enemy arrow within r of p (return-to-sender catch). */
  catchArrow(p: THREE.Vector3, r: number): EnemyArrow | null {
    for (const ar of this.arrows) {
      if (ar.alive && ar.pos.distanceTo(p) < r) { ar.alive = false; ar.stuck = 0; return ar; }
    }
    return null;
  }

  private updateDown(e: Enemy) {
    if (!e.ragdoll) return;
    readRagdoll(e.ragdoll, e.pose);
    const pel = e.ragdoll.bodies[P.Pelvis];
    const v = pel.linvel();
    if ((e.stateT > 2.4 && Math.hypot(v.x, v.y, v.z) < 0.6) || e.stateT > 5) {
      // stand back up where the pelvis landed
      const t = pel.translation();
      e.pos.set(clamp(t.x, -2.7, 2.7), 0, clamp(t.z, HALL.zFar + 1, -1.3));
      destroyRagdoll(this.world, e.ragdoll);
      e.ragdoll = null;
      this.setState(e, 'getup');
    }
  }

  // ── hit testing ────────────────────────────────────────────────
  /**
   * Swept capsule test of a weapon segment against every live (or knocked-down) wooer.
   * Returns the closest hit (head preferred on ties).
   */
  testSegment(a: THREE.Vector3, b: THREE.Vector3, radius: number, sweepA?: THREE.Vector3, sweepB?: THREE.Vector3):
    { enemy: Enemy; part: number; point: THREE.Vector3 } | null {
    let best: { enemy: Enemy; part: number; point: THREE.Vector3 } | null = null;
    let bestD = Infinity;
    for (const e of this.list) {
      if (e.dead || e.state === 'idle') continue;
      // broadphase
      const c = e.pose[P.Torso].c;
      const mx = (a.x + b.x) / 2 - c.x, mz = (a.z + b.z) / 2 - c.z;
      if (mx * mx + mz * mz > 9) continue;
      for (let i = 0; i < PART_COUNT; i++) {
        const p = e.pose[i];
        const r = PART_DIM[i].r * e.look.scale + radius;
        let d2 = segSegDist2(a, b, p.a, p.b, _c1, _c2);
        if (sweepA && sweepB) {
          const d2s = segSegDist2(sweepA, sweepB, p.a, p.b, _v, _v2);
          if (d2s < d2) { d2 = d2s; _c1.copy(_v); _c2.copy(_v2); }
        }
        if (d2 < r * r) {
          const score = d2 - (i === P.Head ? 0.002 : 0);
          if (score < bestD) {
            bestD = score;
            best = { enemy: e, part: i, point: _c2.clone() };
          }
        }
      }
    }
    return best;
  }

  /** Apply a hit. Handles shields, instakills, knockdowns and death → ragdoll. */
  damage(e: Enemy, info: HitInfo): HitResult {
    const res: HitResult = { blocked: false, killed: false, shieldBroke: false, enemy: e };
    if (e.dead) return res;
    // shields block frontal hits (bombs ignore them)
    if (!e.ragdoll && e.shieldHp > 0 && info.source !== 'bomb' && info.zone !== 'head') {
      const frontal = info.dir.dot(e.forward) < -0.15;
      if (frontal) {
        let covered = false;
        if (e.look.shield === 'round') {
          const sc = _v.copy(e.pose[P.LArmL].c).addScaledVector(e.forward, 0.1 * e.look.scale);
          const off = _v2.subVectors(info.point, sc);
          off.addScaledVector(e.forward, -off.dot(e.forward));
          covered = off.length() < 0.46 * e.look.scale;
        } else if (e.look.shield === 'table') {
          const tc = e.pose[P.Torso].c;
          const right = _v.set(e.forward.z, 0, -e.forward.x);
          const lat = Math.abs(_v2.subVectors(info.point, tc).dot(right));
          covered = lat < 0.6 * e.look.scale && info.point.y < tc.y + 0.42 * e.look.scale && info.point.y > tc.y - 0.75 * e.look.scale;
        }
        if (covered) {
          res.blocked = true;
          e.shieldHp -= info.amount * (info.sharp ? 0.6 : 1.4);
          this.fx.sparks(info.point, info.dir.clone().negate(), 12);
          audio.block();
          if (e.shieldHp <= 0) {
            res.shieldBroke = true;
            this.fx.dust(info.point, 14);
            this.fx.sparks(info.point, null, 24, '#ffcf8a');
            audio.thunk(1.4);
          }
          this.renderer.flash[e.slot] = 0.4;
          return res;
        }
      }
    }
    let amount = info.amount;
    if (info.sharp && info.zone === 'head' && info.speed > 6) amount = 9999; // instant kill
    if (e.kind === 'boss' && info.source !== 'bomb' && amount < 9999) amount *= 0.85;
    e.hp -= amount;
    this.renderer.flash[e.slot] = 1;
    this.fx.hitPuff(info.point, info.dir);
    if (e.hp <= 0) {
      res.killed = true;
      this.kill(e, info);
      return res;
    }
    audio.grunt();
    if (amount >= 20) this.hooks.hitstop(info.source === 'bomb' ? 90 : amount > 45 ? 70 : 45);
    // big non-lethal hit → knockdown (airborne trickshots) or stagger
    if (e.kind !== 'boss' && (info.source === 'bomb' || info.impulse > 160)) this.knockdown(e, info);
    else if (e.state !== 'down') {
      this.setState(e, 'stagger');
      e.pos.addScaledVector(_v.copy(info.dir).setY(0).normalize(), 0.22);
    }
    return res;
  }

  private toRagdoll(e: Enemy, info: HitInfo) {
    if (!e.ragdoll) {
      const rag = createRagdoll(this.world, e.pose, e.look.scale, e.vel);
      e.ragdoll = rag;
      if (e.ring !== null) { this.ringOwner[e.ring] = null; e.ring = null; }
    }
    const body = e.ragdoll.bodies[info.part] ?? e.ragdoll.bodies[P.Torso];
    const imp = _v.copy(info.dir).multiplyScalar(info.impulse);
    imp.y += info.impulse * 0.25;
    body.applyImpulse({ x: imp.x, y: imp.y, z: imp.z }, true);
    const tor = e.ragdoll.bodies[P.Torso];
    tor.applyImpulse({ x: imp.x * 0.5, y: imp.y * 0.5, z: imp.z * 0.5 }, true);
    return e.ragdoll;
  }

  private knockdown(e: Enemy, info: HitInfo) {
    this.toRagdoll(e, info);
    this.setState(e, 'down');
  }

  private kill(e: Enemy, info: HitInfo) {
    const pelvisY = e.ragdoll ? e.ragdoll.bodies[P.Pelvis].translation().y : 0.95;
    const wasDown = e.state === 'down';
    const rag = this.toRagdoll(e, info);
    e.dead = true;
    e.diedAt = this.t;
    e.state = 'dead';
    (info as HitInfo & { airborne?: boolean }).airborne = wasDown && pelvisY >= 0.8;
    this.hooks.hitstop(info.source === 'bomb' ? 120 : 150);
    this.hooks.shake(0.25);
    audio.thunk(1.3);
    this.hooks.onKill(e, info, rag);
  }

  /** Radial Greek-fire blast. Returns enemies killed. */
  explode(center: THREE.Vector3, radius: number, maxDamage: number, weaponEntId: number | null): Enemy[] {
    const killed: Enemy[] = [];
    for (const e of [...this.list]) {
      if (e.dead || e.state === 'idle') continue;
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
      if (!r.killed && e.ragdoll) e.ragdoll.bodies[P.Pelvis].applyImpulse({ x: dir.x * 60 * fall, y: 220 * fall, z: dir.z * 60 * fall }, true);
    }
    return killed;
  }

  zoneOf(part: number): Zone { return PART_ZONE[part]; }

  /** The last wooers stop hanging back and charge the threshold. */
  chargeAll() {
    for (const e of this.list) {
      if (e.dead || e.state === 'idle' || e.charging) continue;
      e.charging = true;
      e.speed = Math.max(e.speed, 2.4);
      if (e.state === 'aim' || e.state === 'shoot') this.setState(e, 'approach');
    }
  }

  render() {
    for (const e of this.list) {
      if (e.ragdoll) readRagdoll(e.ragdoll, e.pose);
      this.renderer.write(e.slot, e.pose, e.look, {
        shieldBroken: e.shieldHp <= 0,
        tableIdx: e.tableIdx,
        forward: e.ragdoll ? undefined : e.forward,
        propVisible: !e.ragdoll,
      });
    }
    this.renderer.commit();
  }
}
