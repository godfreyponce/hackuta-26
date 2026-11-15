// Every tunable threshold lives here (spec §8 C.5). The Motion Lab edits `config` live.

export const DEFAULT_CONFIG = {
  // ── tracking (C.5 / C.9) ──
  trackingLostMs: 500,
  trackingOkMs: 300,
  degradedVisibility: 0.5,
  downgradeBelowFps: 40,
};

export type MotionConfig = { -readonly [K in keyof typeof DEFAULT_CONFIG]: number };

/** Live, mutable config. Mutate fields in place; never reassign. */
export const config: MotionConfig = { ...DEFAULT_CONFIG };

export function resetConfig(): void {
  Object.assign(config, DEFAULT_CONFIG);
}

/** Slider ranges for the Motion Lab tuning panel: [min, max, step]. */
export const CONFIG_RANGES: Partial<Record<keyof MotionConfig, [number, number, number]>> = {
  trackingLostMs: [100, 2000, 50],
  trackingOkMs: [0, 1000, 50],
  degradedVisibility: [0, 1, 0.05],
  downgradeBelowFps: [0, 60, 1],
};
