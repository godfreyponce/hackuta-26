import { env } from '../env';
import { log } from '../log';
import { errMsg } from '../util';
import { cutoutDrift, keyOutPaint } from './image';

const STABILITY = 'https://api.stability.ai/v2beta';

export class Model3dError extends Error {}

function isGlb(buf: Buffer): boolean {
  return buf.length > 20 && buf.subarray(0, 4).toString('ascii') === 'glTF';
}

export function redrawPrompt(objectName: string, color: string): string {
  return `a ${color ? `${color} ${objectName}` : objectName}, whole object visible, product photo, centered, isolated on a pure white background, soft studio lighting`;
}

/** One Stability image call. Null on any failure, so the caller can fall back. */
async function stabilityImage(path: string, fields: Record<string, string>, png: Buffer, signal: AbortSignal): Promise<Buffer | null> {
  try {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'in.png');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`${STABILITY}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${env.STABILITY_API_KEY}`, accept: 'image/*' }, body: form, signal,
    });
    if (res.status !== 200) {
      log.warn({ path, status: res.status, body: (await res.text()).slice(0, 300) }, 'stability image step failed');
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log.warn({ path, err: errMsg(e) }, 'stability image step errored');
    return null;
  }
}

/** Redraw as a product shot without the hand. About 3.5 s, 4 credits. Invents details, so the color comes from vision. */
async function redraw(png: Buffer, v: ModelSubject, signal: AbortSignal): Promise<Buffer> {
  return await stabilityImage('/stable-image/generate/sd3', {
    mode: 'image-to-image', strength: '0.8', model: 'sd3.5-large-turbo', output_format: 'png',
    prompt: redrawPrompt(v.object_name, v.color), negative_prompt: 'hand, fingers, person, face, room, clutter',
  }, png, signal) ?? png;
}

// Mean color drift of cutout vs crop, measured on 5 frames: kept objects 3.8 to 13; a repainted call chopstick 70, a changed mug 41.
const MAX_DRIFT = 25;

/**
 * Keep the object's real pixels: erase the hand, then cut out the background. Measured 9.1 to 12.9 s, 10 credits.
 * The color redraw runs at the same time (4 credits) and is used when the cutout fails, runs past the budget, or repainted the object.
 */
async function cutout(png: Buffer, v: ModelSubject, signal: AbortSignal, budgetMs: number): Promise<Buffer> {
  const backup = redraw(png, v, signal);
  const budget = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
  // A white fill came back as a paper sheet that remove-background kept; green paint can be keyed out. The negative prompt stops it painting plants.
  const noHand = await stabilityImage('/stable-image/edit/search-and-replace', {
    search_prompt: 'hand and fingers', prompt: 'flat solid bright green background',
    negative_prompt: 'plant, leaves, foliage, flower, paper, sheet, fabric, cloth, object', output_format: 'png',
  }, png, budget);
  const removed = noHand && await stabilityImage('/stable-image/edit/remove-background', { output_format: 'png' }, noHand, budget);
  const cut = removed && await keyOutPaint(png, removed).catch(() => null);
  const drift = cut ? await cutoutDrift(png, cut).catch(() => null) : null;
  log.info({ drift: drift === null ? null : Math.round(drift) }, drift !== null && drift < MAX_DRIFT ? 'cutout kept' : 'cutout dropped, using redraw');
  return cut && drift !== null && drift < MAX_DRIFT ? cut : backup;
}

export interface ModelSubject { object_name: string; color: string }

// Fast 3D and SPAR answered in 2.0 to 3.4 s over 16 test calls; the image step gets the rest of SF3D_TIMEOUT_MS.
const MODEL_STEP_MS = 4500;

/** 1024×1024 PNG → GLB via Stable Fast 3D or SPAR, plus the image the model was built from. Throws Model3dError on any failure or timeout. */
export async function generateGlb(png1024: Buffer, v: ModelSubject): Promise<{ glb: Buffer; image: Buffer }> {
  if (env.MODEL3D_PROVIDER !== 'stability' || !env.STABILITY_API_KEY) throw new Model3dError('3d provider disabled');
  const signal = AbortSignal.timeout(env.SF3D_TIMEOUT_MS);
  const started = performance.now();
  const input = env.FORGE_CLEAN_IMAGE === 'cutout' ? await cutout(png1024, v, signal, Math.max(0, env.SF3D_TIMEOUT_MS - MODEL_STEP_MS))
    : env.FORGE_CLEAN_IMAGE === '1' ? await redraw(png1024, v, signal)
    : png1024;
  const prepMs = Math.round(performance.now() - started);

  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(input)], { type: 'image/png' }), 'object.png');
  form.append('texture_resolution', env.SF3D_TEXTURE_RES);
  const endpoint = env.FORGE_3D_MODEL === 'spar' ? 'stable-point-aware-3d' : 'stable-fast-3d';
  // SPAR answers 400 to foreground_ratio below 1, so these two go to Stable Fast 3D only.
  if (endpoint === 'stable-fast-3d') {
    form.append('foreground_ratio', '0.85');
    form.append('remesh', 'none');
  }
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
  log.info({ endpoint, prepMs, ms: Math.round(performance.now() - started), kb: Math.round(body.length / 1024) }, '3d model generated');
  return { glb: body, image: input };
}
