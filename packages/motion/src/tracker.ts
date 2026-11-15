// Webcam + MediaPipe Pose/Hand landmarkers. Produces RawFrames; knows nothing about the game.
//
// Hands: the full-frame palm detector letterboxes 1280×720 into 192×192 and loses a hand smaller than
// ~60-90 px (a fist at 2 m is ~50 px). So, when there is a pose, each hand is found in its own 256×256 crop
// placed from the pose wrist (handRoi.ts), by one VIDEO-mode HandLandmarker per side (numHands 1). Both sides'
// VIDEO crops run first; then, while the frame budget lasts, a same-frame IMAGE-mode retry for each side that
// missed (taking turns at going first). The full-frame instance stays as the fallback when there is no pose, and
// re-seeds a side whose pose wrist is gone or whose crop has been off the frame for a while.
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Hand } from '@ithaca/shared';
import { config } from './config';
import {
  clipBlit,
  CROP_PX,
  cropTarget,
  cropToFull,
  type CropRect,
  duplicateSide,
  handBox,
  palmPx,
  POSE_HAND,
  roiFromHand,
  roiFromPose,
  sticky,
} from './handRoi';
import { HANDS } from './mapping';
import { clamp } from './math';
import type { RawFrame, RawHand, RawLandmark, TrackerStats } from './types';

export interface TrackerOptions {
  modelBaseUrl: string;
  poseModel: 'full' | 'lite';
  /** Use this element instead of creating a hidden one. */
  video?: HTMLVideoElement;
  deviceId?: string;
  /**
   * Perf fallback when detection can't keep up (ms/frame > 0.8 × the camera frame interval for 3 seconds)
   * and fps < this. With hand crops: left and right crops run on alternate frames. Without: 960×540 + hands
   * every other frame. 0 disables.
   */
  downgradeBelowFps: number;
}

type Delegate = 'GPU' | 'CPU';
type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
type CropCanvas = OffscreenCanvas | HTMLCanvasElement;
type Crop2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Label = 'Left' | 'Right';

/** One set of model instances, built for one start() (or one GPU → CPU rebuild). */
interface Models {
  delegate: Delegate;
  pose: PoseLandmarker;
  hands: HandLandmarker;
  handVid: Record<Hand, HandLandmarker | null>;
  handImg: HandLandmarker | null;
}

/** A start() (or rebuild) overtaken by stop() or a newer start(): it closes what it built and reports nothing. */
class Superseded extends Error {
  constructor() {
    super('superseded');
  }
}

/** Per-side crop state. */
interface RoiState {
  /** Crop used this frame (null = not run). */
  rect: CropRect | null;
  /** Last hand this side found, full-frame coords, and when (tracker ts). */
  last: RawHand | null;
  lastT: number;
  /** The hand model's own handedness label for that hand (the alternate-mode duplicate guard reads it). */
  label: Label | null;
  /** Palm-centre velocity, source px per ms. */
  vx: number;
  vy: number;
  /** Area to black out of this crop until maskUntil (the other hand, after both crops locked onto it). */
  mask: CropRect | null;
  maskUntil: number;
  /** Hit-rate window counters (pose wrist visible ≥ 0.5). */
  tries: number;
  hits: number;
  /** IMAGE retries in a row that found nothing (hand really not there, e.g. out of frame) … */
  failedRetries: number;
  /** … then this many missed frames pass before the next retry. */
  retryWait: number;
  /** Since when (ts) this side's crop has been skipped as lying off the frame, or -1. */
  offFrameSince: number;
}

const newRoi = (): RoiState => ({
  rect: null, last: null, lastT: -1e9, label: null, vx: 0, vy: 0, mask: null, maskUntil: 0, tries: 0, hits: 0,
  failedRetries: 0, retryWait: 0, offFrameSince: -1,
});

/** Last-hand fallback ROI is trusted this long (ms). */
const LAST_HAND_MS = 250;
/** This side's own hand this recent (ms) also sizes its crop (coverRoi: a hand reaching toward the camera). */
const HAND_COVER_MS = 120;
/** A side with no result this long and no pose wrist is re-seeded from the full frame … */
const RESEED_AFTER_MS = 500;
/** … every this many frames. */
const RESEED_EVERY = 8;
/** A side whose crop has been skipped as off-frame this long (ms) may be re-seeded too: it can poke in at the edge. */
const OFF_FRAME_RESEED_MS = 500;
/** After both crops locked onto one hand, the dropped side's crop masks that hand this long (ms). */
const MASK_MS = 150;
/** Alternate L/R crops: the other side's last result counts for the duplicate guard while this recent (ms). */
const ALT_DUP_MS = 150;
/** Cost of one IMAGE retry (ms) assumed before one has been timed. */
const RETRY_MS_GUESS = 7;
/** The camera's auto-exposure settles in the first seconds: no lighting verdict before this (ms after start). */
const LIGHT_WARMUP_MS = 3000;

const ema = (prev: number | undefined, x: number): number => (prev ? prev * 0.9 + x * 0.1 : x);

export class Tracker {
  readonly video: HTMLVideoElement;
  onFrame: (f: RawFrame) => void = () => {};
  readonly stats: TrackerStats = {
    fps: 0, msPerFrame: 0, delegate: 'none', width: 0, height: 0, handsEveryOtherFrame: false, error: null,
    msPose: 0, msHands: 0, roiRetries: 0, handHitRate: { left: 0, right: 0 }, handRoi: false, handsAlternate: false,
    roiRetrySkips: 0, cameraFps: 0, hint: null,
  };

