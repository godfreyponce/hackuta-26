// Part B: the Quartermaster's face beside the friend cam. His voice (quartermaster-voice) moves the mouth every frame.
import { useEffect, useRef, useState } from 'react';
import { onCallBridge } from '../net/callBridge';
import type { CallMedia } from './callMedia';
import { createMouth, FACE_SIZE, type Face } from './mouth';
import closedUrl from '../assets/qm-closed.webp';
import openUrl from '../assets/qm-open.webp';

/** The part of the 1024 px face the box shows: hair line to beard tip, 4:3 like the friend cam. */
const CROP = { x: 152, y: 170, w: 720, h: 540 };
const CANVAS_W = 480;

let facePromise: Promise<Face> | null = null;
function loadFace(): Promise<Face> {
  const pixels = (img: HTMLImageElement) => {
    const c = document.createElement('canvas');
    c.width = c.height = FACE_SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, FACE_SIZE, FACE_SIZE);
    return ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
  };
  const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`face image failed: ${src}`));
    img.src = src;
  });
  facePromise ??= Promise.all([load(closedUrl), load(openUrl)])
    .then(([closed, open]) => ({ closed, closedPx: pixels(closed), openPx: pixels(open) }));
  return facePromise;
}

function useQmVoice(): AnalyserNode | null {
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    const offBridge = onCallBridge((b) => {
      off?.();
      off = (b.media as Partial<Pick<CallMedia, 'onQmVoice'>> | null)?.onQmVoice?.(setAnalyser);
      if (!off) setAnalyser(null);
    });
    return () => { offBridge(); off?.(); };
  }, []);
  return analyser;
}

export function QmFace() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const analyser = useQmVoice();
  const [face, setFace] = useState<Face | null>(null);

  useEffect(() => {
    let live = true;
    loadFace().then((f) => { if (live) setFace(f); }, (e) => console.warn('[qm-face]', e));
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !face) return;
    const mouth = createMouth(face);
    const s = CANVAS_W / CROP.w;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      mouth.frame(analyser, Math.min(0.1, (now - last) / 1000));
      last = now;
      ctx.setTransform(s, 0, 0, s, -CROP.x * s, -CROP.y * s);
      ctx.imageSmoothingQuality = 'high';
      mouth.draw(ctx);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [face, analyser]);

  return (
    <div className="pip" style={{ width: '60%', alignSelf: 'flex-end' }}>
      <canvas ref={canvas} width={CANVAS_W} height={(CANVAS_W * CROP.h) / CROP.w} style={{ width: '100%', height: '100%', display: 'block' }} />
      <span className="name">Quartermaster</span>
    </div>
  );
}
