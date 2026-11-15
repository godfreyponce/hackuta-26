// Webcam thrusts, checked without a browser: scripted sword moves (scripts/swordMoves.ts — Part C's test synth plus
// tracker noise, at the real tracker's cadence) and Part C's real recordings (packages/motion/fixtures) go through
// Part C's motion Engine and the game's ThrustReader (src/game/engine/thrust.ts) at 60 Hz, as the game runs them.
// Thrusts must be read as thrusts; slashes, chops and the real recordings (none of them a thrust) must never start one.
// Run: cd apps/web && npx tsx scripts/thrust-check.ts   (exit code 1 on a failure; THRUST_DEBUG=1 traces false starts)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Engine, replayProfile, type Recording } from '../../../packages/motion/src/index';
import { ThrustReader } from '../src/game/engine/thrust';
import { MOVES, swordMove, type SwordMove } from './swordMoves';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/motion/fixtures');

/** thrust starts (ms) per hand, the game's way: Part C's state extrapolated to 'now', 60 Hz, armed once a hand has been seen 0.3 s */
function starts(rec: Recording, trace?: [number, number]) {
  const eng = new Engine(replayProfile(rec));
  eng.aspect = rec.meta.aspect;
  eng.begin();
  const rd = { left: new ThrustReader(), right: new ThrustReader() };
  const out: Record<'left' | 'right', number[]> = { left: [], right: [] };
  // how hard each thrust drives the point (m/s, the most the stab reads in its first 0.3 s)
  const drives: Record<'left' | 'right', number[]> = { left: [], right: [] };
  const since = { left: -1, right: -1 };
  const seen = { left: -1, right: -1 };
  const vel = new THREE.Vector3(), fwd = new THREE.Vector3(), depth = new THREE.Vector3(0, 0, 1);
  const F = rec.frames;
  let fi = 0;
  const dur = F[F.length - 1]?.t ?? 0;
  for (let wall = 0; wall <= dur; wall += 1000 / 60) {
    while (fi < F.length && F[fi]!.t <= wall) { eng.push(F[fi]!, F[fi]!.t); fi++; }
    const st = eng.getState(wall);
    for (const h of ['left', 'right'] as const) {
      const hs = st.hands[h];
      if (!hs.visible) seen[h] = -1; else if (seen[h] < 0) seen[h] = wall;
      vel.set(hs.vel.x, hs.vel.y, hs.vel.z);
      fwd.set(hs.forward.x, hs.forward.y, hs.forward.z).normalize();
      const was = rd[h].on;
      rd[h].update(wall / 1000, 1 / 60, vel, fwd, depth, hs.visible && seen[h] >= 0 && wall - seen[h] > 300, false);
      if (!was && rd[h].on) { out[h].push(Math.round(wall)); drives[h].push(0); since[h] = wall; }
      const sv = rd[h].stab?.v;
      if (sv !== undefined && wall - since[h] <= 300 && drives[h].length) drives[h][drives[h].length - 1] = Math.max(drives[h][drives[h].length - 1]!, sv);
      if (trace && h === 'right' && wall >= trace[0] && wall <= trace[1]) {
        console.log(`    ${Math.round(wall)} on ${+rd[h].on} vEff ${rd[h].vEff.toFixed(2)} travel ${rd[h].travel.toFixed(3)} across ${rd[h].across.toFixed(3)} vel ${vel.toArray().map((x) => x.toFixed(2))} fwd ${fwd.toArray().map((x) => x.toFixed(2))}`);
      }
    }
  }
  return { out, dur, drives };
}

const SEEDS = [7, 11, 23];
let ok = true;
const check = (label: string, pass: boolean, detail: string) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  ${detail}`); ok &&= pass; };
// a thrust's point must go through linen (the linothorax, the bracers): enemies.ts VPEN.linen thrust speed
const LINEN_THRUST = 4;
for (const [name, need] of [['thrust', 9], ['jab', 7], ['diagonal', 7]] as const) {
  let caught = 0;
  const lat: number[] = [];
  const dv: number[] = [];
  for (const seed of SEEDS) {
    const { out, drives } = starts(swordMove(name, seed));
    dv.push(...drives.right);
    for (const t0 of MOVES[name].onsets) {
      const s = out.right.find((t) => t >= t0 - 100 && t <= t0 + 450);
      if (s !== undefined) { caught++; lat.push(s - t0); }
    }
  }
  check(`scripted ${name}: read as a thrust`, caught >= need, `${caught}/9 (need ${need}) · ms after onset ${lat.join(' ')}`);
  check(`scripted ${name}: drives through linen`, dv.length > 0 && dv.every((v) => v >= LINEN_THRUST), `m/s ${dv.map((v) => v.toFixed(1)).join(' ')} (need ≥ ${LINEN_THRUST})`);
}
for (const name of ['slash', 'chop'] as SwordMove[]) {
  const fs = SEEDS.map((seed) => {
    const { out } = starts(swordMove(name, seed));
    if (process.env.THRUST_DEBUG && out.left.length + out.right.length) {
      console.log(`  (${name} seed ${seed}: starts at ${JSON.stringify(out)})`);
      const t = out.right[0] ?? out.left[0] ?? 0;
      starts(swordMove(name, seed), [t - 220, t + 20]);
    }
    return out.left.length + out.right.length;
  });
  check(`scripted ${name}: never a thrust`, fs.every((n) => n === 0), `false starts per seed ${fs.join(' ')}`);
}
let realFalse = 0, realMin = 0;
for (const f of readdirSync(FIXTURES).filter((x) => x.endsWith('.json'))) {
  const rec = JSON.parse(readFileSync(resolve(FIXTURES, f), 'utf8')) as Recording;
  const { out, dur } = starts(rec);
  realFalse += out.left.length + out.right.length;
  realMin += dur / 60000;
}
check("Part C's real recordings (throw, bow, block, call, drink — no thrusts): never a thrust", realFalse === 0, `${realFalse} false starts in ${realMin.toFixed(2)} min`);
console.log(ok ? '\nthrust check passed' : '\nthrust check FAILED');
process.exit(ok ? 0 : 1);
