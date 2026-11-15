// Scripted webcam sword moves as Part C recordings (version 1, like packages/motion/fixtures): Part C's test synth
// (packages/motion/test/synth.ts) poses the right arm through keyframes, with tracker-like noise, at the real
// tracker's cadence (15 fps pose, the hand model on every other frame). Used by scripts/thrust-check.ts (Node) and
// by the browser webcam-thrust test (which imports this file through the dev server and replays it into the game).
import { frame, NEUTRAL, type P3 } from '../../../packages/motion/test/synth';
import type { RawFrame, Recording } from '../../../packages/motion/src/types';

/** right arm keyframes, player space: +x his right, +y up from the hips, −z toward the camera (= into the hall) */
type Key = { t: number; elbow: P3; wrist: P3 };
const GUARD = { elbow: [0.24, 0.28, -0.08] as P3, wrist: [0.2, 0.36, -0.32] as P3 };
const at = (elbow: P3, wrist: P3) => ({ elbow, wrist });
const cycles = (t0: number, every: number, moves: [number, { elbow: P3; wrist: P3 }][]): Key[] =>
  [0, 1, 2].flatMap((i) => { let t = t0 + i * every; return moves.map(([dt, p]) => { t += dt; return { t, ...p }; }); });
const OUT = at([0.19, 0.42, -0.3], [0.15, 0.45, -0.6]), DEEP = at([0.17, 0.44, -0.36], [0.13, 0.46, -0.68]);

export type SwordMove = 'thrust' | 'jab' | 'diagonal' | 'slash' | 'chop';
export const MOVES: Record<SwordMove, { keys: Key[]; onsets: number[] }> = {
  // a thrust at the man in front (the arm drives out along the forearm), held, pushed on, drawn back
  thrust: { keys: [{ t: 0, ...GUARD }, ...cycles(1400, 2200, [[0, GUARD], [230, OUT], [380, OUT], [320, DEEP], [300, DEEP], [380, GUARD]])], onsets: [1400, 3600, 5800] },
  // a short jab (12 cm in 0.15 s)
  jab: { keys: [{ t: 0, ...GUARD }, ...cycles(1400, 1800, [[0, GUARD], [150, at([0.22, 0.33, -0.18], [0.18, 0.4, -0.46])], [500, at([0.22, 0.33, -0.18], [0.18, 0.4, -0.46])], [350, GUARD]])], onsets: [1400, 3200, 5000] },
  // at a man to the front-left: the arm drives diagonally into the hall
  diagonal: { keys: [{ t: 0, ...GUARD }, ...cycles(1400, 2200, [[0, GUARD], [240, at([0.12, 0.42, -0.28], [-0.1, 0.44, -0.55])], [400, at([0.12, 0.42, -0.28], [-0.1, 0.44, -0.55])], [380, GUARD]])], onsets: [1400, 3600, 5800] },
  // a cut across his body: the hand sweeps right → left, the blade pointing forward
  slash: { keys: [{ t: 0, ...GUARD }, ...cycles(1400, 2000, [[0, GUARD], [300, at([0.42, 0.34, -0.1], [0.5, 0.42, -0.34])], [200, at([0.42, 0.34, -0.1], [0.5, 0.42, -0.34])], [220, at([0, 0.34, -0.2], [-0.28, 0.38, -0.38])], [300, at([0, 0.34, -0.2], [-0.28, 0.38, -0.38])], [450, GUARD]])], onsets: [] },
  // a chop: the blade raised high, then brought down in front
  chop: { keys: [{ t: 0, ...GUARD }, ...cycles(1400, 2000, [[0, GUARD], [320, at([0.3, 0.6, -0.05], [0.24, 0.85, -0.2])], [200, at([0.3, 0.6, -0.05], [0.24, 0.85, -0.2])], [230, at([0.24, 0.3, -0.25], [0.12, 0.12, -0.45])], [300, at([0.24, 0.3, -0.25], [0.12, 0.12, -0.45])], [450, GUARD]])], onsets: [] },
};

/** A recording of `name` performed three times, with tracker noise (seeded; `noise` scales it). */
export function swordMove(name: SwordMove, seed = 7, noise = 1): Recording {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => { let v = 0; for (let i = 0; i < 6; i++) v += rnd(); return (v - 3) / Math.sqrt(0.5); };
  const ease = (k: number) => k * k * (3 - 2 * k);
  const lerp = (a: P3, b: P3, k: number): P3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const { keys } = MOVES[name];
  const armAt = (t: number) => {
    const first = keys[0]!;
    if (t <= first.t) return first;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1]!, b = keys[i]!;
      if (t <= b.t) { const k = ease((t - a.t) / Math.max(1, b.t - a.t)); return { elbow: lerp(a.elbow, b.elbow, k), wrist: lerp(a.wrist, b.wrist, k) }; }
    }
    return keys[keys.length - 1]!;
  };
  const end = keys[keys.length - 1]!.t + 1200;
  const frames: RawFrame[] = [];
  for (let t = 0, n = 0; t <= end; t += 1000 / 15, n++) {
    const a = armAt(t);
    const f = frame(t, { joints: { ...NEUTRAL, 14: a.elbow, 16: a.wrist, 13: [-0.2, 0.22, 0], 15: [-0.22, 0, -0.08] }, hands: { right: { curl: 1 } }, skipHands: n % 2 === 1 });
    // tracker noise: world depth is the worst (σ 2.5 cm), x/y σ 6 mm; image σ 0.25 %
    for (const p of f.poseWorld ?? []) { p.x += gauss() * 0.006 * noise; p.y += gauss() * 0.006 * noise; p.z += gauss() * 0.025 * noise; }
    for (const p of f.poseImage ?? []) { p.x += gauss() * 0.0025 * noise; p.y += gauss() * 0.0025 * noise; }
    for (const h of f.hands ?? []) { const ox = gauss() * 0.003 * noise, oy = gauss() * 0.003 * noise; for (const p of h.image) { p.x += ox; p.y += oy; } }
    frames.push(f);
  }
  return { version: 1, meta: { label: name, aspect: 16 / 9, width: 960, height: 540, createdAt: new Date(0).toISOString() }, frames };
}
