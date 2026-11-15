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
  maxAlive: number;
  interval: [number, number];
}

// Lines quoted from Odyssey XXII, tr. Butcher & Lang (1879, public domain).
export const WAVES: WaveDef[] = [
  { n: 1, title: 'The Bow Is Strung', sub: '“Lo, now is this terrible trial ended at last.”',
    spawns: ['suitor', 'suitor', 'suitor', 'suitor', 'suitor', 'suitor'], maxAlive: 4, interval: [3.2, 5.0] },
  { n: 2, title: 'The Wooers Rally', sub: '“Draw your blades, and hold up the tables.”',
    spawns: ['suitor', 'suitor', 'archer', 'suitor', 'suitor', 'suitor', 'suitor', 'archer', 'suitor', 'suitor', 'suitor', 'suitor'], maxAlive: 6, interval: [2.4, 4.0] },
  { n: 3, title: 'Antinous', sub: 'The first of the wooers, and the last.',
    spawns: ['suitor', 'boss', 'suitor', 'suitor', 'suitor', 'suitor', 'suitor'], maxAlive: 5, interval: [2.6, 4.2] },
];

export type DirectorPhase = 'intro' | 'fight' | 'cleared' | 'done';

export interface DirectorHooks {
  spawn(kind: EnemyKind, at: THREE.Vector3): boolean;
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
        const door = HALL.doors[this.door++ % 2];
        const at = new THREE.Vector3(door.x + rand(-0.5, 0.5), 0, door.z + 0.6);
        if (this.hooks.spawn(kind, at)) {
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
