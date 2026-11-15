// Forge quips come from the vision model and can hold emoji. With U+FE0F or U+FE0E, Pango aborts the whole process
// (exit 133, "Could not load fallback font"), so this file stays apart from caption.test.ts: a crash here fails only
// these tests.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { dispose } from '@livekit/rtc-node';
import { CHUNK_MIN_MS, captionChunks, chunkStarts, renderCaption } from '../src/video.ts';

const same = async (a: string, b: string) => Buffer.from((await renderCaption(a)).data).equals(Buffer.from((await renderCaption(b)).data));

test('emoji with a variation selector render without a crash, and draw nothing (no black blobs)', async () => {
  for (const e of ['⚔️', '❤️', '🛡️', '🗡️', '⚔︎']) assert.ok(await same(`${e} Behold`, 'Behold'), e);
  for (const e of ['🔥', '😀', '👍🏽', '🇺🇸', '👨‍👩‍👧']) assert.ok(await same(`Behold ${e}`, 'Behold'), e);
  assert.ok(await same('Behold \u0001 axe', 'Behold axe'), 'a control character (invalid in the SVG) blanks the caption');
});

test('chunks drop emoji but keep the words and the symbols the font draws', () => {
  assert.deepEqual(captionChunks('⚔️ Behold, the Axe! 🛡️🛡️'), ['Behold,', 'the Axe!']);
  assert.deepEqual(captionChunks('Acme™ blade ©'), ['Acme™ blade ©']);
  assert.deepEqual(captionChunks('❤️ 🔥'), []);
});

test('a very short chunk (like "I,") shows at least CHUNK_MIN_MS, and later chunks catch up to the audio', () => {
  // 'I,' at the measured 16 chars/s alone gets 125 ms.
  const starts = chunkStarts(['I,', 'the Quartermaster,', 'will help you.'], 1000 / 16);
  assert.equal(starts[0], 0);
  assert.equal(starts[1], CHUNK_MIN_MS);
  assert.equal(starts[2], (2 + 18) * (1000 / 16), 'the third chunk starts on its audio time');
  // Many tiny chunks: the minimum must not push any start past the line's audio end, or the clear cancels it unseen.
  const tiny = chunkStarts(Array(12).fill('No,'), 79);
  assert.ok(tiny.every((t) => t <= 12 * 3 * 79), `starts ${tiny.join(' ')}`);
});

after(() => dispose());
