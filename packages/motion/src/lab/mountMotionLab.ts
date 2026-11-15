// Motion Lab (spec C.7): webcam + skeleton overlay, stats, live state readout, event log.
// Framework-free so it runs in the standalone dev page and inside A's React app (see MotionLab.tsx).
import { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { InputController, InputEvent } from '@ithaca/shared';
import { createMotionController, type MotionDebug } from '../controller';
import type { RawLandmark } from '../types';
import { buildSliders, drawGameSpace } from './panels';
import { LAB_CSS } from './styles';

export interface MotionLabOptions {
  modelBaseUrl?: string;
}

type LabController = InputController & Partial<MotionDebug>;

const POSE_EDGES = PoseLandmarker.POSE_CONNECTIONS;
const HAND_EDGES = HandLandmarker.HAND_CONNECTIONS;
const COLOR = { pose: '#e8e2d0', left: '#4cc9f0', right: '#f8961e', joint: '#ffffff' };

export function mountMotionLab(root: HTMLElement, opts: MotionLabOptions = {}): () => void {
  root.classList.add('ithaca-lab');
  root.innerHTML = `
    <style>${LAB_CSS}</style>
    <header>
      <h1>Motion Lab</h1>
      <span class="badge" data-k="delegate">–</span>
      <span class="badge" data-k="fps">– fps</span>
      <span class="badge" data-k="ms">– ms</span>
      <span class="badge" data-k="res">–</span>
      <span class="badge" data-k="tracking">off</span>
      <span class="badge" data-k="vis">vis –</span>
    </header>
    <div class="toolbar">
      <button data-a="start" class="primary">Start camera</button>
      <button data-a="stop" disabled>Stop</button>
      <label>Pose model
        <select data-a="model"><option value="full">full</option><option value="lite">lite</option></select>
      </label>
      <span class="error" data-k="error"></span>
    </div>
    <main>
      <section class="stage-wrap">
        <div class="stage">
          <video playsinline muted></video>
          <canvas class="overlay"></canvas>
        </div>
        <div class="placeholder">Camera off. Press <b>Start camera</b>.</div>
      </section>
      <aside>
        <h2>Game space</h2>
        <canvas class="space"></canvas>
        <h2>PlayerInputState</h2>
        <pre data-k="state"></pre>
        <h2>Events <button data-a="clear" class="small">clear</button></h2>
        <ol class="log" data-k="log"></ol>
      </aside>
    </main>
    <div class="below">
      <section><h2>Thresholds <small>(double-click a slider to reset it)</small></h2><div class="sliders"></div></section>
    </div>`;

  const q = <T extends Element>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`Motion Lab: missing ${sel}`);
    return el;
  };
  const video = q<HTMLVideoElement>('video');
  const overlay = q<HTMLCanvasElement>('canvas.overlay');
  const ctx2d = overlay.getContext('2d');
  const badge = (k: string) => q<HTMLElement>(`[data-k="${k}"]`);
  const btnStart = q<HTMLButtonElement>('[data-a="start"]');
  const btnStop = q<HTMLButtonElement>('[data-a="stop"]');
  const modelSel = q<HTMLSelectElement>('[data-a="model"]');
  const placeholder = q<HTMLElement>('.placeholder');
  const stateEl = badge('state');
  const logEl = badge('log');
  const errorEl = badge('error');
  const spaceCv = q<HTMLCanvasElement>('canvas.space');
  buildSliders(q<HTMLElement>('.sliders'));

  let controller: LabController | null = null;
  let unsub: (() => void) | null = null;
  let raf = 0;
  let lastReadout = 0;
  const t0 = performance.now();

  function logEvent(e: InputEvent): void {
    const li = document.createElement('li');
    const { type, ...rest } = e;
    const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest, round2) : '';
    li.innerHTML = `<time>${((performance.now() - t0) / 1000).toFixed(1)}s</time> <b>${type}</b>${escapeHtml(extra)}`;
    logEl.prepend(li);
    while (logEl.childElementCount > 80) logEl.lastElementChild?.remove();
  }

  async function start(): Promise<void> {
    stop();
    errorEl.textContent = '';
    btnStart.disabled = true;
    btnStart.textContent = 'Loading models…';
    const c = createMotionController({
      modelBaseUrl: opts.modelBaseUrl ?? '/models',
      poseModel: modelSel.value === 'lite' ? 'lite' : 'full',
      video,
    });
    controller = c;
    unsub = c.on(logEvent);
    try {
      await c.start();
      placeholder.hidden = true;
      btnStop.disabled = false;
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      stop();
    } finally {
      btnStart.disabled = false;
      btnStart.textContent = 'Restart camera';
    }
  }

  function stop(): void {
    unsub?.();
    unsub = null;
    controller?.stop();
    controller = null;
    placeholder.hidden = false;
    btnStop.disabled = true;
  }

  function drawOverlay(): void {
    if (!ctx2d) return;
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    ctx2d.clearRect(0, 0, w, h);
    const frame = controller?.getDebugFrame?.();
    if (!frame) return;
    const lw = Math.max(2, w / 400);
    if (frame.poseImage) {
      drawSkeleton(ctx2d, frame.poseImage, POSE_EDGES, w, h, COLOR.pose, lw, 0.5);
    }
    const hands = controller?.getDebugHands?.() ?? frame.hands ?? [];
    for (const hand of hands) {
      // Raw label is mirrored: MediaPipe "Left" on an un-mirrored image is the player's right.
      const color = hand.label === 'Left' ? COLOR.right : COLOR.left;
      drawSkeleton(ctx2d, hand.image, HAND_EDGES, w, h, color, lw, 0);
    }
  }

  function updateBadges(): void {
    const s = controller?.getStats?.();
    const st = controller?.getState();
    badge('delegate').textContent = s ? s.delegate : '–';
    badge('delegate').dataset.level = s?.delegate === 'GPU' ? 'ok' : s?.delegate === 'CPU' ? 'warn' : '';
    badge('fps').textContent = s ? `${s.fps.toFixed(0)} fps` : '– fps';
    badge('fps').dataset.level = !s || !s.fps ? '' : s.fps >= 40 ? 'ok' : s.fps >= 30 ? 'warn' : 'bad';
    badge('ms').textContent = s ? `${s.msPerFrame.toFixed(1)} ms` : '– ms';
    badge('ms').dataset.level = !s || !s.msPerFrame ? '' : s.msPerFrame <= 6 ? 'ok' : s.msPerFrame <= 12 ? 'warn' : 'bad';
    badge('res').textContent = s?.width ? `${s.width}×${s.height}${s.handsEveryOtherFrame ? ' · hands ½' : ''}` : '–';
    const tracking = st?.tracking ?? 'off';
    badge('tracking').textContent = tracking;
    badge('tracking').dataset.level = tracking === 'ok' ? 'ok' : tracking === 'off' ? '' : tracking === 'lost' ? 'bad' : 'warn';
    const frame = controller?.getDebugFrame?.();
    const vis = frame?.poseImage ? avgVisibility(frame.poseImage) : null;
    badge('vis').textContent = vis === null ? 'vis –' : `vis ${vis.toFixed(2)}`;
    if (s?.error && !errorEl.textContent) errorEl.textContent = s.error;
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    drawOverlay();
    drawGameSpace(spaceCv, controller?.getState() ?? null, controller?.getDebugBody?.() ?? null);
    if (now - lastReadout > 100) {
      lastReadout = now;
      updateBadges();
      const st = controller?.getState();
      stateEl.textContent = st ? JSON.stringify(st, round2, 1) : '';
    }
  }

  btnStart.addEventListener('click', () => void start());
  btnStop.addEventListener('click', stop);
  q<HTMLButtonElement>('[data-a="clear"]').addEventListener('click', () => {
    logEl.innerHTML = '';
  });
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    stop();
    root.innerHTML = '';
    root.classList.remove('ithaca-lab');
  };
}

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  lm: RawLandmark[],
  edges: { start: number; end: number }[],
  w: number,
  h: number,
  color: string,
  lineWidth: number,
  minVis: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const { start, end } of edges) {
    const a = lm[start];
    const b = lm[end];
    if (!a || !b || (a.visibility ?? 1) < minVis || (b.visibility ?? 1) < minVis) continue;
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  for (const p of lm) {
    if ((p.visibility ?? 1) < minVis) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, lineWidth * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function avgVisibility(lm: RawLandmark[]): number {
  let s = 0;
  for (const i of [0, 11, 12, 13, 14, 15, 16]) s += lm[i]?.visibility ?? 0;
  return s / 7;
}

export function round2(_k: string, v: unknown): unknown {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : v;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
