// A Tracker with fake MediaPipe models, a fake video and a fake clock, driven frame by frame (no camera, no GPU).
// Each fake hand model answers from a script: for the crop of side S (it sees which crop canvas it was given),
// where in the FULL frame is a hand, and with which handedness label — mapped into that crop's coordinates.
import { vi } from 'vitest';
import type { Hand } from '@ithaca/shared';
import { Tracker } from '../src/tracker';
import type { CropRect } from '../src/handRoi';
import type { RawFrame, RawLandmark } from '../src/types';

export const W = 1280, H = 720;

/** A hand in the full frame: centre (normalized), size (normalized height), MediaPipe label. */
export interface FakeHand {
  x: number;
  y: number;
  size?: number;
  label: 'Left' | 'Right';
}

/** 21 landmarks of an open hand around (x, y), normalized full-frame coords. */
export function handLandmarks(h: FakeHand): RawLandmark[] {
  const s = h.size ?? 0.08, sx = (s * H) / W;
  const pts: RawLandmark[] = [{ x: h.x, y: h.y + s * 0.5, z: 0 }];
  for (let k = 1; k <= 4; k++) pts.push({ x: h.x - sx * (0.15 + 0.08 * k), y: h.y + s * (0.4 - 0.1 * k), z: 0 });
  for (let f = 0; f < 4; f++) for (let k = 0; k < 4; k++) pts.push({ x: h.x + sx * (-0.15 + 0.1 * f), y: h.y - s * (0.0 + 0.15 * k), z: 0 });
  return pts;
}

export interface Pose {
  left: { x: number; y: number; vis?: number };
  right: { x: number; y: number; vis?: number };
}

/** 33 pose landmarks: shoulders above the wrists, index / pinky just above each wrist (hands raised). */
export function poseLandmarks(p: Pose): RawLandmark[] {
  const lm: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  lm[11] = { x: 0.58, y: 0.35, z: 0, visibility: 0.99 };
  lm[12] = { x: 0.42, y: 0.35, z: 0, visibility: 0.99 };
  const put = (w: number, pinky: number, index: number, q: Pose['left']) => {
    const vis = q.vis ?? 0.9;
    lm[w] = { x: q.x, y: q.y, z: 0, visibility: vis };
    lm[pinky] = { x: q.x + 0.008, y: q.y - 0.03, z: 0, visibility: vis };
    lm[index] = { x: q.x - 0.004, y: q.y - 0.035, z: 0, visibility: vis };
  };
  put(15, 17, 19, p.left);
  put(16, 18, 20, p.right);
  return lm;
}

export interface Script {
  pose: Pose;
  /** VIDEO crop result per side (null = miss). */
  vid: Partial<Record<Hand, FakeHand | null>>;
  /** IMAGE retry result per side (null = miss). */
  img?: Partial<Record<Hand, FakeHand | null>>;
  /** Full-frame model's hands (re-seed / no-pose path). */
  full?: FakeHand[];
}

export interface Cost {
  pose: number;
  vid: number;
  img: number;
  full: number;
}

type Priv = {
  pose: unknown;
  hands: unknown;
  handVid: Record<Hand, unknown>;
  handImg: unknown;
  crop: Record<Hand, { cv: unknown; ctx: unknown } | null>;
  running: boolean;
  startedAt: number;
  fpsWindowStart: number;
  settingsFps: number;
  frameNo: number;
  roi: Record<Hand, { rect: CropRect | null; last: unknown; lastT: number; mask: CropRect | null; maskUntil: number; offFrameSince: number }>;
  tick: (now?: number, meta?: { presentedFrames: number }) => void;
  process: () => void;
  sampleLuma: () => number | null;
};

