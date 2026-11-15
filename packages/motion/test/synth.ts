// Synthetic MediaPipe frames for unit tests. Joints are given in "player space":
// meters, origin between the hips, +x = player's right, +y = up, −z = toward the camera.
import type { RawFrame, RawHand, RawLandmark } from '../src/types';

export type P3 = [number, number, number];
export const ASPECT = 16 / 9;
/** Image-height units per meter (player ~2 m from the camera). */
const K = 0.4;

export const NEUTRAL: Record<number, P3> = {
  0: [0, 0.75, -0.05],
  7: [-0.07, 0.74, 0], 8: [0.07, 0.74, 0],
  9: [-0.025, 0.7, -0.05], 10: [0.025, 0.7, -0.05],
  11: [-0.17, 0.5, 0], 12: [0.17, 0.5, 0],
  13: [-0.2, 0.22, 0], 14: [0.2, 0.22, 0],
  15: [-0.2, -0.05, -0.05], 16: [0.2, -0.05, -0.05],
  23: [-0.1, 0, 0], 24: [0.1, 0, 0],
};

const toWorld = ([x, y, z]: P3): RawLandmark => ({ x: -x, y: -y, z, visibility: 0.99 });
const toImage = ([x, y, z]: P3): RawLandmark => ({ x: 0.5 - (x * K) / ASPECT, y: 0.8 - y * K, z, visibility: 0.99 });

export interface HandSpec {
  /** Finger curl 0 (open) … 1 (fist) for index, middle, ring, pinky. */
  curl?: number | [number, number, number, number];
  thumbOut?: boolean;
}

export interface FrameSpec {
  joints?: Record<number, P3>;
  hands?: Partial<Record<'left' | 'right', HandSpec>>;
  /** Shift the whole body (player space). */
  offset?: P3;
  noPose?: boolean;
  /** Hand model skipped this frame. */
  skipHands?: boolean;
}

export function frame(t: number, spec: FrameSpec = {}): RawFrame {
  const j: Record<number, P3> = { ...NEUTRAL, ...spec.joints };
  const off = spec.offset ?? [0, 0, 0];
  const at = (i: number): P3 => {
    const p = j[i] ?? [0, 0.3, 0];
    return [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
  };
  const hands: RawHand[] = [];
  for (const side of ['left', 'right'] as const) {
    const hs = spec.hands?.[side];
    if (!hs) continue;
    hands.push(makeHand(side, at(side === 'left' ? 15 : 16), at(side === 'left' ? 13 : 14), hs));
  }
  if (spec.noPose) return { t, poseImage: null, poseWorld: null, hands: spec.skipHands ? null : hands };
  const worldOff: P3 = [0, 0, 0]; // world landmarks are hip-centered: don't shift them
  const idx = Array.from({ length: 33 }, (_, i) => i);
  return {
    t,
    poseWorld: idx.map((i) => {
      const p = j[i] ?? [0, 0.3, 0];
      return toWorld([p[0] + worldOff[0], p[1] + worldOff[1], p[2] + worldOff[2]]);
    }),
    poseImage: idx.map((i) => toImage(at(i))),
    hands: spec.skipHands ? null : hands,
  };
}

/** Builds 21 hand landmarks, fingers pointing along elbow→wrist, palm facing the camera. */
function makeHand(side: 'left' | 'right', wrist: P3, elbow: P3, spec: HandSpec): RawHand {
  const curls = Array.isArray(spec.curl) ? spec.curl : [spec.curl ?? 0, spec.curl ?? 0, spec.curl ?? 0, spec.curl ?? 0];
  // Finger axis (up) and across-palm axis in player space.
  let ux = wrist[0] - elbow[0], uy = wrist[1] - elbow[1];
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul; uy /= ul;
  // Across the palm toward the thumb: for the right hand (palm to camera) the thumb is on the player's left.
  const sgn = side === 'right' ? -1 : 1;
  const ax = -uy * -sgn, ay = ux * -sgn;
  const local: P3[] = new Array(21);
  local[0] = [0, 0, 0];
  const mcpAcross = [0.03, 0.01, -0.01, -0.03];
  const mcpUp = 0.09;
  for (let f = 0; f < 4; f++) {
    const c = curls[f] ?? 0;
    const across = mcpAcross[f] ?? 0;
    const tipDist = mcpUp * (2 - 1.15 * c);
    const base = 5 + f * 4;
    for (let k = 0; k < 4; k++) {
      const d = mcpUp + ((tipDist - mcpUp) * k) / 3;
      local[base + k] = [across * ax + d * ux, across * ay + d * uy, 0];
    }
  }
  const thumbAcross = spec.thumbOut ? 0.1 : 0.03;
  for (let k = 1; k <= 4; k++) {
    const a = (thumbAcross * k) / 4 + 0.02, u = 0.02 * k;
    local[k] = [a * ax + u * ux, a * ay + u * uy, 0];
  }
  const image = local.map(([x, y, z]) => toImage([wrist[0] + x, wrist[1] + y, wrist[2] + z]));
  const world = local.map(([x, y, z]) => ({ x: -x, y: -y, z, visibility: 1 }));
  // MediaPipe handedness assumes a mirrored image: the player's right hand is labeled "Left".
  return { image, world, label: side === 'right' ? 'Left' : 'Right', score: 0.95 };
}

/** Runs frames at a fixed rate starting at t0; returns the last t. */
export function run(push: (f: RawFrame) => void, ms: number, spec: FrameSpec | ((t: number) => FrameSpec), t0 = 0, hz = 60): number {
  const step = 1000 / hz;
  let t = t0;
  for (; t < t0 + ms; t += step) push(frame(t, typeof spec === 'function' ? spec(t) : spec));
  return t;
}
