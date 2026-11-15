import * as THREE from 'three';
import type { GameEvent, GameEventKind, Hand, InputController, InputEvent, PlayerInputState, TrickshotKind, WeaponSpawn } from '@ithaca/shared';
import { RAPIER, initPhysics } from './physics';
import { buildHall, HALL, type HallRig } from './hall';
import { Fx } from './fx';
import { EnemyManager, type Attack, type Enemy, type HitInfo, type HitResult, type Outcome } from './enemies';
import { WeaponManager, type HandView, type WeaponEnt } from './weapons';
import { Gauntlet } from './hands';
import { Trails } from './trails';
import { loadBodyTemplate, type BodyTemplate } from './skinnedBody';
import { PlayerBody } from './playerBody';
import { Director, type WaveDef } from './director';
import { Scoring, TRICK_POINTS, TRICK_TITLES } from './scoring';
import { audio } from './audio';
import { basisQuat, clamp, damp, rand } from './math';
import { P } from './humanoid';
import { isKeyboardMouse } from '../../input';

export type EngineMode = 'menu' | 'match' | 'ended';

export interface EngineCallbacks {
  emit(e: GameEvent): void;
  hud(patch: Record<string, unknown>): void;
  toast(t: { kind: 'trickshot' | 'info' | 'gift' | 'wave' | 'warn'; title: string; sub?: string; points?: number }, ttl?: number): void;
  slowmo(on: boolean, trick?: TrickshotKind, weaponName?: string): void;
  matchEnd(r: { victory: boolean; score: number; kills: number; durationMs: number; trickshots: Record<TrickshotKind, number>; bestCombo: number; wave: number; forgedKills: Record<string, number> }): void;
  requestCall(): void;
  requestWeapon(): void;
  pinnedPrompt(show: boolean): void;
  tracking(state: PlayerInputState['tracking']): void;
  pendingGesture(g: { name: string; progress: number } | null): void;
  bowMode(on: boolean): void;
}

export interface PostState { sat: number; chroma: number; flash: number; letterbox: number; heal: number; exposure: number; verdigris: number }

const FIXED = 1 / 60;
/** W7 safety net (webcam): ?autoarm=1 pulls a xiphos to an empty-handed player with a wooer close. Off by default. */
const AUTO_ARM = typeof location !== 'undefined' && new URLSearchParams(location.search).get('autoarm') === '1';

const _sv1 = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _gv1 = new THREE.Vector3(), _gv2 = new THREE.Vector3(), _gv3 = new THREE.Vector3(), _gv4 = new THREE.Vector3(), _gv5 = new THREE.Vector3(), _gv6 = new THREE.Vector3();
const _gm = new THREE.Matrix4();
const _gq = new THREE.Quaternion();
const _sv2 = new THREE.Vector3();
const _rv1 = new THREE.Vector3(), _rv2 = new THREE.Vector3(), _rv3 = new THREE.Vector3();

