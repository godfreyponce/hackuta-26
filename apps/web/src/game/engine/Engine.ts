import * as THREE from 'three';
import type { GameEvent, GameEventKind, Hand, InputController, InputEvent, PlayerInputState, TrickshotKind, WeaponSpawn } from '@ithaca/shared';
import { RAPIER, initPhysics } from './physics';
import { buildHall, HALL, type HallRig } from './hall';
import { Fx } from './fx';
import { EnemyManager, type Enemy, type HitInfo } from './enemies';
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

export interface PostState { sat: number; chroma: number; flash: number; letterbox: number; heal: number; exposure: number }

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
  post: PostState = { sat: 0.72, chroma: 0, flash: 0, letterbox: 0, heal: 0, exposure: 1 };

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
      onKill: (e, info) => this.onKill(e, info),
      onPlayerHit: (dmg, source, from) => this.hurt(dmg, source, from),
      onDodge: () => { this.scoring.addPoints(25); this.cb.toast({ kind: 'info', title: 'DODGED', points: 25 }, 900); },
      onBlock: (_s, pos) => { this.fx.sparks(pos, null, 12); audio.block(); this.addTrauma(0.15); },
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
      onHit: (w, r, info) => this.onWeaponHit(w, r.killed, r.blocked, r.shieldBroke, info, r.enemy),
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
        this.addTrauma(0.3);
        this.cb.toast({ kind: 'warn', title: 'ANTINOUS', sub: 'A table for a shield. Pin him — or burn it.' }, 3400);
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
      case 'block_start': this.blocking = true; this.weapons.blocking = true; break;
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
    audio.gong(82, 6, 0.42);
    audio.setIntensity(0.35 + w.n * 0.2);
    this.cb.hud({ wave: w.n, waveTitle: w.title, intermission: null });
    this.cb.toast({ kind: 'wave', title: `WAVE ${['I', 'II', 'III'][w.n - 1] ?? w.n} · ${w.title.toUpperCase()}`, sub: w.sub }, 3000);
    this.emit('wave_start', { wave: w.n, enemiesLeft: w.spawns.length });
  }

  private onWeaponHit(w: WeaponEnt | null, killed: boolean, blocked: boolean, shieldBroke: boolean, info: HitInfo, enemy: Enemy) {
    if (blocked) {
      if (shieldBroke) this.cb.toast({ kind: 'info', title: enemy.kind === 'boss' ? 'THE TABLE SPLINTERS!' : 'SHIELD BROKEN' }, 1400);
      return;
    }
    if (!killed) this.addTrauma(info.source === 'melee' ? 0.08 : 0.05);
    void w;
  }

  private onKill(e: Enemy, info: HitInfo) {
    const w = info.weaponEntId !== null ? this.weapons.list.find((x) => x.id === info.weaponEntId) ?? null : null;
    const now = this.simT;
    const multi = w ? w.throwKills.filter((t) => now - t < 1.5).length + (w.state === 'free' ? 1 : 0) : 0;
    const res = this.scoring.onKill({
      t: now, realT: this.realT, zone: info.zone, distance: Math.hypot(e.pose[P.Torso].c.x - this.eye.x, e.pose[P.Torso].c.z - this.eye.z),
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
    this.announceTricks(res.tricks, res.points, res.slowmo, w?.name);
    this.killEventCount++;
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

  private hurt(dmg: number, source: 'melee' | 'arrow', from: THREE.Vector3) {
    if (this.mode !== 'match') return;
    const k = this.difficulty === 'easy' ? 0.6 : 1;
    this.health = Math.max(0, this.health - dmg * k);
    if (this.difficulty === 'easy') this.health = Math.max(1, this.health);
    this.lastHurtT = this.realT;
    this.post.flash = Math.min(1, this.post.flash + (dmg > 5 ? 0.85 : 0.35));
    this.addTrauma(dmg > 5 ? 0.35 : 0.12);
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
        const prev = hv.pos.clone();
        hv.pos.lerp(tgt, 1 - Math.exp(-42 * realDt)); // ≈0.5/frame at 60 fps, hides jitter
        hv.vel.copy(hv.pos).sub(prev).multiplyScalar(1 / Math.max(1e-3, realDt));
        hv.forward.set(hs.forward.x, hs.forward.y, hs.forward.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).normalize();
        hv.up.set(hs.up.x, hs.up.y, hs.up.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).normalize();
        basisQuat(hv.forward, hv.up, hv.quat);
      } else hv.vel.set(0, 0, 0);
      hv.grip = hs.grip;
      g.update(hv.pos, hv.quat, hs.grip, hs.visible, !!this.weapons.heldBy(side), realDt);
    }
    this.hands.left.setHealth(this.health / 100);
    this.weapons.bowDraw = state?.bowDraw ?? 0;
  }

  private updateCamera(state: PlayerInputState | null, realDt: number) {
    const cam = this.camera;
    if (this.mode === 'menu') {
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
      const sh = this.trauma * this.trauma;
      const maxRot = THREE.MathUtils.degToRad(2);
      const t = this.realT;
      const pitch = -0.1 + Math.sin(t * 0.7 * Math.PI * 2) * sway * 0.6 + (Math.sin(t * 37) * 0.5 + Math.sin(t * 23) * 0.5) * maxRot * sh;
      const yaw = this.yaw + Math.sin(t * 0.43 * Math.PI * 2) * sway + Math.sin(t * 31 + 1) * maxRot * sh;
      const roll = Math.sin(t * 29 + 2) * maxRot * 0.5 * sh;
      cam.rotation.set(pitch, yaw, roll, 'YXZ');
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
    const satTarget = this.slow.active ? 0.22 : 0.72 - lowHealth * 0.3;
    p.sat = damp(p.sat, satTarget, 8, realDt);
    p.chroma = damp(p.chroma, this.slow.active && this.slow.t < 0.5 ? 1 : 0, 10, realDt);
    p.letterbox = damp(p.letterbox, this.slow.active ? 1 : 0, 9, realDt);
    p.flash = Math.max(0, p.flash - realDt * 2.2);
    p.heal = Math.max(0, p.heal - realDt * 1.5);
  }

  private pushHud() {
    const boss = this.enemies.list.find((e) => e.kind === 'boss' && !e.dead);
    this.cb.hud({
      health: Math.round(this.health), score: this.scoring.score, combo: this.scoring.combo, kills: this.scoring.kills,
      wave: this.director.wave, enemiesLeft: this.director.remaining, blocking: this.blocking || this.weapons.shieldHeld(),
      bowDraw: this.weapons.drawing ? this.weapons.bowDraw : 0, slowmo: this.slow.active,
      boss: boss ? { name: 'ANTINOUS', hp: Math.max(0, boss.hp / boss.maxHp), shield: Math.max(0, boss.shieldHp / 170) } : null,
      matchTimeMs: Math.round((this.realT - this.matchStartReal) * 1000),
    });
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
