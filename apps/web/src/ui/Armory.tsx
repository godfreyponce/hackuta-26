import { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import { runtime } from '../game/runtime';
import type { ArmoryItem } from '../net/types';
import { Btn, ClassIcon, Meander, useMenuNav } from './components';
import { Turntable } from './Turntable';
import { mockThumb } from '../net/mockCatalog';

function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** The Armory — every weapon forged at the event (MongoDB showcase: live via change streams → armory.new). */
export function Armory() {
  const go = useApp((s) => s.go);
  const prev = useApp((s) => s.prevScreen);
  const pulse = useApp((s) => s.armoryPulse);
  const newest = useApp((s) => s.newestWeaponId);
  const netMode = useApp((s) => s.netMode);
  const [items, setItems] = useState<ArmoryItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<ArmoryItem | null>(null);
  const [view, setView] = useState<'3d' | 'photo'>('3d');
  const [retry, setRetry] = useState(0);
  const back = () => go(prev === 'results' ? 'results' : 'title');
  const ref = useMenuNav<HTMLDivElement>(back);

  useEffect(() => {
    let alive = true;
    const net = runtime.net;
    if (!net) return;
    net.api.armory(50).then((list) => {
      if (!alive) return;
      setItems(list);
      setErr(null);
      setSel((s) => (s ? list.find((x) => x.weaponId === s.weaponId) ?? list[0] ?? null : list[0] ?? null));
    }).catch((e) => { if (alive) setErr((e as Error).message); });
    return () => { alive = false; };
  }, [pulse, retry]);

  return (
    <div className="screen dim" ref={ref}>
      <div className="topbar">
        <Btn variant="link" onClick={back}>← Back</Btn>
        <div>
          <div className="eyebrow">The storeroom of Odysseus</div>
          <h1 className="h2">The Armory</h1>
        </div>
        <div className="spacer" />
        <span className={`chip ${err ? 'bad' : netMode === 'live' ? 'live' : 'warn'}`}><span className="dot" />{err ? 'Storeroom offline' : netMode === 'live' ? 'Live · MongoDB Atlas' : 'Mock armory'}</span>
        <span className="muted small num">{items?.length ?? 0} relics</span>
      </div>
      <Meander style={{ marginBottom: 16 }} />
      {err && <div className="error" role="alert">Couldn’t open the storeroom. <Btn variant="link" onClick={() => { setErr(null); setRetry((r) => r + 1); }}>Retry</Btn></div>}
      {!items && !err && <p className="lore">Unbarring the storeroom…</p>}
      {items && items.length === 0 && <p className="lore">Nothing forged yet. Every object a friend holds up becomes a relic here.</p>}
      {items && items.length > 0 && (
        <div className="armory">
          <div className="relics" role="list">
            {items.map((it) => (
              <button key={it.weaponId} role="listitem" className={`relic ${sel?.weaponId === it.weaponId ? 'sel' : ''}`}
                onClick={() => setSel(it)} onFocus={() => setSel(it)} aria-label={`${it.displayName}, a ${it.objectName}, sent by ${it.friendName}`}>
                <img src={it.thumbUrl ?? mockThumb(it.objectName, it.weaponClass)} alt="" loading="lazy" />
                {it.weaponId === newest && <span className="ribbon">NEW</span>}
                <span className="kills chip"><ClassIcon cls={it.weaponClass} size={16} />{it.kills} {it.kills === 1 ? 'kill' : 'kills'}</span>
                <span className="meta">
                  <span className="nm">{it.displayName}</span>
                  <span className="by">a {it.objectName}, sent by {it.friendName}</span>
                </span>
              </button>
            ))}
          </div>
          {sel && (
            <div className="case">
              <div className="stage">
                {view === '3d'
                  ? <Turntable key={sel.weaponId} url={sel.glbUrl} cls={sel.weaponClass} speed={0.7} />
                  : <img src={sel.thumbUrl ?? mockThumb(sel.objectName, sel.weaponClass)} alt={`Photo of the real ${sel.objectName}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                <div className="plinth" />
              </div>
              <div className="seg" role="group" aria-label="View">
                <button aria-pressed={view === 'photo'} onClick={() => setView('photo')}>The real object</button>
                <button aria-pressed={view === '3d'} onClick={() => setView('3d')}>The forged relic</button>
              </div>
              <div className="label">
                <div className="nm">{sel.displayName}</div>
                <div className="sub">A {sel.objectName}, sent by {sel.friendName} · {ago(sel.createdAt)}</div>
              </div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <span className="chip"><ClassIcon cls={sel.weaponClass} size={16} />{sel.weaponClass}</span>
                <span className="chip ok"><span className="dot" />{sel.kills} {sel.kills === 1 ? 'wooer' : 'wooers'} slain</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
