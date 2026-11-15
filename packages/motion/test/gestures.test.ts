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
