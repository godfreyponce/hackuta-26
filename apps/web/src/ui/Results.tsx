import { useState } from 'react';
import type { TrickshotKind } from '@ithaca/shared';
import { useApp } from '../state/store';
import { runtime, startMatch } from '../game/runtime';
import { TRICK_TITLES } from '../game/engine/scoring';
import { Btn, ClassIcon, Meander, TrickIcon, fmtTime, useMenuNav } from './components';

const ORDER: TrickshotKind[] = ['pin', 'multi_kill', 'friend_assist', 'headshot', 'long_shot', 'ricochet', 'airborne', 'return_to_sender'];

export function Results() {
  const go = useApp((s) => s.go);
  const r = useApp((s) => s.results);
  const killcams = useApp((s) => s.killcams);
  const submitted = useApp((s) => s.submitted);
  const session = useApp((s) => s.session);
  const player = useApp((s) => s.player);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [leaveArmed, setLeaveArmed] = useState(false);
  // Esc must not silently throw away an unsubmitted score: first press warns, second leaves
  const ref = useMenuNav<HTMLDivElement>(() => {
    if (!submitted && !leaveArmed) { setLeaveArmed(true); setErr('Press Esc again to leave without submitting your score.'); return; }
    runtime.engine?.backToMenu(); go('title');
  });

  if (!r) return null;

  async function submit() {
    if (!r || !runtime.net) return;
    setBusy(true); setErr(null);
    try {
      const weaponKills = Object.fromEntries(r.forged.map((f) => [f.weaponId, f.kills]));
      const res = await runtime.net.api.submitMatch({
        sessionId: session?.id ?? 'offline', score: r.score, kills: r.kills, trickshots: r.trickshots, durationMs: Math.round(r.durationMs),
        forgedWeaponIds: r.forged.filter((f) => !f.weaponId.startsWith('prefab-local')).map((f) => f.weaponId), weaponKills, playerName: player?.name,
      });
      useApp.setState({ submitted: { rank: res.rank } });
    } catch (e) {
      setErr(`${(e as Error).message || 'Could not reach the leaderboard'} — press Enter to retry.`);
    } finally { setBusy(false); }
  }

  const again = () => { startMatch(); go('game'); };
  const title = () => { runtime.engine?.backToMenu(); go('title'); };

  return (
    <div className="screen dim" ref={ref}>
      <div className="results">
        <section className="panel col">
          <div className="eyebrow">{r.victory ? 'Odyssey XXII · The hall is cleansed' : `Fell in wave ${r.wave}`}</div>
          <h1 className="h1" style={{ fontSize: 'clamp(34px, 4.4vw, 60px)' }}>{r.victory ? 'The hall is yours' : 'The wooers prevail'}</h1>
          <Meander />
          <div className="stat-row">
            <div className="stat"><div className="v">{r.score.toLocaleString()}</div><div className="k">Score</div></div>
            <div className="stat"><div className="v">{r.kills}</div><div className="k">Wooers slain</div></div>
            <div className="stat"><div className="v">×{r.bestCombo.toFixed(2)}</div><div className="k">Best combo</div></div>
            <div className="stat"><div className="v">{fmtTime(r.durationMs)}</div><div className="k">Time</div></div>
          </div>
          <div className="h3" style={{ marginTop: 6 }}>Trickshots</div>
          <div className="tricks">
            {ORDER.map((k) => (
              <div key={k} className={`trick ${r.trickshots[k] ? '' : 'zero'}`}>
                <TrickIcon kind={k} />
                <div><div className="n">{r.trickshots[k]}</div><div className="l">{TRICK_TITLES[k]}</div></div>
              </div>
            ))}
          </div>
          <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            {submitted
              ? <span className="chip ok"><span className="dot" />Rank #{submitted.rank} on the leaderboard</span>
              : <Btn variant="primary" autoFocus onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit to leaderboard'}</Btn>}
            <Btn onClick={again}>Fight again</Btn>
            <Btn onClick={() => go('armory')}>The Armory</Btn>
            <Btn onClick={() => go('leaderboard')}>Leaderboard</Btn>
            <Btn variant="link" onClick={title}>Title</Btn>
          </div>
          {err && <div className="error" role="alert">{err}</div>}
        </section>
        <section className="panel col">
          <div className="h3">Killcams</div>
          {killcams.length ? (
            <div className="clips">
              {killcams.slice(-3).map((k) => (
                <figure key={k.url} style={{ margin: 0 }}>
                  <video src={k.url} autoPlay muted loop playsInline />
                  <figcaption className="muted small" style={{ marginTop: 4 }}>{TRICK_TITLES[k.trickshot]}{k.weaponName ? ` · ${k.weaponName}` : ''}</figcaption>
                </figure>
              ))}
            </div>
          ) : <p className="muted small" style={{ margin: 0 }}>No killcams this time — pin a wooer to a pillar or drop two with one throw.</p>}
          <div className="h3" style={{ marginTop: 8 }}>Sent by Telemachus</div>
          {r.forged.length ? (
            <div className="forged-list">
              {r.forged.map((f) => (
                <div key={f.weaponId} className="forged-item">
                  {f.thumbUrl ? <img src={f.thumbUrl} alt={`Photo of ${f.objectName}`} /> : <ClassIcon cls={f.weaponClass} size={48} />}
                  <div style={{ flex: 1 }}>
                    <div className="h3">{f.displayName}</div>
                    <div className="muted small">a real {f.objectName}{f.fallback ? ' · stock forge' : ''}</div>
                  </div>
                  <div className="stat" style={{ padding: '6px 12px', textAlign: 'center' }}><div className="v" style={{ fontSize: 22 }}>{f.kills}</div><div className="k">kills</div></div>
                </div>
              ))}
            </div>
          ) : <p className="muted small" style={{ margin: 0 }}>No weapons from the storeroom this match. Next time: call Telemachus and raise both arms.</p>}
        </section>
      </div>
    </div>
  );
}
