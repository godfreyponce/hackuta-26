import { useEffect, useState } from 'react';
import { useApp, isCallLive } from '../state/store';
import { endCall, ensureSession, reasonText, requestCall, setupInput, startMatch } from '../game/runtime';
import { motionAvailable } from '../input';
import { Btn, StanceChecklist, isBodyInput, useMenuNav } from './components';
import { CallChip } from './CallChip';
import { FriendPip } from './FriendPip';
import { audio } from '../game/engine/audio';

export function Lobby() {
  const go = useApp((s) => s.go);
  const friend = useApp((s) => s.friend);
  const call = useApp((s) => s.call);
  const difficulty = useApp((s) => s.difficulty);
  const inputKind = useApp((s) => s.inputKind);
  const session = useApp((s) => s.session);
  const netMode = useApp((s) => s.netMode);
  const mediaStatus = useApp((s) => s.mediaStatus);
  const [sessionErr, setSessionErr] = useState(false);
  const ref = useMenuNav<HTMLDivElement>(() => go('calibration'));

  useEffect(() => {
    let alive = true;
    ensureSession().then((ok) => { if (alive) setSessionErr(!ok); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'KeyC') requestCall();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const live = isCallLive(call.state);
  const body = isBodyInput(inputKind);
  const fname = friend?.name ?? 'Telemachus';
  const start = () => { audio.unlock(); startMatch(); go('game'); };

  return (
    <div className="screen dim" ref={ref}>
      <div className="topbar">
        <Btn variant="link" onClick={() => go('calibration')}>← Back</Btn>
        <div className="eyebrow">The threshold</div>
        <div className="spacer" />
        <span className={`chip ${session ? 'ok' : sessionErr ? 'bad' : 'pending'}`}>
          <span className="dot" />{session ? (netMode === 'mock' ? 'Mock session' : 'Session ready') : sessionErr ? 'Offline' : 'Opening session…'}
        </span>
      </div>
      <div className="lobby">
        <section className="panel col">
          <div className="panel-title"><h2 className="h2">Call a friend</h2></div>
          <p className="lore" style={{ margin: 0 }}>
            “Father, lo, now I will bring thee a shield and two spears and a helmet all of bronze.”
            <cite>Telemachus · Odyssey XXII</cite>
          </p>
          {friend ? (
            <>
              <FriendPip big />
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <CallChip />
                <span className="muted small">{friend.name} · {friend.phoneMasked}</span>
                {netMode === 'live' && mediaStatus === 'failed' && <span className="chip bad"><span className="dot" />Video relay offline</span>}
              </div>
            </>
          ) : (
            // fighting alone: say what a Telemachus adds, instead of an empty video frame
            <div className="solo-card">
              <svg width="40" height="40" viewBox="0 0 64 64" aria-hidden>
                <circle cx="32" cy="22" r="11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="4 3" />
                <path d="M10 60 Q12 36 32 36 Q52 36 54 60" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="4 3" />
              </svg>
              <div>
                <div className="h3">You fight alone</div>
                <p className="muted small" style={{ margin: '4px 0 10px' }}>Add a friend and the game FaceTimes them mid-fight:</p>
                <ol className="solo-steps">
                  <li><span><b>Call</b> — {body ? 'the phone sign by your ear' : <>press <span className="kbd">C</span></>}</span></li>
                  <li><span><b>They hold up</b> a pan, a broom, a bottle…</span></li>
                  <li><span><b>It’s forged</b> into a weapon and flies into the hall</span></li>
                </ol>
              </div>
            </div>
          )}
          {call.state === 'failed' && friend && (
            <div className="small call-reason" role="status">{reasonText(call.reason)} · press <span className="kbd">C</span> to try again</div>
          )}
          {sessionErr && <div className="small call-reason" role="status">The server is unreachable — you can still fight alone.</div>}
          {friend ? (
            live ? (
              <Btn variant="danger" onClick={endCall}>End call</Btn>
            ) : (
              <Btn variant="call" big autoFocus={!live} onClick={requestCall} hotkey="C" disabled={!session}>
                📞 Call {friend.name} now
              </Btn>
            )
          ) : (
            <><div className="spacer" /><Btn onClick={() => go('setup')}>Add your Telemachus</Btn></>
          )}
          {friend && (
            <p className="muted small" style={{ margin: 0 }}>
              Call before the fight — ringing takes a moment. The call ends by 4:45. If it drops, the fight goes on.
            </p>
          )}
        </section>

        <section className="panel col">
          <div className="panel-title"><h2 className="h2">The fight</h2></div>
          <div className="field">
            <label>Difficulty</label>
            <div className="seg" role="group" aria-label="Difficulty">
              <button aria-pressed={difficulty === 'easy'} onClick={() => useApp.setState({ difficulty: 'easy' })}>Easy · can’t fall</button>
              <button aria-pressed={difficulty === 'normal'} onClick={() => useApp.setState({ difficulty: 'normal' })}>Normal</button>
            </div>
          </div>
          <div className="field">
            <label>Controls</label>
            <div className="seg" role="group" aria-label="Controls">
              <button aria-pressed={body} disabled={!motionAvailable} onClick={() => { if (!body) void setupInput('motion'); }}>{motionAvailable ? 'Body (webcam)' : 'Body (webcam) · unavailable'}</button>
              <button aria-pressed={inputKind === 'keyboard_mouse'} onClick={() => void setupInput('keyboard_mouse')}>Keyboard &amp; mouse</button>
            </div>
          </div>
          {inputKind === 'replay' && <span className="muted small" style={{ marginTop: -6 }}>Replaying a recorded webcam session — the recording moves your hands.</span>}
          {body && <StanceChecklist compact />}
          <ul className="muted small lobby-tips">
            {body ? (<>
              <li><b>Reach toward a weapon and make a fist</b> — it flies to your hand. Open your hand mid-swing to throw.</li>
              <li><b>Both fists up by your chin</b> to guard; lean to dodge.</li>
            </>) : (<>
              <li><b>Click a weapon</b> on the table to take it (hold <span className="kbd">Tab</span> to look down); swing with the mouse.</li>
              <li><span className="kbd">RMB</span> guard · <span className="kbd">W</span> thrust · flick and release <span className="kbd">LMB</span> to throw.</li>
            </>)}
            <li>Three waves of wooers, then Antinous behind a table-top shield. Pin them to the pillars for slow-motion killcams.</li>
            {friend && (body ? (<>
              <li>Pinned down? <b>Make the phone sign by your ear</b> (or <span className="kbd">C</span>) to call {fname}; <b>hands over your head</b> (or <span className="kbd">Q</span>) and he sends what he’s holding.</li>
            </>) : (
              <li>Pinned down? Press <span className="kbd">C</span> to call {fname}, then <span className="kbd">Q</span> and he sends what he’s holding.</li>
            ))}
          </ul>
          <div className="spacer" />
          <Btn variant="primary" big autoFocus={live || !friend} onClick={start}>Start the fight</Btn>
        </section>
      </div>
    </div>
  );
}
