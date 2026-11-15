// Headless check of the mock-call loop (spec B.10 first box). Needs fake-hub and the agent (AGENT_MODE=mock-call) running.
// Plays both the game (web) and the fake phone with rtc-node, then prints what it saw.
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackPublishOptions,
  TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream, dispose, type RemoteTrack, type RemoteTrackPublication,
  type RemoteParticipant,
} from '@livekit/rtc-node';
import WebSocket from 'ws';

const HUB = 'http://localhost:8787';
const AGENT = 'http://localhost:8788';
const t0 = Date.now();
const out = (event: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ ms: Date.now() - t0, event, ...f }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown) => (await fetch(HUB + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

const { sessionId: sid } = await post('/api/sessions', { playerId: 'e2e' }) as { sessionId: string };
const tok = await post('/api/livekit/token', { sessionId: sid }) as { url: string; token: string };

// ── web side ──
const msgs: Array<{ type: string; state?: string; text?: string }> = [];
const ws = new WebSocket(`ws://localhost:8787/ws?role=web&sessionId=${sid}`);
await new Promise((r) => ws.on('open', r));
ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); msgs.push(m); out('hub->web', { type: m.type, state: m.state, text: m.text, reason: m.reason }); });
const send = (type: string, extra: Record<string, unknown> = {}) => ws.send(JSON.stringify({ v: 1, type, sessionId: sid, ts: Date.now(), ...extra }));
const waitFor = async (pred: () => boolean, ms: number) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) return false; await sleep(50); } return true; };

const game = new Room();
const gameTracks: string[] = [];
game.on(RoomEvent.TrackSubscribed, (_t: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => { gameTracks.push(pub.name ?? ''); out('game_sub', { name: pub.name, from: p.identity }); });
await game.connect(tok.url, tok.token);
// friend-view: moving gray frames
const fv = new VideoSource(640, 360);
await game.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('friend-view', fv), new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
let shade = 0;
const fvTimer = setInterval(() => { shade = (shade + 8) % 256; fv.captureFrame(new VideoFrame(new Uint8Array(640 * 360 * 4).fill(shade), 640, 360, VideoBufferType.RGBA)); }, 66);
// player-mic: 440 Hz tone at about -12 dBFS
const mic = new AudioSource(48000, 1);
await game.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('player-mic', mic), new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
let phase = 0;
let micOn = true;
void (async () => { while (micOn) { const d = new Int16Array(480); for (let i = 0; i < 480; i++) d[i] = Math.round(8000 * Math.sin((phase++ * 2 * Math.PI * 440) / 48000)); await mic.captureFrame(new AudioFrame(d, 48000, 1, 480)); } })();

// ── call ──
send('call.request', { friendId: 'friend-1' });
await waitFor(() => msgs.some((m) => m.type === 'call.status' && m.state === 'ringing'), 15_000);
const ft = await (await fetch(`${AGENT}/dev/fake-phone-token?sid=${sid}`)).json() as { url: string; token: string; room: string };
const phone = new Room();
let joinedAt = 0;
let firstVoiceAt = 0;
let agentVideoFrames = 0;
const rmsTimeline: number[] = [];
phone.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication) => {
  out('phone_sub', { name: pub.name });
  if (pub.name === 'quartermaster-audio') void (async () => {
    let acc = 0, n = 0;
    for await (const f of new AudioStream(track, { sampleRate: 48000, numChannels: 1 })) {
      let s = 0; for (const x of f.data) s += x * x;
      const rms = Math.sqrt(s / f.data.length);
      if (!firstVoiceAt && rms > 500) { firstVoiceAt = Date.now(); out('phone_heard_voice', { msAfterJoin: firstVoiceAt - joinedAt }); }
      acc += rms; n++;
      if (n === 50) { rmsTimeline.push(Math.round(acc / n)); acc = 0; n = 0; }
    }
  })();
  if (pub.name === 'agent-video') void (async () => { for await (const _ of new VideoStream(track)) agentVideoFrames++; })();
});
// caller camera: solid frames that change shade (noise would average to one gray at 64x64), so the scanner's diff check passes
const cam = new VideoSource(1280, 720);
let camShade = 0;
const camTimer = setInterval(() => { camShade = (camShade + 60) % 256; cam.captureFrame(new VideoFrame(new Uint8Array(1280 * 720 * 4).fill(camShade), 1280, 720, VideoBufferType.RGBA)); }, 200);
await phone.connect(ft.url, ft.token);
joinedAt = Date.now();
out('phone_joined', { room: ft.room });
await phone.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('facetime-remote-video', cam), new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
const phoneMic = new AudioSource(48000, 1);
await phone.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('facetime-remote-audio', phoneMic), new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

await waitFor(() => msgs.some((m) => m.type === 'call.status' && m.state === 'connected'), 5_000);
await sleep(9_000); // let the greeting finish
send('game.event', { event: { kind: 'player_pinned', t: 1000 } });
await sleep(1_000);
send('scan.request');
const gotWeapon = await waitFor(() => msgs.some((m) => m.type === 'scan.status' && m.state === 'done'), 20_000);
await sleep(8_000); // quip, 2.5 s gap, then the weapon line
send('call.end');
await waitFor(() => msgs.some((m) => m.type === 'call.status' && m.state === 'ended'), 10_000);

out('summary', {
  greetingMsAfterJoin: firstVoiceAt ? firstVoiceAt - joinedAt : null,
  agentVideoFrames,
  gameTracksFromAgent: gameTracks,
  weaponLoop: gotWeapon,
  narrations: msgs.filter((m) => m.type === 'narration').map((m) => m.text),
  statuses: msgs.filter((m) => m.type === 'call.status').map((m) => m.state),
  scan: msgs.filter((m) => m.type === 'scan.status').map((m) => m.state),
  rmsPer500ms: rmsTimeline,
});
micOn = false;
clearInterval(fvTimer); clearInterval(camTimer);
await Promise.allSettled([phone.disconnect(), game.disconnect()]);
ws.close();
await dispose();
process.exit(0);
