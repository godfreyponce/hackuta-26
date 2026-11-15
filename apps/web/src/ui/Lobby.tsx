import { useEffect, useState } from 'react';
import { useApp, isCallLive } from '../state/store';
import { endCall, ensureSession, requestCall, setupInput, startMatch } from '../game/runtime';
import { Btn, useMenuNav } from './components';
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
          <div className="panel-title"><h2 className="h2">Phone a friend</h2></div>
          <p className="lore" style={{ margin: 0 }}>
            “Father, lo, now I will bring thee a shield and two spears and a helmet all of bronze.”
            <cite>Telemachus · Odyssey XXII</cite>
          </p>
          <FriendPip big />
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <CallChip />
            {friend ? <span className="muted small">{friend.name} · {friend.phoneMasked}</span> : <span className="muted small">No friend added</span>}
            {netMode === 'live' && mediaStatus === 'failed' && <span className="chip bad"><span className="dot" />Video relay offline</span>}
          </div>
          {friend ? (
            live ? (
              <Btn variant="danger" onClick={endCall}>End call</Btn>
            ) : (
              <Btn variant="call" big autoFocus={!live} onClick={requestCall} hotkey="C" disabled={!session}>
                📞 Call {friend.name} now
              </Btn>
            )
          ) : (
            <Btn onClick={() => go('setup')}>Add your Telemachus</Btn>
          )}
          <p className="muted small" style={{ margin: 0 }}>
            Call before the fight — ringing takes a moment. The call ends by 4:45. If it drops, the fight goes on.
          </p>
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
              <button aria-pressed={inputKind === 'motion'} onClick={() => void setupInput('motion')}>Body (webcam)</button>
              <button aria-pressed={inputKind === 'keyboard_mouse'} onClick={() => void setupInput('keyboard_mouse')}>Keyboard &amp; mouse</button>
            </div>
          </div>
          <ul className="muted small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
            <li>Three waves of wooers, then Antinous behind a table-top shield.</li>
            <li>Pin wooers to the pillars with spears and arrows for slow-motion killcams.</li>
            <li>When you’re pinned down, <b>make the phone sign</b> (or press <span className="kbd">C</span>).</li>
            <li><b>Raise both arms</b> (or <span className="kbd">Q</span>) and Telemachus sends whatever he’s holding.</li>
          </ul>
          <div className="spacer" />
          <Btn variant="primary" big autoFocus={live} onClick={start}>Start the fight</Btn>
        </section>
      </div>
    </div>
  );
}
