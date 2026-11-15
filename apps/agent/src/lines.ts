// The Quartermaster's fixed lines (spec B.6). Every line here is pre-rendered at startup.
import { log, warn, errText } from './log.ts';
import { renderCached, TtsHttpError } from './tts.ts';

/** Story v2 (owner): Odysseus is home, armed for war, and comes to fight Adam, the player. {friend} becomes friendTitle(name). */
export const LINES = {
  greeting: ["{friend}! Odysseus is home, and he's armed for war. He's after Adam. Stay close; I'll call when Adam needs steel."],
  matchStart: ['Here they come. Steady now.', 'Odysseus is moving. Here he comes.'],
  waveStart: ['Another wave. Here they come.', 'More of his men at the doors!'],
  pinned: ["Adam's pinned! {friend}, what weapon can you bring him?", 'Odysseus has Adam cornered! {friend}, find him a weapon!'],
  healthLow: ["Adam's bleeding badly. Hurry, {friend}.", "Adam can't take much more of this."],
  scanLooking: [
    'Hold something up to your camera. A broom, a pan, anything! Keep it steady.',
    'Show me what you\'ve got! Hold it up to the camera, nice and steady.',
  ],
  scanCloser: ['Closer! Fill the screen with it.'],
  scanFailed: ["Couldn't make it out. Ask me again."],
  cantSee: ["{friend}, I can't see you. Is your camera on?"],
  pin: ['Pinned him to the pillar! Did you see that?'],
  multiKill: ['Two with one throw!', 'A double! Ha!'],
  bossSpawn: ["That's Odysseus in full bronze. We need something sharp, or something that explodes."],
  waveCleared: ['Wave cleared. Breathe.', 'That wave is done. Catch your breath.'],
  mustGo: ["The storeroom's closing, {friend}. One last look."],
  farewell: ['Good fighting, {friend}. Adam owes you one.'],
} as const;

/** How the Quartermaster addresses the friend (owner: "Warrior Godfrey"). */
export const friendTitle = (name: string) => `Warrior ${name}`;
const fill = (line: string, friendName: string) => line.replaceAll('{friend}', () => friendTitle(friendName)); // a name may hold $&
const ALL: readonly string[] = Object.values(LINES).flat();
const NAMED = ALL.filter((l) => l.includes('{friend}'));
const UNNAMED = ALL.filter((l) => !l.includes('{friend}'));

export type LineKey = keyof typeof LINES;

const cache = new Map<string, Int16Array>();

/** Renders the lines that do not name the friend, at startup. */
export async function prerenderLines(): Promise<void> {
  const t0 = Date.now();
  log('tts_cache_ready', { lines: await renderAll(UNNAMED), of: UNNAMED.length, ms: Date.now() - t0 });
}

/** Renders this friend's named lines when a call starts. The disk cache keeps them, so a name costs credits once. */
export async function prepareFriendLines(friendName: string): Promise<void> {
  const t0 = Date.now();
  const texts = NAMED.map((l) => fill(l, friendName));
  log('friend_lines_ready', { lines: await renderAll(texts), of: texts.length, ms: Date.now() - t0 });
}

/** Renders into the cache; returns how many of texts are cached. */
async function renderAll(texts: readonly string[]): Promise<number> {
  const queue = [...texts];
  // ElevenLabs returned 429 concurrent_limit_exceeded with 22 at once (10 got through); 4 workers stays well under.
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let text = queue.shift(); text; text = queue.shift()) {
      try { cache.set(text, await renderCached(text)); }
      catch (e) { warn('prerender_failed', { text, error: errText(e) }); }
    }
  }));
  return texts.filter((t) => cache.has(t)).length;
}

/**
 * Calls wait until every line that does not name the friend is cached, so keep retrying the missing ones. A 401 or 403
 * (bad or expired key) cannot fix itself: stop, so the team sees one clear line instead of a retry loop.
 */
export async function ensureLines(): Promise<void> {
  for (let tries = 1; !linesReady(); tries++) {
    await new Promise((r) => setTimeout(r, 5_000));
    for (const text of UNNAMED.filter((t) => !cache.has(t))) {
      try { cache.set(text, await renderCached(text)); log('line_rendered', { tries }); }
      catch (e) {
        if (e instanceof TtsHttpError && (e.status === 401 || e.status === 403)) {
          warn('ELEVENLABS_REJECTED_LINES_ALL_CALLS_REFUSED', { status: e.status, error: errText(e), fix: 'check ELEVENLABS_API_KEY and the ElevenLabs quota (error.detail.status says which), then restart the agent' });
          return;
        }
        warn('line_render_failed', { tries, error: errText(e) });
      }
    }
  }
}

/** The startup lines are cached, so ElevenLabs works. A friend's named lines render per call (prepareFriendLines). */
export const linesReady = (): boolean => UNNAMED.every((t) => cache.has(t));

const lastPick = new Map<LineKey, string>();

/** A random line for the key, never the same one twice in a row, with the friend's name filled in. */
export function pick(key: LineKey, friendName: string): { text: string; pcm: Int16Array | undefined } {
  const options: readonly string[] = LINES[key];
  const pool = options.length > 1 ? options.filter((t) => t !== lastPick.get(key)) : options;
  const line = pool[Math.floor(Math.random() * pool.length)]!;
  lastPick.set(key, line);
  const text = fill(line, friendName);
  return { text, pcm: cache.get(text) };
}
