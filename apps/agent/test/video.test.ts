// cropRgba with the crops used live: a crash here kills the agent mid-call (live 1, CALLER_CROP 0.32,0.09,0.68,0.80).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { dispose, VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { AGENT_H, AGENT_W, cropRgba, letterbox, relayable, titleCard } from '../src/video.ts';

const SIZES = [[1280, 720], [960, 540], [640, 360], [480, 270], [320, 180], [160, 90]] as const;
const CROPS: Array<[number, number, number, number]> = [[0.08, 0.12, 0.92, 0.88], [0.32, 0.09, 0.68, 0.8]];

test('a crop of any stream size gives a valid RGBA frame that converts to I420', () => {
  for (const crop of CROPS) for (const [w, h] of SIZES) for (const i420 of [false, true]) {
    let f = new VideoFrame(new Uint8Array(w * h * 4).fill(100), w, h, VideoBufferType.RGBA);
    if (i420) f = f.convert(VideoBufferType.I420);
    const c = cropRgba(f, crop);
    assert.equal(c.data.length, c.width * c.height * 4, `${crop} ${w}x${h} i420=${i420}`);
    const back = c.convert(VideoBufferType.I420);
    assert.equal(back.width, c.width);
  }
});

test('a tiny frame (WebRTC sent 8x8 when the caller republished) is not relayed: its crop would round to width 0 and abort libwebrtc (live 1)', () => {
  const tiny = cropRgba(new VideoFrame(new Uint8Array(8 * 8 * 4), 8, 8, VideoBufferType.RGBA), [0.32, 0.09, 0.68, 0.8]);
  assert.equal(relayable(tiny), false);
  const live = cropRgba(new VideoFrame(new Uint8Array(1280 * 720 * 4), 1280, 720, VideoBufferType.RGBA), [0.32, 0.09, 0.68, 0.8]);
  assert.equal(relayable(live), true);
});

// Call 3: FaceTime showed agent-video cropped to about 3:2 (the phone and the Mac self-view both cut the 640x360 game
// to source x 51..588, about 8% off each side). A 3:2 frame with the game letterboxed inside keeps every game pixel.
test('agent-video is 3:2 with a size libwebrtc keeps (multiple of 4)', () => {
  assert.ok(Math.abs(AGENT_W / AGENT_H - 1.5) < 0.01, `${AGENT_W}x${AGENT_H}`);
  assert.equal(AGENT_W % 4, 0);
  assert.equal(AGENT_H % 4, 0);
});

/** RGBA frame with a red left column, a blue right column, a green top row and a white bottom row on grey. */
function marked(w: number, h: number, i420 = false): VideoFrame {
  const d = new Uint8Array(w * h * 4).fill(128);
  const put = (x: number, y: number, c: number[]) => d.set([...c, 255], (y * w + x) * 4);
  for (let y = 0; y < h; y++) { put(0, y, [255, 0, 0]); put(w - 1, y, [0, 0, 255]); }
  for (let x = 1; x < w - 1; x++) { put(x, 0, [0, 255, 0]); put(x, h - 1, [255, 255, 255]); }
  const f = new VideoFrame(d, w, h, VideoBufferType.RGBA);
  return i420 ? f.convert(VideoBufferType.I420) : f;
}
const px = (f: VideoFrame, x: number, y: number) => Array.from(f.data.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 3));

test('letterbox keeps the whole game frame: all four edges visible, black bars outside', () => {
  for (const [w, h] of [[640, 360], [1280, 720], [480, 270], [320, 180]] as const) {
    const out = letterbox(marked(w, h), AGENT_W, AGENT_H);
    assert.equal(out.width, AGENT_W); assert.equal(out.height, AGENT_H);
    assert.equal(out.data.length, AGENT_W * AGENT_H * 4);
    const mid = AGENT_H >> 1;
    assert.deepEqual(px(out, 0, mid), [255, 0, 0], `${w}x${h} left edge`);
    assert.deepEqual(px(out, AGENT_W - 1, mid), [0, 0, 255], `${w}x${h} right edge`);
    const gameH = Math.round((AGENT_W * h) / w), top = (AGENT_H - gameH) >> 1;
    assert.deepEqual(px(out, AGENT_W >> 1, 0), [0, 0, 0], `${w}x${h} top bar`);
    assert.deepEqual(px(out, AGENT_W >> 1, AGENT_H - 1), [0, 0, 0], `${w}x${h} bottom bar`);
    assert.deepEqual(px(out, AGENT_W >> 1, top), [0, 255, 0], `${w}x${h} first game row`);
    assert.deepEqual(px(out, AGENT_W >> 1, top + gameH - 1), [255, 255, 255], `${w}x${h} last game row`);
    assert.equal(out.convert(VideoBufferType.I420).width, AGENT_W);
  }
});

test('letterbox takes I420 input and pillarboxes a portrait frame', () => {
  const out = letterbox(marked(360, 640, true), AGENT_W, AGENT_H);
  assert.equal(out.width, AGENT_W); assert.equal(out.height, AGENT_H);
  assert.deepEqual(px(out, 0, AGENT_H >> 1), [0, 0, 0]);
  assert.deepEqual(px(out, AGENT_W - 1, AGENT_H >> 1), [0, 0, 0]);
});

// Review #4: at 40 px the title "Calling Warrior <name>…" ran off both sides for names over about 11 characters, and
// POST /api/friends allows up to 40. A U+FE0F in a name made Pango abort the agent in captions (fa36d1b); same font path.
test('the title card fits any allowed friend name inside the frame', async () => {
  const SIDE = 16;
  for (const name of ['Bo', 'Godfrey', 'Maximilian Alexander', 'W'.repeat(40), 'Ana\u2694\uFE0F\u{1F600}']) {
    const f = await titleCard(`Calling Warrior ${name}…`, 'Odysseus is home, and he wants a fight.');
    const bg = px(f, 0, 0);
    for (let y = 0; y < AGENT_H; y++) for (let s = 0; s < SIDE; s++) {
      assert.deepEqual(px(f, s, y), bg, `${name}: text at x ${s}, y ${y}`);
      assert.deepEqual(px(f, AGENT_W - 1 - s, y), bg, `${name}: text at x ${AGENT_W - 1 - s}, y ${y}`);
    }
  }
});

after(() => dispose());
