// Procedural low-poly weapon models. DOM-free so scripts/make-prefabs.ts can export them to GLB in Node.
// Canonical frame: long axis +Y, grip at the origin ('end' grip: blade toward +Y; 'center': centered).
// Shields: face normal +Y (the thin axis), so "forward" when held.
import * as THREE from 'three';
import type { WeaponClass } from '@ithaca/shared';

export const MAT = {
  bronze: () => new THREE.MeshStandardMaterial({ name: 'bronze', color: '#9C7442', metalness: 0.92, roughness: 0.34 }),
  bronzeDark: () => new THREE.MeshStandardMaterial({ name: 'bronze-oxidized', color: '#5E4930', metalness: 0.85, roughness: 0.52 }),
  brass: () => new THREE.MeshStandardMaterial({ name: 'brass', color: '#C49A4A', metalness: 1, roughness: 0.28 }),
  wood: () => new THREE.MeshStandardMaterial({ name: 'ash-wood', color: '#6A4A2C', metalness: 0, roughness: 0.82 }),
  woodDark: () => new THREE.MeshStandardMaterial({ name: 'dark-wood', color: '#3B2A1C', metalness: 0, roughness: 0.85 }),
  leather: () => new THREE.MeshStandardMaterial({ name: 'leather', color: '#3A2618', metalness: 0, roughness: 0.9 }),
  clay: () => new THREE.MeshStandardMaterial({ name: 'terracotta', color: '#B5562E', metalness: 0, roughness: 0.88 }),
  glaze: () => new THREE.MeshStandardMaterial({ name: 'black-glaze', color: '#16110D', metalness: 0.1, roughness: 0.35 }),
  linen: () => new THREE.MeshStandardMaterial({ name: 'linen', color: '#D6CCBA', metalness: 0, roughness: 0.95 }),
  iron: () => new THREE.MeshStandardMaterial({ name: 'cast-iron', color: '#2A2724', metalness: 0.75, roughness: 0.55 }),
  fruit: () => new THREE.MeshStandardMaterial({ name: 'pomegranate', color: '#8E2A1F', metalness: 0, roughness: 0.55 }),
  ember: () => new THREE.MeshStandardMaterial({ name: 'ember', color: '#3A1A0A', emissive: '#FF7A22', emissiveIntensity: 2.2, roughness: 1 }),
  sinew: () => new THREE.MeshStandardMaterial({ name: 'sinew', color: '#D9C9A6', roughness: 0.7 }),
};

const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
  const o = new THREE.Mesh(g, m);
  o.name = name;
  o.castShadow = true;
  return o;
};

function leafShape(len: number, width: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-width * 0.18, 0);
  s.bezierCurveTo(-width * 0.62, len * 0.25, -width * 0.5, len * 0.62, 0, len);
  s.bezierCurveTo(width * 0.5, len * 0.62, width * 0.62, len * 0.25, width * 0.18, 0);
  s.closePath();
  return s;
}

function extrudedBlade(len: number, width: number, thick: number) {
  const g = new THREE.ExtrudeGeometry(leafShape(len, width), {
    depth: thick, bevelEnabled: true, bevelThickness: thick * 0.6, bevelSize: width * 0.06, bevelSegments: 1, curveSegments: 6,
  });
  g.translate(0, 0, -thick / 2);
  return g;
}

