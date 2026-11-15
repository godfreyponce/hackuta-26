// Chert REST client: when_busy queue (1d078dd), 202 = queued, failure reasons from events (review #5).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createCall, getEvents } from '../src/chert.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return calls;
}

const call = { destination: '+15555550123', livekitUrl: 'wss://x', participantToken: 'jwt', remoteIdentity: 'quartermaster' };

test('create sends when_busy queue and the agent identity', async () => {
  const calls = stubFetch(() => Response.json({ data: { id: 'c1' } }, { status: 201 }));
  const r = await createCall(call, 'key-1');
  assert.deepEqual(r, { id: 'c1', queued: false });
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.when_busy, 'queue');
  assert.equal(body.remote_participant_identity, 'quartermaster');
});

test('202 means queued on the shared line', async () => {
  stubFetch(() => Response.json({ data: { id: 'c2', status: 'queued' } }, { status: 202 }));
  assert.deepEqual(await createCall(call, 'key-2'), { id: 'c2', queued: true });
});

test('no retry after the session is cancelled', async () => {
  const calls = stubFetch(() => { throw new TypeError('fetch failed'); });
  let cancelled = false;
  setTimeout(() => { cancelled = true; }, 100);
  await assert.rejects(createCall(call, 'key-3', () => cancelled));
  assert.equal(calls.length, 1);
});

test('events carry the failure reason', async () => {
  stubFetch(() => Response.json({ data: [
    { id: 'e1', type: 'bridge_ready' },
    { id: 'e2', type: 'failed', data: { reason: 'several_audio' } },
    { id: 'e3', event_type: 'ended', reason: 'remote_hangup' },
  ] }));
  const evs = await getEvents('c1');
  assert.deepEqual(evs.map((e) => [e.type, e.reason]), [['bridge_ready', undefined], ['failed', 'several_audio'], ['ended', 'remote_hangup']]);
});