export class Engine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  world!: InstanceType<typeof RAPIER.World>;
  hall!: HallRig;
  fx = new Fx();
  trails = new Trails();
  enemies!: EnemyManager;
  weapons!: WeaponManager;
  hands!: Record<Hand, Gauntlet>;
  director!: Director;
  scoring = new Scoring();
  mode: EngineMode = 'menu';
  paused = false;
  difficulty: 'easy' | 'normal' = 'normal';
  post: PostState = { sat: 0.72, chroma: 0, flash: 0, letterbox: 0, heal: 0, exposure: 1, verdigris: 0 };

  private input: InputController | null = null;
  private unsubInput: (() => void) | null = null;
  private unsubMode: (() => void) | null = null;
  private cb: EngineCallbacks;
  private acc = 0;
  private realT = 0;
  private simT = 0;
  private matchStartReal = 0;
  private timeScale = 1;
  private slow = { active: false, t: 0, hold: 1.6 };
  private hitstopT = 0;
  private handStickUntil = 0;
  private softSlow = 1;
  private trauma = 0;
  private health = 100;
  private lastHurtT = -99;
  private lowHealthArmed = true;
  private lastPinnedEvt = -99;
  private blocking = false;
  private fov = 55;
  private hudTimer = 0;
  private killEventCount = 0;
  private menuT = 0;
  private callActive = false;
  private forgedKills = new Map<string, number>();
  private eye = new THREE.Vector3().copy(HALL.eye);
  private handViews: Record<Hand, HandView>;
  private stepViews: Record<Hand, HandView>;
  private stepPrev: Record<Hand, { pos: THREE.Vector3; fwd: THREE.Vector3; up: THREE.Vector3 }>;
  private handTarget: Record<Hand, THREE.Vector3>;
  private lastState: PlayerInputState | null = null;
  private trackingLost = false;
  private disposed = false;
  private introUntil = 0;
  private guardAt = -9;
  private waveKills = 0;
  shakeScale = 1;
  // ── combat feel state ──
  private bladeHist: { t: number; side: Hand; a: THREE.Vector3; b: THREE.Vector3; speed: number; vel?: THREE.Vector3; intent?: string }[] = [];
  private leanSign = 0;
  private leanCrossT = -9;
  private playerPosture = 0;
  private postureT = -9;
  private micro = { until: 0, scale: 1, kind: '' as '' | 'deflect' | 'dodge' };
  private lastPerfectDodge = -9;
  private counterUntil = 0;
  private kickPitch = 0;
  private lookDown = 0;
  private guardBrokenUntil = -9;
  private guardDownT = 0;
  private prevGuardAt = -9;
  private guardUpEndT = -9;
  private lastActiveHand: Hand = 'right';
  private hoverAcc = 0;
  private hoverW: ReturnType<WeaponManager['pickRay']> = null;
  private hoverChangeT = -9;
  private lastRealDt = 1 / 60;
  private kickVel = 0;
  private recoilOff: Record<Hand, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  private dampUntil: Record<Hand, number> = { left: 0, right: 0 };
  private lastFlashT = -9;
  private drainT = -9;
  private lastDecapSlow = -99;
  private seenDecap = false;
  private seenTips = new Set<string>();
  // ── webcam hands & grabs: per-hand cone target, grip-level trigger, take cooldown, lost/reacquired times ──
  private target: Record<Hand, WeaponEnt | null> = { left: null, right: null };
  private gripT: Record<Hand, number> = { left: 0, right: 0 };
  /** the grip-level trigger re-arms once the hand has been seen open after a take */
  private levelArmed: Record<Hand, boolean> = { left: true, right: true };
  private takeCd: Record<Hand, number> = { left: -9, right: -9 };
  /** realT the hand model last saw this hand (Part C's handFresh) */
  private freshAt: Record<Hand, number> = { left: -9, right: -9 };
  private lostAt: Record<Hand, number> = { left: -9, right: -9 };
  private backAt: Record<Hand, number> = { left: -9, right: -9 };
  private wasLive: Record<Hand, boolean> = { left: false, right: false };
  private unnockT = 0;
  private unarmedT = 0;
  private refuseT: Record<string, number> = {};
  private trackSeen = 'ok';
  private trackSince = 0;
  private trackSent = 'ok';
  /** takes by path (dev play log): the grab event, the grip-level trigger, the auto-arm safety net */
  readonly takeStats = { event: 0, level: 0, auto: 0 };
  /** HUD overlay feed (read every frame by CombatOverlay) */
  damageArcs: { angle: number; t: number; heavy: boolean }[] = [];
  ripples: { pos: THREE.Vector3; t: number; color: 'brass' | 'gold' | 'verdigris' }[] = [];

  private constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, cb: EngineCallbacks) {
    this.scene = scene;
    this.camera = camera;
    this.cb = cb;
    // stereo position of impact sounds from where they happen in view
    const pv = new THREE.Vector3();
    audio.panOf = (x, y, z) => {
      pv.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      return Math.max(-1, Math.min(1, pv.x / Math.max(0.5, -pv.z) / 0.7));
    };
    const mkView = (side: Hand): HandView => ({
      side, pos: new THREE.Vector3(side === 'left' ? -0.26 : 0.24, 1.3, -0.45), quat: new THREE.Quaternion(),
      forward: new THREE.Vector3(0, 0.6, -0.8), up: new THREE.Vector3(side === 'left' ? -1 : 1, 0, 0), vel: new THREE.Vector3(), grip: 0, visible: true,
    });
    this.handViews = { left: mkView('left'), right: mkView('right') };
    // per-substep hand poses: the frame's hand motion is spread evenly across the physics steps it covers,
    // so blade speed (tip travel ÷ step) is the same at 30, 60 or 144 fps
    this.stepViews = { left: mkView('left'), right: mkView('right') };
    this.stepPrev = {
      left: { pos: this.handViews.left.pos.clone(), fwd: this.handViews.left.forward.clone(), up: this.handViews.left.up.clone() },
      right: { pos: this.handViews.right.pos.clone(), fwd: this.handViews.right.forward.clone(), up: this.handViews.right.up.clone() },
    };
    this.handTarget = { left: this.handViews.left.pos.clone(), right: this.handViews.right.pos.clone() };
  }

  static async create(scene: THREE.Scene, camera: THREE.PerspectiveCamera, cb: EngineCallbacks): Promise<Engine> {
    // realistic warrior body (Microsoft Rocketbox, MIT) — falls back to capsule bodies if it can't load
    const [, tpl] = await Promise.all([initPhysics(), loadBodyTemplate('/characters/rocketbox/warrior_male_01.glb').catch(() => null)]);
    const e = new Engine(scene, camera, cb);
    e.bodyTpl = tpl;
    e.build();
    return e;
  }
  private bodyTpl: BodyTemplate | null = null;
  /** first-person body (VR-style): arms to the gauntlets, torso and legs below the camera */
  private playerBody: PlayerBody | null = null;
  private trackedElbows: Record<Hand, THREE.Vector3 | null> = { left: null, right: null };

  private build() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED;
    this.hall = buildHall(this.world);
    this.scene.add(this.hall.group);
    this.scene.add(this.fx.group);
    this.scene.add(this.trails.group);
    if (this.bodyTpl) {
      try { this.playerBody = new PlayerBody(this.bodyTpl, HALL.eye.y); this.scene.add(this.playerBody.root); }
      catch (err) { console.warn('[engine] first-person body unavailable', err); this.playerBody = null; }
    }
    this.fx.hearth = HALL.hearth.clone();
    this.fx.braziers = [new THREE.Vector3(-1.5, 1.08, -1.4), ...HALL.doors.map((d) => new THREE.Vector3(d.x * 1.55, 1.2, HALL.zFar + 1.4))];

    this.enemies = new EnemyManager(this.world, this.fx, {
      onKill: (e, info, _rag, how) => this.onKill(e, info, how),
      onPlayerHit: (dmg, source, from, heavy) => this.hurt(dmg, source, from, heavy),
      resolveIncoming: (e, a) => this.resolveIncoming(e, a),
      onOutcome: (e, a, o, at) => this.onOutcome(e, a, o, at),
      onAttackStart: () => { audio.grunt(); },
      onSever: (e, part, alive) => this.onSever(e, part, alive),
      onDropWeapon: (kind, pos, q, vel) => { this.weapons.spawnDropped(kind, pos, q, vel); },
      onArrowBlocked: (pos) => { this.fx.contact(pos, new THREE.Vector3().subVectors(this.eye, pos), null, 8, 'shield'); audio.shieldWood(0.6, audio.pan(pos)); this.addTrauma(0.15); },
      laneOffset: (dir, out) => {
        // where the wooer's blade crosses in front of you (~0.7 m) — the place to put your sword
        const o = dir === 'left' ? out.set(-0.32, -0.02, -0.7) : dir === 'right' ? out.set(0.32, -0.02, -0.7)
          : dir === 'top' ? out.set(0, 0.2, -0.68) : out.set(0, -0.1, -0.78);
        return o.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
      },
      speedScale: () => (this.input?.kind === 'keyboard_mouse' ? 0.65 : 1),
      playerHead: () => this.eye,
      blocking: () => this.blocking,
      shieldHeld: () => this.weapons.shieldHeld(),
      parryCheck: (a, b) => this.weapons.parry(a, b),
      hitstop: (ms) => this.hitstop(ms),
      shake: (v) => this.addTrauma(v),
      difficultyMult: () => (this.difficulty === 'easy' ? 0.75 : 1),
      wave: () => Math.max(1, this.director.wave),
      playerYaw: () => this.yaw,
      playerBlades: () => {
        const out: { tip: THREE.Vector3; vel: THREE.Vector3; base: THREE.Vector3 }[] = [];
        for (const side of ['right', 'left'] as const) {
          const w = this.weapons.heldBy(side);
          if (!w || !w.spec.sharp || w.cls === 'bow' || w.cls === 'shield') continue;
          // tip travel per physics step (each step covers FIXED of real time — hand poses are spread across steps)
          out.push({ tip: w.tip, base: w.center, vel: w.tip.clone().sub(w.prevTip).multiplyScalar(1 / FIXED) });
        }
        return out;
      },
      playerShield: () => {
        const w = this.weapons.heldBy('left')?.cls === 'shield' ? this.weapons.heldBy('left') : this.weapons.heldBy('right')?.cls === 'shield' ? this.weapons.heldBy('right') : null;
        return w ? w.center : null;
      },
      onBossPhase: (e, ph) => {
        if (ph === 2) {
          this.cb.toast({ kind: 'warn', title: 'THE GILDED SHIELD FALLS', sub: 'Antinous calls the wooers to him' }, 2200);
          for (const x of [-2.2, 2.2]) this.enemies.spawn('suitor', new THREE.Vector3(x, 0, -6.5));
          this.addTrauma(0.25);
        } else if (ph === 3) {
          this.cb.toast({ kind: 'warn', title: 'ANTINOUS IS DESPERATE', sub: 'His thrusts cannot be parried — lean away' }, 2200);
        }
        void e;
      },
    });
    this.enemies.setBodyTemplate(this.bodyTpl);
    this.scene.add(this.enemies.renderer.group);

    this.weapons = new WeaponManager(this.world, this.enemies, this.fx, {
      onHit: (w, r, info) => this.onWeaponHit(w, r, info),
      onRecoil: (hand, dir, dist, dampMs) => this.recoil(hand, dir, dist, dampMs),
      onChamber: (_w, at) => { this.hitstop(60); this.addTrauma(0.12); this.ripple(at, 'brass'); this.tutorial('chamber', 'CHAMBERED', 'Struck his blade mid-swing'); },
      onPinned: (w, enemy) => this.onPinned(w, enemy),
      onStatic: () => {},
      onBroken: (w) => {
        this.cb.toast({ kind: 'warn', title: `${w.name.toUpperCase()} SHATTERS` }, 1500);
        this.emit('weapon_broken', { weaponName: w.name, weaponId: w.forged?.weaponId });
      },
      onExplode: (w, killed) => this.onExplode(w, killed),
      onHeal: (n) => this.heal(n),
      onForgedArrive: (w, inHand) => {
        this.fx.gold(w.center, 36);
        audio.forgeArrive();
        this.hall.setStoreroomGlow(1);
        this.cb.toast({ kind: 'gift', title: 'TELEMACHUS SENDS', sub: w.name }, 2600);
        void inHand;
      },
      onParry: (pos) => {
        this.fx.contact(pos, new THREE.Vector3().subVectors(this.eye, pos), null, 8, 'clash');
        audio.clashEdge(0.7, audio.pan(pos));
        this.hitstop(60);
        this.scoring.addPoints(50);
        this.cb.toast({ kind: 'info', title: 'PARRY', points: 50 }, 900);
      },
      hitstop: (ms) => this.hitstop(ms),
      shake: (v) => this.addTrauma(v),
      playerPos: () => this.eye,
      // point-and-grip pull: the cursor ray (keyboard/mouse) or the ray from your eye through your tracked hand
      // (webcam) — the table sits below where a tracked hand can reach, so reaching toward a weapon + a fist takes it
      kbPull: () => true,
      drivenHand: () => (isKeyboardMouse(this.input) ? this.input.mode.activeHand : null),
      cutCap: (hand) => {
        if (!isKeyboardMouse(this.input)) return null;
        const intent = this.input.intentOf(hand);
        const driven = intent === 'driven';
        const vCap = 1 + 1.4 * this.input.vCmd;
        return { vCap: driven ? vCap : Math.min(vCap, 3), driven };
      },
      onArrowsSpent: () => this.cb.toast({ kind: 'info', title: 'ARROWS SPENT', sub: 'Telemachus brings more between waves' }, 1400),
      speedScale: () => (this.input?.kind === 'keyboard_mouse' ? 0.65 : 1),
      onTake: (w, side) => this.onTake(w, side),
    }, this.hall.staticHandles);
    this.scene.add(this.weapons.group);

    this.hands = { left: new Gauntlet('left', this.world), right: new Gauntlet('right', this.world) };
    this.scene.add(this.hands.left.root, this.hands.right.root);

    this.director = new Director({
      spawn: (kind, at) => !!this.enemies.spawn(kind, at),
      aliveCount: () => this.enemies.aliveCount,
      onWaveStart: (w) => this.onWaveStart(w),
      onWaveCleared: (w) => {
        audio.lyre([0, 4, 7, 12, 16], 0.11, 196);
        audio.setIntensity(0.15);
        this.cb.hud({ intermission: 'WAVE CLEARED' });
        // a breather between waves: wounds bound (with a friend on the line, Telemachus does it)
        this.cb.toast({ kind: 'wave', title: 'WAVE CLEARED', sub: this.callActive ? 'Telemachus binds your wounds.' : 'Catch your breath.' }, 2600);
        if (this.health < 100) setTimeout(() => { if (this.mode === 'match' && this.health > 0) this.heal(Math.min(40, Math.round(100 - this.health))); }, 900);
        this.emit('wave_cleared', { wave: w.n });
      },
      onMelanthius: () => {
        this.enemies.melanthius = true;
        audio.gong(98, 6, 0.4);
        this.cb.toast({ kind: 'warn', title: 'MELANTHIUS IS ARMING THE WOOERS!', sub: 'He climbed the clerestory to the storeroom. Shields incoming.' }, 3600);
      },
      onBoss: () => {
        audio.gong(65, 8, 0.5);
        audio.lyre([0, 3, 7, 10], 0.14, 147);
        this.addTrauma(0.3);
        // boss intro: 2.8 s letterbox name card, world at 0.5×
        this.introUntil = this.realT + 2.8;
        this.microSlow(0.5, 2.8, 'deflect');
        this.cb.hud({ bossIntro: { name: 'ANTINOUS', epithet: 'son of Eupeithes, first of the wooers', at: Date.now() } });
        this.emit('boss_spawn', { wave: 3 });
      },
      onVictory: () => this.finish(true),
      onStragglers: () => {
        this.enemies.chargeAll();
        this.cb.toast({ kind: 'warn', title: 'THE LAST WOOERS CHARGE!' }, 1800);
      },
    });

    this.weapons.spawnStarterKit();
    this.setupMenu();
  }

  // ── input ──
  setInput(c: InputController | null) {
    this.unsubInput?.();
    this.unsubMode?.();
    this.unsubInput = null;
    this.unsubMode = null;
    this.input = c;
    if (!c) return;
    this.unsubInput = c.on((e) => this.onInput(e));
    if (isKeyboardMouse(c)) {
      this.unsubMode = c.onMode((m) => {
        if (m.activeHand !== this.lastActiveHand) { this.lastActiveHand = m.activeHand; this.weapons.guardChangeT = this.realT; } // switching hands never cuts
        if (m.bow) this.weapons.ensureBow(this.handViews.left);
        else this.weapons.dismissBow();
        this.cb.bowMode(m.bow);
      });
    }
  }

  setCallActive(v: boolean) { this.callActive = v; if (v) this.cb.pinnedPrompt(false); }

  private onInput(e: InputEvent) {
    if (this.paused || this.mode !== 'match') {
      if (e.type === 'call_sign') this.cb.requestCall();
      return;
    }
    switch (e.type) {
      case 'grab': {
        // webcam: each tracked hand takes for itself (cone target, reach, else the nearest weapon)
        if (!isKeyboardMouse(this.input)) { this.webcamGrab(e.hand); break; }
        const ray = this.aimRay(e.hand);
        // what you click decides the hand: the bow is taken up as with B (left hand, bow mode); the aspis goes on the left arm
        const pick = this.weapons.pickRay(ray);
        if (pick?.cls === 'bow') { this.input.setBowMode(true); break; }
        if (pick?.cls === 'shield' && !this.weapons.drawing && !(this.weapons.heldBy('left') && this.weapons.heldBy('right'))) {
          if (this.weapons.heldBy('left')) this.weapons.swapHands(); // a sword in the left goes to the right first
          if (!this.weapons.heldBy('left')) { this.weapons.grab(this.handViews.left, ray, true); break; }
        }
        if (!this.weapons.heldBy(e.hand)) this.weapons.grab(this.handViews[e.hand], ray);
        else {
          // keyboard (one button): the free hand takes what you point at (second blade → dual wield, aspis → sword & shield)
          const other = e.hand === 'right' ? 'left' : 'right';
          if (!this.weapons.heldBy(other) && !this.weapons.drawing) this.weapons.grab(this.handViews[other], ray, true);
        }
        break;
      }
      case 'release': {
        if (!isKeyboardMouse(this.input)) {
          // webcam grip flicker: a slow "release" just after a take (or while it is still flying in) is noise —
          // the weapon stays; a real throw (≥ 4 m/s) always goes
          const sp = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
          const held = this.weapons.heldBy(e.hand);
          if (this.weapons.incomingTo(e.hand)) break;
          if (held && held.attachT !== undefined && this.weapons.realT - held.attachT < 0.35 && sp < 4) break;
        }
        const v = this.bodyToWorldDir(new THREE.Vector3(e.vel.x, e.vel.y, e.vel.z));
        // webcam throws: the speed is good but the direction is 35–56° off (Part C) — steer toward the wooer you meant
        if (this.input?.kind !== 'keyboard_mouse' && this.weapons.heldBy(e.hand)) this.throwAssist(v);
        this.weapons.release(e.hand, v, this.handViews[e.hand]);
        break;
      }
      case 'swing': break; // the continuous per-hand swing voice (updateTrails) carries this now
      case 'block_start': this.blocking = true; this.weapons.blocking = true; this.prevGuardAt = this.guardAt; this.guardAt = this.realT; this.weapons.guardChangeT = this.realT; break;
      case 'block_end': this.blocking = false; this.weapons.blocking = false; this.guardUpEndT = this.realT; this.weapons.guardChangeT = this.realT; break;
      case 'bow_nock': {
        // webcam: a nock read while the left hand holds an aspis or blade must not rack it (Part C can misread one)
        const L = this.weapons.heldBy('left');
        if (!isKeyboardMouse(this.input) && L && L.cls !== 'bow') break;
        if (this.weapons.ensureBow(this.handViews.left)) this.weapons.nock();
        break;
      }
      case 'bow_release': {
        const aim = this.bodyToWorldDir(new THREE.Vector3(e.aim.x, e.aim.y, e.aim.z));
        this.weapons.loose(e.draw, aim);
        break;
      }
      case 'drink':
        // the body tracker can read a drink during a bow draw or a block (Part C): only the keyboard's E gets a reply
        if (!this.weapons.drink(e.hand) && this.input?.kind === 'keyboard_mouse') this.cb.toast({ kind: 'info', title: 'NOTHING TO DRINK', sub: 'Ask Telemachus for a bottle' }, 1200);
        break;
      case 'call_sign': this.cb.requestCall(); break;
      case 'request_weapon': this.cb.requestWeapon(); break;
      case 'tracking_lost': this.trackingLost = true; this.trackSent = 'lost'; this.cb.tracking('lost'); break;
      case 'tracking_ok': this.trackingLost = false; this.trackSent = 'ok'; this.cb.tracking('ok'); break;
    }
  }

  /** webcam or a recording of one (Part C): tracked hands, VR-style */
  private get tracked() { return this.input?.kind === 'motion' || this.input?.kind === 'replay'; }

  /** A webcam 'grab' event (a fist) for one hand. */
  private webcamGrab(side: Hand) {
    const W = this.weapons, hv = this.handViews[side];
    if (W.heldBy(side)) {
      // a re-closed fist around what you hold just re-confirms the grip; a full pair of hands pointed at more says so
      const other: Hand = side === 'right' ? 'left' : 'right';
      if (W.heldBy(other) && W.coneTarget(this.eye, hv.pos, null)) this.refuse('full');
      return;
    }
    // the bow: pointed at (closer in angle than any other target) it is taken up in the LEFT hand, only while that
    // hand is free — never stolen into the right. Only from a real hand position (live, or frozen < 0.4 s): a ghost
    // resting low in the view points at the table's right end by construction
    const real = hv.visible || this.realT - this.lostAt[side] <= 0.4;
    if (real && !W.drawing && !W.heldBy('left') && !W.incomingTo('left') && this.realT >= this.takeCd[side]) {
      const bow = W.bowInCone(this.eye, hv.pos);
      if (bow && (!this.target[side] || W.angleFromEye(bow, this.eye, hv.pos) < W.angleFromEye(this.target[side]!, this.eye, hv.pos))) {
        this.takeCd[side] = this.realT + 0.4;
        if (W.ensureBow(this.handViews.left)) this.takeStats.event++;
        return;
      }
    }
    this.takeFor(side, 'event');
  }

  /**
   * Take a weapon into one hand (webcam): reach or an arrow catch first, then pull what the hand targets (the
   * grab event alone also falls back to the nearest weapon, so a fist never comes back empty). The aspis goes on
   * the left arm while it is free. Nothing happens while that hand holds something, while something is already
   * flying to it, during a 0.4 s cooldown, or while an arrow is drawn (that fist is the draw).
   */
  private takeFor(side: Hand, path: 'event' | 'level' | 'auto'): boolean {
    const W = this.weapons, hv = this.handViews[side];
    if (W.heldBy(side) || W.incomingTo(side) || this.realT < this.takeCd[side]) return false;
    if (W.drawing) { if (path === 'event' && this.target[side]) this.refuse('bow'); return false; }
    this.takeCd[side] = this.realT + 0.4;
    if (W.catchArrowInto(hv)) { this.levelArmed[side] = false; this.takeStats[path]++; return true; }
    // the grip-level trigger takes only what glows (a relaxed hand hanging by the table must not pick it up);
    // a discrete fist takes what is in reach, else the target, else the nearest — except when the right fist is
    // probably the nock (the bow is up, or Part C sees the left arm held out in the bow pose)
    const nock = side === 'right' && (W.holds('bow') || !!(this.input as { getDebugGestures?: () => { bowReady?: boolean } }).getDebugGestures?.()?.bowReady);
    const w = path === 'level' ? this.target[side]
      : W.reachFor(hv) ?? this.target[side] ?? (!nock ? W.nearestForHand(hv) : null);
    if (!w) { if (path === 'event' && !nock) this.refuse('reach'); return false; }
    const toLeft = w.cls === 'shield' && side === 'right' && !W.heldBy('left') && !W.incomingTo('left');
    const to = toLeft ? this.handViews.left : hv;
    W.pullTo(w, to);
    if (w.state !== 'incoming') return false;
    if (toLeft) this.takeCd.left = this.realT + 0.4;
    this.levelArmed[side] = false;
    this.target[side] = null;
    this.takeStats[path]++;
    return true;
  }

  /** A weapon settled in a hand: flash, sparks, a small jolt and a click (webcam — the keyboard keeps its feel). */
  private onTake(w: WeaponEnt, side: Hand) {
    if (!this.tracked || this.mode !== 'match') return;
    this.hands[side].flash();
    this.fx.sparks(this.handViews[side].pos, null, 10, '#ffd28a');
    this.recoilOff[side].set(0, -0.025, 0.02);
    this.kick(0.35);
    audio.ui('select');
    if (w.cls !== 'bow' && w.cls !== 'shield' && w.cls !== 'potion') this.tutorial('take', 'TAKEN', 'Swing it — open your hand fast to throw');
  }

  /** Why a fist took nothing: a thunk and a short line (at most every 3 s each). */
  private refuse(kind: 'reach' | 'full' | 'bow') {
    if (this.realT - (this.refuseT[kind] ?? -9) < 3) return;
    this.refuseT[kind] = this.realT;
    audio.thunk(0.2);
    const [title, sub] = kind === 'reach' ? ['NOTHING IN REACH', 'Point your hand at a weapon and close it']
      : kind === 'full' ? ['HANDS FULL', 'Open a hand to throw what it holds']
        : ['LOWER THE BOW', 'Drop your bow arm, then take a weapon'];
    this.cb.toast({ kind: 'info', title, sub }, 1300);
  }

  /** Part C: forget grips the game never saw (a fist closed in the lobby or while paused) — guarded, optional. */
  private resyncGrip() {
    const c = this.input as { resyncGrip?: (keep: Record<Hand, boolean>) => void } | null;
    try { c?.resyncGrip?.({ left: !!this.weapons.heldBy('left'), right: !!this.weapons.heldBy('right') }); }
    catch (err) { console.warn('[engine] resyncGrip failed', err); }
  }

  /**
   * Per frame, webcam, in a match: each free hand's cone target (W4) and the grip-level trigger (W1) — a hand
   * seen closed (grip ≥ 0.5) for 0.12 s, freshly seen by the hand model, with a weapon targeted, takes it even if
   * Part C's discrete 'grab' never fired. Also clears a bow draw Part C cancelled silently.
   */
  private updateWebcamHands(state: PlayerInputState, realDt: number) {
    const W = this.weapons;
    const dbg = this.input as { getDebugBody?: () => { handFresh: Record<Hand, boolean> } | null; getDebugGestures?: () => { nocked: boolean } };
    const body = dbg.getDebugBody?.() ?? null;
    for (const side of ['left', 'right'] as const) {
      const hs = state.hands[side], hv = this.handViews[side];
      if (body ? body.handFresh[side] : hs.visible) this.freshAt[side] = this.realT;
      const fresh = this.realT - this.freshAt[side] <= 0.25;
      const free = !W.heldBy(side) && !W.incomingTo(side);
      let t = this.target[side];
      if (!free) t = null;
      else if (hv.visible) t = W.coneTarget(this.eye, hv.pos, t);
      else if (this.realT - this.lostAt[side] > 0.5) t = null; // a lost hand keeps its target for 0.5 s
      if (t && t.state !== 'racked' && t.state !== 'free') t = null;
      this.target[side] = t;
      if (hs.visible && fresh && hs.grip < 0.4) this.levelArmed[side] = true;
      const closed = free && hs.visible && fresh && hs.grip >= 0.5;
      this.gripT[side] = closed ? this.gripT[side] + realDt : 0;
      if (closed && this.gripT[side] >= 0.12 && this.levelArmed[side] && !W.drawing && !W.holds('bow') && this.target[side]) {
        this.takeFor(side, 'level');
      }
    }
    // Part C cancels a nocked arrow without an event (left arm dropped): let the draw go too
    const flags = dbg.getDebugGestures?.();
    if (W.drawing && flags && !flags.nocked) {
      this.unnockT += realDt;
      if (this.unnockT > 0.25) { W.drawing = false; this.unnockT = 0; }
    } else this.unnockT = 0;
    // optional safety net (?autoarm=1, off by default): empty-handed 5 s with a wooer close → a xiphos flies to you
    if (AUTO_ARM) {
      const empty = !W.heldBy('left') && !W.heldBy('right') && !W.incomingTo('left') && !W.incomingTo('right');
      this.unarmedT = empty ? this.unarmedT + realDt : 0;
      if (this.unarmedT > 5 && this.enemies.list.some((en) => !en.dead && en.kind !== 'hero' && en.state !== 'idle' && Math.hypot(en.pos.x - this.eye.x, en.pos.z - this.eye.z) < 4)) {
        this.unarmedT = -10;
        this.takeCd.right = -9;
        if (this.takeFor('right', 'auto')) this.cb.toast({ kind: 'info', title: 'TAKE IT, FATHER', sub: 'A fist holds it — open your hand fast to throw' }, 2200);
      }
    }
  }

  /** Forward 'ok' ↔ 'degraded' to the HUD (Part C only sends events for lost/ok), held 0.5 s so it can't flicker. */
  private pollTracking(s: PlayerInputState['tracking']) {
    if (s !== 'ok' && s !== 'degraded') return;
    if (s !== this.trackSeen) { this.trackSeen = s; this.trackSince = this.realT; }
    if (!this.trackingLost && s !== this.trackSent && this.realT - this.trackSince >= 0.5) { this.trackSent = s; this.cb.tracking(s); }
  }

  /** Per-hand status for the HUD glove chips (webcam, in a match): live / ghost / lost and how closed the hand is. */
  handStatus(): Record<Hand, { state: 'live' | 'ghost' | 'lost'; grip: number; holding: boolean }> | null {
    if (!this.tracked || this.mode !== 'match' || !this.lastState) return null;
    const one = (side: Hand) => {
      const hs = this.lastState!.hands[side];
      const st: 'live' | 'ghost' | 'lost' = hs.visible ? 'live' : this.trackingLost || this.realT - this.lostAt[side] > 2 ? 'lost' : 'ghost';
      return { state: st, grip: hs.visible ? clamp(hs.grip, 0, 1) : 0, holding: !!this.weapons.heldBy(side) };
    };
    return { left: one('left'), right: one('right') };
  }

  private yaw = 0;
  /** Where the player is pointing: the cursor ray (keyboard & mouse) or eye → hand (motion). */
  private aimRay(hand: Hand) {
    if (isKeyboardMouse(this.input)) {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(this.input.cursor.x, this.input.cursor.y), this.camera);
      return { origin: rc.ray.origin.clone(), dir: rc.ray.direction.clone() };
    }
    const h = this.handViews[hand];
    return { origin: this.eye.clone(), dir: h.pos.clone().sub(this.eye).normalize() };
  }

  /** Pose the first-person body after the hands: webcam elbows (Part C's tracked skeleton) steer the arms. */
  private updatePlayerBody(state: PlayerInputState | null, realDt: number, playing: boolean) {
    const pb = this.playerBody;
    if (!pb) return;
    const on = playing && !!state;
    pb.setVisible(on);
    // webcam (VR-style): your real forearm joins the gauntlet, so its vambrace tube goes; keyboard keeps the tuned
    // viewmodel (there the forearm sits below the narrow view and the gauntlet would float)
    const tracked = this.input?.kind === 'motion' || this.input?.kind === 'replay';
    this.hands.left.setForearmVisible(!(on && tracked)); this.hands.right.setForearmVisible(!(on && tracked));
    if (!on || !state) return;
    const dbg = this.input as unknown as { getDebugBody?: () => { ok: boolean; elbow: Record<Hand, { x: number; y: number; z: number }> } | null };
    const body = this.input?.kind === 'motion' ? dbg.getDebugBody?.() ?? null : null;
    const up = new THREE.Vector3(0, 1, 0);
    for (const side of ['left', 'right'] as const) {
      const el = body?.ok ? body.elbow[side] : null;
      if (el) this.trackedElbows[side] = (this.trackedElbows[side] ?? new THREE.Vector3()).set(el.x, el.y, el.z).applyAxisAngle(up, this.yaw).add(this.eye);
      else this.trackedElbows[side] = null;
    }
    pb.update({ eye: this.eye, yaw: this.yaw, crouch: state.body.crouch ?? 0, hands: this.handViews, elbows: this.trackedElbows }, realDt);
  }

  private bodyToWorldDir(v: THREE.Vector3) { return v.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw); }

  /** Aim assist for a tracked (webcam) throw: the nearest living wooer within 40° of the throw, in front of you,
   *  takes it — the direction turns to his chest (with a little lob for the distance), the speed stays yours. */
  private throwAssist(v: THREE.Vector3) {
    const sp = v.length();
    if (sp < 2.5) return; // a drop, not a throw
    const dirH = new THREE.Vector3(v.x, 0, v.z);
    if (dirH.lengthSq() < 1e-4) return;
    dirH.normalize();
    let best: THREE.Vector3 | null = null, bestCos = Math.cos(THREE.MathUtils.degToRad(40));
    for (const en of this.enemies.list) {
      if (en.dead || en.kind === 'hero' || en.state === 'idle') continue;
      const to = new THREE.Vector3().subVectors(en.pose[P.Torso].c, this.eye);
      const d = Math.hypot(to.x, to.z);
      if (d < 0.6 || d > 14) continue;
      const c = (to.x * dirH.x + to.z * dirH.z) / d;
      if (c > bestCos) { bestCos = c; best = to; }
    }
    if (!best) return;
    const d = Math.hypot(best.x, best.z);
    best.y += Math.min(0.6, d * d * 0.012); // gravity drop over the distance
    v.copy(best.normalize().multiplyScalar(sp));
  }

  // ── modes ──
  private setupMenu() {
    this.mode = 'menu';
    this.enemies.clear();
    const seats: [number, number, number][] = [[-3.9, -7.4, -Math.PI / 2], [-3.9, -9.8, -Math.PI / 2], [3.9, -12.2, Math.PI / 2], [-3.9, -18.0, -Math.PI / 2], [3.9, -14.0, Math.PI / 2], [1.9, -16.2, Math.PI + 0.4]];
    for (const [x, z, yaw] of seats) {
      const e = this.enemies.spawn('suitor', new THREE.Vector3(x, 0, z), { idle: true });
      if (e) e.yaw = yaw;
    }
    // Odysseus himself, home at last — framed by the hearth on the title screen
    const hero = this.enemies.spawn('hero', new THREE.Vector3(0.55, 0, -9.2), { idle: true });
    if (hero) hero.yaw = -0.25;
    for (const g of Object.values(this.hands)) g.root.visible = false;
    audio.setIntensity(0);
  }

  startMatch(difficulty: 'easy' | 'normal') {
    this.difficulty = difficulty;
    this.enemies.clear();
    this.weapons.resetForMatch();
    this.scoring.reset();
    this.forgedKills.clear();
    this.health = 100;
    this.lowHealthArmed = true;
    this.lastPinnedEvt = -99;
    this.killEventCount = 0;
    this.simT = 0;
    this.matchStartReal = this.realT;
    this.slow.active = false;
    this.timeScale = 1;
    this.paused = false;
    for (const side of ['left', 'right'] as const) {
      this.target[side] = null; this.gripT[side] = 0; this.levelArmed[side] = true; this.takeCd[side] = -9;
    }
    this.unnockT = 0; this.unarmedT = 0;
    // a fist closed in the lobby / calibration was dropped by the menu: start the match with the grip latch open
    this.resyncGrip();
    this.mode = 'match';
    for (const g of Object.values(this.hands)) g.root.visible = true;
    this.cb.hud({ health: 100, score: 0, combo: 1, kills: 0, boss: null, intermission: null, pinnedPrompt: false });
    audio.startAmbience();
    audio.setIntensity(0.4);
    this.emit('match_start', { wave: 1, health: 100 });
    this.director.start();
  }

  backToMenu() {
    this.weapons.clearAll();
    this.weapons.spawnStarterKit();
    this.setupMenu();
  }

  setPaused(p: boolean) {
    // resuming: grips changed while paused were dropped — resync before events flow again (releases emitted here
    // are for hands the game doesn't hold, and still land while paused)
    if (this.paused && !p && this.mode === 'match') this.resyncGrip();
    this.paused = p;
  }

  private finish(victory: boolean) {
    if (this.mode !== 'match') return;
    this.mode = 'ended';
    const durationMs = (this.realT - this.matchStartReal) * 1000;
    this.emit('match_end', { score: this.scoring.score, wave: this.director.wave, health: Math.round(this.health) });
    audio.setIntensity(0);
    if (victory) { audio.gong(110, 7, 0.45); audio.lyre([0, 4, 7, 12, 16, 19], 0.12, 196); }
    else audio.gong(55, 8, 0.5);
    this.startSlowmo(undefined, 2.4);
    setTimeout(() => {
      if (this.disposed) return;
      this.cb.matchEnd({
        victory, score: this.scoring.score, kills: this.scoring.kills, durationMs,
        trickshots: { ...this.scoring.trickshots }, bestCombo: this.scoring.bestCombo, wave: this.director.wave,
        forgedKills: Object.fromEntries(this.forgedKills),
      });
    }, 2600);
  }

  /** Abort the current match (pause menu "Quit"). */
  quit() { if (this.mode === 'match') this.finish(false); }

  // ── forged weapons ──
  async spawnForged(ws: WeaponSpawn) {
    this.hall.setStoreroomGlow(1);
    audio.gong(147, 3, 0.25);
    const dominant = (): Hand | null => {
      if (this.mode !== 'match') return null; // lobby/menu: lands on the rack
      const r = this.weapons.heldBy('right');
      if (!r && this.handViews.right.grip < 0.5) return 'right';
      const l = this.weapons.heldBy('left');
      if (!l && this.handViews.left.grip < 0.5 && !this.weapons.drawing) return 'left';
      return null;
    };
    try {
      await this.weapons.spawnForged(ws, dominant);
    } catch (err) {
      console.warn('[engine] forged spawn failed', err);
    }
  }
  forgeGlow(v: number) { this.hall.setStoreroomGlow(v); }

  // ── combat hooks ──
  private emit(kind: GameEventKind, data?: GameEvent['data']) {
    const t = Math.round((this.realT - this.matchStartReal) * 1000);
    this.cb.emit({ kind, t, data });
  }

  private onWaveStart(w: WaveDef) {
    // Telemachus restocks the quiver between waves (12 to start, +6 a wave, max 18)
    this.weapons.quiver = w.n <= 1 ? 12 : Math.min(18, this.weapons.quiver + 6);
    this.waveKills = 0;
    audio.gong(82, 6, 0.42);
    audio.setIntensity(0.35 + w.n * 0.2);
    this.cb.hud({ wave: w.n, waveTitle: w.title, intermission: null });
    this.cb.toast({ kind: 'wave', title: `WAVE ${['I', 'II', 'III'][w.n - 1] ?? w.n} · ${w.title.toUpperCase()}`, sub: w.sub }, 3000);
    this.emit('wave_start', { wave: w.n, enemiesLeft: w.spawns.length });
  }

  private onWeaponHit(w: WeaponEnt | null, r: HitResult, info: HitInfo) {
    const enemy = r.enemy;
    if (r.shieldBroke) this.cb.toast({ kind: 'info', title: enemy.kind === 'boss' ? 'HIS GILDED SHIELD BREAKS' : 'SHIELD BROKEN' }, 1400);
    if (r.parried) { this.tutorial('parried', 'TURNED ASIDE', 'He blocked — strike where his guard is open'); return; }
    if (r.glanced) { this.tutorial('glance', 'GLANCED OFF BRONZE', 'Cut the neck, arms or legs — or thrust'); return; }
    if (r.blocked) return;
    const tier = info.speed < 3.5 ? 0.1 : info.speed < 7 ? 0.25 : 0.4;
    if (!r.killed) this.addTrauma(info.source === 'melee' ? tier : 0.05);
    this.kick(info.source === 'melee' ? 0.6 + tier * 2 : 0.3);
    void w;
  }

  private onSever(e: Enemy, part: number, alive: boolean) {
    this.addTrauma(0.3);
    this.kick(1.2);
    if (alive && (part === P.UArmR || part === P.LArmR)) this.cb.toast({ kind: 'trickshot', title: 'DISARMED', sub: 'his sword arm is gone', points: 150 }, 1300);
    else if (alive && (part === P.UArmL || part === P.LArmL)) this.cb.toast({ kind: 'info', title: e.look.shield !== 'none' ? 'SHIELD ARM SEVERED' : 'ARM SEVERED', points: 100 }, 1000);
    if (alive) this.scoring.addPoints(part === P.UArmR || part === P.LArmR ? 150 : 100);
  }

  private onKill(e: Enemy, info: HitInfo, how: { decapitated: boolean; finisher: boolean; severed: number | null } = { decapitated: false, finisher: false, severed: null }) {
    const w = info.weaponEntId !== null ? this.weapons.list.find((x) => x.id === info.weaponEntId) ?? null : null;
    const now = this.simT;
    const multi = w ? w.throwKills.filter((t) => now - t < 1.5).length + (w.state === 'free' ? 1 : 0) : 0;
    const res = this.scoring.onKill({
      t: now, realT: this.realT, zone: how.decapitated || (info.source === 'melee' && info.zone === 'head') ? 'torso' : info.zone, /* HEADSHOT: thrown & loosed shots only — a beheading is its own toast */ distance: Math.hypot(e.pose[P.Torso].c.x - this.eye.x, e.pose[P.Torso].c.z - this.eye.z),
      airborne: !!(info as HitInfo & { airborne?: boolean }).airborne,
      ricochet: !!w && w.state === 'free' && w.staticHits >= 1,
      multiCount: info.source === 'bomb' ? 0 : multi,
      forged: !!w?.forged,
      returnToSender: !!w?.returnToSender,
    });
    if (w?.forged) {
      w.kills++;
      this.forgedKills.set(w.forged.weaponId, (this.forgedKills.get(w.forged.weaponId) ?? 0) + 1);
      this.emit('item_kill', { weaponName: w.name, weaponId: w.forged.weaponId, score: this.scoring.score });
    }
    if (how.decapitated || how.finisher) {
      const title = how.decapitated ? 'DECAPITATED' : 'EXECUTED';
      this.cb.toast({ kind: 'trickshot', title: res.tricks.length ? `${title} + ${res.tricks.filter((t) => t !== 'headshot').map((t) => TRICK_TITLES[t]).join(' + ')}`.replace(/ \+ $/, '') : title, points: res.points }, 1500);
      for (const t of res.tricks) this.emit('trickshot', { trickshot: t, score: this.scoring.score, combo: this.scoring.combo, weaponName: w?.name });
      audio.stinger(true);
      if (this.realT - this.lastDecapSlow > 10 || !this.seenDecap) { this.seenDecap = true; this.lastDecapSlow = this.realT; this.startSlowmo('headshot', 1.3, w?.name); }
    } else this.announceTricks(res.tricks, res.points, res.slowmo, w?.name);
    this.killEventCount++;
    this.waveKills++;
    if (res.tricks.length || this.killEventCount % 3 === 0) {
      this.emit('enemy_killed', { score: this.scoring.score, combo: res.combo, enemiesLeft: this.director.remaining, trickshot: res.tricks[0], killer: 'player' });
    }
    if (e.kind === 'boss') {
      this.cb.toast({ kind: 'trickshot', title: 'ANTINOUS FALLS', points: res.points }, 2200);
      this.cb.hud({ boss: null });
    }
    this.pushHud();
  }

  private announceTricks(tricks: TrickshotKind[], points: number, slowmo: boolean, weaponName?: string) {
    if (tricks.length) {
      const title = tricks.map((t) => TRICK_TITLES[t]).join(' + ');
      this.cb.toast({ kind: 'trickshot', title, points }, 1400);
      for (const t of tricks) this.emit('trickshot', { trickshot: t, score: this.scoring.score, combo: this.scoring.combo, weaponName });
      audio.stinger(slowmo);
      if (slowmo) this.startSlowmo(tricks.includes('multi_kill') ? 'multi_kill' : tricks.includes('friend_assist') ? 'friend_assist' : tricks[0], undefined, weaponName);
    } else {
      this.cb.toast({ kind: 'info', title: '+100', points }, 700);
    }
  }

  private onPinned(w: WeaponEnt, enemy: Enemy) {
    const r = this.scoring.onPin(this.realT);
    this.cb.toast({ kind: 'trickshot', title: 'PINNED', sub: 'to the pillar', points: r.points }, 1600);
    this.emit('trickshot', { trickshot: 'pin', score: this.scoring.score, weaponName: w.name });
    audio.stinger(true);
    if (r.slowmo) this.startSlowmo('pin', undefined, w.name);
    void enemy;
  }

  private onExplode(w: WeaponEnt, killed: Enemy[]) {
    if (killed.length >= 2) {
      this.scoring.trickshots.multi_kill++;
      const bonus = TRICK_POINTS.multi_kill * killed.length;
      this.scoring.addPoints(bonus);
      this.cb.toast({ kind: 'trickshot', title: `GREEK FIRE ×${killed.length}`, points: bonus }, 1600);
      this.emit('trickshot', { trickshot: 'multi_kill', score: this.scoring.score, weaponName: w.name });
      this.startSlowmo('multi_kill', undefined, w.name);
    }
  }

  private hurt(dmg: number, source: 'melee' | 'arrow', from: THREE.Vector3, heavy = false) {
    if (this.mode !== 'match') return;
    const k = this.difficulty === 'easy' ? 0.6 : 1;
    this.health = Math.max(0, this.health - dmg * k);
    if (this.difficulty === 'easy') this.health = Math.max(1, this.health);
    this.lastHurtT = this.realT;
    // flash ≤ 2/s (photosensitivity), directional arc, camera kick 2–3°, colour drain 300 ms
    if (this.realT - this.lastFlashT > 0.5) { this.post.flash = Math.min(1, this.post.flash + (dmg > 5 ? 0.6 : 0.25)); this.lastFlashT = this.realT; }
    const rel = new THREE.Vector3().subVectors(from, this.eye).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
    this.damageArcs.push({ angle: Math.atan2(rel.x, -rel.z), t: this.realT, heavy });
    if (this.damageArcs.length > 6) this.damageArcs.shift();
    this.drainT = this.realT;
    this.kick(heavy ? 3 : dmg > 5 ? 2 : 0.8);
    if (dmg > 5) this.hitstop(80);
    this.addTrauma(dmg > 5 ? 0.6 : 0.15);
    audio.hurt();
    audio.setHealth(this.health);
    this.emit('player_hit', { health: Math.round(this.health) });
    if (this.health < 35 && this.lowHealthArmed) { this.lowHealthArmed = false; this.emit('health_low', { health: Math.round(this.health) }); }
    this.checkPinned();
    this.pushHud();
    void source; void from;
    if (this.health <= 0) this.finish(false);
  }

  private heal(n: number) {
    this.health = Math.min(100, this.health + n);
    if (this.health >= 35) this.lowHealthArmed = true;
    this.post.heal = 1;
    this.fx.heal(this.handViews.right.pos);
    audio.setHealth(this.health);
    this.cb.toast({ kind: 'gift', title: `+${n} HEALTH` }, 1200);
    this.pushHud();
  }

  private checkPinned() {
    const near = this.enemies.countNear(2.5);
    if ((near >= 3 || this.health < 25) && this.realT - this.lastPinnedEvt > 20) {
      this.lastPinnedEvt = this.realT;
      this.emit('player_pinned', { health: Math.round(this.health), enemiesLeft: this.director.remaining });
      if (!this.callActive) this.cb.pinnedPrompt(true);
      setTimeout(() => this.cb.pinnedPrompt(false), 6000);
    }
  }

  // ── time ──
  hitstop(ms: number) {
    if (this.slow.active) return;
    this.hitstopT = Math.max(this.hitstopT, ms / 1000);
    // only a real bite (≥ 70 ms) sticks the hand in the wound; a graze lets the edge carry on through (shoulder → neck)
    if (ms >= 70) this.handStickUntil = Math.max(this.handStickUntil, this.realT + ms / 1000);
  }
  addTrauma(v: number) { this.trauma = Math.min(1, this.trauma + v); }

  startSlowmo(trick?: TrickshotKind, hold = 1.6, weaponName?: string) {
    if (this.slow.active) { this.slow.t = Math.min(this.slow.t, 0.15); return; }
    this.slow = { active: true, t: 0, hold };
    audio.slowIn();
    this.cb.slowmo(true, trick, weaponName);
  }

  // ── main loop ──
  tick(realDt: number) {
    if (this.disposed) return;
    realDt = Math.min(realDt, 0.1);
    this.realT += realDt;
    this.lastRealDt = realDt;
    const state = this.input?.getState() ?? null;
    this.lastState = state;
    if (state && this.input && 'getPendingGesture' in this.input) {
      const g = (this.input as { getPendingGesture?: () => { name: string; progress: number } | null }).getPendingGesture?.() ?? null;
      this.cb.pendingGesture(g);
    }
    if (state && this.tracked) this.pollTracking(state.tracking);

    // time scale: slow-mo ramp (150 ms in, hold, 250 ms out) · hitstop · tracking-lost soft slow
    let target = 1;
    if (this.slow.active) {
      this.slow.t += realDt;
      const s = this.slow;
      if (s.t < 0.15) target = 1 - 0.8 * (s.t / 0.15);
      else if (s.t < 0.15 + s.hold) target = 0.2;
      else if (s.t < 0.4 + s.hold) target = 0.2 + 0.8 * ((s.t - 0.15 - s.hold) / 0.25);
      else { s.active = false; this.cb.slowmo(false); }
    }
    this.softSlow = damp(this.softSlow, this.trackingLost && this.mode === 'match' ? 0.2 : 1, 4, realDt);
    if (this.realT < this.micro.until) target = Math.min(target, this.micro.scale);
    let scale = target * this.softSlow;
    if (this.hitstopT > 0) { this.hitstopT -= realDt; scale *= 0.05; }
    if (this.paused) scale = 0;
    this.timeScale = scale;
    audio.rate = this.slow.active ? 0.6 : 1;

    this.updatePlayer(state, realDt);

    // physics: fixed real-time steps, each advancing sim by FIXED × scale
    this.acc += realDt;
    const nSteps = Math.min(3, Math.floor(this.acc / FIXED));
    let steps = 0;
    while (steps < nSteps) {
      this.acc -= FIXED;
      steps++;
      this.lerpStepViews(steps / nSteps);
      const dt = FIXED * scale;
      if (dt <= 0) continue;
      this.simStep(dt, FIXED);
    }
    if (steps > 0) for (const side of ['left', 'right'] as const) {
      const hv = this.handViews[side], pv = this.stepPrev[side];
      pv.pos.copy(hv.pos); pv.fwd.copy(hv.forward); pv.up.copy(hv.up);
    }
    if (steps === 3) this.acc = 0;

    const ambientDt = realDt * (this.paused ? 0 : Math.max(0.25, scale));
    this.fx.update(realDt * (this.paused ? 0 : Math.max(0.15, scale)), ambientDt);
    this.hall.update(this.realT, realDt);
    this.enemies.render();
    this.updateTrails(realDt);
    this.updateCamera(state, realDt);
    this.updatePost(realDt);

    this.hudTimer += realDt;
    if (this.hudTimer > 0.1 && this.mode === 'match') { this.hudTimer = 0; this.pushHud(); }
  }

  /** Hand pose at fraction k of the way from the last stepped pose to this frame's pose. */
  private lerpStepViews(k: number) {
    for (const side of ['left', 'right'] as const) {
      const hv = this.handViews[side], sv = this.stepViews[side], pv = this.stepPrev[side];
      sv.visible = hv.visible; sv.grip = hv.grip; sv.vel.copy(hv.vel);
      if (k >= 1) { sv.pos.copy(hv.pos); sv.forward.copy(hv.forward); sv.up.copy(hv.up); sv.quat.copy(hv.quat); continue; }
      sv.pos.copy(pv.pos).lerp(hv.pos, k);
      sv.forward.copy(pv.fwd).lerp(hv.forward, k).normalize();
      sv.up.copy(pv.up).lerp(hv.up, k);
      sv.up.addScaledVector(sv.forward, -sv.up.dot(sv.forward)).normalize();
      if (sv.up.lengthSq() < 0.5 || !Number.isFinite(sv.forward.x)) { sv.pos.copy(hv.pos); sv.forward.copy(hv.forward); sv.up.copy(hv.up); sv.quat.copy(hv.quat); continue; }
      basisQuat(sv.forward, sv.up, sv.quat);
    }
  }

  private simStep(dt: number, realDt: number) {
    this.simT += dt;
    this.world.timestep = dt;
    if (this.mode === 'match') this.director.update(dt);
    this.enemies.update(dt);
    this.weapons.prestep(this.stepViews, realDt);
    this.world.step(this.weapons.queue);
    this.weapons.poststep(dt, realDt, this.stepViews);
    if (this.mode === 'match') {
      this.weapons.upkeep(dt);
      // easy-mode regen
      if (this.difficulty === 'easy' && this.realT - this.lastHurtT > 4 && this.health < 100) this.health = Math.min(100, this.health + dt * 3);
      if (Math.random() < dt * 2) this.checkPinned();
    }
  }

  private updatePlayer(state: PlayerInputState | null, realDt: number) {
    const lean = state?.body.lean ?? 0;
    const crouch = state?.body.crouch ?? 0;
    // webcam: a quarter of the body's turn; keyboard/mouse: the edge-turn yaw directly
    this.yaw = damp(this.yaw, -(state?.body.yaw ?? 0) * (isKeyboardMouse(this.input) ? 1 : 0.25), 6, realDt);
    this.eye.set(lean * 0.6, HALL.eye.y - crouch * 0.5, 0);
    const sign = Math.abs(lean) > 0.5 ? Math.sign(lean) : 0;
    if (sign !== 0 && sign !== this.leanSign) this.leanCrossT = this.realT;
    this.leanSign = sign;
    // balance returns only once you stop turtling (guard down ≥ 1 s)
    if (!this.blocking) this.guardDownT += realDt; else this.guardDownT = 0;
    if (this.realT - this.postureT > 1 && this.guardDownT > 1) this.playerPosture = Math.max(0, this.playerPosture - realDt * 15);
    const playing = this.mode === 'match' || this.mode === 'ended';
    for (const side of ['left', 'right'] as const) {
      const hv = this.handViews[side];
      const hs = state?.hands[side];
      const g = this.hands[side];
      if (!hs || !playing) { g.root.visible = false; continue; }
      g.root.visible = true;
      hv.visible = hs.visible;
      if (hs.visible !== this.wasLive[side]) {
        this.wasLive[side] = hs.visible;
        if (hs.visible) this.backAt[side] = this.realT; else this.lostAt[side] = this.realT;
      }
      if (hs.visible) {
        const tgt = this.handTarget[side].set(hs.pos.x, hs.pos.y, hs.pos.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).add(this.eye);
        tgt.add(this.recoilOff[side]);
        this.recoilOff[side].multiplyScalar(Math.exp(-realDt / 0.15));
        const prev = hv.pos.clone();
        // webcam reacquire: the hand glides in from where it rested (no teleport, and the jump is no punch)
        const back = this.tracked && this.realT - this.backAt[side] < 0.15;
        // parried → input damped; during hitstop the hand that landed the blow sticks in the target and catches up after
        const rate = this.realT < this.dampUntil[side] ? 10 : this.realT < this.handStickUntil ? 6 : back ? 12 : 42;
        hv.pos.lerp(tgt, 1 - Math.exp(-rate * realDt)); // ≈0.5/frame at 60 fps, hides jitter
        hv.vel.copy(hv.pos).sub(prev).multiplyScalar(1 / Math.max(1e-3, realDt));
        if (back) hv.vel.clampLength(0, 2);
        hv.forward.set(hs.forward.x, hs.forward.y, hs.forward.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).normalize();
        hv.up.set(hs.up.x, hs.up.y, hs.up.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).normalize();
        basisQuat(hv.forward, hv.up, hv.quat);
      } else {
        hv.vel.set(0, 0, 0);
        // webcam (VR-style): a lost hand freezes 0.4 s, then settles at a rest spot low in the view — never gone
        if (this.tracked && this.realT - this.lostAt[side] > 0.4) this.restHand(side, realDt);
      }
      hv.grip = hs.grip;
      // a fist around a hilt: the forearm runs back toward the elbow (not along the blade), the blade leaves the
      // fist across the palm — so you see a hand gripping a sword, never the bracer's end staring at you
      const heldW = this.weapons.heldBy(side);
      if (heldW && heldW.cls !== 'bow' && heldW.cls !== 'shield' && hs.visible) {
        const sd = side === 'right' ? 1 : -1;
        const elbow = _gv1.set(0.22 * sd, -0.45, 0.05).applyAxisAngle(_UP, this.yaw).add(this.eye);
        const b = _gv2.copy(hv.forward).normalize();
        const Y = _gv3.subVectors(hv.pos, elbow);
        const fl = Math.max(1e-4, Y.length());
        Y.addScaledVector(b, -Y.dot(b));
        // when the blade continues the forearm line (a cut or thrust) the perpendicular is degenerate: fall back to
        // the forearm hanging below the fist (fingers 'up' ⊥ blade)
        const w = Math.min(1, Y.length() / fl / 0.5);
        const up = _gv6.set(0, 1, 0).addScaledVector(b, -b.y).normalize();
        Y.normalize().multiplyScalar(w).addScaledVector(up, 1 - w);
        if (Y.lengthSq() < 1e-6) Y.copy(up);
        Y.normalize();
        const X = _gv4.copy(b).multiplyScalar(-sd);
        const Z = _gv5.crossVectors(X, Y).normalize();
        _gm.makeBasis(X, Y, Z);
        _gq.setFromRotationMatrix(_gm);
        const at = _gv1.set(0, 0.055, -0.022).applyQuaternion(_gq);
        g.update(_gv6.copy(hv.pos).sub(at), _gq, hs.grip, hs.visible, true, realDt);
      } else {
        // a ghost hand shows relaxed fingers unless it holds something (Part C pins a lost hand's grip at 1)
        const showGrip = hs.visible || !this.tracked ? hs.grip : heldW ? 1 : 0.3;
        g.update(hv.pos, hv.quat, showGrip, hs.visible, !!heldW, realDt);
      }
    }
    this.hands.left.setHealth(this.health / 100);
    if (state && this.tracked && this.mode === 'match' && !this.paused) this.updateWebcamHands(state, realDt);
    this.updatePlayerBody(state, realDt, playing);
    // blade history for deflect timing (last 0.5 s)
    for (const side of ['left', 'right'] as const) {
      const w = this.weapons.heldBy(side);
      if (!w || w.cls === 'bow' || w.cls === 'shield') continue;
      const r = w.body.rotation();
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const t = w.body.translation();
      const g = new THREE.Vector3(t.x, t.y, t.z);
      const a = w.segA.clone().applyQuaternion(q).add(g);
      const b = w.segB.clone().applyQuaternion(q).add(g).addScaledVector(new THREE.Vector3().subVectors(w.segB, w.segA).normalize().applyQuaternion(q), 0.1);
      const vel = w.tip.clone().sub(w.prevTip).multiplyScalar(1 / Math.max(1e-3, this.lastRealDt));
      this.bladeHist.push({ t: this.realT, side, a, b, speed: w.speed, vel, intent: isKeyboardMouse(this.input) ? this.input.intentOf(side) : 'driven' });
    }
    while (this.bladeHist.length && this.realT - this.bladeHist[0].t > 0.5) this.bladeHist.shift();
    this.weapons.bowDraw = state?.bowDraw ?? 0;
  }

  /** Ease a lost hand to its camera-relative rest spot (≈40° below the view centre, inside the fight view). */
  private restHand(side: Hand, realDt: number) {
    const hv = this.handViews[side];
    const sd = side === 'left' ? -1 : 1;
    const k = 1 - Math.exp(-3 * realDt);
    hv.pos.lerp(_rv1.set(0.2 * sd, -0.36, -0.42).applyAxisAngle(_UP, this.yaw).add(this.eye), k);
    hv.forward.lerp(_rv2.set(0, 0.55, -0.83).applyAxisAngle(_UP, this.yaw), k).normalize();
    hv.up.lerp(_rv3.set(sd, 0, 0).applyAxisAngle(_UP, this.yaw), k);
    hv.up.addScaledVector(hv.forward, -hv.up.dot(hv.forward));
    if (hv.up.lengthSq() < 1e-6) hv.up.copy(_rv3).addScaledVector(hv.forward, -_rv3.dot(hv.forward));
    hv.up.normalize();
    basisQuat(hv.forward, hv.up, hv.quat);
  }

  private updateCamera(state: PlayerInputState | null, realDt: number) {
    const cam = this.camera;
    if ((this.mode as string) === 'inspect') {
      // dev: camera is driven externally (tests/screenshots)
    } else if (this.mode === 'menu') {
      this.menuT += realDt;
      const u = (Math.sin(this.menuT * 0.035 - Math.PI / 2) + 1) / 2; // slow dolly in/out
      cam.position.set(Math.sin(this.menuT * 0.05) * 0.6, 2.25 - u * 0.35, 1.8 - u * 7.5);
      cam.lookAt(Math.sin(this.menuT * 0.04) * 0.8, 1.55, -22);
      this.fov = damp(this.fov, 50, 2, realDt);
    } else {
      cam.position.copy(this.eye);
      const drawing = this.weapons.drawing && (state?.bowDraw ?? 0) > 0.2;
      // webcam: a wider, VR-like view so your tracked hands and arms stay in frame through the fighting range
      const wide = this.input?.kind === 'motion' || this.input?.kind === 'replay';
      // (webcam slow-mo keeps the wide view: narrowing it on a kill drops your hands out of frame)
      const fovTarget = (drawing ? 48 : this.slow.active && !wide ? 48 : 55) + (wide ? 20 : 0);
      this.fov = damp(this.fov, fovTarget, 6, realDt);
      // handheld sway ~0.3° @ 0.7 Hz + trauma² shake (≤ 2°)
      const sway = THREE.MathUtils.degToRad(0.3);
      const sh = this.trauma * this.trauma * this.shakeScale;
      const maxRot = THREE.MathUtils.degToRad(2);
      const t = this.realT;
      // keyboard/mouse: pushing the cursor to the bottom edge tilts the view down (legs, dropped blades)
      const cy = isKeyboardMouse(this.input) ? this.input.cursor.y : 0;
      // empty-handed with no wooer close: glance down at the weapon table so it's in view
      const unarmed = !this.weapons.heldBy('left') && !this.weapons.heldBy('right');
      const near = this.enemies.list.some((en) => !en.dead && en.kind !== 'hero' && en.state !== 'idle' && Math.hypot(en.pos.x - this.eye.x, en.pos.z - this.eye.z) < 2.6);
      // three tiers: empty-handed glance at the table · cursor low = leg tilt · Tab or the very bottom edge = full
      // glance at the weapon table (the telegraph arcs keep drawing, but the centre wooer's neck leaves the frame)
      const tab = isKeyboardMouse(this.input) && this.input.glancing;
      // armed with a wooer in reach, a low cut must not drag the view off the fight: only Tab looks down then
      const fighting = !unarmed && near;
      const full = tab || (cy < -0.92 && !fighting);
      // webcam: still unarmed with a wooer close, a smaller glance keeps the table hilts (≈58° down) in frame
      const glance = this.mode === 'match' && unarmed ? (!near ? 0.45 : wide ? 0.2 : 0) : 0;
      // webcam: the head rests a little lower (≈11°) — your hands and forearms ride the bottom of the view
      const bodyTilt = this.input?.kind === 'motion' || this.input?.kind === 'replay' ? 0.2 : 0;
      const target = bodyTilt + (full ? (fighting ? 0.5 : 0.62) : Math.max(glance, cy < -0.55 && !fighting ? Math.min(1, (-0.55 - cy) / 0.37) * 0.42 : 0));
      this.lookDown = damp(this.lookDown, target, full ? 12 : 6, realDt);
      const pitch = -0.1 - this.lookDown + Math.sin(t * 0.7 * Math.PI * 2) * sway * 0.6 + (Math.sin(t * 37) * 0.5 + Math.sin(t * 23) * 0.5) * maxRot * sh;
      const yaw = this.yaw + Math.sin(t * 0.43 * Math.PI * 2) * sway + Math.sin(t * 31 + 1) * maxRot * sh;
      const roll = Math.sin(t * 29 + 2) * maxRot * 0.5 * sh;
      // camera kick: 60 ms out, ~180 ms back (critically damped spring)
      this.kickPitch += this.kickVel * realDt;
      this.kickVel += (-this.kickPitch * 220 - this.kickVel * 26) * realDt;
      cam.rotation.set(pitch + this.kickPitch, yaw, roll, 'YXZ');
      cam.position.x += Math.sin(t * 41) * 0.015 * sh;
      cam.position.y += Math.sin(t * 43 + 1) * 0.015 * sh;
    }
    this.trauma = Math.max(0, this.trauma - realDt * 1.5);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    if (isKeyboardMouse(this.input)) {
      this.input.setCamera({ fovY: THREE.MathUtils.degToRad(cam.fov), aspect: cam.aspect, pitch: -0.1 - this.lookDown });
      for (const h of ['left', 'right'] as const) {
        const w = this.weapons.heldBy(h);
        this.input.setArmed(h, !!w && w.cls !== 'bow' && w.cls !== 'shield', w ? w.segB.length() : undefined, !!w, w?.spec.massKg);
      }
      // hover: with a hand free, the weapon under the cursor glows and is named (10 Hz pick)
      if (this.mode === 'match') {
        this.hoverAcc += realDt;
        if (this.hoverAcc > 0.1) {
          this.hoverAcc = 0;
          const free = !this.weapons.heldBy('left') || !this.weapons.heldBy('right');
          const w = free && !this.input.mode.bow ? this.weapons.pickRay(this.aimRay(this.input.mode.activeHand)) : null;
          if (w !== this.hoverW) { this.hoverW = w; if (w) audio.ui('move'); }
        }
        this.weapons.setHover(this.hoverW, this.realT);
      }
    } else if (this.mode === 'match' && this.input) {
      // webcam: the weapon a free hand targets (eye → hand cone, updateWebcamHands) glows and is named — close the
      // hand to take it. The right hand's target first; a tick only once a target has held 150 ms (no chatter)
      const w = this.target.right ?? this.target.left;
      if (w !== this.hoverW) {
        if (w && this.realT - this.hoverChangeT >= 0.15) audio.ui('move');
        this.hoverW = w;
        this.hoverChangeT = this.realT;
      }
      this.weapons.setHover(this.hoverW, this.realT);
    }
  }

  private updatePost(realDt: number) {
    const p = this.post;
    const lowHealth = this.mode === 'match' && this.health < 35 ? (35 - this.health) / 35 : 0;
    const drain = this.realT - this.drainT < 0.3 ? 0.3 : 0;
    const dodgeTint = this.micro.kind === 'dodge' && this.realT < this.micro.until ? 0.4 : 0;
    const satTarget = this.slow.active ? 0.22 : Math.max(0.15, 0.72 - lowHealth * 0.3 - drain - dodgeTint);
    p.sat = damp(p.sat, satTarget, 8, realDt);
    p.chroma = 0;
    p.letterbox = damp(p.letterbox, this.slow.active || this.realT < this.introUntil ? 1 : 0, 9, realDt);
    p.flash = Math.max(0, p.flash - realDt * 2.2);
    p.heal = Math.max(0, p.heal - realDt * 1.5);
    p.verdigris = Math.max(0, p.verdigris - realDt * 1.1);
  }

  private pushHud() {
    const boss = this.enemies.list.find((e) => e.kind === 'boss' && !e.dead);
    this.cb.hud({
      health: Math.round(this.health), score: this.scoring.score, combo: this.scoring.combo, kills: this.scoring.kills,
      wave: this.director.wave, enemiesLeft: this.director.remaining, blocking: this.blocking || this.weapons.shieldHeld(),
      bowDraw: this.weapons.drawing ? this.weapons.bowDraw : 0, slowmo: this.slow.active,
      boss: boss ? { name: 'ANTINOUS', hp: Math.max(0, boss.hp / boss.maxHp), shield: Math.max(0, boss.shieldHp / 150), posture: boss.posture / 100 } : null,
      tally: { total: this.director.def.spawns.length, killed: Math.min(this.waveKills, this.director.def.spawns.length) },
      posture: this.playerPosture,
      matchTimeMs: Math.round((this.realT - this.matchStartReal) * 1000),
    });
  }

  // ── combat resolution ──────────────────────────────────────────────────
  /** Decide what a wooer's blow does on arrival (research: deflect windows T−220…T+40 ms on mouse; perfect ≤150 ms). */
  private resolveIncoming(_e: Enemy, a: Attack): Outcome {
    const motion = this.input?.kind === 'motion';
    const R = motion ? 0.3 : 0.27;
    const win = motion ? 0.3 : 0.22;
    const perfectWin = motion ? 0.26 : 0.15;
    // a raised guard (RMB / aspis) is perfect only when it comes up in the last 0.12 s (keyboard) — the glint is
    // your cue at 0.6 s; raising early is a plain block
    const raiseWin = motion ? perfectWin + 0.05 : 0.12;
    const now = this.realT;
    const guardUp = this.blocking && now >= this.guardBrokenUntil;
    // 1) blade in the path of the blow
    if (!a.unblockable && now >= this.guardBrokenUntil) {
      // a perfect needs a FRESH guard raise: not mashing (≥ 0.6 s since the press before, RMB up ≥ 0.3 s before it)
      const freshGuard = this.guardAt - this.prevGuardAt >= 0.6 && this.guardAt - this.guardUpEndT >= 0.3;
      // deflects are EARNED: your driven blade must move against the blow (a blade that drifts or is parked in the
      // path doesn't deflect by luck). blowDir: left lane = +X (it sweeps rightward), right = −X, top = −Y, thrust = at you
      const yawM = new THREE.Matrix4().makeRotationY(this.yaw);
      const blowDir = a.dir === 'left' ? new THREE.Vector3(1, 0, 0).applyMatrix4(yawM) : a.dir === 'right' ? new THREE.Vector3(-1, 0, 0).applyMatrix4(yawM)
        : a.dir === 'top' ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3().subVectors(this.eye, a.lane).normalize();
      let enteredAt = -1, entries = 0, prevIn = false, opposing = 0, recentMove = 0, legacySpeed = 0;
      for (const h of this.bladeHist) {
        if (now - h.t > 0.4) continue;
        if (h.intent && h.intent !== 'driven' && h.intent !== 'guard') { prevIn = false; continue; }
        recentMove = Math.max(recentMove, h.speed);
        const inPath = distPointSeg(a.lane, h.a, h.b) < R;
        if (inPath && !prevIn) { entries++; if (now - h.t <= win) enteredAt = h.t; }
        if (inPath && now - h.t <= win) {
          if (enteredAt < 0) enteredAt = h.t;
          legacySpeed = h.speed;
          opposing = Math.max(opposing, h.vel ? -h.vel.dot(blowDir) : h.speed);
        }
        prevIn = inPath;
      }
      // (with RMB held the directional guard rule below decides alone — a blade idling in the lane doesn't widen it)
      if (enteredAt >= 0 && recentMove >= 1.0 && !this.blocking) {
        if (now - enteredAt <= perfectWin && entries <= 2 && opposing >= 2.0) return 'perfect';
        return opposing >= 3.0 || (legacySpeed > 3 && opposing >= 3.0) ? 'beat' : 'block';
      }
      // the aspis: raised (RMB) it takes anything; carried low it still covers your left flank
      if (this.weapons.shieldHeld()) {
        if (guardUp) return now - this.guardAt <= raiseWin && freshGuard ? 'perfect' : 'shield';
        if (a.dir === 'left') return 'shield';
      }
      // RMB guard is directional: it covers overheads and the side your blade is on (cursor x); a blow from the
      // other side, or a thrust, is only half-stopped ('guard': partial damage + posture) — meet those with the blade
      if (guardUp) {
        const cx = isKeyboardMouse(this.input) ? this.input.cursor.x : 0;
        // a centred cursor covers your sword-hand side only (not both)
        const side = cx >= 0.15 ? 'right' : cx <= -0.15 ? 'left' : (isKeyboardMouse(this.input) ? this.input.mode.activeHand : 'right');
        const covered = a.dir === 'top' || a.dir === side;
        if (!covered) return 'guard';
        return now - this.guardAt <= raiseWin && freshGuard ? 'perfect' : 'block';
      }
    }
    // 2) dodge: lean past ~0.3 m (or crouch under a horizontal cut)
    const st = this.lastState;
    const lean = st?.body.lean ?? 0;
    const crouch = st?.body.crouch ?? 0;
    const into = (a.dir === 'left' && lean < -0.5) || (a.dir === 'right' && lean > 0.5);
    const leaned = Math.abs(lean) > 0.5 && !into;
    const ducked = crouch > 0.5 && (a.dir === 'left' || a.dir === 'right');
    if (leaned || ducked) {
      const perfect = now - this.leanCrossT <= (motion ? 0.3 : 0.25) && now - this.lastPerfectDodge > 3;
      return perfect ? 'perfectDodge' : 'dodge';
    }
    return 'hit';
  }

  private onOutcome(e: Enemy, a: Attack, o: Outcome, at: THREE.Vector3) {
    switch (o) {
      case 'perfect':
        this.fx.contact(at, new THREE.Vector3().subVectors(this.eye, at), null, 9, 'parry');
        this.fx.gold(at, 14);
        audio.parryPerfect(audio.pan(at));
        this.hitstop(100);
        this.microSlow(0.3, 0.25, 'deflect');
        this.ripple(at, 'gold');
        this.kick(0.8);
        this.scoring.addPoints(100);
        this.tutorial('perfect', 'PERFECT DEFLECT', 'He staggers — strike now', 100);
        break;
      case 'beat':
        this.fx.contact(at, new THREE.Vector3().subVectors(this.eye, at), null, 7, 'beat');
        audio.clashEdge(0.8, audio.pan(at), 0.001, -2);
        this.hitstop(60); this.kick(0.5); this.ripple(at, 'brass');
        this.addPlayerPosture(5);
        this.tutorial('beat', 'DEFLECTED', 'Meet his blade just before it lands for a perfect deflect');
        break;
      case 'block':
      case 'shield':
        this.fx.contact(at, new THREE.Vector3().subVectors(this.eye, at), null, 5, o === 'shield' ? 'shield' : 'block');
        if (o === 'shield') audio.shieldWood(0.7, audio.pan(at)); else audio.blockFlat(0.7, audio.pan(at));
        this.hitstop(40); this.kick(0.4);
        this.addPlayerPosture(a.windup > 1 ? 35 : 20);
        this.recoil('right', new THREE.Vector3().subVectors(this.eye, at).normalize().negate(), 0.08, 150);
        break;
      case 'guard':
        this.addPlayerPosture(25);
        break;
      case 'perfectDodge':
        this.lastPerfectDodge = this.realT;
        this.microSlow(0.3, 0.6, 'dodge');
        this.counterUntil = this.realT + 1.2;
        this.post.verdigris = 1;
        audio.whoosh(4); audio.slowIn();
        this.scoring.addPoints(75);
        this.tutorial('pdodge', 'PERFECT DODGE', 'Counter now — his guard is open', 75);
        break;
      case 'dodge':
        audio.whoosh(5);
        this.scoring.addPoints(25);
        this.tutorial('dodge', 'DODGED', 'Lean the moment before it lands for slow-motion');
        break;
      case 'hit': break;
    }
    void e;
  }

  private addPlayerPosture(n: number) {
    this.playerPosture = Math.min(100, this.playerPosture + n);
    this.postureT = this.realT;
    if (this.playerPosture >= 100) {
      this.playerPosture = 40;
      this.guardBrokenUntil = this.realT + 1.2; // the next blow lands
      this.recoil('right', new THREE.Vector3(0.6, -0.4, 0.4), 0.4, 600);
      audio.blockFlat(1, 0);
      this.cb.toast({ kind: 'warn', title: 'GUARD BROKEN', sub: 'Your guard is down — dodge!' }, 1100);
    }
  }

  private recoil(hand: Hand, dir: THREE.Vector3, dist: number, dampMs: number) {
    this.recoilOff[hand].copy(dir).multiplyScalar(-dist);
    this.recoilOff[hand].y = Math.abs(this.recoilOff[hand].y) * 0.5;
    this.dampUntil[hand] = this.realT + dampMs / 1000;
    // and the blade itself rebounds (angular kick, then the spring settles it)
    if (isKeyboardMouse(this.input)) {
      const d = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
      this.input.kickBlade(hand, d, Math.min(1, dist / 0.2));
    }
  }

  private kick(deg: number) { this.kickVel += THREE.MathUtils.degToRad(deg) * 16; }
  private microSlow(scale: number, dur: number, kind: 'deflect' | 'dodge') { this.micro = { until: this.realT + dur, scale, kind }; }
  private ripple(pos: THREE.Vector3, color: 'brass' | 'gold' | 'verdigris') {
    this.ripples.push({ pos: pos.clone(), t: this.realT, color });
    if (this.ripples.length > 6) this.ripples.shift();
  }
  /** Outcome words appear the first time only (research: label once, then let feel carry it). */
  private tutorial(key: string, title: string, sub?: string, points?: number) {
    if (this.seenTips.has(key)) { if (points) this.cb.toast({ kind: 'info', title: `+${points}` }, 500); return; }
    this.seenTips.add(key);
    this.cb.toast({ kind: 'info', title, sub, points }, 1600);
  }

  /** Snapshot for the HUD overlay (telegraph arcs, glints, damage arcs, posture). */
  overlay() {
    return {
      telegraphs: this.enemies.telegraphs(),
      damageArcs: this.damageArcs,
      ripples: this.ripples,
      realT: this.realT,
      yaw: this.yaw,
      playerPosture: this.playerPosture,
      counter: this.realT < this.counterUntil,
      enemies: this.enemies.list,
      hover: this.hoverW && this.hoverW.state !== 'held' ? { name: this.hoverW.name, pos: this.hoverW.center, progress: this.hoverProgress() } : null,
      /** webcam: both hands (world), for the off-screen glove chevrons */
      hands: this.tracked ? (['left', 'right'] as const).map((side) => ({ side, pos: this.handViews[side].pos, live: this.handViews[side].visible })) : [],
    };
  }

  /** webcam: how close the targeting hand is to taking (grip toward Part C's 0.65, or the 0.12 s grip-level hold) */
  private hoverProgress(): number | undefined {
    if (!this.tracked || !this.lastState || !this.hoverW) return undefined;
    const side: Hand = this.target.right === this.hoverW ? 'right' : 'left';
    const hs = this.lastState.hands[side];
    if (!hs.visible) return 0;
    return clamp(Math.max(hs.grip / 0.65, this.gripT[side] / 0.12), 0, 1);
  }

  private updateTrails(dt: number) {
    for (const side of ['left', 'right'] as const) {
      const w = this.weapons.heldBy(side);
      if (!w || w.cls === 'bow' || w.cls === 'shield' || !w.spec.sharp && w.cls !== 'blunt') { this.trails.updatePlayer(side, null, null, 0, dt); audio.swing(side, 0, 0, 0); continue; }
      const t = w.body.translation();
      this.trails.updatePlayer(side, new THREE.Vector3(t.x, t.y, t.z), w.tip, w.speed, dt);
      // swing voice: speed of the point; the whistle needs the blade moving across its axis (edge/flat leading)
      const axis = _sv1.subVectors(w.tip, w.center).normalize();
      const mv = _sv2.subVectors(w.tip, w.prevTip);
      const edge = mv.lengthSq() > 1e-8 ? 1 - Math.abs(axis.dot(mv.normalize())) : 0;
      audio.swing(side, w.speed, edge, audio.pan(w.tip));
    }
    const list: { base: THREE.Vector3; tip: THREE.Vector3 }[] = [];
    for (const e of this.enemies.list) {
      if (e.state !== 'strike' && !(e.state === 'windup' && e.attack && e.attack.impactAt - this.enemies.t < 0.2)) continue;
      const base = new THREE.Vector3(), tip = new THREE.Vector3();
      this.enemies.renderer.swordSegment(e.pose, e.look, base, tip);
      list.push({ base, tip });
    }
    this.trails.updateEnemies(list, dt);
  }

  /** Camera FOV/aspect sync from the canvas. */
  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fx.setViewportHeight(h);
  }

  get healthValue() { return this.health; }
  forgedOnRack(): string[] { return this.weapons.list.filter((w) => w.forged).map((w) => w.forged!.weaponId); }
  get inputState() { return this.lastState; }
  get handPositions() { return this.handViews; }
  /** the hand the mouse drives (keyboard/mouse only; null in bow mode) */
  get drivenHand(): Hand | null { return isKeyboardMouse(this.input) && !this.input.mode.bow ? this.input.mode.activeHand : null; }
  get isBlocking() { return this.blocking; }
  get timeScaleValue() { return this.timeScale; }

  dispose() {
    this.disposed = true;
    this.setInput(null);
    this.enemies.clear();
    this.weapons.clearAll();
    this.scene.remove(this.hall.group, this.fx.group, this.enemies.renderer.group, this.weapons.group, this.hands.left.root, this.hands.right.root);
    this.hall.dispose();
    try { this.world.free(); } catch { /* */ }
  }
}

export { rand, clamp };

function distPointSeg(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz || 1)));
  const dx = a.x + abx * t - p.x, dy = a.y + aby * t - p.y, dz = a.z + abz * t - p.z;
  return Math.hypot(dx, dy, dz);
}
