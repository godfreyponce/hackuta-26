import type { GameEvent, ServerToWeb, WeaponSpawn } from '@ithaca/shared';
import type { Hub, HubStatus, Outgoing } from './types';
import { MOCK_OBJECTS, mockThumb } from './mockCatalog';
import { mockArmoryPush } from './mockApi';

/** Mock hub (VITE_MOCK_SERVER=1 or server unreachable). Same interface as the WS client (spec A.10). */
export function createMockHub(getFriendName: () => string): Hub {
  let sessionId = '';
  let st: HubStatus = 'idle';
  const subs = new Set<(m: ServerToWeb) => void>();
  const statusSubs = new Set<(s: HubStatus) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let narrTimer: ReturnType<typeof setInterval> | null = null;
  let callState: 'idle' | 'connected' | 'busy' = 'idle';
  let scanBusy = false;
  let objIndex = 0;
  let lastLine = '';
  let lastSpoke = 0;

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const push = (m: Record<string, unknown> & { type: ServerToWeb['type'] }) => {
    const msg = { v: 1, sessionId, ts: Date.now(), ...m } as ServerToWeb;
    subs.forEach((cb) => { try { cb(msg); } catch (err) { console.warn('[mockHub] subscriber', err); } });
  };
  const say = (text: string, priority = 10) => {
    const now = Date.now();
    if (priority < 80 && now - lastSpoke < 2500) return;
    if (text === lastLine) return;
    lastLine = text;
    lastSpoke = now;
    push({ type: 'narration', text, priority });
  };
  const friend = () => getFriendName() || 'Telemachus';

  const FLAVOR = [
    'Watch his footwork. Old man still has it.',
    'They keep coming through the far doors.',
    'Keep that bow strung, Odysseus!',
    "The hearth's burning low. So are they.",
    'More wooers in the courtyard. Stay sharp.',
  ];
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

  function onGameEvent(e: GameEvent) {
    switch (e.kind) {
      case 'match_start': say(`Here they come. Wave ${e.data?.wave ?? 1}.`, 50); break;
      case 'wave_start': say(`Here they come. Wave ${e.data?.wave ?? ''}.`, 50); break;
      case 'player_pinned': say(getFriendName() ? `He's pinned! Find him a weapon, ${friend()} — anything long!` : "He's pinned! Take another blade from the table!", 70); break;
      case 'health_low': say(getFriendName() ? `He's bleeding badly. Hurry, ${friend()}.` : "He's bleeding. Hold the threshold, Odysseus.", 70); break;
      case 'boss_spawn': say("That's Antinous. He hides behind that gilded shield — break it, or get round it.", 70); break;
      case 'wave_cleared': say('Wave cleared. Breathe.', 40); break;
      case 'item_kill': say(`Your ${e.data?.weaponName ?? 'gift'} just flattened a wooer. Ha!`, 50); break;
      case 'trickshot':
        if (e.data?.trickshot === 'pin') say('Pinned him to the pillar! Did you see that?', 50);
        else if (e.data?.trickshot === 'multi_kill') say('Two with one throw!', 50);
        else if (e.data?.trickshot === 'headshot') say('Right between the eyes.', 30); // thrown & loosed only
        break;
      case 'match_end':
        if ((e.data?.health ?? 1) <= 0) say('The wooers feast on in your hall.', 100);
        else say(getFriendName() ? `The hall is ours. Thank you, ${friend()}.` : 'The hall is yours again, Odysseus.', 100);
        break;
      default: break;
    }
  }

  function startCall() {
    if (callState !== 'idle') return;
    callState = 'busy';
    push({ type: 'call.status', state: 'dialing' });
    later(1000, () => push({ type: 'call.status', state: 'ringing' }));
    later(4000, () => {
      callState = 'connected';
      push({ type: 'call.status', state: 'connected', elapsedMs: 0 });
      say(`${friend()}! Your father's home and the hall is full of wooers. Watch; I'll tell you when he needs steel.`, 100);
      narrTimer = setInterval(() => say(pick(FLAVOR), 10), 8000);
    });
  }

  function endCall(reason = 'user') {
    if (callState === 'idle') return;
    if (narrTimer) { clearInterval(narrTimer); narrTimer = null; }
    push({ type: 'call.status', state: 'ending', reason });
    later(800, () => { callState = 'idle'; push({ type: 'call.status', state: 'ended', reason }); });
  }

  function scan() {
    if (scanBusy) return;
    scanBusy = true;
    const obj = MOCK_OBJECTS[objIndex++ % MOCK_OBJECTS.length];
    const forgeId = `mock-forge-${Date.now()}`;
    push({ type: 'scan.status', state: 'looking' });
    say(`Hold something up to your camera, ${friend()} — a broom, a pan, anything!`, 90);
    later(2000, () => {
      push({ type: 'scan.status', state: 'detected', objectName: obj.objectName, displayName: obj.displayName });
      say(obj.quip, 90);
      push({ type: 'scan.status', state: 'forging', objectName: obj.objectName, displayName: obj.displayName });
      const stages = ['vision', 'crop', '3d', 'store'] as const;
      for (let i = 0; i <= 10; i++) {
        later(i * 200, () => push({ type: 'forge.progress', forgeId, stage: stages[Math.min(3, Math.floor(i / 3))], pct: i * 10 }));
      }
      later(2100, () => {
        const thumbUrl = mockThumb(obj.objectName, obj.weaponClass);
        const weapon: WeaponSpawn = {
          weaponId: `mock-${Date.now().toString(16)}`,
          glbUrl: obj.glbUrl,
          weaponClass: obj.weaponClass,
          objectName: obj.objectName,
          displayName: obj.displayName,
          friendName: friend(),
          fallback: false,
          thumbUrl,
        };
        push({ type: 'weapon.spawn', weapon });
        push({ type: 'scan.status', state: 'done', objectName: obj.objectName, displayName: obj.displayName });
        push({ type: 'armory.new', weaponId: weapon.weaponId, displayName: weapon.displayName, thumbUrl });
        mockArmoryPush(weapon);
        say(`${/^the /i.test(obj.displayName) ? obj.displayName : `The ${obj.displayName}`} is in his hands!`, 80);
        scanBusy = false;
      });
    });
  }

  return {
    mode: 'mock',
    connect(sid) {
      sessionId = sid;
      st = 'open';
      statusSubs.forEach((cb) => cb(st));
    },
    send(m: Outgoing) {
      switch (m.type) {
        case 'call.request': startCall(); break;
        case 'call.end': endCall('user'); break;
        case 'scan.request': scan(); break;
        case 'game.event':
          onGameEvent(m.event);
          if (m.event.kind === 'match_end') later(3500, () => endCall('match_end'));
          break;
        default: break;
      }
    },
    on(cb) { subs.add(cb); return () => subs.delete(cb); },
    onStatus(cb) { statusSubs.add(cb); cb(st); return () => statusSubs.delete(cb); },
    status: () => st,
    close() {
      timers.forEach(clearTimeout);
      timers.clear();
      if (narrTimer) clearInterval(narrTimer);
      st = 'closed';
      statusSubs.forEach((cb) => cb(st));
    },
  };
}
