// Headless checks of the call loop (spec B.10). Needs `pnpm fake-hub` and the agent running:
//   `pnpm dev` (AGENT_MODE=mock-call) runs the mock scenarios;
//   `pnpm dev:fake-chert` (AGENT_MODE=live against the fake hub's /fake-chert) runs the live-path scenarios. No real calls.
// Plays both the game (web) and the phone with rtc-node, asserts, and exits 1 on any failed check.
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackPublishOptions,
  TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream, dispose, type RemoteTrack, type RemoteTrackPublication,
  type RemoteParticipant,
} from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import WebSocket from 'ws';

const HUB = 'http://localhost:8787';
const AGENT = 'http://localhost:8788';
const t0 = Date.now();
const out = (event: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ ms: Date.now() - t0, event, ...f }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown) => (await fetch(HUB + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const waitFor = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) return false; await sleep(50); } return true; };
const rooms = new RoomServiceClient(process.env.LIVEKIT_URL!.replace(/^wss:/, 'https:'), process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);
const roomExists = async (name: string) => (await rooms.listRooms([name])).length > 0;

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  out(ok ? 'PASS' : 'FAIL', { check: name, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures.push(name);
}

type Msg = { type: string; state?: string; text?: string; reason?: string };

/** The web side: hub socket plus the game room with friend-view and player-mic. */
async function openGame() {
  const { sessionId: sid } = await post('/api/sessions', { playerId: 'e2e' }) as { sessionId: string };
  const tok = await post('/api/livekit/token', { sessionId: sid }) as { url: string; token: string };
  const msgs: Msg[] = [];
  const ws = new WebSocket(`ws://localhost:8787/ws?role=web&sessionId=${sid}`);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()) as Msg; msgs.push(m); out('hub->web', { type: m.type, state: m.state, text: m.text, reason: m.reason }); });
  const send = (type: string, extra: Record<string, unknown> = {}) => ws.send(JSON.stringify({ v: 1, type, sessionId: sid, ts: Date.now(), ...extra }));
  const has = (type: string, state: string) => msgs.some((m) => m.type === type && m.state === state);

  const room = new Room();
  const tracks: string[] = [];
  room.on(RoomEvent.TrackSubscribed, (_t: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => { tracks.push(pub.name ?? ''); out('game_sub', { name: pub.name, from: p.identity }); });
  await room.connect(tok.url, tok.token);
  const fv = new VideoSource(640, 360);
  await room.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('friend-view', fv), new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
  let shade = 0;
  const fvTimer = setInterval(() => { shade = (shade + 8) % 256; fv.captureFrame(new VideoFrame(new Uint8Array(640 * 360 * 4).fill(shade), 640, 360, VideoBufferType.RGBA)); }, 66);
  const mic = new AudioSource(48000, 1);
  await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('player-mic', mic), new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  let micOn = true;
  let phase = 0;
  void (async () => { while (micOn) { const d = new Int16Array(480); for (let i = 0; i < 480; i++) d[i] = Math.round(8000 * Math.sin((phase++ * 2 * Math.PI * 440) / 48000)); await mic.captureFrame(new AudioFrame(d, 48000, 1, 480)); } })();
  /** The agent's live publications in the game room, by name. */
  const agentPubs = (name: string) => [...room.remoteParticipants.values()].filter((p) => p.identity === 'quartermaster-relay')
    .flatMap((p) => [...p.trackPublications.values()]).filter((t) => t.name === name).length;
  const close = async () => { micOn = false; clearInterval(fvTimer); await room.disconnect().catch(() => {}); ws.close(); };
  return { sid, msgs, send, has, room, tracks, agentPubs, close };
}

/** The phone side: joins the FaceTime room as the bridge and publishes the caller's camera and mic. */
async function openPhone(url: string, token: string) {
  const room = new Room();
  const s = { joinedAt: 0, firstVoiceAt: 0, agentVideoFrames: 0, rms: [] as number[] };
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
    out('phone_sub', { name: pub.name });
    if (pub.name === 'quartermaster-audio') void (async () => {
      let acc = 0, n = 0;
      for await (const f of new AudioStream(track, { sampleRate: 48000, numChannels: 1 })) {
        let sum = 0; for (const x of f.data) sum += x * x;
        const rms = Math.sqrt(sum / f.data.length);
        if (!s.firstVoiceAt && rms > 500) { s.firstVoiceAt = Date.now(); out('phone_heard_voice', { msAfterJoin: s.firstVoiceAt - s.joinedAt }); }
        acc += rms; n++;
        if (n === 50) { s.rms.push(Math.round(acc / n)); acc = 0; n = 0; }
      }
    })();
    if (pub.name === 'agent-video') void (async () => { for await (const _ of new VideoStream(track)) s.agentVideoFrames++; })();
  });
  // Solid frames that change shade (noise averages to one gray at 64x64), so the scanner's diff check passes.
  const cam = new VideoSource(1280, 720);
  let camShade = 0;
  const camTimer = setInterval(() => { camShade = (camShade + 60) % 256; cam.captureFrame(new VideoFrame(new Uint8Array(1280 * 720 * 4).fill(camShade), 1280, 720, VideoBufferType.RGBA)); }, 200);
  await room.connect(url, token);
  s.joinedAt = Date.now();
  out('phone_joined', { room: room.name });
  const camOpts = new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA });
  let camPub = await room.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('facetime-remote-video', cam), camOpts);
  const phoneMic = new AudioSource(48000, 1);
  await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('facetime-remote-audio', phoneMic), new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  /** Caller video toggled off and on (or the bridge renegotiates). */
  const republishCam = async () => {
    await room.localParticipant!.unpublishTrack(camPub.sid!);
    await sleep(1_000);
    camPub = await room.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('facetime-remote-video', cam), camOpts);
  };
  const close = async () => { clearInterval(camTimer); await room.disconnect().catch(() => {}); };
  return { s, republishCam, close };
}

