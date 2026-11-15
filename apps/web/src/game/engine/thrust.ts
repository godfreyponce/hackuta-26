// Webcam thrusts. A body player stabs by pushing his fist toward a wooer with the blade pointing at him — mostly along
// the camera's depth axis, the one a webcam measures worst: Part C's hand depth is monocular and heavily filtered
// (it arrives ~0.3 s late and at ~⅓ of the real speed), while the forearm (the blade's direction) rotates and jitters
// in the image plane. Judged per physics step, such a thrust is a slow, sideways-wobbling blade: no stab (and below
// 0.8 m/s it isn't even hit-tested — the blade slid silently into him).
// So a thrust is read here from Part C's low-lag hand VELOCITY (derived from the unfiltered position), with its depth
// part scaled back up (so a push into the screen isn't mistaken for a sideways sweep), along the blade. It has to be a
// real push — travel along the blade over the last 0.2 s, not one noisy depth sample. While it lasts it is the stab's
// direction and speed, and the depth the camera missed is added to the hand along the blade (a lunge), so the point
// really goes in — and through.
import * as THREE from 'three';

export const WC_THRUST = {
  /** the hand's depth speed is under-measured ≈ this many times (×, on the camera's depth axis) */
  depthGain: 3.2,
  /** a thrust starts when, over the last `win` s, the hand has travelled this far along the blade (m, corrected)… */
  travel: 0.2,
  win: 0.2,
  /** …this many times more along the blade than across it… */
  straight: 2,
  /** …and has just driven along the blade at this speed (m/s, corrected; the peak of the last 0.12 s), within this
   *  cosine of it… */
  start: 1.7,
  cos: 0.85,
  /** …with the blade pointing into the hall: its share of the camera's depth axis ≥ this, and not steeply up or down */
  aimDepth: 0.55,
  aimPitch: 0.7,
  /** …and not a cut's wind-up: the hand rising faster than this (m/s) while the blade tips up by more than this
   *  (Δ of its vertical component over the window) */
  windupRise: 0.3,
  windupTip: 0.08,
  /** it ends when the hand draws back faster than this (m/s along the blade)… */
  retract: -1.2,
  /** …moves across the blade faster than this (m/s: a slash, not a thrust)… */
  lateral: 3,
  /** …or has stopped pushing (< 3 cm along the blade in 0.15 s) for this long (s) */
  idle: 0.3,
  /** the longest single thrust (s) */
  maxDur: 1.4,
  /** the most the lunge adds along the blade (m)… */
  maxExt: 0.24,
  /** …reached no sooner than this after the thrust starts (s); with the point in a man, pushing on reaches this (m) */
  pace: 0.2,
  maxExtIn: 0.36,
};

export interface ThrustStab {
  /** how hard the point is driven (m/s, the thrust's peak corrected speed along the blade) */
  v: number;
  /** the line it's driven along (unit, world) */
  dir: THREE.Vector3;
}

const _vc = new THREE.Vector3();

export class ThrustReader {
  on = false;
  t0 = 0;
  peak = 0;
  /** the lunge: metres added to the hand along the blade */
  ext = 0;
  lastPushT = -9;
  readonly dir = new THREE.Vector3(0, 0, -1);
  /** last corrected along-blade speed (diagnostics) */
  vEff = 0;
  /** corrected travel along / across the blade over the window (diagnostics) */
  travel = 0;
  across = 0;
  starts = 0;
  private hist: { t: number; a: number; l: number; v: number; fy: number }[] = [];

  /**
   * @param vel hand velocity (game frame, m/s) — Part C's low-lag one, as measured
   * @param fwd blade direction (game frame, unit)
   * @param depthAxis the camera's depth axis in the game frame (unit)
   * @param armed the hand holds a pointed blade and is tracked
   * @param lodged the blade is in a man: the lunge holds (it doesn't drift back out of him) unless you draw back
   */
  update(now: number, dt: number, vel: THREE.Vector3, fwd: THREE.Vector3, depthAxis: THREE.Vector3, armed: boolean, lodged: boolean) {
    if (!armed) { this.on = false; this.ext *= Math.exp(-dt / 0.3); this.vEff = 0; this.hist.length = 0; return; }
    // the velocity with its depth part restored
    const vz = vel.dot(depthAxis);
    const vc = _vc.copy(vel).addScaledVector(depthAxis, vz * (WC_THRUST.depthGain - 1));
    const along = vc.dot(fwd);
    const sp = vc.length();
    const lat = Math.sqrt(Math.max(0, sp * sp - along * along));
    this.vEff = along;
    // (a speed only counts as driving the point if the hand moved within `cos` of the blade)
    this.hist.push({ t: now, a: along * dt, l: lat * dt, v: along >= WC_THRUST.cos * sp ? along : 0, fy: fwd.y });
    while (this.hist.length && now - this.hist[0]!.t > WC_THRUST.win) this.hist.shift();
    let travel = 0, across = 0, recent = 0, drive = 0;
    for (const h of this.hist) {
      travel += h.a; across += h.l;
      if (now - h.t <= 0.15) recent += h.a;
      if (now - h.t <= 0.12) drive = Math.max(drive, h.v); // the tracker updates in chunks: the push's latest peak
    }
    this.travel = travel; this.across = across;
    if (!this.on) {
      // the point aimed into the hall (at a man — not raised overhead for a cut, nor dropped low)
      const aimed = Math.abs(fwd.dot(depthAxis)) >= WC_THRUST.aimDepth && Math.abs(fwd.y) <= WC_THRUST.aimPitch;
      // a cut's wind-up: the arm going up, the blade tipping up with it (the arm foreshortens, so it reads as depth)
      const windup = vel.y > WC_THRUST.windupRise && fwd.y - (this.hist[0]?.fy ?? fwd.y) > WC_THRUST.windupTip;
      if (aimed && !windup && drive >= WC_THRUST.start && along > 0 && travel >= WC_THRUST.travel && travel >= WC_THRUST.straight * across) {
        this.on = true; this.t0 = now; this.peak = drive; this.lastPushT = now; this.dir.copy(fwd); this.starts++;
      }
    } else {
      if (recent > 0.03) this.lastPushT = now;
      this.peak = Math.max(this.peak, along);
      this.dir.lerp(fwd, Math.min(1, dt * 8)).normalize();
      if (along < WC_THRUST.retract || lat > WC_THRUST.lateral || now - this.lastPushT > WC_THRUST.idle || now - this.t0 > WC_THRUST.maxDur) this.on = false;
    }
    // what the camera's depth missed of the push goes onto the hand along the blade, paced like a real arm's thrust
    // (~0.2 s: the point arrives as the push peaks, not while it is still gathering); drawing back takes it back
    // (once the point is in him, pushing on drives it deeper — through him and out of the cloak on his back)
    const missing = (along - vel.dot(fwd)) * dt;
    const cap = lodged ? WC_THRUST.maxExtIn : WC_THRUST.maxExt * Math.min(1, (now - this.t0) / WC_THRUST.pace);
    if (this.on && missing > 0) this.ext = Math.min(Math.max(cap, this.ext), this.ext + missing);
    else if (missing < 0 && along < 0) this.ext = Math.max(0, this.ext + missing * 1.3);
    if (!this.on && !lodged) this.ext *= Math.exp(-dt / 0.45);
  }

  get stab(): ThrustStab | null { return this.on ? { v: this.peak, dir: this.dir } : null; }

  reset() { this.on = false; this.ext = 0; this.peak = 0; this.vEff = 0; this.hist.length = 0; }
}
