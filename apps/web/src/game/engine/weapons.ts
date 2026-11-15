import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WEAPON_CLASSES, type Hand, type WeaponClass, type WeaponSpawn, type WeaponClassSpec } from '@ithaca/shared';
import { RAPIER, GROUPS } from './physics';
import { HALL } from './hall';
import { P } from './humanoid';
import type { Enemy, EnemyManager, HitInfo, HitResult } from './enemies';
import type { Fx } from './fx';
import { audio } from './audio';
import { PREFAB_BUILDERS, buildArrow, buildAspis, buildBlade, buildBowStave, buildSpear } from './weaponGeo';
import { StabSystem, stabProfile } from './stab';
import { ballisticDir, basisQuat, clamp, rand, rotateToward } from './math';

export type WClass = WeaponClass | 'bow' | 'arrow';
/** 'lodged': left in a man's body (it rides on him until you take it back) */
type WState = 'racked' | 'held' | 'free' | 'pinned' | 'stuck' | 'incoming' | 'lodged' | 'gone';

const DAMAGE_K = 4.5;
const BOW_SPEC: WeaponClassSpec = { lengthM: 1.25, massKg: 1.0, damage: 0.8, sharp: false, throwMult: 1.3, grip: 'center', examples: [] };
const ARROW_SPEC: WeaponClassSpec = { lengthM: 0.78, massKg: 0.15, damage: 2.0, sharp: true, throwMult: 1.6, grip: 'center', examples: [] };
const DAGGER_SPEC: WeaponClassSpec = { ...WEAPON_CLASSES.sword, lengthM: 0.72, massKg: 1.1 };
const HELD_MULT = 1.5; // melee feel: a held weapon's swing carries the arm's mass too
const FIST = { massKg: 1.1, damage: 0.9 };

export interface WeaponEnt {
  id: number;
  key: string;
  cls: WClass;
  spec: WeaponClassSpec;
  name: string;
  forged: WeaponSpawn | null;
  obj: THREE.Object3D | null;
  body: InstanceType<typeof RAPIER.RigidBody>;
  collider: InstanceType<typeof RAPIER.Collider>;
  state: WState;
  hand: Hand | null;
  rackPose: { pos: THREE.Vector3; quat: THREE.Quaternion } | null;
  rackKind: 'bow' | 'dagger' | 'spear' | 'forged' | 'shield' | null;
  attachT?: number;
  segA: THREE.Vector3; segB: THREE.Vector3; radius: number;
  prevTip: THREE.Vector3; prevCenter: THREE.Vector3; tip: THREE.Vector3; center: THREE.Vector3;
  /** last step's world blade segment (hilt end → gameplay tip), for swept cut tests */
  segPrevA: THREE.Vector3; segPrevB: THREE.Vector3; segPrevT: number;
  speed: number;
  prevVel: THREE.Vector3;
  thrownAt: number; throwOrigin: THREE.Vector3;
  staticHits: number;
  throwKills: number[];
  alignFlight: boolean;
  pin: { joint: InstanceType<typeof RAPIER.ImpulseJoint>; until: number; enemy: Enemy } | null;
  durability: number;
  kills: number;
  restT: number;
  incoming: { from: THREE.Vector3; to: THREE.Vector3; ctrl: THREE.Vector3; t: number; dur: number; toHand: Hand | null; quatFrom: THREE.Quaternion } | null;
  returnToSender: boolean;
  /** thrown/dropped by the player (dropped wooer weapons never deal damage while tumbling) */
  byPlayer: boolean;
  hitCd: Map<number, number>;
  spinDir: number;
}

export interface WeaponHooks {
  onHit(w: WeaponEnt | null, r: HitResult, info: HitInfo): void;
  onPinned(w: WeaponEnt, enemy: Enemy): void;
  onStatic(w: WeaponEnt): void;
  onBroken(w: WeaponEnt): void;
  onExplode(w: WeaponEnt, killed: Enemy[]): void;
  onHeal(amount: number): void;
  onForgedArrive(w: WeaponEnt, toHand: boolean): void;
  onParry(pos: THREE.Vector3): void;
  onRecoil(hand: Hand, dir: THREE.Vector3, dist: number, dampMs: number): void;
  /** keyboard/mouse swings are slower than real arms: thresholds × this */
  speedScale(): number;
  /** quiver empty */
  onArrowsSpent?(): void;
  /** the hand the mouse is driving (keyboard/mouse), or null */
  drivenHand?(): Hand | null;
  /** keyboard/mouse cut cap for a held blade: max strike speed from the cursor, and whether this blade is driven */
  cutCap?(hand: Hand): { vCap: number; driven: boolean } | null;
  onChamber(w: WeaponEnt, at: THREE.Vector3): void;
  hitstop(ms: number): void;
  shake(v: number): void;
  playerPos(): THREE.Vector3;
  kbPull(): boolean;
}

export interface HandView {
  side: Hand;
  pos: THREE.Vector3;       // world
  quat: THREE.Quaternion;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  vel: THREE.Vector3;       // world m/s (real time)
  grip: number;
  visible: boolean;
}

type World = InstanceType<typeof RAPIER.World>;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _st1 = new THREE.Vector3();
const _st2 = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// ── arrow instancing (player + enemy arrows, 1 draw call) ─────────────────
class ArrowInstancer {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  constructor(cap = 64) {
    const g = buildArrow(0.78);
    g.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      let geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
      geo = geo.index ? geo.toNonIndexed() : geo;
      for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
      const col = new THREE.Color(m.name === 'head' ? '#a07a45' : m.name === 'fletch' ? '#8a2a1a' : '#cdbf9e');
      const arr = new Float32Array(geo.attributes.position.count * 3);
      for (let i = 0; i < geo.attributes.position.count; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(geo);
    });
    const merged = mergeGeometries(parts);
    this.mesh = new THREE.InstancedMesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide }), cap);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }
  begin() { this.n = 0; }
  push(pos: THREE.Vector3, quat: THREE.Quaternion) {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    this.mesh.setMatrixAt(this.n++, _m.compose(pos, quat, _v3.set(1, 1, 1)));
  }
  pushDir(tail: THREE.Vector3, dir: THREE.Vector3) {
    _q.setFromUnitVectors(Y, _v2.copy(dir).normalize());
    this.push(tail, _q);
  }
  end() { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; }
}

// ── forged GLB normalization ──────────────────────────────────────────────
const loader = new GLTFLoader();
const glbCache = new Map<string, Promise<THREE.Object3D>>();

/** A weapon lying on the table: local +Y (blade/shaft axis) along `axis`, local +Z toward `face`. */
function lyingQuat(axis: THREE.Vector3, face: THREE.Vector3) {
  const y = axis.clone().normalize();
  const z = face.clone().addScaledVector(y, -face.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

const HOVER = new THREE.Color('#c8902a');
function glow(o: THREE.Object3D, k: number) {
  o.traverse((m) => {
    const mat = (m as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!mat || !('emissive' in mat)) return;
    if (!mat.userData.baseEmissive) mat.userData.baseEmissive = mat.emissive.clone();
    mat.emissive.copy(mat.userData.baseEmissive as THREE.Color).lerp(HOVER, k);
  });
}

function loadGlb(url: string, timeoutMs = 8000): Promise<THREE.Object3D> {
  const hit = glbCache.get(url);
  if (hit) return hit.then((o) => o.clone(true));
  const p = new Promise<THREE.Object3D>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('glb timeout')), timeoutMs);
    loader.load(url, (g) => { clearTimeout(timer); resolve(g.scene); }, undefined, (err) => { clearTimeout(timer); reject(err); });
  });
  glbCache.set(url, p);
  p.catch(() => glbCache.delete(url));
  return p.then((o) => o.clone(true));
}

/**
 * Center + orient + scale an arbitrary GLB into the canonical weapon frame (spec A.4.2):
 * longest axis → +Y scaled to lengthM (shields: thinnest axis → +Y); 'end' grip at the thinner end.
 * Returns the object and its vertex points (for a convex-hull collider).
 */
