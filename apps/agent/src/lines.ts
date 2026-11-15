// The Quartermaster's fixed lines (spec B.6). Every line here is pre-rendered at startup.
import { log, warn, errText } from './log.ts';
import { renderCached, TtsHttpError } from './tts.ts';

export const LINES = {
  greeting: [
    "Telemachus! Your father's home and the hall is full of suitors. Watch the fight; I'll tell you when he needs steel.",
  ],
  matchStart: ['Here they come. Steady now.', 'The suitors are moving. Here they come.'],
  waveStart: ['Another wave. Here they come.', 'More of them at the doors!'],
  pinned: [
    'He\'s pinned! Find him a weapon, quick: anything long!',
    'They\'ve got him cornered! Telemachus, find him something!',
  ],
  healthLow: ["He's bleeding badly. Hurry, Telemachus.", "He can't take much more of this."],
  scanLooking: [
    'Hold something up to your camera. A broom, a pan, anything! Keep it steady.',
    'Show me what you\'ve got! Hold it up to the camera, nice and steady.',
  ],
  scanCloser: ['Closer! Fill the screen with it.'],
  scanFailed: ["Couldn't make it out. Ask me again."],
  cantSee: ["Telemachus, I can't see you. Is your camera on?"],
  pin: ['Pinned him to the pillar! Did you see that?'],
  multiKill: ['Two with one throw!', 'A double! Ha!'],
  bossSpawn: ["That's Antinous. We need something sharp, or something that explodes."],
  waveCleared: ['Wave cleared. Breathe.', 'That wave is done. Catch your breath.'],
  mustGo: ["The storeroom's closing, Telemachus. One last look."],
  farewell: ['The hall is ours. Thank you, Telemachus.'],
} as const;

export type LineKey = keyof typeof LINES;

const cache = new Map<string, Int16Array>();

export async function prerenderLines(): Promise<void> {
  const t0 = Date.now();
  const texts: string[] = Object.values(LINES).flat();
  const queue = [...texts];
  // ElevenLabs returned 429 concurrent_limit_exceeded with 22 at once (10 got through); 4 workers stays well under.
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let text = queue.shift(); text; text = queue.shift()) {
      try { cache.set(text, await renderCached(text)); }
      catch (e) { warn('prerender_failed', { text, error: errText(e) }); }
    }
  }));
  log('tts_cache_ready', { lines: cache.size, of: texts.length, ms: Date.now() - t0 });
}

/**
 * The greeting must come from the cache (spec B.5), so keep retrying every missing greeting line until all render.
 * A 401 or 403 (bad or expired key) cannot fix itself: stop, so the team sees one clear line instead of a retry loop.
 */
export async function ensureGreeting(): Promise<void> {
  for (let tries = 1; !greetingReady(); tries++) {
    await new Promise((r) => setTimeout(r, 5_000));
    for (const text of LINES.greeting.filter((t) => !cache.has(t))) {
      try { cache.set(text, await renderCached(text)); log('greeting_rendered', { tries }); }
      catch (e) {
        if (e instanceof TtsHttpError && (e.status === 401 || e.status === 403)) {
          warn('ELEVENLABS_KEY_REJECTED_ALL_CALLS_REFUSED', { status: e.status, error: errText(e), fix: 'set a valid ELEVENLABS_API_KEY in apps/agent/.env.local and restart the agent' });
          return;
        }
        warn('greeting_render_failed', { tries, error: errText(e) });
      }
    }
  }
}

export const greetingReady = (): boolean => LINES.greeting.every((t) => cache.has(t));

const lastPick = new Map<LineKey, string>();

/** A random line for the key, never the same one twice in a row. */
export function pick(key: LineKey): { text: string; pcm: Int16Array | undefined } {
  const options: readonly string[] = LINES[key];
  const pool = options.length > 1 ? options.filter((t) => t !== lastPick.get(key)) : options;
  const text = pool[Math.floor(Math.random() * pool.length)]!;
  lastPick.set(key, text);
  return { text, pcm: cache.get(text) };
}
