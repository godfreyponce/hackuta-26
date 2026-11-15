import { useEffect, useState } from 'react';
import type { TrickshotKind } from '@ithaca/shared';
import { useApp } from '../state/store';
import { runtime } from '../game/runtime';
import { TRICK_TITLES } from '../game/engine/scoring';
import type { LeaderRow } from '../net/types';
import { Btn, Meander, TrickIcon, useMenuNav } from './components';

export function Leaderboard() {
  const go = useApp((s) => s.go);
  const prev = useApp((s) => s.prevScreen);
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const back = () => go(prev === 'results' ? 'results' : 'title');
  const ref = useMenuNav<HTMLDivElement>(back);

  useEffect(() => {
    let alive = true;
    runtime.net?.api.leaderboard(10).then((r) => { if (alive) { setRows(r); setErr(null); } }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [tick]);

  return (
    <div className="screen dim" ref={ref}>
      <div className="topbar">
        <Btn variant="link" onClick={back}>← Back</Btn>
        <div className="eyebrow">Heroes of the hall</div>
      </div>
      <div className="board panel">
        <h1 className="h2">Leaderboard</h1>
        <Meander style={{ margin: '12px 0 8px' }} />
        {err && <div className="error" role="alert">Couldn’t reach the leaderboard. <Btn variant="link" onClick={() => setTick((t) => t + 1)}>Retry</Btn></div>}
        {!rows && !err && <p className="muted">Loading…</p>}
        {rows && rows.length === 0 && <p className="lore" style={{ margin: '18px 0 6px' }}>No heroes yet — be the first to clear the hall.</p>}
        {rows && rows.length > 0 && (
          <table>
            <thead><tr><th>#</th><th>Hero</th><th>Trickshots</th><th style={{ textAlign: 'right' }}>Score</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.playerName}-${r.createdAt}-${i}`} className={i === 0 ? 'first' : ''}>
                  <td className="rank">{i + 1}</td>
                  <td>{r.playerName}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {(Object.entries(r.trickshots ?? {}) as [TrickshotKind, number][]).filter(([, n]) => n > 0).slice(0, 5).map(([k, n]) => (
                        <span key={k} className="row" style={{ gap: 3 }} title={TRICK_TITLES[k]}><TrickIcon kind={k} size={20} /><span className="small num">{n}</span></span>
                      ))}
                    </div>
                  </td>
                  <td className="sc">{r.score.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ marginTop: 16 }}><Btn autoFocus onClick={back}>Back</Btn></div>
      </div>
    </div>
  );
}
