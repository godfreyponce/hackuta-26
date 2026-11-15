// Slow-mo killcam recording (spec A.5): MediaRecorder on the main canvas, start at the slow-mo
// trigger, stop 0.4 s after it ends. Keeps the last 3 locally; uploads in the background.
import type { TrickshotKind } from '@ithaca/shared';

export interface Clip { blob: Blob; url: string; trickshot: TrickshotKind; weaponName?: string; at: number }

let stream: MediaStream | null = null;
let rec: MediaRecorder | null = null;
let chunks: Blob[] = [];
let current: { trickshot: TrickshotKind; weaponName?: string } | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let hardStop: ReturnType<typeof setTimeout> | null = null;

function mime(): string | undefined {
  const opts = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return opts.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));
}

export function startKillcam(canvas: HTMLCanvasElement | null, trickshot: TrickshotKind, weaponName: string | undefined, onClip: (c: Clip) => void) {
  if (!canvas || typeof MediaRecorder === 'undefined') return;
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (rec && rec.state === 'recording') return; // extend the current clip
  try {
    if (!stream) stream = canvas.captureStream(30);
    const m = mime();
    rec = new MediaRecorder(stream, m ? { mimeType: m, videoBitsPerSecond: 4_000_000 } : undefined);
    chunks = [];
    current = { trickshot, weaponName };
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      if (!current || !chunks.length) return;
      const blob = new Blob(chunks, { type: m ?? 'video/webm' });
      if (blob.size > 14.5 * 1024 * 1024) return; // server cap 15 MB
      onClip({ blob, url: URL.createObjectURL(blob), trickshot: current.trickshot, weaponName: current.weaponName, at: Date.now() });
      current = null;
    };
    rec.start(250);
    hardStop = setTimeout(() => stopKillcam(0), 6000);
  } catch (err) {
    console.warn('[killcam] recorder unavailable', err);
    rec = null;
  }
}

export function stopKillcam(delayMs = 400) {
  if (!rec) return;
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    if (hardStop) { clearTimeout(hardStop); hardStop = null; }
    try { if (rec && rec.state === 'recording') rec.stop(); } catch { /* ignore */ }
    rec = null;
    stopTimer = null;
  }, delayMs);
}
