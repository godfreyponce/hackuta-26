// Headless checks of the call loop (spec B.10). Needs `pnpm fake-hub` and the agent running:
//   `pnpm dev` (AGENT_MODE=mock-call) runs the mock scenarios;
//   `pnpm dev:fake-chert` (AGENT_MODE=live against the fake hub's /fake-chert) runs the live-path scenarios. No real calls.
// Plays both the game (web) and the phone with rtc-node, asserts, and exits 1 on any failed check.
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackPublishOptions,
  TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream, dispose, type RemoteTrack, type RemoteTrackPublication,
  type RemoteParticipant,
} from '@livekit/rtc-node';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { RoomServiceClient } from 'livekit-server-sdk';
import { GAME_BOTTOM, OUT_H } from '../src/video.ts';
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
  /** What the game's PIP would show: friend-cam frames, and the brightest frame's mean RGB (0 = black). */
  const friendCam = { frames: 0, maxMean: 0, lastMean: 0 };
  room.on(RoomEvent.TrackSubscribed, (t: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
    tracks.push(pub.name ?? ''); out('game_sub', { name: pub.name, from: p.identity });
    if (pub.name === 'friend-cam') void (async () => {
      for await (const { frame } of new VideoStream(t)) {
        if (friendCam.frames++ % 10) continue;
        const d = frame.convert(VideoBufferType.RGBA).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4 * 97) sum += d[i]! + d[i + 1]! + d[i + 2]!;
        friendCam.lastMean = sum / (3 * Math.ceil(d.length / (4 * 97)));
        friendCam.maxMean = Math.max(friendCam.maxMean, friendCam.lastMean);
      }
    })().catch(() => {});
  });
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
  return { sid, msgs, send, has, room, tracks, friendCam, agentPubs, close };
}

