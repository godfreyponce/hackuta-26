import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { FULL_FRAME, toUnitBox, visionResultSchema } from '../src/ai/vision';
import { contentRect, cropForModel, cropRect } from '../src/ai/image';

const close = (got: number[], want: number[]) =>
  got.forEach((g, i) => assert.ok(Math.abs(g - want[i]!) < 1e-9, `${got} vs ${want}`));

test('Gemini box_2d [ymin,xmin,ymax,xmax] in 0..1000 maps to [x0,y0,x1,y1] in 0..1', () => {
  // call 8 chopstick: Gemini answered [173,461,663,482]; the stick stands at x 0.46 to 0.48
  close(toUnitBox([173, 461, 663, 482], 'yx'), [0.461, 0.173, 0.482, 0.663]);
});

test('an xy box in 0..1000 is scaled to 0..1', () => {
  close(toUnitBox([308, 49, 691, 869], 'xy'), [0.308, 0.049, 0.691, 0.869]);
});

test('a 0..1 box passes through, corners in any order', () => {
  close(toUnitBox([0.5, 0.8, 0.2, 0.1], 'xy'), [0.2, 0.1, 0.5, 0.8]);
});

test('values past the edge are clamped', () => {
  close(toUnitBox([0.25, 0.1, 1.05, 0.95], 'xy'), [0.25, 0.1, 1, 0.95]);
  close(toUnitBox([-20, 100, 1200, 900], 'xy'), [0, 0.1, 1, 0.9]);
});

test('a missing, short, non-numeric or tiny box becomes the full frame', () => {
  assert.deepEqual(toUnitBox(undefined, 'yx'), FULL_FRAME);
  assert.deepEqual(toUnitBox([1, 2, 3], 'xy'), FULL_FRAME);
  assert.deepEqual(toUnitBox([0.1, Number.NaN, 0.2, 0.3], 'xy'), FULL_FRAME);
  assert.deepEqual(toUnitBox([500, 500, 505, 505], 'yx'), FULL_FRAME);
  // the old bug: every 0..1000 value clamped to 1 gave [1,1,1,1]
  assert.deepEqual(toUnitBox([1, 1, 1, 1], 'xy'), FULL_FRAME);
});

test('the shared schema scales a 0..1000 bbox', () => {
  const v = visionResultSchema.parse({
    is_object: true, object_name: 'Mug', display_name: 'Cup', weapon_class: 'potion',
    bbox: [308, 49, 691, 869], confidence: 0.9, quip: 'q',
  });
  close(v.bbox, [0.308, 0.049, 0.691, 0.869]);
});

const content = { left: 397, top: 0, width: 486, height: 720 };

test('cropRect clips the box to the picture area', () => {
  const r = cropRect([0, 0.1, 0.5, 0.5], content, 1280, 720);
  assert.equal(r.left, 397);
  assert.ok(r.left + r.width <= 397 + 486);
});

test('cropRect uses the whole picture area for a full-frame box', () => {
  assert.deepEqual(cropRect(FULL_FRAME, content, 1280, 720), content);
});

test('cropRect uses the picture area when the box lies in the black bars', () => {
  assert.deepEqual(cropRect([0.9, 0.1, 0.99, 0.9], content, 1280, 720), content);
});

test('contentRect finds the picture inside black bars', async () => {
  const pic = await sharp({ create: { width: 486, height: 720, channels: 3, background: '#c8b49a' } }).png().toBuffer();
  const frame = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#000' } })
    .composite([{ input: pic, left: 397, top: 0 }]).jpeg().toBuffer();
  const r = await contentRect(frame);
  assert.ok(Math.abs(r.left - 397) <= 2 && Math.abs(r.width - 486) <= 4, JSON.stringify(r));
  assert.equal(r.top, 0);
  assert.equal(r.height, 720);
});

test('contentRect ignores a speck smaller than 16 px', async () => {
  const dot = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
  const frame = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#000' } })
    .composite([{ input: dot, left: 600, top: 300 }]).png().toBuffer();
  assert.deepEqual(await contentRect(frame), { left: 0, top: 0, width: 1280, height: 720 });
});

test('contentRect and cropForModel follow the EXIF rotation', async () => {
  const pic = await sharp({ create: { width: 486, height: 720, channels: 3, background: '#c8b49a' } }).png().toBuffer();
  const frame = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#000' } })
    .composite([{ input: pic, left: 397, top: 0 }]).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const r = await contentRect(frame);
  assert.equal(r.width, 720, JSON.stringify(r));
  assert.ok((await cropForModel(frame, FULL_FRAME)).png1024.length > 0);
});

test('contentRect returns the whole image when there are no bars', async () => {
  const frame = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c8b49a' } }).jpeg().toBuffer();
  assert.deepEqual(await contentRect(frame), { left: 0, top: 0, width: 640, height: 480 });
});

test('the schema keeps the object color, short and trimmed, and defaults it to empty', () => {
  const base = { is_object: true, object_name: 'pen', display_name: 'Quill', weapon_class: 'spear', bbox: [0, 0, 1, 1], confidence: 0.9, quip: 'q' };
  assert.equal(visionResultSchema.parse({ ...base, color: '  Black plastic and silver metal ' }).color, 'black plastic and silver metal');
  assert.equal(visionResultSchema.parse({ ...base, color: 'x'.repeat(200) }).color.length, 60);
  assert.equal(visionResultSchema.parse(base).color, '');
});
