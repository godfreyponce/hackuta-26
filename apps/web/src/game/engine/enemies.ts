// Armored wooers: steering, directional attacks with telegraphs, deflection outcomes, posture,
// zone armor (glance vs. penetrate), Blade & Sorcery–style dismemberment, ragdolls, archers.
// Numbers follow the research briefs (see apps/web/DESIGN.md → Combat).
import * as THREE from 'three';
import { RAPIER } from './physics';
import {
  P, PART_COUNT, PART_DIM, PART_ZONE, PARENT, RIG, addBodies, destroyRagdoll, emptyBodies, jointPoint, newAnim, newPose,
  readRagdoll, severJoint, solvePose, subtree, type Anim, type PartPose, type Ragdoll, type Zone,
} from './humanoid';
import { ArmoredRenderer, type SlotLook, type ShieldKind } from './armoredRenderer';
import { lookFor } from './panoply';
import { SkinnedBody, type BodyTemplate } from './skinnedBody';
import { HALL } from './hall';
import { ballisticDir, clamp, damp, pick, rand, segSegDist2 } from './math';
import type { Fx } from './fx';
import { audio, voiceFor, type VoiceProfile } from './audio';
import { WoundDecals, type Wound } from './wounds';
import { PlayerHabits, type GuardZone } from './tactics';
import { newGait, resetGait, stepGait, STANCE_GUARD, STANCE_LUNGE, STANCE_WALK, type GaitState, type Stance } from './gait';

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
  | 'aim' | 'shoot' | 'down' | 'getup' | 'maimed' | 'impaled' | 'dead';

/** where a point went in: decides how long a man lives with it */
export type Vital = 'throat' | 'face' | 'heart' | 'chest' | 'gut' | 'limb';
/** a living man with a blade in him (set by the stab system, read by his AI) */
export interface Impale {
  weaponId: number;
  part: number;
  vital: Vital;
  t0: number;
  /** sim time he dies on the blade (Infinity = not a mortal wound yet) */
  dieAt: number;
  /** sim time his sword falls from his hand */
  dropAt: number;
  /** sim time he wrenches himself off a shallow wound (Antinous: almost at once) */
  freeAt: number;
  wantFree: boolean;
  through: boolean;
  depth: number;
  nextGroanT: number;
  /** can this wound kill him (Antinous: only once he's broken or spent) */
  mortal: boolean;
}

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
  /** ripostes and chained blows are never feinted; a feint happens at most once */
  noFeint?: boolean;
  feinted?: boolean;
  /** a shield bash (dir 'thrust', shown as dodge-only ✕): it breaks a raised guard instead of being stopped by it */
  bash?: boolean;
}

export interface Stump { part: number; local: THREE.Vector3; until: number; /** arterial jet strength (severed neck) */ jet?: number }

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
  /** archer: volleys loosed (after 3, or when no one else is pressing you, he draws a blade and closes) */
  volleys: number;
  blockTimes: number[];
  flinch: { t: number; dir: THREE.Vector3; amount: number };
  bleedUntil: number;
  /** last stagger (anti stun-lock) */
  staggerT: number;
  /** when he took his ring slot (flank waiters move to a free inner slot after 1.2 s) */
  ringT: number;
  /** a hard clash beat his guard aside until — counts as an opening */
  guardBeatenUntil: number;
  staggerCause: '' | 'throat';
  neckWoundFrom: number;
  /** guard zone he's holding against your blade (reads where it's heading) */
  guard: { zone: GuardZone; setAt: number; nextReactAt: number };
  guardPose: [number, number, number];
  riposteDir: AttackDir | null;
  lastCounterT: number;
  postureWinT: number;
  postureWinSum: number;
  chainLeft: number;
  chainAt: number;
  chainDir: AttackDir | null;
  lastFeintT: number;
  bossPhase: number;
  bossBrokeInPhase: number;
  /** throat cut: bleeding (5 hp/s) until, and the neck gives way more easily until */
  throatBleedUntil: number;
  neckWoundUntil: number;
  /** severed limbs of the realistic body, following their gib bodies */
  gibs: { part: number; mesh: THREE.Object3D }[];
  /** his voice (pitch, tract length, rasp) — every wooer sounds like himself */
  voice: VoiceProfile;
  lastVocalT: number;
  /** stab holes and gashes on his body (decals riding the bones) */
  wounds: Wound[];
  /** run through and still standing */
  impale: Impale | null;
  /** blades lodged in him (alive or dead): his body isn't tidied away while a blade is in it */
  lodged: number;
  /** vertical offset the blade holds him at (m, + = lifted) */
  impaleLift: number;
  /** a pulled-out stab bleeds (hp/s) until */
  woundBleedUntil: number;
  woundBleedRate: number;
  // ── footwork ──
  /** drift along his arc (rad off his ring slot) and how far he stands off (m, ± the waiting distance) */
  orbit: number;
  orbitGoal: number;
  range: number;
  rangeGoal: number;
  /** next footwork decision */
  footT: number;
  gait: GaitState;
  /** the stance his feet are settling into (blended between walk / guard / lunge) */
  stance: Stance;
  /** a quick step out of your swing: velocity until, and when he may do it again */
  evadeVel: THREE.Vector3;
  evadeUntil: number;
  evadeCd: number;
  /** driven back by a blow (m/s, decays) */
  knock: THREE.Vector3;
  /** hurt: he gives ground until */
  backoffUntil: number;
  /** last time he pressed a man whose guard was down */
  pressT: number;
  // ── the aspis ──
  /** his shield arm (FK angles, eased toward the zone he covers) */
  shieldPose: [number, number, number, number];
  /** a hard blow knocked his shield out wide until (no cover, an opening) */
  shieldAsideUntil: number;
  /** next shield bash allowed */
  bashCd: number;
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
  /** visible blade at contact (guard end → point), world — for the strict neck/joint geometry */
  bladeA?: THREE.Vector3;
  bladeB?: THREE.Vector3;
  /** the same blade one physics step earlier: the neck test sweeps between the two */
  bladePrevA?: THREE.Vector3;
  bladePrevB?: THREE.Vector3;
  /** the edge crossed the neck itself (not the helmet bell) — see neckCross() */
  neck?: boolean;
  /** where along the edge it touched: 0 at the guard end of the blade … 1 at the point */
  contactFrac?: number;
  /** speed of the blade at the contact point this frame (m/s) — what B&S cuts with, not the tip's peak */
  contactSpeed?: number;
  /** stroke commitment: tip travel (m) over the last 120 ms and its heading change (deg) */
  strokeLen?: number;
  strokeTurn?: number;
  /** a blade you aren't driving (guard / parked / bouncing): it touches, it never severs */
  noCut?: boolean;
  /** a second contact on the same man within one swing's wound window: the edge drags, it doesn't wound again */
  graze?: boolean;
  /** a neck crossing inside that window: it can still take the head, but a miss is only a graze (no new gash) */
  neckRepeat?: boolean;
  /** a held point driven along its blade into him (the stab system lodges it if it gets through): no knock-back,
   *  the stab sound and his scream instead of a cut and a grunt */
  stab?: boolean;
}

export type HitKind = 'flesh' | 'glance' | 'blocked' | 'shield' | 'kill';
export type ArmorClass = 'bronze' | 'linen' | 'thigh' | 'gap';
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
  /** a thrust along the blade that got through his armour (the stab system may lodge it) */
  penetrated?: boolean;
  /** what the point went through */
  armor?: ArmorClass;
  neck?: boolean;
}

export interface EnemyArrow { pos: THREE.Vector3; vel: THREE.Vector3; prev: THREE.Vector3; alive: boolean; stuck: number; fromId: number }

export interface KillHow { decapitated: boolean; finisher: boolean; severed: number | null; impaled?: Vital | 'through' }

export interface EnemyHooks {
  /** current wave (1..3) — sets attack turns and archetype skill */
  wave(): number;
  /** a shield bash arrived (not dodged): `guarded` = into a raised guard/aspis, which it breaks */
  onBash?(e: Enemy, guarded: boolean): void;
  /** a wooer showed something new he does (the HUD explains it once): read your cuts, his shield turned you,
   *  his shield was knocked aside */
  onTactic?(e: Enemy, kind: 'read' | 'shield' | 'shieldAside' | 'shieldBroke'): void;
  /** you are drawing the bow: men with shields raise them as they come */
  playerAiming?(): boolean;
  /** the player's view yaw (rad, + = turned left) — wooers only strike from where he can see them */
  playerYaw?(): number;
  /** the player's held blades: point and its velocity (world) — what the wooers' guards read */
  playerBlades(): { tip: THREE.Vector3; vel: THREE.Vector3; base?: THREE.Vector3 }[];
  /** centre of the aspis on your arm, if you carry one */
  playerShield?(): THREE.Vector3 | null;
  /** Antinous changes phase (2: shield dropped + calls suitors, 3: desperate) */
  onBossPhase(e: Enemy, phase: number): void;
  onKill(e: Enemy, info: HitInfo, rag: Ragdoll, how: KillHow): void;
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

// five slots around Odysseus; the outer two sit at his flanks (edge of view — chevrons + panned audio)
const RING_ANGLES = [-1.0, -0.5, 0, 0.5, 1.0];
// keyboard/mouse: you turn only by holding the cursor at the edge, so every slot sits inside the ~51° half-view
const RING_ANGLES_KB = [-0.72, -0.36, 0, 0.36, 0.72];
const RING_R = 1.35;
// footwork: how far a waiting man drifts along his arc (rad) and how much he varies his distance (m)
const ORBIT_MAX = 0.24;
// the aspis on his left forearm (FK: fwd swing, abduction, elbow, roll) — covering a zone, carried, knocked wide, bashing
type ArmPose = [number, number, number, number];
const SHIELD_POSE: Record<'ready' | 'high' | 'left' | 'right' | 'low' | 'carry' | 'aside' | 'strike' | 'bashBack' | 'bashOut', ArmPose> = {
  // (heights at scale 1: the centre of the disc; its rim reaches ~0.43 m above — he looks at you over it, and the
  // shield never fills your view when he steps in)
  ready: [0.9, 0.2, 1.7, -1.4],     // before his chest (1.36 m)
  high: [1.25, 0.1, 1.6, -1.1],     // up under his eyes: covers throat and face (1.49 m), and against arrows
  left: [0.85, 0.3, 1.3, 0.3],      // out over his left flank
  right: [0.95, 0.25, 1.9, -1.5],   // drawn across his body to his sword side
  low: [0.35, 0.25, 1.5, -1.3],     // dropped over belly and thighs (1.23 m)
  carry: [0.5, 0.15, 1.0, -0.5],    // walking in from afar
  aside: [0.3, 1.3, 0.5, 0],        // beaten out wide: open
  strike: [0.75, 0.6, 1.0, 0],      // swung out for balance as he commits his blow: open
  bashBack: [0.6, 0.3, 2.0, -1.2],  // drawn in to the chest…
  bashOut: [1.4, 0.05, 0.7, -0.6],  // …and driven out
};
const MAX_RAGDOLLS = 12;
const RAGDOLL_TTL = 14;

// Armor penetration (m/s): cut / thrust — research brief §5
// B&S Update 11: armour cancels slashing — bronze turns all but the hardest cuts (and those do half); thrust gaps
const VPEN: Record<ArmorClass, [number, number]> = { bronze: [14, 7], linen: [7, 4], thigh: [4, 2.5], gap: [1.5, 1.5] };
const BLUNT_ABSORB: Record<ArmorClass, number> = { bronze: 0.45, linen: 0.3, thigh: 0.15, gap: 0 };
// Sever speed (m/s, webcam; × speedScale on mouse) AT THE CONTACT POINT for a committed edge cut across the
// joint. Blade & Sorcery made dismemberment "trickier to encourage skill-based dismembers": perpendicular, hard
// cuts at the neck / shoulder / elbow / knee, ideally after staggering him. Head = the NECK only.
const NECK_V = 10.5;
const SEVER: Partial<Record<number, number>> = {
  [P.Head]: NECK_V, [P.UArmL]: 10.5, [P.UArmR]: 10.5, [P.LArmL]: 9.0, [P.LArmR]: 9.0,
  [P.ULegL]: 14.0, [P.ULegR]: 14.0, [P.LLegL]: 11.0, [P.LLegR]: 11.0,
};
const NECK_R = 0.06;      // neck radius at scale 1
const BLADE_HALF = 0.05;  // xiphos half-width + a hair (the test is on the blade's centre line)
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _n3 = new THREE.Vector3();
const _n4 = new THREE.Vector3();
const _sw1 = new THREE.Vector3();
const _sw2 = new THREE.Vector3();
const _a1 = new THREE.Vector3();
const _a2 = new THREE.Vector3();
const _a3 = new THREE.Vector3();
const _aq = new THREE.Quaternion();

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _c3 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _s4 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

type World = InstanceType<typeof RAPIER.World>;

export class EnemyManager {
  readonly renderer: ArmoredRenderer;
  readonly list: Enemy[] = [];
  /** what they've learned about the way you fight (shared: they talk) */
  readonly habits = new PlayerHabits();
  readonly arrows: EnemyArrow[] = [];
  private freeSlots: number[];
  private nextId = 1;
  private ringOwner: (number | null)[] = [null, null, null, null, null];
  private lastImpactAt = -99;
  melanthius = false;
  t = 0;
  private bodyTpl: BodyTemplate | null = null;
  private bodies: (SkinnedBody | null)[] = [];
  private headTmp = new THREE.Vector3();

  /** Realistic skinned bodies (Rocketbox). Without a template the capsule mannequins are used. */
  setBodyTemplate(tpl: BodyTemplate | null) { this.bodyTpl = tpl; }
  private bodyFor(slot: number): SkinnedBody | null {
    if (!this.bodyTpl) return null;
    let b = this.bodies[slot];
    if (!b) { b = new SkinnedBody(this.bodyTpl); this.bodies[slot] = b; this.renderer.group.add(b.root); }
    return b;
  }

  /** stab holes and gashes riding on the bodies */
  readonly woundDecals = new WoundDecals();

  constructor(private world: World, private fx: Fx, private hooks: EnemyHooks, capacity = 24) {
    this.renderer = new ArmoredRenderer(capacity);
    this.renderer.group.add(this.woundDecals.group);
    this.freeSlots = Array.from({ length: capacity }, (_, i) => capacity - 1 - i);
  }

  get alive() { return this.list.filter((e) => !e.dead && e.kind !== 'hero'); }
  get aliveCount() { let n = 0; for (const e of this.list) if (!e.dead && e.kind !== 'hero') n++; return n; }

