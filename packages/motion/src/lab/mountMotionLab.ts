// Motion Lab (spec C.7): webcam + skeleton overlay, stats, live state readout, event log.
// Framework-free so it runs in the standalone dev page and inside A's React app (see MotionLab.tsx).
import { HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { CalibrationResult, InputController, InputEvent } from '@ithaca/shared';
import { createMotionController, type MotionDebug } from '../controller';
import { clearSavedProfile } from '../profile';
import { downloadRecording, parseRecording } from '../recording';
import { createReplayController } from '../replay';
import type { CalibrationStep, PendingGesture, RawLandmark, Recording } from '../types';
import type { Profile } from '../profile';
import { GestureGuide, type GuideView } from './guide';
import { buildSliders, drawGameSpace } from './panels';
import { LAB_CSS } from './styles';

export interface MotionLabOptions {
  modelBaseUrl?: string;
}

type LabController = InputController &
  Partial<MotionDebug> & {
    getPendingGesture?(): PendingGesture | null;
    onCalibrationStep?(cb: (s: CalibrationStep) => void): () => void;
    getProfile?(): Readonly<Profile>;
    resetCalibration?(): void;
    calibrate?(): Promise<CalibrationResult>;
    startRecording?(label?: string): void;
    stopRecording?(): Recording | null;
    getRecordingInfo?(): { recording: boolean; frames: number; durationMs: number };
    getProgress?(): number;
  };

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
      <span class="badge" data-k="calibrated">uncalibrated</span>
    </header>
    <div class="toolbar">
      <button data-a="start" class="primary">Start camera</button>
      <button data-a="stop" disabled>Stop</button>
      <button data-a="calibrate" disabled>Calibrate</button>
      <button data-a="uncalibrate">Reset calibration</button>
      <button data-a="guide" disabled>Test gestures</button>
      <span class="sep"></span>
      <input data-a="label" placeholder="label (throw, bow…)" size="14">
      <button data-a="record" disabled>● Record</button>
      <label class="file">Load replay <input data-a="load" type="file" accept="application/json,.json"></label>
      <span class="badge" data-k="replay" hidden></span>
      <span class="sep"></span>
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
        <div class="ring" hidden><span></span></div>
        <div class="calib" hidden>
          <div class="calib-head" data-k="calibHead"></div>
          <ol class="calib-steps" data-k="calibSteps"></ol>
          <div class="calib-msg" data-k="calibMsg"></div>
          <div class="calib-hint" data-k="calibHint"></div>
          <progress max="1" value="0"></progress>
          <div class="calib-actions" hidden><button data-a="calibRetry" class="primary">Try again</button> <button data-a="calibClose">Close</button></div>
        </div>
        <div class="coach" hidden>
          <div class="coach-head"><span data-k="coachTitle"></span><span data-k="coachStage"></span></div>
          <div class="coach-say" data-k="coachSay"></div>
          <div class="coach-hint" data-k="coachHint"></div>
          <div class="coach-timer"><i data-k="coachTimer"></i></div>
          <div class="coach-actions">
            <button data-a="guideRetry" hidden>Retry</button>
            <button data-a="guideNext" hidden>Next ▶</button>
            <button data-a="guideSkip">Skip</button>
            <button data-a="guideStop">Stop test</button>
          </div>
        </div>
        <div class="placeholder">Camera off. Press <b>Start camera</b>.</div>
      </section>
      <aside>
        <h2>Game space</h2>
        <canvas class="space"></canvas>
        <h2>Detectors</h2>
        <div class="chips" data-k="flags"></div>
        <h2>PlayerInputState</h2>
        <pre data-k="state"></pre>
        <h2>Events <button data-a="clear" class="small">clear</button></h2>
        <ol class="log" data-k="log"></ol>
      </aside>
    </main>
    <div class="below">
      <section class="guide-panel"><h2>Gesture test <span data-k="guideScore"></span></h2>
        <p class="muted">Press <b>Test gestures</b>. Each move is asked for one at a time and marked PASS or FAIL. Click a row to redo just that move.</p>
        <ol class="checklist" data-k="checklist"></ol></section>
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
  const ring = q<HTMLElement>('.ring');
  const flagsEl = badge('flags');
  const btnCal = q<HTMLButtonElement>('[data-a="calibrate"]');
  const calibBox = q<HTMLElement>('.calib');
  const calibMsg = badge('calibMsg');
  const calibBar = q<HTMLProgressElement>('.calib progress');
  let calibUnsub: (() => void) | null = null;
  const calibHead = badge('calibHead');
  const calibSteps = badge('calibSteps');
  const calibHint = badge('calibHint');
  const calibActions = q<HTMLElement>('.calib-actions');
  const coach = q<HTMLElement>('.coach');
  const btnGuide = q<HTMLButtonElement>('[data-a="guide"]');
  const checklist = badge('checklist');
  let guide: GestureGuide | null = null;
  const btnRec = q<HTMLButtonElement>('[data-a="record"]');
  const labelIn = q<HTMLInputElement>('[data-a="label"]');
  const loadIn = q<HTMLInputElement>('[data-a="load"]');
  const replayBadge = badge('replay');

  function toggleRecording(): void {
    const c = controller;
    if (!c?.startRecording || !c.stopRecording) return;
    if (c.getRecordingInfo?.().recording) {
      const rec = c.stopRecording();
      btnRec.classList.remove('on');
      btnRec.textContent = '● Record';
      if (rec && rec.frames.length) {
        downloadRecording(rec, labelIn.value.trim() || undefined);
        logLine('recorded', `${rec.frames.length} frames, ${(rec.frames[rec.frames.length - 1]?.t ?? 0) / 1000}s → downloaded`);
      }
    } else {
      c.startRecording(labelIn.value.trim() || undefined);
      btnRec.classList.add('on');
    }
  }

  async function loadReplay(file: File): Promise<void> {
    let rec: Recording;
    try {
      rec = parseRecording(await file.text());
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    stop();
    errorEl.textContent = '';
    const c = createReplayController(rec, { loop: true });
    controller = c;
    unsub = c.on(logEvent);
    await c.start();
    placeholder.hidden = true;
    video.hidden = true;
    btnStop.disabled = false;
    btnCal.disabled = false;
    btnGuide.disabled = false;
    replayBadge.hidden = false;
    logLine('replay', `${file.name}: ${rec.frames.length} frames${rec.meta.label ? ' · ' + rec.meta.label : ''}`);
  }

  async function runCalibration(): Promise<void> {
    const c = controller;
    if (!c?.calibrate) return;
    btnCal.disabled = true;
    calibBox.hidden = false;
    calibUnsub?.();
    guide?.stop();
    calibBox.dataset.result = '';
    calibActions.hidden = true;
    calibUnsub = c.onCalibrationStep?.(renderCalibStep) ?? null;
    const t0c = performance.now();
    const res = await c.calibrate();
    const secs = ((performance.now() - t0c) / 1000).toFixed(1);
    logLine('calibration', res.ok ? `PASSED in ${secs}s · arm ${res.armLengthM.toFixed(2)} m · shoulders ${res.shoulderWidthM.toFixed(2)} m` : `FAILED after ${secs}s`);
    calibUnsub?.();
    calibUnsub = null;
    calibActions.hidden = false;
    if (res.ok) setTimeout(() => { if (calibBox.dataset.result === 'pass') calibBox.hidden = true; }, 5000);
    btnCal.disabled = !controller;
  }

  const CALIB_ORDER = ['step_back', 'guard', 'bow', 'grip'] as const;
  const CALIB_LABEL: Record<(typeof CALIB_ORDER)[number], string> = {
    step_back: 'Hips in view',
    guard: 'Guard',
    bow: 'Arm out',
    grip: 'Fist / open',
  };
  function renderCalibStep(s: CalibrationStep): void {
    const failed = s.step === 'failed';
    const done = s.step === 'done';
    calibBox.dataset.result = done ? 'pass' : failed ? 'fail' : '';
    calibHead.textContent = done
      ? 'Calibration PASSED ✓'
      : failed
        ? `Calibration FAILED ✗ at "${CALIB_LABEL[s.failedStep as (typeof CALIB_ORDER)[number]] ?? s.failedStep}"`
        : `Calibration · step ${s.index} of ${s.total}`;
    calibSteps.innerHTML = CALIB_ORDER.map((k) => {
      const st = s.passed.includes(k) ? 'pass' : failed && s.failedStep === k ? 'fail' : s.step === k ? 'active' : 'pending';
      const icon = { pass: '✓', fail: '✗', active: '▶', pending: '○' }[st];
      return `<li class="${st}">${icon} ${CALIB_LABEL[k]}</li>`;
    }).join('');
    calibMsg.textContent = done ? 'All 4 steps passed.' : failed ? (s.failedReason ?? '') : s.message;
    calibHint.textContent = done ? s.hint : failed ? 'Fix that and press Try again.' : s.hint;
    calibBar.value = done ? 1 : s.progress;
  }
  buildSliders(q<HTMLElement>('.sliders'));

  let controller: LabController | null = null;
  let unsub: (() => void) | null = null;
  let raf = 0;
  let lastReadout = 0;
  const t0 = performance.now();

  function logLine(title: string, detail = ''): void {
    const li = document.createElement('li');
    li.innerHTML = `<time>${((performance.now() - t0) / 1000).toFixed(1)}s</time> <b>${escapeHtml(title)}</b> ${escapeHtml(detail)}`;
    logEl.prepend(li);
    while (logEl.childElementCount > 80) logEl.lastElementChild?.remove();
  }

  function logEvent(e: InputEvent): void {
    const { type, ...rest } = e;
    logLine(type, Object.keys(rest).length ? JSON.stringify(rest, round2) : '');
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
    video.hidden = false;
    replayBadge.hidden = true;
    try {
      await c.start();
      placeholder.hidden = true;
      btnStop.disabled = false;
      btnCal.disabled = false;
      btnRec.disabled = false;
      btnGuide.disabled = false;
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
    btnCal.disabled = true;
    btnRec.disabled = true;
    btnGuide.disabled = true;
    guide?.stop();
    guide = null;
    coach.hidden = true;
    btnRec.classList.remove('on');
    btnRec.textContent = '● Record';
    replayBadge.hidden = true;
  }

  function drawOverlay(): void {
    if (!ctx2d) return;
    const st = controller?.getStats?.();
    const w = video.videoWidth || st?.width || 1280;
    const h = video.videoHeight || st?.height || 720;
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
    const ri = controller?.getRecordingInfo?.();
    if (ri?.recording) btnRec.textContent = `■ Stop (${(ri.durationMs / 1000).toFixed(1)}s)`;
    const prog = controller?.getProgress?.();
    if (prog !== undefined) replayBadge.textContent = `replay ${(prog * 100).toFixed(0)}%`;
    const prof = controller?.getProfile?.();
    badge('calibrated').textContent = prof?.calibrated ? `calibrated · arm ${prof.armLengthM.toFixed(2)} m` : 'uncalibrated';
    badge('calibrated').dataset.level = prof?.calibrated ? 'ok' : prof ? 'warn' : '';
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    drawOverlay();
    if (guide) {
      guide.tick(now);
      renderGuide(guide.view());
    }
    const pg = controller?.getPendingGesture?.() ?? null;
    ring.hidden = !pg;
    if (pg) {
      ring.style.setProperty('--p', pg.progress.toFixed(3));
      (ring.firstElementChild as HTMLElement).textContent = pg.name.replace('_', ' ');
    }
    drawGameSpace(spaceCv, controller?.getState() ?? null, controller?.getDebugBody?.() ?? null);
    if (now - lastReadout > 100) {
      lastReadout = now;
      updateBadges();
      const flags = controller?.getDebugGestures?.();
      flagsEl.innerHTML = flags
        ? Object.entries(flags).map(([k, v]) => `<span class="chip${v ? ' on' : ''}">${k}</span>`).join('')
        : '';
      const st = controller?.getState();
      stateEl.textContent = st ? JSON.stringify(st, round2, 1) : '';
    }
  }

  btnStart.addEventListener('click', () => void start());
  btnStop.addEventListener('click', stop);
  btnCal.addEventListener('click', () => void runCalibration());
  btnRec.addEventListener('click', toggleRecording);
  btnGuide.addEventListener('click', () => startGuide(0));
  q<HTMLButtonElement>('[data-a="guideSkip"]').addEventListener('click', () => guide?.skip());
  q<HTMLButtonElement>('[data-a="guideRetry"]').addEventListener('click', () => guide?.retry());
  q<HTMLButtonElement>('[data-a="guideNext"]').addEventListener('click', () => guide?.next());
  q<HTMLButtonElement>('[data-a="guideStop"]').addEventListener('click', () => {
    guide?.stop();
    coach.hidden = true;
  });
  checklist.addEventListener('click', (ev) => {
    const li = (ev.target as HTMLElement).closest<HTMLElement>('li[data-i]');
    if (!li || !controller) return;
    if (!guide) startGuide(-1);
    guide?.runStep(Number(li.dataset.i));
  });
  q<HTMLButtonElement>('[data-a="calibRetry"]').addEventListener('click', () => void runCalibration());
  q<HTMLButtonElement>('[data-a="calibClose"]').addEventListener('click', () => {
    calibBox.hidden = true;
  });
  loadIn.addEventListener('change', () => {
    const f = loadIn.files?.[0];
    if (f) void loadReplay(f);
    loadIn.value = '';
  });
  q<HTMLButtonElement>('[data-a="uncalibrate"]').addEventListener('click', () => {
    if (controller?.resetCalibration) controller.resetCalibration();
    else clearSavedProfile();
  });
  q<HTMLButtonElement>('[data-a="clear"]').addEventListener('click', () => {
    logEl.innerHTML = '';
  });
  function startGuide(from: number): void {
    const c = controller;
    if (!c) return;
    calibBox.hidden = true;
    guide?.stop();
    guide = new GestureGuide(c, (title, ok, detail) => logLine(ok ? 'PASS' : 'FAIL', `${title}: ${detail}`));
    if (from >= 0) guide.start(from);
    renderGuide(guide.view());
  }

  let lastChecklist = '';
  function renderGuide(v: GuideView): void {
    const cur = v.current;
    coach.hidden = !cur;
    if (cur) {
      coach.dataset.flash = cur.flash ?? '';
      badge('coachTitle').textContent = cur.title;
      badge('coachStage').textContent = cur.stages > 1 ? `part ${cur.stage} of ${cur.stages}` : '';
      badge('coachSay').textContent = cur.flash === 'pass' ? 'PASSED ✓' : cur.flash === 'fail' ? 'FAILED ✗' : cur.say;
      badge('coachHint').textContent = cur.hint;
      badge('coachTimer').style.width = `${(cur.remainingMs / cur.totalMs) * 100}%`;
      const failed = guide?.currentStatus === 'fail' && !cur.flash;
      if (failed) {
        badge('coachSay').textContent = 'FAILED ✗';
        badge('coachHint').textContent = v.steps[v.index]?.detail ?? '';
        coach.dataset.flash = 'fail';
      }
      q<HTMLButtonElement>('[data-a="guideRetry"]').hidden = !failed;
      q<HTMLButtonElement>('[data-a="guideNext"]').hidden = !failed;
      q<HTMLButtonElement>('[data-a="guideSkip"]').hidden = failed;
    }
    const passed = v.steps.filter((s) => s.status === 'pass').length;
    const tried = v.steps.filter((s) => s.status === 'pass' || s.status === 'fail').length;
    badge('guideScore').textContent = tried ? `${passed} / ${v.steps.length} passed` : '';
    const html = v.steps
      .map((s, i) => {
        const icon = { pending: '○', active: '▶', pass: '✓', fail: '✗', skipped: '–' }[s.status];
        return `<li data-i="${i}" class="${s.status}"><span class="ic">${icon}</span><span class="tt">${escapeHtml(s.title)}</span><span class="dt">${escapeHtml(s.detail)}</span></li>`;
      })
      .join('');
    if (html !== lastChecklist) {
      checklist.innerHTML = html;
      lastChecklist = html;
    }
  }
  renderGuide(new GestureGuide({ on: () => () => {}, getState: () => ({ t: 0, tracking: 'off', hands: { left: blankHand(), right: blankHand() }, body: { lean: 0, crouch: 0, yaw: 0 }, bowDraw: 0 }) }).view());

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

function blankHand() {
  const z = () => ({ x: 0, y: 0, z: 0 });
  return { visible: false, confidence: 0, pos: z(), vel: z(), grip: 0, forward: z(), up: z() };
}