  private stream: MediaStream | null = null;
  private fileset: Fileset | null = null;
  private pose: PoseLandmarker | null = null;
  /** Full-frame hand model: fallback without a pose, and re-seeding. */
  private hands: HandLandmarker | null = null;
  /** One VIDEO-mode hand model per side, fed that side's crop. */
  private handVid: Record<Hand, HandLandmarker | null> = { left: null, right: null };
  /** Stateless (IMAGE-mode) hand model for the same-frame retry after a crop misses. */
  private handImg: HandLandmarker | null = null;
  /** hand_landmarker.task, downloaded once for all four hand instances (in flight or done). */
  private handModel: Promise<Uint8Array> | null = null;
  private crop: Record<Hand, { cv: CropCanvas; ctx: Crop2D } | null> = { left: null, right: null };
  private readonly roi: Record<Hand, RoiState> = { left: newRoi(), right: newRoi() };
  /** Bumped by stop() and every start(): async work from an older generation must not touch this run. */
  private gen = 0;
  private starting: Promise<void> | null = null;
  private retriesInWindow = 0;
  private retrySkipsInWindow = 0;
  /** One IMAGE retry's cost, ms, smoothed (0 = not timed yet), and how many retries ran so far. */
  private msRetry = 0;
  private retriesTimed = 0;
  /** Time spent in IMAGE retries this frame, and ms/frame without them, smoothed: the work that must fit. */
  private retryMsThisFrame = 0;
  private msCore = 0;
  private running = false;
  private loopHandle = 0;
  private usingRvfc = false;
  private lastTs = 0;
  private lastVideoTime = -1;
  private frameNo = 0;
  private watchdog = 0;
  private lastTickAt = 0;
  private fpsCount = 0;
  private fpsWindowStart = 0;
  /** rVFC presentedFrames now / at the start of the fps window (-1 = not reported): frames the camera delivered. */
  private presented = -1;
  private presentedAtWindow = -1;
  /** The camera track's configured frame rate (getSettings), 0 = unknown. */
  private settingsFps = 0;
  /** Camera frame period (ms) measured while detection kept up; 0 = not yet. */
  private camPeriod = 0;
  private slowWindows = 0;
  private lowLightWindows = 0;
  private okLightWindows = 0;
  /** Tiny CPU canvas for the brightness sample (undefined = not made yet, null = unavailable). */
  private lumaCtx: Crop2D | null | undefined = undefined;
  private startedAt = 0;
  private detectErrors = 0;
  private lastHands: RawHand[] = [];

