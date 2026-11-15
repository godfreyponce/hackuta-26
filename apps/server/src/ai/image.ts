import sharp from 'sharp';
import type { Box } from './vision';

export interface CropOut { png1024: Buffer; thumbJpeg: Buffer }
export interface Rect { left: number; top: number; width: number; height: number }

/** The picture inside a call frame's black bars (call frames are 1280×720 with the picture in about x 0.31..0.69). */
export async function contentRect(jpeg: Buffer): Promise<Rect> {
  const upright = await sharp(jpeg).rotate().toBuffer();
  const { width: W = 0, height: H = 0 } = await sharp(upright).metadata();
  if (!W || !H) throw new Error('could not read image size');
  const full = { left: 0, top: 0, width: W, height: H };
  try {
    const { info } = await sharp(upright).trim({ background: '#000000', threshold: 24 }).toBuffer({ resolveWithObject: true });
    if (info.width < 16 || info.height < 16) return full;
    // Call-frame bars are side bars only: a dark band at the top or bottom is picture, not bar.
    return { left: Math.abs(info.trimOffsetLeft ?? 0), top: 0, width: info.width, height: H };
  } catch {
    return full;
  }
}

/** bbox ⊕ 15% margin, kept inside the picture. A box that misses the picture, or is under 16 px, gives the whole picture. */
export function cropRect(bbox: Box, pic: Rect, W: number, H: number): Rect {
  const [x0, y0, x1, y1] = bbox;
  const mx = (x1 - x0) * W * 0.15, my = (y1 - y0) * H * 0.15;
  const left = Math.max(pic.left, Math.floor(x0 * W - mx));
  const top = Math.max(pic.top, Math.floor(y0 * H - my));
  const right = Math.min(pic.left + pic.width, Math.ceil(x1 * W + mx));
  const bottom = Math.min(pic.top + pic.height, Math.ceil(y1 * H + my));
  if (right - left < 16 || bottom - top < 16) return pic;
  return { left, top, width: right - left, height: bottom - top };
}

/** Crop (see cropRect) → pad to square on white → 1024×1024 PNG, plus a 384 px JPEG thumbnail. */
export async function cropForModel(jpeg: Buffer, bbox: Box): Promise<CropOut> {
  const upright = await sharp(jpeg).rotate().toBuffer();
  const { width: W = 0, height: H = 0 } = await sharp(upright).metadata();
  if (!W || !H) throw new Error('could not read image size');
  const region = await sharp(upright).extract(cropRect(bbox, await contentRect(upright), W, H)).toBuffer();
  const square = sharp(region).resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).flatten({ background: '#ffffff' });
  const png1024 = await square.png().toBuffer();
  return { png1024, thumbJpeg: await toThumb(png1024) };
}

/** 384 px JPEG on white; a cutout's transparent background turns white. */
export function toThumb(png: Buffer): Promise<Buffer> {
  return sharp(png).flatten({ background: '#ffffff' }).resize(384, 384, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
}

/** Mean RGB difference (0..255) between a cutout's opaque pixels and the same pixels of the image it came from; Infinity when nothing is opaque. */
export async function cutoutDrift(original: Buffer, cut: Buffer): Promise<number> {
  const S = 256;
  const a = await sharp(original).flatten({ background: '#ffffff' }).toColourspace('srgb').resize(S, S, { fit: 'fill' }).raw().toBuffer();
  const b = await sharp(cut).toColourspace('srgb').ensureAlpha().resize(S, S, { fit: 'fill' }).raw().toBuffer();
  let sum = 0, opaque = 0;
  for (let i = 0; i < S * S; i++) {
    if (b[i * 4 + 3]! < 128) continue;
    opaque++;
    for (let c = 0; c < 3; c++) sum += Math.abs(a[i * 3 + c]! - b[i * 4 + c]!);
  }
  return opaque ? sum / opaque / 3 : Number.POSITIVE_INFINITY;
}

const isGreen = (r: number, g: number, b: number) => g > r && g > b && g - Math.min(r, b) > 0.25 * g;

/**
 * The cutout paints the hand green; remove-background can keep that paint, so drop green pixels that were not green in the original.
 * Dropped pixels become transparent white, as remove-background leaves its own background: Stable Fast 3D built flaps from transparent green.
 */
export async function keyOutPaint(original: Buffer, cut: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(cut).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = await sharp(original).flatten({ background: '#ffffff' }).toColourspace('srgb').resize(info.width, info.height, { fit: 'fill' }).raw().toBuffer();
  for (let i = 0; i < info.width * info.height; i++) {
    const p = i * 4, q = i * 3;
    if (isGreen(data[p]!, data[p + 1]!, data[p + 2]!) && !isGreen(o[q]!, o[q + 1]!, o[q + 2]!)) data.fill(255, p, p + 3).fill(0, p + 3, p + 4);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}
