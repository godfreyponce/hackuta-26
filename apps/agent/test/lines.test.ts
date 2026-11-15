// Story v2 (owner): Odysseus is the enemy, and the Quartermaster calls the friend "Warrior <name>", the friend name from
// the call. Lines that address the friend are rendered per name when a call starts; the rest at startup.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { env } from '../src/env.ts';
import { LINES, pick, prepareFriendLines } from '../src/lines.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

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

test('prepareFriendLines renders only the lines that name the friend, with the name filled in', async () => {
  env.ELEVENLABS_VOICE_ID = 'lines-test'; // a cache miss, so each render reaches fetch
  const cacheDir = new URL('../.cache/tts/', import.meta.url);
  mkdirSync(cacheDir, { recursive: true });
  const before = new Set(readdirSync(cacheDir));
  const asked: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)).text);
    return new Response(new Uint8Array(480 * 2));
  }) as typeof fetch;
  try {
    assert.equal(pick('greeting', 'Godfrey').pcm, undefined);
    await prepareFriendLines('Godfrey');
    const named = Object.values(LINES).flat().filter((l) => l.includes('{friend}'));
    assert.deepEqual(asked.sort(), named.map((l) => l.replaceAll('{friend}', 'Warrior Godfrey')).sort());
    assert.ok(pick('greeting', 'Godfrey').pcm, 'greeting not cached after prepareFriendLines');
  } finally {
    for (const f of readdirSync(cacheDir)) if (!before.has(f)) rmSync(new URL(f, cacheDir));
  }
});
