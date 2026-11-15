// Per-frame combat HUD drawn on a 2D canvas over the game (research spec @1440×810, scaled):
// guard arcs (direction + fill to impact), weapon-tip glints (✦ deflectable / ✕ dodge-only),
// off-screen chevrons, directional damage arcs, perfect-deflect ripples, posture bars over heads.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { runtime } from '../game/runtime';
import { P } from '../game/engine/humanoid';
import { useApp } from '../state/store';

/** read at draw time (the overlay draws on its own rAF loop, outside React renders) */
const inputKindNow = () => useApp.getState().inputKind;

const BRASS = '#C49A4A';
const BRASS_HI = '#FFD58A';
const LINEN = '#E8DFCC';
const RED = '#C23B2E';
const VERD = '#6E9C88';

export function CombatOverlay() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    const v = new THREE.Vector3();
    const chest = new THREE.Vector3();
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const e = runtime.engine;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = window.innerWidth, H = window.innerHeight;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!e || e.mode !== 'match') return;
      const o = e.overlay();
      const k = Math.min(W / 1440, H / 810);
      const cx = W / 2, cy = H / 2;
      const cam = e.camera;
      const toScreen = (p: THREE.Vector3) => {
        v.copy(p).project(cam);
        return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, behind: v.z > 1, on: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
      };

      // ── telegraphs ──
      for (const t of o.telegraphs) {
        const col = t.a.unblockable ? RED : BRASS;
        const toImpact = t.a.impactAt - e.enemies.t;
        // direction readable from 700 ms before impact (fades in over 120 ms)
        const vis = Math.min(1, Math.max(0, (0.82 - toImpact) / 0.12));
        if (vis > 0) {
          const ang = t.a.dir === 'left' ? Math.PI : t.a.dir === 'right' ? 0 : t.a.dir === 'top' ? -Math.PI / 2 : Math.PI / 2;
          const R = 170 * k;
          const span = (70 * Math.PI) / 180;
          ctx.lineCap = 'round';
          ctx.globalAlpha = 0.4 * vis;
          ctx.strokeStyle = col;
          ctx.lineWidth = 5 * k;
          ctx.beginPath(); ctx.arc(cx, cy, R, ang - span / 2, ang + span / 2); ctx.stroke();
          // fill sweeps to 100% at impact — anticipate, don't react
          ctx.globalAlpha = 0.95 * vis;
          ctx.strokeStyle = t.a.unblockable ? RED : BRASS_HI;
          ctx.lineWidth = 6 * k;
          const f = t.progress;
          ctx.beginPath(); ctx.arc(cx, cy, R, ang - (span / 2) * f, ang + (span / 2) * f); ctx.stroke();
          // shape code (not colour alone): ✦ parriable, ✕ dodge only
          const gx = cx + Math.cos(ang) * (R + 22 * k), gy = cy + Math.sin(ang) * (R + 22 * k);
          ctx.globalAlpha = vis;
          glyph(ctx, gx, gy, 11 * k, t.a.unblockable ? 'x' : 'star', t.a.unblockable ? RED : LINEN);
        }
        // glint on the blade tip (or edge chevron when off-screen)
        const s = toScreen(t.tip);
        const glintOn = toImpact <= (t.a.unblockable ? 0.7 : 0.6);
        if (s.on) {
          if (glintOn) {
            const pulse = 1 + 0.25 * Math.sin(performance.now() / 50);
            ctx.globalAlpha = 1;
            const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 26 * k * pulse);
            g.addColorStop(0, t.a.unblockable ? 'rgba(255,120,90,0.95)' : 'rgba(255,245,220,0.95)');
            g.addColorStop(1, 'rgba(255,190,110,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(s.x, s.y, 26 * k * pulse, 0, Math.PI * 2); ctx.fill();
            glyph(ctx, s.x, s.y, 14 * k, t.a.unblockable ? 'x' : 'star', t.a.unblockable ? RED : '#fff6e0');
          }
        } else if (!toScreen(chest.copy(t.e.pos).setY(t.e.pos.y + 1.3)).on) {
          // attacker's BODY off-screen (not just a blade tip leaving frame): chevron pinned to that edge
          const rel = chest.copy(t.e.pos).sub(cam.position);
          const side = Math.sign(Math.sin(Math.atan2(rel.x, -rel.z) - o.yaw)) || 1;
          ctx.globalAlpha = 0.95;
          chevron(ctx, side > 0 ? W - 36 * k : 36 * k, cy + H * 0.1, 16 * k, side, toImpact < 0.6 ? RED : BRASS);
        }
      }

      // ── damage arcs: 50° wide, 10 px, fade 600 ms ──
      for (const d of o.damageArcs) {
        const age = o.realT - d.t;
        if (age > 0.6) continue;
        const a = d.angle - Math.PI / 2;
        const span = ((d.heavy ? 70 : 50) * Math.PI) / 180;
        ctx.globalAlpha = 1 - age / 0.6;
        ctx.lineCap = 'butt';
        ctx.strokeStyle = 'rgba(232,223,204,0.9)';
        ctx.lineWidth = 12 * k;
        ctx.beginPath(); ctx.arc(cx, cy, 240 * k, a - span / 2, a + span / 2); ctx.stroke();
        ctx.strokeStyle = RED;
        ctx.lineWidth = 10 * k;
        ctx.beginPath(); ctx.arc(cx, cy, 240 * k, a - span / 2, a + span / 2); ctx.stroke();
      }

      // ── ripples (perfect deflect / chamber) ──
      for (const r of o.ripples) {
        const age = o.realT - r.t;
        if (age > 0.35) continue;
        const s = toScreen(r.pos);
        if (!s.on) continue;
        ctx.globalAlpha = 1 - age / 0.35;
        ctx.strokeStyle = r.color === 'gold' ? BRASS_HI : r.color === 'verdigris' ? VERD : BRASS;
        ctx.lineWidth = 3 * k;
        ctx.beginPath(); ctx.arc(s.x, s.y, (20 + (age / 0.2) * 140) * k, 0, Math.PI * 2); ctx.stroke();
      }

      // ── posture bars over wooers (only when > 0) ──
      for (const en of o.enemies) {
        if (en.dead || en.kind === 'hero' || en.state === 'idle' || en.kind === 'boss') continue;
        const show = en.posture > 1 || en.state === 'broken';
        if (!show) continue;
        const head = en.pose[P.Head].c;
        const s = toScreen(v.copy(head).setY(head.y + 0.36 * en.look.scale));
        if (!s.on) continue;
        const w = 80 * k, h = 4 * k;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(10,8,6,0.75)';
        ctx.fillRect(s.x - w / 2 - 1, s.y - 1, w + 2, h + 2);
        const f = Math.min(1, en.posture / 100);
        ctx.fillStyle = en.state === 'broken' ? RED : f > 0.7 ? '#e07a3a' : f > 0.4 ? BRASS : LINEN;
        ctx.fillRect(s.x - (w / 2) * f, s.y, w * f, h); // grows from the centre
        if (en.state === 'broken') {
          ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 90);
          ctx.font = `700 ${12 * k}px 'Cinzel', serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = BRASS_HI;
          ctx.fillText('STAGGERED — STRIKE', s.x, s.y - 8 * k);
        }
      }

      // ── hovered weapon on the table / floor: its name, click to take ──
      if (o.hover) {
        const s = toScreen(o.hover.pos);
        if (s.on) {
          ctx.globalAlpha = 0.95;
          ctx.font = `700 ${13 * k}px 'Cinzel', serif`;
          ctx.textAlign = 'center';
          const label = `${o.hover.name.toUpperCase()} · ${inputKindNow() === 'keyboard_mouse' ? 'CLICK' : 'GRIP'}`;
          ctx.lineWidth = 4 * k; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.strokeText(label, s.x, s.y - 22 * k);
          ctx.fillStyle = BRASS_HI;
          ctx.fillText(label, s.x, s.y - 22 * k);
          // webcam: a ring left of the label fills as the hand closes — you see your fist registering
          if (o.hover.progress !== undefined) {
            const rx = s.x - ctx.measureText(label).width / 2 - 19 * k, ry = s.y - 26.5 * k, rr = 10 * k;
            ctx.lineCap = 'round';
            ctx.lineWidth = 6.5 * k; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2); ctx.stroke();
            ctx.lineWidth = 3.5 * k; ctx.strokeStyle = 'rgba(232,223,204,0.35)';
            ctx.beginPath(); ctx.arc(rx, ry, rr, 0, Math.PI * 2); ctx.stroke();
            if (o.hover.progress > 0.01) {
              ctx.strokeStyle = o.hover.progress >= 1 ? '#fff1c8' : BRASS_HI;
              ctx.beginPath(); ctx.arc(rx, ry, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * o.hover.progress); ctx.stroke();
            }
          }
        }
      }

      // ── webcam: a glove chevron at the screen edge for a hand out of frame (solid live, outlined ghost) ──
      for (const h of o.hands) {
        v.copy(h.pos).project(cam);
        const behind = v.z > 1;
        let nx = behind ? -v.x : v.x, ny = behind ? -v.y : v.y;
        if (!behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1) continue;
        if (behind && Math.abs(nx) < 1e-3 && Math.abs(ny) < 1e-3) ny = -1;
        const m = Math.max(Math.abs(nx), Math.abs(ny));
        nx /= m; ny /= m; // onto the frame's edge, keeping the direction
        const pad = 30 * k;
        const x = Math.min(W - pad, Math.max(pad, (nx + 1) / 2 * W)), y = Math.min(H - pad, Math.max(pad, (1 - ny) / 2 * H));
        gloveMark(ctx, x, y, 15 * k, Math.atan2(y - cy, x - cx), h.live, h.side === 'left' ? 'L' : 'R');
      }

      // ── counter window after a perfect dodge ──
      if (o.counter) {
        // label + pulsing ring at the reticle: the window is readable, not just a tint
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 70);
        ctx.globalAlpha = 0.85;
        ctx.font = `900 ${20 * k}px 'Cinzel', serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 4 * k; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText('COUNTER', cx, cy - 120 * k);
        ctx.fillStyle = '#A9D8C2';
        ctx.fillText('COUNTER', cx, cy - 120 * k);
        ctx.globalAlpha = 0.5 + 0.4 * pulse;
        ctx.strokeStyle = VERD; ctx.lineWidth = 3 * k;
        ctx.beginPath(); ctx.arc(cx, cy, (96 + 10 * pulse) * k, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.18;
        const g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.35, cx, cy, Math.max(W, H) * 0.7);
        g.addColorStop(0, 'rgba(110,156,136,0)');
        g.addColorStop(1, 'rgba(110,156,136,1)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalAlpha = 1;
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="combat-overlay" aria-hidden />;
}

function glyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, kind: 'star' | 'x', color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(8,6,4,0.85)';
  ctx.lineWidth = r * 0.5;
  ctx.lineCap = 'round';
  const path = () => {
    ctx.beginPath();
    if (kind === 'x') { ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); }
    else { for (let i = 0; i < 4; i++) { const a = (i * Math.PI) / 2; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r * 1.2, Math.sin(a) * r * 1.2); } }
  };
  path(); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.28;
  path(); ctx.stroke();
  if (kind === 'star') { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

/** A hand out of frame: a round glove badge (L/R) with a chevron pointing toward the hand. */
function gloveMark(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, ang: number, live: boolean, label: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = live ? 0.95 : 0.75;
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.strokeStyle = 'rgba(8,6,4,0.85)';
  ctx.fillStyle = live ? BRASS_HI : 'rgba(10,8,6,0.55)';
  // chevron toward the hand
  ctx.save();
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(r * 1.75, 0); ctx.lineTo(r * 1.05, -r * 0.6); ctx.lineTo(r * 1.05, r * 0.6); ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = live ? BRASS_HI : '#e8f4ff';
  ctx.fill();
  ctx.restore();
  // badge
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = live ? BRASS_HI : 'rgba(10,8,6,0.55)';
  ctx.fill(); ctx.stroke();
  if (!live) { ctx.strokeStyle = '#e8f4ff'; ctx.lineWidth = Math.max(1.5, r * 0.12); ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2); ctx.stroke(); }
  ctx.fillStyle = live ? '#1a120a' : '#e8f4ff';
  ctx.font = `800 ${Math.round(r * 1.05)}px 'Cinzel', serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, r * 0.06);
  ctx.restore();
}

function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, side: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(side, 1);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(8,6,4,0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(-r * 0.6, -r); ctx.lineTo(-r * 0.2, 0); ctx.lineTo(-r * 0.6, r); ctx.closePath();
  ctx.stroke(); ctx.fill();
  ctx.restore();
}
