// One FaceTime call, spec B.4. Two rooms: the game room (relay) and the FaceTime room (agent + bridge only).
import {
  AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackKind, TrackPublishOptions,
  TrackSource, VideoSource, VideoStream, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import {
  ChertError, chertEventKind, CREATE_AFTER_CANCEL_MAX_MS, createCall, endCall, endConfirmed, END_CALL_MAX_MS, getCallStatus, getEvents,
  isQueuedStatus, queuedNameAfter202, startsRingClock, terminalStatus, type ChertEvent,
} from './chert.ts';
import type { CallState, GameEvent, ServerToAgent, WeaponSpawn } from './contracts/protocol.ts';
import { env } from './env.ts';
import type { Hub } from './hub.ts';
import { pick, type LineKey } from './lines.ts';
import { clearActiveCall, noteActiveCall } from './recovery.ts';
import { errText, log, maskPhone, warn } from './log.ts';
import { Mixer } from './mixer.ts';
import { Narrator, PRIORITY } from './narrator.ts';
import { RelaySlots } from './relay-slots.ts';
import { CallerScanner } from './scanner.ts';
import { cropRgba, OUT_H, OUT_W, VideoRelay } from './video.ts';

const POLL_MS = 400;
const ANSWER_TIMEOUT_MS = 60_000;
const MUST_GO_BEFORE_MS = 20_000;
const FAREWELL_WAIT_MS = 3_000;
const AUTO_SCAN_AFTER_PIN_MS = 5_000;
const SETUP_WAIT_MS = 10_000; // guess: the LiveKit connects before POST /calls starts
const CLEANUP_MARGIN_MS = 3_000; // guess: disconnects plus deleteRoom
const WEB_GONE_GRACE_MS = 10_000; // guess: long enough for a page reload to rejoin
const WEAPON_WAIT_MS = 20_000; // spec D.3: Part D guarantees a prefab fallback by 15 s
const TRACKS_VISIBLE_WAIT_MS = 3_000; // guess: the server showed the second track about 200 ms late in the fake-Chert e2e
/** Longest that end() can take; main's hard stop on signals must be longer. */
export const END_MAX_MS = Math.max(SETUP_WAIT_MS, CREATE_AFTER_CANCEL_MAX_MS, FAREWELL_WAIT_MS) + END_CALL_MAX_MS + CLEANUP_MARGIN_MS;
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
  private chertEnd: Promise<number> | null = null;
  private setup: Promise<void> | null = null;
  private bridgeReadyAt = 0;
  private dialedAt = 0;
  private allocatedAt = 0; // when Chert took the call off the shared-line queue; the call cap counts from it
  private ringStartedAt = 0; // first dialing or ringing status or event; the no-answer clock counts from it
  private statusAt202: string | undefined;
  private queuedNameUnknown = false; // a 202 with no status: the first polled status names the queue
  private lastStatus: string | undefined;
  private chertSaidEnded = false; // a later POST /end may get a 4xx for a call that is already over
  private timers: NodeJS.Timeout[] = [];
  private playerMic: RemoteTrack | null = null;
  private lastWeapon: WeaponSpawn | null = null;
  private awaitingWeapon = false;
  private scanRequested = false;
  private autoScanUsed = false;
  private weaponTimer: NodeJS.Timeout | null = null;
  private ending: Promise<void> | null = null;
  private cleanedUp = false;
  private relays = new RelaySlots<'friend-cam' | 'friend-audio'>(async (sid) => {
    if (!this.ending) await this.game.localParticipant?.unpublishTrack(sid);
  });

  /** bootId keeps Idempotency-Keys unique when the agent restarts and the same session calls again. */
  constructor(msg: StartMsg, attempt: number, bootId: string, private hub: Hub, private onDone: () => void) {
    this.sid = msg.sessionId;
    this.friend = msg.friend;
    this.gameRoomName = msg.gameRoom;
    this.ftRoom = `ft-${this.sid}-${attempt}`;
    this.keyBase = `ithaca-${this.sid}-${bootId}-${attempt}`;
    this.bridgeIdentity = this.mock ? MOCK_BRIDGE_IDENTITY : `facetime-bridge-${attempt}`;
    this.scanner = new CallerScanner(this.sid);
    this.narrator = new Narrator(this.mixer, (text, priority) => this.hub.send({ type: 'narration', sessionId: this.sid, text, priority }));
  }

  /** Token for dev/fake-phone.html (mock-call only). */
  fakePhoneToken(): Promise<string> {
    return mint(MOCK_BRIDGE_IDENTITY, this.ftRoom, '30m');
  }

  async run(): Promise<void> {
    // If a connect outlives end()'s setup wait, cleanup has already run and missed that room: release it here.
    this.setup = this.setUp().finally(() => (this.cleanedUp ? this.releaseRooms() : undefined));
    try {
      await this.setup;
    } catch (e) {
      const reason = e instanceof ChertError ? e.code : 'agent_error';
      warn('call_run_failed', { error: errText(e) });
      await this.end(reason, 'failed');
    }
  }

  /** Every await is followed by an ending check, so an end() during setup stops it. end() waits for this. */
  private async setUp(): Promise<void> {
    this.status('dialing');
    log('call_start', { sid: this.sid, friend: this.friend.name, phone: maskPhone(this.friend.phoneE164), ftRoom: this.ftRoom, mode: env.AGENT_MODE });
    await this.joinGameRoom();
    if (this.ending) return;
    await this.joinFtRoom();
    if (this.ending) return;
    if (this.mock) {
      this.status('ringing');
      log('mock_waiting_for_fake_phone', { open: `http://localhost:${env.AGENT_HEALTH_PORT}/dev/fake-phone?sid=${encodeURIComponent(this.sid)}` });
      return;
    }
    await this.dial();
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
    this.game.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (!p.identity.startsWith('web-') || this.ending) return;
      log('web_left_game_room', { identity: p.identity, graceMs: WEB_GONE_GRACE_MS });
      this.timers.push(setTimeout(() => {
        const back = [...this.game.remoteParticipants.values()].some((q) => q.identity.startsWith('web-'));
        if (!back) void this.end('web_gone', 'ended');
      }, WEB_GONE_GRACE_MS));
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
        if (this.mock) void this.end('remote_hangup', 'ended', { quick: true });
      }
    });
    this.ft.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      log('ft_track', { name: pub.name, from: p.identity });
      if (p.identity !== this.bridgeIdentity) return;
      if (pub.name === 'facetime-remote-video') this.relayCallerVideo(track, pub.sid!);
      if (pub.name === 'facetime-remote-audio') this.relayCallerAudio(track, pub.sid!);
    });
    this.ft.on(RoomEvent.TrackUnsubscribed, (_t: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (p.identity !== this.bridgeIdentity) return;
      if (pub.name === 'facetime-remote-video') void this.relays.drop('friend-cam', pub.sid!);
      if (pub.name === 'facetime-remote-audio') void this.relays.drop('friend-audio', pub.sid!);
    });
    this.ft.on(RoomEvent.LocalTrackPublished, () => this.checkInvariants());
    this.ft.on(RoomEvent.Disconnected, (r) => { if (!this.ending) warn('ft_room_disconnected', { reason: r }); });

    await this.ft.connect(env.LIVEKIT_URL, await mint(AGENT_FT_IDENTITY, this.ftRoom, '2h'), { autoSubscribe: true, dynacast: false });
    if (this.ending) return;
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

  /** A new bridge subscription replaces the old relay, never adds a second. */
  private relay(name: 'friend-cam' | 'friend-audio', from: string, stream: { cancel(): Promise<void> }, source: { close(): Promise<void> }, track: LocalVideoTrack | LocalAudioTrack, opts: TrackPublishOptions): void {
    const label = name.replace('-', '_');
    this.relays.replace(name, from, { stream, source }, () => this.game.localParticipant!.publishTrack(track, opts)
      .then((p) => { log(`${label}_published`); return p.sid; })
      .catch((e) => { warn(`${label}_publish_failed`, { error: errText(e) }); return undefined; }));
  }

  private relayCallerVideo(track: RemoteTrack, from: string): void {
    const source = new VideoSource(OUT_W, OUT_H);
    const stream = new VideoStream(track);
    this.relay('friend-cam', from, stream, source, LocalVideoTrack.createVideoTrack('friend-cam', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA, simulcast: false }));
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

  private relayCallerAudio(track: RemoteTrack, from: string): void {
    const source = new AudioSource(48_000, 1, 100);
    const stream = new AudioStream(track, { sampleRate: 48_000, numChannels: 1 });
    this.relay('friend-audio', from, stream, source, LocalAudioTrack.createAudioTrack('friend-audio', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    void (async () => {
      try { for await (const f of stream) await source.captureFrame(f); }
      catch (e) { warn('caller_audio_ended', { error: errText(e) }); }
    })();
  }

  // ── Chert (live) ─────────────────────────────────────────────

  private async dial(): Promise<void> {
    const names = new Set([...this.ft.localParticipant!.trackPublications.values()].map((p) => p.name));
    if (!names.has('agent-video') || !names.has('quartermaster-audio')) throw new Error('agent tracks not published before dialing');
    await this.waitTracksVisible();
    if (this.ending) return;
    const bridgeToken = await mint(this.bridgeIdentity, this.ftRoom, '30m');
    if (this.ending) return;
    this.dialedAt = Date.now();
    const { id, queued, status } = await createCall({
      destination: this.friend.phoneE164, livekitUrl: env.LIVEKIT_URL,
      participantToken: bridgeToken, remoteIdentity: this.ft.localParticipant!.identity,
    }, `${this.keyBase}-create`, () => !!this.ending);
    this.callId = id;
    if (queued) this.statusAt202 = status;
    this.queuedNameUnknown = queued && !status;
    log('chert_call_created', { callId: id, queued, ms: Date.now() - this.dialedAt });
    await noteActiveCall(id, `${this.keyBase}-end`).catch(() => {});
    if (this.ending) {
      log('chert_call_created_after_end', { callId: id });
      await this.endChert();
      return;
    }
    void this.pollEvents();
  }

  /** Chert checks the room on the server, which can list a just-published track a moment after we have it. */
  private async waitTracksVisible(): Promise<void> {
    const until = Date.now() + TRACKS_VISIBLE_WAIT_MS;
    for (;;) {
      const me = (await this.roomService().listParticipants(this.ftRoom).catch(() => [])).find((p) => p.identity === AGENT_FT_IDENTITY);
      const seen = new Set(me?.tracks.map((t) => t.name));
      if (seen.has('agent-video') && seen.has('quartermaster-audio')) return;
      if (Date.now() > until || this.ending) { warn('agent_tracks_not_visible_on_server', { seen: [...seen] }); return; }
      await sleep(100);
    }
  }

  /** POST /end once per call, whoever asks first. */
  private endChert(): Promise<number> {
    this.chertEnd ??= endCall(this.callId!, `${this.keyBase}-end`).catch((e) => { warn('chert_end_failed', { error: errText(e) }); return 0; });
    return this.chertEnd;
  }

  /**
   * Each tick reads the status and the events. Allocation is applied before the events, so the deadline counts from it;
   * a terminal status is applied after them, so an end event's reason wins.
   */
  private async pollEvents(): Promise<void> {
    const seen = new Set<string>();
    while (!this.ending && this.callId) {
      const [status, events] = await Promise.all([
        getCallStatus(this.callId).catch((e) => { warn('chert_status_failed', { error: errText(e) }); return undefined; }),
        getEvents(this.callId).catch((e) => { warn('chert_poll_failed', { error: errText(e) }); return []; }),
      ]);
      if (this.ending) return;
      if (status !== undefined && status !== this.lastStatus) { this.lastStatus = status; log('chert_status', { status }); }
      if (status && this.queuedNameUnknown) { this.queuedNameUnknown = false; this.statusAt202 = queuedNameAfter202(status); }
      if (status && !this.allocatedAt) this.checkQueue(status);
      if (status && startsRingClock(status, this.statusAt202)) this.startRingClock(`status:${status}`);
      for (const ev of events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        log('chert_event', { type: ev.type, reason: ev.reason });
        this.onChertEvent(ev);
        if (this.ending) return;
      }
      const ended = status ? terminalStatus(status) : null;
      if (ended) { this.chertSaidEnded = true; void this.end(ended === 'failed' ? 'chert_failed' : 'remote_ended', ended, { quick: true }); return; }
      if (this.ringStartedAt && !this.bridgeReadyAt && Date.now() - this.ringStartedAt > ANSWER_TIMEOUT_MS) { await this.end('no_answer', 'failed'); return; }
      await sleep(POLL_MS);
    }
  }

  private startRingClock(via: string): void {
    if (this.ringStartedAt) return;
    this.ringStartedAt = Date.now();
    log('chert_ring_clock_started', { via, msAfterDial: this.ringStartedAt - this.dialedAt });
  }

  private checkQueue(status: string): void {
    if (isQueuedStatus(status, this.statusAt202)) return;
    this.allocatedAt = Date.now();
    log('chert_call_allocated', { status, queuedMs: this.allocatedAt - this.dialedAt });
  }

  /** Allocation is decided only by checkQueue: event names are partly guessed, and a queued event must not start the call cap. */
  private onChertEvent(ev: ChertEvent): void {
    switch (chertEventKind(ev.type)) {
      case 'ready': this.onBridgeReady(ev.type); break;
      case 'ringing': if (startsRingClock(ev.type)) this.startRingClock(`event:${ev.type}`); if (this.state === 'dialing') this.status('ringing'); break;
      case 'no_video': this.say('cantSee', PRIORITY.scan); break;
      case 'ended': this.chertSaidEnded = true; void this.end(ev.reason ?? 'remote_ended', 'ended', { quick: true }); break;
      case 'failed': this.chertSaidEnded = true; void this.end(ev.reason ?? 'chert_failed', 'failed', { quick: true }); break;
      case 'other': break;
    }
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
    // Chert's 5-minute cap may count from allocation, not answer, so the deadline does too.
    const left = (this.allocatedAt || this.bridgeReadyAt) + env.CALL_MAX_MS - Date.now();
    this.timers.push(setTimeout(() => this.say('mustGo', PRIORITY.scan), left - MUST_GO_BEFORE_MS));
    this.timers.push(setTimeout(() => void this.end('time_limit', 'ended'), left));
  }

  private say(key: LineKey, priority: number): void {
    const l = pick(key);
    this.narrator.say(l.text, priority, l.pcm);
  }

  private onGameEvent(e: GameEvent): void {
    if (!this.bridgeReadyAt || this.ending) return;
    switch (e.kind) {
      case 'match_start': this.say('matchStart', PRIORITY.flavor); break;
      case 'wave_start': this.say('waveStart', PRIORITY.flavor); break;
      case 'wave_cleared': this.say('waveCleared', PRIORITY.flavor); break;
      case 'health_low': this.say('healthLow', PRIORITY.danger); break;
      case 'boss_spawn': this.say('bossSpawn', PRIORITY.danger); break;
      case 'player_pinned':
        this.say('pinned', PRIORITY.danger);
        if (this.autoScanUsed) break;
        this.autoScanUsed = true;
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

  /** Every request gets a scan.status reply. A request during a scan repeats the current state. */
  private async runScan(): Promise<void> {
    if (this.ending) return;
    if (!this.bridgeReadyAt) return this.scanStatus('failed', { reason: 'not_connected' });
    if (this.scanner.scanning) return this.scanStatus('looking');
    if (this.awaitingWeapon) return this.scanStatus('forging');
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
    this.weaponTimer = setTimeout(() => {
      if (!this.awaitingWeapon || this.ending) return;
      this.awaitingWeapon = false;
      warn('weapon_spawn_timeout', { waitedMs: WEAPON_WAIT_MS });
      this.scanStatus('failed', { reason: 'forge_timeout' });
    }, WEAPON_WAIT_MS);
    this.timers.push(this.weaponTimer);
  }

  private onWeapon(w: WeaponSpawn): void {
    if (this.ending) return;
    this.lastWeapon = w;
    const fromOurScan = this.awaitingWeapon;
    this.awaitingWeapon = false;
    if (this.weaponTimer) clearTimeout(this.weaponTimer);
    if (!this.bridgeReadyAt) return;
    this.narrator.say(`The ${w.displayName} is in his hands!`, PRIORITY.weapon);
    if (fromOurScan) this.scanStatus('done', { objectName: w.objectName, displayName: w.displayName });
  }

  // ── end + cleanup (every exit path goes through here) ────────

  end(reason: string, final: 'ended' | 'failed', opts: { quick?: boolean } = {}): Promise<void> {
    this.ending ??= this.doEnd(reason, final, opts);
    return this.ending;
  }

  /** quick = no farewell (the friend is already gone, or the process is crashing). */
  private async doEnd(reason: string, final: 'ended' | 'failed', opts: { quick?: boolean }): Promise<void> {
    log('call_ending', { reason, final, callId: this.callId });
    this.status('ending', reason);
    for (const t of this.timers) clearTimeout(t);
    this.scanner.cancel();
    let endStatus = 0;
    try {
      // A connect or a create in flight would otherwise finish after cleanup and leave a room or a call behind.
      // Once POST /calls has started, wait for its whole retry run: a late reply is the only way to learn the call id.
      await Promise.race([this.setup?.catch(() => {}), sleep(this.dialedAt ? CREATE_AFTER_CANCEL_MAX_MS : SETUP_WAIT_MS)]);
      if (this.bridgeReadyAt && !opts.quick) {
        const f = pick('farewell');
        await Promise.race([this.narrator.sayNow(f.text, PRIORITY.greeting, f.pcm), sleep(FAREWELL_WAIT_MS)]);
      }
      if (this.callId) log('chert_end', { status: (endStatus = await this.endChert()) });
    } finally {
      this.narrator.stop();
      await Promise.allSettled([...this.relays.closeAll(), this.mixer.close(), this.video.close()]);
      this.cleanedUp = true;
      await this.releaseRooms();
      if (this.callId && (this.chertSaidEnded || endConfirmed(endStatus))) await clearActiveCall().catch(() => {});
      else if (this.callId) warn('chert_end_unconfirmed_kept_for_recovery', { callId: this.callId, status: endStatus });
      this.status(final, reason);
      log('call_cleaned_up', { ftRoom: this.ftRoom, elapsedMs: this.bridgeReadyAt ? Date.now() - this.bridgeReadyAt : 0 });
      this.onDone();
    }
  }

  private async releaseRooms(): Promise<void> {
    await Promise.allSettled([this.ft.disconnect(), this.game.disconnect()]);
    await this.roomService().deleteRoom(this.ftRoom).catch((e) => warn('delete_room_failed', { error: errText(e) }));
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
