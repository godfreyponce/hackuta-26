// The armory: the WebSocket server the game connects to, and the weapon forge behind it.
// Message format: forge/WEAPON-MESSAGE.md. Run: npm run armory. Test page: http://localhost:8787/
//
// The agent (one job per call) POSTs each new object it sees to /sighting. The armory crops it, sends `weapon` at
// once, then cleans the crop and makes a 3D model in the background (8 Stability credits), and sends `weapon_model`
// or `weapon_failed`. One weapon per object name per call.
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { WebSocketServer } from 'ws';
import { cleanImage } from '../../forge/clean.mjs';
import { imageTo3d } from '../../forge/sf3d.mjs';

const PORT = 8787;
// Same margin the agent uses for its cropped outgoing view, in Gemini's 0-1000 box units.
const CROP_PAD = 40;
const DIR = fileURLToPath(new URL(`./runs/armory-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url));
mkdirSync(DIR, { recursive: true });
const PAGE = fileURLToPath(new URL('./armory.html', import.meta.url));

const log = (event, data = {}) => console.log(`[armory] ${JSON.stringify({ t: Date.now(), event, ...data })}`);

const forged = new Set();
let count = 0;

/**
 * @param {{ call: string, frame: string, object: string, box_2d: number[], weapon_class?: string, color?: string }} s
 *   frame is an upright JPEG, base64
 */
async function forge(s) {
  const name = s.object.trim();
  const key = `${s.call}:${name.toLowerCase()}`;
  if (forged.has(key)) return { skipped: 'already forged in this call' };
  forged.add(key);
  const id = `w${++count}`;

  const frame = Buffer.from(s.frame, 'base64');
  const { width: w, height: h } = await sharp(frame).metadata();
  const [ymin, xmin, ymax, xmax] = s.box_2d;
  const left = Math.max(0, Math.floor((xmin - CROP_PAD) * w / 1000)), top = Math.max(0, Math.floor((ymin - CROP_PAD) * h / 1000));
  const right = Math.min(w, Math.ceil((xmax + CROP_PAD) * w / 1000)), bottom = Math.min(h, Math.ceil((ymax + CROP_PAD) * h / 1000));
  const crop = await sharp(frame).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 90 }).toBuffer();
  await writeFile(`${DIR}${id}-crop.jpg`, crop);

  let color = s.color;
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) {
    const { r, g, b } = (await sharp(crop).stats()).dominant;
    color = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const weapon = { type: 'weapon', id, name, class: s.weapon_class || 'throw', color, crop: `data:image/jpeg;base64,${crop.toString('base64')}` };
  broadcast(weapon);
  log('weapon', { id, call: s.call, name, class: weapon.class, color, crop_px: [right - left, bottom - top] });

  void (async () => {
    const started = Date.now();
    try {
      const clean = await cleanImage(crop, name);
      await writeFile(`${DIR}${id}-clean.png`, clean);
      const cleanMs = Date.now() - started;
      const glb = await imageTo3d(clean, { model: 'spar' });
      await writeFile(`${DIR}${id}.glb`, glb);
      broadcast({ type: 'weapon_model', id, glb: `http://localhost:${PORT}/weapons/${id}.glb` });
      log('weapon_model', { id, clean_ms: cleanMs, total_ms: Date.now() - started, kb: Math.round(glb.length / 1024) });
    } catch (error) {
      broadcast({ type: 'weapon_failed', id });
      log('weapon_failed', { id, ms: Date.now() - started, message: String(error?.message || error) });
    }
  })();
  return { id };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(PAGE));
    } else if (req.method === 'GET' && /^\/weapons\/w\d+\.glb$/.test(req.url)) {
      const glb = await readFile(`${DIR}${req.url.slice('/weapons/'.length)}`).catch(() => null);
      if (!glb) res.writeHead(404).end();
      else res.writeHead(200, { 'content-type': 'model/gltf-binary', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end(glb);
    } else if (req.method === 'POST' && req.url === '/sighting') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = await forge(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    log('http_error', { url: req.url, message: String(error?.message || error) });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const wss = new WebSocketServer({ server });
function broadcast(message) {
  const text = JSON.stringify(message);
  for (const client of wss.clients) if (client.readyState === 1) client.send(text);
}
wss.on('connection', socket => {
  log('game_connected', { clients: wss.clients.size });
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === 'call_me') {
      log('call_me');
      // TODO: start the outbound FaceTime call (chert/agent/outbound.mjs) once the dry-run thread reports check 2 passed.
      socket.send(JSON.stringify({ type: 'call_status', status: 'failed' }));
    }
  });
});

// Loopback only: the game runs in a browser on this laptop.
server.listen(PORT, '127.0.0.1', () => log('listening', { url: `http://localhost:${PORT}/`, dir: DIR }));
