import type { InputController, PlayerInputState } from '@ithaca/shared';
import { config } from './config';
import { Engine } from './engine';
import { Tracker } from './tracker';
import type { RawFrame, RawHand, TrackerStats } from './types';

export interface MotionControllerOptions {
  /** URL prefix where the .task models and wasm/ live. Default "/models". */
  modelBaseUrl?: string;
  /** "full" (default) or "lite" if fps is tight. */
  poseModel?: 'full' | 'lite';
  /** Render the webcam into this element instead of a hidden one. */
  video?: HTMLVideoElement;
  deviceId?: string;
}

/** Extras on top of InputController used by the Motion Lab and A's HUD. All optional for A. */
export interface MotionDebug {
  getStats(): TrackerStats;
  /** Latest raw frame (for skeleton overlays). */
  getDebugFrame(): RawFrame | null;
  /** Hand results incl. frames where hands were skipped (perf mode). */
  getDebugHands(): RawHand[];
}

export interface MotionController extends InputController, MotionDebug {
  readonly kind: 'motion';
}

export function createMotionController(opts: MotionControllerOptions = {}): MotionController {
  const engine = new Engine();
  const tracker = new Tracker({
    modelBaseUrl: opts.modelBaseUrl ?? '/models',
    poseModel: opts.poseModel ?? 'full',
    video: opts.video,
    deviceId: opts.deviceId,
    downgradeBelowFps: config.downgradeBelowFps,
  });
  tracker.onFrame = (f) => {
    engine.aspect = tracker.aspect;
    engine.cpuFallback = tracker.stats.delegate === 'CPU';
    engine.push(f);
  };

  return {
    kind: 'motion',
    async start() {
      engine.begin();
      try {
        await tracker.start();
      } catch (err) {
        engine.end();
        throw err;
      }
    },
    stop() {
      tracker.stop();
      engine.end();
    },
    getState(): PlayerInputState {
      engine.state.t = performance.now();
      return engine.state;
    },
    on: (cb) => engine.on(cb),
    getDebugVideo: () => tracker.video,
    getStats: () => tracker.stats,
    getDebugFrame: () => engine.lastFrame,
    getDebugHands: () => tracker.getLastHands(),
  };
}
