// Session controller: wires the hub (D), call media (B), input (C/A) and the engine to the app store.
import type { GameEvent, InputController, ServerToWeb, TrickshotKind, WeaponSpawn } from '@ithaca/shared';
import { getNet, setMockFriendName, type Net } from '../net';
import { connectCallMedia, disconnectCallMedia, onCallBridge, getCallBridge } from '../net/callBridge';
import { useApp, pushToast, pushNarration, setHud, emptyTrickshots, type ForgedUse, isCallLive } from '../state/store';
import type { Engine, EngineCallbacks } from './engine/Engine';
import { startKillcam, stopKillcam } from './killcam';
import { getFriendViewStream } from './friendView';
import { createInput, type InputKind } from '../input';
import { audio } from './engine/audio';
import { mockThumb } from '../net/mockCatalog';

export const runtime: {
  engine: Engine | null;
  canvas: HTMLCanvasElement | null;
  input: InputController | null;
  net: Net | null;
  forged: Map<string, ForgedUse>;
} = { engine: null, canvas: null, input: null, net: null, forged: new Map() };

const LS_PLAYER = 'ithaca.player.v1';
let callWatchdog: ReturnType<typeof setTimeout> | null = null;
let scanWatchdog: ReturnType<typeof setTimeout> | null = null;
let lastGesture = '';

// ── boot ────────────────────────────────────────────────────────────────
export async function bootNet() {
  const net = await getNet();
  runtime.net = net;
  useApp.setState({ netMode: net.mode, netReason: net.reason });
  net.hub.onStatus((s) => useApp.setState({ hubStatus: s }));
  net.hub.on(onServer);
  onCallBridge((b) => {
    useApp.setState({ mediaStatus: b.status });
    if (b.media) {
      b.media.onFriendCam((el) => useApp.setState({ friendCam: el }));
    }
  });
  // restore player + friend
  try {
    const raw = localStorage.getItem(LS_PLAYER);
    if (raw) {
      const saved = JSON.parse(raw) as { player?: { id: string; name: string }; friend?: { friendId: string; name: string; phoneMasked: string }; mode?: string };
      if (saved.mode === net.mode) {
        useApp.setState({ player: saved.player ?? null, friend: saved.friend ?? null });
        if (saved.friend) setMockFriendName(saved.friend.name);
      }
    }
  } catch { /* ignore */ }
}

export function persistPlayer() {
  const s = useApp.getState();
  try { localStorage.setItem(LS_PLAYER, JSON.stringify({ player: s.player, friend: s.friend, mode: runtime.net?.mode })); } catch { /* ignore */ }
}

// ── input ───────────────────────────────────────────────────────────────
export async function setupInput(kind: InputKind) {
  runtime.input?.stop();
  const created = await createInput(kind);
  runtime.input = created.controller;
  useApp.setState({ inputKind: created.kind, inputFallback: created.fallbackReason });
  if (created.fallbackReason) pushToast({ kind: 'warn', title: 'KEYBOARD & MOUSE', sub: created.fallbackReason }, 2600);
  try { await created.controller.start(); } catch (err) {
    console.warn('[input] start failed', err);
    if (created.kind !== 'keyboard_mouse') return setupInput('keyboard_mouse');
  }
  runtime.engine?.setInput(created.controller);
  return created;
}

// ── session ─────────────────────────────────────────────────────────────
export async function ensureSession(): Promise<boolean> {
  const net = runtime.net ?? (await getNet());
  const st = useApp.getState();
  if (st.session) return true;
  try {
    let player = st.player;
    if (!player) {
      const { playerId } = await net.api.createPlayer('Odysseus');
      player = { id: playerId, name: 'Odysseus' };
      useApp.setState({ player });
    }
    const s = await net.api.createSession(player.id);
    useApp.setState({ session: { id: s.sessionId, gameRoom: s.gameRoom } });
    net.hub.connect(s.sessionId);
    // publish friend-view + mic into the game room (Part B's module, live mode only)
    void connectCallMedia(net.api, s.sessionId, getFriendViewStream());
    return true;
  } catch (err) {
    console.warn('[session] failed', err);
    pushToast({ kind: 'warn', title: 'SERVER UNAVAILABLE', sub: 'Playing offline — Phone a Friend is disabled' }, 3000);
    return false;
  }
}

