// Every tunable threshold lives here (spec §8 C.5). The Motion Lab edits `config` live.
// Distances are meters, times ms, speeds m/s in game space unless noted.

export const DEFAULT_CONFIG = {
  // ── tracking (C.5 / C.9) ──
  trackingLostMs: 500,
  trackingOkMs: 300,
  degradedVisibility: 0.5,
  downgradeBelowFps: 40,

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
  wristMinVisibility: 0.5,
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
  /** Hand lost but wrist still tracked: hold the last grip this long, then treat a closed hand as gripping. */
  gripHoldMs: 300,
  /** release.vel = mean velocity over this window … */
  releaseWindowMs: 80,
  /** … ending this long before the release fired (compensates grip-filter lag). */
  releaseLagMs: 0,

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
    gripHoldMs: [0, 1000, 50],
    releaseWindowMs: [16, 250, 4],
    releaseLagMs: [0, 150, 4],
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
};
