import type { InputController, InputEvent, PlayerInputState } from '@ithaca/shared';
import { neutralState } from './neutral';

export interface MotionControllerOptions {
  /** URL prefix where the .task models and wasm/ live. Default "/models". */
  modelBaseUrl?: string;
}

export interface MotionController extends InputController {
  readonly kind: 'motion';
}

/** Stub: satisfies InputController and reports neutral, invisible hands. */
export function createMotionController(_opts: MotionControllerOptions = {}): MotionController {
  const listeners = new Set<(e: InputEvent) => void>();
  let state: PlayerInputState = neutralState('off');
  return {
    kind: 'motion',
    async start() {
      state = neutralState('lost');
    },
    stop() {
      state = neutralState('off');
    },
    getState() {
      state.t = performance.now();
      return state;
    },
    on(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getDebugVideo() {
      return null;
    },
  };
}
