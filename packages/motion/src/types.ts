// Raw tracker output (also the recording format) and C-specific extras that sit
// on top of the shared InputController contract.
import type { Hand } from '@ithaca/shared';

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
  /**
   * MediaPipe handedness label. On these un-mirrored webcam frames it names the player's own hand
   * ('Left' = the player's left hand); checked against the nearest pose wrist on the fixtures (490/496).
   */
  label: 'Left' | 'Right';
  score: number;
  /** Set by the pose-guided crop path: which pose wrist's crop found this hand. Old recordings have none. */
  side?: Hand;
}

/** One tracker frame. `hands === null` means the hand model was skipped this frame (perf mode). */
export interface RawFrame {
  t: number;
  poseWorld: RawLandmark[] | null;
  poseImage: RawLandmark[] | null;
  hands: RawHand[] | null;
  /** Sides whose hand crop was not run this frame (alternating L/R perf mode): they keep their last result. */
  skippedHands?: Hand[];
}

export interface Recording {
  version: 1;
  meta: {
    createdAt: string;
    label?: string;
    /** Video width / height — needed to measure distances in image space. */
    aspect: number;
    /** Calibration active while recording, so replays judge grip the same way the live run did. */
    profile?: import('./profile').Profile;
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
  /** Pose model time per frame, ms, smoothed. */
  msPose?: number;
  /** Hand model time per frame (crops + retries, or the full-frame model), ms, smoothed. */
  msHands?: number;
  /** Same-frame IMAGE retries after a crop missed, during the last second. */
  roiRetries?: number;
  /** Per side, over the last second: frames with the pose wrist visible (≥ 0.5) where the hand model found that hand. */
  handHitRate?: Record<Hand, number>;
  /** Hands come from pose-guided crops this frame (config.handRoi > 0 and a pose). */
  handRoi?: boolean;
  /** Perf mode with crops: the left and right crops run on alternate frames. */
  handsAlternate?: boolean;
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
