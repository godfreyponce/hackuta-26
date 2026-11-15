// C.6 calibration: step back → guard (neutral) → string the bow (arm length) → fist/open (grip range).
// Each step only advances while the player is actually doing the movement, gives live hints,
// and fails with a reason if it isn't seen within calibStepTimeoutMs.
import type { CalibrationResult, Hand, PlayerInputState } from '@ithaca/shared';
import { config } from './config';
import { HANDS, type Body } from './mapping';
import { len3, type Vec2 } from './math';
import { cloneProfile, type Profile } from './profile';
import type { CalibrationStep, CalibrationStepName } from './types';

export const CALIBRATION_MESSAGES: Record<CalibrationStepName, string> = {
  step_back: 'Step back until your hips are visible',
  guard: 'Raise your guard: both fists up by your chin, hold still',
  bow: 'String the bow: left arm straight out to your LEFT side, at shoulder height',
  grip: 'Make a fist, then open your hand. Repeat with both hands',
  done: 'Calibration passed',
  failed: 'Calibration failed',
};

const ORDER: CalibrationStepName[] = ['step_back', 'guard', 'bow', 'grip'];

/** Time (ms) the movement must be held / seen for each step. */
const HOLD: Record<'step_back' | 'guard' | 'bow', number> = { step_back: 800, guard: 2000, bow: 1200 };
/** Fist → open cycles needed in the grip step. */
const GRIP_CYCLES = 3;

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
  private stepStartedAt = -1;
  private hint = '';
  private readonly passed: CalibrationStepName[] = [];
  private failedStep: CalibrationStepName | undefined;
  private failedReason: string | undefined;
  private lastEmitted = { step: '', progress: -1, hint: '' };
  private readonly guard = { x: [] as number[], y: [] as number[], swImg: [] as number[], swWorld: [] as number[] };
  private readonly bow = { arm: [] as number[], upper: [] as number[], fore: [] as number[] };
  private readonly grip: Record<Hand, number[]> = { left: [], right: [] };
  private readonly fist: Record<Hand, boolean> = { left: false, right: false };
  private cycles = 0;
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
    this.hint = 'Looking for you…';
    this.announce(true);
  }

  get current(): CalibrationStep {
    const index = ORDER.indexOf(this.step) + 1;
    return {
      step: this.step,
      progress: this.stepProgress(),
      message: CALIBRATION_MESSAGES[this.step],
      index,
      total: ORDER.length,
      hint: this.hint,
      passed: [...this.passed],
      failedStep: this.failedStep,
      failedReason: this.failedReason,
    };
  }

  /** Feed one processed frame. Returns false once finished. */
  update(body: Body, poseHipVis: number, state: PlayerInputState): boolean {
    const t = body.t;
    if (this.step === 'done' || this.step === 'failed') return false;
    if (this.stepStartedAt < 0) this.stepStartedAt = t;
    if (t - this.stepStartedAt > config.calibStepTimeoutMs) {
      this.fail(this.step, this.hint && this.hint !== 'Hold still…' ? this.hint : 'Took too long');
      return false;
    }
    const dt = body.dt * 1000;

    if (!body.ok) {
      this.hint = "I can't see you. Step into the camera's view";
      this.announce();
      return true;
    }

    switch (this.step) {
      case 'step_back': {
        if (poseHipVis > config.calibHipVisibility) {
          this.progressMs += dt;
          this.hint = 'Hips visible. Hold still…';
        } else {
          this.progressMs = 0;
          this.hint = "Step back. I can't see your hips yet";
        }
        if (this.progressMs >= HOLD.step_back) this.next('guard');
        break;
      }

      case 'guard': {
        const issue = guardIssue(body, state);
        if (!issue) {
          const l = body.img[11] as Vec2, r = body.img[12] as Vec2;
          this.guard.x.push((l.x + r.x) / 2);
          this.guard.y.push((l.y + r.y) / 2);
          this.guard.swImg.push(body.swImg);
          this.guard.swWorld.push(body.swWorld);
          this.progressMs += dt;
          this.hint = 'Good guard. Hold still…';
        } else {
          this.hint = issue;
        }
        if (this.progressMs >= HOLD.guard) this.next('bow');
        break;
      }

      case 'bow': {
        const issue = bowIssue(body, state);
        if (!issue) {
          this.bow.arm.push(body.armLenWorld.left);
          this.bow.upper.push(body.upperImgRatio.left);
          this.bow.fore.push(body.foreImgRatio.left);
          this.progressMs += dt;
          this.hint = 'Good. Keep it straight…';
        } else {
          this.hint = issue;
        }
        if (this.progressMs >= HOLD.bow) this.next('grip');
        break;
      }

      case 'grip': {
        let seen = false;
        for (const h of HANDS) {
          if (!body.hand[h] || !body.handFresh[h]) continue;
          seen = true;
          const raw = body.gripRaw[h];
          this.grip[h].push(raw);
          if (!this.fist[h] && raw > config.calibFistRaw) this.fist[h] = true;
          else if (this.fist[h] && raw < config.calibOpenRaw) {
            this.fist[h] = false;
            this.cycles++;
          }
        }
        const closed = this.fist.left || this.fist.right;
        this.hint = !seen
          ? "I can't see your hands. Hold them up in front of you, palms to the camera"
          : closed
            ? `Fist ✓. Now open your hand (${this.cycles}/${GRIP_CYCLES})`
            : `Close your hand into a tight fist (${this.cycles}/${GRIP_CYCLES})`;
        if (this.cycles >= GRIP_CYCLES) {
          this.finish();
          return false;
        }
        break;
      }

      default:
        return false;
    }
    this.announce();
    return true;
  }

  cancel(): void {
    if (this.step !== 'done' && this.step !== 'failed') this.fail(this.step, 'Cancelled');
  }

  private stepProgress(): number {
    switch (this.step) {
      case 'step_back':
      case 'guard':
      case 'bow':
        return Math.min(this.progressMs / HOLD[this.step], 1);
      case 'grip':
        return Math.min(this.cycles / GRIP_CYCLES, 1);
      case 'done':
        return 1;
      default:
        return 0;
    }
  }

  private next(step: CalibrationStepName): void {
    this.passed.push(this.step);
    this.step = step;
    this.progressMs = 0;
    this.stepStartedAt = -1;
    this.hint = '';
    this.announce(true);
  }

  private announce(force = false): void {
    const progress = this.stepProgress();
    const last = this.lastEmitted;
    if (!force && last.step === this.step && last.hint === this.hint && Math.abs(progress - last.progress) < 0.02) return;
    this.lastEmitted = { step: this.step, progress, hint: this.hint };
    try {
      this.onStep(this.current);
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

    this.passed.push('grip');
    this.step = 'done';
    this.hint = `Arm ${p.armLengthM.toFixed(2)} m · shoulders ${p.shoulderWidthM.toFixed(2)} m`;
    this.announce(true);
    this.onFinish(p);
    this.resolve({
      ok: true,
      armLengthM: p.armLengthM,
      shoulderWidthM: p.shoulderWidthM,
      // Baselines in image space (shoulder midpoint x / y, units of image height) that lean/crouch are measured from.
      neutral: { lean: p.neutral.x, crouch: p.neutral.y },
    });
  }

  private fail(step: CalibrationStepName, reason: string): void {
    this.failedStep = step;
    this.failedReason = reason;
    this.step = 'failed';
    this.hint = reason;
    this.announce(true);
    this.onFinish(null);
    this.resolve({
      ok: false,
      armLengthM: this.base.armLengthM,
      shoulderWidthM: this.base.shoulderWidthM,
      neutral: { lean: this.base.neutral?.x ?? 0, crouch: this.base.neutral?.y ?? 0 },
    });
  }
}

