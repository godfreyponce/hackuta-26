// Per-player calibration profile (C.6). Persisted in localStorage.
import type { Hand } from '@ithaca/shared';

export interface Profile {
  version: 1;
  calibrated: boolean;
  /** shoulder→elbow→wrist, pose-world meters. */
  armLengthM: number;
  /** Pose-world shoulder width (m). */
  shoulderWidthM: number;
  /** Apparent upper arm / forearm image length ÷ image shoulder width, at full sideways extension. */
  upperArmImgRatio: number;
  forearmImgRatio: number;
  /** Image-space (aspect-corrected, units of image height) neutral shoulder midpoint + width. */
  neutral: { x: number; y: number; swImg: number } | null;
  /** Raw finger-curl range per hand, used to normalize grip to 0..1. */
  grip: Record<Hand, { min: number; max: number }>;
}

export const DEFAULT_PROFILE: Readonly<Profile> = {
  version: 1,
  calibrated: false,
  armLengthM: 0.58,
  shoulderWidthM: 0.34,
  upperArmImgRatio: 0.85,
  forearmImgRatio: 0.8,
  neutral: null,
  grip: { left: { min: 0.1, max: 0.9 }, right: { min: 0.1, max: 0.9 } },
};

export const cloneProfile = (p: Readonly<Profile>): Profile => JSON.parse(JSON.stringify(p)) as Profile;

const KEY = 'ithaca.motion.profile.v1';

export function loadProfile(): Profile | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Profile>;
    if (p.version !== 1 || typeof p.armLengthM !== 'number' || !p.grip) return null;
    return { ...cloneProfile(DEFAULT_PROFILE), ...p } as Profile;
  } catch {
    return null;
  }
}

export function saveProfile(p: Profile): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode / blocked storage: calibration just won't persist */
  }
}

export function clearSavedProfile(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
