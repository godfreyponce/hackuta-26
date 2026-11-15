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
    g.addColorStop(0.35, '#6b5f50');
    g.addColorStop(1, '#5a4f42');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // dado (lower painted band)
    ctx.fillStyle = '#5c2320';
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
    // face is centered at u=0.25 (sphere front, +Z after rotation)
    const cx = w * 0.75, cy = h * 0.5;
    ctx.fillStyle = '#1a120c';
    ctx.fillRect(cx - 26, cy - 14, 14, 6);
    ctx.fillRect(cx + 12, cy - 14, 14, 6);
    ctx.fillStyle = '#efe6d6';
    ctx.fillRect(cx - 24, cy - 6, 10, 6);
    ctx.fillRect(cx + 14, cy - 6, 10, 6);
    ctx.fillStyle = '#120c08';
    ctx.fillRect(cx - 21, cy - 5, 5, 5);
    ctx.fillRect(cx + 17, cy - 5, 5, 5);
    // beard
    ctx.fillStyle = '#24170f';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 34, 34, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a2a20';
    ctx.fillRect(cx - 9, cy + 18, 18, 4);
    // hair (back/top of head)
    ctx.fillStyle = '#1e140d';
    ctx.fillRect(0, 0, w, h * 0.22);
    ctx.fillRect(0, 0, w * 0.55, h);
  });
}
