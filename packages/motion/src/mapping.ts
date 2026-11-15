// C.3: monocular webcam → game camera space (meters, +X right, +Y up, −Z forward, origin at the eyes).
import type { Hand, PlayerInputState, Vec3 } from '@ithaca/shared';
import { config } from './config';
import { angleDeg, clamp, copy3, cross3, dist2, normalize3, set3, slerpish3, sub3, v2, v3, type Vec2 } from './math';
import { OneEuro3 } from './oneEuro';
import type { Profile } from './profile';
import type { RawHand, RawLandmark } from './types';

export const HANDS: readonly Hand[] = ['left', 'right'];

/** Pose landmark indices per (anatomical, un-mirrored) side. */
export const POSE_IDX = {
  left: { shoulder: 11, elbow: 13, wrist: 15, ear: 7 },
  right: { shoulder: 12, elbow: 14, wrist: 16, ear: 8 },
} as const;
export const NOSE = 0;
export const MOUTH_L = 9;
export const MOUTH_R = 10;

type PerHand<T> = Record<Hand, T>;
const perHand = <T>(make: (h: Hand) => T): PerHand<T> => ({ left: make('left'), right: make('right') });

/**
 * Per-frame derived skeleton, shared by grip/gesture/calibration code.
 * Game-space joints use pose-world landmarks only; hand `pos` in PlayerInputState additionally fuses depth.
 */
export class Body {
  /** Pose present this frame. */
  ok = false;
  t = 0;
  /** Seconds since previous frame (clamped). */
  dt = 1 / 60;
  /** Video width / height of the current frame (hand image landmarks are normalized per axis). */
  aspect = 16 / 9;
  /** Aspect-corrected image points (units of image height). Valid when ok. */
  readonly img: Vec2[] = Array.from({ length: 33 }, () => v2());
  /** Image shoulder width (image-height units) and meters per image unit at the shoulders. */
  swImg = 0;
  mPerImg = 0;
  /** Live pose-world shoulder width (m), smoothed. */
  swWorld = 0;
  /** Pose-world arm length right now (m) — calibration reads it. */
  readonly armLenWorld = perHand(() => 0);
  /** Elbow angle (deg) from pose-world landmarks. */
  readonly elbowAngle = perHand(() => 0);
  readonly shoulder = perHand(() => v3());
  readonly elbow = perHand(() => v3());
  readonly wrist = perHand(() => v3());
  readonly wristVis = perHand(() => 0);
  /** Pose-wrist speed in the image plane, converted to game m/s (smoothed). Sees throws the depth axis misses. */
  readonly wristImgSpeed = perHand(() => 0);
  /** Hand landmarks assigned to each side this frame (kept from the last run when hands were skipped). */
  readonly hand = perHand<RawHand | null>(() => null);
  /** True if the hand model ran this frame and found this hand. */
  readonly handFresh = perHand(() => false);
  /** True if the hand model ran for this side this frame (false on skipped / alternate frames). */
  readonly handRan = perHand(() => false);
  /** Aspect-corrected palm center in image space (valid when hand[side]). */
  readonly palmImg = perHand(() => v2());
  /** Upper arm / forearm image length ÷ shoulder width (for calibration + depth). */
  readonly upperImgRatio = perHand(() => 0);
  readonly foreImgRatio = perHand(() => 0);
  /** Raw finger curls (index, middle, ring, pinky), thumb extension, mean curl — filled by GripTracker. */
  readonly curls = perHand(() => [0, 0, 0, 0]);
  readonly thumbExt = perHand(() => 0);
  readonly gripRaw = perHand(() => 0);

  /** Image distance → meters (approx, at shoulder depth). */
  meters(a: Vec2, b: Vec2): number {
    return dist2(a, b) * this.mPerImg;
  }
}

const tmp = v3();
const tmp2 = v3();
const target = v3();
const ZERO: RawLandmark = { x: 0, y: 0, z: 0, visibility: 0 };

export class Mapper {
  readonly body = new Body();
  private lastT = -1;
  private readonly posFilter = perHand(() => new OneEuro3(1, 0.02, 0.6));
  private readonly velFilter = perHand(() => new OneEuro3(5, 0));
  private readonly prevTarget = perHand(() => v3());
  private readonly wasVisible = perHand(() => false);
  private readonly prevWristImg = perHand(() => v2());
  private readonly hasPrevWrist = perHand(() => false);
  private readonly bodyLean = { lean: 0, crouch: 0, yaw: 0 };
  private autoNeutral: { x: number; y: number; swImg: number; n: number } = { x: 0, y: 0, swImg: 0, n: 0 };

