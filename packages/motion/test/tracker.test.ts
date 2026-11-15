// M6: a perf downgrade belongs to one run; stop() resets it so a restart starts at full quality.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tracker } from '../src/tracker';

afterEach(() => vi.unstubAllGlobals());

describe('Tracker perf policy', () => {
  it('stop() clears hands-every-other-frame, alternating crops and the slow-window count', () => {
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const video = { muted: false, playsInline: false, autoplay: false, srcObject: null, videoWidth: 0, videoHeight: 0 };
    const tr = new Tracker({ modelBaseUrl: '/models', poseModel: 'full', video: video as unknown as HTMLVideoElement, downgradeBelowFps: 40 });
    const priv = tr as unknown as { slowWindows: number };
    tr.stats.handsEveryOtherFrame = true;
    tr.stats.handsAlternate = true;
    priv.slowWindows = 2;
    tr.stop();
    expect(tr.stats.handsEveryOtherFrame).toBe(false);
    expect(tr.stats.handsAlternate).toBe(false);
    expect(priv.slowWindows).toBe(0);
    expect(tr.getDebugRois()).toEqual({ left: null, right: null });
  });
});
