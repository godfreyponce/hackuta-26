import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { redrawPrompt } from '../src/ai/model3d';
import { cutoutDrift } from '../src/ai/image';

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