/** The phone side: joins the FaceTime room as the bridge and publishes the caller's camera and mic. */
async function openPhone(url: string, token: string) {
  const room = new Room();
  const s = { joinedAt: 0, firstVoiceAt: 0, agentVideoFrames: 0, agentVideoSize: '', rms: [] as number[], lastAgentFrame: null as VideoFrame | null };
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
    if (pub.name === 'agent-video') void (async () => { for await (const { frame } of new VideoStream(track)) { s.agentVideoFrames++; s.agentVideoSize = `${frame.width}x${frame.height}`; s.lastAgentFrame = frame; } })();
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

/**
 * The caption as the friend sees it: black text and the blue key word in the agent-video frame. The check waits for a
 * bright game frame, so inside the game rows only caption text is dark. Saves the frame as a PNG for a human to look at.
 */
async function captionCheck(latest: () => VideoFrame | null): Promise<void> {
  // The e2e game cycles its shade 0..248; wait for a bright one so the dark band stands out from the game above the bar.
  const gameShade = (g: VideoFrame) => g.data[(40 * g.width + g.width / 2) * 4 + 1]!;
  let f: VideoFrame | null = null;
  for (const until = Date.now() + 4_000; Date.now() < until; await sleep(30)) {
    const frame = latest()?.convert(VideoBufferType.RGBA);
    if (frame && gameShade(frame) > 120) { f = frame; break; }
  }
  if (!f) return check('caption: a bright-game agent-video frame reached the phone', false);
  let n = 0, blue = 0, minX = f.width, maxX = -1, minY = f.height, maxY = -1;
  for (let y = GAME_BOTTOM - OUT_H; y < GAME_BOTTOM; y++) for (let x = 0; x < f.width; x++) {
    const i = (y * f.width + x) * 4, r = f.data[i]!, g = f.data[i + 1]!, b = f.data[i + 2]!;
    const isBlue = b > 200 && r < 120;
    if (isBlue) blue++;
    if (isBlue || (r < 70 && g < 70 && b < 70)) { n++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  const dir = resolve('.cache/e2e');
  mkdirSync(dir, { recursive: true });
  const png = `${dir}/agent-video-caption.png`;
  await sharp(Buffer.from(f.data), { raw: { width: f.width, height: f.height, channels: 4 } }).png().toFile(png);
  const box = { captionPixels: n, keyWordPixels: blue, x: [minX, maxX], y: [minY, maxY], size: `${f.width}x${f.height}`, png };
  check('caption burned into agent-video during the greeting (captions)', n > 200, box);
  check('caption whole inside the game, in its lower half (captions)', n > 0 && minX >= 16 && maxX < f.width - 16 && minY >= f.height / 2 && maxY < GAME_BOTTOM, box);
  // The last game rows above the bottom letterbox bar must keep the game shade: the pill ends above them.
  let sum = 0, px = 0;
  for (let y = GAME_BOTTOM - 4; y < GAME_BOTTOM; y++) for (let x = 100; x < f.width - 100; x++) { sum += f.data[(y * f.width + x) * 4 + 1]!; px++; }
  check('caption band ends above the bottom letterbox bar (captions)', Math.abs(sum / px - gameShade(f)) < 20, { gapGreen: Math.round(sum / px), gameGreen: gameShade(f), rows: [GAME_BOTTOM - 4, GAME_BOTTOM - 1] });
}

const mockPhone = async (sid: string) => {
  const ft = await (await fetch(`${AGENT}/dev/fake-phone-token?sid=${sid}`)).json() as { url: string; token: string; room: string };
  return { ...(await openPhone(ft.url, ft.token)), ftRoom: ft.room };
};

// ── mock-call scenarios ──

async function mockMainLoop(): Promise<void> {
  out('scenario', { name: 'mock main loop' });
  const g = await openGame();
  g.send('scan.request'); // no call yet (integration check b)
  check('scan with no call gets a reply', await waitFor(() => g.msgs.some((m) => m.type === 'scan.status' && m.state === 'failed' && m.reason === 'not_connected'), 3_000));
  g.msgs.length = 0;
  g.send('call.request', { friendId: 'friend-1' });
  await waitFor(() => g.has('call.status', 'ringing'), 15_000);
  g.send('scan.request'); // before the friend answers (review #7a)
  check('scan before connect gets a reply', await waitFor(() => g.msgs.some((m) => m.type === 'scan.status' && m.state === 'failed' && m.reason === 'not_connected'), 3_000));
  const phone = await mockPhone(g.sid);
  check('connected', await waitFor(() => g.has('call.status', 'connected'), 5_000));
  await sleep(9_000); // let the greeting finish
  check('greeting under 1 s after join', phone.s.firstVoiceAt > 0 && phone.s.firstVoiceAt - phone.s.joinedAt < 1_000, phone.s.firstVoiceAt ? phone.s.firstVoiceAt - phone.s.joinedAt : null);
  check('agent video reaches the phone', phone.s.agentVideoFrames > 0, phone.s.agentVideoFrames);
  // Call 3: FaceTime cut our 16:9 frame to about 3:2, losing about 8% at each side. A 3:2 frame keeps the whole game.
  const [vw, vh] = phone.s.agentVideoSize.split('x').map(Number);
  check('agent video is 3:2 (call 3)', !!vw && !!vh && Math.abs(vw / vh - 1.5) < 0.02, phone.s.agentVideoSize);
  check('friend-cam and friend-audio relayed', g.tracks.includes('friend-cam') && g.tracks.includes('friend-audio'), g.tracks);
  check('friend-cam frames reach the game and are not black (live 1 #2)', g.friendCam.frames > 10 && g.friendCam.maxMean > 20, g.friendCam);

  const camFramesBefore = g.friendCam.frames;
  await phone.republishCam(); // review #11
  await sleep(2_000);
  check('friend-cam still has frames after the caller video restarts (live 1 #2)', g.friendCam.frames > camFramesBefore + 10, { before: camFramesBefore, after: g.friendCam.frames });
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
type FakeQueue = { id: string; state: string; gets: number; deletes: number };
const fakeLast = async () => (await (await fetch(`${HUB}/fake-chert/_last`)).json()) as { call: FakeCall | null; createCount: number; queue: FakeQueue | null };
/** Waits until the fake Chert holds a new queue entry for this create. */
async function newQueue(before: string | undefined): Promise<FakeQueue | null> {
  const until = Date.now() + 15_000;
  for (;;) {
    const q = (await fakeLast()).queue;
    if (q && q.id !== before) return q;
    if (Date.now() > until) return null;
    await sleep(100);
  }
}
const fakeEmit = (id: string, e: Record<string, unknown>) => post('/fake-chert/_emit', { id, ...e });

async function liveQueuedCall(): Promise<void> {
  out('scenario', { name: 'live: queued on the shared line (real 202 shape), turn comes, answered, then Chert fails it (live 3)' });
  const { createCount: before, queue: oldQueue } = await fakeLast();
  await post('/fake-chert/_next', { lineBusy: true });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  const q = await newQueue(oldQueue?.id);
  check('create queued by Chert', !!q);
  check('line busy and the position shown to the web (live 3)', await waitFor(() => g.msgs.some((m) => m.type === 'call.status' && m.state === 'dialing' && m.reason === 'line_busy_1'), 5_000));
  await sleep(3_500);
  const waited = (await fakeLast()).queue!;
  check('still dialing while queued, no call placed (live 3)', !g.has('call.status', 'failed') && !g.has('call.status', 'ended') && (await fakeLast()).createCount === before);
  check('queue entry polled about every 1.5 s (live 3)', waited.gets >= 2 && waited.gets <= 4, waited.gets);
  await post('/fake-chert/_queue', { state: 'ready' });
  const sent = Date.now() + 5_000;
  while (Date.now() < sent && (await fakeLast()).createCount === before) await sleep(100);
  check('repeat POST with the same key places the call when the turn comes (live 3)', (await fakeLast()).createCount === before + 1);
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
  await captionCheck(() => phone.s.lastAgentFrame);
  await fakeEmit(c.id, { status: 'failed', type: 'failed', data: { reason: 'several_audio' } });
  check('failed with Chert reason (review #5)', await waitFor(() => g.msgs.some((m) => m.type === 'call.status' && m.state === 'failed' && m.reason === 'several_audio'), 5_000));
  check('POST /end sent after Chert failed (review #5)', (await fakeLast()).call!.endPosts === 1, (await fakeLast()).call!.endPosts);
  await sleep(1_000);
  check('no polling after the end', (await fakeLast()).call!.pollsAfterEnd === 0, (await fakeLast()).call!.pollsAfterEnd);
  await Promise.all([phone.close(), g.close()]);
}

async function liveQueueCancelled(): Promise<void> {
  out('scenario', { name: 'live: the web ends the call while it waits in the queue (live 3)' });
  const { createCount: before, queue: oldQueue } = await fakeLast();
  await post('/fake-chert/_next', { lineBusy: true });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  check('create queued by Chert', !!(await newQueue(oldQueue?.id)));
  await sleep(2_000);
  g.send('call.end');
  check('ends', await waitFor(() => g.has('call.status', 'ended'), 10_000));
  await sleep(500);
  const { queue, createCount } = await fakeLast();
  check('queue entry cancelled with DELETE (live 3)', queue!.deletes === 1, queue!.deletes);
  check('no call placed', createCount === before, createCount - before);
  check('no FaceTime room left behind', !(await roomExists(`ft-${g.sid}-1`)));
  await g.close();
}

async function liveQueueExpired(): Promise<void> {
  out('scenario', { name: 'live: Chert drops our queue entry (expired) (live 3)' });
  const { createCount: before, queue: oldQueue } = await fakeLast();
  await post('/fake-chert/_next', { lineBusy: true });
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  check('create queued by Chert', !!(await newQueue(oldQueue?.id)));
  await post('/fake-chert/_queue', { state: 'expired' });
  check('fails with line_busy (live 3)', await waitFor(() => g.msgs.some((m) => m.type === 'call.status' && m.state === 'failed' && m.reason === 'line_busy'), 10_000));
  check('no call placed', (await fakeLast()).createCount === before);
  check('no FaceTime room left behind', !(await roomExists(`ft-${g.sid}-1`)));
  await g.close();
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

const ACTIVE_CALL_FILE = new URL('../.cache/active-call.json', import.meta.url);

async function liveCreate(next: Record<string, unknown>) {
  const before = (await fakeLast()).createCount;
  await post('/fake-chert/_next', next);
  const g = await openGame();
  g.send('call.request', { friendId: 'friend-1' });
  const sent = Date.now() + 15_000;
  while (Date.now() < sent && (await fakeLast()).createCount === before) await sleep(100);
  return { g, c: (await fakeLast()).call! };
}

async function liveStatusEnd(): Promise<void> {
  out('scenario', { name: 'live: odd events shape, then Chert ends by status only (coord review #2, #3)' });
  const { g, c } = await liveCreate({ oddShape: true });
  await fakeEmit(c.id, { status: 'active', type: 'bridge_ready' });
  check('connected although the events shape is unknown (coord #2)', await waitFor(() => g.has('call.status', 'connected'), 5_000));
  await fakeEmit(c.id, { status: 'completed' });
  check('a terminal status with no end event ends the call (coord #3)', await waitFor(() => g.msgs.some((m) => m.type === 'call.status' && m.state === 'ended' && m.reason === 'remote_ended'), 5_000));
  await sleep(1_000);
  check('a call Chert ended leaves no recovery record', !existsSync(ACTIVE_CALL_FILE));
  check('no polling after the end', (await fakeLast()).call!.pollsAfterEnd === 0, (await fakeLast()).call!.pollsAfterEnd);
  await g.close();
}

async function liveFailedEnd(): Promise<void> {
  out('scenario', { name: 'live: the web ends the call and POST /end fails (coord review #1)' });
  const { g, c } = await liveCreate({ endStatus: 503 });
  await sleep(1_000);
  g.send('call.end');
  check('ends', await waitFor(() => g.has('call.status', 'ended'), 15_000));
  await sleep(1_000);
  check('a failed POST /end is tried twice (coord #1)', (await fakeLast()).call!.endPosts === 2, (await fakeLast()).call!.endPosts);
  check('a failed POST /end keeps the recovery record (coord #1)', existsSync(ACTIVE_CALL_FILE) && readFileSync(ACTIVE_CALL_FILE, 'utf8').includes(c.id));
  rmSync(ACTIVE_CALL_FILE, { force: true }); // the fake call has no real counterpart to recover
  await g.close();
}

const health = await (await fetch(`${AGENT}/health`)).json() as { mode: string; chert: string | null; linesReady?: boolean };
out('agent', health);
if (health.mode === 'live' && !health.chert?.startsWith(`${HUB}/fake-chert`)) {
  out('refused', { why: 'the agent is live against the real Chert; these scenarios would place real calls. Run `pnpm dev:fake-chert`.' });
  process.exit(1);
}
check('/health shows linesReady (integration #8)', health.linesReady === true, health.linesReady);
{
  out('scenario', { name: 'call.end with no call' });
  const g = await openGame();
  g.send('call.end');
  check('call.end with no call gets ended no_active_call (integration #7)', await waitFor(() => g.msgs.some((m) => m.type === 'call.status' && m.state === 'ended' && m.reason === 'no_active_call'), 3_000));
  g.msgs.length = 0;
  g.send('call.request', { friendId: 'friend-1' }); // the server's call.start arriving after the web's call.end
  await sleep(2_000);
  const after = await (await fetch(`${AGENT}/health`)).json() as { call: unknown };
  check('a call.start right after that end is not dialed (review: end/start race)', after.call === null && !g.has('call.status', 'dialing') && !g.has('call.status', 'ringing') && g.has('call.status', 'ended'), { call: after.call, msgs: g.msgs.map((m) => `${m.type} ${m.state ?? ''} ${m.reason ?? ''}`) });
  await g.close();
}
if (health.mode === 'mock-call') {
  await mockMainLoop();
  await mockEndDuringSetup();
  await mockWebGone();
} else {
  await liveQueuedCall();
  await liveQueueCancelled();
  await liveQueueExpired();
  await liveEndDuringCreate();
  await liveStatusEnd();
  await liveFailedEnd();
}
out('result', { failures });
await dispose();
process.exit(failures.length ? 1 : 0);
