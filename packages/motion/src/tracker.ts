// Webcam + MediaPipe Pose/Hand landmarkers. Produces RawFrames; knows nothing about the game.
//
// Hands: the full-frame palm detector letterboxes 1280×720 into 192×192 and loses a hand smaller than
// ~60-90 px (a fist at 2 m is ~50 px). So, when there is a pose, each hand is found in its own 256×256 crop
// placed from the pose wrist (handRoi.ts), by one VIDEO-mode HandLandmarker per side (numHands 1), with a
// same-frame IMAGE-mode retry on a miss. The full-frame instance stays as the fallback when there is no pose,
// and re-seeds a side whose pose wrist is gone.
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Hand } from '@ithaca/shared';
import { config } from './config';
import {
  clipBlit,
  CROP_PX,
  cropToFull,
  type CropRect,
  duplicateSide,
  handBox,
  outsideFraction,
  palmPx,
  POSE_HAND,
  roiFromHand,
  roiFromPose,
  sticky,
} from './handRoi';
import { HANDS } from './mapping';
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

/** Per-side crop state. */
interface RoiState {
  /** Crop used this frame (null = not run). */
  rect: CropRect | null;
  /** Last hand this side found, full-frame coords, and when (tracker ts). */
  last: RawHand | null;
  lastT: number;
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
}

const newRoi = (): RoiState => ({
  rect: null, last: null, lastT: -1e9, vx: 0, vy: 0, mask: null, maskUntil: 0, tries: 0, hits: 0, failedRetries: 0, retryWait: 0,
});

/** Last-hand fallback ROI is trusted this long (ms). */
const LAST_HAND_MS = 250;
/** A side with no result this long and no pose wrist is re-seeded from the full frame … */
const RESEED_AFTER_MS = 500;
/** … every this many frames. */
const RESEED_EVERY = 8;
/** After both crops locked onto one hand, the dropped side's crop masks that hand this long (ms). */
const MASK_MS = 150;

export class Tracker {
  readonly video: HTMLVideoElement;
  onFrame: (f: RawFrame) => void = () => {};
  readonly stats: TrackerStats = {
    fps: 0, msPerFrame: 0, delegate: 'none', width: 0, height: 0, handsEveryOtherFrame: false, error: null,
    msPose: 0, msHands: 0, roiRetries: 0, handHitRate: { left: 0, right: 0 }, handRoi: false, handsAlternate: false,
  };

  private stream: MediaStream | null = null;
  private fileset: Fileset | null = null;
  private pose: PoseLandmarker | null = null;
  /** Full-frame hand model: fallback without a pose, and re-seeding. */
  private hands: HandLandmarker | null = null;
  /** One VIDEO-mode hand model per side, fed that side's crop. */
  private readonly handVid: Record<Hand, HandLandmarker | null> = { left: null, right: null };
  /** Stateless (IMAGE-mode) hand model for the same-frame retry after a crop misses. */
  private handImg: HandLandmarker | null = null;
  private handModel: Uint8Array | null = null;
  private crop: Record<Hand, { cv: CropCanvas; ctx: Crop2D } | null> = { left: null, right: null };
  private readonly roi: Record<Hand, RoiState> = { left: newRoi(), right: newRoi() };
  private retriesInWindow = 0;
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
  private slowWindows = 0;
  private startedAt = 0;
  private detectErrors = 0;
  private lastHands: RawHand[] = [];