function normalizeModel(src: THREE.Object3D, cls: WeaponClass): { obj: THREE.Group; points: Float32Array; vertexCount: number } {
  const spec = WEAPON_CLASSES[cls];
  src.updateMatrixWorld(true);
  const pts: THREE.Vector3[] = [];
  let vertexCount = 0;
  src.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    const pos = m.geometry.attributes.position;
    vertexCount += pos.count;
    const stride = Math.max(1, Math.floor(pos.count / 1500));
    for (let i = 0; i < pos.count; i += stride) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    m.castShadow = false;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) (mat as THREE.MeshStandardMaterial).envMapIntensity = 0.8;
  });
  if (!pts.length) pts.push(new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0, 0.1, 0));
  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const axes = [size.x, size.y, size.z];
  const pickAxis = cls === 'shield' ? axes.indexOf(Math.min(...axes)) : axes.indexOf(Math.max(...axes));
  const rot = new THREE.Quaternion();
  if (pickAxis === 0) rot.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  else if (pickAxis === 2) rot.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const longest = Math.max(...axes) || 1;
  const scale = spec.lengthM / longest;
  const local = pts.map((p) => p.clone().sub(center).applyQuaternion(rot).multiplyScalar(scale));
  // thin end detection for 'end' grips: compare cross-section spread at both ends
  let flip = false;
  let gripY = 0;
  if (spec.grip === 'end') {
    let yMin = Infinity, yMax = -Infinity;
    for (const p of local) { yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y); }
    const span = yMax - yMin || 1;
    let lo = 0, loN = 0, hi = 0, hiN = 0;
    for (const p of local) {
      const r = Math.hypot(p.x, p.z);
      if (p.y < yMin + span * 0.22) { lo += r; loN++; }
      else if (p.y > yMax - span * 0.22) { hi += r; hiN++; }
    }
    const loR = loN ? lo / loN : 0, hiR = hiN ? hi / hiN : 0;
    flip = hiR < loR; // thinner end should be at the bottom (grip)
    gripY = (flip ? -yMax : yMin) + span * (cls === 'spear' ? 0.3 : 0.1);
  }
  const finalRot = flip ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI).multiply(rot) : rot;
  const outPts = new Float32Array(local.length * 3);
  local.forEach((p, i) => {
    if (flip) { p.y = -p.y; p.z = -p.z; }
    p.y -= gripY;
    outPts[i * 3] = p.x; outPts[i * 3 + 1] = p.y; outPts[i * 3 + 2] = p.z;
  });
  const holder = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(src);
  src.position.sub(center);
  inner.quaternion.copy(finalRot);
  inner.scale.setScalar(scale);
  inner.position.set(0, -gripY, 0);
  holder.add(inner);
  return { obj: holder, points: outPts, vertexCount };
}

// ── manager ───────────────────────────────────────────────────────────────
export class WeaponManager {
  readonly group = new THREE.Group();
  readonly list: WeaponEnt[] = [];
  readonly arrows = new ArrowInstancer();
  private byCollider = new Map<number, WeaponEnt>();
  private nextId = 1;
  private held: Record<Hand, WeaponEnt | null> = { left: null, right: null };
  private bowString: THREE.Mesh[] = [];
  private bowTips: { top: THREE.Vector3; bottom: THREE.Vector3 } | null = null;
  drawing = false;
  bowDraw = 0;
  blocking = false;
  private daggerTimer = 0;
  private spearTimer = 0;
  private shieldTimer = 0;
  private dualClashT = -9;
  /** realT of the last guard raise/lower — swings into/out of guard never count as cuts */
  guardChangeT = -9;
  /** arrows left in the quiver (12 at the start, +6 each wave) */
  quiver = 12;
  t = 0;
  realT = 0;
  private speedHist = new Map<number, { t: number; sp: number; x: number; y: number; z: number }[]>();
  private nockedArrow = { show: false, tail: new THREE.Vector3(), dir: new THREE.Vector3() };
  private eventQueue: InstanceType<typeof RAPIER.EventQueue>;
  /** Blade & Sorcery-style stabs: held points that go in, stay in, and come out */
  readonly stabs: StabSystem;

