// Stand-in for Part D's server on :8787, for mock-call development only.
// Routes WS messages per the spec 4.1 hub table, mints game-room tokens, and fakes /api/forge.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { AccessToken } from 'livekit-server-sdk';
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = 8787;
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, AGENT_SHARED_SECRET } = process.env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !AGENT_SHARED_SECRET) throw new Error('missing env');
const FRIEND = { id: 'friend-1', name: 'Telemachus', phoneE164: process.env.OUTBOUND_TO || '+15555550123' };

const log = (event: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), src: 'fake-hub', event, ...f }));

let agent: WebSocket | null = null;
const webs = new Map<string, Set<WebSocket>>();
const forgeCalls = new Map<string, number>();

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
          displayName: 'Pan of Telemachus', friendName: FRIEND.name, fallback: true,
        };
        const msg = env('weapon.spawn', sid, { weapon });
        toWeb(sid, msg);
        toAgent(msg);
        log('weapon_spawn', { sid });
      }, 2_500);
      return json(202, { detected: true, forgeId, objectName: 'frying pan', displayName: 'Pan of Telemachus', weaponClass: 'blunt', quip: 'A frying pan? Bold. I like it. Forging now.' });
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
    if (['call.end', 'game.event', 'scan.request'].includes(m.type)) toAgent(raw.toString());
  });
  ws.on('close', () => webs.get(sid)?.delete(ws));
});

server.listen(PORT, () => log('listening', { open: `http://localhost:${PORT}/` }));
