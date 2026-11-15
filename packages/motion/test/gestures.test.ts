import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@ithaca/shared';
import { Engine } from '../src/engine';
import { ASPECT, NEUTRAL, run, type FrameSpec, type P3 } from './synth';

function engine() {
  const e = new Engine();
  e.aspect = ASPECT;
  const events: InputEvent[] = [];
  e.on((ev) => events.push(ev));
  e.begin();
  return { e, events, push: (f: Parameters<Engine['push']>[0]) => e.push(f, f.t) };
}
const count = (ev: InputEvent[], type: InputEvent['type']) => ev.filter((x) => x.type === type).length;

// Right hand up by the right ear, forearm angled in.
const BY_EAR: Record<number, P3> = { 16: [0.1, 0.62, 0], 14: [0.25, 0.4, 0] };
const PHONE: FrameSpec = { joints: BY_EAR, hands: { right: { curl: [1, 1, 1, 0], thumbOut: true } } };
const ARMS_UP: Record<number, P3> = { 15: [-0.15, 0.95, 0], 16: [0.15, 0.95, 0], 13: [-0.2, 0.72, 0], 14: [0.2, 0.72, 0] };

describe('call_sign (C.5)', () => {
  it('fires after a 1 s hold, with progress exposed, then cools down for 5 s', () => {
    const { e, events, push } = engine();
    let t = run(push, 300, {});
    t = run(push, 500, PHONE, t);
    expect(count(events, 'call_sign')).toBe(0);
    const pg = e.getPendingGesture();
    expect(pg?.name).toBe('call_sign');
    expect(pg?.progress).toBeGreaterThan(0.4);
    t = run(push, 600, PHONE, t);
    expect(count(events, 'call_sign')).toBe(1);
    // Keep holding: no repeat; drop and redo inside the cooldown: still no repeat.
    t = run(push, 1500, PHONE, t);
    t = run(push, 300, {}, t);
    t = run(push, 1500, PHONE, t);
    expect(count(events, 'call_sign')).toBe(1);
    // After the cooldown, a fresh hold fires again.
    t = run(push, 2000, {}, t);
    run(push, 1200, PHONE, t);
    expect(count(events, 'call_sign')).toBe(2);
  });

  it('needs the phone shape: a fist by the ear does nothing', () => {
    const { events, push } = engine();
    run(push, 2000, { joints: BY_EAR, hands: { right: { curl: 1 } } });
    expect(count(events, 'call_sign')).toBe(0);
  });

  it('needs to be by the ear: phone shape at the hip does nothing', () => {
    const { events, push } = engine();
    run(push, 2000, { hands: { right: { curl: [1, 1, 1, 0], thumbOut: true } } });
    expect(count(events, 'call_sign')).toBe(0);
  });

  it('survives a short hand-tracking blip', () => {
    const { events, push } = engine();
    let t = run(push, 600, PHONE);
    t = run(push, 80, { joints: BY_EAR, hands: {} }, t);
    run(push, 500, PHONE, t);
    expect(count(events, 'call_sign')).toBe(1);
  });
});

describe('request_weapon (C.5)', () => {
  it('both arms overhead for 0.8 s fires once; 4 s cooldown', () => {
    const { e, events, push } = engine();
    let t = run(push, 300, {});
    t = run(push, 700, { joints: ARMS_UP }, t);
    expect(count(events, 'request_weapon')).toBe(0);
    expect(e.getPendingGesture()?.name).toBe('request_weapon');
    t = run(push, 200, { joints: ARMS_UP }, t);
    expect(count(events, 'request_weapon')).toBe(1);
    t = run(push, 300, {}, t);
    t = run(push, 1000, { joints: ARMS_UP }, t);
    expect(count(events, 'request_weapon')).toBe(1);
    t = run(push, 3000, {}, t);
    run(push, 1000, { joints: ARMS_UP }, t);
    expect(count(events, 'request_weapon')).toBe(2);
  });

  it('one arm up is not enough', () => {
    const { events, push } = engine();
    run(push, 2000, { joints: { 16: [0.15, 0.95, 0], 14: [0.2, 0.72, 0] } });
    expect(count(events, 'request_weapon')).toBe(0);
  });
});