export function requestCall() {
  const st = useApp.getState();
  const net = runtime.net;
  if (!net || !st.session) { pushToast({ kind: 'warn', title: 'NOT CONNECTED', sub: 'No session yet' }); return; }
  if (!st.friend) { pushToast({ kind: 'warn', title: 'NO TELEMACHUS YET', sub: 'Add a friend in Setup first' }, 2200); return; }
  if (isCallLive(st.call.state)) return;
  if (!net.agentConnected && net.mode === 'live') {
    pushToast({ kind: 'warn', title: 'TELEMACHUS IS AWAY', sub: 'The call agent is offline' }, 2400);
  }
  useApp.setState({ call: { state: 'dialing' } });
  audio.unlock();
  // this key press / click is a user gesture: let the call's audio (Part B) play once it arrives
  void getCallBridge().media?.startAudio?.();
  audio.ring();
  net.hub.send({ type: 'call.request', friendId: st.friend.friendId });
  armCallWatchdog(75_000);
}

/** Give up on a call that never connects. Re-armed by each dialing/ringing status, and stretched while the agent
 *  waits its turn on the shared phone line (B queues up to 2 min before the 60 s ring). */
function armCallWatchdog(ms: number) {
  const net = runtime.net;
  if (callWatchdog) clearTimeout(callWatchdog);
  callWatchdog = setTimeout(() => {
    const s = useApp.getState().call.state;
    if (s === 'dialing' || s === 'ringing') {
      useApp.setState({ call: { state: 'failed', reason: 'timeout' } });
      net?.hub.send({ type: 'call.end' });
      pushToast({ kind: 'warn', title: 'NO ANSWER', sub: `${friendTitle()} didn’t pick up. Press C to try again.` }, 2800);
    }
  }, ms);
}

/** How the friend is named on screen — the same as the Quartermaster says it on the call ("Warrior <name>"). */
export function friendTitle(): string {
  const n = useApp.getState().friend?.name;
  return n ? `Warrior ${n}` : 'Telemachus';
}

export function endCall() {
  runtime.net?.hub.send({ type: 'call.end' });
}

export function requestWeapon() {
  const st = useApp.getState();
  const net = runtime.net;
  if (!net) return;
  if (st.call.state !== 'connected') {
    pushToast({ kind: 'warn', title: 'CALL TELEMACHUS FIRST', sub: 'Make the phone sign (or press C)' }, 2000);
    return;
  }
  if (st.scan.state === 'looking' || st.scan.state === 'detected' || st.scan.state === 'forging') return;
  useApp.setState({ scan: { state: 'looking', pct: 0, at: performance.now() } });
  net.hub.send({ type: 'scan.request' });
  audio.lyre([0, 7], 0.08, 392);
}

export function sendGameEvent(e: GameEvent) {
  runtime.net?.hub.send({ type: 'game.event', event: e });
}

