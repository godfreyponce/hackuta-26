// Connects to the hub as the agent and fakes a call so A can test the call UI without B.
// Usage: pnpm --filter @ithaca/server fake-agent
import WebSocket from 'ws';
import { serverToAgentSchema } from '@ithaca/shared';
import '../src/env';

const base = process.env.SERVER_WS_URL ?? `ws://localhost:${process.env.PORT ?? 8787}/ws`;
const key = process.env.AGENT_SHARED_SECRET ?? '';
const ws = new WebSocket(`${base}?role=agent&key=${encodeURIComponent(key)}`);
const send = (sessionId: string, m: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ts: Date.now(), sessionId, ...m }));

ws.on('open', () => { console.log('fake agent connected'); send('*', { type: 'hello', role: 'agent' }); });
ws.on('close', (c, r) => { console.log('closed', c, r.toString()); process.exit(1); });
ws.on('message', (raw) => {
  const r = serverToAgentSchema.safeParse(JSON.parse(raw.toString()));
  if (!r.success) { console.log('unparsed', raw.toString().slice(0, 200)); return; }
  const m = r.data;
  console.log('←', m.type, m.type === 'game.event' ? m.event.kind : '');
  const sid = m.sessionId;
  if (m.type === 'call.start') {
    console.log(`  calling ${m.friend.name} (${m.friend.phoneE164.slice(0, 2)}•••••${m.friend.phoneE164.slice(-4)}) for ${m.gameRoom}`);
    send(sid, { type: 'call.status', state: 'dialing' });
    setTimeout(() => send(sid, { type: 'call.status', state: 'ringing' }), 1000);
    setTimeout(() => {
      send(sid, { type: 'call.status', state: 'connected', callId: 'fake-call' });
      send(sid, { type: 'narration', text: "Telemachus! Your father's home and the hall is full of suitors.", priority: 100 });
    }, 3000);
  } else if (m.type === 'call.end') {
    send(sid, { type: 'call.status', state: 'ended', reason: m.reason });
  } else if (m.type === 'scan.request') {
    send(sid, { type: 'scan.status', state: 'looking' });
    send(sid, { type: 'narration', text: 'Hold something up to your camera!', priority: 90 });
  } else if (m.type === 'weapon.spawn') {
    send(sid, { type: 'scan.status', state: 'done', objectName: m.weapon.objectName, displayName: m.weapon.displayName });
    send(sid, { type: 'narration', text: `${m.weapon.displayName} is in his hands!`, priority: 80 });
  } else if (m.type === 'game.event' && m.event.kind === 'player_pinned') {
    send(sid, { type: 'narration', text: "He's pinned! Find him a weapon, quick!", priority: 70 });
  }
});
