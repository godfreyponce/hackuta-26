// Match structure (spec A.6) — fits inside the 5-minute FaceTime limit (~3.5–4 min).
import * as THREE from 'three';
import type { EnemyKind } from './enemies';
import { HALL } from './hall';
import { rand } from './math';

export interface WaveDef {
  n: number;
  title: string;
  sub: string;
  spawns: EnemyKind[];
  /** indices into `spawns` of the men who carry the aspis */
  shields: number[];
  maxAlive: number;
  interval: [number, number];
}

// Lines quoted from Odyssey XXII, tr. Butcher & Lang (1879, public domain).
export const WAVES: WaveDef[] = [
  { n: 1, title: 'The Bow Is Strung', sub: '“Lo, now is this terrible trial ended at last.”',
    // a couple of the revelers snatched the old feast-hall shields off the wall
    spawns: ['suitor', 'suitor', 'suitor', 'suitor', 'suitor', 'suitor'], shields: [2, 4], maxAlive: 4, interval: [1.4, 2.4] },
  { n: 2, title: 'The Wooers Rally', sub: '“Draw your blades, and hold up the tables.”',
    // about half the swordsmen hold up shields (and Melanthius brings more from the storeroom)
    spawns: ['suitor', 'suitor', 'archer', 'suitor', 'suitor', 'suitor', 'archer', 'suitor', 'suitor', 'suitor'], shields: [1, 3, 5, 8], maxAlive: 5, interval: [1.2, 2.2] },
  { n: 3, title: 'Antinous', sub: 'The first of the wooers, and the last.',
    // the hoplite core round Antinous (he has his gilded shield until it falls in phase 2)
    spawns: ['boss', 'suitor', 'suitor', 'suitor', 'suitor', 'suitor', 'suitor'], shields: [1, 2, 4, 5], maxAlive: 5, interval: [1.6, 2.6] },
];

const SPAWN_BENCHES: [number, number][] = [[-2.6, -8.4], [2.6, -9.6], [-2.6, -11.2], [2.6, -12.4], [-2.4, -7.2], [2.4, -10.6]];

export type DirectorPhase = 'intro' | 'fight' | 'cleared' | 'done';

export interface DirectorHooks {
  /** `shield`: this man carries the aspis (undefined: the default for his kind) */
  spawn(kind: EnemyKind, at: THREE.Vector3, shield?: boolean): boolean;
  aliveCount(): number;
  onWaveStart(w: WaveDef): void;
  onWaveCleared(w: WaveDef): void;
  onMelanthius(): void;
  onBoss(): void;
  onVictory(): void;
  onStragglers(): void;
}

export class Director {
  wave = 0;
  phase: DirectorPhase = 'intro';
  private phaseT = 0;
  private spawnIdx = 0;
  private nextSpawn = 0;
  private door = 0;
  private melanthiusFired = false;
  private stragglerT = 0;
  private charged = false;
  waveT = 0;

  constructor(private hooks: DirectorHooks) {}

  get def(): WaveDef { return WAVES[Math.max(0, Math.min(WAVES.length - 1, this.wave - 1))]; }
  get remaining() { return this.wave ? this.def.spawns.length - this.spawnIdx + this.hooks.aliveCount() : 0; }

  reset() {
    this.wave = 0;
    this.phase = 'intro';
    this.phaseT = 0;
    this.spawnIdx = 0;
    this.nextSpawn = 0;
    this.melanthiusFired = false;
    this.waveT = 0;
    this.stragglerT = 0;
    this.charged = false;
  }

  start() {
    this.reset();
    this.wave = 1;
    this.beginWave();
  }

  private beginWave() {
    this.phase = 'intro';
    this.phaseT = 0;
    this.spawnIdx = 0;
    this.nextSpawn = 0;
    this.waveT = 0;
    this.stragglerT = 0;
    this.charged = false;
    this.hooks.onWaveStart(this.def);
  }

  update(dt: number) {
    this.phaseT += dt;
    if (this.phase === 'done') return;
    if (this.phase === 'intro') {
      if (this.phaseT > 2.6) { this.phase = 'fight'; this.phaseT = 0; }
      return;
    }
    if (this.phase === 'fight') {
      this.waveT += dt;
      const d = this.def;
      if (d.n === 2 && !this.melanthiusFired && this.waveT > 30) { this.melanthiusFired = true; this.hooks.onMelanthius(); }
      this.nextSpawn -= dt;
      if (this.spawnIdx < d.spawns.length && this.nextSpawn <= 0 && this.hooks.aliveCount() < d.maxAlive) {
        const kind = d.spawns[this.spawnIdx];
        // pacing: wooers rise from the feast benches along the walls (8–13 m out, staggered sides) instead of
        // walking the whole 26 m hall single-file; every third comes through the doors; Antinous strides in close
        const k = this.door++;
        const bench = SPAWN_BENCHES[k % SPAWN_BENCHES.length];
        const door = HALL.doors[k % 2];
        const at = kind === 'boss' ? new THREE.Vector3(rand(-0.6, 0.6), 0, -9.5)
          : k % 3 === 2 ? new THREE.Vector3(door.x + rand(-0.5, 0.5), 0, door.z + 0.6)
          : new THREE.Vector3(bench[0] + rand(-0.3, 0.3), 0, bench[1] + rand(-0.6, 0.6));
        // the director says who carries a shield; Melanthius's storeroom (wave 2, 30 s in) arms some of the rest
        const shield = d.shields.includes(this.spawnIdx) ? true : d.n === 2 ? undefined : false;
        if (this.hooks.spawn(kind, at, shield)) {
          this.spawnIdx++;
          if (kind === 'boss') this.hooks.onBoss();
          this.nextSpawn = rand(d.interval[0], d.interval[1]);
        } else this.nextSpawn = 0.5;
      }
      if (this.spawnIdx >= d.spawns.length && this.hooks.aliveCount() === 0) {
        this.phase = 'cleared';
        this.phaseT = 0;
        this.hooks.onWaveCleared(d);
        return;
      }
      // pacing guard (fits the 5-minute call): stragglers charge, then the next wave storms in anyway
      if (this.spawnIdx >= d.spawns.length && this.hooks.aliveCount() <= 2) {
        this.stragglerT += dt;
        if (this.stragglerT > 15 && !this.charged) { this.charged = true; this.hooks.onStragglers(); }
        if (this.stragglerT > 30 && this.wave < WAVES.length) { this.wave++; this.beginWave(); }
      } else this.stragglerT = 0;
      return;
    }
    if (this.phase === 'cleared' && this.phaseT > 4.2) {
      if (this.wave >= WAVES.length) { this.phase = 'done'; this.hooks.onVictory(); return; }
      this.wave++;
      this.beginWave();
    }
  }
}
