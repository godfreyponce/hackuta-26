// Captions burned into agent-video: the friend in FaceTime reads what the Quartermaster says. Each page is at most
// 2 lines, sits whole inside the game (above the bottom letterbox bar of the 3:2 frame), and leaves no pixels behind
// once it clears.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { dispose, type VideoFrame } from '@livekit/rtc-node';
import { LINES } from '../src/lines.ts';
import { AGENT_H, AGENT_W, CAPTION_LINGER_MS, captionPages, drawCaption, GAME_BOTTOM, renderCaption, VideoRelay } from '../src/video.ts';

/** Grey frame, caption page drawn, bounding box of the bright (text) pixels. */
async function textBox(lines: string[]) {
  const frame = new Uint8Array(AGENT_W * AGENT_H * 4).fill(128);
  const caption = await renderCaption(lines);
  drawCaption(frame, caption);
  let minX = AGENT_W, maxX = -1, minY = AGENT_H, maxY = -1;
  for (let y = 0; y < AGENT_H; y++) for (let x = 0; x < AGENT_W; x++) {
    const i = (y * AGENT_W + x) * 4;
    if (frame[i]! > 200 && frame[i + 1]! > 180) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  return { frame, caption, minX, maxX, minY, maxY };
}

const SIDE = 16; // text must not touch the frame edges
const quip = 'Behold, the Enchanted Golden Frying Pan of the Western Isles, forged in fire and fury, heavier than it looks and twice as mean as a suitor on a bad day!';
const longWord = 'Behold the Antidisestablishmentarianismophobicbroomstickofdoom, Telemachus!';
const TEXTS = [...Object.values(LINES).flat(), quip, longWord, 'Your Enchanted Golden Frying Pan of Ithaca just flattened a suitor. Ha!'];

test('every fixed line and a long forge quip: pages of at most 2 lines, whole inside the game, nothing in the bottom bar', async () => {
  for (const text of TEXTS) {
    for (const page of captionPages(text)) {
      assert.ok(page.length >= 1 && page.length <= 2, `${text}: page of ${page.length} lines`);
      const b = await textBox(page);
      assert.ok(b.maxX >= 0 && b.minX >= SIDE && b.maxX < AGENT_W - SIDE, `${page.join(' / ')}: text x ${b.minX}..${b.maxX}`);
      assert.ok(b.minY >= AGENT_H / 2, `${page.join(' / ')}: text starts at y ${b.minY}`);
      for (let i = GAME_BOTTOM * AGENT_W * 4; i < b.frame.length; i++) if (b.frame[i] !== 128) assert.fail(`${page.join(' / ')}: pixel byte ${i} changed in the bottom bar`);
    }
  }
});

test('the pages together are the web subtitle text: nothing cut, no ellipsis added', () => {
  const letters = (t: string) => t.replace(/\s+/g, '');
  for (const text of TEXTS) assert.equal(letters(captionPages(text).flat().join('')), letters(text));
  assert.equal(quip.length, 152);
});

test('the caption leaves every row above its band unchanged', async () => {
  const [page] = captionPages('Show me what you\'ve got! Hold it up to the camera, nice and steady.');
  const b = await textBox(page!);
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

test('agent-video: a long line pages through its audio by character share, and the last page clears after the linger', async () => {
  const pages = captionPages(quip);
  assert.ok(pages.length >= 3, `${pages.length} pages`);
  const ms = 2_400, perChar = ms / pages.reduce((n, p) => n + p.join(' ').length, 0);
  const starts = pages.map((_, i) => pages.slice(0, i).reduce((n, p) => n + p.join(' ').length * perChar, 0));
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
    for (let i = 0; i < pages.length; i++) {
      const end = i + 1 < pages.length ? starts[i + 1]! : ms;
      await sleep(t0 + (starts[i]! + end) / 2 - Date.now());
      seen.push(frame());
    }
    for (const [i, f] of seen.entries()) {
      assert.ok(!f.equals(plain), `page ${i + 1}: no caption`);
      if (i) assert.ok(!f.equals(seen[i - 1]!), `page ${i + 1} still shows page ${i}`);
    }
    await sleep(t0 + ms - Date.now());
    relay.endCaption();
    await sleep(CAPTION_LINGER_MS - 300);
    assert.ok(frame().equals(seen.at(-1)!), 'the last page left before the linger ended');
    await sleep(600);
    assert.ok(frame().equals(plain), 'caption pixels left after the last page cleared');
  } finally {
    await relay.close();
  }
});

after(() => dispose());
