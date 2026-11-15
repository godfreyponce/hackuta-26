import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import { GestureGuide, GUIDE_STEPS } from '../src/lab/guide';
import { ASPECT, frame, type FrameSpec, type P3 } from './synth';

function setup() {
  const e = new Engine();
  e.aspect = ASPECT;
  e.begin();
  const results: { title: string; ok: boolean; detail: string }[] = [];
  const guide = new GestureGuide(
    { on: (cb) => e.on(cb), getState: () => e.state, getDebugGestures: () => e.detectorFlags() },
    (title, ok, detail) => results.push({ title, ok, detail }),
  );
  let t = 0;
  /** Push frames + tick the guide like the Lab's animation loop does. */
  const play = (ms: number, spec: FrameSpec | ((t: number) => FrameSpec)) => {
    const end = t + ms;
    for (; t < end; t += 1000 / 60) {
      e.push(frame(t, typeof spec === 'function' ? spec(t) : spec), t);
      guide.tick(t);
    }
  };
  return { e, guide, results, play, now: () => t };
}

const idx = (id: string) => GUIDE_STEPS.findIndex((s) => s.id === id);

describe('gesture test guide (Motion Lab)', () => {
  it('asks for every movement in order', () => {
    expect(GUIDE_STEPS.map((s) => s.id)).toEqual([
      'grab_right', 'grab_left', 'throw', 'swing', 'block', 'bow', 'drink', 'call', 'request', 'lean_left', 'lean_right', 'crouch',
    ]);
  });

  it('right-hand step: waits for the fist, then the open hand, then PASSES and moves on', () => {
    const { guide, results, play } = setup();
    play(300, {});
    guide.start(0);
    play(2000, { hands: { right: { curl: 0 } } }); // doing nothing
    expect(guide.view().current?.stage).toBe(1);
    expect(results).toHaveLength(0);
    play(400, { hands: { right: { curl: 1 } } });
    expect(guide.view().current?.stage).toBe(2);
    expect(guide.view().current?.say).toMatch(/open/i);
    play(400, { hands: { right: { curl: 0 } } });
    expect(results).toEqual([{ title: 'Right hand: fist, then open', ok: true, detail: 'grab + release fired' }]);
    expect(guide.view().current?.flash).toBe('pass');
    play(1500, { hands: { right: { curl: 0 } } });
    expect(guide.view().current?.title).toMatch(/Left hand/);
  });

  it('FAILS after the timeout with what it saw, then offers Retry / Next', () => {
    const { guide, results, play } = setup();
    play(300, {});
    guide.runStep(idx('call'));
    play(16000, { hands: { right: { curl: 1 } } }); // a fist at the hip: no phone shape
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toMatch(/Thumb and pinky out/);
    play(3000, {});
    expect(guide.currentStatus).toBe('fail');
    expect(guide.view().steps[idx('call')]?.status).toBe('fail');
    guide.next();
    expect(guide.view().current?.title).toMatch(/Request a weapon/);
  });

  it('a soft throw is a near miss with a reason, not a pass', () => {
    const { guide, results, play, now } = setup();
    play(300, {});
    guide.runStep(idx('throw'));
    play(400, { hands: { right: { curl: 1 } } });
    expect(guide.view().current?.stage).toBe(2);
    // Open the hand without moving: release with ~0 velocity.
    play(300, { hands: { right: { curl: 0 } } });
    expect(results).toHaveLength(0);
    expect(guide.view().current?.hint).toMatch(/Too soft/);
    expect(guide.view().current?.stage).toBe(1);
    // A real throw: forward + up, opening at the end.
    play(400, { hands: { right: { curl: 1 } } });
    const t0 = now();
    play(250, (tt) => {
      const k = Math.min((tt - t0) / 150, 1);
      const wrist: P3 = [0.2, -0.05 + 0.5 * k, -0.05 - 0.5 * k];
      const elbow: P3 = [0.2, 0.22 + 0.15 * k, -0.25 * k];
      return { joints: { 16: wrist, 14: elbow }, hands: { right: { curl: k < 0.85 ? 1 : 0 } } };
    });
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.detail).toMatch(/m\/s/);
  });

  it('pauses the clock while the player is out of frame', () => {
    const { guide, results, play } = setup();
    play(300, {});
    guide.runStep(idx('crouch'));
    play(20000, { noPose: true });
    expect(results).toHaveLength(0);
    expect(guide.view().current?.paused).toBe(true);
  });

  it('skip marks the step skipped and moves on', () => {
    const { guide, play } = setup();
    play(300, {});
    guide.start(0);
    guide.skip();
    expect(guide.view().steps[0]?.status).toBe('skipped');
    expect(guide.view().current?.title).toMatch(/Left hand/);
  });
});
