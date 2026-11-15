import { useEffect, useRef, useState, type ComponentType } from 'react';
import { getFriendViewStream } from '../game/friendView';
import { loadMotionModule } from '../input';

/** ?dev=friendview — shows the friend-view MediaStream in a phone-sized frame with FaceTime chrome mocked in. */
export function DevFriendView() {
  const v = useRef<HTMLVideoElement>(null);
  const [fps, setFps] = useState(0);
  useEffect(() => {
    const s = getFriendViewStream();
    if (v.current) { v.current.srcObject = s; void v.current.play().catch(() => {}); }
    const track = s.getVideoTracks()[0];
    const t = setInterval(() => setFps(track?.getSettings().frameRate ?? 0), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="devphone" aria-hidden>
      <div className="eyebrow">Friend view · 640×360 · {fps ? `${Math.round(fps)} fps` : '…'}</div>
      <div className="phone">
        <video ref={v} muted playsInline />
        <div className="self" title="FaceTime self-view tile" />
        <div className="ctrls" title="FaceTime controls" />
      </div>
    </div>
  );
}

/** ?dev=motionlab — mounts Part C's Motion Lab when the package exists. */
export function DevMotionLab() {
  const [Comp, setComp] = useState<ComponentType | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    loadMotionModule().then((m) => { if (m?.MotionLab) setComp(() => m.MotionLab!); else setMissing(true); });
  }, []);
  if (Comp) return <div style={{ position: 'fixed', inset: 0, overflow: 'auto', background: '#0b0907', zIndex: 10 }}><Comp /></div>;
  return <div className="devframe"><p className="lore">{missing ? 'Motion Lab not installed yet (packages/motion).' : 'Loading Motion Lab…'}</p></div>;
}
