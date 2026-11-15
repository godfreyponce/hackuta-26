import * as THREE from 'three';
import type { Hand, HandState, InputController, InputEvent, PlayerInputState } from '@ithaca/shared';
import { clamp, damp } from '../game/engine/math';

/**
 * Keyboard + mouse InputController (Part A's mock of Part C's motion controller).
 *
 * Coordinates are the player's body frame: origin at the eyes, +X right, +Y up, −Z forward (unpitched).
 * The cursor is unprojected through the real game camera (fov/pitch via setCamera), so the gauntlet
 * sits exactly under the cursor.
 *
 *   Mouse          move the hand (wheel = reach)          LMB hold   grip / grab · release = drop/throw (flick!)
 *   F              quick-throw toward cursor              RMB hold   block (raise guard)
 *   B              bow mode (LMB or Space: draw/loose)    Shift      mouse drives the LEFT hand
 *   E drink · C call Telemachus · Q ask for a weapon · A/D lean (dodge) · S crouch
 */
export interface KbCameraModel { fovY: number; aspect: number; pitch: number }
export type KbMode = { bow: boolean; activeHand: Hand };

export interface KeyboardMouseController extends InputController {
  setCamera(m: KbCameraModel): void;
  setTarget(el: HTMLElement | null): void;
  onMode(cb: (m: KbMode) => void): () => void;
  readonly mode: KbMode;
  /** Normalized device coords of the cursor (for the reticle). */
  readonly cursor: { x: number; y: number };
  /** Tab held: glance down at the weapon table. */
  readonly glancing: boolean;
  /** The engine reports which hands actually hold a melee weapon (drives the visible-blade "lever" pose). */
  setArmed(hand: Hand, armed: boolean, bladeM?: number, holding?: boolean): void;
}

// resting hands sit low, out of the way of the view (and of the weapon table when you glance down)
const REST_LEFT = new THREE.Vector3(-0.3, -0.5, -0.34);
const REST_RIGHT = new THREE.Vector3(0.28, -0.48, -0.36);
const SHOULDER = { left: new THREE.Vector3(-0.2, -0.28, 0.02), right: new THREE.Vector3(0.2, -0.28, 0.02) };
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function makeHand(p: THREE.Vector3): HandState {
  return {
    visible: true, confidence: 1,
    pos: { x: p.x, y: p.y, z: p.z }, vel: { x: 0, y: 0, z: 0 }, grip: 0,
    forward: { x: 0, y: 0.6, z: -0.8 }, up: { x: 1, y: 0, z: 0 },
  };
}

interface Sample { t: number; x: number; y: number; z: number }

class HandTrack {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  vel = new THREE.Vector3();
  hist: Sample[] = [];
  grip = 0;
  gripping = false;
  swingArmed = true;
  /** where this hand's blade point is (lags the cursor on a spring → weight) and its velocity */
  tip = new THREE.Vector3();
  tipVel = new THREE.Vector3();
  armed = false;
  /** grip → point distance of the held weapon (m) */
  blade = 0.65;
  /** holding anything (blade, shield, bow) — grips are sticky */
  holding = false;
  shield = false;
  /** blade direction + angular velocity (damped angular spring → visible drag, then whip) */
  bdir = new THREE.Vector3(0.1, 0.25, -1).normalize();
  omega = new THREE.Vector3();
  wasArmed = false;
  constructor(p: THREE.Vector3) { this.pos = p.clone(); this.target = p.clone(); this.tip.copy(p).multiplyScalar(2); }
  record(t: number) {
    this.hist.push({ t, x: this.pos.x, y: this.pos.y, z: this.pos.z });
    while (this.hist.length > 2 && t - this.hist[0].t > 200) this.hist.shift();
  }
  /** Velocity averaged over the last `windowMs` (spec C.4: 80 ms before release). */
  velOver(windowMs: number, out: THREE.Vector3) {
    const h = this.hist;
    if (h.length < 2) return out.set(0, 0, 0);
    const last = h[h.length - 1];
    let first = h[0];
    for (let i = h.length - 1; i >= 0; i--) { first = h[i]; if (last.t - h[i].t >= windowMs) break; }
    const dt = (last.t - first.t) / 1000;
    if (dt < 1e-3) return out.set(0, 0, 0);
    return out.set((last.x - first.x) / dt, (last.y - first.y) / dt, (last.z - first.z) / dt);
  }
}

