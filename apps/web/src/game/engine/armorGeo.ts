// Procedural Greek panoply (DOM-free geometry; materials live in the renderer).
// All pieces are built in the local frame of the humanoid part they ride on (see humanoid.ts):
//   head  → centered on the head sphere (r≈0.12), +Z = face
//   torso → centered on the torso capsule (spans ≈ −0.29…+0.29 in Y), +Z = chest
//   pelvis→ centered on the pelvis, +Z = front
//   lower leg / lower arm → capsule along Y, centered
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const V2 = (x: number, y: number) => new THREE.Vector2(x, y);

/** Strip to position+normal (+uv) and de-index so mixed primitives merge. */
function norm(g: THREE.BufferGeometry, keepUv = false) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) {
    if (k === 'position' || k === 'normal' || (keepUv && k === 'uv')) continue;
    n.deleteAttribute(k);
  }
  if (keepUv && !n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
  return n;
}
const merge = (gs: THREE.BufferGeometry[], keepUv = false) => mergeGeometries(gs.map((g) => norm(g, keepUv)))!;

function latheSeg(points: THREE.Vector2[], segs: number, phiStart: number, phiLen: number) {
  const g = new THREE.LatheGeometry(points, segs, phiStart, phiLen);
  return g;
}

/** Corinthian helmet: bell with a T-shaped face opening, cheek guards, nasal, flared neck guard. */
export function corinthianHelmet(): THREE.BufferGeometry {
  const prof = [V2(0.0, 0.178), V2(0.075, 0.17), V2(0.126, 0.14), V2(0.152, 0.085), V2(0.158, 0.02), V2(0.156, -0.05), V2(0.16, -0.12), V2(0.178, -0.175)];
  const parts: THREE.BufferGeometry[] = [];
  // closed bell — the face openings are a dark T plate (corinthianSlit) set just proud of the bronze
  parts.push(latheSeg(prof, 22, 0, Math.PI * 2));
  // nasal ridge
  parts.push(latheSeg([V2(0.161, 0.05), V2(0.166, 0.0), V2(0.167, -0.05)], 2, -0.05, 0.1));
  // cheek-guard edges (raised beads framing the slit)
  for (const sx of [-1, 1]) {
    const bead = new THREE.CylinderGeometry(0.005, 0.005, 0.13, 4);
    bead.translate(0, -0.085, 0);
    bead.rotateY(sx * 0.11);
    bead.translate(Math.sin(sx * 0.11) * 0.163, 0, Math.cos(sx * 0.11) * 0.163);
    parts.push(bead);
  }
  // rim bead
  const rim = new THREE.TorusGeometry(0.178, 0.007, 4, 24);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, -0.175, 0);
  parts.push(rim);
  const g = merge(parts);
  g.translate(0, 0.012, 0);
  return g;
}

/** Pilos: conical felt/bronze cap for light infantry. */
/** The Corinthian's T-shaped openings: almond eye bar + vertical mouth slit (render dark, slightly proud). */
export function corinthianSlit(): THREE.BufferGeometry {
  const eyes = new THREE.Shape();
  eyes.moveTo(-0.075, 0.0);
  eyes.quadraticCurveTo(-0.045, 0.026, -0.012, 0.012);
  eyes.lineTo(0.012, 0.012);
  eyes.quadraticCurveTo(0.045, 0.026, 0.075, 0.0);
  eyes.quadraticCurveTo(0.04, -0.012, 0.0, -0.004);
  eyes.quadraticCurveTo(-0.04, -0.012, -0.075, 0.0);
  const eg = new THREE.ShapeGeometry(eyes, 6);
  eg.translate(0, 0.03, 0);
  const mouth = new THREE.PlaneGeometry(0.028, 0.115);
  mouth.translate(0, -0.075, 0);
  const g = merge([eg, mouth]);
  // wrap onto the front of the bell (r≈0.162) — bend x around the curve
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const a = x / 0.162;
    pos.setXYZ(i, Math.sin(a) * 0.1635, y + 0.012, Math.cos(a) * 0.1635);
  }
  g.computeVertexNormals();
  return g;
}

export function pilosCap(): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry([V2(0, 0.2), V2(0.05, 0.17), V2(0.11, 0.08), V2(0.135, 0.02), V2(0.138, -0.01), V2(0.142, -0.02)], 14);
  return merge([g]);
}

