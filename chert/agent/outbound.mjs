// One outbound FaceTime Video test: our agent in our own LiveKit room, Chert dials OUTBOUND_TO.
// Needs in .env.local: the LiveKit three, AGENT_NAME, CHERT_API_KEY, CHERT_PROJECT_ID, CHERT_LINE_ID, OUTBOUND_TO.
// Run with the agent already running (npm start), and chert dev stopped so the line is free.
import { randomUUID } from 'node:crypto';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

const env = process.env;
const API = env.CHERT_API_BASE || 'https://facetime.trychert.com/api/v1';
const httpUrl = env.LIVEKIT_URL.replace(/^wss:/, 'https:');
const room = `outbound-test-${Date.now()}`;
const bridgeIdentity = `chert-bridge-outbound-${Date.now()}`;
const say = (event, data = {}) => console.log(JSON.stringify({ t: Date.now(), event, ...data }));

const rooms = new RoomServiceClient(httpUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
await rooms.createRoom({ name: room, emptyTimeout: 600 });
await new AgentDispatchClient(httpUrl, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).createDispatch(room, env.AGENT_NAME);
say('room_ready', { room });

// The docs ask for the agent's video to be published before dialing.
await new Promise(r => setTimeout(r, 5000));
// The agent joins as a LiveKit-assigned identity (e.g. agent-AJ_...), not AGENT_NAME; Chert needs the real one.
const agentInRoom = (await rooms.listParticipants(room)).find(p => p.identity !== bridgeIdentity);
if (!agentInRoom) { say('agent_missing', { room }); process.exit(1); }
say('agent_in_room', { identity: agentInRoom.identity, tracks: agentInRoom.tracks.map(t => t.source) });

const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: bridgeIdentity, ttl: '30m' });
token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
const headers = {
  authorization: `Bearer ${env.CHERT_API_KEY}`,
  'x-chert-project-id': env.CHERT_PROJECT_ID,
  'content-type': 'application/json',
};
const createKey = `outbound-${randomUUID()}`;
const created = await fetch(`${API}/calls`, {
  method: 'POST',
  headers: { ...headers, 'idempotency-key': createKey },
  body: JSON.stringify({
    direction: 'outbound', mode: 'customer_managed', line_id: env.CHERT_LINE_ID,
    destination: env.OUTBOUND_TO, destination_type: 'phone',
    media: { audio: true, video: true }, when_busy: 'queue',
    livekit_url: env.LIVEKIT_URL, participant_token: await token.toJwt(), remote_participant_identity: agentInRoom.identity,
  }),
});
const body = await created.json().catch(() => ({}));
say('create_call', { status: created.status, call: body?.data?.id, error: body?.error ?? body?.code, idempotency_key: createKey });
if (!created.ok) process.exit(1);
const callId = body.data.id;

// The agent greets on room metadata (greet.mjs); chert dev is not here to set it, so we set it on bridge_ready.
let greeted = false, lastStatus = '';
for (let i = 0; i < 200; i++) {
  await new Promise(r => setTimeout(r, 1500));
  const [call, events] = await Promise.all([
    fetch(`${API}/calls/${callId}`, { headers }).then(r => r.json()).catch(() => ({})),
    fetch(`${API}/calls/${callId}/events`, { headers }).then(r => r.json()).catch(() => ({})),
  ]);
  const status = call?.data?.status ?? call?.data?.state;
  if (status !== lastStatus) { lastStatus = status; say('call_status', { status }); }
  if (!greeted && JSON.stringify(events).includes('bridge_ready')) {
    greeted = true;
    await rooms.updateRoomMetadata(room, JSON.stringify({ chert_call: callId, chert_bridge_ready: true, at: new Date().toISOString() }));
    say('bridge_ready_signalled');
  }
  if (/ended|failed|completed|declined|cancel/i.test(String(status))) break;
}
say('done', { status: lastStatus });
