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
    return { left: Math.abs(info.trimOffsetLeft ?? 0), top: Math.abs(info.trimOffsetTop ?? 0), width: info.width, height: info.height };
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
  const png1024 = await square.clone().png().toBuffer();
  const thumbJpeg = await square.clone().resize(384, 384).jpeg({ quality: 82 }).toBuffer();
  return { png1024, thumbJpeg };
}