/** Horsehair crest on a stilt: a crescent fan running front→back (rotate 90° for a transverse crest). */
export function crest(transverse = false): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.17, 0.0);
  s.quadraticCurveTo(-0.16, 0.2, 0.02, 0.2);
  s.quadraticCurveTo(0.2, 0.18, 0.24, -0.08);
  s.quadraticCurveTo(0.12, 0.04, -0.17, 0.0);
  const fan = new THREE.ExtrudeGeometry(s, { depth: 0.035, bevelEnabled: false, curveSegments: 6 });
  fan.translate(0, 0, -0.0175);
  fan.rotateY(Math.PI / 2); // runs along Z (front ← −X … back)
  fan.scale(1.25, 1.2, 1.25);
  fan.translate(0, 0.2, 0);
  const stilt = new THREE.BoxGeometry(0.03, 0.05, 0.07);
  stilt.translate(0, 0.195, 0);
  const g = merge([fan, stilt]);
  if (transverse) g.rotateY(Math.PI / 2);
  return g;
}

/** Bronze muscle cuirass with pectorals, worn over the chiton. */
export function muscleCuirass(): THREE.BufferGeometry {
  const prof = [V2(0.15, -0.27), V2(0.19, -0.25), V2(0.175, -0.17), V2(0.17, -0.05), V2(0.19, 0.08), V2(0.205, 0.17), V2(0.185, 0.23), V2(0.12, 0.27)];
  const body = new THREE.LatheGeometry(prof, 24);
  body.scale(1.2, 1, 0.84);
  const neck = new THREE.TorusGeometry(0.12, 0.012, 4, 20);
  neck.rotateX(Math.PI / 2);
  neck.scale(1.2, 1, 0.84);
  neck.translate(0, 0.262, 0);
  const hem = new THREE.TorusGeometry(0.19, 0.012, 4, 24);
  hem.rotateX(Math.PI / 2);
  hem.scale(1.2, 1, 0.84);
  hem.translate(0, -0.252, 0);
  // embossed sternum ridge and pectoral arcs — reads as sculpted bronze without lumpy geometry
  const ridge = new THREE.BoxGeometry(0.012, 0.3, 0.012);
  ridge.translate(0, -0.03, 0.168);
  const arcs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const a = new THREE.TorusGeometry(0.075, 0.007, 3, 10, Math.PI * 0.8);
    a.rotateZ(Math.PI * 1.1);
    a.translate(sx * 0.075, 0.1, 0.17);
    arcs.push(a);
  }
  return merge([body, neck, hem, ridge, ...arcs]);
}

/** Linothorax: boxy linen corselet with shoulder flaps. */
export function linothorax(): THREE.BufferGeometry {
  const body = new THREE.LatheGeometry([V2(0.172, -0.27), V2(0.188, -0.22), V2(0.18, -0.02), V2(0.19, 0.12), V2(0.198, 0.22), V2(0.13, 0.265)], 16);
  body.scale(1.2, 1, 0.84);
  const band = new THREE.CylinderGeometry(0.19, 0.19, 0.05, 16, 1, true);
  band.scale(1.21, 1, 0.85);
  band.translate(0, -0.16, 0);
  const flaps: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const f = new THREE.BoxGeometry(0.12, 0.022, 0.25);
    f.rotateZ(sx * -0.32);
    f.translate(sx * 0.13, 0.265, 0);
    flaps.push(f);
  }
  return merge([body, band, ...flaps]);
}

/** Pteruges: two rows of leather strips hanging from the waist (rides on the pelvis part). */
export function pteruges(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [row, n, r, len, y] of [[0, 16, 0.19, 0.2, 0.05], [1, 16, 0.205, 0.26, 0.0]] as const) {
    for (let i = 0; i < n; i++) {
      const a = ((i + (row ? 0.5 : 0)) / n) * Math.PI * 2;
      const strip = new THREE.BoxGeometry(0.068, len, 0.014);
      strip.translate(0, -len / 2, 0);
      strip.rotateX(0.16); // flare outward
      strip.rotateY(a);
      strip.translate(Math.sin(a) * r * 1.12, y, Math.cos(a) * r * 0.86);
      parts.push(strip);
    }
  }
  return merge(parts);
}

