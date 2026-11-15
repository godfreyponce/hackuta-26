// M2: pose-guided hand crops — geometry, mapping back, and how the mapper takes crop hands.
import { afterEach, describe, expect, it } from 'vitest';
import { config, resetConfig } from '../src/config';
import {
  clipBlit,
  cropToFull,
  duplicateSide,
  fullToCrop,
  outsideFraction,
  roiFromHand,
  roiFromPose,
  sticky,
  type CropRect,
} from '../src/handRoi';
import { Mapper } from '../src/mapping';
import { neutralState } from '../src/neutral';
import { cloneProfile, DEFAULT_PROFILE } from '../src/profile';
import type { RawHand, RawLandmark } from '../src/types';
import { ASPECT, frame } from './synth';

const W = 1280, H = 720;
afterEach(resetConfig);

/** 33 pose landmarks; shoulders 128 px apart; the given points override. */
function pose(over: Record<number, [number, number, number?]>): RawLandmark[] {
  const p: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.99 }));
  p[11] = { x: 0.45, y: 0.3, z: 0, visibility: 0.99 };
  p[12] = { x: 0.55, y: 0.3, z: 0, visibility: 0.99 };
  for (const [k, [x, y, vis]] of Object.entries(over)) p[Number(k)] = { x, y, z: 0, visibility: vis ?? 0.99 };
  return p;
}

/** A 21-point hand: wrist at (cx, cy) px, MCPs `s` px above, tips 2s above (open) — normalized coords. */
function hand(cx: number, cy: number, s: number, label: 'Left' | 'Right', side?: 'left' | 'right'): RawHand {
  const image: RawLandmark[] = [];
  for (let i = 0; i < 21; i++) {
    const f = i === 0 ? 0 : i <= 4 ? -1.5 : Math.floor((i - 5) / 4) - 1.5; // across-palm column
    const up = i === 0 ? 0 : i <= 4 ? 0.3 * ((i - 1) % 4) + 0.3 : 1 + ((i - 5) % 4) * 0.33;
    image.push({ x: (cx + f * 0.25 * s) / W, y: (cy - up * s) / H, z: 0 });
  }
  return { image, world: null, label, score: 0.95, ...(side ? { side } : {}) };
}

describe('roiFromPose (Holistic geometry)', () => {
  it('matches hand-computed centre and size', () => {
    // wrist (512, 432) px; m = (2·index + pinky)/3 = (537.6, 468); d = |m − w| = hypot(25.6, 36) = 44.17 px
    const p = pose({ 15: [0.4, 0.6], 17: [0.4, 0.65], 19: [0.43, 0.65] });
    const r = roiFromPose(p, 'left', W, H);
    expect(r).not.toBeNull();
    if (!r) return;
    const d = Math.hypot(25.6, 36);
    const S = 5.4 * d;
    expect(r.size).toBeCloseTo(S, 6);
    // centre = wrist + 1.2·d·unit(m − w) = wrist + 1.2·(m − w)
    expect(r.x0 + r.size / 2).toBeCloseTo(512 + 1.2 * 25.6, 6);
    expect(r.y0 + r.size / 2).toBeCloseTo(432 + 1.2 * 36, 6);
  });

  it('uses the right side landmarks (16 / 18 / 20)', () => {
    const p = pose({ 16: [0.6, 0.6], 18: [0.6, 0.65], 20: [0.63, 0.65] });
    const r = roiFromPose(p, 'right', W, H);
    expect(r && r.x0 + r.size / 2).toBeCloseTo(0.6 * W + 1.2 * 25.6, 6);
  });

  it('clamps the wrist→knuckle length to [0.18, 0.40] shoulder widths', () => {
    const sw = 0.1 * W; // 128 px
    // Foreshortened hand (index/pinky on the wrist): d = 0.18·sw, centre on the wrist.
    const tiny = roiFromPose(pose({ 15: [0.4, 0.6], 17: [0.4, 0.6], 19: [0.4, 0.6] }), 'left', W, H);
    expect(tiny?.size).toBeCloseTo(5.4 * 0.18 * sw, 6);
    expect(tiny && tiny.x0 + tiny.size / 2).toBeCloseTo(0.4 * W, 6);
    // Bad pose (knuckles far away): d = 0.40·sw, centre 1.2·d along the direction.
    const huge = roiFromPose(pose({ 15: [0.4, 0.5], 17: [0.4, 0.8], 19: [0.4, 0.8] }), 'left', W, H);
    expect(huge?.size).toBeCloseTo(5.4 * 0.4 * sw, 6);
    expect(huge && huge.y0 + huge.size / 2).toBeCloseTo(0.5 * H + 1.2 * 0.4 * sw, 6);
  });

  it('grows 1.3× for an uncertain wrist, gates below handRoiMinWristVis, clamps to [96, 0.9·H]', () => {
    const base = { 17: [0.4, 0.65], 19: [0.43, 0.65] } as Record<number, [number, number]>;
    const sure = roiFromPose(pose({ ...base, 15: [0.4, 0.6, 0.9] }), 'left', W, H);
    const unsure = roiFromPose(pose({ ...base, 15: [0.4, 0.6, 0.3] }), 'left', W, H);
    expect((unsure?.size ?? 0) / (sure?.size ?? 1)).toBeCloseTo(1.3, 6);
    expect(roiFromPose(pose({ ...base, 15: [0.4, 0.6, 0.05] }), 'left', W, H)).toBeNull();
    config.handRoiMinWristVis = 0;
    expect(roiFromPose(pose({ ...base, 15: [0.4, 0.6, 0.05] }), 'left', W, H)).not.toBeNull();
    // Tiny person far away: never below 96 px.
    const far = pose({ 11: [0.495, 0.3], 12: [0.505, 0.3], 15: [0.4, 0.6], 17: [0.4, 0.601], 19: [0.401, 0.601] });
    expect(roiFromPose(far, 'left', W, H)?.size).toBe(96);
    config.handRoiScale = 40;
    expect(roiFromPose(pose({ ...base, 15: [0.4, 0.6] }), 'left', W, H)?.size).toBeCloseTo(0.9 * H, 6);
  });
});