// ── server messages ─────────────────────────────────────────────────────
function onServer(m: ServerToWeb) {
  switch (m.type) {
    case 'call.status': {
      const prev = useApp.getState().call;
      const connectedAt = m.state === 'connected' ? (prev.state === 'connected' ? prev.connectedAt : performance.now() - (m.elapsedMs ?? 0)) : prev.connectedAt;
      useApp.setState({ call: { state: m.state, reason: m.reason, connectedAt, elapsedMs: m.elapsedMs } });
      runtime.engine?.setCallActive(m.state === 'connected');
      if (m.state === 'dialing' || m.state === 'ringing') armCallWatchdog(m.reason?.startsWith('line_busy') ? 150_000 : 75_000);
      if (m.state === 'connected' && prev.state !== 'connected') {
        if (callWatchdog) clearTimeout(callWatchdog);
        audio.lyre([0, 4, 7, 12], 0.07, 293.7);
        pushToast({ kind: 'gift', title: `${friendTitle().toUpperCase()} IS ON THE LINE`, sub: useApp.getState().inputKind === 'keyboard_mouse' ? 'Press Q to ask for a weapon' : 'Raise both arms to ask for a weapon' }, 3000);
        void getCallBridge().media?.startAudio?.();
      }
      if (m.state === 'ringing' && prev.state !== 'ringing') audio.ring();
      if ((m.state === 'failed' || m.state === 'ended') && prev.state === 'connected') {
        pushToast({ kind: 'warn', title: m.state === 'failed' ? 'CALL DROPPED' : 'CALL ENDED', sub: `${friendTitle()} is away` }, 2400);
      }
      if (m.state === 'failed' && prev.state !== 'connected') {
        if (callWatchdog) clearTimeout(callWatchdog);
        pushToast({ kind: 'warn', title: 'CALL FAILED', sub: reasonText(m.reason) }, 2800);
      }
      break;
    }
    case 'scan.status': {
      const prev = useApp.getState().scan;
      useApp.setState({ scan: { ...prev, state: m.state, objectName: m.objectName ?? prev.objectName, displayName: m.displayName ?? prev.displayName, reason: m.reason, at: performance.now(), pct: m.state === 'looking' ? 0 : prev.pct } });
      if (m.state === 'detected' || m.state === 'forging') {
        runtime.engine?.forgeGlow(0.6);
        if (scanWatchdog) clearTimeout(scanWatchdog);
        scanWatchdog = setTimeout(() => fallbackSpawn(), 16_000);
      }
      if (m.state === 'failed') {
        pushToast({ kind: 'warn', title: 'COULDN’T MAKE IT OUT', sub: 'Hold it closer and ask again (Q)' }, 2200);
        setTimeout(() => { if (useApp.getState().scan.state === 'failed') useApp.setState({ scan: { state: 'idle', pct: 0, at: performance.now() } }); }, 3000);
      }
      if (m.state === 'done') setTimeout(() => { if (useApp.getState().scan.state === 'done') useApp.setState({ scan: { state: 'idle', pct: 0, at: performance.now() } }); }, 2500);
      break;
    }
    case 'forge.progress':
      useApp.setState((s) => ({ scan: { ...s.scan, state: s.scan.state === 'looking' || s.scan.state === 'detected' ? 'forging' : s.scan.state, pct: m.pct, stage: m.stage } }));
      runtime.engine?.forgeGlow(0.5 + (m.pct / 100) * 0.5);
      break;
    case 'weapon.spawn':
      onWeaponSpawn(m.weapon);
      break;
    case 'narration':
      pushNarration(m.text, m.priority);
      break;
    case 'armory.new':
      useApp.setState((s) => ({ armoryPulse: s.armoryPulse + 1, newestWeaponId: m.weaponId }));
      break;
    case 'error':
      console.warn('[hub] error', m.code, m.message);
      break;
  }
}

export function reasonText(r?: string) {
  switch (r) {
    case 'agent_offline': return 'The Quartermaster is offline — try again shortly';
    case 'line_busy': return 'The line is busy';
    case 'tts_not_ready': return 'The Quartermaster lost his voice — try again shortly';
    case 'no_answer': case 'timeout': return 'No answer';
    default: {
      // B waits its turn on the shared phone line: line_busy_<position in the queue>
      const q = r?.match(/^line_busy_(\d+)$/);
      if (q) return `The line is busy — #${q[1]} in the queue`;
      return r ? r.replace(/_/g, ' ') : `${friendTitle()} is away`;
    }
  }
}

function onWeaponSpawn(w: WeaponSpawn) {
  if (scanWatchdog) { clearTimeout(scanWatchdog); scanWatchdog = null; }
  if (runtime.forged.has(w.weaponId)) return;
  runtime.forged.set(w.weaponId, {
    weaponId: w.weaponId, displayName: w.displayName, objectName: w.objectName, weaponClass: w.weaponClass,
    thumbUrl: w.thumbUrl, kills: 0, fallback: w.fallback,
  });
  useApp.setState({ lastForged: w, incoming: w, scan: { ...useApp.getState().scan, state: 'done', pct: 100, at: performance.now() } });
  setTimeout(() => { if (useApp.getState().incoming?.weaponId === w.weaponId) useApp.setState({ incoming: null }); }, 3200);
  void runtime.engine?.spawnForged(w);
}

