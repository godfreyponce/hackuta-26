// One FaceTime call, spec B.4. Two rooms: the game room (relay) and the FaceTime room (agent + bridge only).
import {
  AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackKind, TrackPublishOptions,
  TrackSource, VideoSource, VideoStream, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { ChertError, createCall, endCall, getEvents } from './chert.ts';
import type { CallState, GameEvent, ServerToAgent, WeaponSpawn } from './contracts/protocol.ts';
import { env } from './env.ts';
import type { Hub } from './hub.ts';
import { pick, type LineKey } from './lines.ts';
import { clearActiveCall, noteActiveCall } from './recovery.ts';
import { errText, log, maskPhone, warn } from './log.ts';
import { Mixer } from './mixer.ts';
import { Narrator, PRIORITY } from './narrator.ts';
import { CallerScanner } from './scanner.ts';
import { cropRgba, OUT_H, OUT_W, VideoRelay } from './video.ts';

const POLL_MS = 400;
const ANSWER_TIMEOUT_MS = 60_000;
const MUST_GO_BEFORE_MS = 20_000;
const FAREWELL_WAIT_MS = 3_000;
const AUTO_SCAN_AFTER_PIN_MS = 5_000;
const AGENT_FT_IDENTITY = 'quartermaster';
const AGENT_GAME_IDENTITY = 'quartermaster-relay';
const ALLOWED_FT_TRACKS = new Set(['agent-video', 'quartermaster-audio']);

export const MOCK_BRIDGE_IDENTITY = 'facetime-bridge-mock';

type StartMsg = Extract<ServerToAgent, { type: 'call.start' }>;

async function mint(identity: string, room: string, ttl: string): Promise<string> {
  const t = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity, ttl });
  t.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });
  return t.toJwt();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CallSession {
  readonly sid: string;
  readonly ftRoom: string;
  readonly bridgeIdentity: string;
  state: CallState = 'idle';
  private readonly mock = env.AGENT_MODE === 'mock-call';
  private readonly friend: StartMsg['friend'];
  private readonly gameRoomName: string;
  private readonly keyBase: string;
  private game = new Room();
  private ft = new Room();
  private mixer = new Mixer();
  private video = new VideoRelay();
  private narrator: Narrator;
  private scanner: CallerScanner;
  private callId: string | null = null;
  private bridgeReadyAt = 0;
  private dialedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private playerMic: RemoteTrack | null = null;
  private lastWeapon: WeaponSpawn | null = null;
  private awaitingWeapon = false;
  private scanRequested = false;
  private ending: Promise<void> | null = null;
  private relayStreams: Array<{ cancel(): Promise<void> }> = [];
  private relaySources: Array<{ close(): Promise<void> }> = [];

  constructor(msg: StartMsg, attempt: number, private hub: Hub, private onDone: () => void) {
    this.sid = msg.sessionId;
    this.friend = msg.friend;
    this.gameRoomName = msg.gameRoom;
    this.ftRoom = `ft-${this.sid}-${attempt}`;
    this.keyBase = `ithaca-${this.sid}-${attempt}`;
    this.bridgeIdentity = this.mock ? MOCK_BRIDGE_IDENTITY : `facetime-bridge-${attempt}`;
    this.scanner = new CallerScanner(this.sid);
    this.narrator = new Narrator(this.mixer, (text, priority) => this.hub.send({ type: 'narration', sessionId: this.sid, text, priority }));
  }

  /** Token for dev/fake-phone.html (mock-call only). */
  fakePhoneToken(): Promise<string> {
    return mint(MOCK_BRIDGE_IDENTITY, this.ftRoom, '30m');
  }

  async run(): Promise<void> {
    try {
      this.status('dialing');
      log('call_start', { sid: this.sid, friend: this.friend.name, phone: maskPhone(this.friend.phoneE164), ftRoom: this.ftRoom, mode: env.AGENT_MODE });
      await this.joinGameRoom();
      await this.joinFtRoom();
      if (this.mock) {
        this.status('ringing');
        log('mock_waiting_for_fake_phone', { open: `http://localhost:${env.AGENT_HEALTH_PORT}/dev/fake-phone?sid=${encodeURIComponent(this.sid)}` });
        return;
      }
      await this.dial();
    } catch (e) {
      const reason = e instanceof ChertError ? e.code : 'agent_error';
      warn('call_run_failed', { error: errText(e) });
      await this.end(reason, 'failed');
    }
  }

  handle(m: ServerToAgent): void {
    switch (m.type) {
      case 'call.end': void this.end(m.reason || 'web_ended', 'ended'); break;
      case 'game.event': this.onGameEvent(m.event); break;
      case 'scan.request': this.scanRequested = true; void this.runScan(); break;
      case 'weapon.spawn': this.onWeapon(m.weapon); break;
      case 'call.start': break; // main handles busy
    }
  }

  // ── rooms ────────────────────────────────────────────────────

  private async joinGameRoom(): Promise<void> {
    this.game.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      log('game_track', { name: pub.name, from: p.identity });
      if (pub.name === 'friend-view' && track.kind === TrackKind.KIND_VIDEO) this.video.attachFriendView(track);
      if (pub.name === 'player-mic' && track.kind === TrackKind.KIND_AUDIO) {
        this.playerMic = track;
        if (this.bridgeReadyAt) this.mixer.enableMic(track);
      }
    });
    this.game.on(RoomEvent.Disconnected, (r) => { if (!this.ending) warn('game_room_disconnected', { reason: r }); });
    await this.game.connect(env.LIVEKIT_URL, await mint(AGENT_GAME_IDENTITY, this.gameRoomName, '2h'), { autoSubscribe: true, dynacast: false });
    log('game_room_joined', { room: this.gameRoomName });
  }

  private async joinFtRoom(): Promise<void> {
    this.ft.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      if (p.identity !== this.bridgeIdentity) {
        warn('INVARIANT_stranger_in_ft_room', { identity: p.identity });
        void this.roomService().removeParticipant(this.ftRoom, p.identity).catch(() => {});
        return;
      }
      log('bridge_joined', { identity: p.identity });
      if (this.mock) this.onBridgeReady('mock_join');
    });
    this.ft.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (p.identity === this.bridgeIdentity && this.bridgeReadyAt) {
        log('bridge_left');
        if (this.mock) void this.end('remote_hangup', 'ended', { skipChert: true });
      }
    });
    this.ft.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      log('ft_track', { name: pub.name, from: p.identity });
      if (p.identity !== this.bridgeIdentity) return;
      if (pub.name === 'facetime-remote-video') this.relayCallerVideo(track);
      if (pub.name === 'facetime-remote-audio') this.relayCallerAudio(track);
    });
    this.ft.on(RoomEvent.LocalTrackPublished, () => this.checkInvariants());
    this.ft.on(RoomEvent.Disconnected, (r) => { if (!this.ending) warn('ft_room_disconnected', { reason: r }); });

    await this.ft.connect(env.LIVEKIT_URL, await mint(AGENT_FT_IDENTITY, this.ftRoom, '2h'), { autoSubscribe: true, dynacast: false });
    const lp = this.ft.localParticipant!;
    const videoTrack = LocalVideoTrack.createVideoTrack('agent-video', this.video.source);
    const audioTrack = LocalAudioTrack.createAudioTrack('quartermaster-audio', this.mixer.source);
    await this.video.start(this.friend.name);
    this.mixer.start(); // silence until bridge_ready
    await lp.publishTrack(videoTrack, new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA, simulcast: false }));
    await lp.publishTrack(audioTrack, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    this.checkInvariants();
    log('ft_room_ready', { room: this.ftRoom, tracks: [...lp.trackPublications.values()].map((t) => t.name) });
  }

  private checkInvariants(): void {
    const pubs = [...(this.ft.localParticipant?.trackPublications.values() ?? [])];
    const audio = pubs.filter((p) => p.kind === TrackKind.KIND_AUDIO);
    if (audio.length > 1) warn('INVARIANT_several_audio', { count: audio.length });
    const extra = pubs.filter((p) => !ALLOWED_FT_TRACKS.has(p.name ?? ''));
    if (extra.length) warn('INVARIANT_unexpected_ft_track', { names: extra.map((p) => p.name) });
  }

  private relayCallerVideo(track: RemoteTrack): void {
    const source = new VideoSource(OUT_W, OUT_H);
    this.relaySources.push(source);
    const stream = new VideoStream(track);
    this.relayStreams.push(stream);
    void this.game.localParticipant!.publishTrack(
      LocalVideoTrack.createVideoTrack('friend-cam', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA, simulcast: false }),
    ).then(() => log('friend_cam_published')).catch((e) => warn('friend_cam_publish_failed', { error: errText(e) }));
    void (async () => {
      let frames = 0;
      try {
        for await (const { frame } of stream) {
          this.scanner.offer(frame);
          if (++frames === 1) log('caller_video_first_frame', { width: frame.width, height: frame.height });
          source.captureFrame(cropRgba(frame, env.callerCrop));
        }
      } catch (e) { warn('caller_video_ended', { error: errText(e) }); }
    })();
  }

  private relayCallerAudio(track: RemoteTrack): void {
    const source = new AudioSource(48_000, 1, 100);
    this.relaySources.push(source);
    const stream = new AudioStream(track, { sampleRate: 48_000, numChannels: 1 });
    this.relayStreams.push(stream);
    void this.game.localParticipant!.publishTrack(
      LocalAudioTrack.createAudioTrack('friend-audio', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    ).then(() => log('friend_audio_published')).catch((e) => warn('friend_audio_publish_failed', { error: errText(e) }));
    void (async () => {
      try { for await (const f of stream) await source.captureFrame(f); }
      catch (e) { warn('caller_audio_ended', { error: errText(e) }); }
    })();
  }

  // ── Chert (live) ─────────────────────────────────────────────

  private async dial(): Promise<void> {
    const bridgeToken = await mint(this.bridgeIdentity, this.ftRoom, '30m');
    this.dialedAt = Date.now();
    this.callId = await createCall({
      destination: this.friend.phoneE164, livekitUrl: env.LIVEKIT_URL,
      participantToken: bridgeToken, remoteIdentity: AGENT_FT_IDENTITY,
    }, `${this.keyBase}-create`);
    log('chert_call_created', { callId: this.callId, ms: Date.now() - this.dialedAt });
    await noteActiveCall(this.callId, `${this.keyBase}-end`).catch(() => {});
    void this.pollEvents();
  }

  private async pollEvents(): Promise<void> {
    const seen = new Set<string>();
    while (!this.ending && this.callId) {
      if (!this.bridgeReadyAt && Date.now() - this.dialedAt > ANSWER_TIMEOUT_MS) { await this.end('no_answer', 'failed'); return; }
      try {
        for (const ev of await getEvents(this.callId)) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          log('chert_event', { type: ev.type });
          this.onChertEvent(ev.type);
          if (this.ending) return;
        }
      } catch (e) { warn('chert_poll_failed', { error: errText(e) }); }
      await sleep(POLL_MS);
    }
  }

  private onChertEvent(type: string): void {
    if (type === 'bridge_ready' || type === 'call.started') this.onBridgeReady(type);
    else if (/ring|dial|alert/i.test(type) && this.state === 'dialing') this.status('ringing');
    else if (type === 'remote_video_unavailable') this.say('cantSee', PRIORITY.scan);
    else if (type === 'ended' || type === 'call.ended') void this.end('remote_ended', 'ended', { skipChert: true });
    else if (type === 'failed' || type === 'call.failed') void this.end('chert_failed', 'failed', { skipChert: true });
  }

  // ── call flow ────────────────────────────────────────────────

  private onBridgeReady(via: string): void {
    if (this.bridgeReadyAt || this.ending) return;
    this.bridgeReadyAt = Date.now();
    const g = pick('greeting');
    void this.narrator.sayNow(g.text, PRIORITY.greeting, g.pcm);
    log('greeting_started', { via, msAfterBridgeReady: Date.now() - this.bridgeReadyAt, cached: !!g.pcm });
    this.status('connected');
    if (this.playerMic) this.mixer.enableMic(this.playerMic);
    this.timers.push(setTimeout(() => this.say('mustGo', PRIORITY.scan), env.CALL_MAX_MS - MUST_GO_BEFORE_MS));
    this.timers.push(setTimeout(() => void this.end('time_limit', 'ended'), env.CALL_MAX_MS));
  }

  private say(key: LineKey, priority: number): void {
    const l = pick(key);
    this.narrator.say(l.text, priority, l.pcm);
  }

  private onGameEvent(e: GameEvent): void {
    if (!this.bridgeReadyAt) return;
    switch (e.kind) {
      case 'match_start': this.say('matchStart', PRIORITY.flavor); break;
      case 'wave_start': this.say('waveStart', PRIORITY.flavor); break;
      case 'wave_cleared': this.say('waveCleared', PRIORITY.flavor); break;
      case 'health_low': this.say('healthLow', PRIORITY.danger); break;
      case 'boss_spawn': this.say('bossSpawn', PRIORITY.danger); break;
      case 'player_pinned':
        this.say('pinned', PRIORITY.danger);
        this.scanRequested = false;
        this.timers.push(setTimeout(() => { if (!this.scanRequested && !this.scanner.scanning) void this.runScan(); }, AUTO_SCAN_AFTER_PIN_MS));
        break;
      case 'trickshot':
        if (e.data?.trickshot === 'pin') this.say('pin', PRIORITY.trickshot);
        else if (e.data?.trickshot === 'multi_kill') this.say('multiKill', PRIORITY.trickshot);
        else if (e.data?.trickshot === 'friend_assist') this.friendKill(e);
        break;
      case 'item_kill': this.friendKill(e); break;
      case 'match_end': void this.end('match_end', 'ended'); break;
      default: break;
    }
  }

  private friendKill(e: GameEvent): void {
    const name = this.lastWeapon?.objectName ?? e.data?.weaponName;
    if (name) this.narrator.say(`Your ${name} just flattened a suitor. Ha!`, PRIORITY.trickshot);
  }

  private async runScan(): Promise<void> {
    if (!this.bridgeReadyAt || this.scanner.scanning || this.awaitingWeapon || this.ending) return;
    this.scanStatus('looking');
    this.say('scanLooking', PRIORITY.scan);
    let nudged = false;
    const hit = await this.scanner.scan((ms) => {
      if (!nudged && ms >= 6_000) { nudged = true; this.say('scanCloser', PRIORITY.scan); }
    });
    if (this.ending) return;
    if (!hit) {
      this.scanStatus('failed', { reason: 'no_object' });
      this.say('scanFailed', PRIORITY.scan);
      return;
    }
    this.scanStatus('detected', { objectName: hit.objectName, displayName: hit.displayName });
    this.narrator.say(hit.quip, PRIORITY.scan);
    this.scanStatus('forging', { objectName: hit.objectName, displayName: hit.displayName });
    this.awaitingWeapon = true;
  }

  private onWeapon(w: WeaponSpawn): void {
    this.lastWeapon = w;
    this.awaitingWeapon = false;
    if (!this.bridgeReadyAt) return;
    this.narrator.say(`The ${w.displayName} is in his hands!`, PRIORITY.weapon);
    this.scanStatus('done', { objectName: w.objectName, displayName: w.displayName });
  }

  // ── end + cleanup (every exit path goes through here) ────────

  end(reason: string, final: 'ended' | 'failed', opts: { skipChert?: boolean; quick?: boolean } = {}): Promise<void> {
    this.ending ??= this.doEnd(reason, final, opts);
    return this.ending;
  }

  private async doEnd(reason: string, final: 'ended' | 'failed', opts: { skipChert?: boolean; quick?: boolean }): Promise<void> {
    log('call_ending', { reason, final, callId: this.callId });
    this.status('ending', reason);
    for (const t of this.timers) clearTimeout(t);
    this.scanner.cancel();
    try {
      if (this.bridgeReadyAt && !opts.skipChert && !opts.quick) {
        const f = pick('farewell');
        await Promise.race([this.narrator.sayNow(f.text, PRIORITY.greeting, f.pcm), sleep(FAREWELL_WAIT_MS)]);
      }
      if (this.callId && !opts.skipChert) {
        const status = await endCall(this.callId, `${this.keyBase}-end`).catch((e) => { warn('chert_end_failed', { error: errText(e) }); return 0; });
        log('chert_end', { status });
      }
    } finally {
      this.narrator.stop();
      await Promise.allSettled([
        ...this.relayStreams.map((s) => s.cancel()),
        this.mixer.close(), this.video.close(),
        ...this.relaySources.map((s) => s.close()),
      ]);
      await Promise.allSettled([this.ft.disconnect(), this.game.disconnect()]);
      await this.roomService().deleteRoom(this.ftRoom).catch((e) => warn('delete_room_failed', { error: errText(e) }));
      if (this.callId) await clearActiveCall().catch(() => {});
      this.status(final, reason);
      log('call_cleaned_up', { ftRoom: this.ftRoom, elapsedMs: this.bridgeReadyAt ? Date.now() - this.bridgeReadyAt : 0 });
      this.onDone();
    }
  }

  private roomService(): RoomServiceClient {
    return new RoomServiceClient(env.LIVEKIT_URL.replace(/^wss:/, 'https:'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  }

  private status(state: CallState, reason?: string): void {
    this.state = state;
    this.hub.send({
      type: 'call.status', sessionId: this.sid, state,
      ...(reason ? { reason } : {}), ...(this.callId ? { callId: this.callId } : {}),
      ...(this.bridgeReadyAt ? { elapsedMs: Date.now() - this.bridgeReadyAt } : {}),
    });
  }

  private scanStatus(state: 'looking' | 'detected' | 'forging' | 'done' | 'failed', extra: { objectName?: string; displayName?: string; reason?: string } = {}): void {
    this.hub.send({ type: 'scan.status', sessionId: this.sid, state, ...extra });
  }
}
