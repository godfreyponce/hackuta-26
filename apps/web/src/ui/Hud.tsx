import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hand } from '@ithaca/shared';
import { useApp, subtitleAt, isCallLive } from '../state/store';
import { endCall, requestCall, requestWeapon, runtime, setMic, setupInput } from '../game/runtime';
import { isKeyboardMouse, motionAvailable } from '../input';
import { Btn, ClassIcon, fmtTime, isBodyInput, useMenuNav } from './components';
import { CallChip } from './CallChip';
import { FriendPip } from './FriendPip';
import { Turntable } from './Turntable';
import { CombatOverlay } from './CombatOverlay';
import { BodyMoves, KEYMAP } from './Calibration';

function HealthBlock() {
  const health = useApp((s) => s.hud.health);
  const posture = useApp((s) => s.hud.posture);
  const blocking = useApp((s) => s.hud.blocking);
  const [ghost, setGhost] = useState(health);
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(true);
    const a = setTimeout(() => setGhost(health), 350);
    const b = setTimeout(() => setActive(false), 2000);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [health]);
  return (
    <div className={`vitals ${active || health < 35 ? 'on' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hud-label">Odysseus</span>
        <span className="row" style={{ gap: 8 }}>
          {blocking && <span className="hud-label" style={{ color: 'var(--verdigris-hi)' }}>Guard</span>}
          <span className="hud-label num">{Math.round(health)}</span>
        </span>
      </div>
      {posture > 1 && <div className="posture"><i style={{ transform: `scaleX(${Math.min(1, posture / 100)})` }} /></div>}
      <div className="health" role="meter" aria-label="Health" aria-valuenow={Math.round(health)} aria-valuemin={0} aria-valuemax={100}>
        <b style={{ transform: `scaleX(${Math.max(0, ghost) / 100})` }} />
        <i className={health < 35 ? 'low' : ''} style={{ transform: `scaleX(${Math.max(0, health) / 100})` }} />
      </div>
    </div>
  );
}

interface HandInfo { held: string | null; seen: boolean; fist: boolean }
interface HandsSnap { left: HandInfo; right: HandInfo; quiver: number; driven: Hand | null; unarmedLong: boolean; unseenLong: boolean; hover: boolean }
const NO_HAND: HandInfo = { held: null, seen: true, fist: false };

/** What each hand holds and (webcam) whether the tracker sees it / reads a fist — polled at 5 Hz, re-renders on change. */
function useHands(body: boolean): HandsSnap {
  const [snap, setSnap] = useState<HandsSnap>({ left: NO_HAND, right: NO_HAND, quiver: 0, driven: null, unarmedLong: false, unseenLong: false, hover: false });
  useEffect(() => {
    let unarmedAt = 0, unseenAt = 0, key = '';
    // fist read with Part C's grip hysteresis (packages/motion config gripOn 0.65 / gripOff 0.35), so the dot doesn't flicker
    const fist: Record<Hand, boolean> = { left: false, right: false };
    const t = setInterval(() => {
      const e = runtime.engine, w = e?.weapons;
      if (!e || !w) return;
      const st = body ? runtime.input?.getState() : null;
      const info = (h: Hand): HandInfo => {
        const hs = st?.hands[h];
        if (hs?.visible) fist[h] = fist[h] ? hs.grip > 0.35 : hs.grip >= 0.65;
        return { held: w.heldBy(h)?.name ?? null, seen: hs ? hs.visible : true, fist: !!hs?.visible && fist[h] };
      };
      const left = info('left'), right = info('right');
      const now = performance.now();
      const playing = e.mode === 'match';
      const unarmed = playing && !left.held && !right.held && !w.drawing;
      unarmedAt = unarmed ? unarmedAt || now : 0;
      const unseen = playing && body && !left.seen && !right.seen;
      unseenAt = unseen ? unseenAt || now : 0;
      const next: HandsSnap = {
        left, right, quiver: w.quiver,
        // the mouse drives this hand (Shift swaps while held) — only worth showing when both hands hold something
        driven: left.held && right.held ? e.drivenHand ?? null : null,
        unarmedLong: unarmed && now - unarmedAt > 1200,
        unseenLong: unseen && now - unseenAt > 1500,
        hover: playing && !!e.overlay().hover,
      };
      const k = JSON.stringify(next);
      if (k !== key) { key = k; setSnap(next); }
    }, 200);
    return () => clearInterval(t);
  }, [body]);
  return snap;
}

function HandsBlock({ hands, body }: { hands: HandsSnap; body: boolean }) {
  const slot = (side: Hand, label: string) => {
    const h = hands[side];
    const driven = hands.driven === side;
    // webcam: a dot per hand — green seen/open, brass fist, red not seen (the in-game hand ghosts and holds still)
    const status = !body ? '' : !h.seen ? 'unseen' : h.fist ? 'fist' : 'open';
    return (
      <span className={`hand-slot ${h.held ? 'on' : ''} ${driven ? 'driven' : ''} ${status}`}
        title={body ? (!h.seen ? 'The camera can’t see this hand' : h.fist ? 'Fist' : 'Open hand') : undefined}>
        {body && <i className="dot" aria-hidden />}
        {label} · {h.held ?? (body && !h.seen ? 'not seen' : 'empty')}
        {body && !h.seen && h.held && <em className="unseen-tag"> · not seen</em>}
        {driven ? ' ◂ mouse' : ''}
      </span>
    );
  };
  return (
    <div className="hands-slots" aria-label="What you hold">
      {slot('left', 'L')}
      {slot('right', 'R')}
      <span>Arrows · {hands.quiver}</span>
      {hands.driven === 'right' && <em className="muted">Shift: left hand</em>}
    </div>
  );
}

function ScoreBlock() {
  const score = useApp((s) => s.hud.score);
  const wave = useApp((s) => s.hud.wave);
  const title = useApp((s) => s.hud.waveTitle);
  const tally = useApp((s) => s.hud.tally);
  const time = useApp((s) => s.hud.matchTimeMs);
  return (
    <div className="tc">
      <div className="hud-label wave-label">Wave {['I', 'II', 'III'][wave - 1] ?? '—'} · <span style={{ color: 'var(--dust)' }}>{title}</span></div>
      <div className="tally" aria-label={`${tally.killed} of ${tally.total} wooers slain`}>
        {Array.from({ length: tally.total }, (_, i) => <i key={i} className={i < tally.killed ? 'on' : ''} />)}
      </div>
      <div className="row" style={{ gap: 14 }}>
        <span className="score-sm num">{score.toLocaleString()}</span>
        <span className="hud-label num" style={{ color: 'var(--dust)' }}>{fmtTime(time)}</span>
      </div>
    </div>
  );
}

function BossBar() {
  const boss = useApp((s) => s.hud.boss);
  const [trail, setTrail] = useState(1);
  useEffect(() => {
    if (!boss) return;
    const t = setTimeout(() => setTrail(boss.hp), 600);
    return () => clearTimeout(t);
  }, [boss?.hp, boss]);
  if (!boss) return null;
  return (
    <div className="bossbar">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="boss-name">{boss.name}</span>
        {boss.shield > 0 && <span className="hud-label" style={{ color: 'var(--brass)' }}>Gilded shield {Math.round(boss.shield * 100)}%</span>}
      </div>
      {(boss.posture ?? 0) > 0.01 && <div className="boss-posture"><i style={{ transform: `scaleX(${Math.min(1, boss.posture ?? 0)})` }} /></div>}
      <div className="boss-hp">
        <b style={{ width: `${Math.max(boss.hp, trail) * 100}%` }} />
        <i style={{ width: `${boss.hp * 100}%` }} />
      </div>
    </div>
  );
}

function BossIntro() {
  const intro = useApp((s) => s.hud.bossIntro);
  const [, force] = useState(0);
  useEffect(() => { if (!intro) return; const t = setTimeout(() => force((x) => x + 1), 2900); return () => clearTimeout(t); }, [intro]);
  if (!intro || Date.now() - intro.at > 2800) return null;
  return (
    <div className="boss-intro" key={intro.at}>
      <div className="boss-intro-name">{intro.name}</div>
      <div className="boss-intro-epithet">{intro.epithet}</div>
    </div>
  );
}

function ForgeCard() {
  const scan = useApp((s) => s.scan);
  const incoming = useApp((s) => s.incoming);
  const friend = useApp((s) => s.friend?.name ?? 'Telemachus');
  if (incoming) {
    return (
      <div className="callpanel forge-card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="hud-label" style={{ color: 'var(--brass-hi)' }}>Incoming</span>
          <ClassIcon cls={incoming.weaponClass} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          {incoming.thumbUrl && <img className="thumb" style={{ width: '42%' }} src={incoming.thumbUrl} alt={`Photo of ${incoming.objectName}`} />}
          <div style={{ position: 'relative', flex: 1, aspectRatio: '1', borderRadius: 8, overflow: 'hidden' }}>
            <Turntable url={incoming.glbUrl} cls={incoming.weaponClass} speed={3} />
          </div>
        </div>
        <div className="h3">{incoming.displayName}</div>
        <div className="muted small">{incoming.objectName} · sent by {incoming.friendName}{incoming.fallback ? ' · stock forge' : ''}</div>
      </div>
    );
  }
  if (scan.state === 'idle' || scan.state === 'done') return null;
  const stage = scan.state === 'looking' ? 0 : scan.state === 'detected' ? 1 : scan.pct < 85 ? 2 : 3;
  return (
    <div className="callpanel forge-card" aria-live="polite">
      <span className="hud-label" style={{ color: scan.state === 'failed' ? '#ffb38a' : 'var(--brass-hi)' }}>
        {scan.state === 'looking' ? `${friend} is looking…` : scan.state === 'failed' ? 'Couldn’t make it out' : 'The forge is lit'}
      </span>
      {scan.state !== 'looking' && scan.state !== 'failed' && (
        <>
          <div className="h3">{scan.displayName ?? scan.objectName ?? '…'}</div>
          {scan.objectName && <div className="muted small">a real {scan.objectName}</div>}
        </>
      )}
      {scan.state === 'failed' ? <div className="muted small">Press <span className="kbd">Q</span> to ask again</div> : (
        <>
          <div className="progress"><i style={{ width: `${scan.state === 'looking' ? 8 : Math.max(12, scan.pct)}%` }} /></div>
          <div className="stages">
            {['Capture', 'Identify', `Forge ${scan.pct ? `${Math.round(scan.pct)}%` : ''}`, 'Incoming'].map((l, i) => <span key={l} className={i <= stage ? 'on' : ''}>{l}</span>)}
          </div>
        </>
      )}
    </div>
  );
}

function CallPanel() {
  const call = useApp((s) => s.call.state);
  const mic = useApp((s) => s.micEnabled);
  const netMode = useApp((s) => s.netMode);
  const friend = useApp((s) => s.friend);
  const kb = useApp((s) => s.inputKind === 'keyboard_mouse');
  // fighting alone: one small chip, not a panel — keeps the top-right of the hall clear
  if (!friend && !isCallLive(call)) {
    return <div className="tr solo"><span className="chip" title={netMode === 'mock' ? 'Mock hub' : undefined}><span className="dot" />Fighting alone</span></div>;
  }
  return (
    <div className="tr">
      <div className="callpanel">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
          <CallChip compact />
          {call === 'connected' && <span className={`chip ${mic ? 'ok' : 'bad'}`} title="Push-to-talk (T)"><span className="dot" />{mic ? 'Mic' : 'Muted'}</span>}
        </div>
        {isCallLive(call) && <FriendPip />}
        {!isCallLive(call) && friend && <div className="muted small">{kb ? <>Press <span className="kbd">C</span> to call {friend.name}.</> : <>Make the phone sign by your ear (or <span className="kbd">C</span>) to call {friend.name}.</>}</div>}
      </div>
      <ForgeCard />
    </div>
  );
}

function Subtitles() {
  const narration = useApp((s) => s.narration);
  const [, force] = useState(0);
  const last = narration[narration.length - 1];
  const cur = last ? subtitleAt(last.text, performance.now() - last.at) : null;
  // re-render when this chunk runs out (next chunk, or hide)
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => force((x) => x + 1), cur.endsIn + 30);
    return () => clearTimeout(t);
  });
  if (!last || !cur) return null;
  return (
    <div className="subtitle" aria-live="polite" key={`${last.id}:${cur.index}`}>
      <span className="who">Quartermaster</span>
      {cur.chunk}
    </div>
  );
}

function Prompts({ hands }: { hands: HandsSnap }) {
  const call = useApp((s) => s.call.state);
  const scan = useApp((s) => s.scan.state);
  const pinned = useApp((s) => s.hud.pinnedPrompt);
  const bow = useApp((s) => s.bowMode);
  const draw = useApp((s) => s.hud.bowDraw);
  const kb = useApp((s) => s.inputKind === 'keyboard_mouse');
  const body = useApp((s) => isBodyInput(s.inputKind));
  const tracking = useApp((s) => s.tracking);
  const friend = useApp((s) => s.friend?.name ?? 'Telemachus');
  const solo = useApp((s) => !s.friend);
  if (pinned && !isCallLive(call)) {
    // fighting alone there's no one to call: point at what you CAN do
    if (solo) return <div className="prompt big">{kb ? <>Surrounded — <span className="kbd">RMB</span> guard, strike the one who swings</> : 'Surrounded — fists up to guard, strike the one who swings'}</div>;
    return kb
      ? <div className="prompt big">Press <span className="kbd">C</span> to call {friend}</div>
      : <div className="prompt big">Make the phone sign by your ear to call {friend}</div>;
  }
  // webcam: say when the tracker is struggling — the in-game hands only ghost, which is easy to miss mid-fight
  if (body && tracking === 'degraded') return <div className="prompt warn" role="status">Tracking is weak — face a light and keep both hands in view</div>;
  if (body && hands.unseenLong) return <div className="prompt warn" role="status">We can’t see your hands — hold them up in front of you</div>;
  if (hands.unarmedLong && !bow && !(kb && hands.hover)) {
    return kb
      ? <div className="prompt">Click a weapon on the table to take it · <span className="kbd">Tab</span> look down</div>
      : <div className="prompt">Reach toward a weapon and <b>make a fist</b> to take it</div>;
  }
  if (call === 'connected' && (scan === 'idle' || scan === 'done')) {
    return kb
      ? <div className="prompt">Press <span className="kbd">Q</span> to ask {friend} for a weapon</div>
      : <div className="prompt">Raise both hands over your head to ask {friend} for a weapon</div>;
  }
  if (bow && kb) {
    return <div className="prompt">{draw > 0 ? `Drawing… ${Math.round(draw * 100)}%` : 'Bow ready — hold LMB or Space to draw'} <span className="kbd">B</span></div>;
  }
  return null;
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts">
      {(() => {
        // one big banner at a time (the newest); small info lines only when no banner is up
        const big = toasts.filter((t) => t.kind === 'trickshot' || t.kind === 'wave' || t.kind === 'gift').slice(-1);
        const rest = toasts.filter((t) => t.kind !== 'trickshot' && t.kind !== 'wave' && t.kind !== 'gift' && (!big.length || t.kind === 'warn')).slice(-2);
        return [...big, ...rest];
      })().map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} style={{ ['--out' as string]: t.kind === 'trickshot' ? '1.2s' : t.kind === 'info' ? '0.6s' : '2.2s' }}>
          <div className="t">{t.title}</div>
          {t.kind === 'trickshot' && <div className="band" />}
          {t.sub && <div className="s">{t.sub}</div>}
          {t.points ? <div className="p">+{t.points.toLocaleString()}</div> : null}
        </div>
      ))}
    </div>
  );
}

function Reticle() {
  const ref = useRef<HTMLDivElement>(null);
  const bow = useApp((s) => s.bowMode);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = runtime.input;
      const el = ref.current;
      if (el && isKeyboardMouse(c)) {
        el.style.left = `${((c.cursor.x + 1) / 2) * window.innerWidth}px`;
        el.style.top = `${((1 - c.cursor.y) / 2) * window.innerHeight}px`;
        el.style.display = 'block';
      } else if (el) el.style.display = 'none';
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div ref={ref} className={`reticle ${bow ? 'bow' : ''}`} />;
}

function GestureRing() {
  const g = useApp((s) => s.pendingGesture);
  const solo = useApp((s) => !s.friend);
  if (!g || g.progress <= 0) return null;
  if (solo && (g.name === 'call_sign' || g.name === 'request_weapon')) return null;
  const r = 32, c = 2 * Math.PI * r;
  const label = g.name === 'call_sign' ? 'Calling…' : g.name === 'request_weapon' ? 'Asking for a weapon…' : g.name === 'drink' ? 'Drinking…' : g.name;
  return (
    <div style={{ position: 'absolute', top: '58%', left: '50%', transform: 'translateX(-50%)', textAlign: 'center' }}>
      <svg className="gesture-ring" viewBox="0 0 74 74">
        <circle cx="37" cy="37" r={r} fill="rgba(10,8,6,.6)" stroke="rgba(214,204,186,.2)" strokeWidth="5" />
        <circle cx="37" cy="37" r={r} fill="none" stroke="#ffd58a" strokeWidth="5" strokeDasharray={`${c * g.progress} ${c}`} transform="rotate(-90 37 37)" strokeLinecap="round" />
      </svg>
      <div className="hud-label">{label}</div>
    </div>
  );
}

function TrackingOverlay() {
  const tracking = useApp((s) => s.tracking);
  const kind = useApp((s) => s.inputKind);
  if (!isBodyInput(kind)) return null;
  if (tracking === 'lost') {
    return (
      <div className="overlay-center" role="alert">
        <div className="lost">
          <svg width="90" height="120" viewBox="0 0 64 86" aria-hidden><circle cx="32" cy="14" r="10" fill="#6e665b" /><path d="M14 84 L18 40 Q32 28 46 40 L50 84 Z" fill="#6e665b" /></svg>
          <h2 className="h2">We lost you</h2>
          <p className="lore" style={{ margin: 0 }}>Step back into the light. The hall waits — time is slowed.</p>
          <p className="muted small" style={{ margin: 0 }}>Stand about 2 m from the camera, hips in view, a light in front of you.</p>
          <div className="pointer" style={{ pointerEvents: 'auto' }}><Btn onClick={() => void setupInput('keyboard_mouse')}>Switch to keyboard &amp; mouse</Btn></div>
        </div>
      </div>
    );
  }
  return null;
}

function PauseMenu({ onResume }: { onResume: () => void }) {
  const inputKind = useApp((s) => s.inputKind);
  const difficulty = useApp((s) => s.difficulty);
  const call = useApp((s) => s.call.state);
  const mic = useApp((s) => s.micEnabled);
  const friend = useApp((s) => s.friend);
  const body = isBodyInput(inputKind);
  const ref = useMenuNav<HTMLDivElement>(onResume);
  return (
    <div className="overlay-center" style={{ pointerEvents: 'auto' }}>
      <div className="panel pause" ref={ref}>
        <h2 className="h2">Paused</h2>
        <Btn variant="primary" autoFocus onClick={onResume} hotkey="Esc">Resume</Btn>
        <div className="field">
          <label>Controls (hot-swap)</label>
          <div className="seg">
            <button aria-pressed={body} disabled={!motionAvailable} title={motionAvailable ? undefined : 'Body tracking isn’t installed in this build'} onClick={() => void setupInput('motion')}>{motionAvailable ? 'Body (webcam)' : 'Body (webcam) · unavailable'}</button>
            <button aria-pressed={inputKind === 'keyboard_mouse'} onClick={() => void setupInput('keyboard_mouse')}>Keyboard &amp; mouse</button>
          </div>
          {inputKind === 'replay' && <span className="muted small">Replaying a recorded webcam session.</span>}
        </div>
        {body && <Btn onClick={() => { void runtime.input?.calibrate?.(); }}>Recalibrate</Btn>}
        <div className="field">
          <label htmlFor="shake">Camera shake</label>
          <input id="shake" type="range" min={0} max={100} defaultValue={Math.round((runtime.engine?.shakeScale ?? 1) * 100)}
            onChange={(ev) => { if (runtime.engine) runtime.engine.shakeScale = Number(ev.target.value) / 100; }} />
        </div>
        <div className="field">
          <label>Difficulty (next match)</label>
          <div className="seg">
            <button aria-pressed={difficulty === 'easy'} onClick={() => useApp.setState({ difficulty: 'easy' })}>Easy</button>
            <button aria-pressed={difficulty === 'normal'} onClick={() => useApp.setState({ difficulty: 'normal' })}>Normal</button>
          </div>
        </div>
        {isCallLive(call)
          ? <div className="row"><Btn onClick={() => setMic(!mic)} hotkey="T">{mic ? 'Mute mic' : 'Unmute mic'}</Btn><Btn variant="danger" onClick={endCall}>End call</Btn></div>
          : friend
            ? <Btn variant="call" onClick={requestCall} hotkey="C">📞 Call {friend.name}</Btn>
            : <p className="muted small" style={{ margin: 0 }}>Fighting alone — add a Telemachus from the title screen to call for weapons.</p>}
        <Btn variant="danger" onClick={() => { onResume(); runtime.engine?.quit(); }}>End the fight</Btn>
        {body && (
          <details open>
            <summary className="muted small" style={{ cursor: 'pointer' }}>Body controls</summary>
            <div style={{ marginTop: 10 }}><BodyMoves friend={!!friend} /></div>
          </details>
        )}
        <details>
          <summary className="muted small" style={{ cursor: 'pointer' }}>Keyboard controls</summary>
          <div className="keys" style={{ marginTop: 10 }}>
            {KEYMAP.map(([k, v]) => <span key={k} style={{ display: 'contents' }}><span className="kbd">{k}</span><span>{v}</span></span>)}
          </div>
        </details>
      </div>
    </div>
  );
}

const K = ({ children }: { children: ReactNode }) => <span className="kbd">{children}</span>;

/** The always-handy cheat sheet (top-left, first seconds of a fight; H toggles). */
function ControlsCard({ body, hidden }: { body: boolean; hidden: boolean }) {
  const friend = useApp((s) => s.friend?.name ?? null);
  const rows: [ReactNode, ReactNode][] = body
    ? [
      ['Reach + fist', 'take a weapon'],
      ['Swing your arm', 'strike · punch to stab'],
      ['Open your hand', 'throw (mid-swing)'],
      ['Fists by your chin', 'guard'],
      ['Lean', 'dodge'],
      ...(friend ? [['Phone sign', `call ${friend}`] as [ReactNode, ReactNode]] : []),
    ]
    : [
      [<K key="c">Click</K>, 'take a weapon'],
      [<K key="t">Tab</K>, 'look down at the table'],
      [<K key="m">Mouse</K>, <>swing · <K>W</K> thrust</>],
      [<K key="r">RMB</K>, <>guard · <K>A</K>/<K>D</K> dodge</>],
      [<><K>LMB</K> flick</>, <>throw · <K>X</K> set down</>],
      [<K key="b">B</K>, <>bow · <K>E</K> drink</>],
    ];
  return (
    <div className={`bl callpanel ctrl-card ${hidden ? 'away' : ''}`} aria-hidden={hidden}>
      <div className="hud-label ctrl-head">{body ? 'How to fight' : 'Controls'}<span className="muted"><K>H</K> hide · <K>Esc</K> pause</span></div>
      <div className="ctrl-grid">
        {rows.map(([k, v], i) => <span key={i} style={{ display: 'contents' }}><span className="ctrl-k">{k}</span><span className="ctrl-v">{v}</span></span>)}
      </div>
    </div>
  );
}

export function Hud() {
  const paused = useApp((s) => s.paused);
  const kb = useApp((s) => s.inputKind === 'keyboard_mouse');
  const body = useApp((s) => isBodyInput(s.inputKind));
  const cine = useApp((s) => s.hud.slowmo);
  const boss = useApp((s) => !!s.hud.boss);
  const banner = useApp((s) => s.toasts.some((t) => t.kind === 'wave' || t.kind === 'trickshot' || t.kind === 'gift'));
  const hands = useHands(body);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        const p = !useApp.getState().paused;
        useApp.setState({ paused: p });
        runtime.engine?.setPaused(p);
      } else if (e.code === 'KeyT' && !useApp.getState().paused) setMic(!useApp.getState().micEnabled);
      else if (e.code === 'KeyH') setHint((h) => !h);
      // webcam: the screens promise "(or C)" / "(or Q)" — the keyboard controller isn't running to send them, so do it here
      else if (body && !e.repeat && !useApp.getState().paused && e.code === 'KeyC') requestCall();
      else if (body && !e.repeat && !useApp.getState().paused && e.code === 'KeyQ') requestWeapon();
    };
    window.addEventListener('keydown', onKey);
    // webcam players stand back from the keyboard: their card stays up longer
    const t = setTimeout(() => setHint(false), body ? 25000 : 15000);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, [body]);

  const resume = () => { useApp.setState({ paused: false }); runtime.engine?.setPaused(false); };

  return (
    <div className={`hud ${cine ? 'cine' : ''}`}>
      <CombatOverlay />
      <div className="dock-bl">
        <HandsBlock hands={hands} body={body} />
        <HealthBlock />
      </div>
      <ScoreBlock />
      <CallPanel />
      <BossBar />
      <BossIntro />
      <Toasts />
      <GestureRing />
      <div className="bc">
        <Subtitles />
        <Prompts hands={hands} />
      </div>
      {/* the boss bar and the big banners take the top of the screen: the cheat sheet steps aside meanwhile */}
      {hint && !boss && <ControlsCard body={body} hidden={banner} />}
      <TrackingOverlay />
      {kb && !paused && <Reticle />}
      {paused && <PauseMenu onResume={resume} />}
      <button style={{ display: 'none' }} onClick={requestWeapon} aria-hidden tabIndex={-1} />
    </div>
  );
}