describe('crop geometry', () => {
  const r: CropRect = { x0: 100, y0: 50, size: 200 };

  it('cropToFull maps the crop centre to the rect centre, scales z by S/W, and round-trips', () => {
    const lm: RawLandmark[] = [
      { x: 0.5, y: 0.5, z: 0.1, visibility: 0.7 },
      { x: 0, y: 0, z: -0.2 },
      { x: 1, y: 1, z: 0 },
    ];
    const full = cropToFull(lm, r, W, H);
    expect(full[0]?.x).toBeCloseTo(200 / W, 9);
    expect(full[0]?.y).toBeCloseTo(150 / H, 9);
    expect(full[0]?.z).toBeCloseTo((0.1 * 200) / W, 9);
    expect(full[0]?.visibility).toBe(0.7);
    expect(full[1]).not.toHaveProperty('visibility');
    expect(full[2]?.x).toBeCloseTo(300 / W, 9);
    const back = fullToCrop(full, r, W, H);
    lm.forEach((l, i) => {
      expect(back[i]?.x).toBeCloseTo(l.x, 9);
      expect(back[i]?.y).toBeCloseTo(l.y, 9);
      expect(back[i]?.z).toBeCloseTo(l.z, 9);
    });
  });

  it('clipBlit: fully inside copies the whole rect', () => {
    expect(clipBlit(r, W, H, 256)).toEqual([100, 50, 200, 200, 0, 0, 256, 256]);
  });

  it('clipBlit: clips at each of the four edges and keeps the destination aligned', () => {
    const k = 256 / 200;
    const left = clipBlit({ x0: -50, y0: 100, size: 200 }, W, H, 256);
    expect(left).toEqual([0, 100, 150, 200, 50 * k, 0, 150 * k, 256]);
    const right = clipBlit({ x0: W - 120, y0: 100, size: 200 }, W, H, 256);
    expect(right).toEqual([W - 120, 100, 120, 200, 0, 0, 120 * k, 256]);
    const top = clipBlit({ x0: 300, y0: -80, size: 200 }, W, H, 256);
    expect(top).toEqual([300, 0, 200, 120, 0, 80 * k, 256, 120 * k]);
    const bottom = clipBlit({ x0: 300, y0: H - 30, size: 200 }, W, H, 256);
    expect(bottom).toEqual([300, H - 30, 200, 30, 0, 0, 256, 30 * k]);
    expect(clipBlit({ x0: -300, y0: 100, size: 200 }, W, H, 256)).toBeNull();
    expect(clipBlit({ x0: 100, y0: H + 1, size: 200 }, W, H, 256)).toBeNull();
  });

  it('outsideFraction', () => {
    expect(outsideFraction(r, W, H)).toBe(0);
    expect(outsideFraction({ x0: -100, y0: 0, size: 200 }, W, H)).toBeCloseTo(0.5, 9);
    expect(outsideFraction({ x0: -100, y0: H - 100, size: 200 }, W, H)).toBeCloseTo(0.75, 9);
    expect(outsideFraction({ x0: W, y0: 0, size: 200 }, W, H)).toBe(1);
  });

  it('sticky: keeps the old rect inside the dead-band, jumps outside it', () => {
    const prev: CropRect = { x0: 100, y0: 100, size: 200 };
    expect(sticky(null, prev)).toBe(prev);
    const near = { x0: 105, y0: 100, size: 210 }; // centre moved 11 px < 0.12·200 = 24, size +5%
    expect(sticky(prev, near)).toBe(prev);
    const far = { x0: 130, y0: 100, size: 200 }; // 30 px ≥ 24 px
    expect(sticky(prev, far)).toBe(far);
    const grown = { x0: 75, y0: 75, size: 250 }; // +25% size, same centre
    expect(sticky(prev, grown)).toBe(grown);
  });

  it('roiFromHand: 1.8 × the landmark box, moved by velocity × age', () => {
    const h = hand(640, 400, 40, 'Left');
    const r0 = roiFromHand(h, W, H, 0, 0, 0);
    const xs = h.image.map((l) => l.x * W), ys = h.image.map((l) => l.y * H);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    expect(r0.size).toBeCloseTo(Math.max(96, 1.8 * Math.max(bw, bh)), 6);
    const r1 = roiFromHand(h, W, H, 0.5, -0.25, 100);
    expect(r1.x0 - r0.x0).toBeCloseTo(50, 6);
    expect(r1.y0 - r0.y0).toBeCloseTo(-25, 6);
  });
});