  constructor(private readonly opts: TrackerOptions) {
    this.video = opts.video ?? document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  /**
   * Opens the camera and loads the models (in parallel). A second call while one is in flight returns the same
   * promise. stop() during start() wins: the start resolves without running, and closes what it had built.
   */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    const gen = ++this.gen;
    const p: Promise<void> = this.doStart(gen).finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  private async doStart(gen: number): Promise<void> {
    this.stats.error = null;
    const modelsP = this.loadModels(gen);
    // whoever ends up not using the models closes them (camera failed, or stop() came first)
    const discardModels = () => void modelsP.then(closeModels, () => {});
    let stream: MediaStream;
    try {
      stream = await this.openCamera();
    } catch (err) {
      discardModels();
      if (gen !== this.gen) return;
      return this.failStart(err); // fail fast (permission denied …); the model load sees a stale generation
    }
    if (gen !== this.gen) {
      stopStream(stream);
      discardModels();
      return;
    }
    let models: Models;
    try {
      models = await modelsP;
    } catch (err) {
      stopStream(stream);
      if (gen !== this.gen || err instanceof Superseded) return;
      return this.failStart(err);
    }
    if (gen !== this.gen) {
      stopStream(stream);
      closeModels(models);
      return;
    }
    // from here stop() releases them
    this.adopt(models);
    this.stream = stream;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch (err) {
      if (gen !== this.gen) return;
      return this.failStart(err);
    }
    if (gen !== this.gen) return;
    this.updateResolution();
    this.running = true;
    this.startedAt = this.fpsWindowStart = this.lastTickAt = performance.now();
    this.schedule();
    // Keep-alive, independent of the video's frame callbacks: the browser PAUSES a <video> that is removed from or
    // moved around the page (e.g. a calibration screen that showed it and handed it back), and a paused video sends
    // no frame callbacks — the loop would stop and the player freeze on his last pose. Resume it and re-arm the loop.
    globalThis.clearInterval(this.watchdog);
    this.watchdog = globalThis.setInterval(() => this.keepAlive(), 500) as unknown as number;
  }

  private failStart(err: unknown): never {
    const msg = describeError(err);
    this.stop();
    this.stats.error = msg;
    throw new Error(msg);
  }

  private keepAlive(): void {
    if (!this.running) return;
    const v = this.video;
    if (v.paused && v.srcObject) void v.play().catch(() => {});
    if (!v.paused && performance.now() - this.lastTickAt > 1000) {
      if (this.usingRvfc) this.video.cancelVideoFrameCallback(this.loopHandle);
      else cancelAnimationFrame(this.loopHandle);
      this.lastTickAt = performance.now();
      this.schedule();
    }
  }

  stop(): void {
    this.gen++;
    this.starting = null;
    this.running = false;
    globalThis.clearInterval(this.watchdog);
    if (this.usingRvfc) this.video.cancelVideoFrameCallback(this.loopHandle);
    else cancelAnimationFrame(this.loopHandle);
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.closeLandmarkers();
    this.stats.delegate = 'none';
    this.stats.fps = 0;
    this.stats.cameraFps = 0;
    this.stats.hint = null;
    // A perf downgrade belongs to one run: a restart (other camera, lighter load) starts at full quality.
    this.stats.handsEveryOtherFrame = false;
    this.stats.handsAlternate = false;
    this.slowWindows = 0;
    this.lowLightWindows = this.okLightWindows = 0;
    this.lastVideoTime = -1;
    this.presented = this.presentedAtWindow = -1;
    this.camPeriod = this.msCore = 0;
    for (const h of HANDS) Object.assign(this.roi[h], newRoi());
  }

  get aspect(): number {
    const w = this.video.videoWidth || this.stats.width;
    const h = this.video.videoHeight || this.stats.height;
    return w && h ? w / h : 16 / 9;
  }

  /** Last hand results, including on frames where the hand model was skipped (for overlays). */
  getLastHands(): RawHand[] {
    return this.lastHands;
  }

  /** The hand crops used on the last frame, in source-video px (null = that side was not cropped). */
  getDebugRois(): Record<Hand, CropRect | null> {
    return { left: this.roi.left.rect, right: this.roi.right.rect };
  }

  private async openCamera(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera API unavailable (page must be served from localhost or https).');
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
        ...(this.opts.deviceId ? { deviceId: { exact: this.opts.deviceId } } : { facingMode: 'user' }),
      },
    });
  }

  /** The hand model bytes, fetched once (a failed fetch is retried by the next call). */
  private handModelBytes(base: string): Promise<Uint8Array> {
    this.handModel ??= (async () => {
      const res = await fetch(`${base}/hand_landmarker.task`);
      if (!res.ok) throw new Error(`hand model ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    })();
    const p = this.handModel;
    p.catch(() => {
      if (this.handModel === p) this.handModel = null;
    });
    return p;
  }

  /**
   * Builds one set of models. Throws Superseded (after closing everything it made) as soon as the generation it
   * was started for is no longer current.
   */
  private async createLandmarkers(delegate: Delegate, gen: number): Promise<Models> {
    const base = this.opts.modelBaseUrl.replace(/\/$/, '');
    const live = () => {
      if (gen !== this.gen) throw new Superseded();
    };
    const made: { close(): void }[] = [];
    try {
      this.fileset ??= await FilesetResolver.forVisionTasks(`${base}/wasm`);
      live();
      const fileset = this.fileset;
      const bytes = this.handModelBytes(base);
      const mkHands = (buf: Uint8Array, runningMode: 'VIDEO' | 'IMAGE', numHands: number) =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: buf, delegate },
          runningMode,
          numHands,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      // pose and the full-frame hands in parallel (two at a time is safe), both kept even if the other fails so
      // that nothing created leaks
      const [poseR, handsR] = await Promise.allSettled([
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}/pose_landmarker_${this.opts.poseModel}.task`, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
        bytes.then((buf) => mkHands(buf, 'VIDEO', 2)),
      ]);
      if (poseR.status === 'fulfilled') made.push(poseR.value);
      if (handsR.status === 'fulfilled') made.push(handsR.value);
      if (poseR.status === 'rejected') throw poseR.reason;
      if (handsR.status === 'rejected') throw handsR.reason;
      live();
      const m: Models = { delegate, pose: poseR.value, hands: handsR.value, handVid: { left: null, right: null }, handImg: null };
      if (config.handRoi > 0) {
        // The same bytes for the three crop instances. Created one at a time: more than two in parallel can fail
        // with "ModuleFactory not set" (each instance loads its own wasm module).
        const crops: HandLandmarker[] = [];
        try {
          const buf = await bytes;
          for (let i = 0; i < 3; i++) {
            live();
            const x = await mkHands(buf, i < 2 ? 'VIDEO' : 'IMAGE', 1);
            crops.push(x);
            made.push(x);
          }
          live();
          for (const h of HANDS) this.crop[h] ??= makeCropCanvas();
          m.handVid = { left: crops[0] ?? null, right: crops[1] ?? null };
          m.handImg = crops[2] ?? null;
        } catch (err) {
          if (err instanceof Superseded) throw err;
          // the crops are an upgrade: losing them must not drag pose onto the CPU — stay on full-frame hands
          console.warn('[motion] hand crops unavailable, using full-frame hand detection', err);
          for (const x of crops) {
            x.close();
            made.splice(made.indexOf(x), 1);
          }
        }
      }
      return m;
    } catch (err) {
      for (const x of made) x.close();
      throw err;
    }
  }

  /** C.1: GPU is required for 60 fps; fall back to CPU (reported as degraded) if it fails. */
  private async loadModels(gen: number): Promise<Models> {
    try {
      return await this.createLandmarkers('GPU', gen);
    } catch (err) {
      if (err instanceof Superseded || gen !== this.gen) throw err instanceof Superseded ? err : new Superseded();
      console.warn('[motion] GPU delegate failed, falling back to CPU', err);
      return this.createLandmarkers('CPU', gen);
    }
  }

  private adopt(m: Models): void {
    this.pose = m.pose;
    this.hands = m.hands;
    this.handVid = { ...m.handVid };
    this.handImg = m.handImg;
    this.stats.delegate = m.delegate;
  }

  private closeLandmarkers(): void {
    this.pose?.close();
    this.hands?.close();
    this.handVid.left?.close();
    this.handVid.right?.close();
    this.handImg?.close();
    this.pose = this.hands = this.handImg = null;
    this.handVid = { left: null, right: null };
  }

  private schedule(): void {
    if (!this.running) return;
    this.usingRvfc = typeof this.video.requestVideoFrameCallback === 'function';
    this.loopHandle = this.usingRvfc
      ? this.video.requestVideoFrameCallback(this.tick)
      : requestAnimationFrame(this.tick);
  }

  private readonly tick = (_now?: number, meta?: VideoFrameCallbackMetadata): void => {
    if (!this.running) return;
    this.lastTickAt = performance.now();
    // counts every frame the camera delivered, including those that arrived while we were still busy
    if (meta && typeof meta.presentedFrames === 'number') this.presented = meta.presentedFrames;
    try {
      this.process();
    } catch (err) {
      this.handleDetectError(err);
    }
    this.schedule();
  };

  private process(): void {
    const v = this.video;
    // the browser pauses a <video> that is removed from (or moved around) the page — e.g. a calibration screen
    // that showed it and handed it back. A paused camera means no new frames and a frozen player: resume it.
    if (!this.pose || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;

    const now = performance.now();
    const ts = Math.max(Math.round(now), this.lastTs + 1); // MediaPipe needs strictly increasing ms
    this.lastTs = ts;
    this.frameNo++;

    const t0 = performance.now();
    this.retryMsThisFrame = 0;
    const poseRes = this.pose.detectForVideo(v, ts);
    const tPose = performance.now();
    const pose = poseRes.landmarks[0] ?? null;
    const W = v.videoWidth, H = v.videoHeight;
    let hands: RawHand[] | null = null;
    let skippedHands: Hand[] | undefined;
    const useRoi = config.handRoi > 0 && !!pose && W > 0 && H > 0 && this.cropsReady();
    this.stats.handRoi = useRoi;
    if (useRoi && pose) {
      // Alternate mode (processing-bound): one side per frame, pose stays at the camera rate.
      const only: Hand | null = this.stats.handsAlternate ? (this.frameNo % 2 === 0 ? 'left' : 'right') : null;
      const res = this.handsFromPose(v, pose, ts, t0, W, H, only);
      hands = res.hands;
      // the side that did not run keeps its last result — unless that turned out to be this side's hand
      if (only && !res.dropOther) skippedHands = [only === 'left' ? 'right' : 'left'];
    } else {
      for (const h of HANDS) this.roi[h].rect = null;
      const halfRate = this.stats.handsEveryOtherFrame || this.stats.handsAlternate;
      if (this.hands && (!halfRate || this.frameNo % 2 === 0)) {
        hands = toRawHands(this.hands.detectForVideo(v, ts));
        this.countFullFrameHits(hands, pose, W, H);
      }
    }
    if (hands) this.lastHands = hands;
    const t1 = performance.now();
    // Skip warm-up frames (shader compilation) so the C.8 budget readout is honest.
    if (this.frameNo > 5) {
      this.stats.msPerFrame = ema(this.stats.msPerFrame, t1 - t0);
      this.msCore = ema(this.msCore, t1 - t0 - this.retryMsThisFrame);
      this.stats.msPose = ema(this.stats.msPose, tPose - t0);
      if (hands) this.stats.msHands = ema(this.stats.msHands, t1 - tPose);
    }
    this.detectErrors = 0;

    this.onFrame({
      t: now,
      poseImage: pose,
      poseWorld: poseRes.worldLandmarks[0] ?? null,
      hands,
      ...(skippedHands ? { skippedHands } : {}),
    });
    this.measureFps(now);
  }

  private cropsReady(): boolean {
    return !!(this.handVid.left && this.handVid.right && this.crop.left && this.crop.right);
  }

  /**
   * Hands from the two pose-guided crops (or just `only`). Every returned hand carries its `side`.
   * `dropOther` (alternate mode): the side that did not run this frame was holding this side's hand — its last
   * result must not be carried over.
   */
  private handsFromPose(
    v: HTMLVideoElement,
    pose: RawLandmark[],
    ts: number,
    frameStart: number,
    W: number,
    H: number,
    only: Hand | null,
  ): { hands: RawHand[]; dropOther: boolean } {
    const found: Partial<Record<Hand, RawHand>> = {};
    const modelLabel: Record<Hand, Label> = { left: 'Left', right: 'Right' };
    const missed: Hand[] = [];
    // 1) every side's VIDEO crop first, so the retries below share what is left of the frame fairly (retrying the
    //    left before the right crop even ran left the right hand without budget: it read less than the left)
    for (const side of HANDS) {
      if (only && side !== only) continue;
      const st = this.roi[side];
      const wristVis = pose[POSE_HAND[side].wrist]?.visibility ?? 0;
      if (wristVis >= 0.5) st.tries++;
      const model = this.handVid[side];
      const crop = this.crop[side];
      if (!model || !crop) continue;
      const rect = this.placeCrop(side, pose, ts, W, H);
      if (!rect) continue;
      drawCrop(v, crop.ctx, rect, st.mask && ts < st.maskUntil ? st.mask : null, W, H, this.cropGain());
      // Same ts as the pose; each instance only needs its own timestamps to increase.
      const r = model.detectForVideo(crop.cv, ts);
      if (r.landmarks.length) this.takeHand(side, r, rect, W, H, found, modelLabel);
      else if (wristVis >= 0.5) missed.push(side);
    }
    // 2) same-frame IMAGE retries: a stateless palm search on the same crop recovers a hand the VIDEO tracker lost
    //    after a crop jump (fast swings)
    if (missed.length && config.handRoi >= 2 && this.handImg) this.retryMissed(missed, frameStart, W, H, found, modelLabel);
    // 3) both crops on one physical hand?
    let dropOther = false;
    if (found.left && found.right) {
      const drop = duplicateSide(found.left, found.right, modelLabel, pose, W, H);
      if (drop) {
        const keep = found[drop === 'left' ? 'right' : 'left'] as RawHand;
        this.roi[drop].mask = handBox(keep, W, H, 1.2);
        this.roi[drop].maskUntil = ts + MASK_MS;
        delete found[drop];
      }
    } else if (only && found[only]) {
      dropOther = this.alternateDuplicate(only, found, modelLabel, pose, ts, W, H);
    }
    this.reseed(v, pose, ts, W, H, found, only);
    const out: RawHand[] = [];
    for (const side of HANDS) {
      const h = found[side];
      if (!h) continue;
      this.noteHand(side, h, ts, W, H);
      if ((pose[POSE_HAND[side].wrist]?.visibility ?? 0) >= 0.5) this.roi[side].hits++;
      out.push(h);
    }
    return { hands: out, dropOther };
  }

  /**
   * Brightening for the hand crops in a dark room: the hand model loses a fist in a dim image long before the pose
   * model loses the body (bench: a 20 px fist at 13% luma is never found). Lifts the frame's mean luma toward
   * 0.4, at most cropBoostMax ×; 1 when the image is bright enough (≥ cropBoostBelowLuma) or the boost is off.
   */
  private cropGain(): number {
    const b = this.stats.brightness;
    if (b === undefined || !(config.cropBoostMax > 1) || b >= config.cropBoostBelowLuma) return 1;
    return clamp(0.4 / Math.max(b, 0.02), 1, config.cropBoostMax);
  }

  /** This frame's crop for one side (also kept in roi[side].rect), or null when none is worth running. */
  private placeCrop(side: Hand, pose: RawLandmark[], ts: number, W: number, H: number): CropRect | null {
    const st = this.roi[side];
    const age = ts - st.lastT;
    const fromHand = st.last && age < LAST_HAND_MS ? roiFromHand(st.last, W, H, st.vx, st.vy, age) : null;
    const { rect, offFrame } = cropTarget(roiFromPose(pose, side, W, H), fromHand, age <= HAND_COVER_MS, W, H);
    if (!offFrame) st.offFrameSince = -1;
    else if (st.offFrameSince < 0) st.offFrameSince = ts;
    if (!rect) {
      st.rect = null;
      return null;
    }
    return (st.rect = sticky(st.rect, rect));
  }

  /**
   * IMAGE retries for the sides whose VIDEO crop missed, while pose + crops + one more retry fit in
   * handRoiRetryShare of the camera's frame interval. With both missing they take turns at going first.
   */
  private retryMissed(
    missed: Hand[],
    frameStart: number,
    W: number,
    H: number,
    found: Partial<Record<Hand, RawHand>>,
    modelLabel: Record<Hand, Label>,
  ): void {
    const img = this.handImg;
    if (!img) return;
    if (missed.length > 1 && this.frameNo % 2 === 1) missed.reverse();
    const budget = config.handRoiRetryShare * this.frameIntervalMs();
    for (const side of missed) {
      const st = this.roi[side];
      const crop = this.crop[side];
      const rect = st.rect;
      if (!crop || !rect) continue;
      // After 2 empty retries in a row (no hand there at all, e.g. out of frame) only every 4th miss, to save
      // ~7 ms a frame.
      if (st.retryWait > 0) {
        st.retryWait--;
        continue;
      }
      const t = performance.now();
      if (t - frameStart + (this.msRetry || RETRY_MS_GUESS) > budget) {
        this.retrySkipsInWindow++;
        // an estimate inflated by a slow moment drifts back, so retries get re-tried (and re-timed)
        if (this.msRetry > RETRY_MS_GUESS) this.msRetry += (RETRY_MS_GUESS - this.msRetry) * 0.02;
        continue;
      }
      const r = img.detect(crop.cv);
      const took = performance.now() - t;
      this.retryMsThisFrame += took;
      // the first calls compile shaders (tens of ms): not a cost estimate; later spikes are clipped
      if (++this.retriesTimed > 2) this.msRetry = ema(this.msRetry, Math.min(took, 2 * RETRY_MS_GUESS));
      this.retriesInWindow++;
      if (r.landmarks.length) this.takeHand(side, r, rect, W, H, found, modelLabel);
      else if (++st.failedRetries >= 2) st.retryWait = 3;
    }
  }

  private takeHand(
    side: Hand,
    r: HandLandmarkerResult,
    rect: CropRect,
    W: number,
    H: number,
    found: Partial<Record<Hand, RawHand>>,
    modelLabel: Record<Hand, Label>,
  ): void {
    const lm = r.landmarks[0];
    if (!lm) return;
    const st = this.roi[side];
    st.failedRetries = st.retryWait = 0;
    const cat = r.handedness[0]?.[0];
    modelLabel[side] = st.label = cat?.categoryName === 'Left' ? 'Left' : 'Right';
    found[side] = {
      image: cropToFull(lm, rect, W, H),
      world: r.worldLandmarks[0] ?? null,
      // On un-mirrored frames MediaPipe's label names the player's own hand; the crop's side is the truth.
      label: side === 'left' ? 'Left' : 'Right',
      score: cat?.score ?? 0,
      side,
    };
  }

  /**
   * Alternate L/R crops run one side per frame, so the both-found duplicate check never fires: compare this side's
   * hand with the other side's last one (moved on by its velocity). Returns true when the other side's last result
   * was this very hand (it is forgotten, and that crop masks this hand for a moment); a duplicate found by THIS
   * side is dropped here and its crop masks the other hand.
   */
  private alternateDuplicate(
    side: Hand,
    found: Partial<Record<Hand, RawHand>>,
    modelLabel: Record<Hand, Label>,
    pose: RawLandmark[],
    ts: number,
    W: number,
    H: number,
  ): boolean {
    const other: Hand = side === 'left' ? 'right' : 'left';
    const os = this.roi[other];
    const mine = found[side];
    if (!mine || !os.last || ts - os.lastT > ALT_DUP_MS) return false;
    const age = ts - os.lastT;
    const theirs = shiftHand(os.last, (os.vx * age) / W, (os.vy * age) / H);
    const labels: Record<Hand, Label> = { ...modelLabel, [other]: os.label ?? (other === 'left' ? 'Left' : 'Right') };
    const drop = side === 'left' ? duplicateSide(mine, theirs, labels, pose, W, H) : duplicateSide(theirs, mine, labels, pose, W, H);
    if (!drop) return false;
    if (drop === side) {
      this.roi[side].mask = handBox(theirs, W, H, 1.2);
      this.roi[side].maskUntil = ts + MASK_MS;
      delete found[side];
      return false;
    }
    os.last = null;
    os.mask = handBox(mine, W, H, 1.2);
    os.maskUntil = ts + MASK_MS;
    return true;
  }

  /**
   * A side with no result for RESEED_AFTER_MS that has no crop to run — its pose wrist is gone
   * (< handRoiMinWristVis), or its crop has lain off the frame for OFF_FRAME_RESEED_MS (a hand at the edge the pose
   * extrapolates past it). Every RESEED_EVERY frames, look for it on the full frame; a hit seeds the last-hand ROI,
   * so the next frames crop around it.
   */
  private reseed(
    v: HTMLVideoElement,
    pose: RawLandmark[],
    ts: number,
    W: number,
    H: number,
    found: Partial<Record<Hand, RawHand>>,
    only: Hand | null = null,
  ): void {
    if (!this.hands) return;
    // Alternating crops: the left side runs on even frames only, so a multiple of RESEED_EVERY alone would never
    // re-seed the right hand — give the frame after it to the right.
    const slot = this.frameNo % RESEED_EVERY;
    if (slot !== 0 && !(only && slot === 1)) return;
    const need = HANDS.filter((s) => {
      // a side skipped this frame (alternating crops) isn't filled in: its grip didn't run
      if ((only && s !== only) || found[s]) return false;
      const st = this.roi[s];
      if (ts - st.lastT < RESEED_AFTER_MS) return false;
      const noWrist = (pose[POSE_HAND[s].wrist]?.visibility ?? 0) < config.handRoiMinWristVis;
      const offFrame = st.offFrameSince >= 0 && ts - st.offFrameSince >= OFF_FRAME_RESEED_MS;
      return noWrist || offFrame;
    });
    if (!need.length) return;
    const all = toRawHands(this.hands.detectForVideo(v, ts));
    for (const side of need) {
      const o: Hand = side === 'left' ? 'right' : 'left';
      // not the other side's hand seen again: this frame's, or (it did not run) its recent last one
      const other = found[o] ?? (this.roi[o].last && ts - this.roi[o].lastT <= LAST_HAND_MS ? this.roi[o].last : null);
      let best: RawHand | null = null;
      for (const h of all) {
        if ((h.label === 'Left' ? 'left' : 'right') !== side || (best && best.score >= h.score)) continue;
        if (other) {
          const a = palmPx(h, W, H), b = palmPx(other, W, H);
          if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5 * Math.max(a.len, b.len)) continue;
        }
        best = h;
      }
      if (best) {
        found[side] = { ...best, side };
        this.roi[side].label = best.label;
      }
    }
  }

  private noteHand(side: Hand, h: RawHand, ts: number, W: number, H: number): void {
    const st = this.roi[side];
    const c = palmPx(h, W, H);
    if (st.last && ts - st.lastT < 150 && ts > st.lastT) {
      const p = palmPx(st.last, W, H);
      st.vx = (c.x - p.x) / (ts - st.lastT);
      st.vy = (c.y - p.y) / (ts - st.lastT);
    } else {
      st.vx = st.vy = 0;
    }
    st.last = h;
    st.lastT = ts;
  }

  /** Hit-rate bookkeeping for the full-frame path: a hand counts for the side of the nearest pose wrist. */
  private countFullFrameHits(hands: RawHand[], pose: RawLandmark[] | null, W: number, H: number): void {
    if (!pose) return;
    const hit = { left: false, right: false };
    for (const h of hands) {
      const hw = h.image[0];
      if (!hw) continue;
      let bestSide: Hand = 'left', bestD = Infinity;
      for (const s of HANDS) {
        const pw = pose[POSE_HAND[s].wrist];
        const d = pw ? Math.hypot((pw.x - hw.x) * W, (pw.y - hw.y) * H) : Infinity;
        if (d < bestD) { bestD = d; bestSide = s; }
      }
      hit[bestSide] = true;
    }
    for (const s of HANDS) {
      if ((pose[POSE_HAND[s].wrist]?.visibility ?? 0) < 0.5) continue;
      this.roi[s].tries++;
      if (hit[s]) this.roi[s].hits++;
    }
  }

  /** The camera's frame rate as delivered (stats.cameraFps), else as configured, else 30. */
  private cameraRate(): number {
    return clamp(this.stats.cameraFps || this.settingsFps || 30, 5, 120);
  }

  /** The camera's frame period for the retry budget (ms). */
  private frameIntervalMs(): number {
    return this.camPeriod || 1000 / clamp(this.settingsFps || 30, 5, 120);
  }

  private measureFps(now: number): void {
    this.fpsCount++;
    const span = now - this.fpsWindowStart;
    if (span < 1000) return;
    this.stats.fps = (this.fpsCount * 1000) / span;
    // what the camera delivered: rVFC's presentedFrames also counts the frames that came while we were busy
    const presentedDelta = this.presented >= 0 && this.presentedAtWindow >= 0 ? this.presented - this.presentedAtWindow : 0;
    let cam = (Math.max(this.fpsCount, presentedDelta) * 1000) / span;
    if (this.settingsFps) cam = Math.min(cam, this.settingsFps);
    this.stats.cameraFps = cam;
    this.presentedAtWindow = this.presented;
    // The retry budget's frame period follows the camera (a dim 20 fps camera leaves 50 ms a frame) — but only
    // while detection keeps up: when it doesn't, fewer frames get through than the camera sends (and a browser
    // that doesn't report presentedFrames can't tell), and a budget grown from that would slow it further.
    if (cam > 0 && !this.processingBound(cam)) this.camPeriod = 1000 / clamp(cam, 5, 120);
    this.fpsCount = 0;
    this.fpsWindowStart = now;
    const rate = this.stats.handHitRate ?? (this.stats.handHitRate = { left: 0, right: 0 });
    for (const h of HANDS) {
      const st = this.roi[h];
      rate[h] = st.tries ? st.hits / st.tries : 0;
      st.tries = st.hits = 0;
    }
    this.stats.roiRetries = this.retriesInWindow;
    this.stats.roiRetrySkips = this.retrySkipsInWindow;
    this.retriesInWindow = this.retrySkipsInWindow = 0;
    // Cameras often report their real size only after the first frames.
    if (this.stats.width !== this.video.videoWidth) this.updateResolution();
    this.updateLighting(now);
    const threshold = this.opts.downgradeBelowFps;
    const degraded = this.stats.handsEveryOtherFrame || this.stats.handsAlternate;
    // the rate frames really arrive at: a camera that reports 60 but delivers 30 (dim light) mustn't halve the budget
    const camFps = this.cameraRate();
    if (this.stats.handsAlternate) {
      // recover: when both crops would fit comfortably again (pose + 2 hand crops < 60% of a frame) for 5 windows
      const full = (this.stats.msPose ?? 0) + 2 * (this.stats.msHands ?? 0);
      this.slowWindows = full < (0.6 * 1000) / camFps ? this.slowWindows + 1 : 0;
      if (this.slowWindows >= 5) { this.stats.handsAlternate = false; this.slowWindows = 0; console.info('[motion] both hand crops every frame again'); }
    } else if (threshold > 0 && !degraded && now - this.startedAt > 3000) {
      // Only when WE are the bottleneck: a Mac camera delivers 30 fps however fast detection is, and degrading
      // then costs hand rate for nothing.
      this.slowWindows = this.stats.fps < threshold && this.processingBound(camFps) ? this.slowWindows + 1 : 0;
      if (this.slowWindows >= 3) {
        if (config.handRoi > 0) {
          // Hand crops cost the same at any camera resolution, and 960×540 only shrinks the hands: alternate
          // the left and right crops instead (each hand at half rate, pose at full rate).
          this.stats.handsAlternate = true;
          console.warn(`[motion] detection ${this.stats.msPerFrame.toFixed(1)} ms/frame at ${camFps.toFixed(0)} fps: alternating L/R hand crops`);
        } else {
          void this.downgrade();
        }
      }
    }
  }

  /**
   * Detection can't keep up with the camera. Judged without the IMAGE retries: they only ever use what is left of
   * a frame (handRoiRetryShare), so counting them would make a busy-but-fine frame look like a slow machine.
   */
  private processingBound(camFps: number): boolean {
    return (this.msCore || this.stats.msPerFrame) > (0.8 * 1000) / camFps;
  }

  /**
   * stats.brightness every window; stats.hint = 'lighting' after config.lowLightWindows windows in a row with the
   * camera starved for light (delivering < lowLightFps, or mean luma < lowLightLuma), cleared after one more good
   * window than that.
   */
  private updateLighting(now: number): void {
    const luma = this.sampleLuma(this.video);
    if (luma !== null) this.stats.brightness = luma;
    if (now - this.startedAt < LIGHT_WARMUP_MS) return;
    const cam = this.stats.cameraFps ?? 0;
    // A camera that can't go faster anyway (a 15 fps model) is no lighting problem. Without presentedFrames the
    // delivered rate is only known while detection keeps up.
    const couldBeFaster = !this.settingsFps || this.settingsFps >= config.lowLightFps;
    const known = this.presented >= 0 || !this.processingBound(cam || 30);
    const slow = cam > 0 && cam < config.lowLightFps && couldBeFaster && known;
    const dark = luma !== null && luma < config.lowLightLuma;
    if (slow || dark) {
      this.lowLightWindows++;
      this.okLightWindows = 0;
    } else {
      this.okLightWindows++;
      this.lowLightWindows = 0;
    }
    const n = Math.max(1, Math.round(config.lowLightWindows));
    if (this.stats.hint !== 'lighting' && this.lowLightWindows >= n) {
      this.stats.hint = 'lighting';
      console.warn(`[motion] low light: camera ${cam.toFixed(0)} fps, brightness ${luma === null ? '?' : luma.toFixed(2)}`);
    } else if (this.stats.hint === 'lighting' && this.okLightWindows > n) {
      this.stats.hint = null;
    }
  }

  /** Mean luma (0..1) of the current video frame from a 32×18 thumbnail, or null when it can't be read. */
  private sampleLuma(v: HTMLVideoElement): number | null {
    const w = 32, h = 18;
    if (this.lumaCtx === undefined) {
      this.lumaCtx = null;
      try {
        const cv =
          typeof OffscreenCanvas === 'function'
            ? new OffscreenCanvas(w, h)
            : typeof document !== 'undefined'
              ? Object.assign(document.createElement('canvas'), { width: w, height: h })
              : null;
        // CPU-backed: read back every second
        this.lumaCtx = (cv?.getContext('2d', { willReadFrequently: true }) as Crop2D | null | undefined) ?? null;
      } catch {
        this.lumaCtx = null;
      }
    }
    const ctx = this.lumaCtx;
    if (!ctx || v.readyState < 2) return null;
    try {
      ctx.drawImage(v, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);
      return sum / ((d.length / 4) * 255);
    } catch {
      return null;
    }
  }

  /** C.8, full-frame hands only (config.handRoi 0): drop to 960×540 and run hands every other frame. */
  private async downgrade(): Promise<void> {
    this.stats.handsEveryOtherFrame = true;
    console.warn(`[motion] fps ${this.stats.fps.toFixed(0)} < ${this.opts.downgradeBelowFps}: 960×540 + hands every 2nd frame`);
    try {
      await this.stream?.getVideoTracks()[0]?.applyConstraints({ width: { ideal: 960 }, height: { ideal: 540 } });
    } catch {
      /* keep current resolution */
    }
    this.updateResolution();
  }

  private updateResolution(): void {
    const s = this.stream?.getVideoTracks()[0]?.getSettings();
    this.stats.width = this.video.videoWidth || s?.width || 0;
    this.stats.height = this.video.videoHeight || s?.height || 0;
    this.settingsFps = s?.frameRate ?? 0;
  }

  private handleDetectError(err: unknown): void {
    this.detectErrors++;
    console.error('[motion] detect failed', err);
    this.stats.error = describeError(err);
    // GPU contexts can die after init (e.g. driver reset): rebuild on CPU once.
    if (this.stats.delegate === 'GPU' && this.detectErrors >= 3) {
      this.detectErrors = 0;
      this.closeLandmarkers();
      this.stats.delegate = 'CPU';
      const gen = this.gen;
      this.createLandmarkers('CPU', gen).then(
        (m) => {
          if (gen !== this.gen) return closeModels(m);
          this.adopt(m);
          this.stats.error = null;
        },
        (e: unknown) => {
          if (!(e instanceof Superseded)) this.stats.error = `CPU fallback failed: ${describeError(e)}`;
        },
      );
    }
  }
}

