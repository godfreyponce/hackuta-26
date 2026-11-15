import { env } from '../env';
import { log } from '../log';
import { errMsg } from '../util';

const STABILITY = 'https://api.stability.ai/v2beta';

export class Model3dError extends Error {}

function isGlb(buf: Buffer): boolean {
  return buf.length > 20 && buf.subarray(0, 4).toString('ascii') === 'glTF';
}

/**
 * Optional: redraw the object as a clean product shot (removes the hand). Measured ~3.5 s, 4 credits.
 * Falls back to the original crop on any failure.
 */
async function cleanImage(png: Buffer, objectName: string, signal: AbortSignal): Promise<Buffer> {
  try {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'crop.png');
    form.append('mode', 'image-to-image');
    form.append('strength', '0.8');
    form.append('model', 'sd3.5-large-turbo');
    form.append('output_format', 'png');
    form.append('prompt', `a ${objectName}, whole object visible, product photo, centered, isolated on a pure white background, soft studio lighting`);
    form.append('negative_prompt', 'hand, fingers, person, face, room, clutter');
    const res = await fetch(`${STABILITY}/stable-image/generate/sd3`, {
      method: 'POST', headers: { authorization: `Bearer ${env.STABILITY_API_KEY}`, accept: 'image/*' }, body: form, signal,
    });
    if (res.status !== 200) {
      log.warn({ status: res.status, body: (await res.text()).slice(0, 300) }, 'clean image failed, using raw crop');
      return png;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log.warn({ err: errMsg(e) }, 'clean image errored, using raw crop');
    return png;
  }
}

/** 1024×1024 PNG → GLB via Stable Fast 3D (or SPAR). Throws Model3dError on any failure or timeout. */
export async function generateGlb(png1024: Buffer, objectName: string): Promise<Buffer> {
  if (env.MODEL3D_PROVIDER !== 'stability' || !env.STABILITY_API_KEY) throw new Model3dError('3d provider disabled');
  const signal = AbortSignal.timeout(env.SF3D_TIMEOUT_MS);
  const started = performance.now();
  const input = env.FORGE_CLEAN_IMAGE === '1' ? await cleanImage(png1024, objectName, signal) : png1024;

  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(input)], { type: 'image/png' }), 'object.png');
  form.append('texture_resolution', env.SF3D_TEXTURE_RES);
  form.append('foreground_ratio', '0.85');
  form.append('remesh', 'none');
  const endpoint = env.FORGE_3D_MODEL === 'spar' ? 'stable-point-aware-3d' : 'stable-fast-3d';
  let res: Response;
  try {
    res = await fetch(`${STABILITY}/3d/${endpoint}`, {
      method: 'POST', headers: { authorization: `Bearer ${env.STABILITY_API_KEY}` }, body: form, signal,
    });
  } catch (e) {
    throw new Model3dError(`stability request failed: ${errMsg(e)}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) throw new Model3dError(`stability HTTP ${res.status}: ${body.toString('utf8').slice(0, 300)}`);
  if (!isGlb(body)) throw new Model3dError('stability response is not a GLB');
  log.info({ endpoint, ms: Math.round(performance.now() - started), kb: Math.round(body.length / 1024) }, '3d model generated');
  return body;
}
