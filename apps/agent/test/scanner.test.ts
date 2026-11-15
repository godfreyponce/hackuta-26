// Review #3: spec D.3 replies 202 {forgeId, objectName, ...} with no `detected` field. That is a hit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseForgeReply } from '../src/scanner.ts';

const d3 = { forgeId: 'f1', objectName: 'frying pan', displayName: 'Pan of Godfrey', weaponClass: 'blunt', quip: 'Forging now.' };

test('202 with forgeId and no detected field is a hit', () => {
  assert.deepEqual(parseForgeReply(202, d3), d3);
});

test('202 with detected:true is a hit', () => {
  assert.equal(parseForgeReply(202, { detected: true, ...d3 })?.forgeId, 'f1');
});

test('200 no_object and 200 busy are misses', () => {
  assert.equal(parseForgeReply(200, { detected: false, reason: 'no_object' }), null);
  assert.equal(parseForgeReply(200, { detected: false, reason: 'busy' }), null);
});

test('202 without forgeId is a miss', () => {
  assert.equal(parseForgeReply(202, { objectName: 'pan' }), null);
});

import { dispose, VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import { after } from 'node:test';
import { CallerScanner } from '../src/scanner.ts';

const grey = (v: number) => new VideoFrame(new Uint8Array(1280 * 720 * 4).fill(v), 1280, 720, VideoBufferType.RGBA);
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; return dispose(); });

/** Replies `miss` until `hitOn` calls, then a 202 hit; records when each call came. */
function stubForge(hitOn: number, miss: string): number[] {
  const calls: number[] = [];
  const t0 = Date.now();
  globalThis.fetch = (async () => {
    calls.push(Date.now() - t0);
    return calls.length >= hitOn
      ? new Response(JSON.stringify({ detected: true, ...d3 }), { status: 202 })
      : new Response(JSON.stringify({ detected: false, reason: miss }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

// Call 3 frames with the mug clearly held: Gemini said no_object on 5 of 23 that look the same as the hits. A held
// mug changed under 2% between frames in 18 of 80 pairs 1 to 2 s apart, so the old same-picture rule skipped retries.
/** A scanner that does not save tuning captures into dev/captures. */
function scanner(): CallerScanner {
  const s = new CallerScanner('aaaaaaaaaaaaaaaaaaaaaaaa');
  (s as unknown as { saved: number }).saved = 3;
  return s;
}

test('after no_object, the same picture is sent again on the next tick (Gemini misses a held object at random)', async () => {
  const s = scanner();
  s.offer(grey(128));
  const calls = stubForge(2, 'no_object');
  const hit = await s.scan();
  assert.equal(hit?.forgeId, 'f1');
  assert.ok(calls[1]! < 1_500, `second try at ${calls[1]} ms`);
});

test('an unchanged picture is re-sent only once after no_object (frozen video must not cost a call every tick)', async () => {
  const s = scanner();
  s.offer(grey(128));
  const calls = stubForge(99, 'no_object');
  setTimeout(() => s.cancel(), 3_000);
  assert.equal(await s.scan(), null);
  assert.equal(calls.length, 2, `calls at ${calls.join(', ')} ms`);
});
