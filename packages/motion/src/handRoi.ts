// Pose-guided hand crops (pure geometry, no DOM). The full-frame palm detector letterboxes 1280×720 into
// 192×192, so a hand at 2 m (fist ≈ 50 px) shrinks to ≈ 8 px and is never found. Instead each hand gets a
// 256×256 crop placed from the pose wrist / index / pinky, the way MediaPipe Holistic does it
// (HandDetectionsFromPoseToRectsCalculator + RectTransformationCalculator), and the landmarks are mapped back.
// All rects are axis-aligned squares in source-video pixels.
import type { Hand } from '@ithaca/shared';
import { config } from './config';
import { clamp } from './math';
import type { RawHand, RawLandmark } from './types';

export interface CropRect {
  x0: number;
  y0: number;
  size: number;
}

/** Pose landmark indices per side used to place the hand crop. */
export const POSE_HAND = {
  left: { wrist: 15, pinky: 17, index: 19 },
  right: { wrist: 16, pinky: 18, index: 20 },
} as const;

/** Side of the square canvas the hand model sees. Above 224 adds nothing for the 192 / 224 models. */
export const CROP_PX = 256;
/** Smallest crop side in source px (upscaling up to ~2.7× was fine in the benchmark). */
export const MIN_CROP = 96;

/**
 * Holistic's hand ROI from the pose: m = (2·index + pinky)/3, d = |m − w| clamped to [0.18, 0.40]·shoulder
 * width (guards against a foreshortened hand pointing at the camera), side S = 5.4·d (×1.3 when the wrist is
 * uncertain), centred 1.2·d past the wrist toward m. Null when the wrist is not tracked (visibility gate).
 */
export function roiFromPose(pose: RawLandmark[], side: Hand, W: number, H: number): CropRect | null {
  const ix = POSE_HAND[side];
  const w = pose[ix.wrist], p = pose[ix.pinky], i = pose[ix.index];
  const vis = w?.visibility ?? 0;
  if (!w || !p || !i || vis < config.handRoiMinWristVis) return null;
  const wx = w.x * W, wy = w.y * H;
  const mx = ((2 * i.x + p.x) / 3) * W, my = ((2 * i.y + p.y) / 3) * H;
  const dRaw = Math.hypot(mx - wx, my - wy);
  const ls = pose[11], rs = pose[12];
  const sw = ls && rs ? Math.hypot((ls.x - rs.x) * W, (ls.y - rs.y) * H) : 4 * dRaw;
  const d = sw > 0 ? clamp(dRaw, 0.18 * sw, 0.4 * sw) : dRaw;
  const ux = dRaw > 1e-3 ? (mx - wx) / dRaw : 0, uy = dRaw > 1e-3 ? (my - wy) / dRaw : 0;
  const size = clamp(config.handRoiScale * d * (vis < 0.5 ? 1.3 : 1), MIN_CROP, 0.9 * H);
  const cx = wx + config.handRoiCenterAlong * d * ux, cy = wy + config.handRoiCenterAlong * d * uy;
  return { x0: cx - size / 2, y0: cy - size / 2, size };
}