  reset(): void {
    this.lastT = -1;
    for (const h of HANDS) {
      this.posFilter[h].reset();
      this.velFilter[h].reset();
      this.wasVisible[h] = false;
      this.hasPrevWrist[h] = false;
      this.body.wristImgSpeed[h] = 0;
      this.body.hand[h] = null;
    }
    this.autoNeutral = { x: 0, y: 0, swImg: 0, n: 0 };
  }

  /** Forget the auto-estimated neutral (e.g. after calibration). */
  resetAutoNeutral(): void {
    this.autoNeutral.n = 0;
  }

  update(
    poseImage: RawLandmark[] | null,
    poseWorld: RawLandmark[] | null,
    hands: RawHand[] | null,
    t: number,
    aspect: number,
    profile: Profile,
    state: PlayerInputState,
    skippedHands?: readonly Hand[],
  ): Body {
    const b = this.body;
    for (const h of HANDS) b.handRan[h] = !!hands && !skippedHands?.includes(h);
    b.dt = this.lastT < 0 ? 1 / 60 : clamp((t - this.lastT) / 1000, 1 / 240, 0.1);
    this.lastT = t;
    b.t = t;
    b.aspect = aspect;
    this.aspect = aspect;

    if (!poseImage || !poseWorld || poseImage.length < 33 || poseWorld.length < 33) {
      b.ok = false;
      for (const h of HANDS) {
        this.hasPrevWrist[h] = false;
        b.wristImgSpeed[h] = 0;
        b.handFresh[h] = false;
        this.loseHand(h, state);
      }
      if (hands) this.assignHands(hands, null, skippedHands);
      return b;
    }
    b.ok = true;

    // ── image space ──
    for (let i = 0; i < 33; i++) {
      const p = poseImage[i] ?? ZERO;
      const q = b.img[i] as Vec2;
      q.x = p.x * aspect;
      q.y = p.y;
    }
    const img = b.img;
    b.swImg = Math.max(dist2(img[11] as Vec2, img[12] as Vec2), 1e-3);

    // ── world → game ──
    const w = poseWorld;
    const wl = w[11] ?? ZERO;
    const wr = w[12] ?? ZERO;
    const swWorldNow = Math.hypot(wl.x - wr.x, wl.y - wr.y, wl.z - wr.z);
    b.swWorld = b.swWorld ? b.swWorld + (swWorldNow - b.swWorld) * 0.05 : swWorldNow;
    const swM = profile.calibrated ? profile.shoulderWidthM : b.swWorld || profile.shoulderWidthM;
    b.mPerImg = swM / b.swImg;

    const ox = (wl.x + wr.x) / 2, oy = (wl.y + wr.y) / 2, oz = (wl.z + wr.z) / 2;
    const s = config.gameArmReach / Math.max(profile.armLengthM, 0.2);
    const toGame = (out: Vec3, p: RawLandmark | undefined): Vec3 =>
      set3(out, -((p ?? ZERO).x - ox) * s, -((p ?? ZERO).y - oy) * s - config.eyeToShoulderM, ((p ?? ZERO).z - oz) * s);

    for (const h of HANDS) {
      const ix = POSE_IDX[h];
      toGame(b.shoulder[h], w[ix.shoulder]);
      toGame(b.elbow[h], w[ix.elbow]);
      toGame(b.wrist[h], w[ix.wrist]);
      b.wristVis[h] = poseImage[ix.wrist]?.visibility ?? 0;
      const wi = img[ix.wrist] as Vec2, pw = this.prevWristImg[h];
      if (this.hasPrevWrist[h] && b.wristVis[h] >= config.wristMinVisibility) {
        const sp = (dist2(wi, pw) / b.dt) * b.mPerImg * s;
        b.wristImgSpeed[h] += (sp - b.wristImgSpeed[h]) * 0.5;
      } else {
        b.wristImgSpeed[h] = 0;
      }
      pw.x = wi.x;
      pw.y = wi.y;
      this.hasPrevWrist[h] = b.wristVis[h] >= config.wristMinVisibility;
      const ws = w[ix.shoulder] ?? ZERO, we = w[ix.elbow] ?? ZERO, ww = w[ix.wrist] ?? ZERO;
      b.armLenWorld[h] =
        Math.hypot(ws.x - we.x, ws.y - we.y, ws.z - we.z) + Math.hypot(we.x - ww.x, we.y - ww.y, we.z - ww.z);
      b.elbowAngle[h] = angleDeg(b.shoulder[h], b.elbow[h], b.wrist[h]);
      b.upperImgRatio[h] = dist2(img[ix.shoulder] as Vec2, img[ix.elbow] as Vec2) / b.swImg;
      b.foreImgRatio[h] = dist2(img[ix.elbow] as Vec2, img[ix.wrist] as Vec2) / b.swImg;
    }

    this.updateBody(profile, state);
    if (hands) this.assignHands(hands, poseImage, skippedHands);
    else for (const h of HANDS) b.handFresh[h] = false;

    for (const h of HANDS) this.updateHand(h, profile, state, aspect);
    return b;
  }

