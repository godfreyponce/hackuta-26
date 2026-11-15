// Every tunable threshold lives here (spec §8 C.5). The Motion Lab edits `config` live.
// Distances are meters, times ms, speeds m/s in game space unless noted.

export const DEFAULT_CONFIG = {
  // ── tracking (C.5 / C.9) ──
  trackingLostMs: 500,
  trackingOkMs: 300,
  degradedVisibility: 0.5,
  /** Perf fallback (tracker.ts): only when detection can't keep up (ms/frame > 0.8 × the camera's frame interval) and fps < this. 0 disables. */
  downgradeBelowFps: 40,

  // ── hand crops from the pose (tracker.ts / handRoi.ts) ──
  /** 0 = whole frame (old path), 1 = one 256² crop per pose wrist (VIDEO), 2 = crops + same-frame IMAGE retry on a miss. */
  handRoi: 2,
  /** Crop side = this × |wrist → (2·index + pinky)/3| (Holistic: 2 × 2.7). */
  handRoiScale: 5.4,
  /** Crop centre this many wrist→knuckle lengths past the wrist. */
  handRoiCenterAlong: 1.2,
  /** Keep last frame's crop while the target moved less than this × its size (VIDEO tracking stays valid). */
  handRoiSticky: 0.12,
  /** Pose wrist visibility needed to place a crop from the pose (Holistic's gate). */
  handRoiMinWristVis: 0.1,
  /** IMAGE retry only while the frame has used less than this (pose + crops so far). */
  handRoiRetryBudgetMs: 20,

  // ── mapping (C.3) ──
  /** Game arm reach the player's measured arm length maps to. */
  gameArmReach: 0.75,
  /** Shoulder midpoint sits this far below the eyes (camera origin). */
  eyeToShoulderM: 0.25,
  /** Weight of pose-world z vs. forearm-foreshortening z. */
  depthBlend: 0.5,
  zNear: -0.15,
  zFar: -0.85,
  posMinCutoff: 1.0,
  posBeta: 0.02,
  zMinCutoff: 0.6,
  velMinCutoff: 5,
  /** 0..1 per-frame lerp for forward/up vectors. */
  dirSmoothing: 0.5,
  bodySmoothing: 0.3,
  /** Shoulder drop (in shoulder widths) that counts as a full crouch. */
  crouchFullDropSw: 1.2,
  /** Pose wrist visibility below this hides the hand, unless the hand model sees it this frame (score ≥ 0.5). */
  wristMinVisibility: 0.3,
  /** Max image distance (image heights) to pair a hand with a pose wrist. */
  assocMaxDist: 0.25,
  lostHandConfidence: 0.4,
  maxExtrapolateMs: 50,

  // ── grip (C.4) ──
  gripOn: 0.65,
  gripOff: 0.35,
  /** Consecutive frames past a threshold before grab/release fires. */
  gripFrames: 2,
  gripMinCutoff: 4,
  /** Fused curl (grip.ts fusedCurls): image curl at or below this = finger visibly extended, hand-world ignored … */
  gripImgOpenCurl: 0.25,
  /** … at or above this the finger looks short in the image (curled OR foreshortened): take max(image, world). */
  gripImgShortCurl: 0.55,
  /** One hand frame past these (normalized grip) fires grab / release at once, if the hand is seen clearly. */
  gripStrongOn: 0.85,
  gripStrongOff: 0.08,
  gripStrongMinScore: 0.85,
  /** … and the pose wrist visibility is at least this. */
  gripStrongMinWristVis: 0.5,
  /** A calibrated grip range never starts above / ends below these, so open and fist stay reachable. */
  gripRangeMaxMin: 0.25,
  gripRangeMinMax: 0.7,
  /** Hand lost but wrist still tracked: hold the last grip this long, then treat a closed hand as gripping. */
  gripHoldMs: 300,
  /** release.vel = mean velocity over this window … */
  releaseWindowMs: 80,
  /** … ending this long before the release fired (compensates grip-filter lag). */
  releaseLagMs: 0,
  /** Look this far back before a release for the throw's peak speed. */
  releasePeakWindowMs: 300,
  /** Hard cap on the look-back when it is extended over a hand-lost (motion blur) stretch. */
  releaseMaxLookbackMs: 700,

  // ── call_sign / request_weapon (C.5) ──
  /** Palm center within this of an ear (m). */
  callEarDist: 0.12,
  callHoldMs: 1000,
  callCooldownMs: 5000,
  /** Thumb tip ÷ palm distance from the index MCP above which the thumb counts as extended. */
  callThumbExt: 0.6,
  callPinkyMaxCurl: 0.45,
  callFingerMinCurl: 0.55,
  requestAboveHeadM: 0.15,
  requestHoldMs: 800,
  requestCooldownMs: 4000,
  requestMinVisibility: 0.3,

  // ── swing / block / drink / bow (C.5) ──
  swingSpeed: 2.2,
  swingRearmSpeed: 1.0,
  swingMinGrip: 0.5,
  /** Hands within this of eye height (m). */
  blockFaceDist: 0.35,
  /** |forward.y| below this = forearm roughly horizontal. */
  blockMaxForearmSlope: 0.6,
  blockHoldMs: 150,
  blockEndMs: 200,
  drinkMouthDist: 0.12,
  drinkHoldMs: 600,
  bowElbowAngle: 150,
  /** Left wrist must be at least this far forward (game z). */
  bowWristForwardZ: -0.4,
  bowNockDist: 0.15,
  bowMinDraw: 0.2,
  /** Left arm may drop this long before a nocked arrow is cancelled. */
  bowCancelMs: 700,
  /** Once nocked, the left elbow only has to stay above this (the arm softens while pulling). */
  bowHoldElbowAngle: 125,
  /** Left wrist must stay at least this far forward while nocked (a hanging arm is straight too). */
  bowHoldWristForwardZ: -0.3,
  /** After a full extension, the left arm stays nock-ready this long while roughly held out. */
  bowArmLatchMs: 1500,
  /** Right hand must read below this grip, seen by the hand model for bowReleaseFrames, to loose the arrow. */
  bowReleaseGrip: 0.35,
  bowReleaseFrames: 2,
  /** Opens below this draw are treated as tracking noise (sideways hand near the face): arrow stays nocked. */
  bowLooseMinDraw: 0.3,

  // ── calibration (C.6) ──
  /** Wall-clock safety net for the whole calibration (frames stopped arriving). */
  calibTimeoutMs: 90000,
  /** Each step fails if the movement is not seen within this. */
  calibStepTimeoutMs: 15000,
  /** Raw mean finger curl that counts as a fist / an open hand during the grip step. */
  calibFistRaw: 0.6,
  calibOpenRaw: 0.3,
  /** Hands must move slower than this (m/s) for "hold still" steps. */
  calibStillSpeed: 0.6,
  calibHipVisibility: 0.6,
  /** A hand's raw curl must span at least this during the fist/open step to replace the default range. */
  calibMinGripRange: 0.25,
};

