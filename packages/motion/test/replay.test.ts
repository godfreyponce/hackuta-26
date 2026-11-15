import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputEvent } from '@ithaca/shared';
import { Engine } from '../src/engine';
import { parseRecording, Recorder, runReplay } from '../src/recording';
import { createReplayController } from '../src/replay';
import type { Recording } from '../src/types';
import { ASPECT, frame, type FrameSpec } from './synth';

/** Synthetic "grab, hold, open" session recorded through the real Recorder. */
function makeRecording(): Recording {
  const rec = new Recorder();
  rec.start({ label: 'grab-test', aspect: ASPECT, width: 1280, height: 720 });
  for (let t = 0; t < 1500; t += 1000 / 60) {
    const spec: FrameSpec = { hands: { right: { curl: t > 500 && t < 1000 ? 1 : 0 } } };
    rec.push(frame(5000 + t, spec)); // arbitrary start time: recorder rebases to 0
  }
  const out = rec.stop();
  if (!out) throw new Error('no recording');
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('recording + replay (C.7)', () => {
  it('round-trips through JSON and rebases time to 0', () => {
    const rec = makeRecording();
    const again = parseRecording(JSON.stringify(rec));
    expect(again.frames[0]?.t).toBe(0);
    expect(again.frames.length).toBe(rec.frames.length);
    expect(again.meta.label).toBe('grab-test');
  });

  it('rejects things that are not recordings', () => {
    expect(() => parseRecording('{"hello":1}')).toThrow(/recording/);
  });

  it('runReplay is deterministic and matches live processing', () => {
    const rec = makeRecording();
    const a = runReplay(rec).events.map((x) => x.event.type);
    const b = runReplay(rec).events.map((x) => x.event.type);
    expect(a).toEqual(b);
    expect(a).toContain('grab');
    expect(a).toContain('release');

    const live = new Engine();
    live.aspect = ASPECT;
    const ev: InputEvent[] = [];
    live.on((e) => ev.push(e));
    live.begin();
    for (const f of rec.frames) live.push(f, f.t);
    expect(ev.map((e) => e.type)).toEqual(a);
  });

  it('createReplayController plays in real time and loops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const rec = makeRecording();
    const c = createReplayController(rec, { loop: true });
    expect(c.kind).toBe('replay');
    const ev: InputEvent[] = [];
    c.on((e) => ev.push(e));
    await c.start();
    vi.advanceTimersByTime(700);
    expect(ev.map((e) => e.type)).toContain('grab');
    expect(ev.map((e) => e.type)).not.toContain('release');
    vi.advanceTimersByTime(800);
    expect(ev.filter((e) => e.type === 'release')).toHaveLength(1);
    expect(c.getState().tracking).toBe('ok');
    vi.advanceTimersByTime(1500); // second loop
    expect(ev.filter((e) => e.type === 'grab')).toHaveLength(2);
    c.stop();
    expect(c.getState().tracking).toBe('off');
  });

  it('non-looping replay ends and calls onEnd', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const onEnd = vi.fn();
    const c = createReplayController(makeRecording(), { loop: false, onEnd });
    await c.start();
    vi.advanceTimersByTime(2000);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(c.getState().tracking).toBe('off');
  });
});
