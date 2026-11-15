import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { redrawPrompt } from '../src/ai/model3d';
import { cutoutDrift, keyOutPaint } from '../src/ai/image';

test('the redraw prompt names the real color so a black pen stays black', () => {
  assert.match(redrawPrompt('pen', 'black plastic and silver metal'), /^a black plastic and silver metal pen,/);
  assert.match(redrawPrompt('pen', ''), /^a pen,/);
});

const solid = (w: number, h: number, c: { r: number; g: number; b: number; alpha?: number }) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { alpha: 1, ...c } } }).png().toBuffer();
/** A 512 white square with a brown stick, and a cutout of it whose stick is `stick` and the rest transparent. */
async function pair(stick: { r: number; g: number; b: number }) {
  const orig = await sharp(await solid(512, 512, { r: 255, g: 255, b: 255 }))
    .composite([{ input: await solid(40, 400, { r: 120, g: 70, b: 30 }), left: 236, top: 56 }]).png().toBuffer();
  const cut = await sharp(await solid(512, 512, { r: 0, g: 0, b: 0, alpha: 0 }))
    .composite([{ input: await solid(40, 400, stick), left: 236, top: 56 }]).png().toBuffer();
  return { orig, cut };
}

test('a cutout that kept the real pixels has almost no drift', async () => {
  const { orig, cut } = await pair({ r: 120, g: 70, b: 30 });
  assert.ok((await cutoutDrift(orig, cut)) < 2);
});

test('a cutout that repainted the object drifts far', async () => {
  const { orig, cut } = await pair({ r: 20, g: 20, b: 20 });
  assert.ok((await cutoutDrift(orig, cut)) > 50);
});

test('an empty cutout counts as infinite drift', async () => {
  const orig = await solid(512, 512, { r: 255, g: 255, b: 255 });
  assert.equal(await cutoutDrift(orig, await solid(512, 512, { r: 0, g: 0, b: 0, alpha: 0 })), Number.POSITIVE_INFINITY);
});

/** Opaque pixel count inside a rect of a PNG. */
async function opaqueIn(png: Buffer, x: number, y: number, w: number, h: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().extract({ left: x, top: y, width: w, height: h }).raw().toBuffer({ resolveWithObject: true });
  let n = 0;
  for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3]! > 0) n++;
  return n;
}

test('green paint left where the hand was is cut away, the stick stays', async () => {
  const skin = { r: 200, g: 150, b: 120 };
  const orig = await sharp(await solid(512, 512, { r: 255, g: 255, b: 255 })).composite([
    { input: await solid(40, 400, { r: 120, g: 70, b: 30 }), left: 236, top: 56 },
    { input: await solid(120, 100, skin), left: 276, top: 300 },
  ]).png().toBuffer();
  const cut = await sharp(await solid(512, 512, { r: 0, g: 0, b: 0, alpha: 0 })).composite([
    { input: await solid(40, 400, { r: 120, g: 70, b: 30 }), left: 236, top: 56 },
    { input: await solid(120, 100, { r: 90, g: 200, b: 70 }), left: 276, top: 300 },
  ]).png().toBuffer();
  const keyed = await keyOutPaint(orig, cut);
  assert.equal(await opaqueIn(keyed, 276, 300, 120, 100), 0);
  // Stable Fast 3D built green flaps from transparent pixels that kept their green, so they must turn white like remove-background's.
  const { data } = await sharp(keyed).extract({ left: 300, top: 320, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data], [255, 255, 255, 0]);
  assert.equal(await opaqueIn(keyed, 236, 56, 40, 400), 40 * 400);
});

test('a green object keeps its green pixels', async () => {
  const green = { r: 40, g: 160, b: 60 };
  const orig = await sharp(await solid(512, 512, { r: 255, g: 255, b: 255 }))
    .composite([{ input: await solid(100, 300, green), left: 206, top: 106 }]).png().toBuffer();
  const cut = await sharp(await solid(512, 512, { r: 0, g: 0, b: 0, alpha: 0 }))
    .composite([{ input: await solid(100, 300, green), left: 206, top: 106 }]).png().toBuffer();
  assert.equal(await opaqueIn(await keyOutPaint(orig, cut), 206, 106, 100, 300), 100 * 300);
});