  // ── C.3 body lean / crouch / yaw ──
  private updateBody(profile: Profile, state: PlayerInputState): void {
    const b = this.body;
    const l = b.img[11] as Vec2, r = b.img[12] as Vec2;
    const smx = (l.x + r.x) / 2, smy = (l.y + r.y) / 2;

    let n = profile.neutral;
    if (!n) {
      // Uncalibrated: average the first ~0.5 s of frames as the neutral stance.
      const a = this.autoNeutral;
      if (a.n < 30) {
        a.x = (a.x * a.n + smx) / (a.n + 1);
        a.y = (a.y * a.n + smy) / (a.n + 1);
        a.swImg = (a.swImg * a.n + b.swImg) / (a.n + 1);
        a.n++;
      }
      n = a;
    }
    // Un-mirror: image +x is the player's left.
    const lean = clamp(-(smx - n.x) / (0.5 * n.swImg), -1, 1);
    const crouch = clamp((smy - n.y) / (config.crouchFullDropSw * n.swImg), 0, 1);
    sub3(tmp, b.shoulder.right, b.shoulder.left);
    const yaw = Math.atan2(-tmp.z, tmp.x);

    const k = config.bodySmoothing;
    const bl = this.bodyLean;
    bl.lean += (lean - bl.lean) * k;
    bl.crouch += (crouch - bl.crouch) * k;
    bl.yaw += (yaw - bl.yaw) * k;
    state.body.lean = bl.lean;
    state.body.crouch = bl.crouch;
    state.body.yaw = bl.yaw;
  }

  /**
   * C.2: associate detected hands with pose wrists (nearest wrist in image space).
   * Hands from the pose-guided crops carry `side` and are taken as is. Otherwise: nearest pose wrist, falling
   * back to MediaPipe's label, which names the player's own hand on these un-mirrored frames ('Left' = left;
   * checked on the fixtures: 490 of 496 labels match the nearest pose wrist on the same side).
   */
  private assignHands(hands: RawHand[], poseImage: RawLandmark[] | null, skipped?: readonly Hand[]): void {
    const b = this.body;
    const prevL = b.hand.left, prevR = b.hand.right;
    this.assignFresh(hands, poseImage);
    // A side whose crop was not run this frame keeps its last result (not fresh), like a skipped frame.
    if (skipped) {
      if (skipped.includes('left') && !b.handFresh.left) b.hand.left = prevL;
      if (skipped.includes('right') && !b.handFresh.right) b.hand.right = prevR;
    }
  }

  private assignFresh(hands: RawHand[], poseImage: RawLandmark[] | null): void {
    const b = this.body;
    b.hand.left = b.hand.right = null;
    b.handFresh.left = b.handFresh.right = false;
    const byLabel = (hd: RawHand): Hand => (hd.label === 'Left' ? 'left' : 'right');
    const put = (h: Hand, hd: RawHand) => {
      b.hand[h] = hd;
      b.handFresh[h] = true;
    };
    if (hands.length && hands.every((hd) => hd.side)) {
      for (const hd of hands) put(hd.side as Hand, hd);
      return;
    }
    const h0 = hands[0], h1 = hands[1];
    if (!h0) return;
    if (!poseImage) {
      put(byLabel(h0), h0);
      if (h1 && !b.hand[byLabel(h1)]) put(byLabel(h1), h1);
      return;
    }
    const d = (hd: RawHand, h: Hand) => dist2(this.handWristImg(hd, tmpA), b.img[POSE_IDX[h].wrist] as Vec2);
    const maxD = config.assocMaxDist;
    if (!h1) {
      const dl = d(h0, 'left'), dr = d(h0, 'right');
      const side: Hand = Math.min(dl, dr) > maxD ? byLabel(h0) : dl < dr ? 'left' : 'right';
      put(side, h0);
      return;
    }
    const straight = d(h0, 'left') + d(h1, 'right');
    const crossed = d(h0, 'right') + d(h1, 'left');
    if (straight <= crossed) {
      put('left', h0);
      put('right', h1);
    } else {
      put('right', h0);
      put('left', h1);
    }
  }

