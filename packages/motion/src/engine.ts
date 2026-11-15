// Engine: turns RawFrames into PlayerInputState + InputEvents. Pure (no DOM, no MediaPipe),
// so the live controller, the replay controller and unit tests all share it.
import type { CalibrationResult, InputEvent, PlayerInputState } from '@ithaca/shared';
import { Calibrator } from './calibration';
import { config } from './config';
import { Gestures, type DetectorFlags } from './gestures';
import { GripTracker } from './grip';
import { HANDS, Mapper, type Body } from './mapping';
import { copy3 } from './math';
import { neutralState } from './neutral';
import { cloneProfile, DEFAULT_PROFILE, type Profile } from './profile';
import type { CalibrationStep, PendingGesture, RawFrame } from './types';

export type Listener = (e: InputEvent) => void;

/** Landmarks used to judge overall visibility (C.9). */
const KEY_POSE = [0, 11, 12, 13, 14, 15, 16] as const;

export class Engine {
  /** Video width / height; set by the source. */
  aspect = 16 / 9;
  /** True when the tracker runs on CPU (C.1: report degraded). */
  cpuFallback = false;
  profile: Profile;

  /** Internal state at the last frame. */
  readonly state: PlayerInputState = neutralState('off');
  /** What getState() hands out: `state` extrapolated to "now" (≤ maxExtrapolateMs). Reused object. */
  private readonly out: PlayerInputState = neutralState('off');
  lastFrame: RawFrame | null = null;
  /** performance.now() when the last frame was processed. */
  private lastFrameWall = 0;

  readonly mapper = new Mapper();
  readonly grip = new GripTracker();
  readonly gestures = new Gestures();
  private readonly listeners = new Set<Listener>();
  private poseLostSince = -1;
  private poseBackSince = -1;
  private lost = true;
  private everSeen = false;
  private avgVisibility = 0;

  constructor(profile?: Profile | null) {
    this.profile = profile ? cloneProfile(profile) : cloneProfile(DEFAULT_PROFILE);
  }

  get body(): Body {
    return this.mapper.body;
  }

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private calibrator: Calibrator | null = null;
  private calibTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly calibListeners = new Set<(s: CalibrationStep) => void>();
  /** Called with the new profile after a successful calibration (controller persists it). */
  onProfileChange: (p: Profile) => void = () => {};

  /** Gameplay events are muted while calibrating (guard pose ≠ block, fist ≠ grab). */
  private readonly emitFn = (e: InputEvent): void => {
    if (this.calibrator && e.type !== 'tracking_lost' && e.type !== 'tracking_ok') return;
    this.emit(e);
  };

