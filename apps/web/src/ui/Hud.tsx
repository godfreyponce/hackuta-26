import { useEffect, useRef, useState } from 'react';
import { useApp, subtitleAt, isCallLive } from '../state/store';
import { endCall, requestCall, requestWeapon, runtime, setMic, setupInput } from '../game/runtime';
import { isKeyboardMouse, motionAvailable } from '../input';
import { Btn, ClassIcon, fmtTime, useMenuNav } from './components';
import { CallChip } from './CallChip';
import { FriendPip } from './FriendPip';
import { QmFace } from '../call/QmFace';
import { Turntable } from './Turntable';
import { CombatOverlay } from './CombatOverlay';
import { KEYMAP } from './Calibration';

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

function HandsBlock() {
  const [held, setHeld] = useState<{ l: string | null; r: string | null; q: number; a: 'left' | 'right' | null }>({ l: null, r: null, q: 0, a: null });
  useEffect(() => {
    const t = setInterval(() => {
      const w = runtime.engine?.weapons;
      if (!w) return;
      const l = w.heldBy('left')?.name ?? null, r = w.heldBy('right')?.name ?? null, q = w.quiver;
      // the mouse drives this hand (Shift swaps while held) — only worth showing when both hands hold something
      const a = l && r ? runtime.engine?.drivenHand ?? null : null;
      setHeld((p) => (p.l === l && p.r === r && p.q === q && p.a === a ? p : { l, r, q, a }));
    }, 250);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="hands-slots" aria-label="What you hold">
      <span className={(held.l ? 'on' : '') + (held.a === 'left' ? ' driven' : '')}>L · {held.l ?? 'empty'}{held.a === 'left' ? ' ◂ mouse' : ''}</span>
      <span className={(held.r ? 'on' : '') + (held.a === 'right' ? ' driven' : '')}>R · {held.r ?? 'empty'}{held.a === 'right' ? ' ◂ mouse' : ''}{held.a === 'right' ? <em className="muted"> · Shift: left</em> : ''}</span>
      <span>Arrows · {held.q}</span>
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
  return (
    <div className="tr">
      <div className="callpanel">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
          <CallChip compact />
          {call === 'connected' && <span className={`chip ${mic ? 'ok' : 'bad'}`} title="Push-to-talk (T)"><span className="dot" />{mic ? 'Mic' : 'Muted'}</span>}
        </div>
        {isCallLive(call) && <FriendPip />}
        {isCallLive(call) && <QmFace />}
        {!isCallLive(call) && friend && <div className="muted small">{kb ? <>Press <span className="kbd">C</span> to call {friend.name}.</> : <>Make the phone sign (or <span className="kbd">C</span>) to call {friend.name}.</>}</div>}
        {!friend && <div className="muted small">No Telemachus set — fighting alone{netMode === 'mock' ? ' (mock)' : ''}.</div>}
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

function Prompts() {
  const call = useApp((s) => s.call.state);
  const scan = useApp((s) => s.scan.state);
  const pinned = useApp((s) => s.hud.pinnedPrompt);
  const bow = useApp((s) => s.bowMode);
  const draw = useApp((s) => s.hud.bowDraw);
  const kb = useApp((s) => s.inputKind === 'keyboard_mouse');
  const friend = useApp((s) => s.friend?.name ?? 'Telemachus');
  const solo = useApp((s) => !s.friend);
  if (pinned && !isCallLive(call)) {
    // fighting alone there's no one to call: point at what you CAN do
    if (solo) return <div className="prompt big">{kb ? <>Surrounded — <span className="kbd">RMB</span> guard, strike the one who swings</> : 'Surrounded — guard, and strike the one who swings'}</div>;
    return kb
      ? <div className="prompt big">Press <span className="kbd">C</span> to call {friend}</div>
      : <div className="prompt big">Make the phone sign to call {friend}</div>;
  }
  if (call === 'connected' && (scan === 'idle' || scan === 'done')) {
    return kb
      ? <div className="prompt">Press <span className="kbd">Q</span> to ask {friend} for a weapon</div>
      : <div className="prompt">Raise both arms to ask {friend} for a weapon</div>;
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
  if (!g || g.progress <= 0) return null;
  const r = 32, c = 2 * Math.PI * r;
  const label = g.name === 'call_sign' ? 'Calling…' : g.name === 'request_weapon' ? 'Asking…' : g.name;
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
  if (kind === 'keyboard_mouse') return null;
  if (tracking === 'lost') {
    return (
      <div className="overlay-center" role="alert">
        <div className="lost">
          <svg width="90" height="120" viewBox="0 0 64 86" aria-hidden><circle cx="32" cy="14" r="10" fill="#6e665b" /><path d="M14 84 L18 40 Q32 28 46 40 L50 84 Z" fill="#6e665b" /></svg>
          <h2 className="h2">We lost you</h2>
          <p className="lore" style={{ margin: 0 }}>Step back into the light. The hall waits — time is slowed.</p>
          <div className="pointer" style={{ pointerEvents: 'auto' }}><Btn onClick={() => void setupInput('keyboard_mouse')}>Switch to keyboard &amp; mouse</Btn></div>
        </div>
      </div>
    );
  }
  if (tracking === 'degraded') return <div style={{ position: 'absolute', top: 120, left: 26 }}><span className="chip warn"><span className="dot" />Find better light</span></div>;
  return null;
}

function PauseMenu({ onResume }: { onResume: () => void }) {
  const inputKind = useApp((s) => s.inputKind);
  const difficulty = useApp((s) => s.difficulty);
  const call = useApp((s) => s.call.state);
  const mic = useApp((s) => s.micEnabled);
  const ref = useMenuNav<HTMLDivElement>(onResume);
  return (
    <div className="overlay-center" style={{ pointerEvents: 'auto' }}>
      <div className="panel pause" ref={ref}>
        <h2 className="h2">Paused</h2>
        <Btn variant="primary" autoFocus onClick={onResume} hotkey="Esc">Resume</Btn>
        <div className="field">
          <label>Controls (hot-swap)</label>
          <div className="seg">
            <button aria-pressed={inputKind === 'motion'} disabled={!motionAvailable} title={motionAvailable ? undefined : 'Body tracking isn’t installed in this build'} onClick={() => void setupInput('motion')}>{motionAvailable ? 'Body (webcam)' : 'Body (webcam) · unavailable'}</button>
            <button aria-pressed={inputKind === 'keyboard_mouse'} onClick={() => void setupInput('keyboard_mouse')}>Keyboard &amp; mouse</button>
          </div>
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
          : <Btn variant="call" onClick={requestCall} hotkey="C">📞 Call Telemachus</Btn>}
        <Btn variant="danger" onClick={() => { onResume(); runtime.engine?.quit(); }}>End the fight</Btn>
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

export function Hud() {
  const paused = useApp((s) => s.paused);
  const kb = useApp((s) => s.inputKind === 'keyboard_mouse');
  const cine = useApp((s) => s.hud.slowmo);
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
    };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => setHint(false), 12000);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, []);

  const resume = () => { useApp.setState({ paused: false }); runtime.engine?.setPaused(false); };

  return (
    <div className={`hud ${cine ? 'cine' : ''}`}>
      <CombatOverlay />
      <HealthBlock />
      <HandsBlock />
      <ScoreBlock />
      <CallPanel />
      <BossBar />
      <BossIntro />
      <Toasts />
      <GestureRing />
      <div className="bc">
        <Subtitles />
        <Prompts />
      </div>
      {kb && hint && (
        <div className="bl callpanel small" style={{ maxWidth: 360 }}>
          <div className="hud-label" style={{ marginBottom: 6 }}>Controls · <span className="kbd">H</span> hide</div>
          <div className="muted">Click a weapon on the table to take it — hold <span className="kbd">Tab</span> to look down, click a second for your other hand · swing with the mouse · <span className="kbd">W</span> thrust · <span className="kbd">RMB</span> guard · flick + release <span className="kbd">LMB</span> to throw · <span className="kbd">X</span> set down · <span className="kbd">B</span> bow · <span className="kbd">A</span>/<span className="kbd">D</span> dodge</div>
        </div>
      )}
      <TrackingOverlay />
      {kb && !paused && <Reticle />}
      {paused && <PauseMenu onResume={resume} />}
      <button style={{ display: 'none' }} onClick={requestWeapon} aria-hidden tabIndex={-1} />
    </div>
  );
}