/**
 * Copies the crop of the video into the side's N×N canvas (black outside the frame), blacking out `mask`.
 * `gain` > 1 brightens it (a dark room): a GPU canvas filter, no pixel readback.
 */
function drawCrop(v: HTMLVideoElement, ctx: Crop2D, rect: CropRect, mask: CropRect | null, W: number, H: number, gain = 1): void {
  const N = CROP_PX;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, N, N);
  const b = clipBlit(rect, W, H, N);
  if (b) {
    if (gain > 1.05) ctx.filter = `brightness(${gain.toFixed(2)})`;
    ctx.drawImage(v, ...b);
    if (gain > 1.05) ctx.filter = 'none';
  }
  if (mask) {
    const k = N / rect.size;
    ctx.fillRect((mask.x0 - rect.x0) * k, (mask.y0 - rect.y0) * k, mask.size * k, mask.size * k);
  }
}

/** The hand moved by (dx, dy) in normalized image units (alternate-mode duplicate guard). */
function shiftHand(h: RawHand, dx: number, dy: number): RawHand {
  if (!dx && !dy) return h;
  return { ...h, image: h.image.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })) };
}

function closeModels(m: Models): void {
  m.pose.close();
  m.hands.close();
  m.handVid.left?.close();
  m.handVid.right?.close();
  m.handImg?.close();
}

