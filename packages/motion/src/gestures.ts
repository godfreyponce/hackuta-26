// C.5 gesture state machines. Run after Mapper + GripTracker each frame.
import type { Hand, InputEvent, PlayerInputState } from '@ithaca/shared';
import { config } from './config';
import type { GripTracker } from './grip';
import { HANDS, MOUTH_L, MOUTH_R, NOSE, POSE_IDX, type Body } from './mapping';
import { clamp, dist3, len3, normalize3, sub3, v3, type Vec2 } from './math';
import type { PendingGesture } from './types';

type Emit = (e: InputEvent) => void;

export type DetectorFlags = Record<
  'gripL' | 'gripR' | 'blockPose' | 'blocking' | 'bowArm' | 'nocked' | 'phoneShape' | 'nearEar' | 'armsUp',
  boolean
>;

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

const mouth: Vec2 = { x: 0, y: 0 };

/** Grace for one-frame tracking blips on held gestures. */
const GRACE_MS = 150;

export class Gestures {
  readonly callSign: Record<Hand, Hold> = { left: new Hold(), right: new Hold() };
  private callCooldownUntil = -1;
  readonly requestWeapon = new Hold();
  readonly drink: Record<Hand, Hold> = { left: new Hold(), right: new Hold() };
  private readonly swingArmed: Record<Hand, boolean> = { left: true, right: true };
  private blocking = false;
  private blockSince = -1;
  private blockBrokenSince = -1;
  private nocked = false;
  private bowLostSince = -1;
  private bowOpenFrames = 0;
  private bowDraw = 0;
  /** Last frame's diagnostics for the lab. */
  readonly debug = {
    callShape: { left: false, right: false } as Record<Hand, boolean>,
    callNearEar: { left: false, right: false } as Record<Hand, boolean>,
    armsUp: false,
    blockPose: false,
    leftArmExtended: false,
    nocked: false,
    /** Why the last nocked arrow was dropped (lab/guide feedback). */
    bowDropReason: '',
  };

  reset(): void {
    for (const h of HANDS) this.callSign[h].reset();
    this.requestWeapon.reset();
    this.callCooldownUntil = -1;
    for (const h of HANDS) {
      this.drink[h].reset();
      this.swingArmed[h] = true;
    }
    this.blocking = false;
    this.blockSince = this.blockBrokenSince = -1;
    this.nocked = false;
    this.bowLostSince = -1;
    this.bowOpenFrames = 0;
    this.bowDraw = 0;
  }

  update(body: Body, grip: GripTracker, state: PlayerInputState, emit: Emit): void {
    const t = body.t;
    this.updateSwing(state, emit);
    this.updateBlock(body, state, t, emit);
    this.updateDrink(body, grip, t, emit);
    this.updateBow(body, grip, state, t, emit);
    this.updateCallSign(body, t, emit);
    this.updateRequestWeapon(body, t, emit);
  }

  get isBlocking(): boolean {
    return this.blocking;
  }

  get isNocked(): boolean {
    return this.nocked;
  }

  /** swing: hand speed > 2.2 m/s while grip > 0.5; once per swing, re-armed below 1.0 m/s. */
  private updateSwing(state: PlayerInputState, emit: Emit): void {
    for (const h of HANDS) {
      const hs = state.hands[h];
      const speed = len3(hs.vel);
      if (this.swingArmed[h]) {
        if (hs.visible && speed > config.swingSpeed && hs.grip > config.swingMinGrip) {
          this.swingArmed[h] = false;
          emit({ type: 'swing', hand: h, speed, dir: normalize3(v3(hs.vel.x, hs.vel.y, hs.vel.z)) });
        }
      } else if (speed < config.swingRearmSpeed) {
        this.swingArmed[h] = true;
      }
    }
  }

  /**
   * block: both wrists above their elbows, within 0.35 m of the face line (eye height),
   * forearms roughly horizontal; held 150 ms. Ends once the pose is broken for 200 ms.
   */
  private updateBlock(body: Body, state: PlayerInputState, t: number, emit: Emit): void {
    const pose =
      body.ok &&
      HANDS.every((h) => {
        const hs = state.hands[h];
        return (
          hs.visible &&
          body.wrist[h].y > body.elbow[h].y &&
          Math.abs(hs.pos.y) < config.blockFaceDist &&
          Math.abs(hs.forward.y) < config.blockMaxForearmSlope
        );
      });
    this.debug.blockPose = pose;
    if (!this.blocking) {
      if (!pose) this.blockSince = -1;
      else if (this.blockSince < 0) this.blockSince = t;
      if (pose && t - this.blockSince >= config.blockHoldMs) {
        this.blocking = true;
        this.blockBrokenSince = -1;
        emit({ type: 'block_start' });
      }
    } else {
      if (pose) this.blockBrokenSince = -1;
      else if (this.blockBrokenSince < 0) this.blockBrokenSince = t;
      if (!pose && t - this.blockBrokenSince >= config.blockEndMs) {
        this.blocking = false;
        this.blockSince = -1;
        emit({ type: 'block_end' });
      }
    }
  }

