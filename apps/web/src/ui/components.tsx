import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import type { TrickshotKind, WeaponClass } from '@ithaca/shared';
import { audio } from '../game/engine/audio';
import { CLASS_ICON_PATHS } from '../net/mockCatalog';
import type { InputKind } from '../input';

/** Webcam body tracking — live ('motion') or a recorded session driving the same path ('replay'). */
export const isBodyInput = (k: InputKind) => k === 'motion' || k === 'replay';

/** Greek-key (meander) divider. Structural ornament — use sparingly. */
export function Meander({ style }: { style?: CSSProperties }) {
  return <div className="meander" style={style} aria-hidden />;
}

/** Boar's-tusk helmet (Iliad X) in black-figure silhouette — our emblem (not the film's helmet). */
export function HelmetEmblem({ size = 64 }: { size?: number }) {
  return (
    <svg className="emblem" width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="31" fill="#B5562E" />
      <circle cx="32" cy="32" r="28" fill="none" stroke="#16110D" strokeWidth="1.5" />
      <path d="M18 44 Q16 22 32 13 Q48 22 46 44 L42 44 L42 50 L37 50 L37 44 L27 44 L27 50 L22 50 L22 44 Z" fill="#16110D" />
      {[20, 26, 32, 38].map((y) => (
        <path key={y} d={`M${19 + (y - 20) * -0.05} ${y} Q32 ${y - 4} ${45 + (y - 20) * 0.05} ${y}`} stroke="#B5562E" strokeWidth="1.6" fill="none" strokeDasharray="3 2" />
      ))}
      <path d="M30 13 Q32 6 34 13" fill="#16110D" />
    </svg>
  );
}

/** Webcam framing guide: corner brackets + a dashed figure from head to hips — where your body should sit in the
 *  camera's view (head near the top, hips above the bottom edge, hands free at the sides). 16:9 like the Mac camera. */
export function FrameGuide({ className = '', labels = true }: { className?: string; labels?: boolean }) {
  const c = (x: number, y: number, dx: number, dy: number) => `M${x} ${y + dy * 12} V${y} H${x + dx * 12}`;
  return (
    <svg className={`frame-guide ${className}`} viewBox="0 0 160 90" preserveAspectRatio="xMidYMid meet" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="fg-corners">
        <path d={c(6, 5, 1, 1)} /><path d={c(154, 5, -1, 1)} /><path d={c(6, 85, 1, -1)} /><path d={c(154, 85, -1, -1)} />
      </g>
      <g fill="none" stroke="currentColor" strokeWidth="1.1" strokeDasharray="2.4 2" strokeLinejoin="round" className="fg-figure">
        <circle cx="80" cy="19" r="7" />
        <path d="M74 27.5 Q80 30 86 27.5 M62 35 Q80 28 98 35 L95 66 H65 Z M62 35 L55 58 M98 35 L105 58 M68 66 L66 88 M92 66 L94 88" />
      </g>
      <path d="M48 66 H112" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1 2.4" className="fg-hips" />
      {labels && (
        <g className="fg-labels" fill="currentColor" fontSize="3.6" fontWeight="700" letterSpacing="0.5">
          <text x="114" y="67.3">HIPS</text>
          <text x="90" y="14.5">HEAD</text>
        </g>
      )}
    </svg>
  );
}

