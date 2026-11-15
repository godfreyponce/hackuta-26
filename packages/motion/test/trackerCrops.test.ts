// Pose-guided hand crops in the Tracker, with fake models (trackerHarness): retry budget and order, duplicate
// guard with alternating crops, re-seeding (skipped side, off-frame side) and the lighting hint.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, resetConfig } from '../src/config';
import { makeHarness, type FakeHand } from './trackerHarness';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetConfig();
});

const L: FakeHand = { x: 0.62, y: 0.55, label: 'Left' };
const R: FakeHand = { x: 0.38, y: 0.55, label: 'Right' };

describe('IMAGE retries (review #6: budget spent in side order)', () => {
  it('runs both VIDEO crops before any retry', () => {
    const h = makeHarness();
    h.setScript({ vid: { left: null, right: null }, img: { left: L, right: R } });
    for (let i = 0; i < 3; i++) h.frame();
    const vids = h.calls.filter((c) => c.startsWith('vid:'));
    const firstImg = h.calls.findIndex((c) => c.startsWith('img:'));
    expect(vids).toEqual(['vid:left', 'vid:right']);
    expect(firstImg).toBeGreaterThan(h.calls.lastIndexOf('vid:right'));
  });

  it('shares a budget that fits one retry between the sides (the right hand used to get none)', () => {
    // M4 Pro numbers: pose 9 ms, crops 5 ms each, a retry 7 ms; 30 fps camera → 0.8 × 33 ms = 26.7 ms
    const h = makeHarness({ pose: 9, vid: 5, img: 7, full: 8 });
    h.setScript({ vid: { left: null, right: null }, img: { left: L, right: R } });
    const hits = { left: 0, right: 0 };
    let retries = 0;
    for (let i = 0; i < 40; i++) {
      const f = h.frame();
      retries += h.calls.filter((c) => c.startsWith('img:')).length;
      for (const hd of f.hands ?? []) if (hd.side) hits[hd.side]++;
    }
    expect(retries).toBe(40); // exactly one retry fits per frame
    expect(hits.left).toBe(20);
    expect(hits.right).toBe(20);
    expect(h.tr.stats.roiRetrySkips ?? 0).toBeGreaterThan(0);
  });

  it('a slow (20 fps dim-light) camera does not grow the budget: one retry a frame, the sides take turns', () => {
    // the game renders on the same thread — a longer camera interval is no licence for the tracker to take more
    const h = makeHarness({ pose: 9, vid: 5, img: 7, full: 8 });
    h.setScript({ vid: { left: null, right: null }, img: { left: L, right: R } });
    for (let i = 0; i < 25; i++) h.frame(50);
    expect(h.tr.stats.cameraFps).toBeCloseTo(20, 0);
    // (h.calls holds the last frame's model calls only)
    const tries = { left: 0, right: 0 };
    for (let i = 0; i < 10; i++) {
      h.frame(50);
      const img = h.calls.filter((c) => c.startsWith('img:'));
      expect(img.length).toBe(1); // one retry a frame — the second doesn't fit a 30 fps slice
      for (const c of img) tries[c === 'img:left' ? 'left' : 'right']++;
    }
    expect(tries.left).toBe(5);
    expect(tries.right).toBe(5);
  });

  it('a frame rate slowed by detection itself does not grow the budget (no feedback loop)', () => {
    // 35 ms of pose + crops on a 30 fps camera: frames get through every 35 ms, presentedFrames says nothing more
    const h = makeHarness({ pose: 15, vid: 10, img: 7, full: 8 });
    h.setScript({ vid: { left: L, right: R } });
    for (let i = 0; i < 4 * 28; i++) h.frame(35);
    expect(h.tr.stats.cameraFps).toBeLessThan(29);
    expect((h.tr as unknown as { frameIntervalMs(): number }).frameIntervalMs()).toBeCloseTo(1000 / 30, 1);
  });

  it('retries filling the frame do not count as "detection too slow" (no switch to alternating crops)', () => {
    // pose + crops 22 ms, one 7 ms retry a frame → 29 ms of a 33 ms frame: busy, but keeping up
    const h = makeHarness({ pose: 10, vid: 6, img: 7, full: 8 }, 40);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.setScript({ vid: { left: null, right: null }, img: { left: L, right: R } });
    for (let i = 0; i < 6 * 30; i++) h.frame();
    expect(h.tr.stats.msPerFrame).toBeGreaterThan(0.8 * (1000 / 30));
    expect(h.tr.stats.handsAlternate).toBe(false);
  });

  it('a 60 fps camera still gets a retry every frame (the budget is a fixed 30 fps slice)', () => {
    const h = makeHarness({ pose: 9, vid: 5, img: 7, full: 8 });
    h.T.settingsFps = 60;
    h.setScript({ vid: { left: null, right: null }, img: { left: L, right: R } });
    let retries = 0;
    for (let i = 0; i < 10; i++) { h.frame(1000 / 60); retries += h.calls.filter((c) => c.startsWith('img:')).length; }
    expect(retries).toBe(10);
  });
});

