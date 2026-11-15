// Webcam + MediaPipe Pose/Hand landmarkers. Produces RawFrames; knows nothing about the game.
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { RawFrame, RawHand, TrackerStats } from './types';

export interface TrackerOptions {
  modelBaseUrl: string;
  poseModel: 'full' | 'lite';
  /** Use this element instead of creating a hidden one. */
  video?: HTMLVideoElement;
  deviceId?: string;
  /** Drop to 960×540 + hands every other frame when fps < this. 0 disables. */
  downgradeBelowFps: number;
}

type Delegate = 'GPU' | 'CPU';
type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export class Tracker {
  readonly video: HTMLVideoElement;
  onFrame: (f: RawFrame) => void = () => {};
  readonly stats: TrackerStats = {
    fps: 0, msPerFrame: 0, delegate: 'none', width: 0, height: 0, handsEveryOtherFrame: false, error: null,
  };

  private stream: MediaStream | null = null;
  private fileset: Fileset | null = null;
  private pose: PoseLandmarker | null = null;
  private hands: HandLandmarker | null = null;
  private running = false;
  private loopHandle = 0;
  private usingRvfc = false;
  private lastTs = 0;
  private lastVideoTime = -1;
  private frameNo = 0;
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
    this.startedAt = this.fpsWindowStart = performance.now();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.usingRvfc) this.video.cancelVideoFrameCallback(this.loopHandle);
    else cancelAnimationFrame(this.loopHandle);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.closeLandmarkers();
    this.stats.delegate = 'none';
    this.stats.fps = 0;
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
    const [pose, hands] = await Promise.all([
      PoseLandmarker.createFromOptions(this.fileset, {
        baseOptions: { modelAssetPath: `${base}/pose_landmarker_${this.opts.poseModel}.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
      HandLandmarker.createFromOptions(this.fileset, {
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
    this.pose = this.hands = null;
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
    try {
      this.process();
    } catch (err) {
      this.handleDetectError(err);
    }
    this.schedule();
  };

  private process(): void {
    const v = this.video;
    if (!this.pose || !this.hands || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;

    const now = performance.now();
    const ts = Math.max(Math.round(now), this.lastTs + 1); // MediaPipe needs strictly increasing ms
    this.lastTs = ts;
    this.frameNo++;

    const t0 = performance.now();
    const poseRes = this.pose.detectForVideo(v, ts);
    let hands: RawHand[] | null = null;
    if (!this.stats.handsEveryOtherFrame || this.frameNo % 2 === 0) {
      const h = this.hands.detectForVideo(v, ts);
      hands = [];
      for (let i = 0; i < h.landmarks.length; i++) {
        const image = h.landmarks[i];
        if (!image) continue;
        const cat = h.handedness[i]?.[0];
        hands.push({
          image,
          world: h.worldLandmarks[i] ?? null,
          label: cat?.categoryName === 'Left' ? 'Left' : 'Right',
          score: cat?.score ?? 0,
        });
      }
      this.lastHands = hands;
    }
    const dtMs = performance.now() - t0;
    // Skip warm-up frames (shader compilation) so the C.8 budget readout is honest.
    if (this.frameNo > 5) this.stats.msPerFrame = this.stats.msPerFrame ? this.stats.msPerFrame * 0.9 + dtMs * 0.1 : dtMs;
    this.detectErrors = 0;

    this.onFrame({
      t: now,
      poseImage: poseRes.landmarks[0] ?? null,
      poseWorld: poseRes.worldLandmarks[0] ?? null,
      hands,
    });
    this.measureFps(now);
  }

  private measureFps(now: number): void {
    this.fpsCount++;
    const span = now - this.fpsWindowStart;
    if (span < 1000) return;
    this.stats.fps = (this.fpsCount * 1000) / span;
    this.fpsCount = 0;
    this.fpsWindowStart = now;
    // Cameras often report their real size only after the first frames.
    if (this.stats.width !== this.video.videoWidth) this.updateResolution();
    const threshold = this.opts.downgradeBelowFps;
    if (threshold > 0 && !this.stats.handsEveryOtherFrame && now - this.startedAt > 3000) {
      this.slowWindows = this.stats.fps < threshold ? this.slowWindows + 1 : 0;
      if (this.slowWindows >= 2) void this.downgrade();
    }
  }

  /** C.8: drop to 960×540 and run hands every other frame. */
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

function describeError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'Camera permission denied.';
    if (err.name === 'NotFoundError') return 'No camera found.';
    if (err.name === 'NotReadableError') return 'Camera is in use by another app.';
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