/** Dory: ash shaft, bronze leaf spearhead, bronze butt-spike (sauroter). Grip at the end. */
export function buildSpear(length = 1.8): THREE.Group {
  const g = new THREE.Group();
  g.name = 'spear';
  const k = length / 1.8;
  const shaftLen = 1.38 * k;
  const shaft = mesh(new THREE.CylinderGeometry(0.017 * k, 0.019 * k, shaftLen, 7), MAT.wood(), 'shaft');
  shaft.position.y = shaftLen / 2 - 0.08 * k;
  g.add(shaft);
  const butt = mesh(new THREE.ConeGeometry(0.02 * k, 0.12 * k, 6), MAT.bronze(), 'sauroter');
  butt.rotation.x = Math.PI;
  butt.position.y = -0.14 * k;
  g.add(butt);
  const socket = mesh(new THREE.CylinderGeometry(0.02 * k, 0.024 * k, 0.1 * k, 7), MAT.bronze(), 'socket');
  socket.position.y = shaftLen - 0.08 * k + 0.02 * k;
  g.add(socket);
  const head = mesh(extrudedBlade(0.34 * k, 0.085 * k, 0.008 * k), MAT.bronze(), 'spearhead');
  head.position.y = shaftLen - 0.04 * k;
  g.add(head);
  const wrap = mesh(new THREE.CylinderGeometry(0.022 * k, 0.022 * k, 0.16 * k, 7), MAT.leather(), 'grip');
  wrap.position.y = 0.02;
  g.add(wrap);
  return g;
}

/** Xiphos-style leaf blade. `length` overall (dagger ≈ 0.45, sword ≈ 0.9). */
export function buildBlade(length = 0.9): THREE.Group {
  const g = new THREE.Group();
  g.name = 'blade';
  const hilt = Math.max(0.1, length * 0.17);
  const bladeLen = length - hilt - 0.03;
  const width = length * 0.085;
  const grip = mesh(new THREE.CylinderGeometry(0.016, 0.018, hilt, 8), MAT.leather(), 'grip');
  grip.position.y = hilt / 2 - 0.04;
  g.add(grip);
  const pommel = mesh(new THREE.SphereGeometry(0.026, 8, 6), MAT.bronze(), 'pommel');
  pommel.scale.set(1.3, 0.7, 1);
  pommel.position.y = -0.045;
  g.add(pommel);
  const guard = mesh(new THREE.BoxGeometry(width * 1.7, 0.02, 0.03), MAT.bronze(), 'guard');
  guard.position.y = hilt - 0.035;
  g.add(guard);
  const blade = mesh(extrudedBlade(bladeLen, width, 0.006), MAT.bronze(), 'blade');
  blade.position.y = hilt - 0.03;
  g.add(blade);
  const rib = mesh(new THREE.BoxGeometry(0.006, bladeLen * 0.82, 0.012), MAT.bronzeDark(), 'midrib');
  rib.position.y = hilt - 0.03 + bladeLen * 0.43;
  g.add(rib);
  return g;
}

/** Bronze-headed club (generic 'blunt' fallback). */
export function buildClub(length = 0.5): THREE.Group {
  const g = new THREE.Group();
  g.name = 'club';
  const k = length / 0.5;
  const handle = mesh(new THREE.CylinderGeometry(0.02 * k, 0.026 * k, 0.36 * k, 8), MAT.woodDark(), 'handle');
  handle.position.y = 0.14 * k;
  g.add(handle);
  const head = mesh(new THREE.IcosahedronGeometry(0.075 * k, 0), MAT.bronze(), 'head');
  head.position.y = 0.38 * k;
  head.scale.set(1, 1.25, 1);
  g.add(head);
  const band = mesh(new THREE.TorusGeometry(0.03 * k, 0.008 * k, 5, 10), MAT.brass(), 'band');
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.3 * k;
  g.add(band);
  return g;
}

/** Frying pan (the mock-mode "real object" forged weapon, public/dev/sample-weapon.glb). */
export function buildFryingPan(length = 0.5): THREE.Group {
  const g = new THREE.Group();
  g.name = 'frying-pan';
  const k = length / 0.5;
  const handle = mesh(new THREE.BoxGeometry(0.03 * k, 0.24 * k, 0.016 * k), MAT.woodDark(), 'handle');
  handle.position.y = 0.1 * k;
  g.add(handle);
  const neck = mesh(new THREE.CylinderGeometry(0.012 * k, 0.014 * k, 0.05 * k, 6), MAT.iron(), 'neck');
  neck.position.y = 0.24 * k;
  g.add(neck);
  const panProfile = [
    new THREE.Vector2(0, 0), new THREE.Vector2(0.11 * k, 0), new THREE.Vector2(0.125 * k, 0.04 * k),
    new THREE.Vector2(0.118 * k, 0.042 * k), new THREE.Vector2(0.104 * k, 0.008 * k), new THREE.Vector2(0, 0.008 * k),
  ];
  const pan = mesh(new THREE.LatheGeometry(panProfile, 18), MAT.iron(), 'pan');
  pan.rotation.x = -Math.PI / 2;
  pan.position.set(0, 0.38 * k, -0.01 * k);
  g.add(pan);
  return g;
}

