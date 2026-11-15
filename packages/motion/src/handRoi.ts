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
