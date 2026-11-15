import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { fmtTime } from './components';

const CALL_MAX_MS = 285_000; // agent hard-stops at 4:45

export function CallChip({ compact = false }: { compact?: boolean }) {
  const call = useApp((s) => s.call);
  const friend = useApp((s) => s.friend);
  const [, tick] = useState(0);
  useEffect(() => {
    if (call.state !== 'connected') return;
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [call.state]);
  const name = friend?.name ? `Warrior ${friend.name}` : 'Telemachus';
  const queued = call.reason?.match(/^line_busy_(\d+)$/);
  switch (call.state) {
    case 'dialing': return <span className="chip pending"><span className="dot" />{queued ? <>Line busy · #{queued[1]} in queue</> : <>Dialing {name}…</>}</span>;
    case 'ringing': return <span className="chip pending"><span className="dot" />Ringing {name}…</span>;
    case 'connected': {
      const el = call.connectedAt ? performance.now() - call.connectedAt : 0;
      const left = CALL_MAX_MS - el;
      return (
        <span className={`chip ${left < 30_000 ? 'warn' : 'live'}`}>
          <span className="dot" />{compact ? null : <>{name} · </>}<span className="num">{fmtTime(el)}</span>
          <span className="muted num">/ 4:45</span>
        </span>
      );
    }
    case 'ending': return <span className="chip warn"><span className="dot" />Ending call…</span>;
    case 'failed': return <span className="chip bad"><span className="dot" />Call failed</span>;
    case 'ended': return <span className="chip"><span className="dot" />{name} is away</span>;
    default: return <span className="chip"><span className="dot" />Not calling</span>;
  }
}
