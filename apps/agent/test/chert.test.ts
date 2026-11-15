// Chert REST client: when_busy queue (1d078dd), 202 = queued, failure reasons from events (review #5).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { chertEventKind, createCall, getEvents, isQueuedStatus } from '../src/chert.ts';

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
  assert.deepEqual(r, { id: 'c1', queued: false, status: undefined });
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.when_busy, 'queue');
  assert.equal(body.remote_participant_identity, 'quartermaster');
});

test('202 means queued on the shared line', async () => {
  stubFetch(() => Response.json({ data: { id: 'c2', status: 'queued' } }, { status: 202 }));
  assert.deepEqual(await createCall(call, 'key-2'), { id: 'c2', queued: true, status: 'queued' });
});

test('after a cancel, one more try with the same key, so the id of a call Chert already made is learned (review 2 #1)', async () => {
  let n = 0;
  const calls = stubFetch(() => { if (n++ === 0) throw new TypeError('fetch failed'); return Response.json({ data: { id: 'c3' } }, { status: 201 }); });
  assert.deepEqual(await createCall(call, 'key-3', () => true), { id: 'c3', queued: false, status: undefined });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']), ['key-3', 'key-3']);
});

test('after a cancel, only one more try', async () => {
  const calls = stubFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(createCall(call, 'key-4', () => true));
  assert.equal(calls.length, 2);
});

test('only a queued status means still queued (review 2 #4)', () => {
  for (const s of ['queued', 'QUEUED', 'call.queued']) assert.equal(isQueuedStatus(s), true, s);
  for (const s of ['allocating', 'dialing', 'active', 'ended']) assert.equal(isQueuedStatus(s), false, s);
});

test('the status the 202 reported still means queued, whatever its name', () => {
  assert.equal(isQueuedStatus('allocating', 'allocating'), true);
  assert.equal(isQueuedStatus('dialing', 'allocating'), false);
});

test('informational events that merely contain an end word do not end the call (review 3 #2)', () => {
  for (const t of ['remote_video_failed', 'dial_completed', 'ring_ended', 'call.cancel_requested']) assert.equal(chertEventKind(t) === 'ended' || chertEventKind(t) === 'failed', false, t);
});

test('event kinds, including the terminal names the reference loop uses', () => {
  const kinds = Object.fromEntries(['bridge_ready', 'call.started', 'ringing', 'call.queued', 'call.created', 'remote_video_unavailable',
    'ended', 'call.ended', 'call.completed', 'call.cancelled', 'failed', 'call.failed', 'call.declined'].map((t) => [t, chertEventKind(t)]));
  assert.deepEqual(kinds, {
    bridge_ready: 'ready', 'call.started': 'ready', ringing: 'ringing', 'call.queued': 'other', 'call.created': 'other',
    remote_video_unavailable: 'no_video', ended: 'ended', 'call.ended': 'ended', 'call.completed': 'ended', 'call.cancelled': 'ended',
    failed: 'failed', 'call.failed': 'failed', 'call.declined': 'failed',
  });
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
