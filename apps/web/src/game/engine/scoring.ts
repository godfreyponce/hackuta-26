import type { TrickshotKind } from '@ithaca/shared';

export const TRICK_POINTS: Record<TrickshotKind, number> = {
  pin: 500, ricochet: 300, multi_kill: 400, airborne: 250, long_shot: 200, headshot: 150, friend_assist: 300, return_to_sender: 600,
};

export const TRICK_TITLES: Record<TrickshotKind, string> = {
  pin: 'PINNED',
  ricochet: 'RICOCHET',
  multi_kill: 'TWO WITH ONE',
  airborne: 'AIRBORNE',
  long_shot: 'LONG SHOT',
  headshot: 'HEADSHOT',
  friend_assist: 'TELEMACHUS ASSIST',
  return_to_sender: 'RETURN TO SENDER',
};

export interface KillCtx {
  t: number;              // sim seconds
  realT: number;
  zone: 'head' | 'torso' | 'limb';
  distance: number;
  airborne: boolean;
  ricochet: boolean;
  multiCount: number;     // kills by this projectile within 1.5 s (incl. this one)
  forged: boolean;
  returnToSender: boolean;
}

export interface KillResult { points: number; tricks: TrickshotKind[]; slowmo: boolean; combo: number }

export class Scoring {
  score = 0;
  kills = 0;
  combo = 1;
  bestCombo = 1;
  private lastKillT = -99;
  private lastSlowmo = -99;
  private seen = new Set<TrickshotKind>();
  trickshots: Record<TrickshotKind, number> = {
    pin: 0, ricochet: 0, multi_kill: 0, airborne: 0, long_shot: 0, headshot: 0, friend_assist: 0, return_to_sender: 0,
  };

  reset() {
    this.score = 0; this.kills = 0; this.combo = 1; this.bestCombo = 1; this.lastKillT = -99; this.lastSlowmo = -99;
    this.seen.clear();
    for (const k of Object.keys(this.trickshots) as TrickshotKind[]) this.trickshots[k] = 0;
  }

  onKill(c: KillCtx): KillResult {
    this.kills++;
    this.combo = c.t - this.lastKillT < 3 ? Math.min(3, this.combo + 0.25) : 1;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.lastKillT = c.t;
    const tricks: TrickshotKind[] = [];
    if (c.zone === 'head') tricks.push('headshot');
    if (c.distance > 15) tricks.push('long_shot');
    if (c.airborne) tricks.push('airborne');
    if (c.ricochet) tricks.push('ricochet');
    if (c.forged) tricks.push('friend_assist');
    if (c.returnToSender) tricks.push('return_to_sender');
    let bonus = 0;
    if (c.multiCount >= 2) {
      tricks.push('multi_kill');
      bonus += c.multiCount === 2 ? TRICK_POINTS.multi_kill * 2 : TRICK_POINTS.multi_kill;
    }
    for (const k of tricks) { this.trickshots[k]++; if (k !== 'multi_kill') bonus += TRICK_POINTS[k]; }
    const points = Math.round((100 + bonus) * this.combo);
    this.score += points;
    const wantsSlow = tricks.includes('multi_kill') || tricks.includes('friend_assist') || tricks.includes('return_to_sender') || tricks.length >= 2;
    const slowmo = wantsSlow && this.allowSlowmo(c.realT, tricks);
    return { points, tricks, slowmo, combo: this.combo };
  }

  onPin(realT: number): { points: number; slowmo: boolean } {
    this.trickshots.pin++;
    const points = Math.round(TRICK_POINTS.pin * this.combo);
    this.score += points;
    return { points, slowmo: this.allowSlowmo(realT, ['pin']) };
  }

  addPoints(n: number) { this.score += n; }

  /** ≤ 1 killcam per 15 s, except the first of each trickshot type always plays. */
  private allowSlowmo(realT: number, tricks: TrickshotKind[]) {
    const fresh = tricks.some((k) => !this.seen.has(k));
    tricks.forEach((k) => this.seen.add(k));
    if (fresh || realT - this.lastSlowmo > 15) { this.lastSlowmo = realT; return true; }
    return false;
  }
}