  constructor(private world: World, private enemies: EnemyManager, private fx: Fx, private hooks: WeaponHooks, private staticHandles: Set<number>) {
    this.eventQueue = new RAPIER.EventQueue(true);
    this.stabs = new StabSystem(world, enemies, fx, {
      hitstop: (ms) => this.hooks.hitstop(ms),
      shake: (v) => this.hooks.shake(v),
      freeWeapon: (w, v) => this.freeLodged(w, v),
      speedScale: () => this.hooks.speedScale(),
    });
    this.group.add(this.arrows.mesh);
    const strMat = new THREE.MeshStandardMaterial({ color: '#8f8068', roughness: 0.6 });
    for (let i = 0; i < 2; i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.0014, 0.0014, 1, 4), strMat);
      s.visible = false;
      s.renderOrder = 3;
      this.group.add(s);
      this.bowString.push(s);
    }
  }

  get queue() { return this.eventQueue; }
  heldBy(h: Hand) { return this.held[h]; }
  holds(cls: WClass) { return this.held.left?.cls === cls || this.held.right?.cls === cls; }

  // ── creation ──
  private create(cls: WClass, spec: WeaponClassSpec, obj: THREE.Object3D | null, name: string, shape: { points?: Float32Array; vertexCount?: number } = {}): WeaponEnt {
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setCcdEnabled(true).setLinearDamping(0.05).setAngularDamping(0.4);
    const body = this.world.createRigidBody(bodyDesc);
    // collider from geometry bounds (or convex hull for forged models)
    let colDesc: InstanceType<typeof RAPIER.ColliderDesc> | null = null;
    const box = new THREE.Box3();
    if (obj) { obj.updateMatrixWorld(true); box.setFromObject(obj); }
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.02, 0, -0.02), new THREE.Vector3(0.02, spec.lengthM, 0.02));
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    if (shape.points && (shape.vertexCount ?? 0) <= 6000 && shape.points.length >= 12) colDesc = RAPIER.ColliderDesc.convexHull(shape.points);
    if (!colDesc) {
      if (cls === 'throwable' || cls === 'bomb') colDesc = RAPIER.ColliderDesc.ball(Math.max(size.x, size.y, size.z) / 2).setTranslation(c.x, c.y, c.z);
      else colDesc = RAPIER.ColliderDesc.cuboid(Math.max(0.01, size.x / 2), Math.max(0.01, size.y / 2), Math.max(0.01, size.z / 2)).setTranslation(c.x, c.y, c.z);
    }
    colDesc.setMass(spec.massKg).setFriction(0.7).setRestitution(cls === 'throwable' ? 0.55 : 0.2)
      .setCollisionGroups(GROUPS.none).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(colDesc, body);
    // hit segment in local frame
    let segA: THREE.Vector3, segB: THREE.Vector3, radius: number;
    if (cls === 'shield') { segA = new THREE.Vector3(-spec.lengthM * 0.35, 0, 0); segB = new THREE.Vector3(spec.lengthM * 0.35, 0, 0); radius = spec.lengthM * 0.2; }
    else if (spec.grip === 'center' && cls !== 'bow' && cls !== 'arrow') { segA = new THREE.Vector3(0, -0.02, 0); segB = new THREE.Vector3(0, 0.02, 0); radius = Math.max(0.06, spec.lengthM * 0.45); }
    else if (cls === 'bow') { segA = new THREE.Vector3(0, -0.55, 0); segB = new THREE.Vector3(0, 0.55, 0); radius = 0.04; }
    else if (cls === 'arrow') { segA = new THREE.Vector3(0, 0.45, 0); segB = new THREE.Vector3(0, 0.78, 0); radius = 0.03; }
    else { segA = new THREE.Vector3(0, Math.max(box.min.y, 0) + size.y * 0.35, 0); segB = new THREE.Vector3(0, box.max.y * 0.98, 0); radius = clamp(Math.max(size.x, size.z) * 0.5, 0.035, 0.18); }
    const w: WeaponEnt = {
      id: this.nextId++, key: `${cls}-${this.nextId}`, cls, spec, name, forged: null, obj, body, collider,
      state: 'racked', hand: null, rackPose: null, rackKind: null,
      segA, segB, radius, prevTip: new THREE.Vector3(), prevCenter: new THREE.Vector3(), tip: new THREE.Vector3(), center: new THREE.Vector3(),
      segPrevA: new THREE.Vector3(), segPrevB: new THREE.Vector3(), segPrevT: -1,
      speed: 0, prevVel: new THREE.Vector3(), thrownAt: 0, throwOrigin: new THREE.Vector3(), staticHits: 0, throwKills: [],
      alignFlight: false, pin: null, durability: 9999, kills: 0, restT: 0, incoming: null, returnToSender: false, hitCd: new Map(), spinDir: 1, byPlayer: true,
    };
    if (obj) {
      obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).castShadow = false; } });
      this.group.add(obj);
    }
    this.byCollider.set(collider.handle, w);
    this.list.push(w);
    return w;
  }

  private setKinematic(w: WeaponEnt, groups: number) {
    w.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    w.collider.setCollisionGroups(groups);
  }
  private setDynamic(w: WeaponEnt) {
    w.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    w.collider.setCollisionGroups(GROUPS.weapon);
    w.body.enableCcd(true);
  }
  private place(w: WeaponEnt, pos: THREE.Vector3, quat: THREE.Quaternion) {
    w.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    w.body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
    w.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    w.body.setNextKinematicRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
  }

  private rack(w: WeaponEnt) {
    if (!w.rackPose) return;
    w.state = 'racked';
    w.hand = null;
    this.setKinematic(w, GROUPS.none);
    this.place(w, w.rackPose.pos, w.rackPose.quat);
  }

  /**
   * The weapon table in front of Odysseus (top view, player at the origin facing −Z):
   *   aspis leaning on the left end · two xiphoi side by side, hilts toward you (dual wield) ·
   *   the Bow of Odysseus along the front-right · a spear across the back.
   */
  spawnStarterKit() {
    const top = HALL.rackTop, rz = HALL.rackZ;
    const bow = buildBowStave();
    const bw = this.create('bow', BOW_SPEC, bow.group, 'Bow of Odysseus');
    this.bowTips = { top: bow.tipTop, bottom: bow.tipBottom };
    bw.rackKind = 'bow';
    // standing at the table's right end, string toward you
    bw.rackPose = { pos: new THREE.Vector3(0.6, 0.66, rz - 0.08), quat: lyingQuat(new THREE.Vector3(0.06, 1, 0), new THREE.Vector3(-0.4, 0, 1)) };
    this.rack(bw);
    this.spawnDagger(0);
    this.spawnDagger(1);
    this.spawnSpear();
    this.spawnShield();
  }

  private daggerSlot(i: number) {
    // hilts at the front edge, blades pointing away and fanned slightly outward
    // a mirrored pair, hilts at the front edge 0.32 m apart, blades fanned slightly outward
    const dir = i === 0 ? new THREE.Vector3(-0.12, 0, -1) : new THREE.Vector3(0.12, 0, -1);
    return { pos: new THREE.Vector3(i === 0 ? -0.16 : 0.16, HALL.rackTop + 0.022, -0.56), quat: lyingQuat(dir, new THREE.Vector3(0, 1, 0)) };
  }
  private spawnShield() {
    const w = this.create('shield', WEAPON_CLASSES.shield, buildAspis(0.8), 'Aspis of Ithaca');
    w.rackKind = 'shield';
    // leaning against the table's left end, face toward Odysseus
    // lying face-up on the left of the table, tipped toward you
    w.rackPose = { pos: new THREE.Vector3(-0.52, HALL.rackTop + 0.05, HALL.rackZ - 0.02), quat: lyingQuat(new THREE.Vector3(0.1, 1, 0.35), new THREE.Vector3(0, 0, -1)) };
    this.rack(w);
    return w;
  }
  private spawnDagger(i: number) {
    const g = buildBlade(DAGGER_SPEC.lengthM);
    const w = this.create('sword', DAGGER_SPEC, g, 'Xiphos of Ithaca');
    w.rackKind = 'dagger';
    w.rackPose = this.daggerSlot(i);
    this.rack(w);
    return w;
  }
  private spawnSpear() {
    const holder = new THREE.Group();
    const s = buildSpear(1.8);
    s.position.y = -0.62; // grip at the balance point for a javelin throw
    holder.add(s);
    const w = this.create('spear', WEAPON_CLASSES.spear, holder, 'Spear of Ithaca');
    w.rackKind = 'spear';
    // standing against the table's right end beside the bow, point up
    w.rackPose = { pos: new THREE.Vector3(0.78, 0.9, HALL.rackZ - 0.12), quat: lyingQuat(new THREE.Vector3(-0.08, 1, 0.04), new THREE.Vector3(0, 0, 1)) };
    this.rack(w);
    return w;
  }

  /** Forged weapon from Telemachus: load → normalize → fly in from the storeroom. */
  async spawnForged(ws: WeaponSpawn, dominantOpen: () => Hand | null): Promise<WeaponEnt> {
    const cls = ws.weaponClass;
    let obj: THREE.Object3D | null = null;
    let points: Float32Array | undefined;
    let vertexCount = 0;
    const tryUrl = async (url: string) => {
      const raw = await loadGlb(url);
      const n = normalizeModel(raw, cls);
      obj = n.obj; points = n.points; vertexCount = n.vertexCount;
    };
    try { await tryUrl(ws.glbUrl); } catch (err) {
      console.warn('[weapons] forged GLB failed, using prefab', err);
      try { await tryUrl(`/prefabs/${cls}.glb`); } catch {
        obj = PREFAB_BUILDERS[cls]();
      }
    }
    const w = this.create(cls, WEAPON_CLASSES[cls], obj, ws.displayName, { points, vertexCount });
    w.forged = ws;
    w.key = ws.weaponId;
    w.durability = cls === 'throwable' ? 3 : cls === 'shield' ? 30 : 22;
    w.rackKind = 'forged';
    w.rackPose = {
      pos: new THREE.Vector3(0.36, HALL.rackTop + 0.08, HALL.rackZ),
      quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
    };
    // glow material accent
    const from = HALL.storeroom.clone().add(new THREE.Vector3(-0.4, 0.2, 0));
    const hand = dominantOpen();
    w.state = 'incoming';
    this.setKinematic(w, GROUPS.none);
    const to = hand ? new THREE.Vector3() : w.rackPose.pos.clone();
    w.incoming = { from, to, ctrl: new THREE.Vector3(), t: 0, dur: 0.28, toHand: hand, quatFrom: new THREE.Quaternion() };
    this.place(w, from, w.incoming.quatFrom);
    return w;
  }

  // ── hover (keyboard/mouse): the weapon the cursor points at glows brass ──
  private hovered: WeaponEnt | null = null;
  /** Same test as the pull-grab, without taking it. */
  pickRay(aimRay: { origin: THREE.Vector3; dir: THREE.Vector3 }): WeaponEnt | null {
    let best: WeaponEnt | null = null, bestScore = Infinity;
    const end = new THREE.Vector3().copy(aimRay.origin).addScaledVector(aimRay.dir, 4);
    for (const w of this.list) {
      if ((w.state !== 'racked' && w.state !== 'free') || w.cls === 'arrow') continue;
      const gp = this.gripWorld(w, new THREE.Vector3());
      const along = new THREE.Vector3().subVectors(gp, aimRay.origin).dot(aimRay.dir);
      if (along < 0.2 || along > 3.5) continue;
      const perp = Math.sqrt(segSegDistLocal(aimRay.origin, end, gp, w.tip.lengthSq() > 0 ? w.tip : gp));
      const tol = 0.1 + along * 0.05;
      if (perp < tol && perp / tol < bestScore) { bestScore = perp / tol; best = w; }
    }
    return best;
  }
  setHover(w: WeaponEnt | null, t: number) {
    if (this.hovered !== w) {
      if (this.hovered?.obj) glow(this.hovered.obj, 0);
      this.hovered = w;
    }
    if (w?.obj && w.state !== 'held') glow(w.obj, 0.55 + 0.25 * Math.sin(t * Math.PI * 4));
  }

  // ── hand interaction ──
  grab(h: HandView, aimRay?: { origin: THREE.Vector3; dir: THREE.Vector3 }, rayOnly = false) {
    if (this.held[h.side]) return;
    const moving = h.vel.length() > 0.4;
    let best: WeaponEnt | null = null;
    let bestD = Infinity;
    for (const w of rayOnly ? [] : this.list) {
      if (w.state !== 'racked' && w.state !== 'free' && w.state !== 'lodged') continue;
      if (w.cls === 'arrow') continue;
      const gp = this.gripWorld(w, _v);
      const d = gp.distanceTo(h.pos);
      let r = 0.35;
      if (moving && _v2.subVectors(gp, h.pos).dot(h.vel) > 0) r = 0.5;
      if (d < r && d < bestD) { best = w; bestD = d; }
    }
    // return-to-sender: snatch an enemy arrow out of the air
    if (!best && !rayOnly) {
      const ar = this.enemies.catchArrow(h.pos, 0.42);
      if (ar) {
        const w = this.create('arrow', ARROW_SPEC, null, 'Returned Arrow');
        w.returnToSender = true;
        this.attach(w, h);
        this.fx.sparks(h.pos, null, 10, '#fff1b8');
        audio.parry();
        return;
      }
    }
    // keyboard/mouse "gravity pull": point at a weapon and grab it from range
    if (!best && aimRay && this.hooks.kbPull()) {
      let bestRay = 0.2;
      for (const w of this.list) {
        if ((w.state !== 'racked' && w.state !== 'free' && w.state !== 'lodged') || w.cls === 'arrow') continue;
        // point anywhere along the weapon (grip → point), not just at its grip
        const gp = this.gripWorld(w, _v);
        const rayEnd = _v3.copy(aimRay.origin).addScaledVector(aimRay.dir, 4);
        const perp = Math.sqrt(segSegDistLocal(aimRay.origin, rayEnd, gp, w.tip.lengthSq() > 0 ? w.tip : gp));
        const along = _v2.subVectors(gp, aimRay.origin).dot(aimRay.dir);
        if (along < 0.2 || along > 3.5) continue;
        const tol = 0.1 + along * 0.05;
        if (perp < tol && perp / tol < bestRay / 0.2 + 1e-6) { best = w; bestRay = (perp / tol) * 0.2; }
      }
      // a dropped blade on the floor is usually below the view: take the nearest free weapon within 2.5 m
      // whose bearing is within 35° of where you're pointing
      if (!best) {
        let bestScore = Infinity;
        const fx = aimRay.dir.x, fz = aimRay.dir.z, fl = Math.hypot(fx, fz) || 1;
        for (const w of this.list) {
          if (w.state !== 'free' || w.cls === 'arrow') continue;
          const gp = this.gripWorld(w, _v);
          const dx = gp.x - aimRay.origin.x, dz = gp.z - aimRay.origin.z, dl = Math.hypot(dx, dz);
          if (dl > 2.5 || dl < 1e-3) continue;
          const cos = (dx * fx + dz * fz) / (dl * fl);
          if (cos < Math.cos(THREE.MathUtils.degToRad(35))) continue;
          const score = dl * (2 - cos);
          if (score < bestScore) { bestScore = score; best = w; }
        }
      }
      if (best) {
        const w = best;
        const from = this.gripWorld(w, new THREE.Vector3());
        const quatFrom = w.body.rotation();
        w.state = 'incoming';
        this.setKinematic(w, GROUPS.none);
        w.incoming = { from, to: new THREE.Vector3(), ctrl: new THREE.Vector3(), t: 0, dur: 0.14, toHand: h.side, quatFrom: new THREE.Quaternion(quatFrom.x, quatFrom.y, quatFrom.z, quatFrom.w) };
        audio.whoosh(3);
        return;
      }
    }
    if (best) this.attach(best, h);
  }

  private attach(w: WeaponEnt, h: HandView) {
    w.byPlayer = true;
    if (w.pin) { try { this.world.removeImpulseJoint(w.pin.joint, true); } catch { /* gone */ } w.pin = null; }
    const wasLodged = w.state === 'lodged';
    w.state = 'held';
    w.hand = h.side;
    w.incoming = null;
    this.held[h.side] = w;
    w.attachT = this.realT;
    this.setKinematic(w, GROUPS.held);
    w.hitCd.clear();
    if (wasLodged) this.stabs.regrab(w); // your hand closes on the hilt still in him
    audio.metal(0.3, 1900);
    if (w.cls === 'bow') audio.lyre([0], 0, 196);
  }

  /** what each hand holds moves to the other (the sword goes right so the aspis can go on the left arm) */
  swapHands() {
    const L = this.held.left, R = this.held.right;
    if (L?.cls === 'bow' || R?.cls === 'bow') return;
    this.held.left = R; this.held.right = L;
    if (L) L.hand = 'right';
    if (R) R.hand = 'left';
  }

  release(side: Hand, velBody: THREE.Vector3, h: HandView) {
    const w = this.held[side];
    if (!w) return;
    this.held[side] = null;
    w.hand = null;
    if (w.cls === 'bow') { this.drawing = false; }
    // let go of a blade that's in a man: it stays in him (a throw rips it out)
    if (this.stabs.onRelease(w, velBody)) { w.state = 'lodged'; w.restT = 0; return; }
    const speed = velBody.length();
    this.setDynamic(w);
    w.state = 'free';
    w.staticHits = 0;
    w.throwKills = [];
    w.thrownAt = this.t;
    w.throwOrigin.copy(this.hooks.playerPos());
    w.restT = 0;
    w.hitCd.clear();
    if (speed > 1.2) {
      // THROW: v × throwMult, 10° aim assist toward the nearest torso (ballistic-compensated)
      const v = _v.copy(velBody).multiplyScalar(w.spec.throwMult);
      const sp = v.length();
      const dir = _v2.copy(v).normalize();
      const target = new THREE.Vector3();
      const origin = this.gripWorld(w, _v3).clone();
      const enemy = this.enemies.nearestTorso(origin, dir, THREE.MathUtils.degToRad(10), target);
      if (enemy) {
        const bal = ballisticDir(origin, target, sp, 9.81);
        if (bal) dir.copy(bal);
        else rotateToward(dir, target.sub(origin), THREE.MathUtils.degToRad(10));
      }
      const lv = dir.multiplyScalar(sp);
      w.body.setLinvel({ x: lv.x, y: lv.y, z: lv.z }, true);
      const long = w.cls === 'spear' || w.cls === 'sword' || w.cls === 'arrow';
      if (long) {
        w.alignFlight = true;
        w.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        _q.setFromUnitVectors(Y, _v.copy(lv).normalize());
        w.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      } else {
        w.alignFlight = false;
        const right = _v.crossVectors(lv, Y).normalize().multiplyScalar(rand(8, 14) * (w.cls === 'shield' ? 0.3 : 1));
        const spinShield = w.cls === 'shield' ? { x: 0, y: 18, z: 0 } : { x: right.x, y: right.y, z: right.z };
        w.body.setAngvel(spinShield, true);
      }
      w.prevVel.copy(lv);
      audio.whoosh(sp * 0.4);
      if (w.cls === 'bomb') audio.lyre([0, 1], 0.04, 880);
    } else {
      w.alignFlight = false;
      w.body.setLinvel({ x: velBody.x, y: velBody.y, z: velBody.z }, true);
      if (w.cls === 'bow') setTimeout(() => { if (w.state === 'free') this.rack(w); }, 1200);
    }
    void h;
  }

  /** Bow nock/draw/loose. */
  nock() {
    const bowHand = this.held.left?.cls === 'bow' ? 'left' : this.held.right?.cls === 'bow' ? 'right' : null;
    if (!bowHand) return false;
    if (this.quiver <= 0) { this.hooks.onArrowsSpent?.(); return false; }
    this.drawing = true;
    audio.bowDraw();
    return true;
  }
  ensureBow(h: HandView): boolean {
    let cur = this.held[h.side];
    if (cur?.cls === 'bow') return true;
    // the bow needs the left hand: a shield or blade there goes back on the table (or is set down)
    if (cur && cur.rackPose) { this.held[h.side] = null; cur.hand = null; this.rack(cur); cur = null; }
    if (cur) return false;
    const bow = this.list.find((w) => w.cls === 'bow' && w.state !== 'gone');
    if (!bow) return false;
    if (bow.hand && bow.hand !== h.side) return true;
    this.attach(bow, h);
    return true;
  }
  dismissBow() {
    for (const side of ['left', 'right'] as const) {
      const w = this.held[side];
      if (w?.cls === 'bow') { this.held[side] = null; this.drawing = false; this.rack(w); }
    }
  }
  loose(draw: number, aim: THREE.Vector3): boolean {
    const bowHand = this.held.left?.cls === 'bow' ? this.held.left : this.held.right?.cls === 'bow' ? this.held.right : null;
    this.drawing = false;
    if (!bowHand || draw < 0.1) return false;
    if (this.quiver <= 0) return false;
    this.quiver--;
    const origin = this.nockedArrow.tail.clone();
    // a tap is a weak plink; only a full draw (≥ 0.85 s) flies true and hard
    const speed = 14 + 46 * draw;
    const dir = aim.clone().normalize();
    const target = new THREE.Vector3();
    const enemy = this.enemies.nearestTorso(origin, dir, THREE.MathUtils.degToRad(4), target);
    if (enemy) {
      const bal = ballisticDir(origin, target, speed, 9.81 * 0.35);
      if (bal) dir.copy(bal);
    }
    const w = this.create('arrow', ARROW_SPEC, null, 'Arrow');
    this.setDynamic(w);
    w.body.setGravityScale(0.35, true);
    w.state = 'free';
    w.alignFlight = true;
    w.thrownAt = this.t;
    w.throwOrigin.copy(this.hooks.playerPos());
    _q.setFromUnitVectors(Y, dir);
    const tail = origin;
    w.body.setTranslation({ x: tail.x, y: tail.y, z: tail.z }, true);
    w.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    const lv = dir.multiplyScalar(speed);
    w.body.setLinvel({ x: lv.x, y: lv.y, z: lv.z }, true);
    w.prevVel.copy(lv);
    audio.bowRelease(draw);
    // cap stuck/old arrows
    const arrows = this.list.filter((x) => x.cls === 'arrow' && x.state !== 'held');
    if (arrows.length > 28) this.remove(arrows[0]);
    return true;
  }

  drink(side: Hand): boolean {
    for (const s of [side, side === 'left' ? 'right' : 'left'] as const) {
      const w = this.held[s];
      if (w?.cls === 'potion') {
        this.held[s] = null;
        this.hooks.onHeal(40);
        audio.heal();
        this.remove(w);
        return true;
      }
    }
    return false;
  }

  shieldHeld() { return this.holds('shield'); }

  /** a blade left in a man falls free (he pulled it out, or his body is gone) */
  private freeLodged(w: WeaponEnt, vel: THREE.Vector3) {
    this.setDynamic(w);
    w.state = 'free';
    w.alignFlight = false;
    w.thrownAt = this.t;
    w.restT = 0;
    w.staticHits = 0;
    w.hitCd.clear();
    w.byPlayer = false; // falling out of him, it doesn't cut anyone
    w.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    w.body.setAngvel({ x: rand(-2, 2), y: rand(-2, 2), z: rand(-2, 2) }, true);
  }

  remove(w: WeaponEnt) {
    if (w.state === 'gone') return;
    this.stabs.forget(w);
    if (w.hand) this.held[w.hand] = null;
    w.state = 'gone';
    if (w.pin) { try { this.world.removeImpulseJoint(w.pin.joint, true); } catch { /* */ } w.pin = null; }
    this.byCollider.delete(w.collider.handle);
    try { this.world.removeRigidBody(w.body); } catch { /* */ }
    if (w.obj) {
      this.group.remove(w.obj);
      w.obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    const i = this.list.indexOf(w);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** New match: fresh starter kit, but gifts from Telemachus that arrived in the lobby stay on the rack. */
  resetForMatch() {
    this.stabs.clear();
    for (const w of [...this.list]) {
      if (w.forged && w.state !== 'gone') { if (w.hand) this.held[w.hand] = null; w.incoming = null; this.rack(w); }
      else this.remove(w);
    }
    this.drawing = false;
    this.spawnStarterKit();
  }

  clearAll() {
    this.stabs.clear();
    for (const w of [...this.list]) this.remove(w);
    this.held.left = this.held.right = null;
    this.drawing = false;
  }

  gripWorld(w: WeaponEnt, out: THREE.Vector3) {
    const t = w.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  // ── per physics step ──
  /** Kinematic targets for held/incoming weapons. Call before world.step(). */
  prestep(hands: Record<Hand, HandView>, realDt: number) {
    for (const w of this.list) {
      if (w.state === 'held' && w.hand) {
        const h = hands[w.hand];
        const q = this.heldQuat(w, h, _q);
        const off = _v.set(0, 0, 0);
        if (w.cls === 'shield') {
          // carried low at the side so it doesn't blind you; raised to center while blocking
          // the hand pose already places it (low at the side; up in front on guard) — small hold offset only
          if (this.blocking) off.set(w.hand === 'left' ? 0.04 : -0.04, 0, -0.03);
          else off.set(w.hand === 'left' ? -0.04 : 0.04, -0.02, 0.02);
        }
        const p = _v2.copy(h.pos).add(off);
        this.stabs.blendHeld(w, p, q, realDt);
        w.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
        w.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      } else if (w.state === 'incoming' && w.incoming) {
        const inc = w.incoming;
        inc.t += realDt / inc.dur;
        const k = Math.min(1, inc.t);
        if (inc.toHand) inc.to.copy(hands[inc.toHand].pos);
        inc.ctrl.copy(inc.from).lerp(inc.to, 0.5).add(_v.set(0, w.forged ? 1.2 : 0.15, 0));
        const e = 1 - Math.pow(1 - k, 3);
        const a = _v.copy(inc.from).lerp(inc.ctrl, e);
        const b = _v2.copy(inc.ctrl).lerp(inc.to, e);
        const p = a.lerp(b, e);
        const targetQ = inc.toHand ? this.heldQuat(w, hands[inc.toHand], new THREE.Quaternion()) : (w.rackPose?.quat ?? new THREE.Quaternion());
        const q = _q.copy(inc.quatFrom).slerp(targetQ, e);
        w.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
        w.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        if (w.forged) this.fx.trail(p, '#ffe3a0', 0.06);
        if (k >= 1) {
          if (inc.toHand && !this.held[inc.toHand]) this.attach(w, hands[inc.toHand]);
          else if (w.rackPose) { w.incoming = null; this.rack(w); }
          if (w.forged) this.hooks.onForgedArrive(w, !!inc.toHand);
        }
      } else if (w.state === 'free' && w.alignFlight) {
        const lv = w.body.linvel();
        const sp = Math.hypot(lv.x, lv.y, lv.z);
        if (sp > 3) {
          _q.setFromUnitVectors(Y, _v.set(lv.x, lv.y, lv.z).multiplyScalar(1 / sp));
          w.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
          w.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
      if (w.state === 'free') {
        const lv = w.body.linvel();
        w.prevVel.set(lv.x, lv.y, lv.z);
      }
    }
    this.stabs.prestep();
  }

  private heldQuat(w: WeaponEnt, h: HandView, out: THREE.Quaternion) {
    if (w.cls === 'bow') {
      // limbs vertical, belly toward the archer: local −Z → aim
      const z = _v3.copy(h.forward).negate();
      const yv = new THREE.Vector3(0, 1, 0).addScaledVector(z, -z.y).normalize();
      const x = new THREE.Vector3().crossVectors(yv, z).normalize();
      _m.makeBasis(x, yv, z);
      return out.setFromRotationMatrix(_m).multiply(new THREE.Quaternion().setFromAxisAngle(_v.set(0, 0, 1), h.side === 'left' ? -0.38 : 0.38));
    }
    return basisQuat(h.forward, h.up, out);
  }

  /** After world.step(): collisions, hit tests, pins, bombs, despawns. */
  poststep(dt: number, realDt: number, hands: Record<Hand, HandView>) {
    this.t += dt;
    this.realT += realDt;
    // dual wield: your two blades crossing ring off each other (quieter, no hitstop)
    const L = this.held.left, R = this.held.right;
    if (L && R && L.spec.sharp && R.spec.sharp && L.cls !== 'bow' && R.cls !== 'bow' && this.realT - this.dualClashT > 0.2) {
      const la = new THREE.Vector3().copy(L.center), ra = new THREE.Vector3().copy(R.center);
      const d2 = segSegDistLocal(la, L.tip, ra, R.tip);
      const rel = Math.abs(L.speed - R.speed) + Math.min(L.speed, R.speed) * 0.5;
      if (d2 < (L.radius + R.radius + 0.02) ** 2 && rel > 1.5) {
        this.dualClashT = this.realT;
        const at = la.add(L.tip).multiplyScalar(0.5).lerp(ra.add(R.tip).multiplyScalar(0.5), 0.5);
        this.fx.contact(at, new THREE.Vector3(0, 1, 0), null, rel, 'block');
        audio.clashEdge(Math.min(1, rel / 10), audio.pan(at), 0.0009, -6);
      }
    }
    // collision events (static contacts → ricochet, pin-stick, arrow stick, bomb)
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const w1 = this.byCollider.get(h1), w2 = this.byCollider.get(h2);
      const w = w1 ?? w2;
      if (!w || w.state !== 'free') return;
      const other = w1 ? h2 : h1;
      if (this.staticHandles.has(other)) this.onStaticContact(w);
      else if (w.cls === 'bomb' && this.t - w.thrownAt > 0.05) this.detonate(w);
    });

    for (const w of [...this.list]) {
      if (w.state === 'gone') continue;
      // world-space segment
      const t = w.body.translation();
      const r = w.body.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      w.prevTip.copy(w.tip);
      w.prevCenter.copy(w.center);
      w.center.set(t.x, t.y, t.z);
      const a = _v.copy(w.segA).applyQuaternion(_q).add(w.center);
      const b = _v2.copy(w.segB).applyQuaternion(_q).add(w.center);
      w.tip.copy(b);
      if (w.obj) { w.obj.position.copy(w.center); w.obj.quaternion.copy(_q); }

      if (w.state === 'held') {
        const sp = w.prevTip.lengthSq() > 0 ? w.tip.distanceTo(w.prevTip) / Math.max(1e-3, realDt) : 0;
        w.speed = sp;
        // contact uses the swing's peak tip speed over the last ~60 ms: the (inflated) hit capsule meets the
        // smoothed blade early in the arc, before it is at full speed
        const hist = this.speedHist.get(w.id) ?? [];
        hist.push({ t: this.realT, sp, x: w.tip.x, y: w.tip.y, z: w.tip.z });
        while (hist.length && this.realT - hist[0].t > 0.13) hist.shift();
        this.speedHist.set(w.id, hist);
        const peak = hist.reduce((m, h) => (this.realT - h.t <= 0.06 ? Math.max(m, h.sp) : m), sp);
        // slow cuts are never silent: anything above a drift registers (≤1.5 m/s is a touch: tink, no damage)
        _sa.copy(a); _sb.subVectors(b, a);
        _sb.addScaledVector(_sb, w.spec.sharp ? 0.12 / Math.max(1e-3, _sb.length()) : 0).add(a);
        if (sp > 0.8 && w.cls !== 'bow' && !this.stabs.isLodged(w)) this.tryHit(w, a, b, peak, 'melee', w.tip.clone().sub(w.prevTip).normalize(), realDt);
        else if (sp > 2.2 && w.cls === 'bow') this.tryHit(w, a, b, peak, 'melee', w.tip.clone().sub(w.prevTip).normalize(), realDt);
        w.segPrevA.copy(_sa); w.segPrevB.copy(_sb); w.segPrevT = this.realT;
      } else if (w.state === 'free') {
        const lv = w.body.linvel();
        const sp = Math.hypot(lv.x, lv.y, lv.z);
        w.speed = sp;
        if (sp > 2.0 && !w.pin && w.byPlayer) {
          const dir = new THREE.Vector3(lv.x, lv.y, lv.z).multiplyScalar(1 / sp);
          this.tryHit(w, a, b, sp, w.cls === 'arrow' ? 'arrow' : 'thrown', dir, dt);
        }
        if (w.cls === 'bomb' && this.t - w.thrownAt > 0.08) {
          const dv = w.prevVel.distanceTo(_v3.set(lv.x, lv.y, lv.z));
          if (dv > 4) this.detonate(w);
        }
        if (w.forged && sp > 5) this.fx.trail(w.center, '#ffd27a', 0.04);
        else if (w.cls === 'arrow' && sp > 8) this.fx.trail(w.tip, '#ffc06a', 0.02);
        // pin window expired
        if (w.pin && w.pin.until > 0 && this.t > w.pin.until) w.pin.until = -1;
        // rest / despawn
        if (sp < 0.25) w.restT += dt; else w.restT = 0;
        if (w.restT > 1.2 && w.cls === 'bow') this.rack(w);
        if (w.restT > 14 && w.cls !== 'bow') this.remove(w);
        if (w.center.y < -2) this.remove(w);
      } else if (w.state === 'pinned' || w.state === 'stuck') {
        w.restT += dt;
        if (w.restT > (w.cls === 'arrow' ? 18 : 13)) this.remove(w);
      }
      // hit cooldown aging is implicit (timestamps)
    }

    // stabs: follow the hand / the body, run him through, pull out
    this.stabs.update(dt, realDt);

    // pinned weapon whose ragdoll despawned → drop it
    for (const w of this.list) {
      if (w.pin && w.pin.enemy && !this.enemies.list.includes(w.pin.enemy)) w.pin = null;
    }

    // fists: empty hands punching
    for (const side of ['left', 'right'] as const) {
      const h = hands[side];
      if (this.held[side] || !h.visible) continue;
      const sp = h.vel.length();
      if (sp < 3.4) continue;
      const hit = this.enemies.testSegment(h.pos, h.pos, 0.06);
      if (!hit) continue;
      const cdKey = -1 - (side === 'left' ? 0 : 1);
      const last = hit.enemy.lastHit.get(cdKey) ?? -1;
      if (this.realT - last < 0.35) continue;
      hit.enemy.lastHit.set(cdKey, this.realT);
      const zone = this.enemies.zoneOf(hit.part);
      const info: HitInfo = {
        amount: 0, zone, part: hit.part, point: hit.point, dir: h.vel.clone().normalize(),
        speed: sp, sharp: false, source: 'fist', impulse: sp * 18, weaponEntId: null, massKg: FIST.massKg, classDamage: FIST.damage,
      };
      const res = this.enemies.damage(hit.enemy, info);
      this.hooks.onHit(null, res, info);
      audio.thunk(0.7);
    }

    this.renderBow(hands);
    this.renderArrows();
  }

  private tryHit(w: WeaponEnt, a: THREE.Vector3, b: THREE.Vector3, speed: number, source: HitInfo['source'], dir: THREE.Vector3, dt: number) {
    // ONE cutting rule (keyboard/mouse): a held blade can't strike harder than your hand moved it — the cap is
    // 1 + 1.4 × the cursor's commanded point speed; a blade you aren't driving (guard, parked, bouncing, just
    // picked up) only touches and never severs. Replaces the old timers that could be bypassed.
    let cap: { vCap: number; driven: boolean } | null = null;
    if (w.state === 'held' && w.hand && source === 'melee') {
      cap = this.hooks.cutCap?.(w.hand) ?? null;
      if (cap) speed = Math.min(speed, cap.vCap, 16);
    }
    // gameplay blade is 0.12 m longer than the visual one (research: forgiving reach)
    const axis = _v3.subVectors(b, a);
    const len = axis.length();
    if (len > 1e-4) axis.multiplyScalar(1 / len);
    const longB = (w.spec.sharp && w.cls !== 'arrow') ? new THREE.Vector3().copy(b).addScaledVector(axis, 0.12) : b.clone();
    const sweepA = w.state === 'held' ? w.prevTip : w.prevCenter;
    const sweepB = w.state === 'held' ? w.tip : w.center;
    const hasSweep = sweepA.lengthSq() > 0 && sweepA.distanceTo(sweepB) < speed * dt * 3 + 0.5;
    const magnet = w.state === 'held' && speed > 3.5 ? 0.07 : 0;
    // blade meets blade. A CHAMBER (his attack cancelled) needs intent: late in his wind-up (≥ 60%), at speed
    // (≥ 4 m/s on mouse) and driving into his blade. Anything else is a CLASH: ring, sparks, both blades bounce.
    if (w.state === 'held' && speed > 1.2) {
      const clash = this.enemies.testSwords(a, longB, w.radius);
      if (clash) {
        const key = clash.e.id * 16 + 15;
        const last = w.hitCd.get(key) ?? -1;
        if (this.realT - last >= 0.12) {
          w.hitCd.set(key, this.realT);
          const intent = clash.windupProgress >= 0.6 && speed >= 6 * this.hooks.speedScale() && (dir.dot(_v2.subVectors(clash.e.pos, clash.point).setY(0).normalize()) > 0.3 || Math.abs(dir.dot(clash.bladeDir)) < 0.6);
          if (intent && this.enemies.chamber(clash.e, clash.point)) { this.hooks.onChamber(w, clash.point); return; }
          // intensity in the input's own speed range (a hard mouse cut ≈ a hard real one)
          const I = Math.min(1, Math.max(0, (speed - 1.0) / (10.5 * this.hooks.speedScale())));
          if (w.cls === 'shield') {
            // his blade bites the aspis: wood and bronze rim, not a sword ring
            this.fx.contact(clash.point, dir.clone().negate(), clash.bladeDir, speed, 'shield');
            audio.shieldWood(I, audio.pan(clash.point));
          } else {
            this.fx.contact(clash.point, dir.clone().negate(), clash.bladeDir, speed, speed >= 2 ? 'clash' : 'block');
            audio.clashEdge(I, audio.pan(clash.point));
          }
          this.enemies.onClash(clash.e, speed);
          this.hooks.onRecoil(w.hand ?? 'right', dir, 0.1, 150);
          return;
        }
      }
    }
    // a held edge that crossed a neck this step is judged at the neck, whatever it brushed first
    const neckHit = w.state === 'held' && w.spec.sharp && w.cls !== 'bow' && this.realT - w.segPrevT < 0.05
      ? this.enemies.neckCross(a, longB, w.segPrevA, w.segPrevB) : null;
    const neckFree = neckHit && this.realT - (w.hitCd.get(neckHit.enemy.id * 16 + 14) ?? -1) >= 0.25;
    const hit = neckFree ? neckHit : this.enemies.testSegment(a, longB, w.radius, hasSweep ? sweepA : undefined, hasSweep ? sweepB : undefined, magnet);
    if (!hit) return;
    // B&S stab: a held point driven along its own blade, the point leading. A thrust isn't forgiven its reach — the
    // point itself must be at his skin (wait a step for it; a thrust that stops short is a miss)
    let stabLike = false;
    if (w.state === 'held' && source === 'melee' && stabProfile(w) && axis.dot(dir) > 0.8 && !(cap && !cap.driven)) {
      const ab = _st1.subVectors(b, a);
      const frac = _st2.subVectors(hit.point, a).dot(ab) / Math.max(1e-6, ab.lengthSq());
      if (frac >= 0.7) {
        if (!this.stabs.tipReached(hit.enemy, hit.part, b)) return;
        stabLike = true;
      }
    }
    // the neck keeps its own cooldown, and so does a stab (a touch while the point lined up doesn't swallow it)
    const key = hit.enemy.id * 16 + (stabLike ? 12 : neckFree && hit === neckHit ? 14 : hit.part);
    const last = w.hitCd.get(key) ?? -1;
    if (this.realT - last < 0.25) return;
    w.hitCd.set(key, this.realT);
    // one real wound per man per swing window (0.45 s): a sweep that brushes three of his parts doesn't cut three
    // times. Later contacts are grazes (20%, no sever, no stagger); the neck is always judged on its own.
    const isNeck = !!neckFree && hit === neckHit;
    const woundKey = hit.enemy.id * 16 + 13;
    const inWindow = w.state === 'held' && this.realT - (w.hitCd.get(woundKey) ?? -1) < 0.45;
    const graze = inWindow && !isNeck && !stabLike;
    const neckRepeat = inWindow && isNeck;
    if (w.state === 'held' && !inWindow) w.hitCd.set(woundKey, this.realT);
    const zone = this.enemies.zoneOf(hit.part);
    // arrows: damage follows the draw (60 m/s full draw → the old 22 m/s cap; a tap → about a third)
    let relSpeed = source === 'arrow' ? Math.min(22, speed * 0.367) : Math.min(speed, 32);
    // B&S-style contact data for held blades: where along the edge it touched, how fast THAT point moved
    // this frame (not the tip's peak), and whether the stroke was committed
    let contactFrac: number | undefined, contactSpeed: number | undefined, strokeLen: number | undefined, strokeTurn: number | undefined;
    if (w.state === 'held' && dt > 1e-4) {
      const ab = new THREE.Vector3().subVectors(b, a);
      const L2 = Math.max(1e-6, ab.lengthSq());
      contactFrac = clamp(new THREE.Vector3().subVectors(hit.point, a).dot(ab) / L2, 0, 1);
      const reach = (w.segA.length() + contactFrac * (w.segB.length() - w.segA.length())) / Math.max(1e-3, w.segB.length());
      const cur = new THREE.Vector3().copy(w.center).lerp(w.tip, reach);
      const prev = new THREE.Vector3().copy(w.prevCenter).lerp(w.prevTip, reach);
      contactSpeed = prev.lengthSq() > 0 ? cur.distanceTo(prev) / dt : speed;
      if (cap) contactSpeed = Math.min(contactSpeed, cap.vCap, 16);
      relSpeed = Math.min(Math.max(contactSpeed, speed * 0.6 * reach), 32); // damage follows the contact point too
      const hs = this.speedHist.get(w.id) ?? [];
      const recent = hs.filter((h) => this.realT - h.t <= 0.12);
      strokeLen = 0;
      for (let i = 1; i < recent.length; i++) strokeLen += Math.hypot(recent[i].x - recent[i - 1].x, recent[i].y - recent[i - 1].y, recent[i].z - recent[i - 1].z);
      strokeTurn = 0;
      // the turn is judged over the stroke itself (last 80 ms), so a back-swing that set it up isn't a "wiggle"
      const turnWin = hs.filter((h) => this.realT - h.t <= 0.08);
      if (turnWin.length >= 3) recent.splice(0, recent.length, ...turnWin);
      if (recent.length >= 3) {
        const m = Math.floor(recent.length / 2);
        const d1 = new THREE.Vector3(recent[m].x - recent[0].x, recent[m].y - recent[0].y, recent[m].z - recent[0].z);
        const d2 = new THREE.Vector3(recent[recent.length - 1].x - recent[m].x, recent[recent.length - 1].y - recent[m].y, recent[recent.length - 1].z - recent[m].z);
        if (d1.lengthSq() > 1e-6 && d2.lengthSq() > 1e-6) strokeTurn = THREE.MathUtils.radToDeg(d1.angleTo(d2));
      }
    }
    const info: HitInfo = {
      amount: 0, zone, part: hit.part, point: hit.point, dir: dir.clone(), speed: relSpeed, sharp: w.spec.sharp,
      source, impulse: relSpeed * w.spec.massKg * (w.cls === 'blunt' || w.cls === 'shield' ? 14 : 7) + 40, weaponEntId: w.id,
      bladeAxis: w.cls === 'arrow' ? dir.clone() : axis.clone(), massKg: w.spec.massKg * (w.state === 'held' ? HELD_MULT : 1), classDamage: w.spec.damage,
      bladeA: a.clone(), bladeB: longB.clone(),
      bladePrevA: w.state === 'held' && this.realT - w.segPrevT < 0.05 ? w.segPrevA.clone() : undefined,
      bladePrevB: w.state === 'held' && this.realT - w.segPrevT < 0.05 ? w.segPrevB.clone() : undefined,
      contactFrac, contactSpeed, strokeLen, strokeTurn, noCut: (!!cap && !cap.driven) || graze, neck: isNeck, graze, neckRepeat,
      stab: stabLike && !graze,
    };
    if (w.cls === 'bomb' && w.state === 'free') { this.detonate(w); return; }
    const res = this.enemies.damage(hit.enemy, info);
    this.hooks.onHit(w, res, info);
    if (res.blocked || res.glanced) {
      if (w.state === 'free') {
        const lv = w.body.linvel();
        w.body.setLinvel({ x: -lv.x * 0.25, y: Math.abs(lv.y) * 0.3 + 1.2, z: -lv.z * 0.25 }, true);
        w.alignFlight = false;
        w.body.setAngvel({ x: rand(-8, 8), y: rand(-8, 8), z: rand(-8, 8) }, true);
      } else if (w.hand && res.glanced && !res.blocked && hit.part === P.Head && !info.neck) {
        // off the bronze bell the edge SKIDS (it rings and sparks, but carries on down — under the cheek-guards
        // to the neck, or onto the shoulder); only a cut into a guard or a shield is thrown back
      } else if (w.hand) {
        // your blow was turned: the sword kicks back (research: 0.15–0.2 m over ~150 ms)
        // parried by his guard: knocked well aside, hand slowed for ~0.45 s — he ripostes
        this.hooks.onRecoil(w.hand, dir, res.parried ? 0.25 : 0.12, res.parried ? 0.45 : 0.15);
      }
      this.hooks.shake(res.parried ? 0.15 : 0.08);
      return;
    }
    if (w.forged) {
      w.durability--;
      if (w.durability <= 0 && w.state !== 'gone') { this.breakWeapon(w); return; }
    }
    // the point got in: it stays in him (corpses can be run through too)
    if (info.stab && w.state === 'held' && (res.penetrated || hit.enemy.dead)) this.stabs.tryLodge(w, hit.enemy, hit.part, info, res);
    if (res.killed && w.state === 'free') {
      w.throwKills.push(this.t);
      // PIN: sharp weapon killing at > 8 m/s joints itself to the hit part and keeps flying.
      const rag = hit.enemy.ragdoll;
      const part = rag ? (rag.bodies[hit.part] ?? rag.bodies[P.Torso]) : null;
      if (w.spec.sharp && speed > 8 && rag && part && !w.pin && !res.severed) {
        const lv = w.body.linvel();
        for (const bdy of rag.bodies) bdy?.setLinvel({ x: lv.x * 0.55, y: lv.y * 0.55 + 0.6, z: lv.z * 0.55 }, true);
        const wt = w.body.translation(), wr = w.body.rotation();
        const pt = part.translation(), pr = part.rotation();
        const wq = new THREE.Quaternion(wr.x, wr.y, wr.z, wr.w);
        const pq = new THREE.Quaternion(pr.x, pr.y, pr.z, pr.w);
        const anchorW = new THREE.Vector3(pt.x, pt.y, pt.z).sub(new THREE.Vector3(wt.x, wt.y, wt.z)).applyQuaternion(wq.clone().invert());
        const relQ = wq.clone().invert().multiply(pq);
        const jd = RAPIER.JointData.fixed(
          { x: anchorW.x, y: anchorW.y, z: anchorW.z }, { x: relQ.x, y: relQ.y, z: relQ.z, w: relQ.w },
          { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 },
        );
        const joint = this.world.createImpulseJoint(jd, w.body, part, true);
        joint.setContactsEnabled(false);
        w.pin = { joint, until: this.t + 0.5, enemy: hit.enemy };
        w.body.setLinvel({ x: w.prevVel.x, y: w.prevVel.y, z: w.prevVel.z }, true);
      }
    } else if (w.state === 'free' && !res.killed) {
      const lv = w.body.linvel();
      w.body.setLinvel({ x: lv.x * -0.15, y: 1.0, z: lv.z * -0.15 }, true);
      w.alignFlight = false;
    }
  }

  /** A wooer's weapon or shield falls free (dropped on death or when his arm is cut off) — grab it. */
  spawnDropped(kind: 'sword' | 'spear' | 'shield', pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3) {
    let w: WeaponEnt;
    if (kind === 'sword') w = this.create('sword', { ...WEAPON_CLASSES.sword, lengthM: 0.7, massKg: 1.1 }, buildBlade(0.7), "Wooer's Xiphos");
    else if (kind === 'spear') w = this.create('spear', WEAPON_CLASSES.spear, buildSpear(1.8), "Wooer's Spear");
    else w = this.create('shield', WEAPON_CLASSES.shield, buildAspis(0.82), 'Wooer’s Aspis');
    w.rackKind = null;
    w.byPlayer = false;
    this.setDynamic(w);
    w.state = 'free';
    w.thrownAt = this.t;
    w.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    w.body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
    w.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    w.body.setAngvel({ x: rand(-3, 3), y: rand(-3, 3), z: rand(-3, 3) }, true);
    // keep the floor tidy
    const drops = this.list.filter((x) => x.rackKind === null && !x.forged && x.cls !== 'arrow' && x.cls !== 'bow' && x.state === 'free');
    if (drops.length > 10) this.remove(drops[0]);
    return w;
  }

  private onStaticContact(w: WeaponEnt) {
    w.staticHits++;
    this.hooks.onStatic(w);
    if (w.pin && w.pin.until > 0 && this.t <= w.pin.until) {
      // the corpse is nailed to the pillar
      w.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      w.state = 'pinned';
      w.restT = 0;
      w.alignFlight = false;
      this.fx.sparks(w.tip, null, 18);
      this.fx.dust(w.tip, 10);
      audio.thunk(1.6);
      audio.metal(0.7, 1100);
      this.hooks.onPinned(w, w.pin.enemy);
      w.pin.enemy.pinned = true;
      w.pin.until = -1;
      return;
    }
    if (w.cls === 'bomb') { this.detonate(w); return; }
    if ((w.cls === 'arrow' || w.cls === 'spear') && w.alignFlight && w.speed > 9) {
      // embed in wood/stone
      w.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      w.state = 'stuck';
      w.restT = 0;
      w.alignFlight = false;
      this.fx.sparks(w.tip, null, 6);
      audio.thunk(0.6);
      return;
    }
    w.alignFlight = false;
    if (w.speed > 4) { audio.metal(Math.min(1, w.speed / 15), 1300); this.fx.sparks(w.center, null, 5); }
  }

  private detonate(w: WeaponEnt) {
    if (w.state === 'gone') return;
    const c = w.center.clone();
    this.fx.explosion(c);
    audio.explosion();
    this.hooks.shake(0.6);
    this.hooks.hitstop(120);
    const killed = this.enemies.explode(c, 3.6, 175, w.id);
    // push free weapons and ragdolls
    for (const o of this.list) {
      if (o === w || o.state !== 'free') continue;
      const d = o.center.distanceTo(c);
      if (d < 3.6) {
        const k = (1 - d / 3.6) * 8 * o.spec.massKg;
        const dir = _v.subVectors(o.center, c).normalize();
        o.body.applyImpulse({ x: dir.x * k, y: k * 0.8, z: dir.z * k }, true);
      }
    }
    for (const e of this.enemies.list) {
      if (!e.ragdoll) continue;
      const pc = e.pose[P.Pelvis].c;
      const d = pc.distanceTo(c);
      if (d < 4) {
        const k = (1 - d / 4) * 90;
        const dir = _v.subVectors(pc, c).normalize();
        e.ragdoll.bodies[P.Torso]?.applyImpulse({ x: dir.x * k, y: k * 1.1, z: dir.z * k }, true);
      }
    }
    this.hooks.onExplode(w, killed);
    this.remove(w);
  }

  private breakWeapon(w: WeaponEnt) {
    this.fx.sparks(w.center, null, 22, '#ffe3a0');
    this.fx.dust(w.center, 10);
    audio.metal(1, 900);
    this.hooks.onBroken(w);
    this.remove(w);
  }

  /** Rack upkeep: dagger every 20 s, spear after 25 s. */
  upkeep(dt: number) {
    const daggers = this.list.filter((w) => w.rackKind === 'dagger' && (w.state === 'racked' || w.state === 'held' || w.state === 'incoming'));
    this.daggerTimer += dt;
    if (daggers.length < 2 && this.daggerTimer > 20) {
      this.daggerTimer = 0;
      const used = new Set(daggers.filter((d) => d.state === 'racked').map((d) => d.rackPose?.pos.x.toFixed(2)));
      const slot = used.has(this.daggerSlot(0).pos.x.toFixed(2)) ? 1 : 0;
      const w = this.spawnDagger(slot);
      this.fx.gold(w.rackPose!.pos, 16);
      audio.lyre([7], 0, 523);
    } else if (daggers.length >= 2) this.daggerTimer = Math.min(this.daggerTimer, 14);
    const shields = this.list.filter((w) => w.rackKind === 'shield' && w.state !== 'gone');
    if (!shields.length) {
      this.shieldTimer += dt;
      if (this.shieldTimer > 20) { this.shieldTimer = 0; const w = this.spawnShield(); this.fx.gold(w.rackPose!.pos, 16); }
    } else this.shieldTimer = 0;
    const spears = this.list.filter((w) => w.rackKind === 'spear' && (w.state === 'racked' || w.state === 'held' || w.state === 'incoming'));
    if (!spears.length) {
      this.spearTimer += dt;
      if (this.spearTimer > 25) { this.spearTimer = 0; const w = this.spawnSpear(); this.fx.gold(w.rackPose!.pos, 16); }
    } else this.spearTimer = 0;
  }

  /** Does a held blade intercept this arrow path? */
  parry(p0: THREE.Vector3, p1: THREE.Vector3): boolean {
    for (const side of ['left', 'right'] as const) {
      const w = this.held[side];
      if (!w || w.cls === 'bow') continue;
      const r = w.body.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      const c = w.body.translation();
      const a = _v.copy(w.segA).applyQuaternion(_q).add(_v3.set(c.x, c.y, c.z));
      const b = new THREE.Vector3().copy(w.segB).applyQuaternion(_q).add(_v3);
      const rr = w.cls === 'shield' ? 0.36 : w.radius + 0.07;
      const d2 = segSegDistLocal(a, b, p0, p1);
      if (d2 < rr * rr) {
        this.hooks.onParry(p1);
        return true;
      }
    }
    return false;
  }

  private renderBow(hands: Record<Hand, HandView>) {
    const bowW = this.held.left?.cls === 'bow' ? this.held.left : this.held.right?.cls === 'bow' ? this.held.right : null;
    const bow = bowW ?? this.list.find((w) => w.cls === 'bow');
    this.nockedArrow.show = false;
    if (!bow || !this.bowTips || !bow.obj) { this.bowString.forEach((s) => (s.visible = false)); return; }
    const q = bow.obj.quaternion;
    const top = _v.copy(this.bowTips.top).applyQuaternion(q).add(bow.obj.position);
    const bot = _v2.copy(this.bowTips.bottom).applyQuaternion(q).add(bow.obj.position);
    const drawHand = bowW ? hands[bowW.hand === 'left' ? 'right' : 'left'] : null;
    const draw = this.drawing ? this.bowDraw : 0;
    // nock point: rest position on the string, pulled toward the drawing hand
    const rest = new THREE.Vector3(0, 0, 0.065).applyQuaternion(q).add(bow.obj.position);
    const nock = rest.clone();
    if (drawHand && this.drawing) nock.lerp(drawHand.pos, clamp(draw * 1.15, 0, 1));
    for (const [i, from] of [top, bot].entries()) {
      const s = this.bowString[i];
      const mid = _v3.addVectors(from, nock).multiplyScalar(0.5);
      s.position.copy(mid);
      s.scale.set(1, from.distanceTo(nock), 1);
      s.quaternion.setFromUnitVectors(Y, new THREE.Vector3().subVectors(from, nock).normalize());
      s.visible = true;
    }
    if (bowW && this.drawing) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      this.nockedArrow.show = true;
      this.nockedArrow.tail.copy(nock);
      this.nockedArrow.dir.copy(fwd);
    } else if (bowW) {
      this.nockedArrow.tail.copy(rest);
    }
  }

  private renderArrows() {
    this.arrows.begin();
    for (const w of this.list) {
      if (w.cls !== 'arrow') continue;
      const t = w.body.translation(), r = w.body.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      this.arrows.push(_v.set(t.x, t.y, t.z), _q);
    }
    for (const ar of this.enemies.arrows) {
      if (!ar.alive && ar.stuck <= 0.02) continue;
      const dir = _v2.copy(ar.vel);
      if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
      this.arrows.pushDir(_v.copy(ar.pos).addScaledVector(dir.normalize(), -0.7), dir);
    }
    if (this.nockedArrow.show) this.arrows.pushDir(this.nockedArrow.tail, this.nockedArrow.dir);
    this.arrows.end();
  }
}

// local copy to avoid aliasing the shared temp vectors in math.ts
function segSegDistLocal(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const den = a * e - b * b;
      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const dx = p1.x + d1x * s - (p2.x + d2x * t), dy = p1.y + d1y * s - (p2.y + d2y * t), dz = p1.z + d1z * s - (p2.z + d2z * t);
  return dx * dx + dy * dy + dz * dz;
}
