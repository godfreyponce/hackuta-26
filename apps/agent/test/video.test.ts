// cropRgba with the crops used live: a crash here kills the agent mid-call (live 1, CALLER_CROP 0.32,0.09,0.68,0.80).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { dispose, VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { cropRgba, relayable } from '../src/video.ts';

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

after(() => dispose());
