import { Fragment, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { runtime, setupInput } from '../game/runtime';
import { CALIBRATION_ORDER, type CalibrationStepInfo } from '../input';
import { Btn, isBodyInput, useMenuNav } from './components';

const STEPS = [
  // wording follows Part C's checks (packages/motion/src/calibration.ts) so the player does what is measured
  { id: 'frame', label: 'Step back until your hips are visible', hint: 'About 2 m from the Mac, light in front of you' },
  { id: 'guard', label: 'Raise your guard: both fists up by your chin', hint: 'Hold still for 2 seconds' },
  { id: 'bow', label: 'Left arm straight out to your LEFT side', hint: 'At shoulder height, like holding a bow — sideways, not toward the screen' },
  { id: 'grip', label: 'Make a fist, then open your hand', hint: 'Both hands, three times' },
];

export const KEYMAP: [string, string][] = [
  ['Mouse', 'The blade’s point follows the cursor — swing by moving (wheel = reach)'],
  ['LMB click', 'Take the weapon you point at · a second one goes to your other hand'],
  ['LMB flick', 'Hold, flick and release to throw'],
  ['W', 'Thrust'],
  ['X / F', 'Set the weapon down / quick throw'],
  ['RMB hold', 'Raise your guard — the aspis if you carry one'],
  ['B', 'Bow — then hold LMB or Space to draw, release to loose'],
  ['A / D', 'Lean to dodge · S crouch'],
  ['Shift', 'Mouse drives your left hand (dual wield)'],
  ['E', 'Drink a potion'],
  ['C', 'Call a friend (Telemachus)'],
  ['Q', 'Ask Telemachus for a weapon'],
  ['T', 'Push-to-talk toggle · Esc pause'],
];

/** Webcam (body) moves — wording and timings follow Part C's detectors (packages/motion/src/gestures.ts, grip.ts).
 *  `friend` rows only matter when a Telemachus is set up. */
export const BODY_MOVES: { move: string; does: string; friend?: boolean }[] = [
  { move: 'Reach + make a fist', does: 'Take a weapon — reach toward it on the table and close your hand; it flies to you' },
  { move: 'Swing your arm', does: 'Strike — the blade follows your forearm · punch forward to stab' },
  { move: 'Open your hand', does: 'Let go — mid-swing it flies (throw), at rest you set it down' },
  { move: 'Both fists by your chin', does: 'Guard — hold them up as a blow lands' },
  { move: 'Lean left / right', does: 'Dodge · crouch to duck a high cut' },
  { move: 'Left arm out to the side', does: 'Bow — bring your right fist to your left hand, pull back, open to loose' },
  { move: 'Fist to your mouth', does: 'Drink a potion (hold about half a second)' },
  { move: 'Phone sign by your ear', does: 'Thumb and pinky out, hold 1 s — call Telemachus', friend: true },
  { move: 'Both hands over your head', does: 'Hold a moment — your friend sends a weapon', friend: true },
];

/** The moves as a two-column key → action list (used on calibration, in the lobby and the pause menu). */
export function BodyMoves({ friend = true, limit }: { friend?: boolean; limit?: number }) {
  const rows = BODY_MOVES.filter((m) => friend || !m.friend).slice(0, limit);
  return (
    <div className="keys body-moves">
      {rows.map((m) => <Fragment key={m.move}><span className="move">{m.move}</span><span>{m.does}</span></Fragment>)}
    </div>
  );
}

export function Calibration() {
  const go = useApp((s) => s.go);
  const inputKind = useApp((s) => s.inputKind);
  const fallback = useApp((s) => s.inputFallback);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<boolean[]>([false, false, false, false]);
  const [status, setStatus] = useState<'idle' | 'running' | 'ok' | 'failed'>('idle');
  // live feedback from Part C's calibration (what it sees right now, progress within the step, why it failed)
  const [live, setLive] = useState<{ hint: string; progress: number; failed: string }>({ hint: '', progress: 0, failed: '' });
  const [loading, setLoading] = useState(false);
  const camRef = useRef<HTMLDivElement>(null);
  const ref = useMenuNav<HTMLDivElement>(() => go('setup'));

  // ?input=replay drives the same webcam path from a recording: it calibrates and plays like the camera, minus the video
  const motion = isBodyInput(inputKind);
  const replay = inputKind === 'replay';
  const friend = useApp((s) => !!s.friend);
  const [hasVideo, setHasVideo] = useState(false);

  useEffect(() => {
    if (!motion) return;
    const c = runtime.input;
    const host = camRef.current;
    let video: HTMLVideoElement | null = null;
    // the camera can still be starting when this screen mounts: keep looking for its video for a few seconds
    const attach = () => {
      video = c?.getDebugVideo?.() ?? null;
      if (!video || !host) return false;
      if (!host.contains(video)) {
        video.muted = true;
        video.playsInline = true;
        host.prepend(video);
        void video.play().catch(() => {});
      }
      setHasVideo(true);
      return true;
    };
    setHasVideo(false);
    let tries = 0;
    const poll = attach() ? 0 : window.setInterval(() => { if (attach() || ++tries > 40) window.clearInterval(poll); }, 250);
    const ext = c as unknown as { onCalibrationStep?: (cb: (s: CalibrationStepInfo) => void) => () => void; drawOverlay?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void };
    const off = ext?.onCalibrationStep?.((s) => {
      if (s.index >= 1) setStep(s.index - 1); // C numbers the 4 steps from 1 (0 = done/failed)
      if (s.step === 'done') setDone([true, true, true, true]);
      else setDone(CALIBRATION_ORDER.map((n) => !!s.passed?.includes(n)));
      setLive({ hint: s.hint || s.message || '', progress: s.progress ?? 0, failed: s.step === 'failed' ? (s.failedReason ?? '') : '' });
    });
    // skeleton overlay if Part C exposes a drawer
    let raf = 0;
    const canvas = host?.querySelector('canvas');
    if (canvas && ext?.drawOverlay) {
      const ctx = canvas.getContext('2d');
      const loop = () => {
        if (ctx) { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; ext.drawOverlay?.(ctx, canvas.width, canvas.height); }
        raf = requestAnimationFrame(loop);
      };
      loop();
    }
    return () => {
      off?.(); cancelAnimationFrame(raf); window.clearInterval(poll);
      const v = video as HTMLVideoElement | null;
      if (v && host?.contains(v)) {
        host.removeChild(v);
        // removing a <video> from the page pauses it: the tracker would freeze on its last frame — keep it running
        void v.play().catch(() => {});
      }
    };
  }, [motion, inputKind]);

  async function run() {
    const c = runtime.input;
    if (!c?.calibrate) { setStatus('ok'); setDone([true, true, true, true]); return; }
    setStatus('running');
    setLive({ hint: '', progress: 0, failed: '' });
    try {
      const r = await Promise.race([c.calibrate(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 45_000))]);
      if (r.ok) { setStatus('ok'); setDone([true, true, true, true]); } else setStatus('failed');
    } catch { setStatus('failed'); }
  }

  async function switchTo(kind: 'motion' | 'keyboard_mouse') {
    setLoading(true);
    await setupInput(kind);
    setLoading(false);
    setStatus('idle');
  }

  return (
    <div className="screen dim" ref={ref}>
      <div className="topbar">
        <Btn variant="link" onClick={() => go('setup')}>← Back</Btn>
        <div className="eyebrow">Calibration</div>
        <div className="spacer" />
        <span className={`chip ${motion ? 'ok' : 'warn'}`}><span className="dot" />{replay ? 'Recorded motion (replay)' : motion ? 'Motion tracking' : 'Keyboard & mouse'}</span>
      </div>
      <div className="calib">
        {motion ? (
          <div className="col calib-left">
            <div className="cam" ref={camRef}>
              <canvas />
              {!hasVideo && (
                <div className="cam-note">
                  {replay ? <><b>Replaying a recorded webcam session</b><span>No live camera — the recording moves your hands.</span></> : <><b>Starting the camera…</b><span>Allow camera access when Chrome asks.</span></>}
                </div>
              )}
              {status === 'ok' && <div className="cam-ok"><span className="chip ok"><span className="dot" />Calibrated</span></div>}
            </div>
            <section className="panel moves-panel">
              <div className="h3">In the hall</div>
              <BodyMoves friend={friend} limit={5} />
            </section>
          </div>
        ) : (
          <section className="panel">
            <div className="panel-title"><h2 className="h2">Keyboard &amp; mouse</h2></div>
            {fallback && <p className="error" style={{ marginTop: 0 }}>{fallback}</p>}
            <div className="keys">
              {KEYMAP.map(([k, v]) => <Fragment key={k}><span className="kbd">{k}</span><span>{v}</span></Fragment>)}
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>Point at a weapon on the table and click — it flies to your hand. Hold <span className="kbd">Tab</span> to look down at the table.</p>
          </section>
        )}
        <section className="panel col">
          {motion ? (
            <>
              <div className="steps">
                {STEPS.map((s, i) => (
                  <div key={s.id} className={`step ${i === step && status === 'running' ? 'on' : ''} ${done[i] ? 'done' : ''}`}>
                    <span className="ix">{done[i] ? '✓' : i + 1}</span>
                    <div><div className="h3">{s.label}</div><div className="muted small">{i === step && status === 'running' && live.hint ? live.hint : s.hint}</div>
                      {i === step && status === 'running' && live.progress > 0 && <div className="calib-progress"><i style={{ width: `${Math.round(live.progress * 100)}%` }} /></div>}</div>
                  </div>
                ))}
              </div>
              {status === 'failed' && <div className="error">{live.failed || 'Couldn’t see you clearly.'} Face a light, step back, and try again — or use the keyboard.</div>}
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {status !== 'ok' && <Btn variant="primary" autoFocus onClick={run} disabled={status === 'running'}>{status === 'running' ? 'Calibrating…' : status === 'failed' ? 'Try again' : 'Start calibration'}</Btn>}
                {status === 'ok' && <Btn variant="primary" autoFocus onClick={() => go('lobby')}>Continue</Btn>}
                <Btn variant="link" onClick={() => switchTo('keyboard_mouse')}>Use keyboard &amp; mouse instead</Btn>
              </div>
              <Btn variant="link" onClick={() => go('lobby')}>Skip calibration</Btn>
            </>
          ) : (
            <>
              <h2 className="h2">Ready when you are</h2>
              <p className="lore" style={{ margin: 0 }}>“Lo, now is this terrible trial ended at last.”<cite>Odyssey XXII</cite></p>
              <Btn variant="primary" big autoFocus onClick={() => go('lobby')}>Continue</Btn>
              <Btn onClick={() => switchTo('motion')} disabled={loading}>{loading ? 'Starting camera…' : 'Try motion tracking'}</Btn>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
