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
}

const REST_LEFT = new THREE.Vector3(-0.3, -0.4, -0.5);
const REST_RIGHT = new THREE.Vector3(0.24, -0.32, -0.5);
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
  constructor(p: THREE.Vector3) { this.pos = p.clone(); this.target = p.clone(); }
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

  function gripHand(h: Hand, on: boolean) {
    const tr = hands[h];
    if (tr.gripping === on) return;
    tr.gripping = on;
    if (on) emit({ type: 'grab', hand: h });
    else {
      // flick velocity from raw cursor samples (the rendered hand is smoothed and lags fast flicks)
      const flick = cursorVel(h === mode.activeHand ? 90 : 0, tmp);
      const speed = flick.length();
      rayDir(aimDir);
      let vel: THREE.Vector3;
      if (speed > 1.0) {
        // Mouse flicks are planar — inject the aim ray so throws travel where you point.
        vel = tmp2.copy(aimDir).multiplyScalar(2.4 + Math.min(speed, 8) * 1.5).addScaledVector(flick, 0.35);
      } else vel = tmp2.copy(flick);
      emit({ type: 'release', hand: h, vel: { x: vel.x, y: vel.y, z: vel.z } });
    }
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
      case 'Space':
        if (mode.bow) { e.preventDefault(); startDraw(); }
        break;
      case 'KeyE': emit({ type: 'drink', hand: hands.left.gripping && !hands.right.gripping ? 'left' : 'right' }); break;
      case 'KeyC': emit({ type: 'call_sign' }); break;
      case 'KeyQ': emit({ type: 'request_weapon' }); break;
      case 'KeyF': {
        const h = mode.activeHand;
        if (hands[h].gripping) {
          hands[h].gripping = false;
          rayDir(aimDir);
          emit({ type: 'release', hand: h, vel: { x: aimDir.x * 7, y: aimDir.y * 7 + 0.6, z: aimDir.z * 7 } });
        }
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
    if (down) {
      if (mode.bow) startDraw();
      else gripHand(mode.activeHand, true);
    } else if (mode.bow) loose();
    else {
      gripHand(mode.activeHand, false);
      // A left grip latched while Shift was held is released with the button too.
      if (mode.activeHand === 'right' && hands.left.gripping) gripHand('left', false);
    }
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
    else if (rmb) f.set(h === 'right' ? -0.92 : 0.92, 0.24, -0.32).normalize();
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
    } else if (rmb) {
      // guard: sword raised crosswise in front of the face, through all three attack lanes
      L.target.set(-0.16, -0.04, -0.46);
      R.target.set(0.2, 0.0, -0.52);
    } else {
      const active = hands[mode.activeHand];
      // auto-lunge: a fast swing with a weapon extends the arm (mouse can't push forward)
      lunge = damp(lunge, active.gripping && active.vel.length() > 1.5 ? 0.24 : 0, 10, dt);
      active.target.copy(aimDir).multiplyScalar(reach + lunge);
      if (mode.activeHand === 'right' && !L.gripping) L.target.lerp(REST_LEFT, 1 - Math.exp(-4 * dt));
    }
    if (!mode.bow) {
      L.grip = damp(L.grip, L.gripping ? 1 : 0, 25, dt);
      R.grip = damp(R.grip, R.gripping ? 1 : 0, 25, dt);
    }
    for (const h of ['left', 'right'] as const) {
      const tr = hands[h];
      tr.pos.lerp(tr.target, 1 - Math.exp(-28 * dt));
      tr.record(now);
      writeHand(h, tr);
      const speed = tr.vel.length();
      if (tr.gripping && tr.swingArmed && speed > 2.2) {
        tr.swingArmed = false;
        const d = tmp.copy(tr.vel).normalize();
        emit({ type: 'swing', hand: h, speed, dir: { x: d.x, y: d.y, z: d.z } });
      } else if (speed < 1.0) tr.swingArmed = true;
    }
    return state;
  }

  return {
    kind: 'keyboard_mouse',
    mode,
    cursor,
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
    setTarget(el) { attach(el); },
    getDebugVideo: () => null,
  };
}
