// createReplayController: an InputController driven by a recording, in real time.
// Lets A test motion behavior without standing up, and lets C tune deterministically.
import type { CalibrationResult, Hand, InputController, PlayerInputState } from '@ithaca/shared';
import type { MotionDebug } from './controller';
import { Engine } from './engine';
import type { DetectorFlags } from './gestures';
import type { Profile } from './profile';
import { parseRecording } from './recording';
import type { CalibrationStep, PendingGesture, RawFrame, RawHand, Recording, TrackerStats } from './types';

export interface ReplayOptions {
  /** Restart at the end (default true). */
  loop?: boolean;
  /** Playback rate (default 1). */
  speed?: number;
  /** Calibration to use. Default: uncalibrated defaults, so replays are reproducible. */
  profile?: Profile | null;
  onEnd?: () => void;
}

export interface ReplayController extends InputController, MotionDebug {
  readonly kind: 'replay';
  readonly recording: Recording;
  getPendingGesture(): PendingGesture | null;
  calibrate(): Promise<CalibrationResult>;
  onCalibrationStep(cb: (s: CalibrationStep) => void): () => void;
  getProfile(): Readonly<Profile>;
  /** 0..1 playback position. */
  getProgress(): number;
  /** Same as MotionController.resyncGrip: mirror what the game holds (optional for callers). */
  resyncGrip?(keep?: Record<Hand, boolean>): void;
}

type Tick = (cb: () => void) => unknown;
const nextTick: Tick =
  typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 8);
const cancelTick = (h: unknown): void => {
  if (typeof cancelAnimationFrame === 'function' && typeof h === 'number') cancelAnimationFrame(h);
  else clearTimeout(h as ReturnType<typeof setTimeout>);
};
const now = (): number => performance.now();

export function createReplayController(input: Recording | string, opts: ReplayOptions = {}): ReplayController {
  const recording = parseRecording(input);
  const frames = recording.frames;
  const duration = frames[frames.length - 1]?.t ?? 0;
  const frameGap = frames.length > 1 ? duration / (frames.length - 1) : 16.7;
  const loop = opts.loop ?? true;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;

  const engine = new Engine(opts.profile ?? null);
  engine.aspect = recording.meta.aspect;
  const stats: TrackerStats = {
    fps: duration > 0 ? ((frames.length - 1) * 1000) / duration : 0,
    msPerFrame: 0,
    delegate: 'none',
    width: recording.meta.width,
    height: recording.meta.height,
    handsEveryOtherFrame: false,
    error: null,
  };

  let running = false;
  let handle: unknown = null;
  let startWall = 0;
  let idx = 0;
  /** Added to recording times so time keeps increasing across loops. */
  let offset = 0;
  let lastHands: RawHand[] = [];

  const pump = (): void => {
    if (!running) return;
    const elapsed = (now() - startWall) * speed;
    while (running) {
      const f = frames[idx];
      if (!f) {
        if (!loop) {
          running = false;
          engine.end();
          opts.onEnd?.();
          return;
        }
        offset += duration + frameGap;
        idx = 0;
        continue;
      }
      if (f.t + offset > elapsed) break;
      const t0 = now();
      const frame: RawFrame = { ...f, t: f.t + offset };
      if (f.hands) lastHands = f.hands;
      engine.push(frame);
      const dt = now() - t0;
      stats.msPerFrame = stats.msPerFrame ? stats.msPerFrame * 0.9 + dt * 0.1 : dt;
      idx++;
    }
    handle = nextTick(pump);
  };

  return {
    kind: 'replay',
    recording,
    async start() {
      if (running) return;
      if (!frames.length) throw new Error('Recording has no frames.');
      running = true;
      idx = 0;
      offset = 0;
      startWall = now();
      engine.begin();
      pump();
    },
    stop() {
      running = false;
      if (handle !== null) cancelTick(handle);
      handle = null;
      engine.end();
    },
    getState: (): PlayerInputState => engine.getState(),
    on: (cb) => engine.on(cb),
    getDebugVideo: () => null,
    getStats: () => stats,
    getDebugFrame: () => engine.lastFrame,
    getDebugHands: () => lastHands,
    getDebugBody: () => engine.body,
    getDebugGestures: (): DetectorFlags => engine.detectorFlags(),
    getPendingGesture: () => engine.getPendingGesture(),
    calibrate: () => engine.calibrate(),
    onCalibrationStep: (cb) => engine.onCalibrationStep(cb),
    getProfile: () => engine.profile,
    getProgress: () => (frames.length ? Math.min(idx / frames.length, 1) : 0),
    resyncGrip: (keep) => engine.resyncGrip(keep),
  };
}
