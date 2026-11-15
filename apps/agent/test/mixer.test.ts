// Face box: the game room gets the Quartermaster's voice alone. The player's own mic must never come back to the laptop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mixFrame } from '../src/mixer.ts';

const tone = (n: number, amp: number, hz: number) => Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 48_000)));

test('voice carries the TTS samples exactly, with no player mic in it', () => {
  const tts = Float32Array.from(tone(480, 6000, 220));
  const mic = tone(480, 8000, 440);
  const { voice, out } = mixFrame(tts, mic, 1, 1);
  assert.deepEqual([...voice], [...tts]);
  assert.notDeepEqual([...out], [...mixFrame(tts, new Int16Array(480), 1, 1).out], 'the phone mix still has the mic in it');
});

test('voice is silent while only the player talks', () => {
  const { voice, out } = mixFrame(new Float32Array(480), tone(480, 8000, 440), 1, 1);
  assert.ok(voice.every((v) => v === 0));
  assert.ok(out.some((v) => Math.abs(v) > 1000), 'the phone still hears the player');
});

test('the phone mix ducks the mic toward the target gain', () => {
  const mic = new Int16Array(480).fill(8000);
  const { gain } = mixFrame(new Float32Array(480), mic, 1, 0.35);
  assert.ok(gain < 1 && gain > 0.35, `gain ${gain}`);
});
