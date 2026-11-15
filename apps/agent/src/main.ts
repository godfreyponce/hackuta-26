// Agent process, spec B.3: env -> TTS cache -> hub WS -> health server -> idle; one CallSession at a time.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dispose } from '@livekit/rtc-node';
import { CallSession, END_MAX_MS } from './call-session.ts';
import type { ServerToAgent } from './contracts/protocol.ts';
import { env } from './env.ts';
import { Hub } from './hub.ts';
import { ensureGreeting, greetingReady, prerenderLines } from './lines.ts';
import { errText, log, warn } from './log.ts';
import { recoverLeftovers } from './recovery.ts';

let active: CallSession | null = null;
const attempts = new Map<string, number>();
const BOOT_ID = randomBytes(3).toString('hex');

const hub = new Hub((m: ServerToAgent) => {
  if (m.type === 'call.start') {
    if (active || !greetingReady()) {
      hub.send({ type: 'call.status', sessionId: m.sessionId, state: 'failed', reason: active ? 'line_busy' : 'tts_not_ready' });
      return;
    }
    const n = (attempts.get(m.sessionId) ?? 0) + 1;
    attempts.set(m.sessionId, n);
    const session = new CallSession(m, n, BOOT_ID, hub, () => { if (active === session) active = null; });
    active = session;
    void session.run();
    return;
  }
  if (active && active.sid === m.sessionId) active.handle(m);
});

function startHealthServer(): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/health') {
      return json(200, { ok: true, mode: env.AGENT_MODE, chert: env.AGENT_MODE === 'live' ? env.CHERT_API_BASE : null, hub: hub.connected, call: active ? { sid: active.sid, state: active.state } : null });
    }
    if (env.AGENT_MODE === 'mock-call' && url.pathname === '/dev/fake-phone') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(await readFile(new URL('../dev/fake-phone.html', import.meta.url)));
    }
    if (env.AGENT_MODE === 'mock-call' && url.pathname === '/dev/fake-phone-token') {
      const sid = url.searchParams.get('sid');
      if (!active || (sid && sid !== active.sid)) return json(404, { error: 'no_active_call' });
      return json(200, { url: env.LIVEKIT_URL, token: await active.fakePhoneToken(), room: active.ftRoom, identity: active.bridgeIdentity });
    }
    json(404, { error: 'not_found' });
  });
  server.listen(env.AGENT_HEALTH_PORT, () => log('health_listening', { port: env.AGENT_HEALTH_PORT }));
}

let shuttingDown = false;
async function shutdown(reason: string, code: number): Promise<void> {
  if (shuttingDown) process.exit(code); // a second Ctrl-C quits at once
  shuttingDown = true;
  log('agent_shutdown', { reason, hardStopMs: END_MAX_MS + 1_000 });
  const t = setTimeout(() => process.exit(code), END_MAX_MS + 1_000); // hard stop if cleanup hangs
  try { await active?.end(reason, 'ended', { quick: reason !== 'SIGINT' && reason !== 'SIGTERM' }); }
  catch (e) { warn('shutdown_end_failed', { error: errText(e) }); }
  await dispose().catch(() => {});
  clearTimeout(t);
  process.exit(code);
}

process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('uncaughtException', (e) => { warn('uncaught', { error: errText(e) }); void shutdown('crash', 1); });
process.on('unhandledRejection', (e) => { warn('unhandled_rejection', { error: errText(e) }); });

log('agent_starting', { mode: env.AGENT_MODE, chert: env.AGENT_MODE === 'live' ? env.CHERT_API_BASE : null, voice: env.ELEVENLABS_VOICE_ID, model: env.ELEVENLABS_MODEL_ID });
await Promise.all([prerenderLines(), recoverLeftovers()]);
if (!greetingReady()) { warn('greeting_not_cached_calls_refused'); void ensureGreeting(); }
hub.connect();
startHealthServer();