/** Guard = both wrists up near the chin (above the elbows, at or above shoulder height) and still. */
function guardIssue(body: Body, state: PlayerInputState): string | null {
  for (const h of HANDS) {
    if (body.wristVis[h] < config.wristMinVisibility) return `I can't see your ${h} hand`;
  }
  for (const h of HANDS) {
    if (body.wrist[h].y < body.shoulder[h].y - 0.1 || body.wrist[h].y < body.elbow[h].y) {
      return `Raise your ${h} fist up to your chin`;
    }
  }
  if (HANDS.some((h) => len3(state.hands[h].vel) > config.calibStillSpeed)) return 'Hold still…';
  return null;
}

/** Bow = left arm straight, at shoulder height, pointing out to the player's left. */
function bowIssue(body: Body, state: PlayerInputState): string | null {
  if (body.wristVis.left < config.wristMinVisibility) return "I can't see your left hand. Keep it in the frame";
  const sh = body.shoulder.left, wr = body.wrist.left;
  if (sh.x - wr.x < 0.3) return 'Point your left arm out to your LEFT side';
  if (Math.abs(wr.y - sh.y) > 0.25) return wr.y < sh.y ? 'Raise your left arm to shoulder height' : 'Lower your left arm to shoulder height';
  if (body.elbowAngle.left < config.bowElbowAngle) return `Straighten your left arm (elbow ${body.elbowAngle.left.toFixed(0)}°)`;
  if (len3(state.hands.left.vel) > config.calibStillSpeed * 1.5) return 'Hold still…';
  return null;
}
