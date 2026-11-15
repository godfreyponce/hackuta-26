import { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import type { TrickshotKind, WeaponClass } from '@ithaca/shared';
import { audio } from '../game/engine/audio';
import { CLASS_ICON_PATHS } from '../net/mockCatalog';

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
