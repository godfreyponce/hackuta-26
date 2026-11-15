import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { runtime, persistPlayer } from '../game/runtime';
import { pushToast } from '../state/store';
import { setMockFriendName } from '../net';
import { Btn, Meander, useMenuNav } from './components';

const COUNTRIES: { code: string; dial: string; name: string }[] = [
  { code: 'US', dial: '+1', name: 'United States' },
  { code: 'CA', dial: '+1', name: 'Canada' },
  { code: 'MX', dial: '+52', name: 'Mexico' },
  { code: 'GB', dial: '+44', name: 'United Kingdom' },
  { code: 'IN', dial: '+91', name: 'India' },
  { code: 'GR', dial: '+30', name: 'Greece' },
  { code: 'NG', dial: '+234', name: 'Nigeria' },
  { code: 'PK', dial: '+92', name: 'Pakistan' },
  { code: 'VN', dial: '+84', name: 'Vietnam' },
  { code: 'CN', dial: '+86', name: 'China' },
  { code: 'KR', dial: '+82', name: 'South Korea' },
  { code: 'BR', dial: '+55', name: 'Brazil' },
];

class OfflineError extends Error {}

export function Setup() {
  const go = useApp((s) => s.go);
  const player = useApp((s) => s.player);
  const friend = useApp((s) => s.friend);
  const [name, setName] = useState(player?.name ?? 'Odysseus');
  const [fname, setFname] = useState(friend?.name ?? 'Telemachus');
  const [country, setCountry] = useState('US');
  const [local, setLocal] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useMenuNav<HTMLDivElement>(() => go('title'));

  const dial = COUNTRIES.find((c) => c.code === country)?.dial ?? '+1';
  const e164 = useMemo(() => {
    const digits = local.replace(/\D/g, '').replace(/^0+/, '');
    return digits ? `${dial}${digits}` : '';
  }, [dial, local]);
  const validPhone = /^\+[1-9]\d{7,14}$/.test(e164);

  async function savePlayerOnly() {
    const net = runtime.net;
    const nm = name.trim() || 'Odysseus';
    if (player && player.name === nm) return;
    try {
      if (!net) throw new Error('offline');
      const { playerId } = await net.api.createPlayer(nm);
      useApp.setState({ player: { id: playerId, name: nm }, session: null });
    } catch {
      // server unreachable: keep a local hero so the fight still runs (score just won't post)
      useApp.setState({ player: { id: `local-${Math.random().toString(36).slice(2, 10)}`, name: nm }, session: null });
      pushToast({ kind: 'warn', title: 'PLAYING OFFLINE', sub: 'The server is unreachable — Phone a Friend is off' }, 2800);
      throw new OfflineError();
    }
  }

  const friendly = (e: unknown) => {
    const m = (e as Error)?.message ?? '';
    return /internal server error|failed to fetch|network|5\d\d/i.test(m) || !m
      ? 'Couldn’t reach the server. Try again, or skip and fight alone.'
      : m;
  };

  async function save() {
    setErr(null);
    if (!validPhone) { setErr('Enter a full phone number, e.g. 555 123 4567.'); return; }
    if (!consent) { setErr('Your friend must agree to receive a FaceTime call first.'); return; }
    setBusy(true);
    try {
      await savePlayerOnly();
      const p = useApp.getState().player!;
      const f = await runtime.net!.api.addFriend({ playerId: p.id, name: fname.trim() || 'Telemachus', phoneE164: e164, consent: true });
      useApp.setState({ friend: f });
      setMockFriendName(f.name);
      setLocal('');
      persistPlayer();
      go('calibration');
    } catch (e) {
      setErr(e instanceof OfflineError ? 'Couldn’t reach the server. Try again, or skip and fight alone.' : friendly(e));
    } finally {
      setBusy(false);
    }
  }

  async function skip() {
    setBusy(true);
    try { await savePlayerOnly(); } catch (e) { if (!(e instanceof OfflineError)) { setErr(friendly(e)); setBusy(false); return; } }
    persistPlayer(); setBusy(false); go('calibration');
  }

  return (
    <div className="screen dim" ref={ref}>
      <div className="topbar">
        <Btn variant="link" onClick={() => go('title')}>← Back</Btn>
        <div className="eyebrow">One-time setup</div>
      </div>
      <div style={{ width: 'min(1040px, 100%)', margin: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        <section className="panel col">
          <div className="panel-title"><span className="eyebrow">I</span><h2 className="h2">Who returns?</h2></div>
          <div className="field">
            <label htmlFor="pname">Your name (for the leaderboard)</label>
            <input id="pname" className="input" data-autofocus autoFocus value={name} maxLength={24} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <p className="lore" style={{ margin: 0 }}>
            Twenty years from home. The hall is full of wooers. Your son is in the storeroom — and he has a phone.
          </p>
        </section>

        <section className="panel col">
          <div className="panel-title"><span className="eyebrow">II</span><h2 className="h2">Add your Telemachus</h2></div>
          <p className="muted small" style={{ margin: 0 }}>
            Mid-fight, the game places a real FaceTime call to this friend. They hold up household objects; we forge them into weapons.
          </p>
          {friend && (
            <div className="chip ok" style={{ alignSelf: 'flex-start' }}>
              <span className="dot" />{friend.name} · {friend.phoneMasked}
            </div>
          )}
          <div className="field">
            <label htmlFor="fname">Friend’s name</label>
            <input id="fname" className="input" value={fname} maxLength={24} onChange={(e) => setFname(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="phone">Their iPhone number</label>
            <div className="row" style={{ gap: 8 }}>
              <select className="select" aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)} style={{ width: 132 }}>
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.code} {c.dial}</option>)}
              </select>
              <input id="phone" className="input" style={{ flex: 1 }} inputMode="tel" autoComplete="off" placeholder="555 123 4567"
                value={local} onChange={(e) => setLocal(e.target.value)} />
            </div>
            <span className="muted small">
              {e164 ? <>Will be stored as <span className="num">{e164.slice(0, 2)}•••••{e164.slice(-4)}</span> — the full number is never shown again.</> : 'Stored with consent, shown masked, purged after the event.'}
            </span>
          </div>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>My friend agreed to receive a FaceTime call from this game.</span>
          </label>
          {err && <div className="error" role="alert">{err}</div>}
          {!err && (local || consent) && (!validPhone || !consent) && (
            <div className="muted small">{!validPhone ? 'Enter their full number to continue.' : 'Tick the consent box to continue.'}</div>
          )}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Btn variant="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save & continue'}</Btn>
            {friend
              ? <Btn onClick={skip} disabled={busy}>Keep {friend.name}</Btn>
              : <Btn variant="link" onClick={skip}>Skip — fight alone</Btn>}
          </div>
        </section>
      </div>
      <Meander style={{ maxWidth: 1040, margin: '18px auto 0' }} />
    </div>
  );
}