/** Pomegranate (generic 'throwable'). Centered. */
export function buildPomegranate(size = 0.2): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pomegranate';
  const r = size * 0.42;
  const body = mesh(new THREE.IcosahedronGeometry(r, 1), MAT.fruit(), 'fruit');
  body.scale.set(1, 0.92, 1);
  g.add(body);
  const crown = mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.18, r * 0.38, 6, 1, true), MAT.fruit(), 'crown');
  crown.position.y = r * 1.0;
  g.add(crown);
  return g;
}

/** Aspis: round hoplite shield. Normal +Y; centered. */
export function buildAspis(diameter = 0.7): THREE.Group {
  const g = new THREE.Group();
  g.name = 'aspis';
  const r = diameter / 2;
  const profile = [
    new THREE.Vector2(0, 0.06 * diameter), new THREE.Vector2(r * 0.55, 0.05 * diameter), new THREE.Vector2(r * 0.9, 0.025 * diameter),
    new THREE.Vector2(r, 0.01), new THREE.Vector2(r * 1.04, 0), new THREE.Vector2(r, -0.012), new THREE.Vector2(0, -0.01),
  ];
  const face = mesh(new THREE.LatheGeometry(profile, 24), MAT.bronze(), 'face');
  g.add(face);
  const rim = mesh(new THREE.TorusGeometry(r * 1.0, 0.016 * diameter, 5, 28), MAT.bronzeDark(), 'rim');
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  const boss = mesh(new THREE.SphereGeometry(r * 0.13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), MAT.brass(), 'boss');
  boss.position.y = 0.055 * diameter;
  g.add(boss);
  const strap = mesh(new THREE.BoxGeometry(r * 0.7, 0.02, 0.04), MAT.leather(), 'porpax');
  strap.position.y = -0.03;
  g.add(strap);
  return g;
}

/** Greek-fire pot (generic 'bomb'): clay belly, black-glaze band, glowing rag wick. Centered. */
export function buildFirePot(size = 0.25): THREE.Group {
  const g = new THREE.Group();
  g.name = 'fire-pot';
  const k = size / 0.25;
  const profile = [
    new THREE.Vector2(0, -0.1 * k), new THREE.Vector2(0.05 * k, -0.1 * k), new THREE.Vector2(0.09 * k, -0.05 * k),
    new THREE.Vector2(0.095 * k, 0.01 * k), new THREE.Vector2(0.06 * k, 0.06 * k), new THREE.Vector2(0.03 * k, 0.08 * k),
    new THREE.Vector2(0.034 * k, 0.1 * k), new THREE.Vector2(0, 0.1 * k),
  ];
  g.add(mesh(new THREE.LatheGeometry(profile, 14), MAT.clay(), 'pot'));
  const band = mesh(new THREE.CylinderGeometry(0.097 * k, 0.093 * k, 0.03 * k, 14, 1, true), MAT.glaze(), 'band');
  band.position.y = -0.005 * k;
  g.add(band);
  const wick = mesh(new THREE.ConeGeometry(0.022 * k, 0.07 * k, 5), MAT.ember(), 'wick');
  wick.position.y = 0.13 * k;
  g.add(wick);
  return g;
}

