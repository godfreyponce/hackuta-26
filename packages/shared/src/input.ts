// Coordinate convention: game camera space, meters, right-handed.
// +X is the player's right, +Y is up, −Z is forward (into the screen), origin at the player's eyes.
// Un-mirrored: the player's real right hand is `right`, even though the webcam image is mirrored.

export interface Vec3 { x: number; y: number; z: number }
export type Hand = 'left' | 'right';

export interface HandState {
  visible: boolean;
  confidence: number;       // 0..1
  pos: Vec3;                // wrist/palm center, camera space (m)
  vel: Vec3;                // m/s, smoothed (One-Euro) — used for throws/slashes
  grip: number;             // 0 = open palm … 1 = closed fist
  forward: Vec3;            // unit vector: forearm direction elbow→wrist (aim / blade direction)
  up: Vec3;                 // unit vector: back-of-hand normal (blade roll)
}

export interface PlayerInputState {
  t: number;                // performance.now()
  tracking: 'ok' | 'degraded' | 'lost' | 'calibrating' | 'off';
  hands: Record<Hand, HandState>;
  body: {
    lean: number;           // -1 (left) .. 1 (right) — dodge
    crouch: number;         // 0 .. 1
    yaw: number;            // radians, shoulder line rotation (subtle look)
  };
  bowDraw: number;          // 0..1 when bow pose detected, else 0
}

export type InputEvent =
  | { type: 'grab'; hand: Hand }
  | { type: 'release'; hand: Hand; vel: Vec3 }            // open hand; game decides drop vs throw
  | { type: 'swing'; hand: Hand; speed: number; dir: Vec3 } // speed > swing threshold
  | { type: 'block_start' } | { type: 'block_end' }
  | { type: 'bow_nock' } | { type: 'bow_release'; draw: number; aim: Vec3 }
  | { type: 'drink'; hand: Hand }                         // hand-to-mouth hold 0.6s
  | { type: 'call_sign' }                                 // "phone" gesture by the ear, hold 1s
  | { type: 'request_weapon' }                            // both arms raised overhead, hold 0.8s
  | { type: 'tracking_lost' } | { type: 'tracking_ok' };

export interface InputController {
  readonly kind: 'motion' | 'keyboard_mouse' | 'replay';
  start(): Promise<void>;
  stop(): void;
  getState(): PlayerInputState;                 // called every render frame by the game
  on(cb: (e: InputEvent) => void): () => void;  // returns unsubscribe
  calibrate?(): Promise<CalibrationResult>;
  getDebugVideo?(): HTMLVideoElement | null;    // for the calibration screen / PIP
}

export interface CalibrationResult {
  ok: boolean;
  armLengthM: number;
  shoulderWidthM: number;
  neutral: { lean: number; crouch: number };
}
