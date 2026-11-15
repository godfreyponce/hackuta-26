// Motion Lab side panels: game-space view (front + top) and the live threshold sliders.
import type { PlayerInputState } from '@ithaca/shared';
import { config, CONFIG_RANGES, DEFAULT_CONFIG, resetConfig, type MotionConfig } from '../config';
import type { Body } from '../mapping';

const SPACE = { w: 360, h: 190 };

/**
 * 2D stand-in for the spec's small R3F scene: front view (x/y) and top view (x/z) of the mapped
 * hands and forearms in game space. Hand dot size grows with grip; filled = gripping.
 */
export function drawGameSpace(cv: HTMLCanvasElement, state: PlayerInputState | null, body: Body | null): void {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  if (cv.width !== SPACE.w * dpr) {
    cv.width = SPACE.w * dpr;
    cv.height = SPACE.h * dpr;
  }
  const g = cv.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, SPACE.w, SPACE.h);
  const half = SPACE.w / 2;
  const pad = 10;
  // Front: x ∈ [-0.9, 0.9], y ∈ [-1.1, 0.5]. Top: x ∈ [-0.9, 0.9], z ∈ [-1.1, 0.3] (forward = up on screen).
  const sx = (half - 2 * pad) / 1.8;
  const front = (x: number, y: number): [number, number] => [pad + (x + 0.9) * sx, 22 + (0.5 - y) * ((SPACE.h - 32) / 1.6)];
  const top = (x: number, z: number): [number, number] => [half + pad + (x + 0.9) * sx, 22 + (z + 1.1) * ((SPACE.h - 32) / 1.4)];

  g.font = '11px ui-sans-serif, system-ui';
  g.fillStyle = '#9a917f';
  g.fillText('FRONT (x / y)', pad, 13);
  g.fillText('TOP (x / z, forward ↑)', half + pad, 13);
  g.strokeStyle = '#34302a';
  g.beginPath();
  g.moveTo(half, 4);
  g.lineTo(half, SPACE.h - 4);
  g.stroke();
  // Eyes (origin) and the z clamp band.
  const dot = (p: [number, number], r: number, c: string, fill = true) => {
    g.beginPath();
    g.arc(p[0], p[1], r, 0, Math.PI * 2);
    if (fill) {
      g.fillStyle = c;
      g.fill();
    } else {
      g.strokeStyle = c;
      g.lineWidth = 2;
      g.stroke();
    }
  };
  dot(front(0, 0), 4, '#ece6d8');
  dot(top(0, 0), 4, '#ece6d8');
  g.fillStyle = '#ffffff08';
  const [bx0, by0] = top(-0.9, config.zFar);
  const [, by1] = top(0, config.zNear);
  g.fillRect(bx0, by0, half - 2 * pad, by1 - by0);

  if (!state || !body?.ok) return;
  const col = { left: '#4cc9f0', right: '#f8961e' } as const;
  for (const h of ['left', 'right'] as const) {
    const hs = state.hands[h];
    const sh = body.shoulder[h], el = body.elbow[h];
    g.strokeStyle = hs.visible ? col[h] : '#555';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(...front(sh.x, sh.y));
    g.lineTo(...front(el.x, el.y));
    g.lineTo(...front(hs.pos.x, hs.pos.y));
    g.moveTo(...top(sh.x, sh.z));
    g.lineTo(...top(el.x, el.z));
    g.lineTo(...top(hs.pos.x, hs.pos.z));
    g.stroke();
    const r = 4 + hs.grip * 5;
    dot(front(hs.pos.x, hs.pos.y), r, col[h], hs.grip > 0.5);
    dot(top(hs.pos.x, hs.pos.z), r, col[h], hs.grip > 0.5);
    // velocity arrow (0.1 s look-ahead)
    g.strokeStyle = '#ffffff90';
    g.beginPath();
    g.moveTo(...front(hs.pos.x, hs.pos.y));
    g.lineTo(...front(hs.pos.x + hs.vel.x * 0.1, hs.pos.y + hs.vel.y * 0.1));
    g.moveTo(...top(hs.pos.x, hs.pos.z));
    g.lineTo(...top(hs.pos.x + hs.vel.x * 0.1, hs.pos.z + hs.vel.z * 0.1));
    g.stroke();
  }
}

const STORE_KEY = 'ithaca.motion.labConfig.v1';

/** Builds sliders for every entry in CONFIG_RANGES. Tweaks persist per browser (lab only). */
export function buildSliders(host: HTMLElement): void {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? 'null') as Partial<MotionConfig> | null;
    if (saved) for (const [k, v] of Object.entries(saved)) if (k in config && typeof v === 'number') config[k as keyof MotionConfig] = v;
  } catch {
    /* ignore */
  }
  const persist = () => {
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(config));
    } catch {
      /* ignore */
    }
  };
  const render = () => {
    host.innerHTML = '';
    for (const [section, ranges] of Object.entries(CONFIG_RANGES)) {
      const h = document.createElement('h3');
      h.textContent = section;
      host.append(h);
      for (const [key, range] of Object.entries(ranges)) {
        if (!range) continue;
        const k = key as keyof MotionConfig;
        const [min, max, step] = range;
        const label = document.createElement('label');
        label.title = `default ${DEFAULT_CONFIG[k]}`;
        label.innerHTML = `<span>${k}</span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
        const input = label.querySelector('input') as HTMLInputElement;
        const out = label.querySelector('output') as HTMLOutputElement;
        const sync = () => {
          out.textContent = String(+config[k].toFixed(3));
          label.classList.toggle('changed', config[k] !== DEFAULT_CONFIG[k]);
        };
        input.value = String(config[k]);
        sync();
        input.addEventListener('input', () => {
          config[k] = Number(input.value);
          sync();
          persist();
        });
        label.addEventListener('dblclick', () => {
          config[k] = DEFAULT_CONFIG[k];
          input.value = String(config[k]);
          sync();
          persist();
        });
        host.append(label);
      }
    }
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<button data-x="reset" class="small">reset all</button> <button data-x="copy" class="small">copy JSON (changed only)</button>';
    row.querySelector('[data-x="reset"]')?.addEventListener('click', () => {
      resetConfig();
      persist();
      render();
    });
    row.querySelector('[data-x="copy"]')?.addEventListener('click', () => {
      const changed = Object.fromEntries(
        Object.entries(config).filter(([k, v]) => v !== DEFAULT_CONFIG[k as keyof MotionConfig]),
      );
      void navigator.clipboard?.writeText(JSON.stringify(changed, null, 2));
    });
    host.append(row);
  };
  render();
}
