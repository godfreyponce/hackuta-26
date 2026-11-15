// C.6 calibration: step back → guard (neutral) → string the bow (arm length) → fist/open (grip range).
import type { CalibrationResult, Hand } from '@ithaca/shared';
import { config } from './config';
import { HANDS, type Body } from './mapping';
import type { Vec2 } from './math';
import { cloneProfile, type Profile } from './profile';
import type { CalibrationStep, CalibrationStepName } from './types';

export const CALIBRATION_MESSAGES: Record<CalibrationStepName, string> = {
  step_back: 'Step back until your hips are visible',
  guard: 'Raise your guard and hold still',
  bow: 'String the bow: left arm straight out to the side',
  grip: 'Make a fist, then open your hand (both hands, a few times)',
  done: 'Calibrated!',
  failed: 'Calibration timed out. Find better light and try again.',
};

/** Per-step durations (ms of tracked time). */
const STEP_BACK_HOLD = 400;
const GUARD_MS = 3000;
const BOW_MS = 1200;
const GRIP_MS = 4000;

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
};
const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))] ?? NaN;
};

export class Calibrator {
  private step: CalibrationStepName = 'step_back';
  private progressMs = 0;
  private startedAt = -1;
  private lastEmitted = { step: '' as string, progress: -1 };
  private readonly guard = { x: [] as number[], y: [] as number[], swImg: [] as number[], swWorld: [] as number[] };
  private readonly bow = { arm: [] as number[], upper: [] as number[], fore: [] as number[] };
  private readonly grip: Record<Hand, number[]> = { left: [], right: [] };
  private resolve: (r: CalibrationResult) => void = () => {};
  readonly promise: Promise<CalibrationResult>;

  constructor(
    private readonly base: Profile,
    private readonly onStep: (s: CalibrationStep) => void,
    private readonly onFinish: (profile: Profile | null) => void,
  ) {
    this.promise = new Promise((r) => {
      this.resolve = r;
    });
    this.announce(0, true);
  }

  get current(): CalibrationStep {
    return { step: this.step, progress: this.stepProgress(), message: CALIBRATION_MESSAGES[this.step] };
  }

  /** Feed one processed frame. Returns false once finished. */
  update(body: Body, poseHipVis: number): boolean {
    const t = body.t;
    if (this.startedAt < 0) this.startedAt = t;
    if (t - this.startedAt > config.calibTimeoutMs) {
      this.fail();
      return false;
    }
    const dt = body.dt * 1000;
    switch (this.step) {
      case 'step_back':
        if (body.ok && poseHipVis > config.calibHipVisibility) this.progressMs += dt;
        else this.progressMs = 0;
        if (this.progressMs >= STEP_BACK_HOLD) this.next('guard');
        break;

      case 'guard':
        if (body.ok) {
          const l = body.img[11] as Vec2, r = body.img[12] as Vec2;
          this.guard.x.push((l.x + r.x) / 2);
          this.guard.y.push((l.y + r.y) / 2);
          this.guard.swImg.push(body.swImg);
          this.guard.swWorld.push(body.swWorld);
          this.progressMs += dt;
        }
        if (this.progressMs >= GUARD_MS) this.next('bow');
        break;

      case 'bow':
        // Left arm straight (elbow angle) and stretched out sideways (long in the image).
        if (body.ok && body.elbowAngle.left > config.bowElbowAngle && body.wristVis.left > config.wristMinVisibility) {
          this.bow.arm.push(body.armLenWorld.left);
          this.bow.upper.push(body.upperImgRatio.left);
          this.bow.fore.push(body.foreImgRatio.left);
          this.progressMs += dt;
        }
        if (this.progressMs >= BOW_MS) this.next('grip');
        break;

      case 'grip':
        for (const h of HANDS) if (body.ok && body.hand[h] && body.handFresh[h]) this.grip[h].push(body.gripRaw[h]);
        if (body.ok) this.progressMs += dt;
        if (this.progressMs >= GRIP_MS) {
          this.finish();
          return false;
        }
        break;

      default:
        return false;
    }
    this.announce(this.stepProgress());
    return true;
  }

  cancel(): void {
    if (this.step !== 'done' && this.step !== 'failed') this.fail();
  }

  private stepProgress(): number {
    const total = { step_back: STEP_BACK_HOLD, guard: GUARD_MS, bow: BOW_MS, grip: GRIP_MS, done: 1, failed: 1 }[this.step];
    return this.step === 'done' ? 1 : Math.min(this.progressMs / total, 1);
  }

  private next(step: CalibrationStepName): void {
    this.step = step;
    this.progressMs = 0;
    this.announce(0, true);
  }

  private announce(progress: number, force = false): void {
    if (!force && this.lastEmitted.step === this.step && Math.abs(progress - this.lastEmitted.progress) < 0.02) return;
    this.lastEmitted = { step: this.step, progress };
    try {
      this.onStep({ step: this.step, progress, message: CALIBRATION_MESSAGES[this.step] });
    } catch (err) {
      console.error('[motion] calibration listener threw', err);
    }
  }

  private finish(): void {
    const p = cloneProfile(this.base);
    const g = this.guard;
    p.neutral = { x: median(g.x), y: median(g.y), swImg: median(g.swImg) };
    const sw = median(g.swWorld);
    if (sw > 0.15 && sw < 0.7) p.shoulderWidthM = sw;

    const arm = median(this.bow.arm);
    if (arm > 0.3 && arm < 1.2) p.armLengthM = arm;
    // Least-foreshortened samples = true sideways length.
    const upper = percentile(this.bow.upper, 0.9);
    const fore = percentile(this.bow.fore, 0.9);
    if (upper > 0.3 && upper < 2) p.upperArmImgRatio = upper;
    if (fore > 0.3 && fore < 2) p.forearmImgRatio = fore;

    for (const h of HANDS) {
      const lo = percentile(this.grip[h], 0.05);
      const hi = percentile(this.grip[h], 0.95);
      // Only trust a hand that actually opened and closed.
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi - lo > config.calibMinGripRange) p.grip[h] = { min: lo, max: hi };
    }
    p.calibrated = true;

    this.step = 'done';
    this.announce(1, true);
    this.onFinish(p);
    this.resolve({
      ok: true,
      armLengthM: p.armLengthM,
      shoulderWidthM: p.shoulderWidthM,
      // Baselines in image space (shoulder midpoint x / y, units of image height) that lean/crouch are measured from.
      neutral: { lean: p.neutral.x, crouch: p.neutral.y },
    });
  }

  private fail(): void {
    this.step = 'failed';
    this.announce(0, true);
    this.onFinish(null);
    this.resolve({
      ok: false,
      armLengthM: this.base.armLengthM,
      shoulderWidthM: this.base.shoulderWidthM,
      neutral: { lean: this.base.neutral?.x ?? 0, crouch: this.base.neutral?.y ?? 0 },
    });
  }
}
