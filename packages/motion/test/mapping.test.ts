import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine';
import { OneEuro } from '../src/oneEuro';
import type { InputEvent } from '@ithaca/shared';
import { ASPECT, NEUTRAL, run, type P3 } from './synth';

function engine() {
  const e = new Engine();
  e.aspect = ASPECT;
  const events: InputEvent[] = [];
  e.on((ev) => events.push(ev));
  e.begin();
  return { e, events, push: (f: Parameters<Engine['push']>[0]) => e.push(f, f.t) };
}

describe('OneEuro', () => {
  it('converges to a constant and smooths noise', () => {
    const f = new OneEuro(1, 0.02);
    let v = 0;
    for (let i = 0; i < 300; i++) v = f.filter(1 + (i % 2 ? 0.05 : -0.05), 1 / 60);
    expect(Math.abs(v - 1)).toBeLessThan(0.03);
  });
});

describe('mapping (C.3)', () => {
  it('un-mirrors hands: the player\'s right hand is on +X', () => {
    const { e, push } = engine();
    run(push, 500, { hands: { left: {}, right: {} } });
    const s = e.getState(e.state.t);
    expect(s.tracking).toBe('ok');
    expect(s.hands.right.visible).toBe(true);
    expect(s.hands.right.pos.x).toBeGreaterThan(0.1);
    expect(s.hands.left.pos.x).toBeLessThan(-0.1);
    // Hands at the hips are well below the eyes.
    expect(s.hands.right.pos.y).toBeLessThan(-0.5);
    expect(s.hands.right.pos.z).toBeLessThanOrEqual(-0.15);
    expect(s.hands.right.pos.z).toBeGreaterThanOrEqual(-0.85);
  });

  it('reaching toward the camera moves the hand forward (−Z), raising moves it up', () => {
    const { e, push } = engine();
    run(push, 500, {});
    const z0 = e.state.hands.right.pos.z;
    const y0 = e.state.hands.right.pos.y;
    // Right arm straight forward at shoulder height: elbow and wrist toward the camera.
    const reach: Record<number, P3> = { 14: [0.18, 0.5, -0.28], 16: [0.18, 0.5, -0.55] };
    run(push, 1000, { joints: reach }, 500);
    const s = e.state.hands.right;
    expect(s.pos.z).toBeLessThan(z0 - 0.2);
    expect(s.pos.y).toBeGreaterThan(y0 + 0.3);
    // forward points along the forearm: into the screen.
    expect(s.forward.z).toBeLessThan(-0.8);
  });

  it('associates hands to pose wrists even when MediaPipe labels are wrong', () => {
    const { e, push } = engine();
    // Only the right hand is detected, and it is open (curl 0).
    run(push, 300, { hands: { right: { curl: 0 } } });
    expect(e.body.hand.right).not.toBeNull();
    expect(e.body.hand.left).toBeNull();
  });

  it('back-of-hand normal: right palm facing the camera → up points back at the player (+Z)', () => {
    const { e, push } = engine();
    run(push, 300, { hands: { right: {}, left: {} } });
    expect(e.state.hands.right.up.z).toBeGreaterThan(0.5);
    expect(e.state.hands.left.up.z).toBeGreaterThan(0.5);
  });

  it('lean follows a sideways step; crouch follows a drop', () => {
    const { e, push } = engine();
    run(push, 600, {});
    expect(Math.abs(e.state.body.lean)).toBeLessThan(0.05);
    run(push, 600, { offset: [0.15, 0, 0] }, 600); // step to the player's right
    expect(e.state.body.lean).toBeGreaterThan(0.5);
    run(push, 600, { offset: [0, -0.3, 0] }, 1200);
    expect(e.state.body.crouch).toBeGreaterThan(0.5);
  });

  it('yaw: turning right (left shoulder forward) is negative', () => {
    const { e, push } = engine();
    run(push, 400, { joints: { 11: [-0.15, 0.5, -0.08], 12: [0.15, 0.5, 0.08] } });
    expect(e.state.body.yaw).toBeLessThan(-0.2);
  });

  it('tracking_lost after 500 ms without a pose, tracking_ok 300 ms after it returns', () => {
    const { e, events, push } = engine();
    let t = run(push, 300, {});
    t = run(push, 450, { noPose: true }, t);
    expect(events.map((x) => x.type)).not.toContain('tracking_lost');
    t = run(push, 100, { noPose: true }, t);
    expect(events.map((x) => x.type)).toContain('tracking_lost');
    expect(e.state.tracking).toBe('lost');
    t = run(push, 250, {}, t);
    expect(events.map((x) => x.type)).not.toContain('tracking_ok');
    run(push, 100, {}, t);
    expect(events.map((x) => x.type)).toContain('tracking_ok');
  });

  it('extrapolates getState ≤ 50 ms along velocity', () => {
    const { e, push } = engine();
    // Hand moving right at 1 m/s (player space).
    const t = run(push, 500, (tt) => ({ joints: { 16: [0.2 + (tt / 1000) * 1.0, -0.05, -0.05] as P3, 14: [0.2 + (tt / 1000) * 0.5, 0.22, 0] as P3 } }));
    const at = e.state.hands.right.pos.x;
    const later = e.getState(t + 200).hands.right.pos.x; // capped at 50 ms
    const vx = e.state.hands.right.vel.x;
    expect(vx).toBeGreaterThan(0.5);
    expect(later - at).toBeCloseTo(vx * 0.05, 3);
  });

  it('M4: a fresh, confident hand keeps a low-visibility wrist visible; without it the hand hides', () => {
    const { e, push } = engine();
    run(push, 300, { hands: { right: {} }, occlude: [16] }); // pose wrist visibility 0.2 < 0.3
    expect(e.state.hands.right.visible).toBe(true);
    run(push, 100, { occlude: [16] }, 300);
    expect(e.state.hands.right.visible).toBe(false);
  });

  it('uses NEUTRAL as the resting pose', () => {
    expect(NEUTRAL[16]?.[0]).toBeGreaterThan(0);
  });
});
