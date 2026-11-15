export type PinState = {
  weaponCame: boolean;
  scanFailed: boolean;
  /** A scan or forge is open. */
  askOpen: boolean;
  /** The pinned line is queued or playing. It never goes stale, so a second copy would pile up. */
  linePending: boolean;
};

/** The first pin started the call, so a pin speaks only after a weapon came or a scan failed (owner). */
export function pinAction(s: PinState): 'silent' | 'say' | 'sayAndScan' {
  if (s.askOpen || s.linePending) return 'silent';
  if (s.weaponCame) return 'say';
  return s.scanFailed ? 'sayAndScan' : 'silent';
}