describe('duplicateSide (both crops on one hand)', () => {
  const p = pose({ 15: [0.45, 0.6], 16: [0.55, 0.6] });

  it('two distinct hands → null', () => {
    const L = hand(0.45 * W, 0.6 * H, 40, 'Left'), R = hand(0.55 * W, 0.6 * H, 40, 'Right');
    expect(duplicateSide(L, R, { left: 'Left', right: 'Right' }, p, W, H)).toBeNull();
  });

  it('same hand: drops the side whose own model label disagrees', () => {
    const a = hand(0.45 * W, 0.6 * H, 40, 'Left'), b = hand(0.45 * W + 3, 0.6 * H, 40, 'Left');
    // Both crops' models call it a left hand → the right crop is the one that is wrong.
    expect(duplicateSide(a, b, { left: 'Left', right: 'Left' }, p, W, H)).toBe('right');
    expect(duplicateSide(a, b, { left: 'Right', right: 'Right' }, p, W, H)).toBe('left');
  });

  it('same hand, labels tie: drops the side farther from its own pose wrist', () => {
    const a = hand(0.45 * W, 0.6 * H, 40, 'Left'), b = hand(0.45 * W + 3, 0.6 * H, 40, 'Left');
    // The hand sits on the left wrist: the right crop's wrist is 128 px from the right pose wrist.
    expect(duplicateSide(a, b, { left: 'Left', right: 'Right' }, p, W, H)).toBe('right');
    const q = pose({ 15: [0.3, 0.6], 16: [0.46, 0.6] });
    expect(duplicateSide(a, b, { left: 'Left', right: 'Right' }, q, W, H)).toBe('left');
  });
});

describe('Mapper.assignHands', () => {
  const run = (hands: RawHand[], noPose = false) => {
    const m = new Mapper();
    const st = neutralState('ok');
    const f = frame(0, noPose ? { noPose: true } : {});
    m.update(f.poseImage, f.poseWorld, hands, 0, ASPECT, cloneProfile(DEFAULT_PROFILE), st);
    return m.body;
  };
  // synth frame(): left pose wrist at image x ≈ 0.545, right ≈ 0.455 (y ≈ 0.82).
  const atLeftWrist = (lbl: 'Left' | 'Right', side?: 'left' | 'right') => hand(0.545 * W, 0.82 * H, 30, lbl, side);
  const atRightWrist = (lbl: 'Left' | 'Right', side?: 'left' | 'right') => hand(0.455 * W, 0.82 * H, 30, lbl, side);

  it('without side: nearest pose wrist wins over the label', () => {
    const b = run([atLeftWrist('Right'), atRightWrist('Left')]);
    expect(b.hand.left?.image[0]?.x).toBeCloseTo(0.545, 6);
    expect(b.hand.right?.image[0]?.x).toBeCloseTo(0.455, 6);
  });

  it('with side: the crop side is taken as is, even away from that pose wrist', () => {
    const h = atRightWrist('Left', 'left');
    const b = run([h]);
    expect(b.hand.left).toBe(h);
    expect(b.hand.right).toBeNull();
    expect(b.handFresh.left).toBe(true);
  });

  it('mixed: any hand without side falls back to the old association', () => {
    const b = run([atLeftWrist('Right', 'right'), atRightWrist('Right')]);
    expect(b.hand.left?.image[0]?.x).toBeCloseTo(0.545, 6);
    expect(b.hand.right?.image[0]?.x).toBeCloseTo(0.455, 6);
  });

  it('no pose, no side: MediaPipe label names the player\'s own hand (M5)', () => {
    const b = run([atLeftWrist('Left')], true);
    expect(b.hand.left).not.toBeNull();
    expect(b.hand.right).toBeNull();
    const b2 = run([atLeftWrist('Right')], true);
    expect(b2.hand.right).not.toBeNull();
  });

  it('skipped side keeps its last hand (not fresh) on alternate frames', () => {
    const m = new Mapper();
    const st = neutralState('ok');
    const prof = cloneProfile(DEFAULT_PROFILE);
    const f = frame(0);
    const L = atLeftWrist('Left', 'left'), R = atRightWrist('Right', 'right');
    m.update(f.poseImage, f.poseWorld, [L, R], 0, ASPECT, prof, st);
    m.update(f.poseImage, f.poseWorld, [L], 33, ASPECT, prof, st, ['right']);
    expect(m.body.hand.right).toBe(R);
    expect(m.body.handFresh.right).toBe(false);
    expect(m.body.handRan.right).toBe(false);
    expect(m.body.handRan.left).toBe(true);
    m.update(f.poseImage, f.poseWorld, [L], 66, ASPECT, prof, st);
    expect(m.body.hand.right).toBeNull();
  });
});