  emit(e: InputEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        console.error('[motion] listener threw', err);
      }
    }
  }

  /** Called when the source starts: tracking is "lost" until a pose shows up. */
  begin(): void {
    this.lost = true;
    this.everSeen = false;
    this.poseLostSince = this.poseBackSince = -1;
    this.state.tracking = 'lost';
    this.mapper.reset();
    this.grip.reset();
    this.gestures.reset();
  }

  end(): void {
    this.calibrator?.cancel();
    this.state.tracking = 'off';
    this.state.hands.left.visible = this.state.hands.right.visible = false;
  }

  push(frame: RawFrame, wallNow = nowMs()): void {
    this.lastFrame = frame;
    this.lastFrameWall = wallNow;
    this.updateTracking(frame);
    const body = this.mapper.update(frame.poseImage, frame.poseWorld, frame.hands, frame.t, this.aspect, this.profile, this.state);
    this.grip.update(body, frame.hands === null, this.profile, this.state, this.emitFn);
    this.gestures.update(body, this.grip, this.state, this.emitFn);
    if (this.calibrator) {
      const pi = frame.poseImage;
      const hipVis = pi ? Math.min(pi[23]?.visibility ?? 0, pi[24]?.visibility ?? 0) : 0;
      this.calibrator.update(body, hipVis);
    }
    this.state.t = frame.t;
  }

  /** Latest state, extrapolated ≤ maxExtrapolateMs along hand velocity. The returned object is reused. */
  getState(wallNow = nowMs()): PlayerInputState {
    const s = this.state, o = this.out;
    o.t = wallNow;
    o.tracking = s.tracking;
    o.body.lean = s.body.lean;
    o.body.crouch = s.body.crouch;
    o.body.yaw = s.body.yaw;
    o.bowDraw = s.bowDraw;
    const ahead = this.lastFrameWall ? Math.min(Math.max(wallNow - this.lastFrameWall, 0), config.maxExtrapolateMs) / 1000 : 0;
    for (const h of HANDS) {
      const a = s.hands[h], b = o.hands[h];
      b.visible = a.visible;
      b.confidence = a.confidence;
      b.grip = a.grip;
      copy3(b.vel, a.vel);
      copy3(b.forward, a.forward);
      copy3(b.up, a.up);
      const k = a.visible ? ahead : 0;
      b.pos.x = a.pos.x + a.vel.x * k;
      b.pos.y = a.pos.y + a.vel.y * k;
      b.pos.z = a.pos.z + a.vel.z * k;
    }
    return o;
  }

  private updateTracking(f: RawFrame): void {
    const t = f.t;
    const pose = f.poseImage;
    if (pose) {
      let sum = 0;
      for (const i of KEY_POSE) sum += pose[i]?.visibility ?? 0;
      this.avgVisibility = sum / KEY_POSE.length;
      this.poseLostSince = -1;
      if (this.poseBackSince < 0) this.poseBackSince = t;
      // tracking_ok after the pose is back for 300 ms (immediately the very first time).
      if (this.lost && (!this.everSeen || t - this.poseBackSince >= config.trackingOkMs)) {
        this.lost = false;
        if (this.everSeen) this.emit({ type: 'tracking_ok' });
        this.everSeen = true;
      }
    } else {
      this.poseBackSince = -1;
      if (this.poseLostSince < 0) this.poseLostSince = t;
      if (!this.lost && t - this.poseLostSince >= config.trackingLostMs) {
        this.lost = true;
        this.emit({ type: 'tracking_lost' });
      }
    }
    if (this.state.tracking === 'calibrating') return;
    this.state.tracking = this.lost
      ? 'lost'
      : this.cpuFallback || this.avgVisibility < config.degradedVisibility
        ? 'degraded'
        : 'ok';
  }

  /** C.6: runs the 4-step calibration on incoming frames. Resolves ok:false on timeout or stop(). */
  calibrate(): Promise<CalibrationResult> {
    if (this.calibrator) return this.calibrator.promise;
    const prevTracking = this.state.tracking;
    // Close out anything the game thinks is held, then run with gameplay events muted.
    for (const h of HANDS) if (this.grip.isGripping(h)) this.emit({ type: 'release', hand: h, vel: { x: 0, y: 0, z: 0 } });
    if (this.gestures.isBlocking) this.emit({ type: 'block_end' });
    this.grip.reset();
    this.gestures.reset();
    this.state.tracking = 'calibrating';
    const cal = new Calibrator(
      this.profile,
      (s) => {
        for (const cb of this.calibListeners) cb(s);
      },
      (profile) => {
        if (this.calibTimer) clearTimeout(this.calibTimer);
        this.calibTimer = null;
        this.calibrator = null;
        // Grabs during calibration were muted: start clean so no unpaired release reaches the game.
        this.grip.reset();
        this.gestures.reset();
        if (this.state.tracking === 'calibrating') this.state.tracking = prevTracking === 'off' ? 'off' : 'lost';
        if (profile) {
          this.profile = profile;
          this.mapper.resetAutoNeutral();
          this.onProfileChange(profile);
        }
      },
    );
    this.calibrator = cal;
    // Wall-clock safety net in case frames stop arriving (camera unplugged, never started).
    this.calibTimer = setTimeout(() => cal.cancel(), config.calibTimeoutMs + 2000);
    return cal.promise;
  }

  onCalibrationStep(cb: (s: CalibrationStep) => void): () => void {
    this.calibListeners.add(cb);
    if (this.calibrator) cb(this.calibrator.current);
    return () => {
      this.calibListeners.delete(cb);
    };
  }

  get isCalibrating(): boolean {
    return this.calibrator !== null;
  }

  /** In-flight hold gesture (call_sign / request_weapon / drink) for A's progress ring. */
  getPendingGesture(): PendingGesture | null {
    return this.state.tracking === 'off' ? null : this.gestures.pending(this.state.t);
  }

  detectorFlags(): DetectorFlags {
    const d = this.gestures.debug;
    return {
      gripL: this.grip.isGripping('left'),
      gripR: this.grip.isGripping('right'),
      blockPose: d.blockPose,
      blocking: this.gestures.isBlocking,
      bowArm: d.leftArmExtended,
      nocked: d.nocked,
      phoneShape: d.callShape.left || d.callShape.right,
      nearEar: d.callNearEar.left || d.callNearEar.right,
      armsUp: d.armsUp,
    };
  }

  get visibility(): number {
    return this.avgVisibility;
  }
}

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