  /** drink: a gripping (non-phone-shaped) hand within 0.12 m of the mouth (pose 9/10), held 600 ms. Re-arms when the hand leaves. */
  private updateDrink(body: Body, grip: GripTracker, t: number, emit: Emit): void {
    for (const h of HANDS) {
      let near = false;
      // A phone/shaka hand at the ear is also near the mouth and reads as a grip: that's call_sign, not drink.
      const phone = !!body.hand[h] && isPhoneShape(body, h);
      if (body.ok && !phone && grip.isGripping(h) && body.wristVis[h] > config.wristMinVisibility) {
        const ml = body.img[MOUTH_L] as Vec2, mr = body.img[MOUTH_R] as Vec2;
        mouth.x = (ml.x + mr.x) / 2;
        mouth.y = (ml.y + mr.y) / 2;
        const p = body.hand[h] ? body.palmImg[h] : (body.img[POSE_IDX[h].wrist] as Vec2);
        near = body.meters(p, mouth) < config.drinkMouthDist;
      }
      if (this.drink[h].update(near, t, config.drinkHoldMs, GRACE_MS)) emit({ type: 'drink', hand: h });
    }
  }

  /**
   * Bow (right-handed archer): left arm extended (elbow > 150 deg, wrist forward) + right hand grips
   * within 0.15 m of the left wrist -> bow_nock. bowDraw = |right - left| / arm reach while nocked.
   * Right hand opens with draw > 0.2 -> bow_release { draw, aim: normalize(leftWrist - rightShoulder) }.
   */
  private updateBow(body: Body, grip: GripTracker, state: PlayerInputState, t: number, emit: Emit): void {
    const L = state.hands.left, R = state.hands.right;
    const extended =
      body.ok && L.visible && body.elbowAngle.left > config.bowElbowAngle && L.pos.z < config.bowWristForwardZ;
    this.debug.leftArmExtended = extended;

    if (!this.nocked) {
      state.bowDraw = 0;
      if (extended && R.visible && grip.isGripping('right')) {
        const rp = body.hand.right ? body.palmImg.right : (body.img[POSE_IDX.right.wrist] as Vec2);
        if (body.meters(rp, body.img[POSE_IDX.left.wrist] as Vec2) < config.bowNockDist) {
          this.nocked = true;
          this.bowLostSince = -1;
          this.bowOpenFrames = 0;
          this.bowDraw = 0;
          this.debug.bowDropReason = '';
          emit({ type: 'bow_nock' });
        }
      }
    } else {
      // Keep drawing while the pose still tracks the right wrist; hold the last draw through blips.
      if (body.ok && R.visible) this.bowDraw = clamp(dist3(R.pos, L.pos) / config.gameArmReach, 0, 1);
      const draw = this.bowDraw;
      state.bowDraw = draw;

      // Loose only on a real open: the hand model sees the right hand open for N frames.
      // Ignored until the draw is meaningful — a sideways hand by the face misreads as "open".
      const seenOpen = body.ok && !!body.hand.right && body.handFresh.right && R.grip < config.bowReleaseGrip;
      this.bowOpenFrames = seenOpen ? this.bowOpenFrames + 1 : 0;
      if (this.bowOpenFrames >= Math.max(1, Math.round(config.bowReleaseFrames)) && draw > Math.max(config.bowMinDraw, config.bowLooseMinDraw)) {
        this.nocked = false;
        state.bowDraw = 0;
        const aim = normalize3(sub3(v3(), L.pos, body.shoulder.right));
        emit({ type: 'bow_release', draw, aim });
      } else {
        // The left arm may soften while pulling; only a clearly bent/dropped arm cancels.
        const holding =
          body.ok && L.visible && body.elbowAngle.left > config.bowHoldElbowAngle && L.pos.z < config.bowHoldWristForwardZ;
        if (holding) this.bowLostSince = -1;
        else {
          if (this.bowLostSince < 0) this.bowLostSince = t;
          if (t - this.bowLostSince > config.bowCancelMs) {
            this.nocked = false;
            state.bowDraw = 0;
            this.debug.bowDropReason = 'left arm bent or dropped';
          }
        }
      }
    }
    this.debug.nocked = this.nocked;
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
    for (const h of HANDS) consider('drink', this.drink[h].progress(t, config.drinkHoldMs));
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