export function makeHarness(cost: Cost = { pose: 9, vid: 5, img: 7, full: 8 }, downgradeBelowFps = 0) {
  let clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const video = {
    muted: false, playsInline: false, autoplay: false, srcObject: null, paused: false,
    readyState: 4, currentTime: 0, videoWidth: W, videoHeight: H,
    requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {},
  };
  const tr = new Tracker({ modelBaseUrl: '/models', poseModel: 'full', video: video as unknown as HTMLVideoElement, downgradeBelowFps });
  const T = tr as unknown as Priv;
  let script: Script = { pose: { left: { x: 0.62, y: 0.6 }, right: { x: 0.38, y: 0.6 } }, vid: {} };
  /** Calls in order: 'pose', 'vid:left', 'img:right', 'full', … */
  const calls: string[] = [];
  const result = (h: FakeHand | null | undefined, rect: CropRect | null) => {
    if (!h || !rect) return { landmarks: [], worldLandmarks: [], handedness: [], handednesses: [] };
    const lm = handLandmarks(h).map((l) => ({ x: (l.x * W - rect.x0) / rect.size, y: (l.y * H - rect.y0) / rect.size, z: 0 }));
    const cat = [{ categoryName: h.label, displayName: h.label, score: 0.95, index: 0 }];
    return { landmarks: [lm], worldLandmarks: [lm], handedness: [cat], handednesses: [cat] };
  };
  const canvases: Record<Hand, { side: Hand }> = { left: { side: 'left' }, right: { side: 'right' } };
  /** ctx.filter at each crop drawImage (dark-room brightening). */
  const filters: string[] = [];
  const ctx = { fillStyle: '', filter: 'none', fillRect: () => {}, drawImage: () => void filters.push(ctx.filter) };
  T.pose = {
    detectForVideo: () => {
      calls.push('pose');
      clock += cost.pose;
      const lm = poseLandmarks(script.pose);
      return { landmarks: [lm], worldLandmarks: [lm.map((l) => ({ ...l }))] };
    },
    close: () => {},
  };
  const vidModel = (side: Hand) => ({
    detectForVideo: (cv: { side: Hand }) => {
      calls.push(`vid:${cv.side}`);
      clock += cost.vid;
      return result(script.vid[side], T.roi[side].rect);
    },
    close: () => {},
  });
  T.handVid = { left: vidModel('left'), right: vidModel('right') };
  T.handImg = {
    detect: (cv: { side: Hand }) => {
      calls.push(`img:${cv.side}`);
      clock += cost.img;
      return result(script.img?.[cv.side], T.roi[cv.side].rect);
    },
    close: () => {},
  };
  T.hands = {
    detectForVideo: () => {
      calls.push('full');
      clock += cost.full;
      const hs = script.full ?? [];
      const cat = (h: FakeHand) => [{ categoryName: h.label, displayName: h.label, score: 0.9, index: 0 }];
      return { landmarks: hs.map(handLandmarks), worldLandmarks: hs.map(handLandmarks), handedness: hs.map(cat), handednesses: hs.map(cat) };
    },
    close: () => {},
  };
  T.crop = { left: { cv: canvases.left, ctx }, right: { cv: canvases.right, ctx } };
  T.running = true;
  T.startedAt = T.fpsWindowStart = clock; // as start() does
  tr.stats.width = W;
  tr.stats.height = H;
  T.settingsFps = 30;
  T.sampleLuma = () => 0.45;
  const frames: RawFrame[] = [];
  tr.onFrame = (f) => frames.push(f);
  let presented = 0;
  let frameAt = clock;

  return {
    tr,
    T,
    video,
    calls,
    frames,
    filters,
    get clock() {
      return clock;
    },
    setScript(s: Partial<Script>) {
      script = { ...script, ...s };
    },
    /**
     * One camera frame, `dtMs` after the previous one (delivered: every camera frame, `skipped` of which the
     * tracker did not get to, as rVFC's presentedFrames says).
     */
    frame(dtMs = 1000 / 30, skipped = 0) {
      // frames arrive on the camera's beat (unless processing ran past it)
      frameAt += dtMs;
      clock = Math.max(clock, frameAt);
      video.currentTime += dtMs / 1000;
      presented += 1 + skipped;
      calls.length = 0;
      T.tick(clock, { presentedFrames: presented });
      return frames[frames.length - 1] as RawFrame;
    },
  };
}
