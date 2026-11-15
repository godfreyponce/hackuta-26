// Engine: turns RawFrames into PlayerInputState + InputEvents. Pure (no DOM, no MediaPipe),
// so the live controller, the replay controller and unit tests all share it.
import type { InputEvent, PlayerInputState } from '@ithaca/shared';
import { config } from './config';
import { Gestures, type DetectorFlags } from './gestures';
import { GripTracker } from './grip';
import { HANDS, Mapper, type Body } from './mapping';
import { copy3 } from './math';
import { neutralState } from './neutral';
import { cloneProfile, DEFAULT_PROFILE, type Profile } from './profile';
import type { PendingGesture, RawFrame } from './types';

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

  private readonly emitFn = (e: InputEvent): void => this.emit(e);

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
