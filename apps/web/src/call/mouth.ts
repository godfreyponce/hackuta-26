// The Quartermaster's mouth, owner pick: round 5, style E (jaw drop with shape). Ported from the qm-mouth study's
// mouth.js; the numbers and their sources are in that study's notes. Both frames are the full 1024 px v1 face.
// The voice drives it: loudness and a high-band share, read from an AnalyserNode once per animation frame.

const FLOOR_DB = -38, CEIL_DB = -12, GAMMA = 1.5;
const ATTACK_S = 0.025, RELEASE_S = 0.08;
const WIDE_LOG0 = -3, WIDE_LOG1 = -0.5, WIDE_S = 0.06, WIDE_GATE = 0.05;

// Jaw warp geometry, 1024 px space.
const J = {
  XC: 511, SEAM: 559, LIP_CURVE: 0.0016, LIP_DX: 90, RX: 80, HC: 63, TAPER: 20, WF0: 0.65, WF1: 1, HF1: 0.25,
  RIM: 13, RIM_MIN: 4, TEETH: 16, DARK: 0.55, DEPTH: 0.8, HIDE0: 22, REVEAL0: 0.6, TONGUE0: 0.55, TONGUE1: 0.9, SHADE0: 0.5, CORNER0: 0.45, CORNER_DARK: 0.9, RJ: 200, JAW_K: 0.8, BLEND: 120,
  BEARD_Y: 742, BEARD_CURVE: 0.0035, COLLAR_Y: 872, COLLAR_X: 515, COLLAR_K: 1.5, NECK: 0.67,
  X0: 300, Y0: 546, X1: 724, Y1: 872,
};

export const FACE_SIZE = 1024;

/** 0 = round mouth, 1 = wide: the share of voice energy at 2-6 kHz, on a log scale. Needs smoothingTimeConstant = 0. */
function wideness(analyser: AnalyserNode, freqBuf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatFrequencyData(freqBuf);
  const hz = analyser.context.sampleRate / analyser.fftSize;
  let hi = 0, all = 0;
  for (let k = Math.ceil(150 / hz); k * hz < 6000; k++) {
    const p = 10 ** (freqBuf[k] / 10);
    all += p;
    if (k * hz >= 2000) hi += p;
  }
  if (!(all > 0)) return 0.5;
  return Math.min(1, Math.max(0, (Math.log10(hi / all + 1e-9) - WIDE_LOG0) / (WIDE_LOG1 - WIDE_LOG0)));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mouthShape(dx: number, rx: number): number {
  return Math.sqrt(Math.max(0, 1 - Math.abs(dx / rx) ** 3));
}

/** The source row under the teeth keeps to the dark band or below, a floor that fades out toward full open. */
function lowerSrc(raw: number, darkRow: number, reveal: number): number {
  return raw + (1 - reveal) * (Math.max(raw, darkRow) - raw);
}

function sampleCol(px: Uint8ClampedArray, x: number, y: number, ch: number): number {
  const lo = Math.floor(y), f = y - lo, i = (lo * FACE_SIZE + x) * 4 + ch;
  return px[i] * (1 - f) + px[i + FACE_SIZE * 4] * f;
}

/**
 * Jaw drop: the upper lip and teeth stay put, the lower lip, chin and beard slide down by level,
 * and the open frame's mouth inside fills the gap. wide 0..1 narrows or widens the opening.
 * Writes the changed box (x J.X0..J.X1, y J.Y0..J.Y1) into out, an ImageData of that size.
 */
function jawWarp(out: ImageData, closedPx: ImageData, openPx: ImageData, level: number, wide: number): void {
  const W = J.X1 - J.X0, d = out.data, c = closedPx.data, o = openPx.data;
  const wf = J.WF0 + (J.WF1 - J.WF0) * wide, hf = 1 - J.HF1 * wide;
  const reveal = smoothstep(J.REVEAL0, 1, level);
  const hide = J.HIDE0 * (1 - reveal);
  const depth = J.DEPTH + (1 - J.DEPTH) * reveal;
  const shade = J.SHADE0 + (1 - J.SHADE0) * level;
  for (let i = 0; i < W; i++) {
    const x = J.X0 + i, dx = x - J.XC;
    const top = J.SEAM - J.LIP_CURVE * Math.min(dx * dx, J.LIP_DX * J.LIP_DX);
    const g = level * depth * J.HC * hf * mouthShape(dx, J.RX * wf) * smoothstep(0, J.TAPER, J.RX * wf - Math.abs(dx));
    const h = J.HC * mouthShape(dx, J.RX);
    const beard = J.BEARD_Y - J.BEARD_CURVE * dx * dx;
    const neck = Math.max(1, J.COLLAR_Y - J.COLLAR_K * Math.abs(x - J.COLLAR_X) - beard);
    const chin = level * Math.min(J.HC * J.JAW_K * Math.max(0, 1 - (dx / J.RJ) ** 2), J.NECK * neck);
    const rimFull = J.RIM + J.SEAM - top;
    const rim = (rimFull * (J.RIM_MIN + (J.RIM - J.RIM_MIN) * Math.min(1, g / (0.5 * J.HC)))) / J.RIM;
    const teethEnd = Math.min(g, rim + J.TEETH);
    const tongue = 1 - reveal * (1 - smoothstep(J.TONGUE0, J.TONGUE1, g / J.HC));
    const srcDark = J.SEAM + J.DARK * h;
    const cornerK = J.CORNER_DARK * (1 - reveal) * smoothstep(J.CORNER0, 1, Math.abs(dx) / (J.RX * wf));
    for (let y = J.Y0; y < J.Y1; y++) {
      const t = y - top, k = ((y - J.Y0) * W + i) * 4;
      d[k + 3] = 255;
      if (t < 0) {
        for (let ch = 0; ch < 3; ch++) d[k + ch] = c[(y * FACE_SIZE + x) * 4 + ch];
        continue;
      }
      const e = (g + (chin - g) * smoothstep(0, J.BLEND, t - g)) * (1 - smoothstep(beard, beard + neck, y));
      const cover = Math.min(1, Math.max(0, g - t));
      const inTeeth = t < teethEnd;
      const src = inTeeth
        ? top + (t < rim ? (t * rimFull) / rim : t - rim + rimFull)
        : lowerSrc(J.SEAM + h - g + t - hide, J.SEAM + J.DARK * h, reveal);
      for (let ch = 0; ch < 3; ch++) {
        let v = sampleCol(c, x, y - e, ch);
        if (cover > 0) {
          const k1 = inTeeth ? 1 : tongue;
          const raw = sampleCol(o, x, src, ch) * k1 + (k1 < 1 ? sampleCol(o, x, srcDark, ch) * (1 - k1) : 0);
          const inside = raw * shade * (1 - cornerK * (1 - smoothstep(rim - 4, rim + 2, t)));
          v = inside * cover + v * (1 - cover);
        }
        d[k + ch] = v;
      }
    }
  }
}

/** Loudness 0..1 from the analyser's latest window. */
function loudness(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEIL_DB - FLOOR_DB))) ** GAMMA;
}

