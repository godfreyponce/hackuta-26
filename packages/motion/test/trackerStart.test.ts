// Tracker start()/stop() with MediaPipe, the camera and fetch faked: one hand-model download (review #8) and
// stop() during start() leaking nothing (review #9).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mp = vi.hoisted(() => {
  interface Made { kind: 'pose' | 'hand'; opts: { baseOptions?: { modelAssetPath?: string; modelAssetBuffer?: unknown }; runningMode?: string; numHands?: number }; closed: number }
  const state = {
    made: [] as Made[],
    /** Every createFromOptions waits for this. */
    gate: Promise.resolve() as Promise<void>,
    failGpu: false,
  };
  const create = (kind: Made['kind']) => async (_fs: unknown, opts: Made['opts'] & { baseOptions?: { delegate?: string } }) => {
    await state.gate;
    if (state.failGpu && opts.baseOptions?.delegate === 'GPU') throw new Error('no GPU');
    const m: Made = { kind, opts, closed: 0 };
    state.made.push(m);
    const empty = { landmarks: [], worldLandmarks: [], handedness: [], handednesses: [] };
    return { close: () => void m.closed++, detectForVideo: () => empty, detect: () => empty };
  };
  return { state, create };
});

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  PoseLandmarker: { createFromOptions: mp.create('pose') },
  HandLandmarker: { createFromOptions: mp.create('hand') },
}));

import { Tracker } from '../src/tracker';

const tracks: { stopped: number }[] = [];
let fetches: string[] = [];
let getUserMedia: () => Promise<unknown>;

function fakeVideo() {
  return {
    muted: false, playsInline: false, autoplay: false, srcObject: null as unknown, paused: false, readyState: 0,
    currentTime: 0, videoWidth: 1280, videoHeight: 720,
    play: vi.fn(async () => {}),
    requestVideoFrameCallback: vi.fn(() => 1),
    cancelVideoFrameCallback: vi.fn(),
  };
}

const newTracker = (video = fakeVideo()) => ({
  video,
  tr: new Tracker({ modelBaseUrl: '/models', poseModel: 'full', video: video as unknown as HTMLVideoElement, downgradeBelowFps: 40 }),
});

/** Lets every pending promise chain run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  mp.state.made = [];
  mp.state.gate = Promise.resolve();
  mp.state.failGpu = false;
  tracks.length = 0;
  fetches = [];
  getUserMedia = async () => {
    const t = { stopped: 0, stop() { this.stopped++; }, getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }), applyConstraints: async () => {} };
    tracks.push(t);
    return { getTracks: () => [t], getVideoTracks: () => [t] };
  };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => getUserMedia() } });
  vi.stubGlobal('fetch', async (url: string) => {
    fetches.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) };
  });
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return { fillStyle: '', fillRect() {}, drawImage() {}, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(120) }) };
    }
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Tracker.start: one hand-model download (review #8)', () => {
  it('fetches hand_landmarker.task once and builds all four hand instances from those bytes', async () => {
    const { tr } = newTracker();
    await tr.start();
    expect(fetches.filter((u) => u.includes('hand_landmarker.task'))).toEqual(['/models/hand_landmarker.task']);
    const hands = mp.state.made.filter((m) => m.kind === 'hand');
    expect(hands.length).toBe(4); // full frame + left / right VIDEO crops + IMAGE retry
    for (const h of hands) {
      expect(h.opts.baseOptions?.modelAssetPath).toBeUndefined();
      expect(h.opts.baseOptions?.modelAssetBuffer).toBeInstanceOf(Uint8Array);
    }
    expect(hands.map((h) => `${h.opts.runningMode}/${h.opts.numHands}`).sort()).toEqual(['IMAGE/1', 'VIDEO/1', 'VIDEO/1', 'VIDEO/2']);
    tr.stop();
    expect(mp.state.made.every((m) => m.closed === 1)).toBe(true);
    // a restart reuses the bytes
    await tr.start();
    expect(fetches.filter((u) => u.includes('hand_landmarker.task')).length).toBe(1);
    tr.stop();
  });

  it('GPU failure → CPU rebuild: still one download, and the GPU attempt leaves nothing open', async () => {
    mp.state.failGpu = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tr } = newTracker();
    await tr.start();
    expect(tr.stats.delegate).toBe('CPU');
    expect(fetches.length).toBe(1);
    tr.stop();
    expect(mp.state.made.every((m) => m.closed === 1)).toBe(true);
  });
});

describe('Tracker.stop during start (review #9)', () => {
  it('closes every model and the camera that the overtaken start() built, and does not start running', async () => {
    let open!: () => void;
    mp.state.gate = new Promise((r) => (open = r));
    const { tr, video } = newTracker();
    const p = tr.start();
    await flush();
    tr.stop();
    open();
    await p;
    await flush();
    expect(mp.state.made.length).toBeGreaterThan(0);
    expect(mp.state.made.every((m) => m.closed === 1)).toBe(true);
    expect(tracks.every((t) => t.stopped >= 1)).toBe(true);
    expect(video.requestVideoFrameCallback).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(tr.stats.error).toBeNull();
  });

  it('start → stop → start: the second run keeps its own models, the first one leaks none', async () => {
    let open!: () => void;
    mp.state.gate = new Promise((r) => (open = r));
    const { tr, video } = newTracker();
    const p1 = tr.start();
    await flush();
    tr.stop();
    const p2 = tr.start();
    open();
    await Promise.all([p1, p2]);
    await flush();
    const open2 = mp.state.made.filter((m) => m.closed === 0);
    expect(open2.length).toBe(5); // pose + 4 hand instances of the live run
    // the overtaken start built some (it stops at its next step) and closed all of them
    expect(mp.state.made.length).toBeGreaterThan(5);
    expect(mp.state.made.filter((m) => m.closed === 1).length).toBe(mp.state.made.length - 5);
    expect(tracks.filter((t) => t.stopped === 0).length).toBe(1);
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
    tr.stop();
    expect(mp.state.made.every((m) => m.closed === 1)).toBe(true);
  });

  it('a second start() while one is in flight returns the same promise (one camera, one model set)', async () => {
    const { tr } = newTracker();
    const a = tr.start();
    const b = tr.start();
    expect(b).toBe(a);
    await a;
    expect(tracks.length).toBe(1);
    expect(mp.state.made.length).toBe(5);
    tr.stop();
  });

  it('camera permission denied: start() rejects at once, and the models that finish later are closed', async () => {
    let open!: () => void;
    mp.state.gate = new Promise((r) => (open = r));
    getUserMedia = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
    const { tr } = newTracker();
    await expect(tr.start()).rejects.toThrow('Camera permission denied.');
    expect(tr.stats.error).toBe('Camera permission denied.');
    open();
    await flush();
    expect(mp.state.made.every((m) => m.closed === 1)).toBe(true);
  });
});