const mockPhone = async (sid: string) => {
  const ft = await (await fetch(`${AGENT}/dev/fake-phone-token?sid=${sid}`)).json() as { url: string; token: string; room: string };
  return { ...(await openPhone(ft.url, ft.token)), ftRoom: ft.room };
};

// ── mock-call scenarios ──

async function mockMainLoop(): Promise<void> {
  out('scenario', { name: 'mock main loop' });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  await waitFor(() => g.has('call.status', 'ringing'), 15_000);
  g.send('scan.request'); // before the friend answers (review #7a)
  check('scan before connect gets a reply', await waitFor(() => g.msgs.some((m) => m.type === 'scan.status' && m.state === 'failed' && m.reason === 'not_connected'), 3_000));
  const phone = await mockPhone(g.sid);
  check('connected', await waitFor(() => g.has('call.status', 'connected'), 5_000));
  await sleep(9_000); // let the greeting finish
  check('greeting under 1 s after join', phone.s.firstVoiceAt > 0 && phone.s.firstVoiceAt - phone.s.joinedAt < 1_000, phone.s.firstVoiceAt ? phone.s.firstVoiceAt - phone.s.joinedAt : null);
  check('agent video reaches the phone', phone.s.agentVideoFrames > 0, phone.s.agentVideoFrames);
  check('friend-cam and friend-audio relayed', g.tracks.includes('friend-cam') && g.tracks.includes('friend-audio'), g.tracks);

  await phone.republishCam(); // review #11
  await sleep(2_000);
  check('one friend-cam after the caller video comes back', g.agentPubs('friend-cam') === 1, g.agentPubs('friend-cam'));

  g.send('game.event', { event: { kind: 'player_pinned', t: 1000 } });
  await sleep(1_000);
  g.send('scan.request');
  const weapon = await waitFor(() => g.has('scan.status', 'done'), 20_000);
  check('scan -> forge -> weapon.spawn -> done', weapon);
  const scan = g.msgs.filter((m) => m.type === 'scan.status').map((m) => m.state);
  check('scan states in order', ['looking', 'detected', 'forging', 'done'].every((s, i, a) => scan.indexOf(s) >= 0 && (i === 0 || scan.indexOf(s) > scan.indexOf(a[i - 1]!))), scan);
  await sleep(8_000); // quip, 2.5 s gap, then the weapon line
  g.send('call.end');
  check('call ends', await waitFor(() => g.has('call.status', 'ended'), 10_000));
  check('FaceTime room deleted', !(await roomExists(phone.ftRoom)));
  out('summary', { narrations: g.msgs.filter((m) => m.type === 'narration').map((m) => m.text), statuses: g.msgs.filter((m) => m.type === 'call.status').map((m) => m.state), rmsPer500ms: phone.s.rms });
  await Promise.all([phone.close(), g.close()]);
}

async function mockEndDuringSetup(): Promise<void> {
  out('scenario', { name: 'call.end while the agent is still joining (review #1)' });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  await waitFor(() => g.has('call.status', 'dialing'), 5_000);
  g.send('call.end');
  check('ends', await waitFor(() => g.has('call.status', 'ended'), 15_000));
  await sleep(3_000); // a setup that kept going would have joined and published by now
  check('no ringing after the end', !g.has('call.status', 'ringing'));
  check('no FaceTime room left behind', !(await roomExists(`ft-${g.sid}-1`)));
  const health = await (await fetch(`${AGENT}/health`)).json() as { call: unknown };
  check('agent idle again', health.call === null, health.call);
  await g.close();
}

