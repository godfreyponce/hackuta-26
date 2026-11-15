// Engine: turns RawFrames into PlayerInputState + InputEvents. Pure (no DOM, no MediaPipe),
// so the live controller, the replay controller and unit tests all share it.
import type { InputEvent, PlayerInputState } from '@ithaca/shared';
import { config } from './config';
import { neutralState } from './neutral';
import type { RawFrame } from './types';

export type Listener = (e: InputEvent) => void;

/** Landmarks used to judge overall visibility (C.9). */
const KEY_POSE = [0, 11, 12, 13, 14, 15, 16] as const;

export class Engine {
  /** Video width / height; set by the source. */
  aspect = 16 / 9;
  /** True when the tracker runs on CPU (C.1: report degraded). */
  cpuFallback = false;

  readonly state: PlayerInputState = neutralState('off');
  lastFrame: RawFrame | null = null;

  private readonly listeners = new Set<Listener>();
  private poseLostSince = -1;
  private poseBackSince = -1;
  private lost = true;
  private everSeen = false;
  private avgVisibility = 0;

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

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
  }

  end(): void {
    this.state.tracking = 'off';
    this.state.hands.left.visible = this.state.hands.right.visible = false;
  }

  push(frame: RawFrame): void {
    this.lastFrame = frame;
    this.updateTracking(frame);
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

  get visibility(): number {
    return this.avgVisibility;
  }
}