describe('swing (C.5)', () => {
  it('fast gripped sweep fires one swing; re-arms after slowing down', () => {
    const { events, push } = engine();
    const REST = { joints: { 16: [0.3, 0.3, -0.3] as P3, 14: [0.3, 0.25, -0.1] as P3 }, hands: { right: { curl: 1 } } };
    let t = run(push, 600, REST);
    expect(count(events, 'swing')).toBe(0);
    const sweep = (start: number) => (tt: number): FrameSpec => {
      const k = Math.min((tt - start) / 150, 1); // 0.45 m in 150 ms = 3 m/s
      return { joints: { 16: [0.3 - 0.45 * k, 0.3, -0.3], 14: [0.3 - 0.2 * k, 0.25, -0.1] }, hands: { right: { curl: 1 } } };
    };
    const s1 = t;
    t = run(push, 400, sweep(s1), t);
    expect(count(events, 'swing')).toBe(1);
    const sw = events.find((x) => x.type === 'swing');
    if (sw?.type === 'swing') {
      expect(sw.hand).toBe('right');
      expect(sw.dir.x).toBeLessThan(-0.7); // swept toward the player's left
      expect(sw.speed).toBeGreaterThan(2.2);
    }
    // Slow back, then sweep again.
    const back = t;
    t = run(push, 900, (tt) => {
      const k = Math.min((tt - back) / 900, 1); // ~0.6 m/s: no swing
      return { joints: { 16: [-0.15 + 0.45 * k, 0.3, -0.3] as P3, 14: [0.1 + 0.2 * k, 0.25, -0.1] as P3 }, hands: { right: { curl: 1 } } };
    }, t);
    expect(count(events, 'swing')).toBe(1);
    t = run(push, 300, REST, t);
    const s2 = t;
    run(push, 400, sweep(s2), t);
    expect(count(events, 'swing')).toBe(2);
  });

  it('open hand does not swing', () => {
    const { events, push } = engine();
    const t = run(push, 600, { joints: { 16: [0.3, 0.3, -0.3] }, hands: { right: { curl: 0 } } });
    run(push, 300, (tt) => ({ joints: { 16: [0.3 - 3 * ((tt - t) / 1000), 0.3, -0.3] }, hands: { right: { curl: 0 } } }), t);
    expect(count(events, 'swing')).toBe(0);
  });
});

const GUARD: Record<number, P3> = {
  15: [-0.1, 0.7, -0.3], 16: [0.1, 0.7, -0.3],
  13: [-0.3, 0.65, -0.2], 14: [0.3, 0.65, -0.2],
};

describe('block (C.5)', () => {
  it('block_start after 150 ms in guard, block_end 200 ms after breaking it', () => {
    const { events, push } = engine();
    let t = run(push, 300, {});
    t = run(push, 100, { joints: GUARD }, t);
    expect(count(events, 'block_start')).toBe(0);
    t = run(push, 400, { joints: GUARD }, t);
    expect(count(events, 'block_start')).toBe(1);
    t = run(push, 100, {}, t); // brief break: still blocking
    t = run(push, 200, { joints: GUARD }, t);
    expect(count(events, 'block_end')).toBe(0);
    run(push, 600, {}, t);
    expect(count(events, 'block_end')).toBe(1);
    expect(count(events, 'block_start')).toBe(1);
  });
});