/** Bounding box of a hand's image landmarks in source px. */
export function handBounds(h: RawHand, W: number, H: number): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of h.image) {
    const x = l.x * W, y = l.y * H;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Fallback ROI from this side's last hand result (pose wrist untracked): 1.8 × the landmark bounding box
 * (same hand fill as the pose crop), moved by the palm velocity (px/ms) over its age.
 */
export function roiFromHand(h: RawHand, W: number, H: number, vx: number, vy: number, ageMs: number): CropRect {
  const b = handBounds(h, W, H);
  const size = clamp(1.8 * Math.max(b.x1 - b.x0, b.y1 - b.y0), MIN_CROP, 0.9 * H);
  const cx = (b.x0 + b.x1) / 2 + vx * ageMs, cy = (b.y0 + b.y1) / 2 + vy * ageMs;
  return { x0: cx - size / 2, y0: cy - size / 2, size };
}

/** Square around a hand (its bounding box × scale), e.g. to black it out of the other side's crop. */
export function handBox(h: RawHand, W: number, H: number, scale: number): CropRect {
  const b = handBounds(h, W, H);
  const size = Math.max(b.x1 - b.x0, b.y1 - b.y0) * scale;
  return { x0: (b.x0 + b.x1) / 2 - size / 2, y0: (b.y0 + b.y1) / 2 - size / 2, size };
}

/**
 * Dead-band: keep the previous rect while the target centre moved < handRoiSticky·S and the size changed
 * < 20%, so the VIDEO-mode tracker's internal ROI stays valid. Otherwise jump straight to the target (the
 * pose is from the current frame, smoothing would only lag).
 */
export function sticky(prev: CropRect | null, next: CropRect): CropRect {
  if (!prev) return next;
  const dc = Math.hypot(next.x0 + next.size / 2 - (prev.x0 + prev.size / 2), next.y0 + next.size / 2 - (prev.y0 + prev.size / 2));
  return dc < config.handRoiSticky * prev.size && Math.abs(next.size / prev.size - 1) < 0.2 ? prev : next;
}

/**
 * A pose ROI that hides the hand it is for: a hand reaching toward the camera (bow arm, throw, sword thrust)
 * is nearer, so bigger, than its foreshortened wrist→knuckle span says — on the fixtures only 55% of bow-arm
 * hands and 52% of throwing hands fit in the pose crop. When this side's own hand was seen a moment ago and its
 * landmark ROI (`hand`, roiFromHand) is centred inside the pose ROI but is bigger, return the smallest square
 * around the midpoint of both centres that holds that hand ROI (and so the pose ROI). Otherwise `pose` as is.
 * (Fixtures: 68% → 88% of left hands fully inside, 93% → 96% of right hands; small hands unchanged.)
 */
export function coverRoi(pose: CropRect, hand: CropRect, H: number): CropRect {
  if (hand.size <= pose.size) return pose;
  const px = pose.x0 + pose.size / 2, py = pose.y0 + pose.size / 2;
  const hx = hand.x0 + hand.size / 2, hy = hand.y0 + hand.size / 2;
  // a hand ROI centred outside the pose ROI is not this pose wrist's hand (or the pose jumped): trust the pose
  if (hx < pose.x0 || hx > pose.x0 + pose.size || hy < pose.y0 || hy > pose.y0 + pose.size) return pose;
  const cx = (px + hx) / 2, cy = (py + hy) / 2;
  const size = clamp(2 * Math.max(Math.abs(hx - cx), Math.abs(hy - cy)) + hand.size, pose.size, Math.max(pose.size, 0.9 * H));
  return { x0: cx - size / 2, y0: cy - size / 2, size };
}

/** A crop more than this share outside the frame is not run (there is almost nothing of the hand to see). */
export const MAX_OUTSIDE = 0.6;

/**
 * Where to crop one side this frame. `pose` = roiFromPose (null: wrist untracked); `hand` = roiFromHand of this
 * side's own recent result (null: none); `handFresh` = that result is recent enough to size the crop (coverRoi).
 * - pose ROI inside the frame: the pose ROI (grown by coverRoi when it hides the hand);
 * - pose ROI mostly off-frame or missing: the hand ROI — the pose extrapolates a wrist at the frame edge past it,
 *   the hand model just saw where the hand really is.
 * `offFrame`: there was a pose ROI but no crop runs because it lies outside the frame (the tracker then lets the
 * full frame look for that hand after a while — it may poke in at the edge).
 */
export function cropTarget(
  pose: CropRect | null,
  hand: CropRect | null,
  handFresh: boolean,
  W: number,
  H: number,
): { rect: CropRect | null; offFrame: boolean } {
  if (pose && outsideFraction(pose, W, H) <= MAX_OUTSIDE) {
    const c = hand && handFresh ? coverRoi(pose, hand, H) : pose;
    return { rect: c === pose || outsideFraction(c, W, H) <= MAX_OUTSIDE ? c : pose, offFrame: false };
  }
  const h = hand && outsideFraction(hand, W, H) <= MAX_OUTSIDE ? hand : null;
  return { rect: h, offFrame: !!pose && !h };
}

/** Fraction of the rect's area outside the W×H frame (0 = fully inside, 1 = fully outside). */
export function outsideFraction(r: CropRect, W: number, H: number): number {
  const iw = Math.max(0, Math.min(r.x0 + r.size, W) - Math.max(r.x0, 0));
  const ih = Math.max(0, Math.min(r.y0 + r.size, H) - Math.max(r.y0, 0));
  return 1 - (iw * ih) / (r.size * r.size);
}

export type Blit = [sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number];

/**
 * drawImage(src, ...blit) arguments that copy the part of `r` inside the frame into an N×N canvas, at the
 * right place: what lies outside the frame stays as the canvas fill (black, as the model's own letterbox).
 * Null when the rect does not touch the frame.
 */
export function clipBlit(r: CropRect, W: number, H: number, N: number): Blit | null {
  const sx0 = Math.max(r.x0, 0), sy0 = Math.max(r.y0, 0);
  const sx1 = Math.min(r.x0 + r.size, W), sy1 = Math.min(r.y0 + r.size, H);
  if (sx1 <= sx0 || sy1 <= sy0) return null;
  const k = N / r.size;
  return [sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - r.x0) * k, (sy0 - r.y0) * k, (sx1 - sx0) * k, (sy1 - sy0) * k];
}

