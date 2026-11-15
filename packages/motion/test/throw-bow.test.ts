// Regression tests for the two moves that failed in the Lab gesture test (throw, bow shot).
import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@ithaca/shared';
import { Engine } from '../src/engine';
import { ASPECT, run, type FrameSpec, type P3 } from './synth';

function engine() {
  const e = new Engine();
  e.aspect = ASPECT;
  const events: InputEvent[] = [];
  e.on((ev) => events.push(ev));
  e.begin();
  return { e, events, push: (f: Parameters<Engine['push']>[0]) => e.push(f, f.t) };
}
const speed = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
const lerp3 = (a: P3, b: P3, k: number): P3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

// Right hand at the shoulder, cocked back → punched out toward the camera in 150 ms.
const COCK = { wrist: [0.25, 0.45, 0.05] as P3, elbow: [0.3, 0.3, 0.1] as P3 };
const OUT = { wrist: [0.2, 0.5, -0.6] as P3, elbow: [0.2, 0.48, -0.3] as P3 };

/**
 * A realistic webcam throw: the hand blurs during the fast part (hand landmarker loses it),
 * the arm stops at full extension, and the open hand is only seen once it's still again.
 */
function blurredThrow(t0: number, opts: { stopMs: number; blur: boolean }) {
  return (tt: number): FrameSpec => {
    const dt = tt - t0;
    const k = Math.min(dt / 150, 1);
    const joints = { 16: lerp3(COCK.wrist, OUT.wrist, k), 14: lerp3(COCK.elbow, OUT.elbow, k) };
    if (dt < 150) return { joints, hands: opts.blur ? {} : { right: { curl: 1 } } }; // moving: blurred
    if (dt < 150 + opts.stopMs) return { joints, hands: opts.blur ? {} : { right: { curl: 1 } } }; // stopped, not yet seen open
    return { joints, hands: { right: { curl: 0 } } }; // open hand finally detected
  };
}

describe('throw: release velocity survives late open detection', () => {
  it('hand stops 150 ms before the open is seen → release still carries the throw speed', () => {
    const { events, push } = engine();
    let t = run(push, 500, { joints: { 16: COCK.wrist, 14: COCK.elbow }, hands: { right: { curl: 1 } } });
    t = run(push, 500, blurredThrow(t, { stopMs: 150, blur: false }), t);
    const rel = events.find((e) => e.type === 'release');
    expect(rel?.type).toBe('release');
    if (rel?.type !== 'release') return;
    expect(speed(rel.vel)).toBeGreaterThan(1.5); // the Lab's "throw" pass threshold
    expect(rel.vel.z).toBeLessThan(-0.3); // toward the screen
  });

  it('hand landmarks lost during the throw (motion blur) → still a fast, forward release', () => {
    const { events, push } = engine();
    let t = run(push, 500, { joints: { 16: COCK.wrist, 14: COCK.elbow }, hands: { right: { curl: 1 } } });
    t = run(push, 700, blurredThrow(t, { stopMs: 250, blur: true }), t);
    const rel = events.filter((e) => e.type === 'release');
    expect(rel).toHaveLength(1);
    const r = rel[0];
    if (r?.type !== 'release') return;
    expect(speed(r.vel)).toBeGreaterThan(1.5);
    expect(r.vel.z).toBeLessThan(-0.3);
  });

  it('a plain drop (hand held still, then opened) is still slow — drops are not turned into throws', () => {
    const { events, push } = engine();
    let t = run(push, 500, { hands: { right: { curl: 1 } } });
    // Move, then hold still for 0.5 s, then open.
    const t0 = t;
    t = run(push, 200, (tt) => ({ joints: { 16: lerp3([0.2, -0.05, -0.05], [0.2, 0.2, -0.3], Math.min((tt - t0) / 200, 1)) }, hands: { right: { curl: 1 } } }), t);
    t = run(push, 500, { joints: { 16: [0.2, 0.2, -0.3] }, hands: { right: { curl: 1 } } }, t);
    run(push, 300, { joints: { 16: [0.2, 0.2, -0.3] }, hands: { right: { curl: 0 } } }, t);
    const r = events.find((e) => e.type === 'release');
    if (r?.type !== 'release') throw new Error('no release');
    expect(speed(r.vel)).toBeLessThan(1.0);
  });
});