/** Moves cur toward target: fast when it rises, slower when it falls. */
function follow(cur: number, target: number, dt: number, attack: number, release: number): number {
  return cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? attack : release)));
}

export interface Face { closed: CanvasImageSource; closedPx: ImageData; openPx: ImageData }

/** One face's mouth: call frame() once per animation frame, then draw(). */
export function createMouth(face: Face) {
  const box = document.createElement('canvas');
  box.width = J.X1 - J.X0;
  box.height = J.Y1 - J.Y0;
  const boxPx = new ImageData(box.width, box.height);
  let level = 0, wide = 0.5, boxLevel = -1, boxWide = -1;
  let time: Float32Array<ArrayBuffer> | null = null, freq: Float32Array<ArrayBuffer> | null = null;

  return {
    /** Reads the voice (null: silence) and redraws the mouth box if the jaw moved. dt in seconds. */
    frame(analyser: AnalyserNode | null, dt: number) {
      let target = 0, wideTarget = wide;
      if (analyser) {
        if (time?.length !== analyser.fftSize) time = new Float32Array(analyser.fftSize);
        if (freq?.length !== analyser.frequencyBinCount) freq = new Float32Array(analyser.frequencyBinCount);
        target = loudness(analyser, time);
        wideTarget = wideness(analyser, freq);
      }
      level = follow(level, target, dt, ATTACK_S, RELEASE_S);
      // In pauses the spectrum is noise, so the shape holds; quiet frames (hiss tails) move it slowly.
      if (target >= WIDE_GATE) wide = follow(wide, wideTarget, dt, WIDE_S / target, WIDE_S / target);
      // 0.001 of full open is under 0.1 px of jaw: not worth a redraw.
      if (Math.abs(boxLevel - level) < 0.001 && Math.abs(boxWide - wide) < 0.001) return;
      boxLevel = level;
      boxWide = wide;
      jawWarp(boxPx, face.closedPx, face.openPx, level, wide);
      box.getContext('2d')!.putImageData(boxPx, 0, 0);
    },
    /** Draws the face in 1024 px space; the caller sets the transform. */
    draw(ctx: CanvasRenderingContext2D) {
      ctx.drawImage(face.closed, 0, 0);
      ctx.drawImage(box, J.X0, J.Y0);
    },
  };
}
