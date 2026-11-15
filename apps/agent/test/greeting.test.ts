// Integration run #8: with a bad ElevenLabs key, ensureGreeting retried every 5 s forever and every call got
// tts_not_ready. A 401 or 403 cannot fix itself, so the retry loop must stop.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { env } from '../src/env.ts';
import { ensureLines, linesReady } from '../src/lines.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

for (const status of [401, 403]) {
  test(`ensureLines stops after a ${status} instead of retrying forever`, async () => {
    env.ELEVENLABS_VOICE_ID = `no-cache-test-${status}`; // a cache miss, so the render reaches fetch
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{"detail":{"status":"invalid_api_key"}}', { status }); }) as typeof fetch;
    const stopped = await Promise.race([ensureLines().then(() => true), new Promise((r) => setTimeout(() => r(false), 8_000))]);
    assert.equal(stopped, true, 'still retrying after 8 s');
    assert.equal(calls, 1);
    assert.equal(linesReady(), false);
  });
}