describe('alternating L/R crops: duplicate guard (review #4)', () => {
  it('drops a right-crop result that is the left hand seen again, and masks it out of the right crop', () => {
    const h = makeHarness();
    h.tr.stats.handsAlternate = true;
    // odd frames run the right crop, even frames the left one
    h.setScript({ vid: { left: L, right: null }, img: {} });
    h.frame(); // right: nothing
    expect(h.frame().hands?.map((x) => x.side)).toEqual(['left']);
    // from now on the right crop keeps finding the LEFT hand (its own label says Left)
    h.setScript({ vid: { left: L, right: { ...L } } });
    let rightHands = 0, leftHands = 0;
    for (let i = 0; i < 12; i++) {
      const f = h.frame();
      rightHands += (f.hands ?? []).filter((x) => x.side === 'right').length;
      leftHands += (f.hands ?? []).filter((x) => x.side === 'left').length;
    }
    expect(rightHands).toBe(0);
    expect(leftHands).toBe(6);
    expect(h.T.roi.right.mask).not.toBeNull();
  });

  it('when the other side held this hand all along, its stale result is not carried over', () => {
    const h = makeHarness();
    h.tr.stats.handsAlternate = true;
    h.setScript({ vid: { left: null, right: null }, img: {} });
    h.frame(); // right: nothing
    // the left crop locks onto the RIGHT hand (its label says Right) …
    h.setScript({ vid: { left: { ...R }, right: null } });
    expect(h.frame().hands?.map((x) => x.side)).toEqual(['left']);
    // … then the right crop finds that hand where it is
    h.setScript({ vid: { left: null, right: R } });
    const f = h.frame();
    expect(h.calls).toContain('vid:right');
    expect((f.hands ?? []).map((x) => x.side)).toEqual(['right']);
    // the left side's last hand (the duplicate) is forgotten and not held over this frame, and masked next time
    expect(f.skippedHands).toBeUndefined();
    expect(h.T.roi.left.last).toBeNull();
    expect(h.T.roi.left.mask).not.toBeNull();
    // an ordinary right frame carries the left side over again
    h.frame();
    expect(h.frame().skippedHands).toEqual(['left']);
  });

  it('two distinct hands are both kept', () => {
    const h = makeHarness();
    h.tr.stats.handsAlternate = true;
    h.setScript({ vid: { left: L, right: R }, img: {} });
    const seen = { left: 0, right: 0 };
    for (let i = 0; i < 10; i++) for (const hd of h.frame().hands ?? []) if (hd.side) seen[hd.side]++;
    expect(seen).toEqual({ left: 5, right: 5 });
  });
});