  constructor(private readonly opts: TrackerOptions) {
    this.video = opts.video ?? document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stats.error = null;
    try {
      // Camera and model loading in parallel.
      const [stream] = await Promise.all([this.openCamera(), this.loadModels()]);
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      this.updateResolution();
    } catch (err) {
      const msg = describeError(err);
      this.stop();
      this.stats.error = msg;
      throw new Error(msg);
    }
    this.running = true;
    this.startedAt = this.fpsWindowStart = this.lastTickAt = performance.now();
    this.schedule();
    // Keep-alive, independent of the video's frame callbacks: the browser PAUSES a <video> that is removed from or
    // moved around the page (e.g. a calibration screen that showed it and handed it back), and a paused video sends
    // no frame callbacks — the loop would stop and the player freeze on his last pose. Resume it and re-arm the loop.
    globalThis.clearInterval(this.watchdog);
    this.watchdog = globalThis.setInterval(() => this.keepAlive(), 500) as unknown as number;
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
    this.running = false;
    globalThis.clearInterval(this.watchdog);
    if (this.usingRvfc) this.video.cancelVideoFrameCallback(this.loopHandle);
    else cancelAnimationFrame(this.loopHandle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.closeLandmarkers();
    this.stats.delegate = 'none';
    this.stats.fps = 0;
    // A perf downgrade belongs to one run: a restart (other camera, lighter load) starts at full quality.
    this.stats.handsEveryOtherFrame = false;
    this.stats.handsAlternate = false;
    this.slowWindows = 0;
    this.lastVideoTime = -1;
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

  private async createLandmarkers(delegate: Delegate): Promise<void> {
    const base = this.opts.modelBaseUrl.replace(/\/$/, '');
    this.fileset ??= await FilesetResolver.forVisionTasks(`${base}/wasm`);
    const fileset = this.fileset;
    const [pose, hands] = await Promise.all([
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}/pose_landmarker_${this.opts.poseModel}.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}/hand_landmarker.task`, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    ]);
    this.pose = pose;
    this.hands = hands;
    if (config.handRoi > 0) {
      // One model download for the three crop instances. Created one at a time: more than two in parallel
      // can fail with "ModuleFactory not set" (each instance loads its own wasm module).
      try {
      if (!this.handModel) {
        const res = await fetch(`${base}/hand_landmarker.task`);
        if (!res.ok) throw new Error(`hand model ${res.status}`);
        this.handModel = new Uint8Array(await res.arrayBuffer());
      }
      const buf = this.handModel;
      const mk = (runningMode: 'VIDEO' | 'IMAGE') =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: buf, delegate },
          runningMode,
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      this.handVid.left = await mk('VIDEO');
      this.handVid.right = await mk('VIDEO');
      this.handImg = await mk('IMAGE');
      for (const h of HANDS) this.crop[h] ??= makeCropCanvas();
      } catch (err) {
        // the crops are an upgrade: losing them must not drag pose onto the CPU — stay on full-frame hands
        console.warn('[motion] hand crops unavailable, using full-frame hand detection', err);
        for (const h of HANDS) { this.handVid[h]?.close(); this.handVid[h] = null; }
        this.handImg?.close(); this.handImg = null;
      }
    }
    this.stats.delegate = delegate;
  }

  /** C.1: GPU is required for 60 fps; fall back to CPU (reported as degraded) if it fails. */
  private async loadModels(): Promise<void> {
    try {
      await this.createLandmarkers('GPU');
    } catch (err) {
      console.warn('[motion] GPU delegate failed, falling back to CPU', err);
      this.closeLandmarkers();
      await this.createLandmarkers('CPU');
    }
  }

  private closeLandmarkers(): void {
    this.pose?.close();
    this.hands?.close();
    this.handVid.left?.close();
    this.handVid.right?.close();
    this.handImg?.close();
    this.pose = this.hands = this.handImg = null;
    this.handVid.left = this.handVid.right = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.usingRvfc = typeof this.video.requestVideoFrameCallback === 'function';
    this.loopHandle = this.usingRvfc
      ? this.video.requestVideoFrameCallback(this.tick)
      : requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    if (!this.running) return;
    this.lastTickAt = performance.now();
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
      hands = this.handsFromPose(v, pose, ts, t0, W, H, only);
      if (only) skippedHands = [only === 'left' ? 'right' : 'left'];
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
      const ema = (prev: number | undefined, x: number) => (prev ? prev * 0.9 + x * 0.1 : x);
      this.stats.msPerFrame = ema(this.stats.msPerFrame, t1 - t0);
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

  /** Hands from the two pose-guided crops (or just `only`). Every returned hand carries its `side`. */
  private handsFromPose(
    v: HTMLVideoElement,
    pose: RawLandmark[],
    ts: number,
    frameStart: number,
    W: number,
    H: number,
    only: Hand | null,
  ): RawHand[] {
    const N = CROP_PX;
    const found: Partial<Record<Hand, RawHand>> = {};
    const modelLabel: Record<Hand, 'Left' | 'Right'> = { left: 'Left', right: 'Right' };
    for (const side of HANDS) {
      if (only && side !== only) continue;
      const st = this.roi[side];
      const model = this.handVid[side];
      const crop = this.crop[side];
      const wristVis = pose[POSE_HAND[side].wrist]?.visibility ?? 0;
      if (wristVis >= 0.5) st.tries++;
      if (!model || !crop) continue;
      const age = ts - st.lastT;
      const target =
        roiFromPose(pose, side, W, H) ??
        (st.last && age < LAST_HAND_MS ? roiFromHand(st.last, W, H, st.vx, st.vy, age) : null);
      if (!target || outsideFraction(target, W, H) > 0.6) {
        st.rect = null;
        continue;
      }
      const rect = (st.rect = sticky(st.rect, target));
      const { ctx, cv } = crop;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, N, N);
      const b = clipBlit(rect, W, H, N);
      if (b) ctx.drawImage(v, ...b);
      if (st.mask && ts < st.maskUntil) {
        const k = N / rect.size;
        ctx.fillRect((st.mask.x0 - rect.x0) * k, (st.mask.y0 - rect.y0) * k, st.mask.size * k, st.mask.size * k);
      }
      // Same ts as the pose; each instance only needs its own timestamps to increase.
      let r = model.detectForVideo(cv, ts);
      if (!r.landmarks.length && config.handRoi >= 2 && this.handImg && wristVis >= 0.5) {
        // Stateless palm search on the same crop: recovers a hand the VIDEO tracker lost after a crop jump.
        // After 2 empty retries in a row (no hand there at all, e.g. out of frame) only every 4th miss, to save
        // ~7 ms a frame.
        if (st.retryWait > 0) st.retryWait--;
        else if (performance.now() - frameStart < config.handRoiRetryBudgetMs) {
          r = this.handImg.detect(cv);
          this.retriesInWindow++;
          if (r.landmarks.length) st.failedRetries = 0;
          else if (++st.failedRetries >= 2) st.retryWait = 3;
        }
      }
      const lm = r.landmarks[0];
      if (!lm) continue;
      st.failedRetries = st.retryWait = 0;
      const cat = r.handedness[0]?.[0];
      modelLabel[side] = cat?.categoryName === 'Left' ? 'Left' : 'Right';
      found[side] = {
        image: cropToFull(lm, rect, W, H),
        world: r.worldLandmarks[0] ?? null,
        // On un-mirrored frames MediaPipe's label names the player's own hand; the crop's side is the truth.
        label: side === 'left' ? 'Left' : 'Right',
        score: cat?.score ?? 0,
        side,
      };
    }
    if (found.left && found.right) {
      const drop = duplicateSide(found.left, found.right, modelLabel, pose, W, H);
      if (drop) {
        const keep = found[drop === 'left' ? 'right' : 'left'] as RawHand;
        this.roi[drop].mask = handBox(keep, W, H, 1.2);
        this.roi[drop].maskUntil = ts + MASK_MS;
        delete found[drop];
      }
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
    return out;
  }

  /**
   * A side with no result for RESEED_AFTER_MS whose pose wrist is gone (< handRoiMinWristVis) has no crop to
   * run. Every RESEED_EVERY frames, look for it on the full frame; a hit seeds the last-hand ROI, so the next
   * frames crop around it.
   */
  private reseed(v: HTMLVideoElement, pose: RawLandmark[], ts: number, W: number, H: number, found: Partial<Record<Hand, RawHand>>, only: Hand | null = null): void {
    if (!this.hands || this.frameNo % RESEED_EVERY !== 0) return;
    const need = HANDS.filter(
      (s) =>
        (!only || s === only) && // a side skipped this frame (alternating crops) isn't filled in: its grip didn't run
        !found[s] &&
        ts - this.roi[s].lastT >= RESEED_AFTER_MS &&
        (pose[POSE_HAND[s].wrist]?.visibility ?? 0) < config.handRoiMinWristVis,
    );
    if (!need.length) return;
    const all = toRawHands(this.hands.detectForVideo(v, ts));
    for (const side of need) {
      let best: RawHand | null = null;
      for (const h of all) {
        if ((h.label === 'Left' ? 'left' : 'right') !== side || (best && best.score >= h.score)) continue;
        // Not the other side's hand seen again.
        const other = found[side === 'left' ? 'right' : 'left'];
        if (other) {
          const a = palmPx(h, W, H), b = palmPx(other, W, H);
          if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5 * Math.max(a.len, b.len)) continue;
        }
        best = h;
      }
      if (best) found[side] = { ...best, side };
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

  private measureFps(now: number): void {
    this.fpsCount++;
    const span = now - this.fpsWindowStart;
    if (span < 1000) return;
    this.stats.fps = (this.fpsCount * 1000) / span;
    this.fpsCount = 0;
    this.fpsWindowStart = now;
    const rate = this.stats.handHitRate ?? (this.stats.handHitRate = { left: 0, right: 0 });
    for (const h of HANDS) {
      const st = this.roi[h];
      rate[h] = st.tries ? st.hits / st.tries : 0;
      st.tries = st.hits = 0;
    }
    this.stats.roiRetries = this.retriesInWindow;
    this.retriesInWindow = 0;
    // Cameras often report their real size only after the first frames.
    if (this.stats.width !== this.video.videoWidth) this.updateResolution();
    const threshold = this.opts.downgradeBelowFps;
    const degraded = this.stats.handsEveryOtherFrame || this.stats.handsAlternate;
    // the rate frames really arrive at: a camera that reports 60 but delivers 30 (dim light) mustn't halve the budget
    const camFps = Math.min(this.stream?.getVideoTracks()[0]?.getSettings().frameRate || 30, this.stats.fps || 30);
    if (this.stats.handsAlternate) {
      // recover: when both crops would fit comfortably again (pose + 2 hand crops < 60% of a frame) for 5 windows
      const full = (this.stats.msPose ?? 0) + 2 * (this.stats.msHands ?? 0);
      this.slowWindows = full < (0.6 * 1000) / camFps ? this.slowWindows + 1 : 0;
      if (this.slowWindows >= 5) { this.stats.handsAlternate = false; this.slowWindows = 0; console.info('[motion] both hand crops every frame again'); }
    } else if (threshold > 0 && !degraded && now - this.startedAt > 3000) {
      // Only when WE are the bottleneck: a Mac camera delivers 30 fps however fast detection is, and degrading
      // then costs hand rate for nothing.
      const processingBound = this.stats.msPerFrame > (0.8 * 1000) / camFps;
      this.slowWindows = this.stats.fps < threshold && processingBound ? this.slowWindows + 1 : 0;
      if (this.slowWindows >= 3) {
        if (config.handRoi > 0) {
          // Hand crops cost the same at any camera resolution, and 960×540 only shrinks the hands: alternate
          // the left and right crops instead (each hand at half rate, pose at full rate).
          this.stats.handsAlternate = true;
          console.warn(`[motion] detection ${this.stats.msPerFrame.toFixed(1)} ms/frame at ${camFps} fps: alternating L/R hand crops`);
        } else {
          void this.downgrade();
        }
      }
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
      this.createLandmarkers('CPU').then(
        () => { this.stats.error = null; },
        (e: unknown) => { this.stats.error = `CPU fallback failed: ${describeError(e)}`; },
      );
    }
  }
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