  private aspect = 16 / 9;
  private handWristImg(hd: RawHand, out: Vec2): Vec2 {
    const p = hd.image[0] ?? ZERO;
    out.x = p.x * this.aspect;
    out.y = p.y;
    return out;
  }

  private updateHand(h: Hand, profile: Profile, state: PlayerInputState, aspect: number): void {
    const b = this.body;
    const hs = state.hands[h];
    const hd = b.hand[h];

    if (hd) {
      // Palm center = mean of wrist + 4 MCPs.
      let px = 0, py = 0;
      for (const i of [0, 5, 9, 13, 17]) {
        const p = hd.image[i] ?? ZERO;
        px += p.x;
        py += p.y;
      }
      b.palmImg[h].x = (px / 5) * aspect;
      b.palmImg[h].y = py / 5;
    }

    // The pose wrist score is low on a hand held toward the camera or in front of the body, exactly where the
    // hand model still sees it: a fresh, confident hand detection keeps the hand visible.
    const handSeen = !!hd && b.handFresh[h] && hd.score >= 0.5;
    if (b.wristVis[h] < config.wristMinVisibility && !handSeen) {
      this.loseHand(h, state);
      return;
    }

    // Depth (z) fusion: world z + forearm/upper-arm foreshortening, 50/50, clamped.
    const ru = clamp(b.upperImgRatio[h] / Math.max(profile.upperArmImgRatio, 0.1), 0, 1);
    const rf = clamp(b.foreImgRatio[h] / Math.max(profile.forearmImgRatio, 0.1), 0, 1);
    const zCue = -(Math.sqrt(1 - ru * ru) * 0.5 + Math.sqrt(1 - rf * rf) * 0.5) * config.gameArmReach;
    const zWorld = b.wrist[h].z;
    const z = clamp(config.depthBlend * zWorld + (1 - config.depthBlend) * zCue, config.zFar, config.zNear);
    set3(target, b.wrist[h].x, b.wrist[h].y, z);

    const pf = this.posFilter[h];
    const vf = this.velFilter[h];
    pf.tune(config.posMinCutoff, config.posBeta, config.zMinCutoff);
    vf.tune(config.velMinCutoff, 0);
    if (!this.wasVisible[h]) {
      // Re-acquired: restart filters so the jump doesn't become a huge velocity.
      pf.reset();
      vf.reset();
      copy3(this.prevTarget[h], target);
    }
    pf.filter(hs.pos, target, b.dt);
    // Velocity: derivative of the (unfiltered) mapped position, then One-Euro'd. Deriving it from the
    // heavily smoothed position adds ~150 ms of lag, which ruins throws.
    const dt = b.dt;
    set3(tmp2, (target.x - this.prevTarget[h].x) / dt, (target.y - this.prevTarget[h].y) / dt, (target.z - this.prevTarget[h].z) / dt);
    vf.filter(hs.vel, tmp2, dt);
    copy3(this.prevTarget[h], target);

    // forward = elbow → wrist
    sub3(tmp, b.wrist[h], b.elbow[h]);
    normalize3(tmp);
    if (this.wasVisible[h]) slerpish3(hs.forward, tmp, config.dirSmoothing);
    else copy3(hs.forward, tmp);

    // up = back-of-hand normal from hand-world landmarks (cross 0→5, 0→17), un-mirrored.
    if (hd && b.handFresh[h]) {
      const lm = hd.world ?? hd.image;
      const l0 = lm[0] ?? ZERO, l5 = lm[5] ?? ZERO, l17 = lm[17] ?? ZERO;
      // Convert to game axes: x and y flip, z stays (z toward camera is negative = forward).
      set3(tmpV1, -(l5.x - l0.x), -(l5.y - l0.y), l5.z - l0.z);
      set3(tmpV2, -(l17.x - l0.x), -(l17.y - l0.y), l17.z - l0.z);
      if (h === 'right') cross3(tmp, tmpV2, tmpV1);
      else cross3(tmp, tmpV1, tmpV2);
      normalize3(tmp, 0, 1, 0);
      slerpish3(hs.up, tmp, config.dirSmoothing);
    }

    this.wasVisible[h] = true;
    hs.visible = true;
    hs.confidence = clamp(b.wristVis[h] * (b.handFresh[h] && hd ? hd.score : config.lostHandConfidence), 0, 1);
  }

  private loseHand(h: Hand, state: PlayerInputState): void {
    const hs = state.hands[h];
    hs.visible = false;
    hs.confidence = 0;
    hs.vel.x *= 0.8;
    hs.vel.y *= 0.8;
    hs.vel.z *= 0.8;
    this.wasVisible[h] = false;
  }
}

const tmpA = v2();
const tmpV1 = v3();
const tmpV2 = v3();