  spawn(kind: EnemyKind, at: THREE.Vector3, opts: { idle?: boolean; shield?: boolean } = {}): Enemy | null {
    if (!this.freeSlots.length) this.evictOldestRagdoll();
    const slot = this.freeSlots.pop();
    if (slot === undefined) return null;
    const boss = kind === 'boss';
    // who carries the aspis is the director's call per wave; otherwise (men he summons) Melanthius's storeroom decides
    const shield: ShieldKind = boss || kind === 'hero' ? 'round'
      : kind === 'suitor' && (opts.shield ?? (this.melanthius && Math.random() < 0.55)) ? 'round' : 'none';
    const look: SlotLook = lookFor(kind, this.melanthius, shield);
    // later waves are harder men (hoplites, then the hard core round Antinous): they take longer to cut down
    const wi = Math.max(0, Math.min(2, this.hooks.wave() - 1));
    const waveHp = [1, 1.25, 1.45][wi];
    const maxHp = boss ? 360 : Math.round((kind === 'archer' ? 70 : 100) * waveHp);
    // a reveler's aspis is the feast-hall's old wicker-and-hide; the storeroom shields are bronze-faced
    const shieldHp = boss ? 150 : shield === 'round' ? [55, 70, 80][wi] : 0;
    const e: Enemy = {
      id: this.nextId++, kind, slot, look, hp: maxHp, maxHp,
      shieldHp, posture: 0, postureT: -9,
      pos: at.clone(), yaw: Math.PI, vel: new THREE.Vector3(), speed: boss ? 1.25 : kind === 'archer' ? 2.0 : rand(1.9, 2.5),
      state: opts.idle ? 'idle' : 'approach', stateT: 0, stateDur: 0, phase: Math.random() * 6,
      anim: newAnim(), pose: newPose(), ragdoll: null, severed: new Set(), stumps: [], armed: look.prop !== 'none',
      dead: false, diedAt: 0, ring: null, attack: null, nextAttackAt: 0, spot: null, lastHit: new Map(), spawnT: this.t,
      name: boss ? 'Antinous' : undefined, pinned: false, feastSeed: Math.random() * 10, forward: new THREE.Vector3(0, 0, 1),
      charging: false, volleys: 0, blockTimes: [], flinch: { t: -9, dir: new THREE.Vector3(), amount: 0 }, bleedUntil: 0, gibs: [], staggerT: -9, throatBleedUntil: 0, neckWoundUntil: 0,
      guard: { zone: 'none', setAt: -9, nextReactAt: 0 }, ringT: 0, guardBeatenUntil: 0, staggerCause: '', neckWoundFrom: 0, guardPose: [0.32, 0.24, 0.7], riposteDir: null, lastCounterT: -9, postureWinT: -9, postureWinSum: 0, chainLeft: 0, chainAt: 0, chainDir: null, lastFeintT: -9, bossPhase: 1, bossBrokeInPhase: 0,
      voice: voiceFor(this.nextId * 7 + slot, boss), lastVocalT: -9, wounds: [], impale: null, lodged: 0, impaleLift: 0, woundBleedUntil: 0, woundBleedRate: 0,
      orbit: 0, orbitGoal: 0, range: 0, rangeGoal: 0, footT: 0, gait: newGait(at.x, at.z), stance: { ...STANCE_WALK },
      evadeVel: new THREE.Vector3(), evadeUntil: -9, evadeCd: 0, knock: new THREE.Vector3(), backoffUntil: -9, pressT: -9,
      shieldPose: [...SHIELD_POSE.carry], shieldAsideUntil: -9, bashCd: this.t + rand(2, 4),
    };
    if (kind === 'archer') {
      const side = Math.random() < 0.5 ? -1 : 1;
      e.spot = new THREE.Vector3(side * rand(1.6, 2.5), 0, rand(-19, -11.5));
      if (Math.abs(e.spot.z - HALL.hearth.z) < 2.4) e.spot.x = side * 2.5;
    }
    solvePose(e.pose, e.pos, e.yaw, e.look.scale, e.anim);
    const body = this.bodyFor(slot);
    if (body) { body.reset(); body.setLook(look); body.root.visible = true; body.root.scale.setScalar(body.baseScale * look.scale); }
    this.list.push(e);
    return e;
  }

  clear() {
    for (const e of this.list) this.release(e);
    this.list.length = 0;
    this.arrows.length = 0;
    this.ringOwner = [null, null, null, null, null];
    this.melanthius = false;
    this.habits.reset();
  }

