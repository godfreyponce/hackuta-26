// Replays saved caller frames through CallerScanner against a real forge server, in real time. No Chert call.
// Frames: <dir>/f001.jpg, f002.jpg, ... at <fps>, frame k at (k-1)/fps s. Starts a scan at <askSec>, as if the web
// pressed Ask then. Frames are already cropped, so run it with CALLER_CROP=0,0,1,1.
// usage: CALLER_CROP=0,0,1,1 SERVER_HTTP_URL=http://localhost:8789 tsx --env-file=.env.local dev/replay-scan.ts <dir> <fps> <askSec> [scanner module]
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dispose, VideoBufferType, VideoFrame } from '@livekit/rtc-node';
import sharp from 'sharp';

const [dir, fpsArg, askArg, mod = '../src/scanner.ts'] = process.argv.slice(2);
if (!dir || !fpsArg || !askArg) throw new Error('usage: replay-scan.ts <dir> <fps> <askSec> [scanner module]');
const fps = Number(fpsArg), ask = Number(askArg);
const { CallerScanner } = (await import(mod.startsWith('.') ? mod : pathToFileURL(resolve(mod)).href)) as typeof import('../src/scanner.ts');

const file = (k: number) => `${dir}/f${String(k).padStart(3, '0')}.jpg`;
async function frame(k: number): Promise<VideoFrame | null> {
  if (!existsSync(file(k))) return null;
  const { data, info } = await sharp(file(k)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return new VideoFrame(new Uint8Array(data), info.width, info.height, VideoBufferType.RGBA);
}

const first = Math.floor(ask * fps) + 1;
const frames: VideoFrame[] = [];
for (let k = first; ; k++) { const f = await frame(k); if (!f || frames.length > 30 * fps) break; frames.push(f); }
if (!frames.length) throw new Error(`no frame ${file(first)}`);
const scanner = new CallerScanner(randomBytes(12).toString('hex'));
let i = 0;
scanner.offer(frames[0]!);
const feed = setInterval(() => { if (++i < frames.length) scanner.offer(frames[i]!); }, 1000 / fps);
const t0 = Date.now();
const hit = await scanner.scan();
const ms = Date.now() - t0;
clearInterval(feed);
console.log(JSON.stringify({ replay: dir, ask, hit: hit ? { objectName: hit.objectName, displayName: hit.displayName, weaponClass: hit.weaponClass } : null, ms, atRecordingSec: +(ask + ms / 1000).toFixed(1) }));
await dispose();
