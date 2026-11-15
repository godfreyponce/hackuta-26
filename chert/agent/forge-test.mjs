// Test mode without a phone call: one saved frame through Gemini vision, then to the running armory (npm run armory).
// Usage: node --env-file=.env.local forge-test.mjs <image>
// Costs one Gemini request and, for a new object, 8 Stability credits.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describeObject } from './vision.mjs';

const [imagePath] = process.argv.slice(2);
if (!imagePath) throw new Error('usage: forge-test.mjs <image>');

const frame = await sharp(await readFile(imagePath)).rotate().jpeg({ quality: 90 }).toBuffer();
const started = Date.now();
const seen = await describeObject(await sharp(frame).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer());
console.log(JSON.stringify({ vision_ms: Date.now() - started, ...seen }));
if (!seen.object || seen.box_2d?.length !== 4) process.exit(1);

const res = await fetch('http://127.0.0.1:8787/sighting', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ call: `test-${Date.now()}`, frame: frame.toString('base64'), ...seen }),
});
console.log(res.status, await res.text());
