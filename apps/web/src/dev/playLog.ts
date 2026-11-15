// Dev-only play log: what happens while someone plays, posted once a second to the Vite dev server
// (POST /__playlog → apps/web/playlog.log, git-ignored). Errors, frame rate, tracker fps, input events,
// calibration steps, combat outcomes, health. No video, no landmarks, nothing leaves the machine.
import { useApp } from '../state/store';
import { runtime } from '../game/runtime';
import type { CalibrationStepInfo } from '../input';

type Line = Record<string, unknown>;
const buf: Line[] = [];
const push = (kind: string, f: Line = {}) => {
  buf.push({ t: Math.round(performance.now()), kind, ...f });
  if (buf.length > 500) buf.shift();
};
const text = (x: unknown): string => {
  if (x instanceof Error) return x.message;
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
};

let started = false;

export function startPlayLog() {
  if (started) return;
  started = true;
  window.addEventListener('error', (e) => push('error', { msg: String(e.message).slice(0, 300), at: `${e.filename?.split('/').pop() ?? ''}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => push('error', { msg: `unhandled: ${text((e.reason as Error)?.message ?? e.reason)}`.slice(0, 300) }));
  for (const lvl of ['error', 'warn'] as const) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a: unknown[]) => { push(lvl, { msg: a.map(text).join(' ').slice(0, 300) }); orig(...a); };
  }
  // enemies.ts writes combat outcomes here when the array exists
  const w = window as unknown as { __combatLog?: Line[]; __engine?: { weapons: { heldBy(h: 'left' | 'right'): { name?: string } | null; quiver: number }; takeStats?: { event: number; level: number; auto: number } } };
  w.__combatLog = [];

  let frames = 0, worst = 0, last = performance.now();
  // per-frame hand diagnostics (webcam), summarised once a second: how often each hand is visible / freshly seen
  // by the hand model, its peak grip, how often Part C's grip latch is closed, pose wrist visibility, hand size in px
  const H = () => ({ n: 0, vis: 0, fresh: 0, maxGrip: 0, latched: 0, wristVis: [] as number[], px: [] as number[] });
  let hd = { left: H(), right: H() };
  const sampleHands = () => {
    const c = runtime.input as (typeof runtime.input & {
      getDebugBody?: () => { handFresh: Record<'left' | 'right', boolean>; wristVis: Record<'left' | 'right', number> } | null;
      getDebugGestures?: () => { gripL: boolean; gripR: boolean };
      getDebugHands?: () => { image: { x: number; y: number }[]; label: 'Left' | 'Right'; side?: 'left' | 'right' }[];
      getStats?: () => { width: number; height: number };
    }) | null;
    if (!c || c.kind === 'keyboard_mouse') return;
    const st = c.getState();
    const body = c.getDebugBody?.() ?? null;
    const fl = c.getDebugGestures?.();
    for (const side of ['left', 'right'] as const) {
      const a = hd[side], hs = st.hands[side];
      a.n++;
      if (hs.visible) { a.vis++; a.maxGrip = Math.max(a.maxGrip, hs.grip); }
      if (body?.handFresh[side]) a.fresh++;
      if (fl && (side === 'left' ? fl.gripL : fl.gripR)) a.latched++;
      if (body) a.wristVis.push(body.wristVis[side]);
    }
    // hand bounding box (px, longest side) per detection; side from the ROI tracker when it says, else the label
    // (MediaPipe's label matches the anatomical side on raw webcam frames)
    const hands = c.getDebugHands?.() ?? [];
    const dims = c.getStats?.();
    if (dims?.width && body) for (const h of hands) {
      if (!body.handFresh[h.side ?? (h.label === 'Left' ? 'left' : 'right')]) continue;
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
      for (const p of h.image) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      hd[h.side ?? (h.label === 'Left' ? 'left' : 'right')].px.push(Math.max((x1 - x0) * dims.width, (y1 - y0) * dims.height));
    }
  };
  const p50 = (a: number[]) => { if (!a.length) return undefined; const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(2); };
  const pct = (k: number, n: number) => (n ? Math.round((100 * k) / n) : 0);
  const raf = () => {
    const n = performance.now(); worst = Math.max(worst, n - last); last = n; frames++;
    try { sampleHands(); } catch { /* diagnostics never break the game */ }
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  let lastTakes = { event: 0, level: 0, auto: 0 };

  let subbed: unknown = null;
  let unsubs: (() => void)[] = [];
  const counts: Record<string, number> = {};
  let lastCalib = '', lastPending = '', lastScreen = '', lastHp = 100;

  setInterval(() => {
    const c = runtime.input as (typeof runtime.input & {
      getStats?: () => { fps: number; msPerFrame: number; delegate: string; error: string | null };
      getPendingGesture?: () => { name: string; progress: number } | null;
      onCalibrationStep?: (cb: (s: CalibrationStepInfo) => void) => () => void;
    }) | null;
    if (c !== subbed) {
      unsubs.forEach((u) => u());
      unsubs = [];
      subbed = c;
      if (c) {
        unsubs.push(c.on((e) => {
          counts[e.type] = (counts[e.type] ?? 0) + 1;
          if (e.type !== 'swing' && e.type !== 'grab' && e.type !== 'release') push('input', { e: e.type, hand: (e as { hand?: string }).hand });
        }));
        const off = c.onCalibrationStep?.((s) => {
          const key = `${s.step}|${s.failedReason ?? ''}`;
          if (key !== lastCalib) { lastCalib = key; push('calib', { step: s.step, index: s.index, hint: s.hint, failed: s.failedReason }); }
        });
        if (off) unsubs.push(off);
      }
      push('input_kind', { input: c?.kind ?? null }); // (not `kind`: that would overwrite the record's own kind)
    }
    const s = useApp.getState();
    if (s.screen !== lastScreen) { push('screen', { screen: s.screen, from: lastScreen }); lastScreen = s.screen; }
    const hp = Math.round(s.hud.health);
    if (s.screen === 'game' && hp < lastHp) push('hurt', { hp, lost: lastHp - hp });
    lastHp = hp;
    const pend = c?.getPendingGesture?.()?.name ?? '';
    if (pend !== lastPending) { if (pend) push('gesture_hold', { name: pend }); lastPending = pend; }
    const cl = w.__combatLog ?? [];
    for (const x of cl.splice(0, cl.length)) if (x.kind !== 'hit') push('combat', x);
    const stats = c?.getStats?.() as (ReturnType<NonNullable<NonNullable<typeof c>['getStats']>> & {
      msPose?: number; msHands?: number; roiRetries?: number; handHitRate?: Partial<Record<'left' | 'right', number>>;
      roiRetrySkips?: number; cameraFps?: number; brightness?: number; hint?: string | null; handsAlternate?: boolean; handRoi?: boolean;
    }) | undefined;
    const E = w.__engine;
    // webcam hand summary: [visible %, handFresh %, max grip, latched %] per side
    let hands: Record<string, unknown> | undefined;
    if (hd.left.n) {
      const row = (a: ReturnType<typeof H>) => [pct(a.vis, a.n), pct(a.fresh, a.n), +a.maxGrip.toFixed(2), pct(a.latched, a.n)];
      hands = {
        L: row(hd.left), R: row(hd.right),
        wv: [p50(hd.left.wristVis), p50(hd.right.wristVis)],
        px: [p50(hd.left.px) !== undefined ? Math.round(p50(hd.left.px)!) : null, p50(hd.right.px) !== undefined ? Math.round(p50(hd.right.px)!) : null],
      };
    }
    hd = { left: H(), right: H() };
    const tk = E?.takeStats;
    const takes = tk ? { event: tk.event - lastTakes.event, level: tk.level - lastTakes.level, auto: tk.auto - lastTakes.auto } : undefined;
    if (tk) lastTakes = { ...tk };
    push('tick', {
      screen: s.screen, fps: frames, worstMs: Math.round(worst), input: c?.kind,
      mfps: stats ? Math.round(stats.fps) : undefined, mms: stats ? Math.round(stats.msPerFrame) : undefined,
      delegate: stats?.delegate, trackErr: stats?.error ?? undefined,
      msPose: stats?.msPose !== undefined ? +stats.msPose.toFixed(1) : undefined, msHands: stats?.msHands !== undefined ? +stats.msHands.toFixed(1) : undefined,
      roiRetries: stats?.roiRetries, roiSkips: stats?.roiRetrySkips || undefined, hitRate: stats?.handHitRate, hands,
      alt: stats?.handsAlternate || undefined, roi: stats?.handRoi,
      // camera as delivered (dim light drops it), image brightness 0..1, Part C's player hint ('lighting')
      cam: stats?.cameraFps ? Math.round(stats.cameraFps) : undefined,
      lum: stats?.brightness !== undefined ? +stats.brightness.toFixed(2) : undefined, hint: stats?.hint ?? undefined,
      takes: takes && (takes.event || takes.level || takes.auto) ? takes : undefined,
      hp, wave: s.hud.wave, kills: s.hud.kills, left: s.hud.enemiesLeft, posture: Math.round(s.hud.posture ?? 0),
      held: E ? [E.weapons.heldBy('left')?.name ?? null, E.weapons.heldBy('right')?.name ?? null] : undefined,
      ev: { ...counts }, toasts: s.toasts.map((t) => t.title).slice(-3), call: s.call.state,
    });
    for (const k of Object.keys(counts)) delete counts[k];
    frames = 0; worst = 0;
    const body = JSON.stringify(buf.splice(0));
    void fetch('/__playlog', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
  }, 1000);
}