export type MotionConfig = { -readonly [K in keyof typeof DEFAULT_CONFIG]: number };

/** Live, mutable config. Mutate fields in place; never reassign. */
export const config: MotionConfig = { ...DEFAULT_CONFIG };

export function resetConfig(): void {
  Object.assign(config, DEFAULT_CONFIG);
}

/** Slider ranges for the Motion Lab tuning panel: [min, max, step]. Grouped by section title. */
export const CONFIG_RANGES: Record<string, Partial<Record<keyof MotionConfig, [number, number, number]>>> = {
  Tracking: {
    trackingLostMs: [100, 2000, 50],
    trackingOkMs: [0, 1000, 50],
    degradedVisibility: [0, 1, 0.05],
    downgradeBelowFps: [0, 60, 1],
  },
  'Hand ROI': {
    handRoi: [0, 2, 1],
    handRoiScale: [3, 8, 0.1],
    handRoiCenterAlong: [0, 2.5, 0.05],
    handRoiSticky: [0, 0.4, 0.01],
    handRoiMinWristVis: [0, 0.8, 0.05],
    handRoiRetryBudgetMs: [0, 40, 1],
  },
  Mapping: {
    gameArmReach: [0.4, 1.2, 0.05],
    eyeToShoulderM: [0, 0.5, 0.01],
    depthBlend: [0, 1, 0.05],
    zNear: [-0.5, 0, 0.01],
    zFar: [-1.5, -0.4, 0.01],
    posMinCutoff: [0.1, 5, 0.1],
    posBeta: [0, 5, 0.01],
    zMinCutoff: [0.1, 5, 0.1],
    velMinCutoff: [0.5, 20, 0.5],
    dirSmoothing: [0.05, 1, 0.05],
    bodySmoothing: [0.05, 1, 0.05],
    crouchFullDropSw: [0.3, 3, 0.1],
    wristMinVisibility: [0, 1, 0.05],
    assocMaxDist: [0.05, 0.6, 0.01],
    maxExtrapolateMs: [0, 100, 5],
  },
  Grip: {
    gripOn: [0.3, 0.95, 0.01],
    gripOff: [0.05, 0.7, 0.01],
    gripFrames: [1, 6, 1],
    gripMinCutoff: [0.5, 15, 0.5],
    gripImgOpenCurl: [0, 0.5, 0.01],
    gripImgShortCurl: [0.3, 0.9, 0.01],
    gripStrongOn: [0.6, 1.01, 0.01],
    gripStrongOff: [-0.01, 0.35, 0.01],
    gripStrongMinScore: [0, 1, 0.05],
    gripStrongMinWristVis: [0, 1, 0.05],
    gripRangeMaxMin: [0, 0.5, 0.01],
    gripRangeMinMax: [0.5, 1, 0.01],
    gripHoldMs: [0, 1000, 50],
    releaseWindowMs: [16, 250, 4],
    releaseLagMs: [0, 150, 4],
    releasePeakWindowMs: [40, 500, 10],
    releaseMaxLookbackMs: [100, 1500, 50],
  },
  'Call sign / request weapon': {
    callEarDist: [0.04, 0.3, 0.01],
    callHoldMs: [200, 2000, 50],
    callCooldownMs: [0, 10000, 250],
    callThumbExt: [0.2, 1.2, 0.05],
    callPinkyMaxCurl: [0.1, 0.9, 0.05],
    callFingerMinCurl: [0.2, 0.95, 0.05],
    requestAboveHeadM: [0, 0.4, 0.01],
    requestHoldMs: [200, 2000, 50],
    requestCooldownMs: [0, 10000, 250],
    requestMinVisibility: [0, 1, 0.05],
  },
  'Swing / block / drink / bow': {
    swingSpeed: [0.5, 6, 0.1],
    swingRearmSpeed: [0.2, 3, 0.1],
    swingMinGrip: [0, 1, 0.05],
    blockFaceDist: [0.1, 0.8, 0.01],
    blockMaxForearmSlope: [0.1, 1, 0.05],
    blockHoldMs: [0, 600, 10],
    blockEndMs: [0, 800, 10],
    drinkMouthDist: [0.04, 0.3, 0.01],
    drinkHoldMs: [100, 2000, 50],
    bowElbowAngle: [110, 180, 1],
    bowWristForwardZ: [-0.8, -0.1, 0.01],
    bowNockDist: [0.05, 0.4, 0.01],
    bowMinDraw: [0, 0.8, 0.01],
    bowCancelMs: [0, 2000, 50],
    bowHoldElbowAngle: [90, 170, 1],
    bowHoldWristForwardZ: [-0.8, 0, 0.01],
    bowArmLatchMs: [0, 4000, 100],
    bowReleaseGrip: [0.05, 0.6, 0.01],
    bowReleaseFrames: [1, 8, 1],
    bowLooseMinDraw: [0, 0.8, 0.01],
  },
};
