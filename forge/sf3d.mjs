// Times one Stability image-to-3D call: photo in, GLB out.
// Usage: node --env-file=.env.local sf3d.mjs <image> [texture_resolution] [fast|spar]
// Docs: https://docs.stability.ai/api-reference/3d/stable-fast-3d.md (10 credits per success)
//       https://docs.stability.ai/api-reference/3d/stable-point-aware-3d.md (4 credits per success)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname } from "node:path";

const [imagePath, texture = "1024", model = "fast"] = process.argv.slice(2);
const ENDPOINTS = { fast: "stable-fast-3d", spar: "stable-point-aware-3d" };
if (!imagePath) throw new Error("usage: sf3d.mjs <image> [512|1024|2048]");

const bytes = await readFile(imagePath);
const form = new FormData();
form.append("image", new Blob([bytes], { type: imagePath.endsWith(".png") ? "image/png" : "image/jpeg" }), basename(imagePath));
form.append("texture_resolution", texture);

const started = performance.now();
const res = await fetch(`https://api.stability.ai/v2beta/3d/${ENDPOINTS[model]}`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.STABILITY_API_KEY}` },
  body: form,
});
const body = Buffer.from(await res.arrayBuffer());
const ms = Math.round(performance.now() - started);

if (res.status !== 200) {
  console.error(`HTTP ${res.status} after ${ms} ms: ${body.toString().slice(0, 500)}`);
  process.exit(1);
}
await mkdir("out", { recursive: true });
const out = `out/${basename(imagePath, extname(imagePath))}-${model}-${texture}.glb`;
await writeFile(out, body);
console.log(JSON.stringify({ ms, model, texture, kb: Math.round(body.length / 1024), out }));
