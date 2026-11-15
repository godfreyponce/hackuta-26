import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Hand } from '@ithaca/shared';
import { useApp, subtitleAt, isCallLive } from '../state/store';
import { endCall, requestCall, requestWeapon, runtime, setMic, setupInput } from '../game/runtime';
import { isKeyboardMouse, motionAvailable } from '../input';
import { Btn, ClassIcon, FrameGuide, StanceChecklist, fmtTime, isBodyInput, useMenuNav } from './components';
import { CallChip } from './CallChip';
import { FriendPip } from './FriendPip';
import { Turntable } from './Turntable';
import { CombatOverlay } from './CombatOverlay';
import { BodyMoves, KEYMAP } from './Calibration';

const LOW_HP = 35;

function HealthBlock({ quiver }: { quiver: number }) {
  const health = useApp((s) => s.hud.health);
  const posture = useApp((s) => s.hud.posture);
  const blocking = useApp((s) => s.hud.blocking);
  const [ghost, setGhost] = useState(health);
  const [active, setActive] = useState(false);
  // every blow taken restarts a short shake + red flash on the bar (two alternating animations, so back-to-back hits replay)
  const [hits, setHits] = useState(0);
  const prev = useRef(health);
  useEffect(() => {
    if (health < prev.current - 0.5) setHits((n) => n + 1);
    prev.current = health;
    setActive(true);
    const a = setTimeout(() => setGhost(health), 350);
    const b = setTimeout(() => setActive(false), 2000);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [health]);
  const low = health < LOW_HP;
  const p = Math.min(1, posture / 100);
  return (
    <div className={`vitals ${active || low ? 'on' : ''} ${low ? 'low' : ''} ${hits ? `hit-${hits % 2}` : ''}`}>
      <div className="vitals-head">
        <span className="vitals-name">Odysseus</span>
        {blocking && <span className="guard-tag">Guard</span>}
        <span className="spacer" />
        {quiver > 0 && <span className="quiver-tag" title="Arrows"><ArrowGlyph />{quiver}</span>}
        <span className="hp-num num">{Math.round(health)}</span>
      </div>
      <div className="health" role="meter" aria-label="Health" aria-valuenow={Math.round(health)} aria-valuemin={0} aria-valuemax={100}>
        <b style={{ transform: `scaleX(${Math.max(0, ghost) / 100})` }} />
        <i className={low ? 'low' : ''} style={{ transform: `scaleX(${Math.max(0, health) / 100})` }} />
        <span className="ticks" aria-hidden />
      </div>
      {/* posture: fills as blows land on your guard — full means the guard breaks */}
      {posture > 1 && (
        <div className={`posture ${p > 0.7 ? 'hot' : ''}`} aria-label="Posture">
          <i style={{ transform: `scaleX(${p})` }} />
        </div>
      )}
    </div>
  );
}

/** Red edges that breathe while you're badly hurt (slow, low-contrast pulse — no strobing). */
function LowHealthVignette() {
  const health = useApp((s) => s.hud.health);
  if (health >= LOW_HP || health <= 0) return null;
  const k = Math.min(1, (LOW_HP - health) / LOW_HP);
  return <div className="hurt-vignette" style={{ ['--hurt' as string]: (0.45 + 0.55 * k).toFixed(2) }} aria-hidden />;
}

/** Small line glyphs for the HUD (drawn here, no icon font). */
function ArrowGlyph() {
  return (
    <svg className="glyph" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M2 14 L13 3 M9 3 H13 V7 M2 14 l1.5-3.5 M2 14 l3.5-1.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type HandState = 'open' | 'fist' | 'unread' | 'unseen' | 'kb';
/** A hand as the camera reads it: open palm, closed fist, or struck through (not seen); colour carries the rest
 *  (amber palm = arm seen but fingers not read). */
function HandGlyph({ state }: { state: HandState }) {
  const fist = state === 'fist';
  return (
    <svg className="glyph hand-glyph" width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      {fist ? (
        <g fill="currentColor">
          <rect x="5" y="7" width="14" height="12" rx="4" />
          <path d="M9 7v5M12.5 7v5M16 7v5" stroke="rgba(10,8,6,0.75)" strokeWidth="1.3" />
          <rect x="3.5" y="13" width="9" height="4" rx="2" stroke="rgba(10,8,6,0.75)" strokeWidth="1" />
        </g>
      ) : (
        <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 13V6.5a1.5 1.5 0 0 1 3 0V12M10 11V4.5a1.5 1.5 0 0 1 3 0V11M13 11V5.5a1.5 1.5 0 0 1 3 0V12M16 12V8a1.5 1.5 0 0 1 3 0v6.5c0 4-2.8 6.5-6.5 6.5-2.6 0-4.2-1.2-5.6-3.3L4.5 14a1.5 1.5 0 0 1 2.4-1.7L7 13" />
          {state === 'unseen' && <path d="M3 3l18 18" strokeWidth="2" />}
        </g>
      )}
    </svg>
  );
}

interface HandInfo { held: string | null; seen: boolean; read: boolean; fist: boolean }
interface HandsSnap { left: HandInfo; right: HandInfo; quiver: number; driven: Hand | null; unarmedLong: boolean; unseenLong: boolean; hover: boolean }
const NO_HAND: HandInfo = { held: null, seen: true, read: true, fist: false };

/** What each hand holds and (webcam) whether the tracker sees it / reads a fist — polled at 5 Hz, re-renders on change. */
function useHands(body: boolean): HandsSnap {
  const [snap, setSnap] = useState<HandsSnap>({ left: NO_HAND, right: NO_HAND, quiver: 0, driven: null, unarmedLong: false, unseenLong: false, hover: false });
  useEffect(() => {
    let unarmedAt = 0, unseenAt = 0, key = '';
    // fallback fist read (only if the controller exposes no gesture flags): C's default hysteresis
    const fist: Record<Hand, boolean> = { left: false, right: false };
    // when the HAND model last actually read each hand (wrist seen ≠ fingers read: that's when a fist can't register)
    const freshAt: Record<Hand, number> = { left: 0, right: 0 };
    const t = setInterval(() => {
      const e = runtime.engine, w = e?.weapons;
      if (!e || !w) return;
      const st = body ? runtime.input?.getState() : null;
      const dbg = (body ? runtime.input : null) as unknown as {
        getDebugBody?: () => { handFresh: Record<Hand, boolean> } | null;
        getDebugGestures?: () => Record<string, boolean>;
      } | null;
      const dbody = dbg?.getDebugBody?.() ?? null;
      const flags = dbg?.getDebugGestures?.() ?? null;
      const now0 = performance.now();
      const info = (h: Hand): HandInfo => {
        const hs = st?.hands[h];
        if (dbody?.handFresh[h]) freshAt[h] = now0;
        if (hs?.visible) fist[h] = fist[h] ? hs.grip > 0.35 : hs.grip >= 0.65;
        // Part C's own grip latch, so the dot agrees with whether a grab can fire
        const latched = flags ? !!flags[h === 'left' ? 'gripL' : 'gripR'] : fist[h];
        const read = !dbody || now0 - freshAt[h] < 400;
        return { held: w.heldBy(h)?.name ?? null, seen: hs ? hs.visible : true, read, fist: !!hs?.visible && read && latched };
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
    // webcam: a hand glyph per hand — verdigris open, brass fist, amber arm seen but fingers not read (a fist can't
    // register), red struck-through not seen at all (the in-game hand ghosts and holds still)
    const status: HandState = !body ? 'kb' : !h.seen ? 'unseen' : !h.read ? 'unread' : h.fist ? 'fist' : 'open';
    const what = h.held ?? (status === 'unseen' ? 'not seen' : status === 'unread' ? 'show your palm' : 'empty');
    const tip = status === 'unseen' ? 'The camera can’t see this hand' : status === 'unread' ? 'Arm seen, fingers not read — a fist can’t register yet' : undefined;
    return (
      <span className={`hand-chip ${status} ${h.held ? 'on' : ''} ${driven ? 'driven' : ''}`} title={tip}>
        {body ? <HandGlyph state={status} /> : null}
        <b className="side">{label}</b>
        <span className="what">{what}</span>
        {body && h.held && status === 'unseen' && <em className="flag">not seen</em>}
        {driven && <em className="flag">mouse</em>}
      </span>
    );
  };
  return (
    <div className="hands-slots" aria-label="What you hold">
      {slot('left', 'L')}
      {slot('right', 'R')}
      {hands.driven === 'right' && <em className="hands-hint">Shift — mouse drives the left hand</em>}
    </div>
  );
}

function ScoreBlock() {
  const score = useApp((s) => s.hud.score);
  const wave = useApp((s) => s.hud.wave);
  const title = useApp((s) => s.hud.waveTitle);
  const tally = useApp((s) => s.hud.tally);
  const time = useApp((s) => s.hud.matchTimeMs);
  const cleared = tally.total > 0 && tally.killed >= tally.total;
  return (
    <div className="tc">
      <div className="hud-label wave-label">
        <span className="wave-num">Wave {['I', 'II', 'III'][wave - 1] ?? '—'}</span>
        {title && <span className="wave-title">{title}</span>}
      </div>
      <div className={`tally ${cleared ? 'cleared' : ''}`} aria-label={`${tally.killed} of ${tally.total} wooers slain`}>
        {Array.from({ length: tally.total }, (_, i) => <i key={i} className={i < tally.killed ? 'on' : ''} />)}
      </div>
      <div className="score-row">
        {/* keyed on the score: each gain replays a short brass flare */}
        <span key={score} className={`score-sm num ${score > 0 ? 'bump' : ''}`}>{score.toLocaleString()}</span>
        <span className="score-time num">{fmtTime(time)}</span>
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
  const shield = Math.max(0, Math.min(1, boss.shield));
  const posture = Math.min(1, boss.posture ?? 0);
  return (
    <div className="bossbar" role="meter" aria-label={`${boss.name} health`} aria-valuenow={Math.round(boss.hp * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="boss-head">
        <span className="boss-rule" aria-hidden />
        <span className="boss-name">{boss.name}</span>
        <span className="boss-rule" aria-hidden />
      </div>
      <div className="boss-hp">
        <b style={{ width: `${Math.max(boss.hp, trail) * 100}%` }} />
        <i style={{ width: `${boss.hp * 100}%` }} />
        {shield > 0 && <s className="boss-shield" style={{ width: `${shield * 100}%` }} />}
      </div>
      <div className="boss-sub">
        {shield > 0 ? <span className="boss-shield-tag">Gilded shield · {Math.round(shield * 100)}%</span> : <span />}
        {posture > 0.01 && <span className={`boss-posture ${posture > 0.7 ? 'hot' : ''}`} title="Posture — fill it to stagger him"><i style={{ transform: `scaleX(${posture})` }} /></span>}
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
    return <div className="tr solo"><span className="chip"><span className="dot" />Fighting alone{netMode === 'mock' ? ' · mock' : ''}</span><ForgeCard /></div>;
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
  if (body && hands.unseenLong && tracking !== 'lost' && tracking !== 'calibrating') return <div className="prompt warn" role="status">We can’t see your hands — hold them up in front of you</div>;
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
      })().map((t) => {
        // "WAVE I · THE BOW IS STRUNG" → a title card: the numeral as an eyebrow between rules, the name large
        const [eyebrow, main] = t.kind === 'wave' && t.title.includes(' · ') ? t.title.split(' · ', 2) : [null, t.title];
        return (
          <div key={t.id} className={`toast ${t.kind}`} style={{ ['--out' as string]: t.kind === 'trickshot' ? '1.2s' : t.kind === 'info' ? '0.6s' : '2.2s' }}>
            {eyebrow && <div className="eb"><i aria-hidden />{eyebrow}<i aria-hidden /></div>}
            <div className="t">{main}</div>
            {t.kind === 'trickshot' && <div className="band" />}
            {t.sub && <div className="s">{t.sub}</div>}
            {t.points ? <div className="p">+{t.points.toLocaleString()}</div> : null}
          </div>
        );
      })}
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
          <FrameGuide className="lost-guide" />
          <h2 className="h2">We lost you</h2>
          <p className="lore" style={{ margin: 0 }}>Step back into the light. The hall waits — time is slowed.</p>
          <StanceChecklist />
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
        <div className="pause-main">
        <div className="pause-head"><h2 className="h2">Paused</h2><span className="muted small">The hall holds its breath.</span></div>
        <Btn variant="primary" autoFocus onClick={onResume} hotkey="Esc">Resume</Btn>
        <div className="field">
          <label>Controls (hot-swap)</label>
          <div className="seg">
            <button aria-pressed={body} disabled={!motionAvailable} onClick={() => { if (!body) void setupInput('motion'); }}>{motionAvailable ? 'Body (webcam)' : 'Body (webcam) · unavailable'}</button>
            <button aria-pressed={inputKind === 'keyboard_mouse'} onClick={() => void setupInput('keyboard_mouse')}>Keyboard &amp; mouse</button>
          </div>
          {inputKind === 'replay' && <span className="muted small">Replaying a recorded webcam session.</span>}
        </div>
        {inputKind === 'motion' && <Btn onClick={() => { void runtime.input?.calibrate?.(); }}>Recalibrate</Btn>}
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
        </div>
        {/* the reference column: always open, no scrolling hunt for "how do I guard again?" */}
        <aside className="pause-ref">
          <div className="h3">{body ? 'Body controls' : 'Keyboard controls'}</div>
          {body ? (
            <>
              <BodyMoves friend={!!friend} />
              <StanceChecklist compact />
            </>
          ) : (
            <div className="keys">
              {KEYMAP.map(([k, v]) => <span key={k} style={{ display: 'contents' }}><span className="kbd">{k}</span><span>{v}</span></span>)}
            </div>
          )}
        </aside>
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
      <LowHealthVignette />
      <CombatOverlay />
      <div className="dock-bl">
        <HandsBlock hands={hands} body={body} />
        <HealthBlock quiver={hands.quiver} />
      </div>
      <ScoreBlock />
      <CallPanel />
      <BossBar />
      <BossIntro />
      <Toasts />
      <GestureRing />
      {/* what to do sits above what is being said: subtitles keep the bottom line, like film */}
      <div className="bc">
        <Prompts hands={hands} />
        <Subtitles />
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