describe('re-seeding from the full frame', () => {
  it('alternating crops: never fills the side that did not run, and still re-seeds the right side (review #5)', () => {
    const h = makeHarness();
    h.tr.stats.handsAlternate = true;
    // right pose wrist gone (no crop), the full frame sees the right hand
    h.setScript({ pose: { left: { x: 0.62, y: 0.6 }, right: { x: 0.38, y: 0.6, vis: 0.02 } }, vid: { left: L }, full: [R] });
    let filledOnLeftFrame = false, filledOnRightFrame = false;
    for (let i = 0; i < 40; i++) {
      const f = h.frame();
      const right = (f.hands ?? []).some((x) => x.side === 'right');
      const leftRan = h.frames.length > 0 && f.skippedHands?.includes('right');
      if (right && leftRan) filledOnLeftFrame = true;
      if (right && !leftRan) filledOnRightFrame = true;
      if (right) break;
    }
    expect(filledOnLeftFrame).toBe(false);
    expect(filledOnRightFrame).toBe(true);
  });

  it("a re-seed never takes the other side's recent hand for this side", () => {
    const h = makeHarness();
    h.tr.stats.handsAlternate = true;
    // the full frame sees one hand, labelled Right, exactly where the left side's last hand is
    const fake: FakeHand = { ...L, label: 'Right' };
    h.setScript({ pose: { left: { x: 0.62, y: 0.6 }, right: { x: 0.38, y: 0.6, vis: 0.02 } }, vid: { left: L }, full: [] });
    for (let i = 0; i < 4; i++) h.frame();
    h.setScript({ full: [fake] });
    let reseeds = 0;
    for (let i = 0; i < 40; i++) {
      const f = h.frame();
      if (h.calls.includes('full')) reseeds++;
      expect((f.hands ?? []).some((x) => x.side === 'right')).toBe(false);
    }
    expect(reseeds).toBeGreaterThanOrEqual(4); // it did look
  });

  it('a hand at the frame edge whose pose crop is off-frame is found after 500 ms, then cropped (review #7)', () => {
    const h = makeHarness();
    // the pose extrapolates the right wrist past the left image edge; the hand pokes in at x ≈ 0.02
    const edge: FakeHand = { x: 0.02, y: 0.5, label: 'Right' };
    h.setScript({ pose: { left: { x: 0.62, y: 0.6 }, right: { x: -0.2, y: 0.5 } }, vid: { left: L, right: edge }, full: [L, edge] });
    let firstRightAt = -1;
    const t0 = h.clock;
    for (let i = 0; i < 60 && firstRightAt < 0; i++) {
      const f = h.frame();
      if ((f.hands ?? []).some((x) => x.side === 'right')) firstRightAt = h.clock - t0;
    }
    expect(firstRightAt).toBeGreaterThanOrEqual(500);
    expect(firstRightAt).toBeLessThan(900);
    // from then on the right crop runs around the hand the full frame found
    for (let i = 0; i < 5; i++) {
      const f = h.frame();
      expect(h.calls).toContain('vid:right');
      expect((f.hands ?? []).some((x) => x.side === 'right')).toBe(true);
    }
    expect(h.tr.getDebugRois().right).not.toBeNull();
  });
});

describe('crop sizing for a hand reaching toward the camera', () => {
  it("grows the crop to this side's own recent, bigger hand", () => {
    const h = makeHarness();
    const big: FakeHand = { x: 0.38, y: 0.5, size: 0.3, label: 'Right' };
    h.setScript({ vid: { left: L, right: big } });
    h.frame();
    const poseSize = h.T.roi.right.rect?.size ?? 0;
    h.frame();
    const grown = h.T.roi.right.rect?.size ?? 0;
    expect(grown).toBeGreaterThan(1.5 * poseSize);
    // a small hand leaves the pose crop alone
    expect(h.T.roi.left.rect?.size).toBeCloseTo(poseSize, 0);
  });
});