/** Aryballos flask (generic 'potion'). Centered, upright along +Y. */
export function buildFlask(size = 0.22): THREE.Group {
  const g = new THREE.Group();
  g.name = 'flask';
  const k = size / 0.22;
  const profile = [
    new THREE.Vector2(0, -0.1 * k), new THREE.Vector2(0.055 * k, -0.09 * k), new THREE.Vector2(0.07 * k, -0.04 * k),
    new THREE.Vector2(0.06 * k, 0.01 * k), new THREE.Vector2(0.02 * k, 0.05 * k), new THREE.Vector2(0.018 * k, 0.08 * k),
    new THREE.Vector2(0.034 * k, 0.09 * k), new THREE.Vector2(0, 0.095 * k),
  ];
  g.add(mesh(new THREE.LatheGeometry(profile, 14), MAT.clay(), 'flask'));
  const band = mesh(new THREE.CylinderGeometry(0.071 * k, 0.068 * k, 0.03 * k, 14, 1, true), MAT.glaze(), 'band');
  band.position.y = -0.035 * k;
  g.add(band);
  const cork = mesh(new THREE.CylinderGeometry(0.016 * k, 0.014 * k, 0.03 * k, 6), MAT.woodDark(), 'stopper');
  cork.position.y = 0.105 * k;
  g.add(cork);
  return g;
}

/** Palintonos (back-curved composite) bow — the bow of Odysseus. Grip at center, limbs along ±Y. */
export function buildBowStave(): { group: THREE.Group; tipTop: THREE.Vector3; tipBottom: THREE.Vector3 } {
  const g = new THREE.Group();
  g.name = 'bow';
  const pts: THREE.Vector3[] = [];
  // Recurve profile in the YZ plane: belly toward the archer (+Z local), tips recurve forward.
  for (let i = 0; i <= 16; i++) {
    const t = i / 16 * 2 - 1;               // -1..1
    const y = t * 0.62;
    const bend = 0.09 * (1 - t * t);        // main curve away from archer
    const recurve = Math.pow(Math.abs(t), 6) * 0.08; // tips flick back
    pts.push(new THREE.Vector3(0, y, -bend + recurve + 0.06));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const limb = mesh(new THREE.TubeGeometry(curve, 32, 0.014, 6, false), MAT.woodDark(), 'stave');
  g.add(limb);
  const horn = mesh(new THREE.TubeGeometry(curve, 32, 0.009, 5, false), MAT.bronzeDark(), 'horn-inlay');
  horn.position.z = -0.008;
  g.add(horn);
  const grip = mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8), MAT.leather(), 'grip');
  grip.position.z = -0.03;
  g.add(grip);
  for (const sgn of [1, -1]) {
    const cap = mesh(new THREE.SphereGeometry(0.014, 6, 4), MAT.brass(), 'nock-cap');
    cap.position.copy(pts[sgn > 0 ? 16 : 0]);
    g.add(cap);
  }
  return { group: g, tipTop: pts[16].clone(), tipBottom: pts[0].clone() };
}

/** Arrow: reed shaft, bronze head, fletching. Tail at origin, tip at +Y length. */
export function buildArrow(length = 0.78): THREE.Group {
  const g = new THREE.Group();
  g.name = 'arrow';
  const shaft = mesh(new THREE.CylinderGeometry(0.0045, 0.0045, length - 0.06, 4), MAT.linen(), 'shaft');
  shaft.position.y = (length - 0.06) / 2;
  g.add(shaft);
  const head = mesh(new THREE.ConeGeometry(0.012, 0.07, 4), MAT.bronze(), 'head');
  head.position.y = length - 0.03;
  g.add(head);
  for (let i = 0; i < 3; i++) {
    const f = mesh(new THREE.PlaneGeometry(0.022, 0.09), MAT.ember(), 'fletch');
    (f.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    (f.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.25;
    f.position.y = 0.06;
    f.rotation.y = (i / 3) * Math.PI * 2;
    f.translateX(0.012);
    g.add(f);
  }
  return g;
}

export const PREFAB_BUILDERS: Record<WeaponClass, () => THREE.Group> = {
  spear: () => buildSpear(1.8),
  sword: () => buildBlade(0.9),
  blunt: () => buildClub(0.5),
  throwable: () => buildPomegranate(0.2),
  shield: () => buildAspis(0.7),
  bomb: () => buildFirePot(0.25),
  potion: () => buildFlask(0.22),
};
