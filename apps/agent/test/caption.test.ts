// Captions burned into agent-video (owner pick: style 5, big short chunks): one short phrase at a time, large heavy
// black sans on a small off-white pill, one key word in blue, near the bottom of the game. Each chunk sits whole
// inside the game (above the bottom letterbox bar of the 3:2 frame) and leaves no pixels behind once it clears.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { dispose, type VideoFrame } from '@livekit/rtc-node';
import { LINES } from '../src/lines.ts';
import { AGENT_H, AGENT_W, CAPTION_LINGER_MS, CHUNK_MAX_CHARS, captionChunks, drawCaption, GAME_BOTTOM, keyWord, renderCaption, SPEECH_CHARS_PER_S, VideoRelay } from '../src/video.ts';

/** Grey frame, caption chunk drawn: bounding box of every changed pixel (the pill), and the count of blue pixels. */
async function pillBox(chunk: string) {
  const frame = new Uint8Array(AGENT_W * AGENT_H * 4).fill(128);
  const caption = await renderCaption(chunk);
  drawCaption(frame, caption);
  let minX = AGENT_W, maxX = -1, minY = AGENT_H, maxY = -1, blue = 0;
  for (let y = 0; y < AGENT_H; y++) for (let x = 0; x < AGENT_W; x++) {
    const i = (y * AGENT_W + x) * 4;
    if (frame[i] !== 128 || frame[i + 1] !== 128 || frame[i + 2] !== 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (frame[i + 2]! > 200 && frame[i]! < 120) blue++;
  }
  return { frame, caption, minX, maxX, minY, maxY, blue };
}

const SIDE = 16; // the pill must not touch the frame edges
const quip = 'Behold, the Enchanted Golden Frying Pan of the Western Isles, forged in fire and fury, heavier than it looks and twice as mean as a suitor on a bad day!';
const longWord = 'Behold the Antidisestablishmentarianismophobicbroomstickofdoom, Telemachus!';
const TEXTS = [...Object.values(LINES).flat(), quip, longWord, 'W'.repeat(22), 'm'.repeat(22), 'Behold the Megasledgehammer of doom!', 'Your Enchanted Golden Frying Pan of Ithaca just flattened a suitor. Ha!'];

test('every fixed line and a long forge quip: one short line per chunk, pill whole inside the game, nothing in the bottom bar', async () => {
  for (const text of TEXTS) {
    for (const chunk of captionChunks(text)) {
      assert.ok(chunk.length >= 1 && chunk.length <= CHUNK_MAX_CHARS, `${text}: chunk "${chunk}" is ${chunk.length} chars`);
      const b = await pillBox(chunk);
      assert.ok(b.maxX >= 0 && b.minX >= SIDE && b.maxX < AGENT_W - SIDE, `${chunk}: pill x ${b.minX}..${b.maxX}`);
      assert.ok(b.minY >= AGENT_H / 2, `${chunk}: pill starts at y ${b.minY}`);
      assert.ok(b.maxY < GAME_BOTTOM, `${chunk}: pill ends at y ${b.maxY}`);
    }
  }
});

test('a chunk ends at a phrase break: a chunk never runs on past a sentence end', () => {
  for (const text of TEXTS) for (const chunk of captionChunks(text)) {
    assert.ok(!/[.!?;:,]\s/.test(chunk), `"${chunk}" runs past a phrase break`);
  }
  assert.deepEqual(captionChunks('Two with one throw!'), ['Two with one throw!']);
  assert.ok(captionChunks(LINES.greeting[0]).includes('Telemachus!'));
});

test('a word that fits on a chunk is never split across two', () => {
  for (const text of TEXTS) {
    const words = new Set(captionChunks(text).flatMap((c) => c.split(' ')));
    for (const w of text.split(/\s+/)) if (w.length <= CHUNK_MAX_CHARS) assert.ok(words.has(w), `"${w}" was split in ${text}`);
  }
});

test('the chunks together are the web subtitle text: nothing cut, no ellipsis added', () => {
  const letters = (t: string) => t.replace(/\s+/g, '');
  for (const text of TEXTS) assert.equal(letters(captionChunks(text).join('')), letters(text));
  assert.equal(quip.length, 152);
});

test('key word: the last word not in NOT_KEY (stand-in for the last noun), drawn in blue', async () => {
  assert.equal(keyWord("Your father's home."), 'home.');
  assert.equal(keyWord('Telemachus!'), 'Telemachus!');
  assert.equal(keyWord('Two with one throw!'), 'throw!');
  assert.equal(keyWord('Hold it up to the camera'), 'camera');
  assert.equal(keyWord('A double! Ha!'), 'double!');
  assert.equal(keyWord('Wave cleared.'), 'Wave');
  assert.equal(keyWord('the camera, nice and steady.'), 'camera,');
  assert.equal(keyWord("I'll tell you when"), undefined, 'a chunk of only small words has no key word');
  assert.ok((await pillBox("Your father's home.")).blue > 100, 'no blue key word pixels');
  assert.equal((await pillBox('Ha!')).blue, 0, 'blue drawn with no key word');
});

test('the caption leaves every row above its band unchanged', async () => {
  const [chunk] = captionChunks('Show me what you\'ve got! Hold it up to the camera, nice and steady.');
  const b = await pillBox(chunk!);
  assert.ok(b.caption.top > AGENT_H / 2, `band starts at ${b.caption.top}`);
  for (let i = 0; i < b.caption.top * AGENT_W * 4; i++) if (b.frame[i] !== 128) assert.fail(`pixel byte ${i} changed above the band`);
});

test('agent-video: caption pixels while a line plays, still there just after its audio ends, gone after the linger', async () => {
  const relay = new VideoRelay();
  let last: VideoFrame | null = null;
  relay.source.captureFrame = (f: VideoFrame) => { last = f; };
  const frame = () => Buffer.from(last!.data);
  await relay.start('Telemachus');
  await sleep(200);
  const plain = frame();
  try {
    relay.showCaption('Wave cleared. Breathe.');
    await sleep(300);
    assert.ok(!frame().equals(plain), 'no caption pixels while the line plays');
    relay.endCaption();
    await sleep(CAPTION_LINGER_MS - 300);
    assert.ok(!frame().equals(plain), 'caption cleared before the linger ended');
    await sleep(600);
    assert.ok(frame().equals(plain), 'caption pixels left after the clear');

    relay.showCaption('Here they come. Steady now.');
    relay.endCaption();
    relay.showCaption('A double! Ha!'); // the old line's clear must not take the new line down
    await sleep(CAPTION_LINGER_MS + 300);
    assert.ok(!frame().equals(plain), 'a newer line was cleared by the older line\'s end');
  } finally {
    await relay.close();
  }
});

test('agent-video: a long line steps through its chunks by character share of its audio, and the last clears after the linger', async () => {
  const chunks = captionChunks(quip);
  assert.ok(chunks.length >= 3, `${chunks.length} chunks`);
  // The quip at the measured speech rate. A chunk can show up to about 110 ms late (sharp render stalls, measured) and
  // the card frame comes every 67 ms, so each chunk is checked 3/4 of the way through its share.
  const ms = Math.round((quip.length / SPEECH_CHARS_PER_S) * 1000), perChar = ms / chunks.reduce((n, p) => n + p.length, 0);
  const starts = chunks.map((_, i) => chunks.slice(0, i).reduce((n, p) => n + p.length * perChar, 0));
  const relay = new VideoRelay();
  let last: VideoFrame | null = null;
  relay.source.captureFrame = (f: VideoFrame) => { last = f; };
  const frame = () => Buffer.from(last!.data);
  await relay.start('Telemachus');
  await sleep(200);
  const plain = frame();
  try {
    const t0 = Date.now();
    relay.showCaption(quip, ms);
    const seen: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const end = i + 1 < chunks.length ? starts[i + 1]! : ms;
      await sleep(t0 + starts[i]! + 0.75 * (end - starts[i]!) - Date.now());
      seen.push(frame());
    }
    for (const [i, f] of seen.entries()) {
      assert.ok(!f.equals(plain), `chunk ${i + 1}: no caption`);
      if (i) assert.ok(!f.equals(seen[i - 1]!), `chunk ${i + 1} still shows chunk ${i}`);
    }
    await sleep(t0 + ms - Date.now());
    relay.endCaption();
    await sleep(CAPTION_LINGER_MS - 300);
    assert.ok(frame().equals(seen.at(-1)!), 'the last chunk left before the linger ended');
    await sleep(600);
    assert.ok(frame().equals(plain), 'caption pixels left after the last chunk cleared');
  } finally {
    await relay.close();
  }
});

after(() => dispose());
