// Times one Stability image-to-3D call: photo in, GLB out.
// Usage: node --env-file=.env.local sf3d.mjs <image> [texture_resolution] [fast|spar]
// Docs: https://docs.stability.ai/api-reference/3d/stable-fast-3d.md (10 credits per success)
//       https://docs.stability.ai/api-reference/3d/stable-point-aware-3d.md (4 credits per success)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINTS = { fast: "stable-fast-3d", spar: "stable-point-aware-3d" };

/** Returns the GLB bytes. Throws on any non-200 answer. */
export async function imageTo3d(bytes, { texture = "1024", model = "fast", mime = "image/png", filename = "object.png" } = {}) {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: mime }), filename);
  form.append("texture_resolution", String(texture));

  const res = await fetch(`https://api.stability.ai/v2beta/3d/${ENDPOINTS[model]}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.STABILITY_API_KEY}` },
    body: form,
  });
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) throw new Error(`${model}: HTTP ${res.status}: ${body.toString().slice(0, 500)}`);
  return body;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [imagePath, texture = "1024", model = "fast"] = process.argv.slice(2);
  if (!imagePath) throw new Error("usage: sf3d.mjs <image> [512|1024|2048] [fast|spar]");
  const started = performance.now();
  const glb = await imageTo3d(await readFile(imagePath), { texture, model, mime: imagePath.endsWith(".png") ? "image/png" : "image/jpeg", filename: basename(imagePath) });
  await mkdir("out", { recursive: true });
  const out = `out/${basename(imagePath, extname(imagePath))}-${model}-${texture}.glb`;
  await writeFile(out, glb);
  console.log(JSON.stringify({ ms: Math.round(performance.now() - started), model, texture, kb: Math.round(glb.length / 1024), out }));
}
