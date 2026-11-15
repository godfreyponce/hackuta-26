// Runs every recording in fixtures/ through the engine and checks that the gesture named by the
// file name fires. Record them in the Motion Lab (label = gesture), then drop the .json files in fixtures/.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@ithaca/shared';
import { parseRecording, replayProfile, runReplay } from '../src/recording';

const DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** File-name prefix → events that must appear at least once. */
const EXPECT: Record<string, InputEvent['type'][]> = {
  throw: ['grab', 'release'],
  bow: ['bow_nock', 'bow_release'],
  block: ['block_start', 'block_end'],
  call: ['call_sign'],
  drink: ['drink'],
  request: ['request_weapon'],
  swing: ['swing'],
};

/**
 * File-name prefix → events that must NOT appear. A raised fist by the face read as a drink in combat (live play
 * log: hold:drink / drink mid-fight); on these recordings the guard and the bow anchor did the same 5 times.
 */
const FORBID: Record<string, InputEvent['type'][]> = {
  block: ['drink'],
  bow: ['drink'],
  throw: ['drink'],
  call: ['drink'],
};

const files = (() => {
  try {
    return readdirSync(DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
})();

describe('reference recordings (fixtures/)', () => {
  it.skipIf(files.length > 0)('no recordings committed yet — see fixtures/README.md', () => {});

  for (const file of files) {
    const key = Object.keys(EXPECT).find((k) => file.toLowerCase().startsWith(k));
    it(`${file} → ${key ? EXPECT[key]?.join(', ') : '(no expectation; just must not crash)'}`, () => {
      const rec = parseRecording(readFileSync(join(DIR, file), 'utf8'));
      const types = new Set(runReplay(rec, replayProfile(rec)).events.map((e) => e.event.type));
      for (const t of key ? (EXPECT[key] ?? []) : []) expect(types, `${file} should fire ${t}`).toContain(t);
      for (const t of key ? (FORBID[key] ?? []) : []) expect(types, `${file} should not fire ${t}`).not.toContain(t);
    });
  }
});
