// Captions burned into agent-video: the friend in FaceTime reads what the Quartermaster says. They must sit whole
// inside the 3:2 frame (call 3: FaceTime cut a 16:9 frame to about 3:2) and leave the top of the game alone.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { dispose } from '@livekit/rtc-node';
import { LINES } from '../src/lines.ts';
import { AGENT_H, AGENT_W, drawCaption, renderCaption } from '../src/video.ts';

/** Grey frame, caption drawn, bounding box of the bright (text) pixels. */
async function textBox(text: string) {
  const frame = new Uint8Array(AGENT_W * AGENT_H * 4).fill(128);
  const caption = await renderCaption(text);
  drawCaption(frame, caption);
  let minX = AGENT_W, maxX = -1, minY = AGENT_H, maxY = -1;
  for (let y = 0; y < AGENT_H; y++) for (let x = 0; x < AGENT_W; x++) {
    const i = (y * AGENT_W + x) * 4;
    if (frame[i]! > 200 && frame[i + 1]! > 180) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  return { frame, caption, minX, maxX, minY, maxY };
}

const SIDE = 16; // text must not touch the frame edges

test('every fixed line and a long forge quip render whole inside the 3:2 frame, in its lower half', async () => {
  const quip = 'Behold, the Enchanted Golden Frying Pan of the Western Isles, forged in fire and fury, heavier than it looks and twice as mean as a suitor on a bad day!';
  for (const text of [...Object.values(LINES).flat(), quip, 'Your Enchanted Golden Frying Pan of Ithaca just flattened a suitor. Ha!']) {
    const b = await textBox(text);
    assert.ok(b.maxX >= 0 && b.minX >= SIDE && b.maxX < AGENT_W - SIDE, `${text}: text x ${b.minX}..${b.maxX}`);
    assert.ok(b.maxY >= 0 && b.minY >= AGENT_H / 2 && b.maxY < AGENT_H - 4, `${text}: text y ${b.minY}..${b.maxY}`);
  }
});

test('the caption leaves every row above its band unchanged', async () => {
  const b = await textBox('Show me what you\'ve got! Hold it up to the camera, nice and steady.');
  assert.ok(b.caption.top > AGENT_H / 2, `band starts at ${b.caption.top}`);
  for (let i = 0; i < b.caption.top * AGENT_W * 4; i++) if (b.frame[i] !== 128) assert.fail(`pixel byte ${i} changed above the band`);
});

after(() => dispose());
