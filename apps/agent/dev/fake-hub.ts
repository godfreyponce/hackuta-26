// Stand-in for Part D's server on :8787, for mock-call development only.
// Routes WS messages per the spec 4.1 hub table, mints game-room tokens, and fakes /api/forge.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = 8787;
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, AGENT_SHARED_SECRET } = process.env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !AGENT_SHARED_SECRET) throw new Error('missing env');
const FRIEND = { id: 'friend-1', name: 'Godfrey', phoneE164: process.env.OUTBOUND_TO || '+15555550123' };

const log = (event: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), src: 'fake-hub', event, ...f }));

let agent: WebSocket | null = null;
const webs = new Map<string, Set<WebSocket>>();
const forgeCalls = new Map<string, number>();

// ── fake Chert (for `pnpm dev:fake-chert`): the agent runs AGENT_MODE=live against /fake-chert. No real calls. ──
type FakeCall = { id: string; key: string; body: Record<string, unknown>; status: string; events: Array<Record<string, unknown>>; endPosts: number; pollsAfterEnd: number; agentTracksAtCreate: string[]; oddShape: boolean; endStatus: number };
const calls = new Map<string, FakeCall>();
let lastCall: FakeCall | null = null;
let createCount = 0;
/** Chert's real busy-line reply (live 3): a queue entry, no call id, until a repeat POST with the same key finds it ready. */
type FakeQueue = { id: string; key: string; body: string; state: string; gets: number; deletes: number };
const queues = new Map<string, FakeQueue>();
let lastQueue: FakeQueue | null = null;
const queueBody = (q: FakeQueue) => ({ data: { queued: q.state === 'waiting', queue: { id: q.id, kind: 'call', state: q.state, position: q.state === 'waiting' ? 1 : null, expires_at: null, call_id: null } } });
/** oddShape: events come back in an unknown shape. endStatus: every POST /end answers with this status. lineBusy: queue the create. */
let nextCreate: { queued?: boolean; lineBusy?: boolean; delayMs?: number; oddShape?: boolean; endStatus?: number } = {};
const rooms = new RoomServiceClient(LIVEKIT_URL.replace(/^wss:/, 'https:'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

async function fakeChert(method: string, path: string, req: IncomingMessage, json: (code: number, b: unknown) => void): Promise<void> {
  const parts = path.split('/').filter(Boolean); // calls, <id>, events|end
  if (method === 'POST' && path === '/_next') { nextCreate = JSON.parse((await body(req)).toString()); return json(200, {}); }
  if (method === 'GET' && path === '/_last') return json(200, { call: lastCall, createCount, queue: lastQueue });
  if (method === 'POST' && path === '/_queue') { if (lastQueue) lastQueue.state = String((JSON.parse((await body(req)).toString()) as { state: string }).state); return json(200, {}); }
  if (parts[0] === 'calls' && parts[1] === 'queue') {
    const q = queues.get(parts[2] ?? '');
    if (!q) return json(404, { error: { code: 'not_found' } });
    if (method === 'GET') { q.gets++; return json(200, queueBody(q)); }
    if (method === 'DELETE') { q.deletes++; q.state = 'cancelled'; log('fake_chert_queue_cancelled', { id: q.id }); return json(200, queueBody(q)); }
  }
  if (method === 'POST' && path === '/_emit') {
    const { id, status, ...ev } = JSON.parse((await body(req)).toString()) as { id: string; status?: string; type?: string };
    const c = calls.get(id);
    if (!c) return json(404, {});
    if (status) c.status = status;
    if (ev.type) c.events.push({ id: `ev-${c.events.length + 1}`, ...ev });
    return json(200, {});
  }
  if (method === 'POST' && path === '/calls') {
    const key = String(req.headers['idempotency-key'] ?? '');
    const raw = (await body(req)).toString();
    const existing = [...calls.values()].find((c) => c.key === key);
    if (existing) return JSON.stringify(existing.body) === raw ? json(201, { data: { id: existing.id } }) : json(409, { error: { code: 'idempotency_conflict' } });
    const waiting = [...queues.values()].find((q) => q.key === key);
    if (waiting && waiting.body !== raw) return json(409, { error: { code: 'idempotency_conflict' } });
    if (waiting?.state === 'waiting') return json(202, queueBody(waiting));
    if (waiting && waiting.state !== 'ready') return json(409, { error: { code: `queue_${waiting.state}` } });
    if (waiting) waiting.state = 'placed';
    else if (nextCreate.lineBusy) {
      nextCreate = {};
      const q: FakeQueue = { id: randomBytes(4).toString('hex'), key, body: raw, state: 'waiting', gets: 0, deletes: 0 };
      queues.set(q.id, q);
      lastQueue = q;
      log('fake_chert_queued', { id: q.id });
      return json(202, queueBody(q));
    }
    const { queued = false, delayMs = 0, oddShape = false, endStatus = 0 } = nextCreate;
    nextCreate = {};
    const b = JSON.parse(raw) as Record<string, unknown>;
    const ftRoom = /"room":"([^"]+)"/.exec(Buffer.from(String(b.participant_token).split('.')[1] ?? '', 'base64url').toString())?.[1] ?? '';
    const agent = (await rooms.listParticipants(ftRoom).catch(() => [])).find((p) => p.identity === b.remote_participant_identity);
    const c: FakeCall = { id: randomBytes(4).toString('hex'), key, body: b, status: queued ? 'queued' : 'allocating', events: queued ? [{ id: 'ev-0', type: 'call.queued' }] : [], endPosts: 0, pollsAfterEnd: 0, agentTracksAtCreate: agent?.tracks.map((t) => t.name) ?? [], oddShape, endStatus };
    calls.set(c.id, c);
    lastCall = c;
    createCount++;
    log('fake_chert_create', { id: c.id, queued, delayMs, agentTracksAtCreate: c.agentTracksAtCreate });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return json(queued ? 202 : 201, { data: { id: c.id, status: c.status } });
  }
  const c = calls.get(parts[1] ?? '');
  if (parts[0] !== 'calls' || !c) return json(404, { error: { code: 'not_found' } });
  if (method === 'GET' && c.endPosts) c.pollsAfterEnd++;
  if (method === 'GET' && parts.length === 2) return json(200, { data: { id: c.id, status: c.status } });
  if (method === 'GET' && parts[2] === 'events') return json(200, c.oddShape ? { result: { log: c.events } } : { data: c.events });
  if (method === 'POST' && parts[2] === 'end' && c.endStatus) { c.endPosts++; return json(c.endStatus, { error: { code: 'fake_end_failure' } }); }
  if (method === 'POST' && parts[2] === 'end') { c.endPosts++; c.status = 'ended'; log('fake_chert_end', { id: c.id }); return json(202, {}); }
  json(404, { error: { code: 'not_found' } });
}

