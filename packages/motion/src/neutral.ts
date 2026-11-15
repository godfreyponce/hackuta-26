import type { Hand, HandState, PlayerInputState, Vec3 } from '@ithaca/shared';

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** Resting hand positions in game camera space (origin = eyes, −Z forward). */
export const NEUTRAL_HAND_POS: Record<Hand, Readonly<Vec3>> = {
  left: { x: -0.22, y: -0.45, z: -0.3 },
  right: { x: 0.22, y: -0.45, z: -0.3 },
};

export function neutralHand(hand: Hand): HandState {
  const p = NEUTRAL_HAND_POS[hand];
  return {
    visible: false,
    confidence: 0,
    pos: vec3(p.x, p.y, p.z),
    vel: vec3(),
    grip: 0,
    forward: vec3(0, 0, -1),
    up: vec3(0, 1, 0),
  };
}

export function neutralState(tracking: PlayerInputState['tracking'] = 'off'): PlayerInputState {
  return {
    t: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    tracking,
    hands: { left: neutralHand('left'), right: neutralHand('right') },
    body: { lean: 0, crouch: 0, yaw: 0 },
    bowDraw: 0,
  };
}