/** Forge stalled: a stock weapon flies in anyway (research: never leave the player empty-handed). */
function fallbackSpawn() {
  const sc = useApp.getState().scan;
  if (sc.state !== 'detected' && sc.state !== 'forging') return;
  const name = sc.objectName ?? 'gift';
  onWeaponSpawn({
    weaponId: `prefab-local-${Date.now()}`, glbUrl: '/prefabs/spear.glb', weaponClass: 'spear', objectName: name,
    displayName: sc.displayName ?? 'Spear of the Storeroom', friendName: useApp.getState().friend?.name ?? 'Telemachus',
    fallback: true, thumbUrl: mockThumb(name, 'spear'),
  });
}

// ── engine callbacks ────────────────────────────────────────────────────
export function engineCallbacks(): EngineCallbacks {
  return {
    emit: (e) => sendGameEvent(e),
    hud: (patch) => setHud(patch),
    toast: (t, ttl) => pushToast(t, ttl),
    slowmo: (on, trick, weaponName) => {
      setHud({ slowmo: on });
      if (on && trick) startKillcam(runtime.canvas, trick, weaponName, onClip);
      if (!on) stopKillcam(400);
    },
    matchEnd: (r) => {
      for (const [id, k] of Object.entries(r.forgedKills)) {
        const f = runtime.forged.get(id);
        if (f) f.kills = k;
      }
      useApp.setState({
        results: {
          score: r.score, kills: r.kills, durationMs: r.durationMs, victory: r.victory,
          trickshots: { ...emptyTrickshots(), ...r.trickshots }, forged: [...runtime.forged.values()], bestCombo: r.bestCombo, wave: r.wave,
        },
        submitted: null,
      });
      useApp.getState().go('results');
    },
    requestCall: () => requestCall(),
    requestWeapon: () => requestWeapon(),
    pinnedPrompt: (show) => setHud({ pinnedPrompt: show && !isCallLive(useApp.getState().call.state) }),
    tracking: (s) => useApp.setState({ tracking: s }),
    pendingGesture: (g) => {
      const key = g ? `${g.name}:${g.progress.toFixed(2)}` : '';
      if (key === lastGesture) return;
      lastGesture = key;
      useApp.setState({ pendingGesture: g });
    },
    bowMode: (on) => useApp.setState({ bowMode: on }),
  };
}

function onClip(c: { blob: Blob; url: string; trickshot: TrickshotKind; weaponName?: string; at: number }) {
  useApp.setState((s) => ({ killcams: [...s.killcams.slice(-2), { url: c.url, trickshot: c.trickshot, at: c.at, weaponName: c.weaponName }] }));
  const sid = useApp.getState().session?.id;
  if (sid && runtime.net) {
    runtime.net.api.uploadKillcam(c.blob, sid, c.trickshot).catch((err) => console.warn('[killcam] upload failed', err.message));
  }
}

export function startMatch() {
  const st = useApp.getState();
  const keep = new Set(runtime.engine?.forgedOnRack() ?? []);
  for (const id of [...runtime.forged.keys()]) if (!keep.has(id)) runtime.forged.delete(id);
  for (const f of runtime.forged.values()) f.kills = 0;
  useApp.setState({ killcams: [], results: null, paused: false, scan: { state: 'idle', pct: 0, at: 0 }, incoming: null, narration: st.narration.slice(-1) });
  audio.unlock();
  void getCallBridge().media?.startAudio?.(); // Start is a user gesture (B.8 autoplay)
  runtime.engine?.setCallActive(st.call.state === 'connected');
  runtime.engine?.startMatch(st.difficulty);
}

export function setMic(on: boolean) {
  useApp.setState({ micEnabled: on });
  getCallBridge().media?.setMicEnabled(on);
}

export async function shutdownCall() {
  endCall();
  await disconnectCallMedia();
}
