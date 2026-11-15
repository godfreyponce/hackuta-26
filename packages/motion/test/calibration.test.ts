import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@ithaca/shared';
import { Engine } from '../src/engine';
import type { CalibrationStep } from '../src/types';
import type { Profile } from '../src/profile';
import { ASPECT, run, type FrameSpec, type P3 } from './synth';

function engine() {
  const e = new Engine();
  e.aspect = ASPECT;
  const events: InputEvent[] = [];
  e.on((ev) => events.push(ev));
  e.begin();
  return { e, events, push: (f: Parameters<Engine['push']>[0]) => e.push(f, f.t) };
}

const GUARD: Record<number, P3> = { 15: [-0.1, 0.7, -0.3], 16: [0.1, 0.7, -0.3], 13: [-0.3, 0.65, -0.2], 14: [0.3, 0.65, -0.2] };
// Left arm straight out to the side: upper arm 0.28 m, forearm 0.28 m.
const BOW_SIDE: Record<number, P3> = { 13: [-0.45, 0.5, 0], 15: [-0.73, 0.5, 0] };

describe('calibration (C.6)', () => {
  it('walks all four steps, measures the body, mutes gameplay events, and stays under 20 s', async () => {
    const { e, events, push } = engine();
    const steps: CalibrationStep[] = [];
    e.onCalibrationStep((s) => steps.push(s));
    let saved: Profile | null = null;
    e.onProfileChange = (p) => {
      saved = p;
    };
    const done = e.calibrate();
    expect(e.state.tracking).toBe('calibrating');

    let t = run(push, 600, {});
    t = run(push, 3200, { joints: GUARD }, t);
    t = run(push, 1500, { joints: BOW_SIDE }, t);
    // Fist/open both hands, 0.5 s each.
    t = run(push, 4200, (tt): FrameSpec => {
      const c = Math.floor(tt / 500) % 2 ? 1 : 0;
      return { hands: { left: { curl: c }, right: { curl: c } } };
    }, t);
    const res = await done;

    expect(res.ok).toBe(true);
    expect(t).toBeLessThan(20000);
    const names = [...new Set(steps.map((s) => s.step))];
    expect(names).toEqual(['step_back', 'guard', 'bow', 'grip', 'done']);
    expect(res.armLengthM).toBeCloseTo(0.56, 1);
    expect(res.shoulderWidthM).toBeCloseTo(0.34, 2);
    expect(saved).not.toBeNull();
    expect(e.profile.calibrated).toBe(true);
    expect(e.profile.forearmImgRatio).toBeCloseTo(0.28 / 0.34, 1);
    expect(e.profile.grip.right.max - e.profile.grip.right.min).toBeGreaterThan(0.5);
    // Guard pose and fists during calibration must not leak block/grab to the game.
    const leaked = events.filter((x) => x.type !== 'tracking_ok' && x.type !== 'tracking_lost');
    expect(leaked).toEqual([]);
    // Tracking resumes normally afterwards, with no unpaired release from muted grabs.
    t = run(push, 600, { hands: { left: { curl: 0 }, right: { curl: 0 } } }, t);
    expect(e.state.tracking).toBe('ok');
    expect(events.filter((x) => x.type === 'release')).toEqual([]);
    run(push, 300, { hands: { right: { curl: 1 } } }, t);
    expect(events.filter((x) => x.type === 'grab')).toHaveLength(1);
  });

  it('times out with ok:false and keeps the old profile', async () => {
    const { e, push } = engine();
    const before = JSON.stringify(e.profile);
    const done = e.calibrate();
    run(push, 31000, { noPose: true }, 0, 30);
    const res = await done;
    expect(res.ok).toBe(false);
    expect(JSON.stringify(e.profile)).toBe(before);
  });

  it('releases a held weapon when calibration starts', async () => {
    const { e, events, push } = engine();
    const t = run(push, 400, { hands: { right: { curl: 1 } } });
    expect(events.filter((x) => x.type === 'grab')).toHaveLength(1);
    const done = e.calibrate();
    expect(events.filter((x) => x.type === 'release')).toHaveLength(1);
    run(push, 100, {}, t);
    e.end();
    await done;
  });

  it('end() cancels an in-flight calibration', async () => {
    const { e, push } = engine();
    const done = e.calibrate();
    run(push, 300, {});
    e.end();
    expect((await done).ok).toBe(false);
    expect(e.state.tracking).toBe('off');
  });
});
