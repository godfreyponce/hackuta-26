// Chert REST client: when_busy queue (1d078dd), 202 = queued, failure reasons from events (review #5).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { chertEventKind, createCall, endCall, endConfirmed, getEvents, isQueuedStatus, terminalStatus } from '../src/chert.ts';

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

// Coordinator review of 3a6718e.

test('POST /end retries once with the same key on a 5xx (coord #1)', async () => {
  let n = 0;
  const calls = stubFetch(() => Response.json({}, { status: n++ === 0 ? 503 : 202 }));
  assert.equal(await endCall('c1', 'end-1'), 202);
  assert.deepEqual(calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']), ['end-1', 'end-1']);
});

test('POST /end retries once on a network error, then gives up (coord #1)', async () => {
  const calls = stubFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(endCall('c1', 'end-2'));
  assert.equal(calls.length, 2);
});

test('POST /end does not retry a 4xx (coord #1)', async () => {
  const calls = stubFetch(() => Response.json({}, { status: 404 }));
  assert.equal(await endCall('c1', 'end-3'), 404);
  assert.equal(calls.length, 1);
});

test('only 2xx or an already-ended 404/409 lets the recovery record go (coord #1)', () => {
  for (const s of [200, 202, 204, 404, 409]) assert.equal(endConfirmed(s), true, String(s));
  for (const s of [0, 400, 401, 500, 503]) assert.equal(endConfirmed(s), false, String(s));
});

test('events in other shapes still parse (coord #2)', async () => {
  for (const shape of [
    { events: [{ type: 'bridge_ready' }] }, { data: { items: [{ type: 'bridge_ready' }] } },
    { items: [{ type: 'bridge_ready' }] }, [{ type: 'bridge_ready' }],
  ]) {
    stubFetch(() => Response.json(shape));
    assert.deepEqual((await getEvents('c1')).map((e) => e.type), ['bridge_ready'], JSON.stringify(shape));
  }
});

test('bridge_ready anywhere in an unknown shape still counts, as in the dry-run reference (coord #2)', async () => {
  stubFetch(() => Response.json({ result: { log: [{ what: 'bridge_ready', at: 1 }] } }));
  assert.equal((await getEvents('c1')).filter((e) => chertEventKind(e.type) === 'ready').length, 1);
  stubFetch(() => Response.json({ result: { note: 'bridge_ready_timeout' } }));
  assert.equal((await getEvents('c1')).filter((e) => chertEventKind(e.type) === 'ready').length, 0);
});

test('the raw events body is logged when it changes, so the first live call shows the real shape (coord #2)', async () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (s: string) => { lines.push(s); };
  try {
    stubFetch(() => Response.json({ odd: [] }));
    await getEvents('raw-1');
    await getEvents('raw-1');
    stubFetch(() => Response.json({ odd: [1] }));
    await getEvents('raw-1');
  } finally { console.log = realLog; }
  assert.equal(lines.filter((l) => l.includes('chert_events_raw')).length, 2);
});

test('a terminal call status ends the call, as the reference loop did (coord #3)', () => {
  const kinds = Object.fromEntries(['ended', 'call_ended', 'completed', 'cancelled', 'canceled', 'failed', 'declined',
    'queued', 'allocating', 'dialing', 'ringing', 'active'].map((s) => [s, terminalStatus(s)]));
  assert.deepEqual(kinds, {
    ended: 'ended', call_ended: 'ended', completed: 'ended', cancelled: 'ended', canceled: 'ended', failed: 'failed', declined: 'failed',
    queued: null, allocating: null, dialing: null, ringing: null, active: null,
  });
});

test('a cancel after the 4th failed try still gets the one extra try (coord #4)', async () => {
  const calls = stubFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(createCall(call, 'key-5', () => calls.length >= 4));
  assert.equal(calls.length, 5);
});

test('an event with no id keeps its id when the list shifts, so it does not replay (coord #5)', async () => {
  stubFetch(() => Response.json({ data: [{ type: 'remote_video_unavailable', at: 1 }] }));
  const [a] = await getEvents('c1');
  stubFetch(() => Response.json({ data: [{ type: 'ringing', at: 2 }, { type: 'remote_video_unavailable', at: 1 }] }));
  const second = await getEvents('c1');
  assert.equal(second.find((e) => e.type === 'remote_video_unavailable')!.id, a!.id);
});

// Own reviewer on the coordinator fixes.

test('raw logs hide tokens and phone numbers (reviewer #1)', async () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (s: string) => { lines.push(s); };
  try {
    stubFetch(() => Response.json({ data: { id: 'c9', destination: '+15555550123', participant_token: 'eyJsecret.jwt.value', status: 'allocating' } }, { status: 201 }));
    await createCall(call, 'key-9');
  } finally { console.log = realLog; }
  const raw = lines.find((l) => l.includes('chert_create_raw'))!;
  assert.ok(raw.includes('c9'), raw);
  assert.ok(!raw.includes('5555550123') && !raw.includes('eyJsecret'), raw);
});

test('hint text or a flag named bridge_ready does not connect a ringing call (reviewer #2)', async () => {
  for (const shape of [
    { data: [], meta: { bridge_ready: false } },
    { data: [{ type: 'waiting', message: 'waiting for bridge_ready' }] },
    { data: [{ type: 'call.dialing', expected_next: 'bridge_ready' }] },
  ]) {
    stubFetch(() => Response.json(shape));
    assert.equal((await getEvents('c1')).filter((e) => chertEventKind(e.type) === 'ready').length, 0, JSON.stringify(shape));
  }
});

test('terminal statuses match whole words only (reviewer #6)', () => {
  for (const s of ['suspended', 'cancel_requested', 'end_requested', 'pending']) assert.equal(terminalStatus(s), null, s);
  assert.equal(terminalStatus('call.ended'), 'ended');
  assert.equal(terminalStatus('CALL_FAILED'), 'failed');
});
