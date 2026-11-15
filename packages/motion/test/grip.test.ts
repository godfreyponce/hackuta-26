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
});