const env = (type: string, sessionId: string, p: Record<string, unknown> = {}) => JSON.stringify({ v: 1, type, sessionId, ts: Date.now(), ...p });
const toWeb = (sid: string, msg: string) => { for (const w of webs.get(sid) ?? []) w.send(msg); };
const toAgent = (msg: string) => agent?.send(msg);

async function body(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(await readFile(new URL('./game-stub.html', import.meta.url)));
    }
    if (url.pathname.startsWith('/fake-chert/')) return await fakeChert(req.method ?? 'GET', url.pathname.slice('/fake-chert'.length), req, json);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, mongo: false, agentConnected: !!agent });
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const sessionId = randomBytes(6).toString('hex');
      return json(200, { sessionId, gameRoom: `game-${sessionId}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/livekit/token') {
      const { sessionId } = JSON.parse((await body(req)).toString()) as { sessionId: string };
      const room = `game-${sessionId}`;
      const identity = `web-${sessionId}`;
      const t = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '1h' });
      t.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
      return json(200, { url: LIVEKIT_URL, token: await t.toJwt(), room, identity });
    }
    if (req.method === 'POST' && url.pathname === '/api/forge') {
      const raw = await body(req);
      const sid = /name="sessionId"\r\n\r\n([^\r]+)/.exec(raw.toString('latin1'))?.[1] ?? 'unknown';
      const n = (forgeCalls.get(sid) ?? 0) + 1;
      forgeCalls.set(sid, n);
      log('forge', { sid, n, bytes: raw.length });
      if (n % 3 !== 2) return json(200, { detected: false, reason: 'no_object' }); // detect on the 2nd try, to exercise the loop
      const forgeId = randomBytes(4).toString('hex');
      setTimeout(() => {
        const weapon = {
          weaponId: 'prefab-blunt', glbUrl: '/prefabs/blunt.glb', weaponClass: 'blunt', objectName: 'frying pan',
          displayName: 'Pan of Godfrey', friendName: FRIEND.name, fallback: true,
        };
        const msg = env('weapon.spawn', sid, { weapon });
        toWeb(sid, msg);
        toAgent(msg);
        log('weapon_spawn', { sid });
      }, 2_500);
      return json(202, { forgeId, objectName: 'frying pan', displayName: 'Pan of Godfrey', weaponClass: 'blunt', quip: 'A frying pan? Bold. I like it. Forging now.' });
    }
    json(404, { error: 'not_found' });
  } catch (e) {
    json(500, { error: String(e) });
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const role = url.searchParams.get('role');
  if (role === 'agent') {
    if (url.searchParams.get('key') !== AGENT_SHARED_SECRET) { ws.close(4401, 'bad key'); return; }
    agent = ws;
    log('agent_connected');
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; sessionId: string };
      if (m.type === 'hello') return;
      log('agent->web', { type: m.type, sid: m.sessionId });
      toWeb(m.sessionId, raw.toString());
    });
    ws.on('close', () => { if (agent === ws) agent = null; log('agent_disconnected'); });
    return;
  }
  const sid = url.searchParams.get('sessionId');
  if (role !== 'web' || !sid) { ws.close(4400, 'bad params'); return; }
  if (!webs.has(sid)) webs.set(sid, new Set());
  webs.get(sid)!.add(ws);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as { type: string; sessionId: string };
    log('web->hub', { type: m.type, sid });
    if (m.type === 'call.request') {
      if (!agent) return ws.send(env('call.status', sid, { state: 'failed', reason: 'agent_offline' }));
      return toAgent(env('call.start', sid, { friend: FRIEND, gameRoom: `game-${sid}` }));
    }
    // Like apps/server/src/hub.ts: the web's call.end has no reason, so the hub adds one.
    if (m.type === 'call.end') return toAgent(env('call.end', sid, { reason: 'web_request' }));
    if (['game.event', 'scan.request'].includes(m.type)) toAgent(raw.toString());
  });
  ws.on('close', () => webs.get(sid)?.delete(ws));
});

server.listen(PORT, () => log('listening', { open: `http://localhost:${PORT}/` }));
