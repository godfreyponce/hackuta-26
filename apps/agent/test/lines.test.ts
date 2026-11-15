// Story v2 (owner): Odysseus is the enemy, and the Quartermaster calls the friend "Warrior <name>", the friend name from
// the call. Lines that address the friend are rendered per name when a call starts; the rest at startup.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { env } from '../src/env.ts';
import { LINES, pick, prepareFriendLines } from '../src/lines.ts';

// A render can outlive its test (a failed assert leaves the background renders running). With the real fetch back,
// those reached ElevenLabs once and spent credits, so this file never has a real fetch, key or voice.
const noNetwork = (async () => { throw new Error('lines.test.ts: no network'); }) as typeof fetch;
globalThis.fetch = noNetwork;
env.ELEVENLABS_API_KEY = 'lines-test';
env.ELEVENLABS_VOICE_ID = 'lines-test';
const realCacheDir = env.TTS_CACHE_DIR;
const listReal = () => { try { return readdirSync(realCacheDir).sort(); } catch { return []; } };
let realBefore: string[] = [];
beforeEach(() => {
  realBefore = listReal();
  env.TTS_CACHE_DIR = mkdtempSync(join(tmpdir(), 'lines-test-')); // review #5: a killed run left files in the real cache
});
afterEach(() => {
  globalThis.fetch = noNetwork;
  rmSync(env.TTS_CACHE_DIR, { recursive: true, force: true });
  env.TTS_CACHE_DIR = realCacheDir;
});

const NAMED = Object.values(LINES).flat().filter((l) => l.includes('{friend}'));
const GREETING = LINES.greeting[0];
const titled = (line: string, name: string) => line.replaceAll('{friend}', `Warrior ${name}`);

/** Fake ElevenLabs: every render is a short silent clip; texts that `hold` picks wait for release(). */
function fakeTts(opts: { hold?: (text: string) => boolean; status?: (text: string) => number } = {}) {
  const asked: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const text: string = JSON.parse(String(init.body)).text;
    asked.push(text);
    if (opts.hold?.(text)) await gate;
    const status = opts.status?.(text) ?? 200;
    return status === 200 ? new Response(new Uint8Array(480 * 2)) : new Response('{"detail":"fail"}', { status });
  }) as typeof fetch;
  return { asked, release };
}

test('nothing the agent says or shows names Telemachus or the suitors, and no line has a middle dot', () => {
  const dir = new URL('../', import.meta.url);
  const files = [...readdirSync(new URL('src/', dir)).map((f) => `src/${f}`), ...readdirSync(new URL('dev/', dir)).filter((f) => /\.(ts|html)$/.test(f)).map((f) => `dev/${f}`), 'README.md'];
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /telemachus|suitor/i, f);
  for (const line of Object.values(LINES).flat()) assert.ok(!line.includes('·'), line);
});

test('a line that addresses the friend calls them "Warrior <name>"', () => {
  assert.match(pick('greeting', 'Godfrey').text, /^Warrior Godfrey!/);
  for (let i = 0; i < 4; i++) assert.match(pick('pinned', 'Godfrey').text, /Warrior Godfrey, /);
  assert.doesNotMatch(pick('scanCloser', 'Godfrey').text, /Warrior/);
  assert.match(pick('greeting', "$&$' Jo").text, /^Warrior \$&\$' Jo!/, 'a $ pattern in the name was expanded');
});

test('prepareFriendLines renders only the lines that name the friend, with the name filled in, into the cache dir', async () => {
  const { asked } = fakeTts();
  assert.equal(pick('greeting', 'Godfrey').pcm, undefined);
  const lines = prepareFriendLines('Godfrey');
  assert.equal(await lines.greeting, true);
  await lines.rest;
  assert.deepEqual(asked.sort(), NAMED.map((l) => titled(l, 'Godfrey')).sort());
  assert.ok(pick('greeting', 'Godfrey').pcm, 'greeting not cached after prepareFriendLines');
  assert.equal(readdirSync(env.TTS_CACHE_DIR).length, NAMED.length, 'renders did not land in TTS_CACHE_DIR');
  assert.deepEqual(listReal(), realBefore, 'the test wrote to the real .cache/tts');
});

// Review #2: dialing waited for all 7 named lines. Only the greeting must be ready before the phone rings.
test('the greeting is ready before the other named lines finish, so dialing waits only for it', async () => {
  const { release } = fakeTts({ hold: (t) => t !== titled(GREETING, 'Ada') });
  const lines = prepareFriendLines('Ada');
  assert.equal(await lines.greeting, true);
  assert.ok(pick('greeting', 'Ada').pcm);
  assert.equal(pick('farewell', 'Ada').pcm, undefined, 'farewell finished before its render was released');
  release();
  await lines.rest;
  assert.ok(pick('farewell', 'Ada').pcm, 'farewell not cached after the background render');
});

test('a failed greeting render reports false and renders nothing else (the call is refused)', async () => {
  const { asked } = fakeTts({ status: () => 500 });
  const lines = prepareFriendLines('Bea');
  assert.equal(await lines.greeting, false);
  await lines.rest;
  assert.deepEqual(asked, [titled(GREETING, 'Bea')]);
  assert.equal(pick('greeting', 'Bea').pcm, undefined);
});
