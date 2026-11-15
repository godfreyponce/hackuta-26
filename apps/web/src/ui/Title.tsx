import { useApp } from '../state/store';
import { Btn, HelmetEmblem, Meander, useMenuNav } from './components';

export function Title() {
  const go = useApp((s) => s.go);
  const player = useApp((s) => s.player);
  const friend = useApp((s) => s.friend);
  const netMode = useApp((s) => s.netMode);
  const netReason = useApp((s) => s.netReason);
  const ref = useMenuNav<HTMLDivElement>();

  const begin = () => go(player && friend ? 'calibration' : 'setup');

  return (
    <div className="screen vignette" ref={ref}>
      <div className="title-wrap">
        <div className="row" style={{ gap: 18 }}>
          <HelmetEmblem />
          <div className="eyebrow">Odyssey · Book XXII</div>
        </div>
        <div>
          <h1 className="h1 logo">ITHACA</h1>
          <div className="logo-sub logo-name2">Calling</div>
        </div>
        <Meander style={{ maxWidth: 420 }} />
        <p className="lore" style={{ maxWidth: 560, margin: 0 }}>
          “Run and bring them while I have arrows to defend me, lest they thrust me from the doorway, one man against them all.”
          <cite>Odysseus to Telemachus · Odyssey XXII, tr. Butcher &amp; Lang (1879)</cite>
        </p>
        <div className="title-menu">
          <Btn variant="primary" big autoFocus onClick={begin}>Begin</Btn>
          <Btn onClick={() => go('armory')}>The Armory</Btn>
          <Btn onClick={() => go('leaderboard')}>Leaderboard</Btn>
          {player && <Btn variant="link" onClick={() => go('setup')}>Change player or Telemachus</Btn>}
        </div>
        <div className="title-foot">
          <span className={`chip ${netMode === 'live' ? 'ok' : netMode === 'mock' ? 'warn' : 'pending'}`}>
            <span className="dot" />{netMode === 'live' ? 'Server connected' : netMode === 'mock' ? 'Mock hub' : 'Connecting…'}
          </span>
          {netReason && <span className="muted small">{netReason}</span>}
          <span className="muted small">Arrow keys + Enter to navigate · Esc to go back</span>
        </div>
      </div>
    </div>
  );
}
