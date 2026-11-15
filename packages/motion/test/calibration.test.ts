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
    let eventsAtDone = -1;
    e.onCalibrationStep((s) => {
      steps.push(s);
      if (s.step === 'done') eventsAtDone = events.length;
    });
    let saved: Profile | null = null;
    e.onProfileChange = (p) => {
      saved = p;
    };
    const done = e.calibrate();
    expect(e.state.tracking).toBe('calibrating');

    let t = run(push, 1000, {});
    t = run(push, 3000, { joints: GUARD }, t);
    t = run(push, 2000, { joints: BOW_SIDE }, t);
    // Fist/open both hands, 0.5 s each.
    t = run(push, 4000, (tt): FrameSpec => {
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
    const leaked = events.slice(0, eventsAtDone).filter((x) => x.type !== 'tracking_ok' && x.type !== 'tracking_lost');
    expect(leaked).toEqual([]);
    // Tracking resumes normally afterwards, with no unpaired release from muted grabs:
    // after calibration, every release must follow a grab of the same hand.
    t = run(push, 600, { hands: { left: { curl: 0 }, right: { curl: 0 } } }, t);
    expect(e.state.tracking).toBe('ok');
    run(push, 300, { hands: { right: { curl: 1 } } }, t);
    const held = { left: false, right: false };
    for (const ev of events.slice(eventsAtDone)) {
      if (ev.type === 'grab') held[ev.hand] = true;
      if (ev.type === 'release') {
        expect(held[ev.hand], `unpaired release (${ev.hand})`).toBe(true);
        held[ev.hand] = false;
      }
    }
    expect(held.right).toBe(true);
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

describe('calibration waits for the actual movement', () => {
  const stepsOf = (e: Engine) => {
    const steps: CalibrationStep[] = [];
    e.onCalibrationStep((s) => steps.push(s));
    return steps;
  };

  it('guard does not advance with hands down, and says why', () => {
    const { e, push } = engine();
    const steps = stepsOf(e);
    void e.calibrate();
    run(push, 6000, {}); // hips visible, but hands at the sides
    const last = steps[steps.length - 1];
    expect(last?.step).toBe('guard');
    expect(last?.passed).toEqual(['step_back']);
    expect(last?.hint).toMatch(/Raise your (left|right) fist/);
    expect(last?.progress).toBe(0);
    e.end();
  });

  it('bow does not advance with the arm hanging straight down', () => {
    const { e, push } = engine();
    const steps = stepsOf(e);
    void e.calibrate();
    let t = run(push, 1000, {});
    t = run(push, 3000, { joints: GUARD }, t);
    run(push, 5000, { joints: { 13: [-0.2, 0.22, 0], 15: [-0.2, -0.06, 0] } }, t); // straight, but down
    const last = steps[steps.length - 1];
    expect(last?.step).toBe('bow');
    expect(last?.hint).toMatch(/LEFT side|shoulder height/);
    e.end();
  });

  it('grip needs real fist→open cycles; open hands alone never finish it', () => {
    const { e, push } = engine();
    const steps = stepsOf(e);
    void e.calibrate();
    let t = run(push, 1000, {});
    t = run(push, 3000, { joints: GUARD }, t);
    t = run(push, 2000, { joints: BOW_SIDE }, t);
    run(push, 8000, { hands: { left: { curl: 0 }, right: { curl: 0 } } }, t);
    const last = steps[steps.length - 1];
    expect(last?.step).toBe('grip');
    expect(last?.progress).toBe(0);
    expect(last?.hint).toMatch(/fist/);
    e.end();
  });

  it('fails with the step and reason when a movement is never seen', async () => {
    const { e, push } = engine();
    const steps = stepsOf(e);
    const done = e.calibrate();
    run(push, 17000, {}, 0, 30);
    expect((await done).ok).toBe(false);
    const last = steps[steps.length - 1];
    expect(last?.step).toBe('failed');
    expect(last?.failedStep).toBe('guard');
    expect(last?.failedReason).toMatch(/fist/);
  });
});
