import * as THREE from 'three';
import type { GameEvent, GameEventKind, Hand, InputController, InputEvent, PlayerInputState, TrickshotKind, WeaponSpawn } from '@ithaca/shared';
import { RAPIER, initPhysics } from './physics';
import { buildHall, HALL, type HallRig } from './hall';
import { Fx } from './fx';
import { EnemyManager, type Attack, type Enemy, type HitInfo, type HitResult, type Outcome } from './enemies';
import { WeaponManager, type HandView, type WeaponEnt } from './weapons';
import { Gauntlet } from './hands';
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

export class Engine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  world!: InstanceType<typeof RAPIER.World>;
  hall!: HallRig;
  fx = new Fx();
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
  private handTarget: Record<Hand, THREE.Vector3>;
  private lastState: PlayerInputState | null = null;
  private trackingLost = false;
  private disposed = false;
  private introUntil = 0;
  private guardAt = -9;
  private waveKills = 0;
  shakeScale = 1;
  // ── combat feel state ──
  private bladeHist: { t: number; side: Hand; a: THREE.Vector3; b: THREE.Vector3; speed: number }[] = [];
  private leanSign = 0;
  private leanCrossT = -9;
  private playerPosture = 0;
  private postureT = -9;
  private micro = { until: 0, scale: 1, kind: '' as '' | 'deflect' | 'dodge' };
  private lastPerfectDodge = -9;
  private counterUntil = 0;
  private kickPitch = 0;
  private kickVel = 0;
  private recoilOff: Record<Hand, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  private dampUntil: Record<Hand, number> = { left: 0, right: 0 };
  private lastFlashT = -9;
  private drainT = -9;
  private lastDecapSlow = -99;
  private seenDecap = false;
  private seenTips = new Set<string>();
  /** HUD overlay feed (read every frame by CombatOverlay) */
  damageArcs: { angle: number; t: number; heavy: boolean }[] = [];
  ripples: { pos: THREE.Vector3; t: number; color: 'brass' | 'gold' | 'verdigris' }[] = [];

  private constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, cb: EngineCallbacks) {
    this.scene = scene;
    this.camera = camera;
    this.cb = cb;
    const mkView = (side: Hand): HandView => ({
      side, pos: new THREE.Vector3(side === 'left' ? -0.26 : 0.24, 1.3, -0.45), quat: new THREE.Quaternion(),
      forward: new THREE.Vector3(0, 0.6, -0.8), up: new THREE.Vector3(side === 'left' ? -1 : 1, 0, 0), vel: new THREE.Vector3(), grip: 0, visible: true,
    });
    this.handViews = { left: mkView('left'), right: mkView('right') };
    this.handTarget = { left: this.handViews.left.pos.clone(), right: this.handViews.right.pos.clone() };
  }

  static async create(scene: THREE.Scene, camera: THREE.PerspectiveCamera, cb: EngineCallbacks): Promise<Engine> {
    await initPhysics();
    const e = new Engine(scene, camera, cb);
    e.build();
    return e;
  }

  private build() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED;
    this.hall = buildHall(this.world);
    this.scene.add(this.hall.group);
    this.scene.add(this.fx.group);
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
      onArrowBlocked: (pos) => { this.fx.sparks(pos, null, 12); audio.block(); this.addTrauma(0.15); },
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
    });
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
        this.fx.sparks(pos, null, 16, '#fff4d0');
        audio.parry();
        this.hitstop(60);
        this.scoring.addPoints(50);
        this.cb.toast({ kind: 'info', title: 'PARRY', points: 50 }, 900);
      },
      hitstop: (ms) => this.hitstop(ms),
      shake: (v) => this.addTrauma(v),
      playerPos: () => this.eye,
      kbPull: () => isKeyboardMouse(this.input),
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
        this.cb.toast({ kind: 'wave', title: 'WAVE CLEARED', sub: 'Breathe.' }, 2600);
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
        const h = this.handViews[e.hand];
        const dir = h.pos.clone().sub(this.eye).normalize();
        this.weapons.grab(h, { origin: this.eye.clone(), dir });
        break;
      }
      case 'release': {
        const v = this.bodyToWorldDir(new THREE.Vector3(e.vel.x, e.vel.y, e.vel.z));
        this.weapons.release(e.hand, v, this.handViews[e.hand]);
        break;
      }
      case 'swing': audio.whoosh(e.speed); break;
      case 'block_start': this.blocking = true; this.weapons.blocking = true; this.guardAt = this.realT; break;
      case 'block_end': this.blocking = false; this.weapons.blocking = false; break;
      case 'bow_nock':
        if (this.weapons.ensureBow(this.handViews.left)) this.weapons.nock();
        break;
      case 'bow_release': {
        const aim = this.bodyToWorldDir(new THREE.Vector3(e.aim.x, e.aim.y, e.aim.z));
        this.weapons.loose(e.draw, aim);
        break;
      }
      case 'drink':
        if (!this.weapons.drink(e.hand)) this.cb.toast({ kind: 'info', title: 'NOTHING TO DRINK', sub: 'Ask Telemachus for a bottle' }, 1200);
        break;
      case 'call_sign': this.cb.requestCall(); break;
      case 'request_weapon': this.cb.requestWeapon(); break;
      case 'tracking_lost': this.trackingLost = true; this.cb.tracking('lost'); break;
      case 'tracking_ok': this.trackingLost = false; this.cb.tracking('ok'); break;
    }
  }

  private yaw = 0;
  private bodyToWorldDir(v: THREE.Vector3) { return v.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw); }

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

  setPaused(p: boolean) { this.paused = p; }

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
    else if (alive && (part === P.UArmL || part === P.LArmL)) this.cb.toast({ kind: 'info', title: 'SHIELD ARM SEVERED', points: 100 }, 1000);
    if (alive) this.scoring.addPoints(part === P.UArmR || part === P.LArmR ? 150 : 100);
  }

  private onKill(e: Enemy, info: HitInfo, how: { decapitated: boolean; finisher: boolean; severed: number | null } = { decapitated: false, finisher: false, severed: null }) {
    const w = info.weaponEntId !== null ? this.weapons.list.find((x) => x.id === info.weaponEntId) ?? null : null;
    const now = this.simT;
    const multi = w ? w.throwKills.filter((t) => now - t < 1.5).length + (w.state === 'free' ? 1 : 0) : 0;
    const res = this.scoring.onKill({
      t: now, realT: this.realT, zone: how.decapitated ? 'head' : info.zone, distance: Math.hypot(e.pose[P.Torso].c.x - this.eye.x, e.pose[P.Torso].c.z - this.eye.z),
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
  hitstop(ms: number) { if (!this.slow.active) this.hitstopT = Math.max(this.hitstopT, ms / 1000); }
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
    const state = this.input?.getState() ?? null;
    this.lastState = state;
    if (state && this.input && 'getPendingGesture' in this.input) {
      const g = (this.input as { getPendingGesture?: () => { name: string; progress: number } | null }).getPendingGesture?.() ?? null;
      this.cb.pendingGesture(g);
    }

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
    let steps = 0;
    while (this.acc >= FIXED && steps < 3) {
      this.acc -= FIXED;
      steps++;
      const dt = FIXED * scale;
      if (dt <= 0) continue;
      this.simStep(dt, FIXED);
    }
    if (steps === 3) this.acc = 0;

    const ambientDt = realDt * (this.paused ? 0 : Math.max(0.25, scale));
    this.fx.update(realDt * (this.paused ? 0 : Math.max(0.15, scale)), ambientDt);
    this.hall.update(this.realT, realDt);
    this.enemies.render();
    this.updateCamera(state, realDt);
    this.updatePost(realDt);

    this.hudTimer += realDt;
    if (this.hudTimer > 0.1 && this.mode === 'match') { this.hudTimer = 0; this.pushHud(); }
  }

  private simStep(dt: number, realDt: number) {
    this.simT += dt;
    this.world.timestep = dt;
    if (this.mode === 'match') this.director.update(dt);
    this.enemies.update(dt);
    this.weapons.prestep(this.handViews, realDt);
    this.world.step(this.weapons.queue);
    this.weapons.poststep(dt, realDt, this.handViews);
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
    this.yaw = damp(this.yaw, -(state?.body.yaw ?? 0) * 0.25, 6, realDt);
    this.eye.set(lean * 0.6, HALL.eye.y - crouch * 0.5, 0);
    const sign = Math.abs(lean) > 0.5 ? Math.sign(lean) : 0;
    if (sign !== 0 && sign !== this.leanSign) this.leanCrossT = this.realT;
    this.leanSign = sign;
    if (this.realT - this.postureT > 1) this.playerPosture = Math.max(0, this.playerPosture - realDt * 15);
    const playing = this.mode === 'match' || this.mode === 'ended';
    for (const side of ['left', 'right'] as const) {
      const hv = this.handViews[side];
      const hs = state?.hands[side];
      const g = this.hands[side];
      if (!hs || !playing) { g.root.visible = false; continue; }
      g.root.visible = true;
      hv.visible = hs.visible;
      if (hs.visible) {
        const tgt = this.handTarget[side].set(hs.pos.x, hs.pos.y, hs.pos.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).add(this.eye);
        tgt.add(this.recoilOff[side]);
        this.recoilOff[side].multiplyScalar(Math.exp(-realDt / 0.15));
        const prev = hv.pos.clone();
        const rate = this.realT < this.dampUntil[side] ? 10 : 42; // parried → input damped
        hv.pos.lerp(tgt, 1 - Math.exp(-rate * realDt)); // ≈0.5/frame at 60 fps, hides jitter
        hv.vel.copy(hv.pos).sub(prev).multiplyScalar(1 / Math.max(1e-3, realDt));
        hv.forward.set(hs.forward.x, hs.forward.y, hs.forward.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).normalize();
        hv.up.set(hs.up.x, hs.up.y, hs.up.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).normalize();
        basisQuat(hv.forward, hv.up, hv.quat);
      } else hv.vel.set(0, 0, 0);
      hv.grip = hs.grip;
      g.update(hv.pos, hv.quat, hs.grip, hs.visible, !!this.weapons.heldBy(side), realDt);
    }
    this.hands.left.setHealth(this.health / 100);
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
      this.bladeHist.push({ t: this.realT, side, a, b, speed: w.speed });
    }
    while (this.bladeHist.length && this.realT - this.bladeHist[0].t > 0.5) this.bladeHist.shift();
    this.weapons.bowDraw = state?.bowDraw ?? 0;
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
      const fovTarget = drawing ? 42 : this.slow.active ? 48 : 55;
      this.fov = damp(this.fov, fovTarget, 6, realDt);
      // handheld sway ~0.3° @ 0.7 Hz + trauma² shake (≤ 2°)
      const sway = THREE.MathUtils.degToRad(0.3);
      const sh = this.trauma * this.trauma * this.shakeScale;
      const maxRot = THREE.MathUtils.degToRad(2);
      const t = this.realT;
      const pitch = -0.1 + Math.sin(t * 0.7 * Math.PI * 2) * sway * 0.6 + (Math.sin(t * 37) * 0.5 + Math.sin(t * 23) * 0.5) * maxRot * sh;
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
    if (isKeyboardMouse(this.input)) this.input.setCamera({ fovY: THREE.MathUtils.degToRad(cam.fov), aspect: cam.aspect, pitch: -0.1 });
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
    const now = this.realT;
    // 1) blade in the path of the blow
    if (!a.unblockable) {
      let enteredAt = -1, entries = 0, prevIn = false, lastSpeed = 0;
      for (const h of this.bladeHist) {
        if (now - h.t > 0.4) continue;
        const inPath = distPointSeg(a.lane, h.a, h.b) < R;
        if (inPath && !prevIn) { entries++; if (now - h.t <= win) enteredAt = h.t; }
        if (inPath && now - h.t <= win) { if (enteredAt < 0) enteredAt = h.t; lastSpeed = h.speed; }
        prevIn = inPath;
      }
      if (enteredAt >= 0) {
        if (this.blocking && now - this.guardAt <= perfectWin + 0.05) return 'perfect'; // guard raised just in time
        if (now - enteredAt <= perfectWin && entries <= 2) return 'perfect';
        return lastSpeed > 3 ? 'beat' : 'block';
      }
      if (this.weapons.shieldHeld()) return 'shield';
      // explicit guard (RMB / guard pose): timed = perfect parry, held = clean block
      if (this.blocking) return now - this.guardAt <= perfectWin + 0.05 ? 'perfect' : 'block';
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
        this.fx.sparks(at, null, 34, '#fff1c4');
        this.fx.gold(at, 14);
        audio.metal(1.2, 2600); audio.lyre([12], 0, 880);
        this.hitstop(100);
        this.microSlow(0.3, 0.25, 'deflect');
        this.ripple(at, 'gold');
        this.kick(0.8);
        this.scoring.addPoints(100);
        this.tutorial('perfect', 'PERFECT DEFLECT', 'He staggers — strike now', 100);
        break;
      case 'beat':
        this.fx.sparks(at, null, 14, '#ffd28a');
        audio.metal(0.9, 2000);
        this.hitstop(60); this.kick(0.5); this.ripple(at, 'brass');
        this.addPlayerPosture(5);
        this.tutorial('beat', 'DEFLECTED', 'Meet his blade just before it lands for a perfect deflect');
        break;
      case 'block':
      case 'shield':
        this.fx.sparks(at, null, 4, '#d8b070');
        audio.block();
        this.hitstop(40); this.kick(0.4);
        this.addPlayerPosture(a.windup > 1 ? 35 : 20);
        this.recoil('right', new THREE.Vector3().subVectors(this.eye, at).normalize().negate(), 0.08, 150);
        break;
      case 'guard':
        this.addPlayerPosture(20);
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
      this.recoil('right', new THREE.Vector3(0.6, -0.4, 0.4), 0.4, 600);
      audio.metal(1, 700);
      this.cb.toast({ kind: 'warn', title: 'GUARD BROKEN' }, 1000);
    }
  }

  private recoil(hand: Hand, dir: THREE.Vector3, dist: number, dampMs: number) {
    this.recoilOff[hand].copy(dir).multiplyScalar(-dist);
    this.recoilOff[hand].y = Math.abs(this.recoilOff[hand].y) * 0.5;
    this.dampUntil[hand] = this.realT + dampMs / 1000;
    audio.metal(0.6, 1100);
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
    };
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
