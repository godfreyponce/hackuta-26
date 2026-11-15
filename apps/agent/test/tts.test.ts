// Review #8: a TTS body that stalls after the headers must end the stream, not hang it.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CHUNK_IDLE_MS, ttsStream } from '../src/tts.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a stalled body throws after the idle timeout', async () => {
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(960));
        init.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const t0 = Date.now();
  let chunks = 0;
  await assert.rejects(async () => { for await (const _ of ttsStream('hi')) chunks++; });
  assert.equal(chunks, 1);
  assert.ok(Date.now() - t0 < CHUNK_IDLE_MS + 1_000);
});
