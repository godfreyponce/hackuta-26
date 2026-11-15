// Raw tracker output (also the recording format) and C-specific extras that sit
// on top of the shared InputController contract.

/** Same shape as MediaPipe's Landmark / NormalizedLandmark, so results pass through without copying. */
export interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface RawHand {
  /** 21 normalized image landmarks (un-mirrored camera image: x right in the image, y down). */
  image: RawLandmark[];
  /** 21 hand-world landmarks (meters, hand-centered), or null. */
  world: RawLandmark[] | null;
  /** MediaPipe handedness label. It assumes a mirrored image, so on raw webcam frames it is swapped. */
  label: 'Left' | 'Right';
  score: number;
}

/** One tracker frame. `hands === null` means the hand model was skipped this frame (perf mode). */
export interface RawFrame {
  t: number;
  poseWorld: RawLandmark[] | null;
  poseImage: RawLandmark[] | null;
  hands: RawHand[] | null;
}

export interface Recording {
  version: 1;
  meta: {
    createdAt: string;
    label?: string;
    /** Video width / height — needed to measure distances in image space. */
    aspect: number;
    width: number;
    height: number;
  };
  frames: RawFrame[];
}

export interface TrackerStats {
  fps: number;
  /** Detection time per frame (pose + hands), ms, smoothed. */
  msPerFrame: number;
  delegate: 'GPU' | 'CPU' | 'none';
  width: number;
  height: number;
  handsEveryOtherFrame: boolean;
  error: string | null;
}

export interface PendingGesture {
  name: 'call_sign' | 'request_weapon' | 'drink';
  /** 0..1 hold progress, for A's radial ring. */
  progress: number;
}

export type CalibrationStepName = 'step_back' | 'guard' | 'bow' | 'grip' | 'done' | 'failed';

export interface CalibrationStep {
  step: CalibrationStepName;
  /** 0..1 progress within the current step. */
  progress: number;
  /** Player-facing instruction. */
  message: string;
  /** 1-based position of this step among the 4 real steps (0 for done/failed). */
  index: number;
  total: number;
  /** Live feedback on what the tracker sees right now ("Raise your left arm higher"). */
  hint: string;
  /** Steps already passed, in order. */
  passed: CalibrationStepName[];
  /** When step === 'failed': which step failed and why. */
  failedStep?: CalibrationStepName;
  failedReason?: string;
}