describe('lighting hint (stats.hint)', () => {
  it("raises 'lighting' when the camera delivers under 24 fps, and clears it when light is back", () => {
    const h = makeHarness();
    h.setScript({ vid: { left: L, right: R } });
    for (let i = 0; i < 4 * 30; i++) h.frame(); // 4 s at 30 fps: past warm-up, fine
    expect(h.tr.stats.hint).toBeNull();
    for (let i = 0; i < 3 * 18; i++) h.frame(1000 / 18); // dim: 18 fps
    expect(h.tr.stats.cameraFps).toBeLessThan(20);
    expect(h.tr.stats.hint).toBe('lighting');
    for (let i = 0; i < 2 * 30; i++) h.frame();
    expect(h.tr.stats.hint).toBe('lighting'); // hysteresis: not yet
    for (let i = 0; i < 2 * 30; i++) h.frame();
    expect(h.tr.stats.hint).toBeNull();
  });

  it('counts frames the camera delivered while detection was busy (presentedFrames), so slow detection is no lighting problem', () => {
    const h = makeHarness({ pose: 30, vid: 12, img: 7, full: 8 }); // 54 ms a frame: every other camera frame dropped
    h.setScript({ vid: { left: L, right: R } });
    for (let i = 0; i < 6 * 15; i++) h.frame(1000 / 15, 1);
    expect(h.tr.stats.fps).toBeLessThan(20);
    expect(h.tr.stats.cameraFps).toBeGreaterThan(25);
    expect(h.tr.stats.hint).toBeNull();
  });

  it("a very dark image raises 'lighting' at full frame rate", () => {
    const h = makeHarness();
    h.T.sampleLuma = () => 0.06;
    h.setScript({ vid: { left: L, right: R } });
    for (let i = 0; i < 6 * 30; i++) h.frame();
    expect(h.tr.stats.brightness).toBeCloseTo(0.06);
    expect(h.tr.stats.hint).toBe('lighting');
  });

  it('a camera that only does 15 fps is not a lighting problem', () => {
    const h = makeHarness();
    h.T.settingsFps = 15;
    h.setScript({ vid: { left: L, right: R } });
    for (let i = 0; i < 6 * 15; i++) h.frame(1000 / 15);
    expect(h.tr.stats.hint).toBeNull();
  });

  it('brightens the hand crops in a dark room (only then), smoothly, at most 3×', () => {
    const gain = (f: string | undefined) => (!f || f === 'none' ? 1 : +f.slice('brightness('.length, -1));
    const h = makeHarness();
    h.setScript({ vid: { left: L, right: R } });
    for (let i = 0; i < 200; i++) h.frame(); // brightness 0.45: untouched
    expect(new Set(h.filters)).toEqual(new Set(['none']));
    h.T.sampleLuma = () => 0.249; // just under the threshold: no step
    for (let i = 0; i < 200; i++) h.frame();
    expect(gain(h.filters.at(-1))).toBeLessThan(1.05);
    h.T.sampleLuma = () => 0.2; // partway into the ramp
    for (let i = 0; i < 300; i++) h.frame();
    expect(gain(h.filters.at(-1))).toBeGreaterThan(1.4);
    expect(gain(h.filters.at(-1))).toBeLessThan(1.9);
    h.T.sampleLuma = () => 0.05;
    for (let i = 0; i < 300; i++) h.frame();
    expect(h.filters.at(-1)).toBe('brightness(3.00)');
    // the filter is reset after each crop, so masks and later draws are not brightened
    expect((h.T.crop.left?.ctx as { filter: string }).filter).toBe('none');
  });

  it('no verdict during the first seconds (auto-exposure settling)', () => {
    const h = makeHarness();
    h.T.sampleLuma = () => 0.02;
    for (let i = 0; i < 2 * 30; i++) h.frame();
    expect(h.tr.stats.hint).toBeNull();
    expect(config.lowLightWindows).toBe(2);
  });
});