const _ax = new THREE.Vector3();
const _ax2 = new THREE.Vector3();
/** Angular spring on a unit direction: ω += (wn²·e − 2ζwn·ω)·h, |ω| ≤ wmax, sub-stepped at ≤ 1/120 s. */
function springBlade(tr: { bdir: THREE.Vector3; omega: THREE.Vector3 }, want: THREE.Vector3, dt: number, wn: number, zeta: number, wmax: number) {
  let t = Math.min(dt, 0.1);
  while (t > 1e-5) {
    const h = Math.min(t, 1 / 120);
    t -= h;
    const axis = _ax.crossVectors(tr.bdir, want);
    const s = axis.length();
    const ang = Math.atan2(s, tr.bdir.dot(want));
    if (s > 1e-6) axis.multiplyScalar(ang / s); else axis.set(0, 0, 0);
    tr.omega.addScaledVector(axis, wn * wn * h).addScaledVector(tr.omega, -2 * zeta * wn * h);
    const om = tr.omega.length();
    if (om > wmax) tr.omega.multiplyScalar(wmax / om);
    const a = Math.min(wmax, tr.omega.length()) * h;
    if (a > 1e-7) tr.bdir.applyAxisAngle(_ax2.copy(tr.omega).normalize(), a).normalize();
  }
}

/** Unity-style SmoothDamp on a vector (critically damped, stable at any dt). */
function smoothDamp(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number) {
  if (dt <= 0) return;
  const omega = 2 / smoothTime, x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cx = cur.x - target.x, cy = cur.y - target.y, cz = cur.z - target.z;
  const tx = (vel.x + omega * cx) * dt, ty = (vel.y + omega * cy) * dt, tz = (vel.z + omega * cz) * dt;
  vel.set((vel.x - omega * tx) * e, (vel.y - omega * ty) * e, (vel.z - omega * tz) * e);
  cur.set(target.x + (cx + tx) * e, target.y + (cy + ty) * e, target.z + (cz + tz) * e);
}

