// Redraws the held-up object as a clean product photo (whole object, no hand) so image-to-3D gets a clean input.
// Usage: node --env-file=.env.local clean.mjs <image> "<object name>" [strength]
// Docs: https://docs.stability.ai/api-reference/generate/stable-diffusion-35.md (sd3.5-large-turbo: 4 credits per success)
// strength 0.8 removed the hand from a real call frame and kept the mug's shape; 0.6 kept the hand.
import { readFile, writeFile } from "node:fs/promises";

const [imagePath, name, strength = "0.8"] = process.argv.slice(2);
if (!imagePath || !name) throw new Error('usage: clean.mjs <image> "<object name>" [strength]');

const form = new FormData();
const bytes = await readFile(imagePath);
form.append("image", new Blob([bytes], { type: imagePath.endsWith(".png") ? "image/png" : "image/jpeg" }), "frame");
form.append("mode", "image-to-image");
form.append("strength", strength);
form.append("model", "sd3.5-large-turbo");
form.append("output_format", "png");
form.append("prompt", `a ${name}, whole object visible, product photo, centered, isolated on a pure white background, soft studio lighting`);
form.append("negative_prompt", "hand, fingers, person, face, room, clutter");

const started = performance.now();
const res = await fetch("https://api.stability.ai/v2beta/stable-image/generate/sd3", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.STABILITY_API_KEY}`, accept: "image/*" },
  body: form,
});
const body = Buffer.from(await res.arrayBuffer());
const ms = Math.round(performance.now() - started);

if (res.status !== 200) {
  console.error(`HTTP ${res.status} after ${ms} ms: ${body.toString().slice(0, 500)}`);
  process.exit(1);
}
const out = imagePath.replace(/\.[^.]+$/, "-clean.png");
await writeFile(out, body);
console.log(JSON.stringify({ ms, strength, out }));