/**
 * Crop-normalized landmarks → full-frame normalized (LandmarkProjectionCalculator, rotation 0).
 * MediaPipe's image z uses the x scale, so z scales by S/W. World landmarks need no mapping.
 */
export function cropToFull(lm: RawLandmark[], r: CropRect, W: number, H: number): RawLandmark[] {
  return lm.map((l) => {
    const o: RawLandmark = { x: (r.x0 + l.x * r.size) / W, y: (r.y0 + l.y * r.size) / H, z: (l.z * r.size) / W };
    if (l.visibility !== undefined) o.visibility = l.visibility;
    return o;
  });
}

/** Inverse of cropToFull (tests, overlays). */
export function fullToCrop(lm: RawLandmark[], r: CropRect, W: number, H: number): RawLandmark[] {
  return lm.map((l) => ({ x: (l.x * W - r.x0) / r.size, y: (l.y * H - r.y0) / r.size, z: (l.z * W) / r.size }));
}

const PALM = [0, 5, 9, 13, 17] as const;

/** Palm centre (mean of wrist + 4 MCPs) and palm length |lm0 − lm9|, in source px. */
export function palmPx(h: RawHand, W: number, H: number): { x: number; y: number; len: number } {
  let x = 0, y = 0;
  for (const i of PALM) {
    x += (h.image[i]?.x ?? 0) * W;
    y += (h.image[i]?.y ?? 0) * H;
  }
  const a = h.image[0], b = h.image[9];
  const len = a && b ? Math.hypot((a.x - b.x) * W, (a.y - b.y) * H) : 0;
  return { x: x / PALM.length, y: y / PALM.length, len };
}

/**
 * Both crops locked onto one physical hand (hands together: guard, bow draw, drink)? Returns the side to
 * drop, or null for two distinct hands (palm centres ≥ 0.5 palm length apart).
 * The side whose own model label disagrees with it is dropped ('Left' = left hand on these un-mirrored
 * frames); on a tie, the side whose wrist landmark is farther from its own pose wrist.
 */
export function duplicateSide(
  L: RawHand,
  R: RawHand,
  modelLabel: Record<Hand, 'Left' | 'Right'>,
  pose: RawLandmark[] | null,
  W: number,
  H: number,
): Hand | null {
  const a = palmPx(L, W, H), b = palmPx(R, W, H);
  if (Math.hypot(a.x - b.x, a.y - b.y) >= 0.5 * Math.max(a.len, b.len)) return null;
  const leftWrong = modelLabel.left !== 'Left', rightWrong = modelLabel.right !== 'Right';
  if (leftWrong !== rightWrong) return leftWrong ? 'left' : 'right';
  const off = (h: RawHand, side: Hand): number => {
    const pw = pose?.[POSE_HAND[side].wrist], hw = h.image[0];
    return pw && hw ? Math.hypot((pw.x - hw.x) * W, (pw.y - hw.y) * H) : 0;
  };
  return off(L, 'left') > off(R, 'right') ? 'left' : 'right';
}