async function mockWebGone(): Promise<void> {
  out('scenario', { name: 'web tab killed mid-call (review #6)' });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  await waitFor(() => g.has('call.status', 'ringing'), 15_000);
  const phone = await mockPhone(g.sid);
  await waitFor(() => g.has('call.status', 'connected'), 5_000);
  await g.room.disconnect(); // the tab is gone; the hub socket stays only so we can watch
  check('call ends with web_gone', await waitFor(() => g.msgs.some((m) => m.type === 'call.status' && m.state === 'ended' && m.reason === 'web_gone'), 20_000));
  await Promise.all([phone.close(), g.close()]);
}

// ── live-path scenarios against the fake Chert ──

type FakeCall = { id: string; body: Record<string, unknown>; status: string; endPosts: number; pollsAfterEnd: number; agentTracksAtCreate: string[] };
const fakeLast = async () => (await (await fetch(`${HUB}/fake-chert/_last`)).json()) as { call: FakeCall | null; createCount: number };
const fakeEmit = (id: string, e: Record<string, unknown>) => post('/fake-chert/_emit', { id, ...e });

async function liveQueuedCall(): Promise<void> {
  out('scenario', { name: 'live: queued on the shared line, answered, then Chert fails it' });
  const before = (await fakeLast()).createCount;
  await post('/fake-chert/_next', { queued: true });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  const sent = Date.now() + 15_000;
  while (Date.now() < sent && (await fakeLast()).createCount === before) await sleep(100);
  check('create sent', (await fakeLast()).createCount > before);
  const c = (await fakeLast()).call!;
  check('when_busy is queue', c.body.when_busy === 'queue', c.body.when_busy);
  check('remote identity is the agent', c.body.remote_participant_identity === 'quartermaster', c.body.remote_participant_identity);
  check('agent video and audio published before create', c.agentTracksAtCreate.includes('agent-video') && c.agentTracksAtCreate.includes('quartermaster-audio'), c.agentTracksAtCreate);
  await sleep(2_000);
  check('still dialing while queued', !g.has('call.status', 'failed') && !g.has('call.status', 'ended'));
  await fakeEmit(c.id, { status: 'dialing', type: 'ringing' });
  check('ringing', await waitFor(() => g.has('call.status', 'ringing'), 5_000));
  const phone = await openPhone(String(c.body.livekit_url), String(c.body.participant_token));
  await sleep(500);
  await fakeEmit(c.id, { status: 'active', type: 'bridge_ready' });
  check('connected on bridge_ready', await waitFor(() => g.has('call.status', 'connected'), 5_000));
  await sleep(3_000);
  check('greeting under 1.5 s after join (poll included)', phone.s.firstVoiceAt > 0 && phone.s.firstVoiceAt - phone.s.joinedAt < 1_500, phone.s.firstVoiceAt ? phone.s.firstVoiceAt - phone.s.joinedAt : null);
  await fakeEmit(c.id, { status: 'failed', type: 'failed', data: { reason: 'several_audio' } });
  check('failed with Chert reason (review #5)', await waitFor(() => g.msgs.some((m) => m.type === 'call.status' && m.state === 'failed' && m.reason === 'several_audio'), 5_000));
  check('POST /end sent after Chert failed (review #5)', (await fakeLast()).call!.endPosts === 1, (await fakeLast()).call!.endPosts);
  await sleep(1_000);
  check('no polling after the end', (await fakeLast()).call!.pollsAfterEnd === 0, (await fakeLast()).call!.pollsAfterEnd);
  await Promise.all([phone.close(), g.close()]);
}

async function liveEndDuringCreate(): Promise<void> {
  out('scenario', { name: 'live: call.end while POST /calls is in flight (review #1)' });
  const before = (await fakeLast()).createCount;
  await post('/fake-chert/_next', { delayMs: 3_000 });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  const sent = Date.now() + 15_000;
  while (Date.now() < sent && (await fakeLast()).createCount === before) await sleep(50);
  g.send('call.end');
  check('ends', await waitFor(() => g.has('call.status', 'ended'), 15_000));
  await sleep(1_000);
  const c = (await fakeLast()).call!;
  check('late call ended with POST /end', c.endPosts === 1, c.endPosts);
  check('no polling after the end', c.pollsAfterEnd === 0, c.pollsAfterEnd);
  check('no FaceTime room left behind', !(await roomExists(`ft-${g.sid}-1`)));
  await g.close();
}

const health = await (await fetch(`${AGENT}/health`)).json() as { mode: string; chert: string | null };
out('agent', health);
if (health.mode === 'live' && !health.chert?.startsWith(`${HUB}/fake-chert`)) {
  out('refused', { why: 'the agent is live against the real Chert; these scenarios would place real calls. Run `pnpm dev:fake-chert`.' });
  process.exit(1);
}
if (health.mode === 'mock-call') {
  await mockMainLoop();
  await mockEndDuringSetup();
  await mockWebGone();
} else {
  await liveQueuedCall();
  await liveEndDuringCreate();
}
out('result', { failures });
await dispose();
process.exit(failures.length ? 1 : 0);
