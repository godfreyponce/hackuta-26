import sharp from 'sharp';

export interface CropOut { png1024: Buffer; thumbJpeg: Buffer }

/** bbox ⊕ 15% margin → pad to square on white → 1024×1024 PNG, plus a 384 px JPEG thumbnail. */
export async function cropForModel(jpeg: Buffer, bbox: [number, number, number, number]): Promise<CropOut> {
  const img = sharp(jpeg).rotate();
  const meta = await img.metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  if (!W || !H) throw new Error('could not read image size');
  const [x0, y0, x1, y1] = bbox;
  const bw = (x1 - x0) * W, bh = (y1 - y0) * H;
  const mx = bw * 0.15, my = bh * 0.15;
  const left = Math.max(0, Math.floor(x0 * W - mx));
  const top = Math.max(0, Math.floor(y0 * H - my));
  const right = Math.min(W, Math.ceil(x1 * W + mx));
  const bottom = Math.min(H, Math.ceil(y1 * H + my));
  const width = Math.max(16, right - left), height = Math.max(16, bottom - top);
  const region = await sharp(jpeg).rotate()
    .extract({ left: Math.min(left, W - width), top: Math.min(top, H - height), width: Math.min(width, W), height: Math.min(height, H) })
    .toBuffer();
  const square = sharp(region).resize(1024, 1024, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).flatten({ background: '#ffffff' });
  const png1024 = await square.clone().png().toBuffer();
  const thumbJpeg = await square.clone().resize(384, 384).jpeg({ quality: 82 }).toBuffer();
  return { png1024, thumbJpeg };
}