// Bow geometry (same as gestures.test.ts).
const LEFT_OUT: Record<number, P3> = { 13: [-0.12, 0.5, -0.28], 15: [-0.08, 0.5, -0.56] };
const NOCK: Record<number, P3> = { ...LEFT_OUT, 16: [-0.05, 0.5, -0.5], 14: [0.15, 0.45, -0.25] };
const DRAWN: Record<number, P3> = { ...LEFT_OUT, 16: [0.0, 0.62, -0.05], 14: [0.25, 0.55, 0] };
const drawPath = (t0: number, ms: number, right: FrameSpec['hands']) => (tt: number): FrameSpec => {
  const k = Math.min((tt - t0) / ms, 1);
  return {
    joints: { ...LEFT_OUT, 16: lerp3(NOCK[16] as P3, DRAWN[16] as P3, k), 14: lerp3(NOCK[14] as P3, DRAWN[14] as P3, k) },
    hands: right,
  };
};
const types = (ev: InputEvent[]) => ev.map((e) => e.type);

describe('bow: the arrow stays nocked while drawing', () => {
  function nocked() {
    const ctx = engine();
    let t = run(ctx.push, 300, { joints: LEFT_OUT, hands: { left: { curl: 1 }, right: { curl: 0 } } });
    t = run(ctx.push, 400, { joints: NOCK, hands: { left: { curl: 1 }, right: { curl: 1 } } }, t);
    expect(types(ctx.events)).toContain('bow_nock');
    return { ...ctx, t };
  }

  it('right hand landmarks lost for most of the draw (hand turns sideways) → still shoots', () => {
    const { e, events, push, t: t1 } = nocked();
    let t = run(push, 600, drawPath(t1, 600, { left: { curl: 1 } }), t1); // right hand not detected while drawing
    t = run(push, 300, { joints: DRAWN, hands: { left: { curl: 1 } } }, t);
    expect(e.state.bowDraw).toBeGreaterThan(0.5);
    run(push, 200, { joints: DRAWN, hands: { left: { curl: 1 }, right: { curl: 0 } } }, t);
    expect(types(events)).toContain('bow_release');
  });

  it('grip reads half-open right after the nock (sideways hand) → arrow is not dropped', () => {
    const { e, events, push, t: t1 } = nocked();
    // Grip reads ~0.2 (below gripOff 0.35) for the first 150 ms of the draw, while draw is still small.
    let t = run(push, 150, drawPath(t1, 700, { left: { curl: 1 }, right: { curl: 0.2 } }), t1);
    t = run(push, 550, drawPath(t1, 700, { left: { curl: 1 }, right: { curl: 1 } }), t);
    t = run(push, 300, { joints: DRAWN, hands: { left: { curl: 1 }, right: { curl: 1 } } }, t);
    expect(e.state.bowDraw).toBeGreaterThan(0.5);
    run(push, 200, { joints: DRAWN, hands: { left: { curl: 1 }, right: { curl: 0 } } }, t);
    const rel = events.find((x) => x.type === 'bow_release');
    expect(rel).toBeDefined();
    if (rel?.type === 'bow_release') expect(rel.draw).toBeGreaterThan(0.5);
  });

  it('left elbow softens a little while pulling (140°) → still nocked', () => {
    const { events, push, t: t1 } = nocked();
    const soft: Record<number, P3> = { 13: [-0.12, 0.5, -0.28], 15: [0.06, 0.5, -0.43] }; // elbow ≈ 140°
    let t = run(push, 600, (tt) => ({ ...drawPath(t1, 600, { left: { curl: 1 }, right: { curl: 1 } })(tt), joints: { ...(drawPath(t1, 600, {})(tt).joints ?? {}), ...soft } }), t1);
    t = run(push, 200, { joints: { ...DRAWN, ...soft }, hands: { left: { curl: 1 }, right: { curl: 1 } } }, t);
    run(push, 200, { joints: { ...DRAWN, ...soft }, hands: { left: { curl: 1 }, right: { curl: 0 } } }, t);
    expect(types(events)).toContain('bow_release');
  });

  it('dropping the left arm still cancels the arrow (no shot), and says why', () => {
    const { e, events, push, t: t1 } = nocked();
    const t = run(push, 1500, { joints: { 16: [0.0, 0.62, -0.05], 14: [0.25, 0.55, 0] }, hands: { right: { curl: 1 } } }, t1);
    run(push, 200, { hands: { right: { curl: 0 } } }, t);
    expect(types(events)).not.toContain('bow_release');
    expect(e.gestures.debug.bowDropReason).toMatch(/left arm/);
  });
});
