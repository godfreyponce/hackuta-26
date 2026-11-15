import type { CalibrationResult, Hand, InputController, PlayerInputState } from '@ithaca/shared';
import { config } from './config';
import { Engine } from './engine';
import type { DetectorFlags } from './gestures';
import type { CropRect } from './handRoi';
import type { Body } from './mapping';
import { clearSavedProfile, cloneProfile, DEFAULT_PROFILE, loadProfile, saveProfile, type Profile } from './profile';
import { Recorder } from './recording';
import { Tracker } from './tracker';
import type { CalibrationStep, PendingGesture, RawFrame, RawHand, Recording, TrackerStats } from './types';

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
  /** Derived skeleton in game space (joints, assigned hands). */
  getDebugBody(): Body | null;
  /** Per-detector live flags (block pose, bow arm, phone shape, …). */
  getDebugGestures(): DetectorFlags;
  /** Pose-guided hand crops of the last frame, source-video px (live camera only). */
  getDebugRois?(): Record<Hand, CropRect | null>;
}

export interface MotionController extends InputController, MotionDebug {
  readonly kind: 'motion';
  /** In-flight hold gesture for a radial progress ring (C.5), or null. */
  getPendingGesture(): PendingGesture | null;
  calibrate(): Promise<CalibrationResult>;
  /** C.6: step/progress/message updates while calibrate() runs (A draws the UI). */
  onCalibrationStep(cb: (s: CalibrationStep) => void): () => void;
  getProfile(): Readonly<Profile>;
  /** Forget the saved calibration and go back to defaults. */
  resetCalibration(): void;
  /**
   * Call on match start / resume. Emits `release` for any hand the motion side thinks is closed but the game
   * does not hold (`keep[h]` false), resets grip tracking, and latches each hand to `keep[h]`.
   */
  resyncGrip?(keep?: Record<Hand, boolean>): void;
  /** C.7: record raw tracker frames for replay / tuning. */
  startRecording(label?: string): void;
  stopRecording(): Recording | null;
  getRecordingInfo(): { recording: boolean; frames: number; durationMs: number };
}

export function createMotionController(opts: MotionControllerOptions = {}): MotionController {
  const engine = new Engine(loadProfile());
  engine.onProfileChange = saveProfile;
  const recorder = new Recorder();
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
    recorder.push(f);
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
    getState: (): PlayerInputState => engine.getState(),
    on: (cb) => engine.on(cb),
    getDebugVideo: () => tracker.video,
    getStats: () => tracker.stats,
    getDebugFrame: () => engine.lastFrame,
    getDebugHands: () => tracker.getLastHands(),
    getDebugBody: () => engine.body,
    getPendingGesture: () => engine.getPendingGesture(),
    getDebugGestures: () => engine.detectorFlags(),
    getDebugRois: () => tracker.getDebugRois(),
    calibrate: () => engine.calibrate(),
    onCalibrationStep: (cb) => engine.onCalibrationStep(cb),
    getProfile: () => engine.profile,
    resyncGrip: (keep) => engine.resyncGrip(keep),
    startRecording(label?: string) {
      recorder.start({ label, aspect: tracker.aspect, width: tracker.stats.width, height: tracker.stats.height, profile: cloneProfile(engine.profile) });
    },
    stopRecording: () => recorder.stop(),
    getRecordingInfo: () => ({ recording: recorder.recording, frames: recorder.frameCount, durationMs: recorder.durationMs }),
    resetCalibration() {
      clearSavedProfile();
      engine.profile = cloneProfile(DEFAULT_PROFILE);
      engine.mapper.resetAutoNeutral();
    },
  };
}