describe('drink (C.5)', () => {
  const AT_MOUTH: Record<number, P3> = { 16: [0.05, 0.6, -0.1], 14: [0.2, 0.35, -0.05] };
  const REST: Record<number, P3> = { 16: NEUTRAL[16] as P3, 14: NEUTRAL[14] as P3 };
  const lerp = (a: P3, b: P3, k: number): P3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const FIST = { right: { curl: 1 } };
  /** The right fist brought from the hip to the mouth over `ms` (a real lift: ~1.5 m/s, not a teleport). */
  const lift = (start: number, ms = 450, to: Record<number, P3> = AT_MOUTH) => (tt: number): FrameSpec => {
    const k = Math.min((tt - start) / ms, 1);
    return { joints: { 16: lerp(REST[16]!, to[16]!, k), 14: lerp(REST[14]!, to[14]!, k) }, hands: FIST };
  };

  it('gripping hand held at the mouth for 600 ms fires once', () => {
    const { events, push } = engine();
    let t = run(push, 400, { hands: FIST });
    const s1 = t;
    t = run(push, 450, lift(s1), t);
    t = run(push, 450, { joints: AT_MOUTH, hands: FIST }, t);
    expect(count(events, 'drink')).toBe(0);
    t = run(push, 1500, { joints: AT_MOUTH, hands: FIST }, t);
    expect(count(events, 'drink')).toBe(1);
    // Leave and come back: drinks again.
    t = run(push, 400, { hands: FIST }, t);
    const s2 = t;
    t = run(push, 450, lift(s2), t);
    run(push, 900, { joints: AT_MOUTH, hands: FIST }, t);
    expect(count(events, 'drink')).toBe(2);
  });

  it('open hand at the mouth does not drink', () => {
    const { events, push } = engine();
    run(push, 2000, { joints: AT_MOUTH, hands: { right: { curl: 0 } } });
    expect(count(events, 'drink')).toBe(0);
  });

  it('both fists up by the face (a guard / block) is not a drink', () => {
    const { events, push } = engine();
    const BOTH_AT_FACE: Record<number, P3> = { 15: [-0.1, 0.62, -0.25], 16: [0.06, 0.6, -0.2], 13: [-0.3, 0.55, -0.15], 14: [0.25, 0.45, -0.1] };
    run(push, 2500, { joints: BOTH_AT_FACE, hands: { left: { curl: 1 }, right: { curl: 1 } } });
    expect(count(events, 'drink')).toBe(0);
    const { events: ev2, push: push2 } = engine();
    run(push2, 2500, { joints: GUARD, hands: { left: { curl: 1 }, right: { curl: 1 } } });
    expect(count(ev2, 'block_start')).toBe(1);
    expect(count(ev2, 'drink')).toBe(0);
  });

  it('a fist moving by the face mid-fight is not a drink', () => {
    const { events, push } = engine();
    // the right fist shakes ±5 cm about the mouth three times a second (~1 m/s): never leaves drinking range
    run(push, 3000, (tt) => {
      const k = Math.sin((tt / 160) * Math.PI);
      return { joints: { 16: [0.05 + 0.05 * k, 0.6, -0.1], 14: [0.2 + 0.02 * k, 0.35, -0.05] }, hands: FIST };
    });
    expect(count(events, 'drink')).toBe(0);
  });

  it('a fist held 0.1 m off the mouth (bow anchor at the cheek) is not a drink', () => {
    const { events, push } = engine();
    // palm centre ≈ (0.11, 0.68): 0.11 m from the mouth
    run(push, 2500, { joints: { 16: [0.15, 0.62, -0.1], 14: [0.3, 0.38, -0.05] }, hands: FIST });
    expect(count(events, 'drink')).toBe(0);
  });

  it('no drink while a bow is nocked, even with the draw hand at the mouth', () => {
    const { events, push } = engine();
    const LEFT_OUT: Record<number, P3> = { 13: [-0.12, 0.5, -0.28], 15: [-0.08, 0.5, -0.56] };
    const both = { left: { curl: 1 }, right: { curl: 1 } };
    let t = run(push, 300, { joints: LEFT_OUT, hands: { left: { curl: 1 }, right: { curl: 0 } } });
    t = run(push, 300, { joints: { ...LEFT_OUT, 16: [-0.05, 0.5, -0.5], 14: [0.15, 0.45, -0.25] }, hands: both }, t);
    expect(count(events, 'bow_nock')).toBe(1);
    run(push, 2000, { joints: { ...LEFT_OUT, ...AT_MOUTH }, hands: both }, t);
    expect(count(events, 'drink')).toBe(0);
  });
});

describe('bow (C.5)', () => {
  const LEFT_OUT: Record<number, P3> = { 13: [-0.12, 0.5, -0.28], 15: [-0.08, 0.5, -0.56] };
  const NOCK: Record<number, P3> = { ...LEFT_OUT, 16: [-0.05, 0.5, -0.5], 14: [0.15, 0.45, -0.25] };
  const DRAWN: Record<number, P3> = { ...LEFT_OUT, 16: [0.0, 0.62, -0.05], 14: [0.25, 0.55, 0] };
  const both = (curlR: number) => ({ left: { curl: 1 }, right: { curl: curlR } });

  it('nock → draw → release fires bow_release with draw and a forward aim', () => {
    const { e, events, push } = engine();
    let t = run(push, 300, { joints: LEFT_OUT, hands: both(0) });
    t = run(push, 300, { joints: NOCK, hands: both(1) }, t);
    expect(count(events, 'bow_nock')).toBe(1);
    t = run(push, 500, { joints: DRAWN, hands: both(1) }, t);
    expect(e.state.bowDraw).toBeGreaterThan(0.5);
    run(push, 200, { joints: DRAWN, hands: both(0) }, t);
    const rel = events.find((x) => x.type === 'bow_release');
    expect(rel).toBeDefined();
    if (rel?.type === 'bow_release') {
      expect(rel.draw).toBeGreaterThan(0.5);
      expect(rel.aim.z).toBeLessThan(-0.8);
    }
    expect(e.state.bowDraw).toBe(0);
  });

  it('releasing without drawing does not shoot', () => {
    const { events, push } = engine();
    let t = run(push, 300, { joints: LEFT_OUT, hands: both(0) });
    t = run(push, 1000, { joints: NOCK, hands: both(1) }, t);
    run(push, 300, { joints: NOCK, hands: both(0) }, t);
    expect(count(events, 'bow_nock')).toBe(1);
    expect(count(events, 'bow_release')).toBe(0);
  });

  it('no nock unless the left arm is extended', () => {
    const { events, push } = engine();
    run(push, 1000, { joints: { 16: [-0.15, -0.05, -0.1], 14: [0.1, 0.2, -0.05] }, hands: both(1) });
    expect(count(events, 'bow_nock')).toBe(0);
  });
});
