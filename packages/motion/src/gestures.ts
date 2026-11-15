// C.5 gesture state machines. Run after Mapper + GripTracker each frame.
import type { Hand, InputEvent, PlayerInputState } from '@ithaca/shared';
import { config } from './config';
import type { GripTracker } from './grip';
import { HANDS, NOSE, POSE_IDX, type Body } from './mapping';
import { clamp, type Vec2 } from './math';
import type { PendingGesture } from './types';

type Emit = (e: InputEvent) => void;

/**
 * "Hold a pose for N ms" with a short grace period for tracking blips, one fire per hold,
 * and an optional cooldown after firing.
 */
export class Hold {
  private start = -1;
  private lastActive = -1;
  private fired = false;
  private cooldownUntil = -1;

  /** Returns true on the frame the hold completes. */
  update(active: boolean, t: number, holdMs: number, graceMs: number, cooldownMs = 0): boolean {
    if (active) {
      this.lastActive = t;
      if (t < this.cooldownUntil) return false;
      if (this.start < 0) this.start = t;
      if (!this.fired && t - this.start >= holdMs) {
        this.fired = true;
        this.cooldownUntil = t + cooldownMs;
        return true;
      }
    } else if (this.start >= 0 && t - this.lastActive > graceMs) {
      this.start = -1;
      this.fired = false;
    } else if (this.start < 0) {
      this.fired = false;
    }
    return false;
  }

  /** 0..1 progress of an in-flight (not yet fired) hold. */
  progress(t: number, holdMs: number): number {
    return this.start < 0 || this.fired ? 0 : clamp((t - this.start) / holdMs, 0, 1);
  }

  get active(): boolean {
    return this.start >= 0;
  }

  reset(): void {
    this.start = this.lastActive = this.cooldownUntil = -1;
    this.fired = false;
  }
}

/** Grace for one-frame tracking blips on held gestures. */
const GRACE_MS = 150;

export class Gestures {
  readonly callSign: Record<Hand, Hold> = { left: new Hold(), right: new Hold() };
  private callCooldownUntil = -1;
  readonly requestWeapon = new Hold();
  /** Last frame's diagnostics for the lab. */
  readonly debug = {
    callShape: { left: false, right: false } as Record<Hand, boolean>,
    callNearEar: { left: false, right: false } as Record<Hand, boolean>,
    armsUp: false,
  };

  reset(): void {
    for (const h of HANDS) this.callSign[h].reset();
    this.requestWeapon.reset();
    this.callCooldownUntil = -1;
  }

  update(body: Body, _grip: GripTracker, _state: PlayerInputState, emit: Emit): void {
    const t = body.t;
    this.updateCallSign(body, t, emit);
    this.updateRequestWeapon(body, t, emit);
  }

  /** call_sign: "phone"/shaka hand (thumb + pinky out, middle three curled) by the ear, held 1 s. Cooldown 5 s. */
  private updateCallSign(body: Body, t: number, emit: Emit): void {
    for (const h of HANDS) {
      const shape = body.ok && !!body.hand[h] && body.handFresh[h] && isPhoneShape(body, h);
      const near = body.ok && !!body.hand[h] && nearestEarM(body, body.palmImg[h]) < config.callEarDist;
      this.debug.callShape[h] = shape;
      this.debug.callNearEar[h] = near;
      const active = shape && near && t >= this.callCooldownUntil;
      if (this.callSign[h].update(active, t, config.callHoldMs, GRACE_MS)) {
        this.callCooldownUntil = t + config.callCooldownMs;
        for (const o of HANDS) if (o !== h) this.callSign[o].reset();
        emit({ type: 'call_sign' });
      }
    }
  }

  /** request_weapon: both wrists above the head (> 0.15 m above the nose), held 0.8 s. Cooldown 4 s. */
  private updateRequestWeapon(body: Body, t: number, emit: Emit): void {
    let up = false;
    if (body.ok) {
      const nose = body.img[NOSE] as Vec2;
      up = HANDS.every((h) => {
        const w = body.img[POSE_IDX[h].wrist] as Vec2;
        return body.wristVis[h] > config.requestMinVisibility && (nose.y - w.y) * body.mPerImg > config.requestAboveHeadM;
      });
    }
    this.debug.armsUp = up;
    if (this.requestWeapon.update(up, t, config.requestHoldMs, GRACE_MS, config.requestCooldownMs)) {
      emit({ type: 'request_weapon' });
    }
  }

  /** The most advanced in-flight hold gesture, for A's radial progress ring. */
  pending(t: number): PendingGesture | null {
    let best: PendingGesture | null = null;
    const consider = (name: PendingGesture['name'], p: number) => {
      if (p > 0 && (!best || p > best.progress)) best = { name, progress: p };
    };
    for (const h of HANDS) consider('call_sign', this.callSign[h].progress(t, config.callHoldMs));
    consider('request_weapon', this.requestWeapon.progress(t, config.requestHoldMs));
    return best;
  }
}

function isPhoneShape(body: Body, h: Hand): boolean {
  const [index = 0, middle = 0, ring = 0, pinky = 1] = body.curls[h];
  return (
    body.thumbExt[h] > config.callThumbExt &&
    pinky < config.callPinkyMaxCurl &&
    index > config.callFingerMinCurl &&
    middle > config.callFingerMinCurl &&
    ring > config.callFingerMinCurl
  );
}

/** Distance (m) from an image point to the nearer ear (pose 7 / 8). */
function nearestEarM(body: Body, p: Vec2): number {
  const l = body.img[POSE_IDX.left.ear] as Vec2;
  const r = body.img[POSE_IDX.right.ear] as Vec2;
  return Math.min(body.meters(p, l), body.meters(p, r));
}
