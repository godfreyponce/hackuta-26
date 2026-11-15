import type { InputController } from '@ithaca/shared';
import { createKeyboardMouseController, type KeyboardMouseController } from './keyboardMouse';

export type InputKind = 'motion' | 'keyboard_mouse' | 'replay';

/** Optional extras Part C may expose on the motion controller (all feature-detected). */
export interface MotionExtras {
  getPendingGesture?: () => { name: string; progress: number } | null;
  onCalibrationStep?: (cb: (step: CalibrationStepInfo) => void) => () => void;
  getLandmarks?: () => unknown;
}
export interface CalibrationStepInfo {
  index: number;            // 0..3
  id?: string;
  label?: string;
  progress?: number;        // 0..1
  done?: boolean;
  ok?: boolean;
}

type MotionModule = {
  createMotionController?: (opts?: Record<string, unknown>) => InputController;
  createReplayController?: (json: unknown) => InputController;
  MotionLab?: React.ComponentType;
};

// Part C's package is optional at build time: the glob resolves to {} until packages/motion exists,
// so the web app always builds and falls back to keyboard & mouse.
const motionModules = import.meta.glob<MotionModule>('../../../../packages/motion/src/index.ts');

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
        const res = await fetch('/models/recordings/throw.json').then((r) => r.json());
        return { controller: mod.createReplayController(res), kind: 'replay' };
      }
      return { controller: mod.createMotionController({}), kind: 'motion' };
    } catch (err) {
      console.warn('[input] motion controller failed, using keyboard', err);
      return { controller: createKeyboardMouseController(), kind: 'keyboard_mouse', fallbackReason: 'Camera tracking unavailable' };
    }
  }
  return { controller: createKeyboardMouseController(), kind: 'keyboard_mouse' };
}
