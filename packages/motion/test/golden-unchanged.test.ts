// Golden regression: the 10 moves that passed the Lab gesture test, plus calibration, must produce
// exactly the same events (type, hand, frame time, swing speed/dir) as before the throw/bow fix.
// The snapshot was recorded on the pre-fix code (commit 8765147). The grab/release, sword swing and drink
// snapshots were refreshed for the fused-curl grip (M3): same events, 17-67 ms earlier (hysteresis now runs on
// the unfiltered grip, and a clear reading fires on its first frame).
import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@ithaca/shared';
import { Engine } from '../src/engine';
import { ASPECT, run, type FrameSpec, type P3 } from './synth';

function session(script: (push: (f: Parameters<Engine['push']>[0]) => void, e: Engine) => void) {
  const e = new Engine();
  e.aspect = ASPECT;
  const out: string[] = [];
  let now = 0;
  e.on((ev: InputEvent) => {
    const extra =
      ev.type === 'swing' ? ` ${ev.speed.toFixed(3)} ${ev.dir.x.toFixed(3)},${ev.dir.y.toFixed(3)},${ev.dir.z.toFixed(3)}` : '';
    out.push(`${now.toFixed(0)} ${ev.type}${'hand' in ev ? ' ' + ev.hand : ''}${extra}`);
  });
  e.begin();
  script((f) => {
    now = f.t;
    e.push(f, f.t);
  }, e);
  return { events: out, engine: e };
}

const lerp3 = (a: P3, b: P3, k: number): P3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const GUARD: Record<number, P3> = { 15: [-0.1, 0.7, -0.3], 16: [0.1, 0.7, -0.3], 13: [-0.3, 0.65, -0.2], 14: [0.3, 0.65, -0.2] };
const BY_EAR: Record<number, P3> = { 16: [0.1, 0.62, 0], 14: [0.25, 0.4, 0] };
const ARMS_UP: Record<number, P3> = { 15: [-0.15, 0.95, 0], 16: [0.15, 0.95, 0], 13: [-0.2, 0.72, 0], 14: [0.2, 0.72, 0] };
const AT_MOUTH: Record<number, P3> = { 16: [0.05, 0.6, -0.1], 14: [0.2, 0.35, -0.05] };
const BOW_SIDE: Record<number, P3> = { 13: [-0.45, 0.5, 0], 15: [-0.73, 0.5, 0] };

describe('golden: passing moves and calibration are unchanged', () => {
  it('right + left grab/release', () => {
    const { events } = session((push) => {
      let t = run(push, 300, { hands: { right: { curl: 0 }, left: { curl: 0 } } });
      t = run(push, 400, { hands: { right: { curl: 1 }, left: { curl: 0 } } }, t);
      t = run(push, 400, { hands: { right: { curl: 0 }, left: { curl: 0 } } }, t);
      t = run(push, 400, { hands: { right: { curl: 0 }, left: { curl: 1 } } }, t);
      run(push, 400, { hands: { right: { curl: 0 }, left: { curl: 0 } } }, t);
    });
    expect(events).toMatchSnapshot();
  });

  it('sword swing', () => {
    const { events } = session((push) => {
      const REST: FrameSpec = { joints: { 16: [0.3, 0.3, -0.3], 14: [0.3, 0.25, -0.1] }, hands: { right: { curl: 1 } } };
      let t = run(push, 600, REST);
      const s = t;
      t = run(push, 400, (tt) => {
        const k = Math.min((tt - s) / 150, 1);
        return { joints: { 16: [0.3 - 0.45 * k, 0.3, -0.3], 14: [0.3 - 0.2 * k, 0.25, -0.1] }, hands: { right: { curl: 1 } } };
      }, t);
      run(push, 400, { joints: { 16: [-0.15, 0.3, -0.3], 14: [0.1, 0.25, -0.1] }, hands: { right: { curl: 1 } } }, t);
    });
    expect(events).toMatchSnapshot();
  });

  it('block', () => {
    const { events } = session((push) => {
      let t = run(push, 300, {});
      t = run(push, 600, { joints: GUARD }, t);
      run(push, 600, {}, t);
    });
    expect(events).toMatchSnapshot();
  });

  it('drink', () => {
    const { events } = session((push) => {
      let t = run(push, 400, { hands: { right: { curl: 1 } } });
      t = run(push, 1000, { joints: AT_MOUTH, hands: { right: { curl: 1 } } }, t);
      run(push, 400, { hands: { right: { curl: 1 } } }, t);
    });
    expect(events).toMatchSnapshot();
  });

  it('call sign', () => {
    const { events } = session((push) => {
      let t = run(push, 300, {});
      run(push, 1500, { joints: BY_EAR, hands: { right: { curl: [1, 1, 1, 0], thumbOut: true } } }, t);
    });
    expect(events).toMatchSnapshot();
  });

  it('request weapon', () => {
    const { events } = session((push) => {
      let t = run(push, 300, {});
      t = run(push, 1200, { joints: ARMS_UP }, t);
      run(push, 300, {}, t);
    });
    expect(events).toMatchSnapshot();
  });

  it('dodge left / right and crouch (body state)', () => {
    const samples: string[] = [];
    session((push, e) => {
      let t = run(push, 600, {});
      for (const [off, ms] of [[[-0.15, 0, 0], 600], [[0.15, 0, 0], 600], [[0, -0.3, 0], 600]] as [P3, number][]) {
        t = run(push, ms, { offset: off }, t);
        const b = e.state.body;
        samples.push(`${b.lean.toFixed(4)} ${b.crouch.toFixed(4)} ${b.yaw.toFixed(4)}`);
      }
    });
    expect(samples).toMatchSnapshot();
  });

  it('calibration: steps and measured profile', async () => {
    let profile = '';
    const steps: string[] = [];
    await new Promise<void>((resolve) => {
      session((push, e) => {
        e.onCalibrationStep((s) => {
          const key = `${s.step}`;
          if (steps[steps.length - 1] !== key) steps.push(key);
        });
        void e.calibrate().then(() => resolve());
        let t = run(push, 1000, {});
        t = run(push, 3000, { joints: GUARD }, t);
        t = run(push, 2000, { joints: BOW_SIDE }, t);
        run(push, 4000, (tt): FrameSpec => {
          const c = Math.floor(tt / 500) % 2 ? 1 : 0;
          return { hands: { left: { curl: c }, right: { curl: c } } };
        }, t);
        const p = e.profile;
        profile = JSON.stringify(p, (_k, v: unknown) => (typeof v === 'number' ? Number(v.toFixed(4)) : v));
      });
    });
    expect(steps).toMatchSnapshot();
    expect(profile).toMatchSnapshot();
  });

  it('hand positions over a reach (mapping/filters untouched)', () => {
    const samples: string[] = [];
    session((push, e) => {
      let t = run(push, 400, {});
      const s = t;
      t = run(push, 600, (tt) => ({ joints: { 16: lerp3([0.2, -0.05, -0.05], [0.18, 0.5, -0.55], Math.min((tt - s) / 300, 1)), 14: [0.18, 0.4, -0.25] as P3 } }), t);
      const h = e.state.hands.right;
      samples.push(`${h.pos.x.toFixed(4)} ${h.pos.y.toFixed(4)} ${h.pos.z.toFixed(4)} ${h.vel.x.toFixed(4)} ${h.vel.y.toFixed(4)} ${h.vel.z.toFixed(4)}`);
    });
    expect(samples).toMatchSnapshot();
  });
});
