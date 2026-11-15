// One-Euro filter (Casiez et al. 2012). Low lag when moving fast, low jitter when still.
import type { Vec3 } from '@ithaca/shared';

const alpha = (cutoffHz: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  private x = 0;
  private dx = 0;
  private init = false;

  constructor(
    public minCutoff: number,
    public beta: number,
    public dCutoff = 1,
  ) {}

  /** dt in seconds. */
  filter(value: number, dt: number): number {
    if (!this.init || dt <= 0) {
      this.init = true;
      this.x = value;
      this.dx = 0;
      return value;
    }
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  get value(): number {
    return this.x;
  }

  reset(): void {
    this.init = false;
  }
}

export class OneEuro3 {
  readonly x: OneEuro;
  readonly y: OneEuro;
  readonly z: OneEuro;

  constructor(minCutoff: number, beta: number, zMinCutoff = minCutoff) {
    this.x = new OneEuro(minCutoff, beta);
    this.y = new OneEuro(minCutoff, beta);
    this.z = new OneEuro(zMinCutoff, beta);
  }

  /** Filters `v` into `out` (may be the same object). */
  filter(out: Vec3, v: Vec3, dt: number): Vec3 {
    out.x = this.x.filter(v.x, dt);
    out.y = this.y.filter(v.y, dt);
    out.z = this.z.filter(v.z, dt);
    return out;
  }

  tune(minCutoff: number, beta: number, zMinCutoff = minCutoff): void {
    this.x.minCutoff = this.y.minCutoff = minCutoff;
    this.z.minCutoff = zMinCutoff;
    this.x.beta = this.y.beta = this.z.beta = beta;
  }

  reset(): void {
    this.x.reset();
    this.y.reset();
    this.z.reset();
  }
}
