import type { InputController } from '@ithaca/shared';
import { createKeyboardMouseController, type KeyboardMouseController } from './keyboardMouse';

export type InputKind = 'motion' | 'keyboard_mouse' | 'replay';

/** Optional extras Part C may expose on the motion controller (all feature-detected). */
export interface MotionExtras {
  getPendingGesture?: () => { name: string; progress: number } | null;
  onCalibrationStep?: (cb: (step: CalibrationStepInfo) => void) => () => void;
  getLandmarks?: () => unknown;
}
/** Part C's CalibrationStep (packages/motion/src/types.ts), as the calibration screen reads it. */
export interface CalibrationStepInfo {
  step: 'step_back' | 'guard' | 'bow' | 'grip' | 'done' | 'failed';
  index: number;            // 1-based among the 4 real steps; 0 for done/failed
  total?: number;
  progress?: number;        // 0..1 within the step
  message?: string;         // the instruction
  hint?: string;            // live feedback ("Raise your left arm higher")
  passed?: string[];        // steps passed so far, in order
  failedStep?: string;
  failedReason?: string;
}
export const CALIBRATION_ORDER = ['step_back', 'guard', 'bow', 'grip'] as const;

type MotionModule = {
  createMotionController?: (opts?: Record<string, unknown>) => InputController;
  createReplayController?: (json: unknown, opts?: { profile?: unknown }) => InputController;
  replayProfile?: (json: never) => unknown;
};
type MotionLabModule = { MotionLab?: React.ComponentType };

// Part C's package is optional at build time: the glob resolves to {} until packages/motion exists,
// so the web app always builds and falls back to keyboard & mouse.
const motionModules = import.meta.glob<MotionModule>('../../../../packages/motion/src/index.ts');
// C ships its dev Lab as a separate entry (@ithaca/motion/lab) and reference recordings as fixtures
const motionLabModules = import.meta.glob<MotionLabModule>('../../../../packages/motion/src/lab/index.ts');
const motionRecordings = import.meta.glob<{ default: unknown }>('../../../../packages/motion/fixtures/*.json');
/** False until Part C's package exists — the UI disables "Body (webcam)" rather than silently falling back. */
export const motionAvailable = Object.keys(motionModules).length > 0;

export async function loadMotionModule(): Promise<MotionModule | null> {
  const loader = Object.values(motionModules)[0];
  if (!loader) return null;
  try {
    return await loader();
  } catch (err) {
    console.warn('[input] motion package failed to load', err);
    return null;
  }
}

/** Part C's Motion Lab (?dev=motionlab), or null when the package isn't there. */
export async function loadMotionLab(): Promise<React.ComponentType | null> {
  const loader = Object.values(motionLabModules)[0];
  if (!loader) return null;
  try { return (await loader()).MotionLab ?? null; } catch (err) { console.warn('[input] motion lab failed to load', err); return null; }
}

/** One of C's reference recordings for VITE_INPUT=replay (the throw one if present). */
async function loadReplayRecording(): Promise<unknown> {
  const keys = Object.keys(motionRecordings).sort();
  const key = keys.find((k) => /\/throw-[^/]*\.json$/.test(k)) ?? keys[0];
  if (!key) throw new Error('no motion recordings');
  return (await motionRecordings[key]!()).default;
}

export function isKeyboardMouse(c: InputController | null): c is KeyboardMouseController {
  return !!c && c.kind === 'keyboard_mouse' && 'setCamera' in c;
}

export interface CreatedInput {
  controller: InputController;
  kind: InputKind;
  fallbackReason?: string;
}

/** Create the requested controller, falling back to keyboard/mouse with a reason the UI can show. */
export async function createInput(kind: InputKind): Promise<CreatedInput> {
  if (kind === 'motion' || kind === 'replay') {
    const mod = await loadMotionModule();
    if (!mod?.createMotionController) {
      return { controller: createKeyboardMouseController(), kind: 'keyboard_mouse', fallbackReason: 'Motion tracking module not installed yet' };
    }
    try {
      if (kind === 'replay') {
        if (!mod.createReplayController) throw new Error('no replay controller');
        const rec = await loadReplayRecording();
        // C: replays use the recording's own calibration
        return { controller: mod.createReplayController(rec, mod.replayProfile ? { profile: mod.replayProfile(rec as never) } : {}), kind: 'replay' };
      }
      return { controller: mod.createMotionController({}), kind: 'motion' };
    } catch (err) {
      console.warn('[input] motion controller failed, using keyboard', err);
      return { controller: createKeyboardMouseController(), kind: 'keyboard_mouse', fallbackReason: 'Camera tracking unavailable' };
    }
  }
  return { controller: createKeyboardMouseController(), kind: 'keyboard_mouse' };
}
