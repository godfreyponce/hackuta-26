import { useEffect, useRef } from 'react';
import { useApp } from '../state/store';

/** Friend's live camera (Part B's "friend-cam" track). Placeholder until the call connects. */
export function FriendPip({ big = false }: { big?: boolean }) {
  const el = useApp((s) => s.friendCam);
  const call = useApp((s) => s.call.state);
  const friend = useApp((s) => s.friend);
  const netMode = useApp((s) => s.netMode);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = host.current;
    if (!h || !el) return;
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    h.prepend(el);
    void el.play().catch(() => {});
    return () => { if (h.contains(el)) h.removeChild(el); };
  }, [el]);

  const name = friend?.name ?? 'Telemachus';
  let msg = 'Not on a call';
  if (call === 'dialing' || call === 'ringing') msg = `Calling ${name}…`;
  else if (call === 'connected') msg = netMode === 'mock' ? `${name} is on the line (mock — no video)` : 'Waiting for video…';
  else if (call === 'failed' || call === 'ended') msg = `${name} is away`;

  return (
    <div className="pip" ref={host} style={big ? { maxWidth: 420 } : undefined}>
      {!el && (
        <div className="placeholder">
          <svg width="46" height="46" viewBox="0 0 64 64" aria-hidden style={{ opacity: 0.6, marginBottom: 6 }}>
            <circle cx="32" cy="22" r="11" fill="#6e665b" />
            <path d="M10 60 Q12 36 32 36 Q52 36 54 60 Z" fill="#6e665b" />
          </svg>
          <div>{msg}</div>
        </div>
      )}
      <span className="name">{name}</span>
    </div>
  );
}