  private release(e: Enemy) {
    if (e.ragdoll) { destroyRagdoll(this.world, e.ragdoll); e.ragdoll = null; }
    this.renderer.hide(e.slot);
    const body = this.bodies[e.slot];
    if (body) { body.reset(); body.root.visible = false; }
    for (const g of e.gibs) { this.renderer.group.remove(g.mesh); g.mesh.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); }
    e.gibs.length = 0;
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
    // they watch how you fight: the line of your cuts, your guard
    this.habits.update(dt, this.t, this.hooks.playerBlades(), head, this.hooks.playerYaw?.() ?? 0, this.hooks.blocking(), this.hooks.speedScale());
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      this.renderer.flash[e.slot] = Math.max(0, this.renderer.flash[e.slot] - dt * 5);
      if (e.dead) {
        const pel = e.ragdoll?.bodies[P.Pelvis]?.translation();
        // a corpse with your blade in it stays until the blade comes out (or 40 s)
        const held = e.lodged > 0 && this.t - e.diedAt < 40;
        const tooClose = !!pel && !e.pinned && !held && Math.hypot(pel.x, pel.z) < 1.8 && this.t - e.diedAt > 3;
        if ((this.t - e.diedAt > RAGDOLL_TTL && !held) || tooClose) {
          if (tooClose && pel) this.fx.dust(new THREE.Vector3(pel.x, pel.y, pel.z), 10);
          this.release(e);
          this.list.splice(i, 1);
        }
        this.bleed(e, dt);
        continue;
      }
      e.stateT += dt;
      // throat cut: he bleeds 5 hp/s, clutching his neck
      if (this.t < e.throatBleedUntil && e.state !== 'maimed') {
        e.hp -= 5 * dt;
        if (Math.random() < dt * 6) this.fx.blood(jointPoint(e.pose, P.Head, _n1), e.forward, 3);
        if (e.hp <= 0) {
          this.kill(e, { amount: 999, zone: 'head', part: P.Head, point: jointPoint(e.pose, P.Head, new THREE.Vector3()), dir: e.forward.clone().negate(), speed: 1, sharp: true, source: 'melee', impulse: 40, weaponEntId: null }, { decapitated: false, finisher: false, severed: null });
          continue;
        }
      }
      // a stab pulled out of him bleeds
      if (this.t < e.woundBleedUntil && e.state !== 'impaled') {
        e.hp -= e.woundBleedRate * dt;
        if (e.hp <= 0) {
          this.kill(e, { amount: 999, zone: 'torso', part: P.Torso, point: e.pose[P.Torso].c.clone(), dir: e.forward.clone().negate(), speed: 1, sharp: true, source: 'melee', impulse: 30, weaponEntId: null }, { decapitated: false, finisher: false, severed: null });
          continue;
        }
      }
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
      const p = e.pose[s.part];
      if (s.jet) {
        // a severed neck: the artery pumps in beats (~2.2 Hz), strong at first, weakening
        const age = this.t - (s.until - 2.6);
        const beat = Math.pow(Math.max(0, Math.sin(age * Math.PI * 2 * 2.2)), 2);
        const k = Math.max(0, 1 - age / 2.6) * s.jet;
        if (Math.random() < dt * 90 * (0.25 + 0.75 * beat) * k + dt * 8) {
          const w = _v.copy(s.local).applyQuaternion(p.q).add(p.c);
          const d = _v2.copy(s.local).normalize().applyQuaternion(p.q);
          this.fx.spurt(w, d, 2, (1.2 + 2.8 * beat) * (0.4 + 0.6 * k), 0.35);
        }
        continue;
      }
      if (Math.random() < dt * 40) {
        const w = _v.copy(s.local).applyQuaternion(p.q).add(p.c);
        const d = _v2.copy(s.local).normalize().applyQuaternion(p.q);
        this.fx.blood(w, d, 2);
      }
    }
    for (const wd of e.wounds) {
      if (this.t > wd.bleedUntil || e.severed.has(wd.part)) continue;
      const fresh = Math.max(0, (wd.bleedUntil - this.t) / 4);
      if (Math.random() < dt * (6 + 22 * fresh)) {
        this.woundDecals.worldOf(e, wd, _v, _v2);
        if (fresh > 0.5 && Math.random() < 0.4) this.fx.spurt(_v, _v2, 1, 0.6 + fresh, 0.2);
        else this.fx.drip(_v.addScaledVector(_v2, 0.01), 1);
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

  /** the player fights with his body (webcam): slower to guard and dodge than a mouse — the wooers give him room */
  private bodyInput() { return this.hooks.speedScale() >= 1; }

  private ringAngles() { return this.hooks.speedScale() < 1 ? RING_ANGLES_KB : RING_ANGLES; }
  /** how far off your view a ring slot may be and still strike (it must be on screen) */
  private onScreenAng() { return this.hooks.speedScale() < 1 ? 0.8 : 0.62; }

  private assignRing(e: Enemy) {
    if (e.ring !== null) return;
    let best = -1, bestD = Infinity;
    const RA = this.ringAngles();
    for (let k = 0; k < RA.length; k++) {
      if (this.ringOwner[k] !== null) continue;
      const sx = Math.sin(RA[k]) * RING_R, sz = -Math.cos(RA[k]) * RING_R;
      const d = Math.hypot(e.pos.x - sx, e.pos.z - sz);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best >= 0) { e.ring = best; this.ringOwner[best] = e.id; e.ringT = this.t; e.nextAttackAt = Math.max(e.nextAttackAt, this.t + rand(0.25, 0.7)); }
  }

  /** Skill per archetype (combat research): guard chance/react time, feints, combos, wind-up. */
  private arche(e: Enemy) {
    const w = this.hooks.wave();
    const easy = this.hooks.difficultyMult() < 1;
    let r: { pGuard: number; react: number; pFeint: number; pCombo: number; maxCombo: number; windup: number; pCounter?: number; adapt?: number; pEvade?: number };
    if (e.kind === 'boss') {
      const ph = e.bossPhase;
      r = { pGuard: 0.75, react: ph >= 3 ? 0.17 : 0.2, pFeint: ph >= 2 ? 0.35 : 0.2, pCombo: 0.6, maxCombo: ph >= 2 ? 3 : 2, windup: ph >= 2 ? 0.65 : 0.8 };
    } else if (e.kind === 'archer') r = { pGuard: 0.2, react: 0.5, pFeint: 0, pCombo: 0, maxCombo: 0, windup: 0.9 };
    else if (w <= 1) r = { pGuard: 0.4, react: 0.42, pFeint: 0, pCombo: 0, maxCombo: 0, windup: 1.05 };          // reveler (wave 1 teaches)
    else if (e.look.shield !== 'none' || e.look.armor === 'muscle') r = { pGuard: 0.7, react: 0.34, pFeint: 0.15, pCombo: 0.2, maxCombo: 1, windup: 0.8 }; // hoplite
    else r = { pGuard: 0.55, react: 0.3, pFeint: w >= 3 ? 0.25 : 0.18, pCombo: w >= 3 ? 0.3 : 0.2, maxCombo: 1, windup: w >= 3 ? 0.75 : 0.8 }; // swordsman
    // hammering a raised guard invites the counter: how often a plain block becomes a riposte
    r.pCounter = e.kind === 'boss' ? 0.8 : e.kind === 'archer' ? 0.2 : w <= 1 ? 0.3 : w === 2 ? 0.55 : 0.7;
    // how much he learns from the way you fight (drunken revelers barely; Antinous most) and how often he steps out
    // of a swing he can't guard (a shield man trusts his shield) — both gentler against a body (webcam) player
    const hoplite = e.look.shield !== 'none' && e.shieldHp > 0;
    r.adapt = e.kind === 'boss' ? 0.9 : e.kind === 'archer' ? 0 : w <= 1 ? 0.35 : hoplite ? 0.7 : 0.75;
    r.pEvade = e.kind === 'boss' ? 0.3 : e.kind === 'archer' ? 0.1 : w <= 1 ? 0.16 : hoplite ? 0.14 : 0.32;
    if (this.bodyInput()) { r.adapt *= 0.55; r.pEvade *= 0.6; }
    if (easy) { r.windup += 0.15; r.react += 0.15; r.pFeint = 0; r.pCounter *= 0.5; r.adapt *= 0.5; r.pEvade *= 0.5; }
    return r;
  }

  /** attack turns: 1 attacker in wave 1, 2 from wave 2 (Antinous always has his own); impacts ≥ 0.4 s apart */
  private canStartAttack(e: Enemy) {
    const easy = this.hooks.difficultyMult() < 1;
    const turns = Math.max(1, (this.hooks.wave() >= 2 ? 2 : 1) - (easy ? 1 : 0));
    let n = 0;
    for (const o of this.list) if (o !== e && !o.dead && o.kind !== 'boss' && (o.state === 'windup' || o.state === 'strike')) n++;
    if (e.kind !== 'boss' && n >= turns) return false;
    // only from where you can see him: a man more than ~35° off your view waits (or moves in, below) — judged where he
    // really stands (his footwork drifts him along his arc), not just by his ring slot
    if (e.ring !== null && e.kind !== 'archer') {
      const yaw = this.hooks.playerYaw?.() ?? 0;
      const head = this.hooks.playerHead();
      const actual = Math.atan2(e.pos.x - head.x, -(e.pos.z - head.z));
      if (Math.abs(this.ringAngles()[e.ring] + yaw) > this.onScreenAng() || Math.abs(actual + yaw) > this.onScreenAng()) return false;
    }
    const planned = this.t + this.arche(e).windup + 0.12;
    // blows land at least this far apart — a body (webcam) player raises a guard or leans far slower than a click
    const gap = this.bodyInput() ? 0.9 : 0.4;
    for (const o of this.list) if (o !== e && o.attack && !o.attack.resolved && Math.abs(o.attack.impactAt - planned) < gap) return false;
    return this.t - this.lastImpactAt > (this.bodyInput() ? 0.6 : 0.2);
  }

  /** His guard reads your blade: predict where it crosses him 0.18 s ahead and raise high / left / right / low. */
  private updateGuard(e: Enemy, distPlayer: number, a: Anim, dt: number) {
    // no guard while he recovers from his own swing (his arm is out of position — that is your opening)
    const guardable = e.armed && !e.severed.has(P.LArmR) && distPlayer < 2.4 && ['approach', 'wait', 'block'].includes(e.state) && e.kind !== 'archer';
    if (!guardable) { e.guard.zone = 'none'; return; }
    const blades = this.hooks.playerBlades();
    if (this.t >= e.guard.nextReactAt) {
      const ar = this.arche(e);
      const adapt = ar.adapt ?? 0;
      let best: THREE.Vector3 | null = null, bv: THREE.Vector3 | null = null, btip: THREE.Vector3 | null = null, bd = Infinity;
      for (const b of blades) {
        const p = _c2.copy(b.tip).addScaledVector(b.vel, 0.18);
        const d = p.distanceTo(e.pose[P.Torso].c);
        if (d < bd) { bd = d; best = p.clone(); bv = b.vel; btip = b.tip; }
      }
      // where your cuts have been going: once he has seen enough of them he waits for that line (trained men from wave
      // 2; a drunken reveler only for a cut spammed over and over)
      const hz = this.habits.habitZone();
      const learned: GuardZone | null = hz && hz.zone !== 'none' && (this.hooks.wave() >= 2 || this.habits.spam() >= 0.6) && adapt * hz.share >= 0.3 ? hz.zone : null;
      // a trained man stands in a ready guard (high, or the line he expects) until he reads your blade; revelers don't
      if (!best || bd >= 1.25) {
        const ready: GuardZone | null = learned ?? (this.hooks.wave() >= 2 ? 'high' : null);
        if (ready && (e.guard.zone === 'none' || (learned !== null && e.guard.zone !== learned))) { e.guard.zone = ready; e.guard.setAt = this.t; }
      }
      let guardedRead = false;
      if (best && bd < 1.25) {
        const right = _c1.set(-e.forward.z, 0, e.forward.x);
        const zone: GuardZone = best.y > e.pose[P.Torso].c.y + 0.12 * e.look.scale ? 'high'
          : best.y < e.pose[P.Pelvis].c.y ? 'low' : (_c3.subVectors(best, e.pos).dot(right) > 0 ? 'right' : 'left');
        // the cut he was waiting for is the one he's quickest to meet
        const expect = hz && hz.zone === zone ? 0.25 * adapt * hz.share : 0;
        if (Math.random() < ar.pGuard + expect) {
          if (zone !== e.guard.zone) { e.guard.zone = zone; e.guard.setAt = this.t; }
          guardedRead = true;
        }
      }
      // a fast swing he didn't set himself against: he may step out of it (judged on where your point is now — a quick
      // cut's look-ahead overshoots him)
      if (!guardedRead && bv && btip && btip.distanceTo(e.pose[P.Torso].c) < 1.15) this.tryEvade(e, btip, bv, ar.pEvade ?? 0);
      e.guard.nextReactAt = this.t + ar.react * (e.posture > 70 ? 1.4 : 1);
    }
    // show the guard: blade level over the brow (high), upright across a flank, or point down (low)
    const want: [number, number, number] = e.guard.zone === 'high' ? [2.35, 0.3, 1.5] : e.guard.zone === 'left' ? [1.35, 0.95, 1.6]
      : e.guard.zone === 'right' ? [1.3, -0.55, 1.35] : e.guard.zone === 'low' ? [0.55, 0.25, 1.45] : [0.32, 0.24, 0.7];
    const k = 1 - Math.exp(-14 * dt);
    for (let i = 0; i < 3; i++) e.guardPose[i] += (want[i] - e.guardPose[i]) * k;
    // (the point breathes a little: a live guard, not a statue)
    const br = 0.045 * Math.sin(this.t * 1.3 + e.feastSeed * 5);
    if (e.state === 'approach' || e.state === 'wait') a.armR = [e.guardPose[0] + br, e.guardPose[1], e.guardPose[2] - br];
  }

  /** a swing he couldn't guard (your point `tip` coming at him with `vel`): a quick step back and aside, out of its
   *  path (only while he's on his feet, waiting) */
  private tryEvade(e: Enemy, tip: THREE.Vector3, vel: THREE.Vector3, p: number) {
    if (this.t < e.evadeCd || (e.state !== 'approach' && e.state !== 'wait') || e.impale || e.kind === 'hero') return;
    const torso = e.pose[P.Torso].c;
    const closing = vel.dot(_c1.subVectors(torso, tip));
    if (closing <= 0 || vel.length() < 3.5 * this.hooks.speedScale()) return;
    e.evadeCd = this.t + rand(1.8, 3.2) + (this.bodyInput() ? 1 : 0);
    if (Math.random() >= p) return;
    const head = this.hooks.playerHead();
    const back = _c1.set(e.pos.x - head.x, 0, e.pos.z - head.z).normalize();
    const left = _c3.set(e.forward.z, 0, -e.forward.x);          // his left
    const side = vel.dot(left) > 0 ? -1 : 1;                       // away from where the edge is travelling
    const kb = Math.random() < 0.6 ? 1 : 0.35;                    // mostly a backstep, sometimes a pure sidestep
    e.evadeVel.copy(back).multiplyScalar(kb).addScaledVector(left, side * (1.1 - kb * 0.5)).setY(0).normalize().multiplyScalar(2.4);
    e.evadeUntil = this.t + 0.24; // ≈ 0.6–0.8 m
    e.rangeGoal = Math.max(e.rangeGoal, 0.2); e.footT = this.t + rand(0.6, 1.0); // and he keeps the distance a moment
    combatLog({ kind: 'evade', id: e.id, side });
  }

  private guardCovers(e: Enemy, zone: GuardZone, info: HitInfo) {
    const p = info.part;
    switch (zone) {
      case 'high': return p === P.Head || (p === P.Torso && info.point.y > e.pose[P.Torso].b.y - 0.1 * e.look.scale);
      case 'left': return p === P.Torso || p === P.UArmL || p === P.LArmL;
      case 'right': return p === P.Torso || p === P.UArmR || p === P.LArmR;
      case 'low': return p === P.Pelvis || p === P.ULegL || p === P.ULegR || p === P.LLegL || p === P.LLegR;
      default: return false;
    }
  }

  private setState(e: Enemy, s: EState, dur = 0) {
    // a man held on a blade stays on it (a second blow can maim him, knock him flat or kill him — not free him)
    if (e.state === 'impaled' && e.impale && s !== 'impaled' && s !== 'maimed' && s !== 'down') return;
    e.state = s; e.stateT = 0; e.stateDur = dur; e.staggerCause = '';
  }

  private updateAI(e: Enemy, dt: number, head: THREE.Vector3) {
    const a = e.anim;
    const toPlayer = _v.set(head.x - e.pos.x, 0, head.z - e.pos.z);
    const distPlayer = toPlayer.length();
    let target: THREE.Vector3 | null = null;
    let moving = false;
    // a disarmed wooer doesn't stand idle — he comes at you with his fists (half damage)
    const meleeCapable = (e.armed || ((e.kind === 'suitor' || e.kind === 'boss') && !e.severed.has(P.LArmR))) && !(e.kind === 'archer' && !e.charging);

    if (e.kind === 'archer' && !e.charging) target = e.spot;
    else {
      if (distPlayer < 10 || e.ring !== null) this.assignRing(e);
      // footwork: he circles a little along his arc and works his distance in and out instead of standing still
      this.updateFootwork(e);
      e.orbit += (e.orbitGoal - e.orbit) * (1 - Math.exp(-1.8 * dt));
      e.range += (e.rangeGoal - e.range) * (1 - Math.exp(-2.4 * dt));
      if (e.ring !== null) {
        const ang = this.ringAngles()[e.ring] + e.orbit;
        // they wait just out of your reach and step in to strike (spacing matters; your idle blade doesn't rest in them)
        const striking = e.state === 'windup' || e.state === 'strike' || e.state === 'recover'; // stays in to recover: punish him
        const bashing = !!e.attack?.bash && (e.state === 'windup' || e.state === 'strike');
        // …and the step in to strike brings his neck inside your reach: countering his committed swing is the opening.
        // Waiting he works his distance (stepping in to press you, out after his blow or when you've hurt him)
        const wait = 1.9 + (this.t < e.backoffUntil ? Math.max(e.range, 0.45) : e.range);
        const r = (bashing ? 1.12 : striking ? 1.24 : wait) * (e.kind === 'boss' ? 1.08 : 1); // waits beyond your lunge (~1.5 m + his body)
        target = _v3.set(Math.sin(ang) * r, 0, -Math.cos(ang) * r);
      } else {
        // the men behind the ring pace and mill, waiting for a place
        const ang = ((e.id * 0.618) % 1) * 2.2 - 1.1 + e.orbit * 1.6;
        const rr = 4.6 + e.range * 1.5;
        target = _v3.set(Math.sin(ang) * rr, 0, -Math.cos(ang) * rr - 0.5);
      }
    }

    const rooted = ['windup', 'strike', 'recover', 'recoil', 'stagger', 'broken', 'block', 'aim', 'shoot', 'getup', 'maimed', 'impaled'].includes(e.state);
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
        // far off they jog in (no dead air while they cross the hall); close in they slow to a stalk
        const distP = Math.hypot(e.pos.x - head.x, e.pos.z - head.z);
        const sp = Math.min(e.speed * (distP > 6 ? 1.45 : 1) * Math.min(1, dist / 0.6 + 0.25), distP < 3 ? 1.25 : 99);
        e.vel.x = damp(e.vel.x, d.x * sp, 6, dt);
        e.vel.z = damp(e.vel.z, d.z * sp, 6, dt);
        moving = true;
      } else { e.vel.x = damp(e.vel.x, 0, 8, dt); e.vel.z = damp(e.vel.z, 0, 8, dt); }
    } else { e.vel.x = damp(e.vel.x, 0, 10, dt); e.vel.z = damp(e.vel.z, 0, 10, dt); }
    // stepping out of your swing
    if (this.t < e.evadeUntil && (e.state === 'approach' || e.state === 'wait')) { e.vel.copy(e.evadeVel); moving = true; }
    if (e.state === 'impaled') { e.vel.set(0, 0, 0); e.knock.set(0, 0, 0); } // the blade holds him where he is
    e.pos.addScaledVector(e.vel, dt);
    // driven back by a blow (stagger, a cut that rocks him): he steps back under it, it isn't a slide
    e.pos.addScaledVector(e.knock, dt);
    e.knock.multiplyScalar(Math.exp(-7 * dt));
    e.pos.x = clamp(e.pos.x, -2.75, 2.75);
    // in front of the weapon table they stop at its far edge; beside it (flank slots) they may come level with you
    e.pos.z = clamp(e.pos.z, HALL.zFar + 0.8, Math.abs(e.pos.x) > 1.0 ? -0.45 : -1.25);
    const r0 = Math.hypot(e.pos.x, e.pos.z);
    if (r0 < 1.3 && e.state !== 'impaled') { e.pos.x *= 1.3 / r0; e.pos.z *= 1.3 / r0; }

    const speed = Math.hypot(e.vel.x, e.vel.z);
    const faceYaw = (moving && speed > 0.5 && distPlayer > 3.2 && !(e.kind === 'archer' && !e.charging))
      ? Math.atan2(e.vel.x, e.vel.z) : Math.atan2(toPlayer.x, toPlayer.z);
    let dy = faceYaw - e.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    // attacks track until 250 ms before impact, then lock
    const locked = e.attack?.locked || e.state === 'impaled'; // a man on a blade turns only as the blade turns him
    if (!locked) e.yaw += dy * (1 - Math.exp(-8 * dt));
    e.forward.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));

    // base locomotion pose: his feet step the way he really moves (in, out, strafing round you — the steering, the
    // step into a blow, being driven back), a fighting stance when he's close, his weight shifting while he waits
    const g = e.gait;
    let mvx = dt > 1e-4 ? (e.pos.x - g.px) / dt : 0, mvz = dt > 1e-4 ? (e.pos.z - g.pz) / dt : 0;
    const mv = Math.hypot(mvx, mvz);
    if (mv > 4) { mvx *= 4 / mv; mvz *= 4 / mv; } // a teleport (a blade shoving him) isn't a sprint
    g.px = e.pos.x; g.pz = e.pos.z;
    const at0 = e.attack;
    const lunge = e.kind !== 'archer' && (e.state === 'strike' || (e.state === 'windup' && !!at0 && this.t - at0.startT > at0.windup * 0.45));
    const want = lunge ? STANCE_LUNGE : (distPlayer < 3.6 && !(e.kind === 'archer' && !e.charging)) || e.state !== 'approach' ? STANCE_GUARD : STANCE_WALK;
    const ks = 1 - Math.exp(-9 * dt);
    const stn = e.stance;
    stn.lx += (want.lx - stn.lx) * ks; stn.lz += (want.lz - stn.lz) * ks; stn.rx += (want.rx - stn.rx) * ks; stn.rz += (want.rz - stn.rz) * ks;
    stn.crouch += (want.crouch - stn.crouch) * ks;
    stepGait(g, dt, mvx, mvz, e.yaw, stn, a, this.t, e.feastSeed);
    e.phase = g.phase;
    const gv = Math.hypot(g.vl, g.vf);
    const sw = Math.sin(g.phase) * Math.min(1, gv / 1.5);
    const still = 1 - Math.min(1, gv / 0.4);
    a.lean = 0.07 * clamp(g.vf / 2, -1, 1) + 0.04 * (want === STANCE_GUARD ? 1 : 0);
    // looking for an opening: the shoulders turn a little, the blade point breathes
    a.twist = 0.06 * still * Math.sin(this.t * 0.7 + e.feastSeed * 2);
    a.headPitch = 0;
    a.armL = [-sw * 0.4, 0.12, 0.3];
    a.armR = e.armed ? [0.32 + sw * 0.2, 0.24, 0.7] : [sw * 0.4, 0.12, 0.3]; // low guard: blade forward at the hip, throat open

    const atRing = e.ring !== null && target && Math.hypot(e.pos.x - target.x, e.pos.z - target.z) < 0.4;
    // a flank waiter who can't strike from there moves in to a free inner slot
    if (e.ring !== null && e.kind !== 'archer' && (e.state === 'wait' || e.state === 'approach') && this.t - e.ringT > 1.2
      && Math.abs(this.ringAngles()[e.ring] + (this.hooks.playerYaw?.() ?? 0)) > this.onScreenAng()) {
      for (const k of [2, 1, 3]) if (this.ringOwner[k] === null) { this.ringOwner[e.ring] = null; e.ring = k; this.ringOwner[k] = e.id; e.ringT = this.t; e.orbit = e.orbitGoal = 0; break; }
    }
    // step in during the first part of the wind-up
    if ((e.state === 'windup' || e.state === 'strike') && target && e.kind !== 'archer') {
      const k = 1 - Math.exp(-7 * dt);
      e.pos.x += (target.x - e.pos.x) * k; e.pos.z += (target.z - e.pos.z) * k;
    }
    const diff = this.hooks.difficultyMult();
    this.updateGuard(e, distPlayer, a, dt);

    switch (e.state) {
      case 'approach':
      case 'wait':
        if (e.kind === 'archer' && !e.charging) {
          if (target && Math.hypot(e.pos.x - target.x, e.pos.z - target.z) < 0.5 && this.t > e.nextAttackAt) this.setState(e, 'aim');
        } else if (meleeCapable && (atRing || distPlayer < 2.1) && this.t > e.nextAttackAt && this.canStartAttack(e)) {
          this.beginAttack(e, head);
        }
        break;
      case 'windup':
      case 'strike':
        this.updateAttack(e, dt, head);
        break;
      case 'recover':
        a.armR = [0.4, 0.2, 0.5];
        // combo: chain an opposite-side blow
        if (e.chainDir && this.t >= e.chainAt) { const d = e.chainDir; e.chainDir = null; this.beginAttack(e, head, { dir: d, windup: 0.45, chained: true }); break; }
        if (e.stateT > 0.5) {
          e.nextAttackAt = this.t + rand(1.2, 2.2) / diff; this.setState(e, 'wait');
          // and he steps back out of your reach (B&S / Mordhau spacing), then works his way in again
          e.rangeGoal = rand(0.25, 0.4); e.footT = this.t + rand(0.7, 1.1);
        }
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
        // (his legs: the gait steps him back under the blow that drove him)
        if (e.stateT > e.stateDur) { e.nextAttackAt = this.t + rand(0.8, 1.4) / diff; this.setState(e, 'wait'); e.rangeGoal = Math.max(e.rangeGoal, 0.3); }
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
        if (e.stateT > e.stateDur) {
          // parried you → riposte at once from that side (0.45 s, never feinted)
          if (e.riposteDir) { const d = e.riposteDir; e.riposteDir = null; this.beginAttack(e, head, { dir: d, windup: 0.45, noFeint: true }); break; }
          e.nextAttackAt = Math.min(e.nextAttackAt, this.t + 0.35); this.setState(e, 'wait');
        }
        break;
      }
      case 'impaled': {
        const im = e.impale;
        if (!im) { this.setState(e, 'stagger', 0.5); break; }
        const T = this.t - im.t0;
        const k = Math.min(1, T / 0.3);            // the clutch comes in
        const sink = Math.min(1, T / 1.8);         // and the knees go
        const throat = im.vital === 'throat' || im.vital === 'face';
        // the shock: arms thrown out for an instant, then the free hand clutches at the wound
        const shock = Math.max(0, 1 - T / 0.18);
        // (FK arm: [forward swing, abduction (− = toward the midline), elbow bend])
        const sag: [number, number, number] = [0.3 - 0.15 * sink, 0.22 + 0.4 * shock, 0.45 - 0.2 * sink]; // sword arm hangs
        if (throat) {
          // hands fly to the throat (and the blade in it)
          a.armL = [0.95 * k, -0.35 * k + 0.5 * shock, 2.25 * k];
          a.armR = e.armed ? sag : [0.95 * k, -0.35 * k + 0.5 * shock, 2.25 * k];
        } else {
          // the free hand grabs at the blade in front of his belly; disarmed, both hands do
          const grab: [number, number, number] = [0.32 * k - 0.3 * shock, -0.3 * k + 0.55 * shock, 1.25 * k];
          a.armL = grab;
          a.armR = e.armed ? sag : [grab[0], grab[1], grab[2]];
        }
        // he folds over the blade (throat: head back) — gently: the wound itself is held on the blade
        a.lean = (throat ? -0.06 : 0.12) + (throat ? 0.04 : 0.16) * sink - 0.06 * shock;
        a.headPitch = throat ? -0.18 : 0.25 + 0.3 * sink;
        a.legL = [0.35 * sink, 0.95 * sink]; a.legR = [-0.12 * sink, 0.55 * sink];
        a.bob = -0.08 * sink;
        a.twist = Math.sin(this.t * 37 + e.feastSeed) * 0.025 * (1 - 0.5 * sink); // trembling
        if (this.t >= im.dropAt && e.armed && !e.severed.has(P.LArmR)) this.dropSword(e, e.forward.clone().multiplyScalar(-0.4));
        if (this.t >= im.nextGroanT) { im.nextGroanT = this.t + rand(0.9, 1.5); if (!throat) this.vocal(e, 'pain', 0.35); }
        if (this.t >= im.freeAt) im.wantFree = true;
        if (this.t >= im.dieAt) {
          const pt = jointPoint(e.pose, im.part, new THREE.Vector3());
          this.kill(e, { amount: 999, zone: PART_ZONE[im.part], part: im.part, point: pt, dir: e.forward.clone().negate(), speed: 1, sharp: true, source: 'melee', impulse: 18, weaponEntId: im.weaponId },
            { decapitated: false, finisher: false, severed: null, impaled: im.through ? 'through' : im.vital });
          return;
        }
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
          e.volleys++;
          e.nextAttackAt = this.t + rand(3.4, 4.8) / diff;
          if (Math.random() < 0.4 && e.spot) e.spot.set(-e.spot.x, 0, clamp(e.spot.z + rand(-2, 2), -19, -10.5));
          this.setState(e, 'approach');
          // no dead air: after three volleys — or as soon as no blade is pressing you — he drops the bow and closes
          const pressing = this.list.some((o) => o !== e && !o.dead && o.kind !== 'archer' && o.kind !== 'hero' && Math.hypot(o.pos.x - head.x, o.pos.z - head.z) < 3);
          if (e.volleys >= 3 || (!pressing && e.volleys >= 1)) {
            e.charging = true; e.speed = Math.max(e.speed, 2.4);
            if (!e.armed) { e.armed = true; e.look.prop = 'xiphos'; }
          }
        }
        break;
      case 'getup':
        a.lean = 0.5 * (1 - e.stateT / 0.6);
        if (e.stateT > 0.6) this.setState(e, 'approach');
        break;
      default: break;
    }
    // the aspis arm (over the zone he's guarding, out wide when beaten aside or as he swings, driven out in a bash)
    this.updateShieldArm(e, a, dt, distPlayer);
    // legs posed by hand (kneeling, sinking, on a blade, drawing a bow): no weight shift on top
    if (e.state === 'broken' || e.state === 'maimed' || e.state === 'impaled' || e.state === 'aim') resetGait(e.gait, e.pos.x, e.pos.z, a);
    // additive flinch (200 ms spring) — the hit reads even when nothing else changes
    const ft = this.t - e.flinch.t;
    if (ft < 0.25) {
      const k = Math.sin((ft / 0.25) * Math.PI) * e.flinch.amount;
      const side = e.flinch.dir.dot(_v.set(e.forward.z, 0, -e.forward.x));
      a.twist += side * 0.45 * k;
      a.lean -= 0.3 * k;
      a.headPitch -= 0.35 * k;
    }
    // held up (or pressed down) by the blade in him
    if (e.state !== 'impaled') e.impaleLift *= Math.exp(-6 * dt); // off the blade he finds his feet again
    a.bob += e.impaleLift / e.look.scale;
    solvePose(e.pose, e.pos, e.yaw, e.look.scale, a);
    if (e.ragdoll) readRagdoll(e.ragdoll, e.pose); // severed limbs follow their own bodies
  }

  // ── footwork ────────────────────────────────────────────────────────────
  /** Every second or two a waiting man picks where to drift on his arc and how close to stand. */
  private updateFootwork(e: Enemy) {
    if (this.t < e.footT || (e.state !== 'approach' && e.state !== 'wait')) return;
    e.footT = this.t + rand(1.1, 2.4);
    let lo = -ORBIT_MAX, hi = ORBIT_MAX, push = 0;
    if (e.ring !== null) {
      const RA = this.ringAngles();
      const slot = RA[e.ring];
      // stay inside the on-screen arc (a flank waiter only drifts toward it): blows come only from where you can see
      const rel = slot + (this.hooks.playerYaw?.() ?? 0);
      const lim = this.onScreenAng() - 0.06;
      if (Math.abs(rel) <= lim) { lo = Math.max(lo, -lim - rel); hi = Math.min(hi, lim - rel); }
      else if (rel > 0) hi = 0; else lo = 0;
      // keep his distance from the men beside him
      const me = slot + e.orbit;
      for (const o of this.list) {
        if (o === e || o.dead || o.ring === null || o.kind === 'hero') continue;
        const d = me - (RA[o.ring] + o.orbit);
        if (Math.abs(d) < 0.42) push += (d >= 0 ? 1 : -1) * (0.42 - Math.abs(d));
      }
    }
    // circle: a step or two to one side of his place, then across to the other
    const side = Math.abs(e.orbit) > 0.08 ? -Math.sign(e.orbit) : Math.random() < 0.5 ? -1 : 1;
    e.orbitGoal = lo <= hi ? clamp(side * rand(0.1, ORBIT_MAX) + push * 0.8, lo, hi) : (lo + hi) / 2;
    // distance: in and out around his waiting line; a badly hurt man keeps further off
    e.rangeGoal = rand(-0.12, 0.26) + (e.hp < e.maxHp * 0.4 ? 0.25 : 0);
    // guard down? a trained man presses you: he closes and his blow comes sooner (never sooner than his turn allows)
    if (this.habits.open() && this.hooks.wave() >= 2 && e.kind !== 'archer' && this.t - e.pressT > 2.5) {
      e.pressT = this.t;
      e.rangeGoal = -0.14;
      const left = e.nextAttackAt - this.t;
      if (left > 0.4 && left < 2.5) e.nextAttackAt = this.t + 0.35 + left * 0.45;
      combatLog({ kind: 'press', id: e.id });
    }
  }

  // ── the aspis ───────────────────────────────────────────────────────────
  private shieldUsable(e: Enemy) { return e.look.shield !== 'none' && e.shieldHp > 0 && !e.severed.has(P.LArmL) && !e.dead; }

  /** His shield arm: over the zone he guards (his face against your bow), out wide when beaten aside or as he commits
   *  his own blow (the opening), drawn in and driven out in a bash. */
  private updateShieldArm(e: Enemy, a: Anim, dt: number, distPlayer: number) {
    if (!this.shieldUsable(e)) return;
    const st = e.state;
    if (st !== 'approach' && st !== 'wait' && st !== 'block' && st !== 'windup' && st !== 'strike' && st !== 'recover' && st !== 'recoil' && st !== 'getup') return;
    const at = e.attack;
    let want: ArmPose;
    let rate = 12;
    if (this.t < e.shieldAsideUntil) { want = SHIELD_POSE.aside; rate = 24; }
    else if (at?.bash && (st === 'windup' || st === 'strike')) {
      const out = at.impactAt - this.t < 0.16;
      want = out ? SHIELD_POSE.bashOut : SHIELD_POSE.bashBack; rate = out ? 30 : 10;
    } else if (st === 'strike' || (st === 'windup' && at && this.t - at.startT > at.windup * 0.55) || (st === 'recover' && e.stateT < 0.35)) {
      want = SHIELD_POSE.strike; rate = 9;
    } else if (this.hooks.playerAiming?.() && distPlayer > 2.6) want = SHIELD_POSE.high;
    else if (distPlayer > 4.5 && st === 'approach') want = SHIELD_POSE.carry;
    else {
      const z = e.guard.zone;
      want = z === 'high' ? SHIELD_POSE.high : z === 'left' ? SHIELD_POSE.left : z === 'right' ? SHIELD_POSE.right : z === 'low' ? SHIELD_POSE.low : SHIELD_POSE.ready;
    }
    const k = 1 - Math.exp(-rate * dt);
    const sp = e.shieldPose;
    for (let i = 0; i < 4; i++) sp[i] += (want[i] - sp[i]) * k;
    a.armL = [sp[0], sp[1], sp[2], sp[3]];
  }

  /** centre of his aspis (world) — the same disc the renderer draws */
  private shieldCentre(e: Enemy, out: THREE.Vector3) { return out.copy(e.pose[P.LArmL].c).addScaledVector(e.forward, 0.12 * e.look.scale); }
  /** radius of that disc (face + rim; Antinous's gilded one is bigger) */
  private shieldRadius(e: Enemy) { return (e.look.shieldDevice === 'lion-gilt' ? 0.5 : e.look.shieldDevice === 'scorpion' ? 0.43 : 0.45) * e.look.scale + 0.02; }

  /** Does the segment a→b (a blade of radius r) pass through his aspis from the front? The shield is a real thing
   *  in front of him: a blade meets it before anything behind it. Writes the contact point on its face. */
  private shieldIntersect(e: Enemy, a: THREE.Vector3, b: THREE.Vector3, r: number, out: THREE.Vector3): boolean {
    if (e.dead || !this.shieldUsable(e) || this.t < e.shieldAsideUntil || e.state === 'down' || e.state === 'broken' || e.state === 'idle' || e.kind === 'hero') return false;
    const n = e.forward;
    const C = this.shieldCentre(e, _s1);
    // only its face: from his flank or back you reach the man before the shield
    if (_s2.subVectors(this.hooks.playerHead(), C).dot(n) <= 0) return false;
    const da = _s2.subVectors(a, C).dot(n), db = _s3.subVectors(b, C).dot(n);
    const th = 0.03 + r;
    if ((da > th && db > th) || (da < -th && db < -th)) return false;
    const t = Math.abs(da - db) < 1e-6 ? 0.5 : clamp(da / (da - db), 0, 1);
    out.copy(a).lerp(b, t);
    const off = _s2.subVectors(out, C);
    off.addScaledVector(n, -off.dot(n));
    if (off.length() > this.shieldRadius(e) + r) return false;
    out.copy(C).add(off).addScaledVector(n, 0.02);
    return true;
  }

  /** A blow on his aspis: it wears (and splits at 0); a heavy one — or one on a man near the end of his footing —
   *  beats it out wide (an opening). */
  private shieldTakes(e: Enemy, info: HitInfo, res: HitResult, wear: number) {
    const ss = this.hooks.speedScale();
    const v = info.contactSpeed ?? info.speed;
    e.shieldHp -= (info.amount || this.rawDamage(info)) * wear;
    if (e.shieldHp <= 0) {
      res.shieldBroke = true;
      e.riposteDir = null;
      const c = this.shieldCentre(e, new THREE.Vector3());
      this.fx.dust(c, 14);
      this.fx.sparks(c, null, 24, '#ffcf8a');
      audio.thunk(1.4);
      this.dropShield(e);
      // the aspis splits on his arm: he reels
      if (e.state !== 'broken' && e.state !== 'impaled') { e.attack = null; this.setState(e, 'stagger', 0.6); e.knock.addScaledVector(_c3.copy(info.dir).setY(0).normalize(), 0.9); }
      this.hooks.onTactic?.(e, 'shieldBroke');
      combatLog({ kind: 'shieldBroke', id: e.id });
      return;
    }
    const heavy = v >= 9 * ss || (!!info.massKg && info.massKg > 2 && v >= 7 * ss) || (info.source === 'thrown' && (info.massKg ?? 0) > 1.5);
    if (heavy || e.posture >= 75) this.shieldAside(e);
  }

  private shieldAside(e: Enemy, dur = 0.8) {
    if (this.t < e.shieldAsideUntil || e.kind === 'hero') return;
    e.shieldAsideUntil = this.t + dur;
    e.guard.zone = 'none'; e.guard.nextReactAt = this.t + dur * 0.8;
    e.guardBeatenUntil = Math.max(e.guardBeatenUntil, this.t + dur);
    e.riposteDir = null; // (no riposte from a man whose shield was just beaten wide)
    if (e.attack?.bash && e.state === 'windup') { e.attack = null; this.setState(e, 'recoil', 0.5); }
    this.hooks.onTactic?.(e, 'shieldAside');
    combatLog({ kind: 'shieldAside', id: e.id });
  }

  /** a man hiding behind his guard gets the aspis driven into it (Mordhau's kick / Chivalry's bash) */
  private wantsBash(e: Enemy, head: THREE.Vector3) {
    if (!this.shieldUsable(e) || this.t < e.shieldAsideUntil || this.t < e.bashCd || e.kind === 'archer' || e.kind === 'hero') return false;
    if (Math.hypot(head.x - e.pos.x, head.z - e.pos.z) > 2.4 || !this.habits.turtling(this.bodyInput())) return false;
    const p = e.kind === 'boss' ? 0.7 : this.hooks.wave() <= 1 ? 0.35 : 0.55;
    if (Math.random() < p) return true;
    e.bashCd = this.t + 1.5; // not this time — he'll weigh it again
    return false;
  }

  private resolveBash(e: Enemy, at: Attack, o: Outcome, head: THREE.Vector3) {
    if (o === 'dodge' || o === 'perfectDodge') {
      this.hooks.onOutcome(e, at, o, at.lane);
      // he drove at air and stumbles past his own shield: open (the shield swung wide, his neck exposed)
      this.setState(e, 'recoil', 0.75);
      e.knock.addScaledVector(_c3.set(head.x - e.pos.x, 0, head.z - e.pos.z).normalize(), 0.9);
      this.shieldAside(e, 0.75);
      combatLog({ kind: 'bash', id: e.id, result: 'dodged' });
      return;
    }
    const guarded = this.hooks.blocking();
    const from = _c3.subVectors(at.lane, head).multiply(_c1.set(2.6, 1, 1)).add(head);
    const dmg = (e.kind === 'boss' ? 8 : [3, 4, 5][Math.min(2, this.hooks.wave() - 1)]) * (this.bodyInput() ? 0.8 : 1) * (guarded ? 1 : 1.4);
    this.hooks.onPlayerHit(dmg, 'melee', from, false);
    this.hooks.onBash?.(e, guarded);
    const c = this.shieldCentre(e, new THREE.Vector3());
    this.fx.contact(c, _c1.subVectors(head, c).normalize(), null, 6, 'shield');
    audio.shieldWood(1, audio.pan(c)); audio.thunk(0.8);
    this.hooks.shake(0.35);
    this.setState(e, 'recover', 0.5);
    combatLog({ kind: 'bash', id: e.id, result: guarded ? 'guardBroken' : 'shoved' });
  }

  // ── attacks ─────────────────────────────────────────────────────────────
  private beginAttack(e: Enemy, head: THREE.Vector3, opts: { dir?: AttackDir; windup?: number; noFeint?: boolean; chained?: boolean } = {}) {
    const boss = e.kind === 'boss';
    const ar = this.arche(e);
    // hiding behind your guard? a shield man drives the aspis into it (shown as a dodge-only ✕ thrust)
    const bash = !opts.dir && this.wantsBash(e, head);
    const unblockable = bash || (!opts.dir && boss && Math.random() < (e.bossPhase >= 3 ? 0.3 : e.bossPhase === 2 ? 0.2 : 0.12));
    // the line of his blow: the usual mix, tilted toward what lands on you and away from what you answer well
    // (and against a raised guard, more often the thrust under it)
    const dir: AttackDir = opts.dir ?? (unblockable ? 'thrust' : this.habits.chooseDir(ar.adapt ?? 0, this.hooks.blocking()));
    // off-screen flank attackers get +0.2 s so the chevron/whoosh can be read
    const flank = e.ring === 0 || e.ring === RING_ANGLES.length - 1 ? 0.2 : 0;
    const windup = opts.windup ?? (bash ? (this.bodyInput() ? 0.95 : 0.75) + flank : (unblockable ? 1.1 : ar.windup) + flank);
    if (!opts.chained) e.chainLeft = !bash && Math.random() < ar.pCombo ? ar.maxCombo : 0;
    const a: Attack = {
      dir, unblockable, windup, startT: this.t, impactAt: this.t + windup + 0.12, lane: new THREE.Vector3(), locked: false,
      glinted: false, whooshed: false, resolved: false, noFeint: !!opts.noFeint || !!opts.chained || bash, bash,
    };
    if (bash) { e.bashCd = this.t + rand(5, 8); combatLog({ kind: 'bashStart', id: e.id }); }
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
    if (at.bash) {
      // the aspis drawn in to his chest (updateShieldArm), sword held back, then driven into you off the back foot
      an.armR = [0.9 + 0.3 * ease, 0.5, 1.6];
      an.twist = 0.35 * ease - 0.6 * s; an.lean = -0.12 * ease + 0.38 * s;
    } else switch (at.dir) {
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
    // feint: halfway through, if you already reacted (guard up, or your blade in his lane), he pulls it and swings
    // from another side — only from wave 2, at most once per attack and once per 4 s
    if (!at.noFeint && !at.feinted && w >= 0.5 && w <= 0.65 && toImpact >= 0.45 && this.t - e.lastFeintT > 4) {
      const reacted = this.hooks.blocking() || this.hooks.playerBlades().some((b) => b.tip.distanceTo(at.lane) < 0.35);
      if (reacted && Math.random() < this.arche(e).pFeint) {
        at.feinted = true;
        e.lastFeintT = this.t;
        const others = (['top', 'left', 'right', 'thrust'] as AttackDir[]).filter((d) => d !== at.dir);
        at.dir = pick(others);
        at.startT = this.t; at.windup = 0.5; at.impactAt = this.t + 0.62;
        at.glinted = false; at.whooshed = false; at.locked = false;
        audio.glanceScrape(0.15, at.dir === 'left' ? -0.5 : at.dir === 'right' ? 0.5 : 0);
        combatLog({ kind: 'feint', id: e.id, dir: at.dir });
      }
    }
    if (!at.glinted && toImpact <= Math.min(at.unblockable ? 0.7 : 0.6, at.windup)) {
      at.glinted = true;
      const tip = new THREE.Vector3();
      if (at.bash) this.shieldCentre(e, tip); else this.renderer.swordSegment(e.pose, e.look, _c1, tip);
      this.fx.sparks(tip, null, 8, at.unblockable ? '#ff6a4a' : '#fff1c4');
      if (at.bash) { audio.shieldWood(0.5, audio.pan(tip)); audio.grunt(); }
      else if (at.unblockable) audio.gong(98, 1.2, 0.25); else audio.glint(at.dir === 'left' ? -0.6 : at.dir === 'right' ? 0.6 : 0);
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
    combatLog({ kind: 'incoming', dir: at.dir, outcome: o, unblockable: at.unblockable, bash: !!at.bash });
    if (at.bash) { this.resolveBash(e, at, o, head); e.attack = null; return; }
    // they remember which of their lines you answer and which land
    this.habits.noteOutcome(at.dir, o);
    if (at.unblockable && (o === 'perfect' || o === 'beat' || o === 'block' || o === 'shield' || o === 'guard')) o = 'hit';
    // effects where the bronze actually meets: on your blade nearest his (or on the face of your aspis)
    const contact = at.lane.clone();
    if (o === 'perfect' || o === 'beat' || o === 'block' || o === 'guard' || o === 'shield') {
      this.renderer.swordSegment(e.pose, e.look, _c1, _c2);
      const sc = o === 'shield' ? this.hooks.playerShield?.() : null;
      if (sc) {
        // the point of his blade nearest the shield's centre, pulled onto the shield face
        segSegDist2(_c1, _c2, sc, sc, _n3, _n4);
        contact.copy(_n3).lerp(sc, 0.6);
      } else {
        let bd = Infinity;
        for (const b of this.hooks.playerBlades()) {
          if (!b.base) continue;
          const d = segSegDist2(_c1, _c2, b.base, b.tip, _n3, _n4);
          if (d < bd) { bd = d; contact.copy(_n4).lerp(_n3, 0.25); }
        }
        if (bd > 0.6 * 0.6) contact.copy(at.lane); // nothing of yours near his blade (guard by stance): the lane
      }
    }
    this.hooks.onOutcome(e, at, o, contact);
    // combo: after a block / guard / dodge / hit he chains the opposite side (a clean deflect ends the string)
    if (e.chainLeft > 0 && (o === 'block' || o === 'shield' || o === 'guard' || o === 'dodge' || o === 'hit')) {
      e.chainLeft--;
      e.chainDir = at.dir === 'left' ? 'right' : at.dir === 'right' ? 'left' : pick(['left', 'right'] as AttackDir[]);
      e.chainAt = this.t + 0.12;
    } else e.chainLeft = 0;
    // the damage arc shows the side the blade came from (its lane), exaggerated off the player's eye line
    const from = _v3.subVectors(at.lane, head).multiply(_v2.set(2.6, 1, 1)).add(head);
    // per-wave blow damage (7 / 10 / 12 — wave 1 teaches), fists half; Antinous 22 (30 unblockable)
    const base = (e.kind === 'boss' ? (at.unblockable ? 30 : 22) : [6, 9, 12][Math.min(2, this.hooks.wave() - 1)] * (e.armed ? 1 : 0.5))
      * (this.bodyInput() ? 0.8 : 1); // webcam: blows cost a fifth less
    switch (o) {
      case 'perfect':
        this.addPosture(e, 40, true);
        if (e.state !== 'broken') this.setState(e, 'stagger', 0.9);
        break;
      case 'beat':
        this.addPosture(e, 25, true);
        if (e.state !== 'broken') this.setState(e, 'recoil', 0.5);
        break;
      case 'block':
      case 'shield':
        if (o === 'block' && !at.unblockable) this.hooks.onPlayerHit(base * 0.1, 'melee', from, false); // a held block leaks
        this.addPosture(e, 8);
        if (e.state !== 'broken') this.setState(e, 'recoil', 0.3);
        break;
      case 'guard':
        this.hooks.onPlayerHit(base * 0.4, 'melee', from, false); // half-stopped: wrong side or a thrust
        this.setState(e, 'recover');
        break;
      case 'dodge':
      case 'perfectDodge':
        this.setState(e, 'recover', 0.5);
        break;
      case 'hit':
        this.hooks.onPlayerHit(base, 'melee', from, base > 15);
        this.setState(e, 'recover');
        break;
    }
    e.attack = null;
  }

  private addPosture(e: Enemy, amt: number, breaker = false) {
    // pressure wears a man down, flailing doesn't break him: ordinary sources add ≤ 35 a second; a deflect, a
    // chamber or a hard beat of his blade (breaker) goes straight through
    if (!breaker) {
      if (this.t - e.postureWinT > 1) { e.postureWinT = this.t; e.postureWinSum = 0; }
      amt = Math.max(0, Math.min(amt, 35 - e.postureWinSum));
      e.postureWinSum += amt;
    }
    e.posture = Math.min(100, e.posture + amt);
    // Antinous breaks only through deflects / chambers / hard clashes — hacking at him caps at 95
    if (e.kind === 'boss' && !breaker) e.posture = Math.min(e.posture, 95);
    e.postureT = this.t;
    // Antinous breaks at most once per phase — deflects and chambers are the way in, not hacking at him
    if (e.kind === 'boss' && e.bossBrokeInPhase === e.bossPhase) e.posture = Math.min(e.posture, 95);
    if (e.posture >= 100 && e.state !== 'broken' && !e.dead) {
      e.attack = null;
      if (e.kind === 'boss') e.bossBrokeInPhase = e.bossPhase;
      this.setState(e, 'broken', e.kind === 'boss' ? 1.4 : 2.0);
      audio.gong(110, 2.5, 0.35);
      this.renderer.flash[e.slot] = 1;
    }
  }

  /** Your blade met his (not a chamber): it costs him posture and knocks his guard; a hard clash beats it aside. */
  onClash(e: Enemy, v: number) {
    const ss = this.hooks.speedScale();
    const k = clamp((v - 4 * ss) / (8 * ss), 0, 1);
    if (v < 4 * ss) return;
    this.addPosture(e, (4 + 10 * k) * (e.kind === 'boss' ? 0.5 : 1), v >= 12 * ss);
    if (v >= 12 * ss) {
      e.guard.zone = 'none'; e.guard.nextReactAt = this.t + 0.5; e.guardBeatenUntil = this.t + 0.5;
      const at = e.attack;
      if (e.state === 'windup' && at && 1 - (at.impactAt - this.t) / Math.max(0.1, at.windup) < 0.6) { at.impactAt += 0.15; at.startT += 0.15; }
      combatLog({ kind: 'beatAside', id: e.id, v: +v.toFixed(2) });
    }
  }

  /** Player blade struck the wooer's sword during his wind-up: the attack is cancelled (chamber). */
  chamber(e: Enemy, point: THREE.Vector3) {
    if (e.state !== 'windup' || !e.attack) return false;
    e.attack = null;
    this.addPosture(e, 20, true);
    if ((e.state as EState) !== 'broken') this.setState(e, 'recoil', 0.45);
    this.fx.contact(point, _v.copy(this.hooks.playerHead()).sub(point), null, 6, 'clash');
    audio.clashEdge(0.75, audio.pan(point));
    return true;
  }

  /** Swept test of the player's blade against wooers' swords (for chambers). */
  /** Blade-on-blade: your blade against any living, armed wooer's sword (any state) — the true contact point. */
  testSwords(a: THREE.Vector3, b: THREE.Vector3, radius: number): { e: Enemy; point: THREE.Vector3; windupProgress: number; bladeDir: THREE.Vector3 } | null {
    for (const e of this.list) {
      if (e.dead || !e.armed || e.severed.has(P.LArmR) || e.state === 'idle' || e.kind === 'hero') continue;
      this.renderer.swordSegment(e.pose, e.look, _c1, _c2);
      if (segSegDist2(a, b, _c1, _c2, _v, _v2) < (radius + 0.04) ** 2) {
        const at = e.attack;
        const progress = e.state === 'windup' && at ? 1 - (at.impactAt - this.t) / Math.max(0.1, at.windup) : 0;
        return { e, point: _v.clone().lerp(_v2, 0.5), windupProgress: progress, bladeDir: _c2.clone().sub(_c1).normalize() };
      }
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
        if (this.hooks.blocking() || this.hooks.shieldHeld()) { this.hooks.onArrowBlocked(ar.pos); this.hooks.onPlayerHit(6 * 0.2, 'arrow', ar.prev, false); }
        else this.hooks.onPlayerHit(6, 'arrow', ar.prev, false);
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
  /** The wooer whose neck the swept blade crossed this step. The neck is judged on its own (B&S), not by
   *  whichever body part the edge happened to touch first on its way in (usually the near shoulder). */
  neckCross(a: THREE.Vector3, b: THREE.Vector3, pa: THREE.Vector3, pb: THREE.Vector3): { enemy: Enemy; part: number; point: THREE.Vector3 } | null {
    for (const e of this.list) {
      if (e.dead || e.state === 'idle' || e.kind === 'hero' || e.severed.has(P.Head)) continue;
      const c = e.pose[P.Torso].c;
      if ((b.x - c.x) ** 2 + (b.z - c.z) ** 2 > 4) continue;
      // (a raised aspis takes the cut before it reaches his throat)
      if (this.shieldIntersect(e, a, b, BLADE_HALF, _s4)) continue;
      const top = jointPoint(e.pose, P.Head, _n1);
      const bot = _n2.copy(e.pose[P.Torso].b);
      if (top.distanceToSquared(bot) < 1e-4) bot.y -= 0.06 * e.look.scale;
      const r = NECK_R * e.look.scale + BLADE_HALF;
      if (this.sweptNeck({ bladeA: a, bladeB: b, bladePrevA: pa, bladePrevB: pb } as HitInfo, top, bot, r)) {
        return { enemy: e, part: P.Head, point: top.clone().lerp(bot, 0.35) };
      }
    }
    return null;
  }

  testSegment(a: THREE.Vector3, b: THREE.Vector3, radius: number, sweepA?: THREE.Vector3, sweepB?: THREE.Vector3, magnet = 0):
    { enemy: Enemy; part: number; point: THREE.Vector3 } | null {
    let best: { enemy: Enemy; part: number; point: THREE.Vector3 } | null = null;
    let bestD = Infinity;
    for (const e of this.list) {
      if (e.dead || e.state === 'idle' || e.kind === 'hero') continue;
      const c = e.pose[P.Torso].c;
      const mx = (a.x + b.x) / 2 - c.x, mz = (a.z + b.z) / 2 - c.z;
      if (mx * mx + mz * mz > 9) continue;
      // his aspis stands in front of him: a blade (or its swept point) that meets it strikes the shield, not what's behind
      if (this.shieldIntersect(e, a, b, radius, _s4) || (sweepA && sweepB && this.shieldIntersect(e, sweepA, sweepB, radius, _s4))) {
        if (bestD > -1) { bestD = -1; best = { enemy: e, part: P.LArmL, point: _s4.clone() }; }
        continue;
      }
      for (let i = 0; i < PART_COUNT; i++) {
        if (e.severed.has(i)) continue;
        const p = e.pose[i];
        // forgiveness: the swept tip + a few cm (a fast blade drags a little "magnet"); never on the head, whose
        // helmet would otherwise swallow the neck below it — the neck is judged on its own (neckCross)
        const r = PART_DIM[i].r * e.look.scale + radius + (i === P.Head ? 0.01 : 0.03 + magnet);
        let d2 = segSegDist2(a, b, p.a, p.b, _c1, _c2);
        if (sweepA && sweepB) {
          const d2s = segSegDist2(sweepA, sweepB, p.a, p.b, _v, _v2);
          if (d2s < d2) { d2 = d2s; _c1.copy(_v); _c2.copy(_v2); }
        }
        if (d2 < r * r) {
          const score = d2 - (i === P.Head ? 0.002 : 0);
          if (score < bestD) {
            bestD = score;
            // contact on the body's surface toward the blade (not the bone axis): a cut passing under the
            // jaw reads as the throat, blood and impacts land on the skin
            const pr = PART_DIM[i].r * e.look.scale;
            const off = _v.subVectors(_c1, _c2);
            const len = off.length();
            const point = _c2.clone();
            if (len > 1e-5) point.addScaledVector(off, Math.min(len, pr) / len);
            best = { enemy: e, part: i, point };
          }
        }
      }
    }
    return best;
  }

  private armorAt(e: Enemy, part: number, point: THREE.Vector3, atNeck = false, thrust = false): { cls: ArmorClass; neck: boolean } {
    const L = e.look;
    switch (part) {
      case P.Head: {
        // throat/jaw under the cheek guards is a gap; the bell of the helmet is bronze
        const neck = atNeck || point.y < e.pose[P.Head].c.y - 0.03 * L.scale;
        if (neck) return { cls: 'gap', neck: true };
        return { cls: L.helmet === 'corinthian' ? 'bronze' : L.helmet === 'pilos' ? 'linen' : 'gap', neck: false };
      }
      case P.Torso: {
        if (point.y > e.pose[P.Torso].b.y + 0.06 * L.scale) return { cls: 'gap', neck: true };
        // the armpit and the belly below the plate are gaps for a POINT finding them — a slash still meets the bronze
        if (L.armor !== 'none' && thrust) {
          const tp = e.pose[P.Torso];
          const loc = _a1.copy(point).sub(tp.c).applyQuaternion(_aq.copy(tp.q).invert());
          // the armpit: under a raised arm the cuirass is open
          const ua = e.pose[loc.x > 0 ? P.UArmL : P.UArmR];
          const hang = _a2.subVectors(ua.b, ua.a).normalize().dot(_a3.set(0, -1, 0).applyQuaternion(tp.q));
          if (Math.abs(loc.x) > 0.1 * L.scale && loc.y > 0.04 * L.scale && hang < 0.5) return { cls: 'gap', neck: false };
          // below the plate's lower edge: the belly behind belt and flaps
          if (loc.y < (RIG.torsoA - RIG.torsoC + 0.04) * L.scale) return { cls: 'thigh', neck: false };
        }
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
      if (info.sharp && info.source === 'melee' && e.ragdoll) {
        const cut = this.cutCheck(e, info, 0.6);
        if (cut !== null && this.sever(e, cut, info)) { res.severed = cut; res.decapitated = cut === P.Head; }
      }
      return res;
    }
    const tier = info.graze ? Math.min(1, this.tierOf(info.speed)) : this.tierOf(info.speed);
    const alive = !e.ragdoll || e.state !== 'down';
    // his guard faces YOU: a melee cut is frontal when you stand within 50° of where he faces (whatever way the
    // edge travels — a lateral cut is still in front of him); thrown things by the way they're coming in
    const toP = _v.copy(this.hooks.playerHead()).sub(e.pos).setY(0).normalize();
    const frontal = info.source === 'melee' ? toP.dot(e.forward) >= Math.cos(THREE.MathUtils.degToRad(50)) : info.dir.dot(e.forward) < -0.15;
    const vulnerable = ['windup', 'strike', 'recover', 'stagger', 'broken', 'recoil', 'maimed', 'down', 'getup', 'impaled'].includes(e.state);
    const broken = e.state === 'broken';

    // 1) his guard reads your blade — deterministic, no dice: a cut into a guard he raised ≥ 0.10 s ago is blocked;
    // a fast cut (≥ 6 m/s mouse) into one held ≥ 0.25 s is PARRIED: your blade is knocked aside and he ripostes
    if (info.source === 'melee' && alive && frontal && !vulnerable && e.guard.zone !== 'none' && this.t - e.guard.setAt >= 0.1 && this.guardCovers(e, e.guard.zone, info)) {
      const hasShield = this.shieldUsable(e) && this.t >= e.shieldAsideUntil;
      const hasSword = e.armed && !e.severed.has(P.LArmR);
      {
        const fast = (info.contactSpeed ?? info.speed) >= 6 * this.hooks.speedScale();
        const parry = fast && this.t - e.guard.setAt >= 0.25 && e.posture < 70;
        res.blocked = true; res.parried = parry;
        // posture is broken by committed blows into the guard, not by flailing at it
        const committed = info.strokeLen === undefined || (info.strokeLen >= 0.25 && (info.strokeTurn ?? 0) <= 40);
        this.addPosture(e, e.kind === 'boss' ? 8 : !committed ? 4 : tier === 3 ? 16 : 10);
        // a block runs its course (re-hitting it doesn't restart it — otherwise spam would hold him in it forever)
        if (e.state !== 'broken' && e.state !== 'block') this.setState(e, 'block', parry ? 0.22 : 0.3);
        // a parry always ripostes; a plain block often does (≤ 1 a second) — spam into his guard and he cuts back; the
        // same cut over and over is the one he was waiting for, and he punishes it more often
        const ar = this.arche(e);
        const spam = this.habits.spam();
        const counter = hasSword && (parry || (this.t - e.lastCounterT > 1.0 && Math.random() < (ar.pCounter ?? 0) + 0.3 * spam * (ar.adapt ?? 0)));
        if (counter) { e.lastCounterT = this.t; e.riposteDir = info.dir.dot(_v.set(-e.forward.z, 0, e.forward.x)) > 0 ? 'left' : 'right'; }
        if (spam >= 0.6) this.hooks.onTactic?.(e, 'read');
        combatLog({ kind: 'guarded', zone: e.guard.zone, parry, shield: hasShield, spam: +spam.toFixed(2), speed: +(info.contactSpeed ?? info.speed).toFixed(2) });
        if (hasShield && tier === 3 && info.massKg && info.massKg > 2) this.setState(e, 'stagger', 0.6); // heavy blow staggers through the shield
        const I = Math.min(1, Math.max(0, ((info.contactSpeed ?? info.speed) - 1.5) / 10.5));
        let at = info.point;
        if (hasShield) {
          // met on the aspis: the blow lands on its face, and it wears (a heavy one beats it out wide)
          at = this.shieldCentre(e, new THREE.Vector3()).lerp(info.point, 0.45);
          this.shieldTakes(e, info, res, info.sharp ? 0.35 : 1);
          this.hooks.onTactic?.(e, 'shield');
        }
        if (!hasShield && hasSword && info.bladeA && info.bladeB) {
          this.renderer.swordSegment(e.pose, e.look, _v, _v2);
          segSegDist2(info.bladeA, info.bladeB, _v, _v2, _n3, _n4);
          at = _n4.clone().lerp(_n3, 0.3); // on HIS guard, where your edge meets it (not out on your own blade)
        }
        this.fx.contact(at, info.dir.clone().negate(), info.dir, info.contactSpeed ?? info.speed, hasShield ? 'shield' : 'clash');
        if (hasShield) audio.shieldWood(I, audio.pan(at)); else audio.clashEdge(I, audio.pan(at));
        this.renderer.flash[e.slot] = 0.3;
        return res;
      }
    }

    // 2) passive shield coverage (thrown, arrows, slow swings): the disc on his arm, wherever he holds it — raised
    // over his face it takes head blows too; beaten out wide (or swung out as he commits) it covers nothing. A blow from
    // his flank or back goes round it (frontal).
    const raised = e.shieldPose[0] > 1.15;
    if (alive && this.shieldUsable(e) && this.t >= e.shieldAsideUntil && info.source !== 'bomb' && (info.zone !== 'head' || e.kind === 'boss' || raised) && frontal && !broken) {
      const sc = this.shieldCentre(e, _v);
      const off = _v2.subVectors(info.point, sc);
      const depth = off.dot(e.forward);
      off.addScaledVector(e.forward, -depth);
      // a blow that met the disc itself (contact on its face) is the shield's however near the rim; one that reached his
      // body is covered when the body is behind the shield
      const rad = Math.abs(depth) < 0.06 ? this.shieldRadius(e) + 0.06 : (e.kind === 'boss' ? 0.55 : 0.45) * e.look.scale;
      if (off.length() < rad) {
        res.blocked = true;
        this.addPosture(e, 6);
        const face = sc.clone().lerp(info.point, 0.45);
        this.fx.contact(face, info.dir.clone().negate(), info.dir, info.speed, 'shield');
        audio.shieldWood(Math.min(1, info.speed / 12), audio.pan(info.point));
        this.shieldTakes(e, info, res, info.sharp ? 0.6 : 1.4);
        if (!res.shieldBroke) this.hooks.onTactic?.(e, 'shield');
        combatLog({ kind: 'shieldBlock', id: e.id, part: info.part, src: info.source, hp: Math.round(e.shieldHp) });
        this.renderer.flash[e.slot] = 0.4;
        return res;
      }
    }

    // 3) armor: glance or penetrate
    const thrust = !!info.bladeAxis && Math.abs(info.bladeAxis.dot(info.dir)) > 0.8 || info.source === 'arrow';
    const arm = this.armorAt(e, info.part, info.point, !!info.neck, thrust);
    res.armor = arm.cls; res.neck = arm.neck;
    combatLog({ kind: 'hit', part: info.part, speed: +info.speed.toFixed(2), cls: arm.cls, neck: arm.neck, thrust, stab: !!info.stab, source: info.source, state: e.state });
    let dmg: number;
    if (info.source === 'bomb') dmg = info.amount;
    else if (info.sharp) {
      const need = VPEN[arm.cls][thrust ? 1 : 0] * (arm.cls === 'gap' ? 1 : this.hooks.speedScale());
      // (a slow touch on bare flesh is just a touch — it doesn't ring off like bronze)
      if (info.speed < need && !broken && !(arm.cls === 'gap' && tier === 0)) {
        // glance: 20% as blunt, posture, sparks, bounce
        res.glanced = true;
        dmg = this.rawDamage(info) * 0.2;
        this.addPosture(e, (tier >= 3 ? 12 : tier === 2 ? 8 : 4) * (e.kind === 'boss' ? 0.3 : 1));
        const I = Math.min(1, Math.max(0, (info.speed - 1.5) / 10.5));
        const pan = audio.pan(info.point);
        if (info.part === P.Head) { this.fx.contact(info.point, info.dir.clone().negate(), info.dir, info.speed, 'helmet'); audio.helmetBell(I, pan); }
        else { this.fx.contact(info.point, info.dir.clone().negate(), info.dir, info.speed, arm.cls === 'bronze' ? 'glance' : 'armour'); audio.glanceScrape(I, pan); if (arm.cls === 'bronze') audio.armourBonk(I * 0.6, pan); }
      } else dmg = this.rawDamage(info) * (arm.cls === 'bronze' && !thrust ? 0.5 : 1);
    } else dmg = this.rawDamage(info) * (1 - BLUNT_ABSORB[arm.cls]);
    if (!res.glanced) dmg *= this.zoneMult(info.part, arm.neck);
    if (info.graze) dmg *= 0.2;
    if (broken) dmg *= e.kind === 'boss' ? 1.6 : 3;
    else if (e.state === 'stagger' || e.state === 'recoil') dmg *= 1.5; // riposte window
    if (tier === 0 && info.source === 'melee') {
      // touch: never silent
      if (arm.cls === 'bronze') audio.armourBonk(0.1, audio.pan(info.point)); else audio.fleshCut(0.05, arm.cls === 'linen', audio.pan(info.point));
      e.flinch = { t: this.t, dir: info.dir.clone(), amount: 0.25 };
      return res;
    }
    // 4) dismemberment — Blade & Sorcery rules: a committed edge cut ACROSS the neck or a joint, fast enough at the
    // contact point, with the middle-to-point of the blade; the neck also needs an opening
    let severPart: number | null = null;
    const cutCapable = info.sharp && !thrust && (info.source === 'melee' || info.source === 'thrown') && !res.glanced;
    // Antinous is a boss, not a one-cut kill: his limbs and head come off only once he's broken or nearly spent
    const bossGuard = e.kind === 'boss' && !broken && e.hp - dmg > e.maxHp * 0.3;
    if (cutCapable && !bossGuard) {
      severPart = this.cutCheck(e, info, broken ? 0.5 : 1);
      if (severPart === null && info.neckRepeat) { this.lastNeckNearMiss = false; dmg *= 0.2; }
      // near miss at the throat: a gash, not a beheading — he bleeds and staggers, and the next cut takes it
      if (severPart === null && this.lastNeckNearMiss) {
        dmg *= 1.8 / this.zoneMult(info.part, arm.neck);
        e.throatBleedUntil = this.t + 6;
        e.neckWoundUntil = this.t + 9; // (the weakened neck counts from 1 s after the gash — no instant follow-up)
        e.neckWoundFrom = this.t + 1;
        if (e.state !== 'broken' && !(e.kind === 'boss' && e.bossPhase === 1)) { e.attack = null; this.setState(e, 'stagger', 0.7); e.staggerCause = 'throat'; }
        this.fx.blood(info.point, info.dir, 14);
        combatLog({ kind: 'throatCut', speed: +(info.contactSpeed ?? info.speed).toFixed(2) });
      }
    }
    // Antinous can't be one-shot by any single blow (bombs, forged gifts): each costs him ≤ 22% (≤ 30% while he's
    // broken — the break is worth it, but it can't burst him through his phases); and no blow crosses two phases
    if (e.kind === 'boss') {
      dmg = Math.min(dmg, e.maxHp * (broken ? 0.3 : 0.22));
      const floor = e.hp > e.maxHp * 0.6 ? e.maxHp * 0.3 + 1 : 0;
      dmg = Math.min(dmg, Math.max(0, e.hp - floor));
    }
    // no one-shots: a hit that doesn't take a limb or the head costs a wooer ≤ 45% (melee) / 70% (thrown) of his life
    if (e.kind !== 'boss' && !broken && severPart === null && info.source !== 'arrow' && info.source !== 'bomb')
      dmg = Math.min(dmg, e.maxHp * (info.source === 'thrown' ? 0.7 : 0.4));
    res.damage = dmg;
    e.hp -= dmg;
    // Antinous: phase 2 at 60% (the gilded shield drops, he calls for help), phase 3 at 30% (desperate)
    if (e.kind === 'boss' && e.hp > 0) {
      const ph = e.hp < e.maxHp * 0.3 ? 3 : e.hp < e.maxHp * 0.6 ? 2 : 1;
      if (ph > e.bossPhase) {
        e.bossPhase = ph;
        // a new phase: he tears free of the break and resets his footing (a fresh posture bar to beat)
        if (e.state === 'broken') { e.attack = null; this.setState(e, 'recover', 0.6); }
        e.posture = 0;
        if (ph === 2 && e.shieldHp > 0 && e.look.shield !== 'none') { e.shieldHp = 0; this.dropShield(e); }
        this.hooks.onBossPhase(e, ph);
      }
    }
    e.lastHit.set(-99, this.t);
    this.renderer.flash[e.slot] = Math.min(1, 0.5 + dmg / 60);
    if (!res.glanced) {
      this.fx.hitPuff(info.point, info.dir, dmg);
      // a committed cut leaves a gash on him (stabs leave their own holes)
      if (info.sharp && !thrust && !info.graze && !info.noCut && info.source === 'melee' && tier >= 2) this.addGash(e, info);
      // the missing sound: a blade going in (through bronze it also rings the plate)
      if (info.sharp && info.source !== 'bomb') {
        const I = Math.min(1, Math.max(0, ((info.contactSpeed ?? info.speed) - 1.5) / 10.5));
        const pan = audio.pan(info.point);
        if (info.stab && thrust) { audio.stabIn(Math.max(0.45, I), arm.cls, pan, info.part === P.Torso || info.part === P.Head); res.penetrated = true; }
        else if (arm.cls === 'bronze') { audio.armourBonk(I, pan); setTimeout(() => audio.fleshCut(I * 0.6, false, pan), 6); }
        else audio.fleshCut(I, arm.cls === 'linen', pan);
      }
    }
    if (severPart === P.Head || ((severPart === P.ULegL || severPart === P.ULegR || severPart === P.LLegL || severPart === P.LLegR))) e.hp = Math.min(e.hp, 0);
    if (!res.glanced && tier >= 2 && !info.graze) this.addPosture(e, (tier === 3 ? 8 : 4) * (e.kind === 'boss' ? 0.3 : 1));

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
      this.vocal(e, 'scream', 0.9);
      this.hooks.hitstop(90);
      return res;
    }
    if (!res.glanced && res.penetrated) {
      // the point went in: no knock-back (the stab system holds him on the blade), a bite of hitstop
      e.flinch = { t: this.t, dir: info.dir.clone(), amount: 1 };
      this.hooks.hitstop(70);
      return res;
    }
    if (!res.glanced) {
      this.vocal(e, 'pain', tier >= 3 ? 0.9 : tier === 2 ? 0.6 : 0.35);
      // hit reaction: flinch (light) or directional stagger (solid/heavy)
      e.flinch = { t: this.t, dir: info.dir.clone(), amount: tier >= 2 ? 1 : 0.6 };
      // only a heavy blow (or one on a man whose balance is going) staggers him; ordinary cuts make him flinch
      // a fast cut alone no longer staggers (mouse cuts are often ≥ 7 m/s): it takes a heavy blow, or a fast one on a
      // man already off balance (posture ≥ 30), or his posture nearly gone
      const ssH = this.hooks.speedScale();
      if (((tier >= 3 && (e.posture >= 30 || info.speed >= 14 * ssH)) || e.posture >= 60) && e.state !== 'broken' && e.state !== 'maimed') {
        // hyper-armour: once his wind-up is 40% done only a heavy blow (≥7 m/s, mouse-scaled) breaks it, and a
        // wooer can be staggered at most once per 1.5 s — fast sweeps no longer stun-lock him
        // interrupts only early in his wind-up (< 25%) or with a heavy blow (≥ 14 m/s, mouse-scaled) — otherwise
        // it's a TRADE: you hurt him, but his blow still lands. Stagger cooldown 1.5 s (2.5 s armoured).
        const atk = e.attack;
        const progress = e.state === 'windup' && atk ? 1 - (atk.impactAt - this.t) / Math.max(0.1, atk.windup) : 0;
        const committed = e.state === 'windup' && progress >= 0.25;
        const heavy = info.speed >= 14 * this.hooks.speedScale();
        const resist = (e.kind === 'boss' || e.look.armor === 'muscle') && !(heavy && e.posture >= 60);
        const cd = e.look.armor === 'muscle' || e.kind === 'boss' ? 2.5 : 1.5;
        if ((committed && (!heavy || resist)) || this.t - e.staggerT < cd) { /* flinch only — trade */ this.lashBack(e); }
        else {
          e.staggerT = this.t;
          e.attack = null;
          this.setState(e, 'stagger', tier === 3 ? 1.0 : 0.6);
          // he's driven back under it and staggers a step or two (≈ 0.35 / 0.15 m)
          e.knock.addScaledVector(_v.copy(info.dir).setY(0).normalize(), tier === 3 ? 2.4 : 1.05);
        }
      } else this.lashBack(e);
      // every cut that bites rocks him back a little
      if (e.state !== 'stagger' && e.state !== 'impaled') e.knock.addScaledVector(_v.copy(info.dir).setY(0).normalize(), tier >= 2 ? 0.6 : 0.3);
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
  private lastNeckNearMiss = false;
  /**
   * Blade & Sorcery dismemberment check. Returns the part that comes off (P.Head = beheading) or null.
   * `k` scales the speed thresholds (0.5 broken finisher, 0.6 corpses). Sets lastNeckNearMiss for throat cuts.
   * Held-blade hits carry the real blade segment, contact fraction/speed and stroke; thrown blades use speed.
   */
  private cutCheck(e: Enemy, info: HitInfo, k: number): number | null {
    this.lastNeckNearMiss = false;
    if (info.noCut) return null;
    const ss = this.hooks.speedScale();
    const L = e.look;
    const v = info.contactSpeed ?? info.speed;
    const held = info.bladeA !== undefined && info.bladeB !== undefined;
    // the edge leads (≥ 65° off the blade axis) and the stroke was committed (no back-and-forth wiggles)
    const edge = !info.bladeAxis || Math.abs(info.bladeAxis.dot(info.dir)) <= 0.42;
    const committed = !held || ((info.strokeLen ?? 0) >= 0.25 && (info.strokeTurn ?? 0) <= 40);
    const onEdge = !held || ((info.contactFrac ?? 1) >= 0.15); // not the ricasso by the guard
    if (!edge || !onEdge) return null;
    const corpse = e.dead;
    // ── the neck: a strict capsule between the head joint and the top of the torso, no hit-test forgiveness ──
    if (!e.severed.has(P.Head)) {
      const top = jointPoint(e.pose, P.Head, _n1);
      const bot = _n2.copy(e.pose[P.Torso].b);
      if (top.distanceToSquared(bot) < 1e-4) bot.y -= 0.06 * L.scale;
      const r = NECK_R * L.scale + BLADE_HALF; // the neck itself + the blade's half-width: the edge visibly through it
      const geo = held
        ? this.sweptNeck(info, top, bot, r)
        : info.point.distanceTo(top) < 0.1 * L.scale;
      if (geo) {
        const axis = _n3.subVectors(top, bot).normalize();
        const across = Math.abs(info.dir.dot(axis)) <= 0.72; // level or diagonal (≥ 44° off the neck's line), not a chop down it
        // an opening: off balance, committed to his own swing, or cut from his flank/back
        const toPlayer = _n4.copy(this.hooks.playerHead()).sub(e.pos).setY(0).normalize();
        const flank = toPlayer.dot(e.forward) < Math.cos(THREE.MathUtils.degToRad(50));
        const atk = e.attack;
        const progress = e.state === 'windup' && atk ? 1 - (atk.impactAt - this.t) / Math.max(0.1, atk.windup) : 0;
        const offBalance = ['strike', 'stagger', 'recoil', 'broken', 'maimed', 'recover', 'down', 'getup', 'impaled'].includes(e.state) && !(e.state === 'stagger' && e.staggerCause === 'throat');
        const opening = corpse || flank || progress >= 0.6 || offBalance || (e.kind !== 'boss' && this.t < e.guardBeatenUntil);
        const need = NECK_V * ss * k * (this.t < e.neckWoundUntil && this.t >= e.neckWoundFrom ? 0.7 : 1);
        if (across && committed) {
          if (opening && v >= need) return P.Head;
          // no opening (he's square to you, guarding) or not quite fast enough: a throat gash instead
          if (!corpse && v >= need * 0.55) this.lastNeckNearMiss = true;
        }
        return null;
      }
    }
    if (!committed) return null;
    // ── limbs: across the bone, at the joint (shoulder / elbow / hip / knee) ──
    const part = info.part;
    const base = SEVER[part];
    if (base === undefined || part === P.Head || e.severed.has(part)) return null;
    if ((part === P.LLegL || part === P.LLegR) && L.greaves) return null; // greaves cover the knee/shin
    const p = e.pose[part];
    const bone = _n1.subVectors(p.b, p.a).normalize();
    if (Math.abs(info.dir.dot(bone)) > 0.5) return null;
    if (info.point.distanceTo(jointPoint(e.pose, part, _n2)) > 0.14 * L.scale) return null;
    // and the edge really reached the limb (no severing through the air on a forgiving hit test)
    if (info.bladeA && info.bladeB && !this.sweptNeck(info, p.a, p.b, PART_DIM[part].r * L.scale + BLADE_HALF)) return null;
    const armored = this.armorAt(e, part, info.point).cls === 'linen' ? 1.3 : 1; // leather bracers
    return v >= base * ss * k * armored ? part : null;
  }

  /** Did the blade pass through the neck capsule between the last step and this one? A fast cut moves the
   *  edge ~20 cm per step — more than the neck is wide — so the test sweeps the blade, not one snapshot. */
  private sweptNeck(info: HitInfo, top: THREE.Vector3, bot: THREE.Vector3, r: number): boolean {
    const A = info.bladeA!, B = info.bladeB!;
    const r2 = r * r;
    if (!info.bladePrevA || !info.bladePrevB) return segSegDist2(A, B, top, bot, _n3, _n4) <= r2;
    const pa = info.bladePrevA, pb = info.bladePrevB;
    for (let i = 1; i <= 6; i++) {
      const k = i / 6;
      _sw1.copy(pa).lerp(A, k); _sw2.copy(pb).lerp(B, k);
      if (segSegDist2(_sw1, _sw2, top, bot, _n3, _n4) <= r2) return true;
    }
    return false;
  }

  /** hurt but not staggered, a wooer standing his ground cuts back at once instead of waiting his turn */
  private lashBack(e: Enemy) {
    if ((e.state !== 'wait' && e.state !== 'approach') || e.kind === 'archer') return;
    // (wave-1 revelers are drunk and slow to answer — the lesson wave)
    if (this.hooks.wave() >= 2 && e.hp >= e.maxHp * 0.35) {
      e.nextAttackAt = Math.min(e.nextAttackAt, this.t + (this.bodyInput() ? rand(0.55, 0.9) : rand(0.2, 0.45)));
      return;
    }
    // a reveler — or a badly hurt man — gives ground instead: a step back out of your reach
    e.backoffUntil = this.t + rand(0.6, 0.9);
  }

  private zoneMult(part: number, neck: boolean) {
    if (neck) return 1.35;
    if (part === P.Head) return 1.5;
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
    const skin = this.bodies[e.slot];
    if (skin) {
      const gib = skin.sever(part, e.pose[part]);
      if (gib) { this.renderer.group.add(gib); e.gibs.push({ part, mesh: gib }); }
    }
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
    e.stumps.push({ part, local: toLocal(part), until: this.t + (part === P.Head ? 2.0 : 1.6) });
    // off with his head: the neck pumps an arterial jet for a couple of seconds as the head flies
    if (parent >= 0) e.stumps.push({ part: parent, local: toLocal(parent), until: this.t + (part === P.Head ? 2.6 : 2.2), jet: part === P.Head ? 1 : undefined });
    this.fx.blood(jp, info.dir, 26);
    if (part === P.Head) {
      const up = _v.subVectors(jp, e.pose[P.Torso].c).normalize();
      this.fx.spurt(jp, up.addScaledVector(info.dir, 0.3), 34, 3.6, 0.55);
      audio.decap(audio.pan(jp));
    } else {
      audio.severSound(audio.pan(jp));
      if (!e.dead) this.vocal(e, 'scream', 1);
    }
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

  private toRagdoll(e: Enemy, info: HitInfo, crumple = false) {
    if (!e.ragdoll) e.ragdoll = emptyBodies(e.look.scale);
    const parts: number[] = [];
    for (let i = 0; i < PART_COUNT; i++) if (!e.severed.has(i)) parts.push(i);
    addBodies(this.world, e.ragdoll, e.pose, parts, e.vel);
    if (e.ring !== null) { this.ringOwner[e.ring] = null; e.ring = null; }
    const body = e.ragdoll.bodies[info.part] ?? e.ragdoll.bodies[P.Torso];
    // a beheaded man crumples where he stands (small push along the cut, knees go) instead of cartwheeling
    const imp = _v.copy(info.dir).multiplyScalar(info.impulse * (crumple ? 0.25 : 1));
    imp.y += info.impulse * (crumple ? -0.1 : 0.25);
    body?.applyImpulse({ x: imp.x, y: imp.y, z: imp.z }, true);
    e.ragdoll.bodies[P.Torso]?.applyImpulse({ x: imp.x * 0.5, y: imp.y * 0.5, z: imp.z * 0.5 }, true);
    return e.ragdoll;
  }

  private knockdown(e: Enemy, info: HitInfo) {
    e.attack = null;
    this.toRagdoll(e, info);
    this.setState(e, 'down');
  }

  private kill(e: Enemy, info: HitInfo, how: KillHow) {
    const pelvisY = e.ragdoll?.bodies[P.Pelvis]?.translation().y ?? 0.95;
    const wasDown = e.state === 'down';
    // a blow already falling (strike) still lands as he dies — trading wounds with a committed man costs you;
    // a beheading stops it dead
    if (e.state === 'strike' && e.attack && !e.attack.resolved && !how.decapitated) {
      e.attack.resolved = true;
      this.lastImpactAt = this.t;
      this.resolveAttack(e, e.attack, this.hooks.playerHead());
    }
    e.attack = null;
    const throatDeath = how.impaled === 'throat' || (this.t < e.throatBleedUntil + 0.5 && !how.decapitated);
    const rag = this.toRagdoll(e, info, how.decapitated || !!how.impaled);
    e.dead = true;
    e.diedAt = this.t;
    e.state = 'dead';
    e.impale = null;
    (info as HitInfo & { airborne?: boolean }).airborne = wasDown && pelvisY >= 0.8;
    // a clean beheading is swift - no freeze, the blade carries on through; other deaths bite briefly
    this.hooks.hitstop(how.decapitated ? 0 : how.impaled ? 60 : info.source === 'bomb' ? 120 : 110);
    this.hooks.shake(how.decapitated ? 0.3 : 0.25);
    audio.thunk(how.decapitated ? 0.8 : 1.3);
    if (!how.decapitated && how.impaled !== 'face') this.vocal(e, throatDeath ? 'gurgle' : 'death');
    // the dead man's sword falls from his hand
    if (e.armed && !e.severed.has(P.LArmR)) this.dropSword(e, info.dir.clone());
    this.hooks.onKill(e, info, rag, how);
  }

  private dropSword(e: Enemy, vel: THREE.Vector3) {
    if (!e.armed) return;
    e.armed = false;
    this.renderer.swordSegment(e.pose, e.look, _c1, _c2);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, _v.subVectors(_c2, _c1).normalize());
    this.hooks.onDropWeapon(e.look.prop === 'spear' ? 'spear' : 'sword', _c1.clone(), q, vel, e.look);
  }

  /** a gash on his skin where the edge went in, running the way the edge travelled */
  private addGash(e: Enemy, info: HitInfo) {
    const p = e.pose[info.part];
    segSegDist2(info.point, info.point, p.a, p.b, _a1, _a2);
    const n = _a3.subVectors(info.point, _a2);
    if (n.lengthSq() < 1e-6) return;
    n.normalize();
    const hit = this.surfaceRay(e, info.part, info.point.clone().addScaledVector(n, 0.15), n.clone().negate(), 0.32);
    if (!hit) return;
    this.woundDecals.add(e, info.part, hit.bone, hit.point, hit.normal, info.dir, 0.1 + Math.min(0.07, info.speed * 0.005), 'gash', this.t, 2.5);
  }

  /** his voice, at most one cry per ~half second per man (the audio engine also limits the crowd) */
  vocal(e: Enemy, kind: 'pain' | 'scream' | 'death' | 'gurgle', I = 0.6) {
    if (e.kind === 'hero') return;
    const gap = kind === 'pain' ? 0.6 : kind === 'scream' ? 0.3 : 0;
    if (this.t - e.lastVocalT < gap) return;
    e.lastVocalT = this.t;
    const pan = audio.pan(e.pose[P.Head].c);
    if (kind === 'pain') audio.pain(e.id, e.voice, I, pan);
    else if (kind === 'scream') audio.scream(e.id, e.voice, I, pan);
    else if (kind === 'death') audio.deathCry(e.id, e.voice, pan, false);
    else audio.gurgle(e.id, e.voice, pan, 1.1);
  }

  // -- stabs (driven by the stab system in weapons) --
  /** The wooer's realistic body, posed as he stands this instant (for surface rays). */
  skinOf(e: Enemy): SkinnedBody | null {
    const b = this.bodies[e.slot];
    if (!b) return null;
    // a ragdoll's pose is read at render time — bring it up to this physics step first
    if (e.ragdoll && (e.dead || e.state === 'down')) readRagdoll(e.ragdoll, e.pose);
    b.apply(e.pose);
    return b;
  }

  /** The outermost surface of a wooer along a ray — his worn layers (chiton, cuirass, cloak…) or the realistic skin of
   *  that part — so a wound decal sits where it can be seen. */
  surfaceRay(e: Enemy, part: number, origin: THREE.Vector3, dir: THREE.Vector3, far: number): { point: THREE.Vector3; normal: THREE.Vector3; bone: THREE.Object3D | null } | null {
    const s = this.skinOf(e)?.surfaceRay(part, origin, dir, far) ?? null;
    const l = this.renderer.surfaceRay(e.slot, origin, dir, far);
    if (s && (!l || s.point.distanceTo(origin) <= l.dist)) return s;
    return l ? { point: l.point, normal: l.normal, bone: null } : null;
  }

  /** Where the point went in decides how long he lives with it. */
  vitalOf(e: Enemy, part: number, entry: THREE.Vector3, neck: boolean): Vital {
    if (part === P.Head) return neck ? 'throat' : 'face';
    if (part === P.Torso) {
      if (neck) return 'throat';
      const tp = e.pose[P.Torso];
      const loc = _a1.copy(entry).sub(tp.c).applyQuaternion(_aq.copy(tp.q).invert()).multiplyScalar(1 / e.look.scale);
      if (loc.x > -0.04 && loc.x < 0.15 && loc.y > -0.05 && loc.y < 0.17) return 'heart'; // his left breast (+X)
      return loc.y < -0.08 ? 'gut' : 'chest';
    }
    if (part === P.Pelvis) return 'gut';
    return 'limb';
  }

  /** A blade lodged in a living wooer: he's held on it, clutches it, cries out. */
  impaleStart(e: Enemy, weaponId: number, part: number, vital: Vital) {
    if (e.dead) return;
    const wasBroken = e.state === 'broken';
    e.attack = null;
    e.chainDir = null; e.riposteDir = null;
    this.setState(e, 'impaled');
    const mortal = e.kind !== 'boss' || wasBroken || e.hp < e.maxHp * 0.3;
    e.impale = {
      weaponId, part, vital, t0: this.t, dieAt: Infinity, dropAt: Infinity,
      // a limb wound he tears himself off; Antinous wrenches free almost at once (unless he's broken or spent)
      freeAt: !mortal ? this.t + 0.45 : vital === 'limb' ? this.t + 1.0 : vital === 'gut' ? this.t + 3.2 : this.t + 6,
      wantFree: false, through: false, depth: 0, nextGroanT: this.t + 1.1, mortal,
    };
    if (vital === 'throat') this.vocal(e, 'gurgle');
    else if (vital !== 'face') this.vocal(e, 'scream', 0.85);
    e.flinch = { t: this.t, dir: e.forward.clone().negate(), amount: 1 };
  }

  /** The blade's current depth in him (m) and whether the point is out of his back: mortal wounds start the clock. */
  impaleDepth(e: Enemy, depth: number, through: boolean) {
    const im = e.impale;
    if (!im || e.dead) return;
    im.depth = Math.max(im.depth, depth);
    const firstThrough = through && !im.through;
    if (through) im.through = true;
    let die = Infinity;
    switch (im.vital) {
      case 'face': if (depth >= 0.05) die = 0.1; break;
      case 'throat': if (depth >= 0.04) die = 0.55; break;
      case 'heart': if (depth >= 0.07) die = 0.35; break;
      case 'chest': if (im.through || depth >= 0.22) die = 0.6; break;
      case 'gut': if (im.through) die = 0.9; else if (depth >= 0.18) die = 2.4; break;
      default: break;
    }
    if (die < Infinity && im.mortal) im.dieAt = Math.min(im.dieAt, this.t + die);
    if (depth >= 0.1 && im.vital !== 'limb') im.dropAt = Math.min(im.dropAt, this.t + 0.35);
    if (firstThrough) { this.vocal(e, im.vital === 'throat' ? 'gurgle' : 'scream', 1); e.flinch = { t: this.t, dir: e.forward.clone().negate(), amount: 1 }; }
  }

  /** The blade moves a living man on it: shift him (m), lift him (m), turn him (rad), re-posed at once. */
  moveImpaled(e: Enemy, dx: number, dz: number, dLift: number, dYaw: number) {
    e.pos.x += dx; e.pos.z += dz;
    e.impaleLift += dLift;
    e.anim.bob += dLift / e.look.scale;
    e.yaw += dYaw;
    e.forward.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
    solvePose(e.pose, e.pos, e.yaw, e.look.scale, e.anim);
  }

  /** The blade came out of a living man: a mortal wound drops him there; otherwise he staggers back, bleeding. */
  impaleEnd(e: Enemy, how: 'pull' | 'tear', weaponId: number) {
    const im = e.impale;
    if (!im || e.dead || im.weaponId !== weaponId) return;
    e.impale = null;
    const pt = jointPoint(e.pose, im.part, new THREE.Vector3());
    const info: HitInfo = { amount: 0, zone: PART_ZONE[im.part], part: im.part, point: pt, dir: e.forward.clone().negate(), speed: 1, sharp: true, source: 'melee', impulse: 25, weaponEntId: weaponId };
    if (im.dieAt < Infinity) {
      this.kill(e, info, { decapitated: false, finisher: false, severed: null, impaled: im.through ? 'through' : im.vital });
      return;
    }
    if (how === 'tear') { e.hp -= e.kind === 'boss' ? 8 : 12; this.vocal(e, 'scream', 1); } else this.vocal(e, 'pain', 0.9);
    const deep = im.vital === 'gut' || im.vital === 'chest' || im.vital === 'heart';
    e.woundBleedUntil = this.t + (deep ? 5 : 3);
    e.woundBleedRate = deep ? (im.depth > 0.12 ? 6 : 3.5) : 1.5;
    if (e.hp <= 0) { this.kill(e, info, { decapitated: false, finisher: false, severed: null, impaled: im.vital }); return; }
    if (e.state === 'down') return; // knocked down on the blade: his ragdoll gets up through updateDown, not a stagger
    e.staggerT = this.t;
    this.setState(e, 'stagger', e.kind === 'boss' ? 0.5 : 0.8);
    e.knock.addScaledVector(_v.copy(e.forward).setY(0).normalize(), -0.85);
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
      const body = this.bodies[e.slot];
      if (body) { body.apply(e.pose); body.setFlash(this.renderer.flash[e.slot]); }
      for (const g of e.gibs) { const p = e.pose[g.part]; g.mesh.position.copy(p.c); g.mesh.quaternion.copy(p.q); }
      this.renderer.write(e.slot, e.pose, e.look, {
        shieldBroken: e.shieldHp <= 0,
        forward: e.dead || e.state === 'down' ? undefined : e.forward,
        propVisible: e.armed && !e.severed.has(P.LArmR),
        stumps: e.stumps,
        broken: e.state === 'broken',
        skinned: !!body,
        shells: !!body?.hasShell,
        head: body ? body.headAnchor(this.headTmp) : null,
      });
    }
    this.renderer.commit();
    this.woundDecals.render(this.list, this.t);
  }
}