/** The three things that make webcam tracking work — shown before calibration and whenever we lose the player. */
export function StanceChecklist({ compact = false }: { compact?: boolean }) {
  const items: [ReactNode, ReactNode, ReactNode][] = [
    [
      <path key="d" d="M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4" />,
      'About 2 m back', 'head to hips in the frame',
    ],
    [
      <g key="l"><circle cx="12" cy="12" r="4" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></g>,
      'Light in front', 'a lamp or window facing you, not behind',
    ],
    [
      <path key="h" d="M7 13V6.5a1.5 1.5 0 0 1 3 0V12M10 11V4.5a1.5 1.5 0 0 1 3 0V11M13 11V5.5a1.5 1.5 0 0 1 3 0V12M16 12V8a1.5 1.5 0 0 1 3 0v6.5c0 4-2.8 6.5-6.5 6.5-2.6 0-4.2-1.2-5.6-3.3L4.5 14a1.5 1.5 0 0 1 2.4-1.7L7 13" />,
      'Hands in view', 'palms toward the camera',
    ],
  ];
  return (
    <ul className={`stance ${compact ? 'compact' : ''}`}>
      {items.map(([icon, k, v], i) => (
        <li key={i}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{icon}</svg>
          <span><b>{k}</b>{compact ? null : <> — {v}</>}</span>
        </li>
      ))}
    </ul>
  );
}

export function ClassIcon({ cls, size = 22 }: { cls: WeaponClass; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <circle cx="100" cy="100" r="98" fill="#B5562E" />
      <path d={CLASS_ICON_PATHS[cls]} fill="#16110D" transform="translate(20 20) scale(0.8)" />
    </svg>
  );
}

const TRICK_GLYPH: Record<TrickshotKind, string> = {
  pin: 'M30 30 L170 170 M150 150 L178 178 M40 100 L100 40',
  ricochet: 'M20 160 L100 40 L180 160',
  multi_kill: 'M30 150 L170 50 M30 60 L60 60 M30 100 L80 100',
  airborne: 'M40 160 Q100 0 160 160',
  long_shot: 'M20 100 L180 100 M150 80 L180 100 L150 120',
  headshot: 'M100 30 a40 40 0 1 1 -0.1 0 M100 130 L100 180',
  friend_assist: 'M60 70 a20 20 0 1 1 -0.1 0 M140 70 a20 20 0 1 1 -0.1 0 M40 160 Q100 110 160 160',
  return_to_sender: 'M170 60 L40 60 L70 30 M30 140 L160 140 L130 170',
};

export function TrickIcon({ kind, size = 28 }: { kind: TrickshotKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <circle cx="100" cy="100" r="98" fill="#B5562E" />
      <path d={TRICK_GLYPH[kind]} fill="none" stroke="#16110D" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Btn(props: {
  children: ReactNode; onClick?: () => void; variant?: 'primary' | 'ghost' | 'call' | 'danger' | 'link'; big?: boolean;
  autoFocus?: boolean; disabled?: boolean; hotkey?: string; title?: string; type?: 'button' | 'submit';
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (props.autoFocus) { ref.current?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: 'nearest' }); } }, [props.autoFocus]);
  const cls = ['btn', props.variant && props.variant !== 'ghost' ? props.variant : '', props.big ? 'big' : ''].join(' ');
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      className={cls}
      disabled={props.disabled}
      title={props.title}
      data-autofocus={props.autoFocus ? '' : undefined}
      onFocus={() => audio.ui('move')}
      onClick={() => { audio.unlock(); audio.ui('select'); props.onClick?.(); }}
    >
      {props.children}
      {props.hotkey && <span className="kbd">{props.hotkey}</span>}
    </button>
  );
}

/** Arrow-key navigation across focusables inside a container (linear, wraps). */
export function useMenuNav<T extends HTMLElement>(onBack?: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sel = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const typing = active && (active.tagName === 'INPUT' && (active as HTMLInputElement).type !== 'checkbox' || active.tagName === 'SELECT');
      if (e.key === 'Escape' && onBack) { e.preventDefault(); audio.ui('back'); onBack(); return; }
      if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      if (active?.tagName === 'SELECT') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(sel)).filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      e.preventDefault();
      const i = active ? items.indexOf(active) : -1;
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      const next = items[(i + dir + items.length) % items.length];
      next.focus();
    };
    window.addEventListener('keydown', onKey);
    // initial focus
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>(sel);
    if (first && !el.contains(document.activeElement)) { first.focus({ preventScroll: true }); first.scrollIntoView({ block: 'nearest' }); }
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);
  return ref;
}

export function fmtTime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
