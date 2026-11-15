// What Telemachus sees on FaceTime (spec A.7) — Part B publishes this as "friend-view".
// 640×360 @ 15 fps. Layout keeps all four corners clear (FaceTime self-view tile + controls live
// there): status strip top-center, contextual banner bottom-center (≤ 60% width), safe margins
// 32 px sides / 18 px top-bottom, banner text ≥ 28 px, title cards ≥ 48 px.
import { useApp, subtitleAt } from '../state/store';
import { runtime } from './runtime';

const W = 640, H = 360, FPS = 15;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let stream: MediaStream | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const thumbCache = new Map<string, HTMLImageElement>();
let lastTrick: { title: string; at: number } | null = null;

const FONT = "'Montserrat Variable', 'Montserrat', 'Helvetica Neue', Arial, sans-serif";
const GREEK = "'Cinzel', 'Cormorant Garamond', Georgia, serif"; // title cards

function thumb(url?: string) {
  if (!url) return null;
  let img = thumbCache.get(url);
  if (!img) { img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; thumbCache.set(url, img); }
  return img.complete && img.naturalWidth ? img : null;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight = 800, align: CanvasTextAlign = 'center', track = 0, face = FONT) {
  c.font = `${weight} ${size}px ${face}`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${track}px`;
  c.lineWidth = Math.max(3, size * 0.16);
  c.strokeStyle = 'rgba(8,6,4,0.9)';
  c.lineJoin = 'round';
  c.strokeText(s, x, y);
  c.fillStyle = color;
  c.fillText(s, x, y);
  (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
}

function fitText(c: CanvasRenderingContext2D, s: string, maxW: number, size: number, weight = 800, face = FONT) {
  let sz = size;
  c.font = `${weight} ${sz}px ${face}`;
  while (sz > 18 && c.measureText(s).width > maxW) { sz -= 2; c.font = `${weight} ${sz}px ${face}`; }
  return sz;
}

function draw() {
  if (!ctx) return;
  const c = ctx;
  const st = useApp.getState();
  const now = performance.now();
  c.fillStyle = '#0b0907';
  c.fillRect(0, 0, W, H);

  // game frame, letterboxed to 16:9
  const src = runtime.canvas;
  if (src && src.width > 0) {
    const sa = src.width / src.height;
    let dw = W, dh = H, dx = 0, dy = 0;
    if (sa > W / H) { dh = W / sa; dy = (H - dh) / 2; } else { dw = H * sa; dx = (W - dw) / 2; }
    try { c.drawImage(src, dx, dy, dw, dh); } catch { /* canvas not ready */ }
  }

  const inGame = st.screen === 'game';
  const hud = st.hud;

  // ── top-center status strip (middle 50%) ──
  const sx = 170, sw = 300;
  c.fillStyle = 'rgba(12,9,7,0.72)';
  const TOP = 40; // FaceTime aspect-fill crops ~9% top/bottom on a landscape iPhone
  roundRect(c, sx, TOP, sw, inGame ? 58 : 34, 10);
  c.fill();
  const blink = Math.floor(now / 600) % 2 === 0;
  c.fillStyle = blink ? '#E0402F' : '#8a2418';
  c.beginPath(); c.arc(sx + 22, TOP + 17, 7, 0, Math.PI * 2); c.fill();
  text(c, 'LIVE · ODYSSEUS', sx + 38, TOP + 17, 18, '#F3E9D6', 800, 'left', 2);
  if (inGame) {
    const hp = Math.max(0, Math.min(100, hud.health));
    const bx = sx + 18, by = TOP + 36, bw = 150, bh = 12;
    c.fillStyle = '#2a201a'; roundRect(c, bx, by, bw, bh, 6); c.fill();
    c.fillStyle = hp < 35 ? '#E0402F' : '#C49A4A'; roundRect(c, bx, by, Math.max(6, (bw * hp) / 100), bh, 6); c.fill();
    text(c, `W${hud.wave || 1}`, sx + 196, TOP + 42, 18, '#F3E9D6', 800);
    text(c, hud.score.toLocaleString(), sx + sw - 18, TOP + 42, 18, '#FFD58A', 800, 'right');
  }

  // ── center title card (slow-mo trickshots) ──
  const trick = st.toasts.filter((t) => t.kind === 'trickshot').slice(-1)[0];
  if (trick && (!lastTrick || lastTrick.title !== trick.title || now - lastTrick.at > 2000)) lastTrick = { title: trick.title, at: trick.at };
  if (lastTrick && now - lastTrick.at < 1300) {
    const k = Math.min(1, (now - lastTrick.at) / 120);
    const size = fitText(c, lastTrick.title, 420, 52, 900, GREEK) * (1.15 - 0.15 * k);
    text(c, lastTrick.title, W / 2, H * 0.44, size, '#FFE2A0', 900, 'center', 3, GREEK);
  }

  // ── bottom-center contextual banner (≤ 60% width) ──
  let banner: { title: string; sub?: string; color: string; pulse?: boolean; pct?: number } | null = null;
  const friend = st.friend?.name?.toUpperCase() ?? 'TELEMACHUS';
  const callAge = st.call.state === 'connected' && st.call.connectedAt ? now - st.call.connectedAt : Infinity;
  if (callAge < 7000) banner = { title: '↻ TURN YOUR PHONE SIDEWAYS', color: '#F3E9D6' };
  else if (st.scan.state === 'looking') banner = { title: `${friend} — HOLD UP A WEAPON!`, color: '#FFE2A0', pulse: true };
  else if (st.scan.state === 'detected' || st.scan.state === 'forging') banner = { title: `FORGING: ${(st.scan.displayName ?? st.scan.objectName ?? '…').toUpperCase()}`, color: '#FFD58A', pct: st.scan.pct };
  else if (st.incoming) banner = { title: `SENT: ${st.incoming.displayName.toUpperCase()}`, color: '#CFE8D8' };
  else if (hud.pinnedPrompt || (inGame && hud.health < 25)) banner = { title: 'HE’S PINNED! SEND HELP!', color: '#FF8A70', pulse: true };
  else if (st.scan.state === 'failed') banner = { title: 'TRY AGAIN — HOLD IT CLOSER', color: '#FFB38A' };

  // 300 px: same column as the status strip, clear of FaceTime's bottom controls pill (~x ≥ 457)
  const bw = 300, bx = (W - bw) / 2;
  if (banner) {
    const bh = banner.pct !== undefined ? 80 : 66;
    const by = 318 - bh;
    // pulse the border only — the text stays at full strength
    const pulse = banner.pulse ? 0.5 + 0.5 * Math.sin(now / 160) : 0;
    c.fillStyle = 'rgba(12,9,7,0.86)';
    roundRect(c, bx, by, bw, bh, 12);
    c.fill();
    c.strokeStyle = banner.pulse ? banner.color : '#8A6A40';
    c.globalAlpha = banner.pulse ? 0.45 + 0.55 * pulse : 1;
    c.lineWidth = banner.pulse ? 3 : 2; c.stroke();
    c.globalAlpha = 1;
    const img = thumb(st.lastForged?.thumbUrl ?? undefined);
    const hasThumb = !!img && (st.scan.state === 'forging' || st.scan.state === 'detected' || !!st.incoming);
    const tx = hasThumb ? bx + 76 : bx;
    const tw = hasThumb ? bw - 86 : bw;
    if (hasThumb && img) {
      c.save(); roundRect(c, bx + 10, by + 9, 56, 56, 8); c.clip(); c.drawImage(img, bx + 10, by + 9, 56, 56); c.restore();
    }
    const size = fitText(c, banner.title, tw - 24, 28, 900);
    text(c, banner.title, tx + tw / 2, by + 33, size, banner.color, 900);
    if (banner.pct !== undefined) {
      c.fillStyle = '#2a201a'; roundRect(c, tx + 16, by + 58, tw - 32, 10, 5); c.fill();
      c.fillStyle = '#FFD58A'; roundRect(c, tx + 16, by + 58, Math.max(10, ((tw - 32) * banner.pct) / 100), 10, 5); c.fill();
    }
    c.globalAlpha = 1;
  } else {
    // subtitles: latest Quartermaster line (22 px, ≤ 2 lines)
    const n = st.narration[st.narration.length - 1];
    const cur = n ? subtitleAt(n.text, now - n.at, 44) : null;
    if (n && cur) {
      c.font = `700 22px ${FONT}`;
      const words = cur.chunk.split(' ');
      const lines: string[] = [];
      let line = '';
      for (const wd of words) {
        const test = line ? `${line} ${wd}` : wd;
        if (c.measureText(test).width > bw - 28 && line) { lines.push(line); line = wd; } else line = test;
      }
      if (line) lines.push(line);
      const shown = lines.slice(0, 2);
      const bh = 22 + shown.length * 28;
      const by = H - 42 - bh;
      c.fillStyle = 'rgba(8,6,4,0.7)';
      roundRect(c, bx, by, bw, bh, 10);
      c.fill();
      shown.forEach((l, i) => text(c, l, W / 2, by + 24 + i * 28, 22, '#F3E9D6', 700));
    }
  }
}

/** Spec A.7 export: the 640×360 @ 15 fps MediaStream Part B publishes as "friend-view". */
export function getFriendViewStream(): MediaStream {
  if (stream) return stream;
  canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  ctx = canvas.getContext('2d');
  draw();
  timer = setInterval(draw, 1000 / FPS);
  stream = canvas.captureStream(FPS);
  return stream;
}

export function getFriendViewCanvas() {
  getFriendViewStream();
  return canvas;
}

export function stopFriendView() {
  if (timer) clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}
