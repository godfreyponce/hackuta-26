import { useEffect, useRef, useState } from 'react';
import { useApp, subtitleMs, isCallLive } from '../state/store';
import { endCall, requestCall, requestWeapon, runtime, setMic, setupInput } from '../game/runtime';
import { isKeyboardMouse } from '../input';
import { Btn, ClassIcon, fmtTime, useMenuNav } from './components';
import { CallChip } from './CallChip';
import { FriendPip } from './FriendPip';
import { Turntable } from './Turntable';
import { KEYMAP } from './Calibration';

function HealthBlock() {
  const health = useApp((s) => s.hud.health);
  const wave = useApp((s) => s.hud.wave);
  const title = useApp((s) => s.hud.waveTitle);
  const left = useApp((s) => s.hud.enemiesLeft);
  const blocking = useApp((s) => s.hud.blocking);
  const [ghost, setGhost] = useState(health);
  useEffect(() => { const t = setTimeout(() => setGhost(health), 350); return () => clearTimeout(t); }, [health]);
  return (
    <div className="tl">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hud-label">Odysseus</span>
        <span className="hud-label num">{Math.round(health)}</span>
      </div>
      <div className="health" role="meter" aria-label="Health" aria-valuenow={Math.round(health)} aria-valuemin={0} aria-valuemax={100}>
        <b style={{ transform: `scaleX(${Math.max(0, ghost) / 100})` }} />
        <i className={health < 35 ? 'low' : ''} style={{ transform: `scaleX(${Math.max(0, health) / 100})` }} />
      </div>
      <div className="row" style={{ gap: 10 }}>
        <span className="hud-label">Wave {['I', 'II', 'III'][wave - 1] ?? '—'}</span>
        <span className="hud-label" style={{ color: 'var(--dust)' }}>{title}</span>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <span className="hud-label num" style={{ color: 'var(--brass-hi)' }}>{left}</span>
        <span className="hud-label" style={{ color: 'var(--dust)' }}>wooers remain</span>
        {blocking && <span className="chip ok" style={{ marginLeft: 'auto' }}><span className="dot" />Guard</span>}
      </div>
    </div>
  );
}

function ScoreBlock() {
  const score = useApp((s) => s.hud.score);
  const combo = useApp((s) => s.hud.combo);
  const boss = useApp((s) => s.hud.boss);
  const time = useApp((s) => s.hud.matchTimeMs);
  return (
    <div className="tc">
      <div className="score">{score.toLocaleString()}</div>
      <div className="row" style={{ gap: 12 }}>
        {combo > 1 && <span className="combo">×{combo.toFixed(2)} COMBO</span>}
        <span className="hud-label num" style={{ color: 'var(--dust)' }}>{fmtTime(time)}</span>
      </div>
      {boss && (
        <div className="boss">
          <div className="hud-label" style={{ marginBottom: 4 }}>{boss.name}</div>
          <div className="bars">
            <div className="bar"><i style={{ width: `${boss.hp * 100}%` }} /></div>
            {boss.shield > 0 && <div className="bar shield"><i style={{ width: `${boss.shield * 100}%` }} /></div>}
          </div>
        </div>
      )}
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
  return (
    <div className="tr">
      <div className="callpanel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <CallChip />
          {call === 'connected' && <span className={`chip ${mic ? 'ok' : 'bad'}`} title="Push-to-talk (T)"><span className="dot" />{mic ? 'Mic' : 'Muted'}</span>}
        </div>
        {isCallLive(call) && <FriendPip />}
        {!isCallLive(call) && friend && <div className="muted small">Make the phone sign or press <span className="kbd">C</span> to call {friend.name}.</div>}
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
  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => force((x) => x + 1), subtitleMs(last.text) + 50);
    return () => clearTimeout(t);
  }, [last]);
  if (!last || performance.now() - last.at > subtitleMs(last.text)) return null;
  return (
    <div className="subtitle" aria-live="polite" key={last.id}>
      <span className="who">Quartermaster</span>
      {last.text}
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
  if (pinned && !isCallLive(call)) {
    return <div className="prompt big">📞 Make the phone sign to call {friend} {kb && <span className="kbd">C</span>}</div>;
  }
  if (call === 'connected' && (scan === 'idle' || scan === 'done')) {
    return <div className="prompt">🙌 Raise both arms to ask {friend} for a weapon {kb && <span className="kbd">Q</span>}</div>;
  }
  if (bow && kb) {
    return <div className="prompt">{draw > 0 ? `Drawing… ${Math.round(draw * 100)}%` : 'Bow ready — hold LMB or Space to draw'} <span className="kbd">B</span></div>;
  }
  return null;
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.slice(-3).map((t) => (
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
            <button aria-pressed={inputKind === 'motion'} onClick={() => void setupInput('motion')}>Body (webcam)</button>
            <button aria-pressed={inputKind === 'keyboard_mouse'} onClick={() => void setupInput('keyboard_mouse')}>Keyboard &amp; mouse</button>
          </div>
        </div>
        {inputKind === 'motion' && <Btn onClick={() => { void runtime.input?.calibrate?.(); }}>Recalibrate</Btn>}
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
    const t = setTimeout(() => setHint(false), 20000);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, []);

  const resume = () => { useApp.setState({ paused: false }); runtime.engine?.setPaused(false); };

  return (
    <div className="hud">
      <HealthBlock />
      <ScoreBlock />
      <CallPanel />
      <Toasts />
      <GestureRing />
      <div className="bc">
        <Subtitles />
        <Prompts />
      </div>
      {kb && hint && (
        <div className="bl callpanel small" style={{ maxWidth: 360 }}>
          <div className="hud-label" style={{ marginBottom: 6 }}>Controls · <span className="kbd">H</span> hide</div>
          <div className="muted">Point at the rack + hold <span className="kbd">LMB</span> to grab · flick + release to throw · <span className="kbd">B</span> bow · <span className="kbd">RMB</span> guard · <span className="kbd">A</span>/<span className="kbd">D</span> dodge · <span className="kbd">C</span> call · <span className="kbd">Q</span> weapon</div>
        </div>
      )}
      <TrackingOverlay />
      {kb && !paused && <Reticle />}
      {paused && <PauseMenu onResume={resume} />}
      <button style={{ display: 'none' }} onClick={requestWeapon} aria-hidden tabIndex={-1} />
    </div>
  );
}