export function createKeyboardMouseController(): KeyboardMouseController {
  const listeners = new Set<(e: InputEvent) => void>();
  const modeListeners = new Set<(m: KbMode) => void>();
  const emit = (e: InputEvent) => listeners.forEach((cb) => { try { cb(e); } catch (err) { console.warn('[kb] listener', err); } });

  let cam: KbCameraModel = { fovY: (55 * Math.PI) / 180, aspect: 16 / 9, pitch: -0.1 };
  let target: HTMLElement | null = null;
  let running = false;

  const cursor = { x: 0.25, y: -0.35 };
  let reach = 0.7;
  let lunge = 0;
  let thrust = 0;
  const mode: KbMode = { bow: false, activeHand: 'right' };
  const keys = new Set<string>();
  let lmb = false;
  let rmb = false;
  let drawing = false;
  let draw = 0;
  let lean = 0;
  let crouch = 0;
  let lastT = performance.now();

  const hands: Record<Hand, HandTrack> = { left: new HandTrack(REST_LEFT), right: new HandTrack(REST_RIGHT) };
  const cursorHist: Sample[] = [];

  const state: PlayerInputState = {
    t: performance.now(), tracking: 'ok',
    hands: { left: makeHand(REST_LEFT), right: makeHand(REST_RIGHT) },
    body: { lean: 0, crouch: 0, yaw: 0 }, bowDraw: 0,
  };

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const tmp3 = new THREE.Vector3();
  const tmp4 = new THREE.Vector3();
  const aimDir = new THREE.Vector3();

  function rayDir(out: THREE.Vector3) {
    const t = Math.tan(cam.fovY / 2);
    out.set(cursor.x * t * cam.aspect, cursor.y * t, -1).normalize();
    // pitch the camera-space ray into the unpitched body frame
    const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
    const y = out.y * c - out.z * s;
    const z = out.y * s + out.z * c;
    out.y = y; out.z = z;
    return out.normalize();
  }

  /** Body-frame point on the camera ray through NDC (x, y) at view depth `depth`. */
  function ndcPoint(x: number, y: number, depth: number, out: THREE.Vector3) {
    const t = Math.tan(cam.fovY / 2);
    out.set(x * t * cam.aspect * depth, y * t * depth, -depth);
    const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
    const yy = out.y * c - out.z * s, zz = out.y * s + out.z * c;
    out.y = yy; out.z = zz;
    return out;
  }

  function notifyMode() { modeListeners.forEach((cb) => cb({ ...mode })); }

  function setBow(on: boolean) {
    if (mode.bow === on) return;
    mode.bow = on;
    if (!on && drawing) { drawing = false; draw = 0; }
    notifyMode();
  }

  function startDraw() {
    if (drawing) return;
    drawing = true; draw = 0;
    emit({ type: 'bow_nock' });
  }
  function loose() {
    if (!drawing) return;
    drawing = false;
    const d = draw;
    draw = 0;
    rayDir(aimDir);
    if (d > 0.12) emit({ type: 'bow_release', draw: d, aim: { x: aimDir.x, y: aimDir.y, z: aimDir.z } });
  }

  // ── DOM handlers ─────────────────────────────────────────────
  const isTyping = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  function onKeyDown(e: KeyboardEvent) {
    if (!running || isTyping()) return;
    const k = e.code;
    if (keys.has(k)) return;
    keys.add(k);
    switch (k) {
      case 'KeyB': setBow(!mode.bow); break;
      case 'Tab': e.preventDefault(); break; // glance at the weapon table (held)
      case 'Space':
        if (mode.bow) { e.preventDefault(); startDraw(); }
        break;
      case 'KeyE': emit({ type: 'drink', hand: hands.left.gripping && !hands.right.gripping ? 'left' : 'right' }); break;
      case 'KeyC': emit({ type: 'call_sign' }); break;
      case 'KeyQ': emit({ type: 'request_weapon' }); break;
      case 'KeyF': {
        // quick throw: the active hand's weapon, else the other hand's
        const h = hands[mode.activeHand].holding ? mode.activeHand : (mode.activeHand === 'right' ? 'left' : 'right');
        if (hands[h].holding && !(mode.bow && h === 'left')) {
          rayDir(aimDir);
          emit({ type: 'release', hand: h, vel: { x: aimDir.x * 7, y: aimDir.y * 7 + 0.6, z: aimDir.z * 7 } });
        }
        break;
      }
      case 'KeyX': {
        // set the weapon down (active hand first)
        const h = hands[mode.activeHand].holding ? mode.activeHand : (mode.activeHand === 'right' ? 'left' : 'right');
        if (hands[h].holding) emit({ type: 'release', hand: h, vel: { x: 0, y: 0, z: 0 } });
        break;
      }
      case 'ShiftLeft': case 'ShiftRight':
        if (!mode.bow) { mode.activeHand = 'left'; notifyMode(); }
        break;
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    const k = e.code;
    keys.delete(k);
    if (!running) return;
    if (k === 'Space' && mode.bow) loose();
    if ((k === 'ShiftLeft' || k === 'ShiftRight') && mode.activeHand === 'left') {
      if (hands.left.gripping && !lmb) { /* keep left grip latched */ }
      mode.activeHand = 'right'; notifyMode();
    }
  }
  function onPointerMove(e: PointerEvent) {
    if (!target) return;
    const r = target.getBoundingClientRect();
    cursor.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    cursor.y = clamp(-(((e.clientY - r.top) / r.height) * 2 - 1), -1, 1);
    rayDir(aimDir);
    const now = performance.now();
    cursorHist.push({ t: now, x: aimDir.x * reach, y: aimDir.y * reach, z: aimDir.z * reach });
    while (cursorHist.length > 2 && now - cursorHist[0].t > 250) cursorHist.shift();
    // a second button pressed while one is held is "chorded": browsers report it only as a pointermove
    // with e.button set (no pointerdown/up) — e.g. RMB guard while LMB holds the sword
    if (running && e.button === 2) setRight((e.buttons & 2) !== 0);
    else if (running && e.button === 0) setLeft((e.buttons & 1) !== 0);
  }
  function setLeft(down: boolean) {
    if (down === lmb) return;
    lmb = down;
    if (mode.bow) { if (down) startDraw(); else loose(); return; }
    const h = mode.activeHand, tr = hands[h];
    if (down) {
      // click: an empty hand takes what you point at; if it's already armed, your FREE hand takes it
      // (second sword → dual wield, aspis → sword & shield)
      tr.gripping = true;
      emit({ type: 'grab', hand: h });
      return;
    }
    tr.gripping = false;
    // grips are sticky — the weapon stays in your hand; releasing during a fast flick THROWS it
    if (!tr.holding) return;
    const flick = cursorVel(90, tmp);
    const speed = flick.length();
    if (speed < 2.2) return;
    rayDir(aimDir);
    const vel = tmp2.copy(aimDir).multiplyScalar(2.4 + Math.min(speed, 8) * 1.5).addScaledVector(flick, 0.35);
    emit({ type: 'release', hand: h, vel: { x: vel.x, y: vel.y, z: vel.z } });
  }
  function setRight(down: boolean) {
    if (down === rmb) return;
    rmb = down;
    emit({ type: down ? 'block_start' : 'block_end' });
  }
  function cursorVel(windowMs: number, out: THREE.Vector3) {
    const now = performance.now();
    const recent = cursorHist.filter((s) => now - s.t <= Math.max(windowMs, 1));
    if (windowMs <= 0 || recent.length < 2) return hands[mode.activeHand].velOver(80, out);
    const a = recent[0], b = recent[recent.length - 1];
    const dt = Math.max(0.016, (b.t - a.t) / 1000);
    return out.set((b.x - a.x) / dt, (b.y - a.y) / dt, (b.z - a.z) / dt);
  }
  function onPointerDown(e: PointerEvent) {
    if (!running) return;
    onPointerMove(e);
    if (e.button === 0) setLeft(true);
    else if (e.button === 2) setRight(true);
  }
  function onPointerUp(e: PointerEvent) {
    if (!running) return;
    if (e.button === 0) setLeft(false);
    else if (e.button === 2) setRight(false);
  }
  function onWheel(e: WheelEvent) {
    if (!running) return;
    reach = clamp(reach - e.deltaY * 0.0006, 0.42, 0.95);
  }
  const onContext = (e: Event) => e.preventDefault();
  const onBlur = () => {
    keys.clear();
    lmb = false; hands.left.gripping = false; hands.right.gripping = false; // grips are sticky: nothing drops
    if (rmb) { rmb = false; emit({ type: 'block_end' }); }
    if (drawing) loose();
  };

  function attach(el: HTMLElement | null) {
    if (target) {
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContext);
    }
    target = el;
    if (target && running) {
      target.addEventListener('pointerdown', onPointerDown);
      target.addEventListener('wheel', onWheel, { passive: true });
      target.addEventListener('contextmenu', onContext);
    }
  }

  // ── per-frame state ──────────────────────────────────────────
  function writeHand(h: Hand, tr: HandTrack) {
    const s = state.hands[h];
    s.pos.x = tr.pos.x; s.pos.y = tr.pos.y; s.pos.z = tr.pos.z;
    tr.velOver(60, tr.vel);
    s.vel.x = tr.vel.x; s.vel.y = tr.vel.y; s.vel.z = tr.vel.z;
    s.grip = tr.grip;
    // Blade direction (Half Sword–style mouse fencing): the point follows your aim so the tip
    // reaches the wooers (~1.35 m); it trails fast motion so a swipe reads as a slash; in guard
    // (RMB) it turns crosswise in front of the face to catch blows.
    const f = tmp;
    if (mode.bow && h === 'left') f.copy(rayDir(aimDir));
    else if (tr.shield) f.set(h === 'right' ? -0.12 : 0.12, rmb ? 0.12 : 0.02, -1).normalize(); // aspis face → the enemy
    else if (rmb && !hands.left.shield && !hands.right.shield) f.set(h === 'right' ? -0.92 : 0.92, 0.24, -0.32).normalize();
    else if (tr.armed && h === mode.activeHand) f.copy(tr.bdir);
    else if (tr.armed) f.set(h === 'right' ? -0.3 : 0.3, 0.8, -0.5).normalize(); // off-hand blade raised to parry
    else if (h === mode.activeHand && !mode.bow) f.subVectors(tr.tip, tr.pos).normalize(); // empty hand reaching
    else {
      rayDir(aimDir);
      const sh = tmp2.copy(tr.pos).sub(SHOULDER[h]).normalize();
      f.copy(aimDir).multiplyScalar(0.78).addScaledVector(sh, 0.22).addScaledVector(WORLD_UP, 0.16);
      const lag = Math.min(1, tr.vel.length() / 6);
      if (lag > 0.05) f.addScaledVector(tr.vel.clone().normalize(), -0.55 * lag);
      f.normalize();
    }
    s.forward.x = f.x; s.forward.y = f.y; s.forward.z = f.z;
    const u = h === 'right' ? tmp2.crossVectors(f, WORLD_UP) : tmp2.crossVectors(WORLD_UP, f);
    if (u.lengthSq() < 1e-4) u.set(h === 'right' ? 1 : -1, 0, 0);
    u.normalize();
    s.up.x = u.x; s.up.y = u.y; s.up.z = u.z;
  }

  function getState(): PlayerInputState {
    const now = performance.now();
    const dt = clamp((now - lastT) / 1000, 0, 0.1);
    lastT = now;
    state.t = now;

    lean = damp(lean, (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), 10, dt);
    crouch = damp(crouch, keys.has('KeyS') ? 1 : 0, 10, dt);
    state.body.lean = lean;
    state.body.crouch = crouch;

    if (drawing) draw = Math.min(1, draw + dt / 0.85);
    state.bowDraw = drawing ? 1 - (1 - draw) * (1 - draw) : 0;

    rayDir(aimDir);
    const L = hands.left, R = hands.right;
    if (mode.bow) {
      // bow arm extended, held left of the sightline and canted; draw hand travels to a chin anchor
      L.target.copy(aimDir).multiplyScalar(0.64).add(tmp.set(-0.21, -0.13, 0));
      const rest = tmp2.copy(L.target).addScaledVector(aimDir, -0.09).add(tmp.set(0.03, 0.02, 0));
      R.target.copy(rest).lerp(tmp.set(0.05, -0.13, -0.14), state.bowDraw);
      L.grip = 1; R.grip = drawing ? 1 : 0.4;
    } else if (rmb && !L.shield && !R.shield) {
      // guard: sword raised crosswise in front of the face, through all three attack lanes
      L.target.set(-0.16, -0.04, -0.46);
      R.target.set(0.2, 0.0, -0.52);
    } else {
      const active = hands[mode.activeHand];
      const off = mode.activeHand === 'right' ? L : R;
      // auto-lunge: a fast swing with a weapon extends the arm (mouse can't push forward)
      lunge = damp(lunge, active.armed && active.tipVel.length() > 3.2 ? 0.22 : 0, 10, dt);
      if (active.armed) {
        // LEVER: the cursor marks where the blade's POINT goes; the hand rides between shoulder and point,
        // so the whole blade is on screen as a diagonal from the lower corner to the reticle and sweeps
        // visibly as you move the mouse (instead of pointing straight down the line of sight)
        // W = thrust: drive the point straight out along the line of the blade
        thrust = damp(thrust, keys.has('KeyW') ? 0.34 : 0, keys.has('KeyW') ? 22 : 9, dt);
        const goal = tmp.copy(aimDir).multiplyScalar(reach + 0.45 + lunge + thrust);
        // hand: from a low rest anchor it moves 45% as far as the aim point does (the blade covers the rest),
        // so it stays in its corner instead of crossing the view; clamped to the arm's reach from the shoulder
        const side = mode.activeHand === 'right' ? 1 : -1;
        const hRest = ndcPoint(side * 0.4, -0.6, 0.5, tmp2);
        const tRest = ndcPoint(side * 0.1, 0.04, reach + 0.45, tmp3);
        active.target.copy(hRest).addScaledVector(tmp4.copy(goal).sub(tRest), 0.45);
        const sh = SHOULDER[mode.activeHand];
        const off = tmp2.copy(active.target).sub(sh);
        const ol = off.length();
        if (ol > 0.66 || ol < 0.3) active.target.copy(sh).addScaledVector(off, clamp(ol, 0.3, 0.66) / Math.max(1e-3, ol));
        // the blade swings toward the aim point on a damped angular spring: a flick drags it behind the hand,
        // then it whips through and settles — heavier/longer weapons are slower (Mordhau-style turn cap)
        const want = tmp3.copy(goal).sub(active.pos).normalize();
        if (!active.wasArmed) { active.bdir.copy(want); active.omega.set(0, 0, 0); }
        const wn = clamp(16 * Math.sqrt(0.65 / Math.max(0.3, active.blade)), 7, 19);
        springBlade(active, want, dt, wn, 0.55, wn > 12 ? 12 : 8);
        const prev = tmp4.copy(active.tip);
        active.tip.copy(active.pos).addScaledVector(active.bdir, active.blade);
        if (dt > 1e-4 && active.wasArmed) active.tipVel.copy(active.tip).sub(prev).multiplyScalar(1 / dt);
        else active.tipVel.set(0, 0, 0);
      } else {
        // empty hand reaches toward what you point at from the lower corner (the cursor ray does the picking),
        // instead of sitting dead-centre under the reticle where its bracer blocks the view
        const sh = SHOULDER[mode.activeHand];
        const d = tmp2.copy(aimDir).multiplyScalar(1.0).sub(sh);
        active.target.copy(sh).addScaledVector(d, 0.44 / Math.max(0.3, d.length()));
        active.tip.copy(aimDir).multiplyScalar(1.0); active.tipVel.set(0, 0, 0);
      }
      // the other hand: a second blade is held up on its side as a parrying blade; an empty hand rests
      const sx = off === L ? -1 : 1;
      if (off.armed) off.target.lerp(tmp.set(sx * 0.27, -0.24, -0.5), 1 - Math.exp(-8 * dt));
      // aspis: carried low at your side (rim in the corner); on guard it comes up in front — you look over its rim
      else if (off.shield) off.target.lerp(rmb ? tmp.set(sx * 0.27, -0.42, -0.62) : tmp.set(sx * 0.44, -0.42, -0.46), 1 - Math.exp(-(rmb ? 16 : 10) * dt));
      else if (!off.gripping) off.target.lerp(off === L ? REST_LEFT : REST_RIGHT, 1 - Math.exp(-4 * dt));
    }
    if (!mode.bow) {
      L.grip = damp(L.grip, L.gripping || L.holding ? 1 : 0, 25, dt);
      R.grip = damp(R.grip, R.gripping || R.holding ? 1 : 0, 25, dt);
    }
    for (const h of ['left', 'right'] as const) {
      const tr = hands[h];
      tr.pos.lerp(tr.target, 1 - Math.exp(-28 * dt));
      tr.record(now);
      writeHand(h, tr);
      tr.wasArmed = tr.armed && h === mode.activeHand && !mode.bow;
      const speed = tr.armed ? tr.tipVel.length() * 0.6 : tr.vel.length();
      if ((tr.armed || tr.gripping) && tr.swingArmed && speed > 2.2) {
        tr.swingArmed = false;
        const d = tmp.copy(tr.armed ? tr.tipVel : tr.vel).normalize();
        emit({ type: 'swing', hand: h, speed, dir: { x: d.x, y: d.y, z: d.z } });
      } else if (speed < 1.0) tr.swingArmed = true;
    }
    return state;
  }

  return {
    kind: 'keyboard_mouse',
    mode,
    cursor,
    get glancing() { return keys.has('Tab'); },
    async start() {
      if (running) return;
      running = true;
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('blur', onBlur);
      attach(target);
    },
    stop() {
      if (!running) return;
      onBlur();
      running = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('blur', onBlur);
      const el = target;
      attach(null);
      target = el;
    },
    getState,
    on(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    onMode(cb) { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    setCamera(m) { cam = m; },
    setArmed(h, a, bladeM, holding) { const t = hands[h]; t.armed = a; if (bladeM) t.blade = bladeM; t.holding = holding ?? a; t.shield = !!t.holding && !a && !(mode.bow && h === 'left'); },
    setTarget(el) { attach(el); },
    getDebugVideo: () => null,
  };
}
