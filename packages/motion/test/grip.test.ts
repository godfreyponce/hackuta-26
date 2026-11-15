import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@ithaca/shared';
import { Engine } from '../src/engine';
import { fingerCurls } from '../src/grip';
import { ASPECT, frame, run, type FrameSpec, type P3 } from './synth';

function engine() {
  const e = new Engine();
  e.aspect = ASPECT;
  const events: InputEvent[] = [];
  e.on((ev) => events.push(ev));
  e.begin();
  return { e, events, push: (f: Parameters<Engine['push']>[0]) => e.push(f, f.t) };
}
const types = (ev: InputEvent[]) => ev.map((x) => x.type);

describe('grip (C.4)', () => {
  it('curl formula: open ≈ 0, fist ≈ 1', () => {
    const open = frame(0, { hands: { right: { curl: 0 } } }).hands?.[0];
    const fist = frame(0, { hands: { right: { curl: 1 } } }).hands?.[0];
    const o = fingerCurls(open?.world ?? [], [0, 0, 0, 0]);
    const f = fingerCurls(fist?.world ?? [], [0, 0, 0, 0]);
    expect(Math.max(...o)).toBeLessThan(0.1);
    expect(Math.min(...f)).toBeGreaterThan(0.95);
  });

  it('grab on closing, release on opening, once each', () => {
    const { e, events, push } = engine();
    let t = run(push, 300, { hands: { right: { curl: 0 } } });
    expect(events.filter((x) => x.type === 'grab')).toHaveLength(0);
    t = run(push, 300, { hands: { right: { curl: 1 } } }, t);
    expect(events.filter((x) => x.type === 'grab')).toEqual([{ type: 'grab', hand: 'right' }]);
    expect(e.grip.isGripping('right')).toBe(true);
    expect(e.state.hands.right.grip).toBeGreaterThan(0.9);
    run(push, 300, { hands: { right: { curl: 0 } } }, t);
    expect(types(events).filter((x) => x === 'release')).toHaveLength(1);
  });

  it('hysteresis: hovering between 0.35 and 0.65 never toggles', () => {
    const { events, push } = engine();
    // Synthetic curl 0.4 → normalized grip ≈ 0.48; ±0.05 wobble stays inside 0.41–0.55.
    run(push, 2000, (t) => ({ hands: { right: { curl: 0.4 + 0.05 * Math.sin(t / 40) } } }));
    expect(types(events)).not.toContain('grab');
    expect(types(events)).not.toContain('release');
  });

  it('does not drop the weapon when the hand landmarker blinks out', () => {
    const { e, events, push } = engine();
    let t = run(push, 400, { hands: { right: { curl: 1 } } });
    expect(e.grip.isGripping('right')).toBe(true);
    t = run(push, 1000, { hands: {} }, t); // pose still has the wrist, hand model sees nothing
    expect(types(events)).not.toContain('release');
    expect(e.grip.isGripping('right')).toBe(true);
    expect(e.state.hands.right.grip).toBe(1);
    expect(e.state.hands.right.confidence).toBeLessThan(0.5);
    run(push, 300, { hands: { right: { curl: 1 } } }, t);
    expect(types(events)).not.toContain('release');
  });

  it('release.vel carries the throw: forward + up swing gives −Z/+Y velocity', () => {
    const { events, push } = engine();
    let t = run(push, 400, { hands: { right: { curl: 1 } } });
    // Throw: wrist travels forward (toward the camera) and up over 150 ms, hand opens at the end.
    const throwSpec = (tt: number): FrameSpec => {
      const k = Math.min((tt - t) / 150, 1);
      const wrist: P3 = [0.2, -0.05 + 0.5 * k, -0.05 - 0.5 * k];
      const elbow: P3 = [0.2, 0.22 + 0.15 * k, 0 - 0.25 * k];
      return { joints: { 16: wrist, 14: elbow }, hands: { right: { curl: k < 0.85 ? 1 : 0 } } };
    };
    t = run(push, 200, throwSpec, t);
    const rel = events.find((x) => x.type === 'release');
    expect(rel).toBeDefined();
    if (rel?.type !== 'release') return;
    expect(rel.vel.y).toBeGreaterThan(0.5);
    expect(rel.vel.z).toBeLessThan(-0.3);
  });

  it('perf mode (hands skipped) holds grip state', () => {
    const { e, events, push } = engine();
    const t = run(push, 400, { hands: { right: { curl: 1 } } });
    run(push, 500, { skipHands: true }, t);
    expect(e.grip.isGripping('right')).toBe(true);
    expect(types(events)).not.toContain('release');
  });

  // ── M1: the latch can't deadlock ──
  const FIST: FrameSpec = { hands: { right: { curl: 1 } } };
  const OPEN: FrameSpec = { hands: { right: { curl: 0 } } };

  it('resyncGrip(keep=false) with a fist held: one release, then exactly one grab within 2 hand frames', () => {
    const { e, events, push } = engine();
    let t = run(push, 400, FIST);
    expect(types(events).filter((x) => x === 'grab')).toHaveLength(1);
    events.length = 0;
    e.resyncGrip({ left: false, right: false });
    expect(events).toEqual([{ type: 'release', hand: 'right', vel: { x: 0, y: 0, z: 0 } }]);
    expect(e.grip.isGripping('right')).toBe(false);
    events.length = 0;
    for (let i = 0; i < 2; i++, t += 33) push(frame(t, FIST));
    expect(events).toEqual([{ type: 'grab', hand: 'right' }]);
    run(push, 600, FIST, t);
    expect(events).toEqual([{ type: 'grab', hand: 'right' }]);
  });

  it('resyncGrip(keep=true) keeps the latch: no events, and the next open hand releases', () => {
    const { e, events, push } = engine();
    const t = run(push, 400, FIST);
    events.length = 0;
    e.resyncGrip({ left: false, right: true });
    expect(events).toEqual([]);
    expect(e.grip.isGripping('right')).toBe(true);
    run(push, 300, OPEN, t);
    expect(types(events)).toEqual(['release']);
  });

  it('resyncGrip(keep=true) on an open hand the game holds a weapon in: releases on the next open frames', () => {
    const { e, events, push } = engine();
    const t = run(push, 300, OPEN);
    e.resyncGrip({ left: false, right: true });
    run(push, 200, OPEN, t);
    expect(types(events)).toEqual(['release']);
  });

  it('50% hand dropout: an open hand still releases within 3 hand frames', () => {
    const { e, events, push } = engine();
    let t = run(push, 400, FIST);
    events.length = 0;
    // A weakly-open reading (norm ~0.16: past gripOff but not the one-frame gripStrongOff), every other
    // hand frame missed. A miss used to reset the debounce, so this never released.
    const halfOpen: FrameSpec = { hands: { right: { curl: 0.2 } } };
    let handFrames = 0;
    while (!events.length && handFrames < 12) {
      push(frame(t, handFrames % 2 === 0 ? halfOpen : { hands: {} }));
      t += 33;
      handFrames++;
    }
    expect(types(events)).toEqual(['release']);
    expect(handFrames).toBeLessThanOrEqual(3);
    expect(e.grip.isGripping('right')).toBe(false);
  });

  it('a hand lost while gripping stays latched (no timeout) until it is seen open', () => {
    const { e, events, push } = engine();
    let t = run(push, 400, FIST);
    t = run(push, 3000, { hands: {} }, t);
    expect(e.grip.isGripping('right')).toBe(true);
    run(push, 200, OPEN, t);
    expect(types(events)).toEqual(['grab', 'release']);
  });

  it('alternate L/R frames: the skipped side holds its grip state', () => {
    const { e, events, push } = engine();
    let t = run(push, 400, { hands: { right: { curl: 1 }, left: { curl: 0 } } });
    for (let i = 0; i < 30; i++, t += 33) {
      const f = frame(t, { hands: { right: { curl: 1 }, left: { curl: 0 } } });
      // Only one side's crop runs per frame.
      const side = i % 2 ? 'left' : 'right';
      f.hands = (f.hands ?? []).filter((h) => (h.label === 'Left' ? 'left' : 'right') === side);
      f.skippedHands = [side === 'left' ? 'right' : 'left'];
      push(f);
    }
    expect(e.grip.isGripping('right')).toBe(true);
    expect(types(events)).toEqual(['grab']);
  });
});

