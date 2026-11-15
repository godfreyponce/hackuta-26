// Procedural canvas textures (no external assets). All cached.
import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();

function canvasTex(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, repeat?: [number, number]) {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  cache.set(key, t);
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number, size = 2) {
  for (let i = 0; i < (w * h) / (size * size * 3); i++) {
    const v = Math.random();
    ctx.fillStyle = v > 0.5 ? `rgba(255,240,220,${alpha * Math.random()})` : `rgba(0,0,0,${alpha * Math.random() * 1.4})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

/** Worn flagstone floor. */
export function floorTexture() {
  return canvasTex('floor', 512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#3d362d';
    ctx.fillRect(0, 0, w, h);
    const rows = 6;
    for (let r = 0; r < rows; r++) {
      let x = (r % 2) * -40;
      const y = (r / rows) * h;
      while (x < w) {
        const sw = 70 + Math.random() * 70;
        const l = 18 + Math.random() * 10;
        ctx.fillStyle = `hsl(32, ${8 + Math.random() * 8}%, ${l}%)`;
        ctx.fillRect(x + 2, y + 2, sw - 4, h / rows - 4);
        x += sw;
      }
    }
    noise(ctx, w, h, 0.18);
    // soot near hearth: radial darkening handled by fog/light; add scuffs
    for (let i = 0; i < 40; i++) {
      ctx.strokeStyle = `rgba(0,0,0,${0.08 + Math.random() * 0.1})`;
      ctx.lineWidth = 1 + Math.random() * 2;
      ctx.beginPath();
      const x = Math.random() * w, y = Math.random() * h;
      ctx.moveTo(x, y); ctx.lineTo(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 20);
      ctx.stroke();
    }
  }, [8, 20]);
}

/** Plaster wall with a Mycenaean fresco band (spirals + running meander) and soot. */
export function wallTexture() {
  return canvasTex('wall', 1024, 512, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1d1814');      // soot-blackened top
    g.addColorStop(0.35, '#5f584e');
    g.addColorStop(1, '#4f4941');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // dado (lower painted band)
    ctx.fillStyle = '#6B3A2E';
    ctx.fillRect(0, h * 0.78, w, h * 0.22);
    // fresco band
    const by = h * 0.5, bh = h * 0.16;
    ctx.fillStyle = '#233554';
    ctx.fillRect(0, by, w, bh);
    ctx.fillStyle = '#a89060';
    ctx.fillRect(0, by - 6, w, 6);
    ctx.fillRect(0, by + bh, w, 6);
    // running spirals (Mycenaean motif)
    ctx.strokeStyle = '#c9b48a';
    ctx.lineWidth = 4;
    const step = bh * 1.2;
    for (let x = step / 2; x < w; x += step) {
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 4; a += 0.2) {
        const r = (a / (Math.PI * 4)) * bh * 0.42;
        const px = x + Math.cos(a) * r, py = by + bh / 2 + Math.sin(a) * r;
        if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // meander on dado top
    ctx.strokeStyle = '#2a120f';
    ctx.lineWidth = 5;
    const my = h * 0.8, ms = 28;
    ctx.beginPath();
    for (let x = 0; x < w; x += ms * 2) {
      ctx.moveTo(x, my + ms); ctx.lineTo(x, my); ctx.lineTo(x + ms * 1.5, my); ctx.lineTo(x + ms * 1.5, my + ms * 0.6);
      ctx.lineTo(x + ms * 0.6, my + ms * 0.6); ctx.lineTo(x + ms * 0.6, my + ms * 0.3);
    }
    ctx.stroke();
    noise(ctx, w, h, 0.22, 3);
    // flaking / damp stains
    for (let i = 0; i < 30; i++) {
      ctx.fillStyle = `rgba(20,14,10,${0.05 + Math.random() * 0.12})`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * w, Math.random() * h, 10 + Math.random() * 60, 6 + Math.random() * 30, Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [3, 1]);
}

/** Painted column: Mycenaean red shaft, black capital band, fluting hint. */
export function columnTexture() {
  return canvasTex('column', 256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#6e221c';
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x, 0, 4, h);
    }
    noise(ctx, w, h, 0.25, 2);
    ctx.fillStyle = 'rgba(10,8,6,0.55)';
    ctx.fillRect(0, 0, w, h * 0.08); // soot at top
  });
}

/** Timber (tables, beams, doors). */
export function woodTexture() {
  return canvasTex('wood', 256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#3b2e22';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) {
      ctx.fillStyle = `rgba(${Math.random() > 0.5 ? '90,66,44' : '20,14,10'},${0.15 + Math.random() * 0.2})`;
      ctx.fillRect(0, y, w, 1 + Math.random() * 2);
    }
    noise(ctx, w, h, 0.12);
  }, [2, 1]);
}

/** Soft radial sprite used for embers, sparks, glows. */
export function glowTexture() {
  return canvasTex('glow', 64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,220,160,0.8)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Flame sprite sheet-ish soft teardrop. */
export function flameTexture() {
  return canvasTex('flame', 64, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h * 0.7, 2, w / 2, h * 0.6, h * 0.55);
    g.addColorStop(0, 'rgba(255,240,200,1)');
    g.addColorStop(0.3, 'rgba(255,170,70,0.9)');
    g.addColorStop(0.7, 'rgba(200,70,20,0.35)');
    g.addColorStop(1, 'rgba(120,30,10,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.quadraticCurveTo(w, h * 0.55, w / 2, h);
    ctx.quadraticCurveTo(0, h * 0.55, w / 2, 0);
    ctx.fill();
  });
}

/** Smoke puff sprite. */
export function smokeTexture() {
  return canvasTex('smoke', 64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(200,200,210,0.5)');
    g.addColorStop(1, 'rgba(200,200,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Wooer face decal: eyes, brows, beard on skin tone (applied to head spheres). */
export function faceTexture() {
  return canvasTex('face', 256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#b98a68';
    ctx.fillRect(0, 0, w, h);
    const cx = w * 0.75, cy = h * 0.46;
    const g = ctx.createRadialGradient(cx, cy, 4, cx, cy + 6, 46);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(40,20,10,0.35)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 60, cy - 50, 120, 110);
    ctx.fillStyle = 'rgba(30,16,8,0.55)';
    ctx.fillRect(cx - 24, cy - 8, 16, 7);
    ctx.fillRect(cx + 8, cy - 8, 16, 7);
    ctx.fillStyle = '#1b120c';
    ctx.fillRect(cx - 25, cy - 14, 17, 4);
    ctx.fillRect(cx + 8, cy - 14, 17, 4);
    ctx.fillStyle = '#d9cbb4';
    ctx.fillRect(cx - 20, cy - 6, 6, 3);
    ctx.fillRect(cx + 13, cy - 6, 6, 3);
    ctx.fillStyle = 'rgba(60,30,18,0.5)';
    ctx.fillRect(cx - 3, cy - 4, 6, 16);
    ctx.fillStyle = 'rgba(40,24,14,0.85)';
    ctx.beginPath();
    ctx.moveTo(cx - 30, cy + 16);
    ctx.quadraticCurveTo(cx - 28, cy + 44, cx, cy + 50);
    ctx.quadraticCurveTo(cx + 28, cy + 44, cx + 30, cy + 16);
    ctx.quadraticCurveTo(cx, cy + 30, cx - 30, cy + 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(40,24,14,0.7)';
    ctx.fillRect(cx - 12, cy + 15, 24, 4);
    ctx.fillStyle = '#5a2a20';
    ctx.fillRect(cx - 7, cy + 23, 14, 2);
    // hair (back/top of head)
    ctx.fillStyle = '#1e140d';
    ctx.fillRect(0, 0, w, h * 0.22);
    ctx.fillRect(0, 0, w * 0.55, h);
  });
}

/** Aspis blazon: field + offset rim + painted device (no gods: boar, scorpion, lion, serpent). */
export function shieldTexture(device: 'boar' | 'scorpion' | 'serpent' | 'lion' = 'scorpion', field: 'bronze' | 'blue' | 'gilt' | 'worn' = 'bronze') {
  return canvasTex(`aspis-${device}-${field}`, 256, 256, (ctx, w, h) => {
    const F = { bronze: ['#b98a4c', '#5e4428'], blue: ['#4a6f9a', '#2E4A73'], gilt: ['#e2c06a', '#8a6a2a'], worn: ['#7a5c38', '#3e2e1e'] }[field];
    const g = ctx.createRadialGradient(w * 0.42, h * 0.38, 10, w / 2, h / 2, w * 0.55);
    g.addColorStop(0, F[0]); g.addColorStop(1, F[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = field === 'gilt' ? '#5a3e14' : '#2a1a0e'; ctx.lineWidth = 12;
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.44, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = field === 'blue' ? '#c9b48a' : '#7a2622'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.39, 0, Math.PI * 2); ctx.stroke();
    const ink = field === 'blue' ? '#e6dcc6' : field === 'gilt' ? '#2a1a0a' : '#16110d';
    ctx.fillStyle = ink; ctx.strokeStyle = ink;
    ctx.save(); ctx.translate(w / 2, h / 2);
    ctx.lineCap = 'round';
    if (device === 'scorpion') {
      ctx.beginPath(); ctx.ellipse(0, 10, 20, 34, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(0, -20); ctx.quadraticCurveTo(10, -70, -18, -62); ctx.stroke();
      for (const sd of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(sd * 14, 30); ctx.quadraticCurveTo(sd * 48, 46, sd * 40, 72); ctx.stroke();
        for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(sd * 16, k * 12); ctx.lineTo(sd * 46, -8 + k * 16); ctx.stroke(); }
      }
    } else if (device === 'boar') {
      // charging boar in profile (black-figure): hump, long snout, bristled spine, tusk, thin legs
      ctx.beginPath();
      ctx.moveTo(-70, 10); ctx.quadraticCurveTo(-72, -22, -40, -30); ctx.quadraticCurveTo(-6, -46, 26, -26);
      ctx.quadraticCurveTo(48, -16, 62, -6); ctx.lineTo(88, 2); ctx.lineTo(86, 12); ctx.lineTo(60, 14);
      ctx.quadraticCurveTo(30, 26, -10, 24); ctx.quadraticCurveTo(-50, 26, -70, 10); ctx.closePath(); ctx.fill();
      for (let k = -50; k < 34; k += 7) { const y0 = -30 - Math.sin(((k + 50) / 84) * Math.PI) * 14; ctx.beginPath(); ctx.moveTo(k, y0 + 6); ctx.lineTo(k + 3, y0 - 9); ctx.lineTo(k + 7, y0 + 6); ctx.fill(); }
      ctx.lineWidth = 8;
      for (const [x0, x1] of [[-52, -58], [-36, -30], [30, 24], [46, 52]]) { ctx.beginPath(); ctx.moveTo(x0, 18); ctx.lineTo(x1, 56); ctx.stroke(); }
      ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-70, 4); ctx.quadraticCurveTo(-84, -4, -80, -16); ctx.stroke(); // tail
      ctx.strokeStyle = F[0]; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(74, 10); ctx.quadraticCurveTo(80, -4, 70, -12); ctx.stroke(); // tusk
      ctx.fillStyle = F[0]; ctx.beginPath(); ctx.arc(56, -6, 3, 0, Math.PI * 2); ctx.fill(); // eye
    } else if (device === 'lion') {
      // striding lion, facing left (black-figure)
      ctx.beginPath(); ctx.ellipse(14, 8, 52, 20, -0.05, 0, Math.PI * 2); ctx.fill();          // body
      ctx.beginPath();                                                                          // jagged mane
      for (let k = 0; k <= 16; k++) { const a = Math.PI * 0.35 + (k / 16) * Math.PI * 1.3; const r = k % 2 ? 34 : 26; ctx.lineTo(-38 + Math.cos(a) * r, -4 + Math.sin(a) * r); }
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-62, -2, 16, 12, 0.2, 0, Math.PI * 2); ctx.fill();         // muzzle
      ctx.lineWidth = 9;
      for (const [x0, x1] of [[-14, -22], [4, 10], [40, 34], [56, 66]]) { ctx.beginPath(); ctx.moveTo(x0, 20); ctx.lineTo(x1, 56); ctx.stroke(); } // legs
      ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(64, 2); ctx.bezierCurveTo(96, -6, 96, -40, 80, -44); ctx.stroke(); // tail
      ctx.beginPath(); ctx.arc(80, -46, 7, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.lineWidth = 16;
      ctx.beginPath(); ctx.moveTo(-60, 60); ctx.bezierCurveTo(-60, -10, 60, 30, 40, -50); ctx.stroke();
      ctx.beginPath(); ctx.arc(40, -54, 14, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    noise(ctx, w, h, field === 'worn' ? 0.3 : 0.16, 2);
    if (field === 'worn') for (let k = 0; k < 18; k++) { ctx.fillStyle = 'rgba(10,8,6,0.35)'; ctx.beginPath(); ctx.arc(Math.random() * w, Math.random() * h, 2 + Math.random() * 6, 0, Math.PI * 2); ctx.fill(); }
  });
}
