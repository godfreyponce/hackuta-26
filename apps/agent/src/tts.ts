// ElevenLabs streaming TTS. The only place that knows the TTS provider.
// pcm_48000 is allowed on the Creator plan (checked 2026-11-14; only pcm_44100 needs Pro), so no resampling.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { env } from './env.ts';
import { log } from './log.ts';

export const TTS_SAMPLE_RATE = 48_000;
const FIRST_BYTE_TIMEOUT_MS = 5_000; // guess: measured TTFB was about 0.26 s

/** Streams 48 kHz mono Int16 PCM chunks for one line. */
export async function* ttsStream(text: string): AsyncGenerator<Int16Array> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}/stream?output_format=pcm_48000`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FIRST_BYTE_TIMEOUT_MS);
  const res = await fetch(url, {
    method: 'POST',
    signal: ctl.signal,
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: env.ELEVENLABS_MODEL_ID }),
  }).finally(() => clearTimeout(timer));
  if (!res.ok || !res.body) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);

  let carry: Uint8Array | null = null; // odd byte left over between network chunks
  for await (const part of res.body as AsyncIterable<Uint8Array>) {
    let bytes: Uint8Array = part;
    if (carry) {
      bytes = new Uint8Array(carry.length + part.length);
      bytes.set(carry);
      bytes.set(part, carry.length);
      carry = null;
    }
    const even = bytes.length & ~1;
    if (even < bytes.length) carry = bytes.slice(even);
    if (even > 0) yield new Int16Array(bytes.slice(0, even).buffer); // little-endian, same as the Mac
  }
}

async function collect(text: string): Promise<Int16Array> {
  const parts: Int16Array[] = [];
  for await (const p of ttsStream(text)) parts.push(p);
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const CACHE_DIR = new URL('../.cache/tts/', import.meta.url);

/** Renders a fixed line once and keeps it on disk, so restarts cost no credits. */
export async function renderCached(text: string): Promise<Int16Array> {
  const key = createHash('sha256').update(`${env.ELEVENLABS_VOICE_ID}|${env.ELEVENLABS_MODEL_ID}|${text}`).digest('hex').slice(0, 24);
  const file = new URL(`${key}.pcm`, CACHE_DIR);
  try {
    const buf = await readFile(file);
    return new Int16Array(new Uint8Array(buf).buffer); // copy: Buffer offsets may be odd
  } catch { /* not cached yet */ }
  const pcm = await collect(text);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  log('tts_rendered', { chars: text.length, ms: Math.round((pcm.length / TTS_SAMPLE_RATE) * 1000) });
  return pcm;
}