function stopStream(s: MediaStream): void {
  s.getTracks().forEach((t) => t.stop());
}

function toRawHands(h: HandLandmarkerResult): RawHand[] {
  const out: RawHand[] = [];
  for (let i = 0; i < h.landmarks.length; i++) {
    const image = h.landmarks[i];
    if (!image) continue;
    const cat = h.handedness[i]?.[0];
    out.push({
      image,
      world: h.worldLandmarks[i] ?? null,
      label: cat?.categoryName === 'Left' ? 'Left' : 'Right',
      score: cat?.score ?? 0,
    });
  }
  return out;
}

function makeCropCanvas(): { cv: CropCanvas; ctx: Crop2D } {
  // GPU-backed 2D canvas (no willReadFrequently), so the upload to the model's WebGL context stays on the GPU.
  const cv: CropCanvas =
    typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(CROP_PX, CROP_PX) : Object.assign(document.createElement('canvas'), { width: CROP_PX, height: CROP_PX });
  const ctx = cv.getContext('2d', { alpha: false }) as Crop2D | null;
  if (!ctx) throw new Error('2D canvas unavailable for hand crops.');
  return { cv, ctx };
}

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Camera permission denied.';
    if (err.name === 'NotFoundError') return 'No camera found.';
    if (err.name === 'NotReadableError') return 'Camera is in use by another app.';
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