/** Greave: shin guard, open at the back, rides on the lower leg capsule (hh≈0.15). */
export function greave(): THREE.BufferGeometry {
  const prof = [V2(0.06, -0.19), V2(0.072, -0.12), V2(0.082, -0.02), V2(0.078, 0.08), V2(0.085, 0.15), V2(0.07, 0.2)];
  const g = new THREE.LatheGeometry(prof, 12, -2.2, 4.4); // phi=0 is +Z (front)
  return merge([g]);
}

/** Bracer for the forearm. */
export function bracer(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.06, 0.052, 0.16, 10, 1, true);
  g.translate(0, -0.03, 0);
  return merge([g]);
}

/** Cloak panel hanging behind the shoulders (rides on the torso). */
export function cloak(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.5, 1.0, 4, 6);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const t = (0.5 - y) / 1.0; // 0 at top → 1 at hem
    pos.setX(i, x * (1 + t * 0.5));
    pos.setZ(i, -0.2 - Math.cos((x / 0.5) * Math.PI) * 0.06 - t * 0.12);
  }
  g.translate(0, -0.25, 0);
  g.computeVertexNormals();
  return merge([g]);
}

/** Xiphos (leaf-bladed short sword) for wooers — tip at −Y (hangs from the fist), bronze. */
export function xiphosProp(): THREE.BufferGeometry {
  const len = 0.58;
  const s = new THREE.Shape();
  const w = 0.05;
  s.moveTo(-w * 0.35, 0);
  s.bezierCurveTo(-w * 0.75, len * 0.3, -w * 0.62, len * 0.68, 0, len);
  s.bezierCurveTo(w * 0.62, len * 0.68, w * 0.75, len * 0.3, w * 0.35, 0);
  const blade = new THREE.ExtrudeGeometry(s, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.004, bevelSegments: 1, curveSegments: 5 });
  blade.translate(0, 0.05, -0.004);
  const guard = new THREE.BoxGeometry(0.09, 0.018, 0.026);
  guard.translate(0, 0.045, 0);
  const grip = new THREE.CylinderGeometry(0.014, 0.016, 0.1, 6);
  grip.translate(0, -0.01, 0);
  const pommel = new THREE.SphereGeometry(0.022, 6, 4);
  pommel.translate(0, -0.065, 0);
  const g = merge([blade, guard, grip, pommel]);
  g.rotateX(Math.PI); // tip toward −Y in the hand frame (forearm points down)
  return g;
}

/** Aspis with UVs for a blazon texture (face +Z). */
export function aspisFace(diameter = 0.82): THREE.BufferGeometry {
  const r = diameter / 2;
  const face = new THREE.CylinderGeometry(r, r, 0.03, 28, 1, false);
  face.rotateX(Math.PI / 2);
  const rim = new THREE.TorusGeometry(r, 0.022, 5, 28);
  return merge([face, rim], true);
}

/** Lion-pelt mantle over the shoulders (rides on the torso; mane collar + hanging hide). */
export function peltMantle(): THREE.BufferGeometry {
  const collar = new THREE.TorusGeometry(0.17, 0.05, 6, 18);
  collar.rotateX(Math.PI / 2);
  collar.scale(1.25, 1, 0.95);
  collar.translate(0, 0.27, -0.01);
  const hide = new THREE.PlaneGeometry(0.46, 0.5, 4, 4);
  const pos = hide.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const t = (0.25 - y) / 0.5;
    pos.setX(i, x * (1 + t * 0.25) + (Math.random() - 0.5) * 0.02 * t);
    pos.setZ(i, -0.19 - Math.cos((x / 0.46) * Math.PI) * 0.05 - t * 0.06);
    if (y < -0.2) pos.setY(i, y - Math.random() * 0.06); // ragged hem
  }
  hide.translate(0, 0.02, 0);
  hide.computeVertexNormals();
  return merge([collar, hide]);
}

/** Wound cap at a severed joint: a flattened dome, faces +Y (rides on the part, oriented by its axis). */
export function stumpCap(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(1, 0.35, 1);
  return merge([g]);
}

export const TORSO_HALF = 0.29;
