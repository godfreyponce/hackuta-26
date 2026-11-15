// Wound decals that ride on the body (stab entry/exit holes, gashes) and the blood coat on a blade that has been
// through a man. Decals are attached to the realistic body's bone under the hit (or to the capsule part), so they
// follow the skin alive and on the ragdoll. One instanced draw call per wound kind.
import * as THREE from 'three';
import type { PartPose } from './humanoid';
import { bloodBlend } from './blood';

/** entry/exit: stab holes · gash: an edge's cut · stain: the blood soaking out around a wound and running down */
export type WoundKind = 'entry' | 'exit' | 'gash' | 'stain';
export interface Wound {
  part: number;
  /** bone of the realistic body the wound rides on (null → the capsule part's frame) */
  bone: THREE.Object3D | null;
  /** position / outward normal / decal 'up' (the slit's long axis) in that frame (bone frames are unscaled here) */
  local: THREE.Vector3;
  nLocal: THREE.Vector3;
  tLocal: THREE.Vector3;
  size: number;
  kind: WoundKind;
  bornT: number;
  bleedUntil: number;
  spin: number;
}

interface WoundOwner { wounds: Wound[]; pose: PartPose[]; severed: Set<number> }

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);

/** procedural decal textures (no image files): dark wet hole, ragged blood around it */
function woundTexture(kind: WoundKind): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d')!;
  let seed = kind === 'entry' ? 11 : kind === 'exit' ? 23 : kind === 'gash' ? 37 : 53;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  x.translate(S / 2, S / 2);
  // blood stain: overlapping soft blotches (a fresh, saturated red: the grade keeps blood red, the light is dim)
  const blot = (r: number, a: number, n: number, spreadX: number, spreadY: number) => {
    for (let i = 0; i < n; i++) {
      const px = (rnd() - 0.5) * spreadX, py = (rnd() - 0.5) * spreadY, rr = r * (0.5 + rnd() * 0.8);
      const g = x.createRadialGradient(px, py, 0, px, py, rr);
      g.addColorStop(0, `rgba(168,14,9,${a})`); g.addColorStop(0.6, `rgba(140,10,7,${a * 0.8})`); g.addColorStop(1, 'rgba(110,6,4,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px, py, rr, 0, Math.PI * 2); x.fill();
    }
  };
  // (texture up = world up: blood runs down the canvas)
  const runnels = (n: number, w0: number, y0: number, len: number) => {
    for (let i = 0; i < n; i++) {
      const px = (rnd() - 0.5) * w0, L = len * (0.5 + rnd() * 0.7), wd = 2.5 + rnd() * 3;
      const g = x.createLinearGradient(0, y0, 0, y0 + L);
      g.addColorStop(0, 'rgba(160,12,8,0.97)'); g.addColorStop(0.8, 'rgba(130,9,6,0.9)'); g.addColorStop(1, 'rgba(110,6,4,0)');
      x.fillStyle = g; x.beginPath(); x.ellipse(px, y0 + L / 2, wd, L / 2, 0, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.arc(px, y0 + L - 2, wd * 1.15, 0, Math.PI * 2); x.fillStyle = 'rgba(140,10,6,0.8)'; x.fill();
    }
  };
  if (kind === 'stain') {
    // soaked into the cloth / skin round the wound, running down in streams
    blot(30, 0.85, 14, 60, 44);
    blot(18, 0.9, 6, 30, 20);
    runnels(7, 56, 6, 58);
  } else if (kind === 'entry') {
    blot(22, 0.95, 10, 50, 26);
    runnels(5, 38, 4, 56);
    // the slit the blade cut (the blade held flat): dark, wet, a lip of torn, bright flesh
    x.fillStyle = 'rgba(190,34,22,1)';
    x.beginPath(); x.ellipse(0, 0, 35, 11, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(40,3,2,1)';
    x.beginPath(); x.ellipse(0, 0, 28, 5, 0, 0, Math.PI * 2); x.fill();
  } else if (kind === 'exit') {
    blot(30, 0.95, 12, 64, 50);
    runnels(6, 48, 10, 54);
    // ragged burst hole
    x.fillStyle = 'rgba(185,30,20,1)';
    x.beginPath();
    for (let i = 0; i <= 18; i++) { const a = (i / 18) * Math.PI * 2, r = (i % 2 ? 13 : 22) * (0.7 + rnd() * 0.5); x.lineTo(Math.cos(a) * r * 0.6, Math.sin(a) * r); }
    x.fill();
    x.fillStyle = 'rgba(40,3,2,1)';
    x.beginPath(); x.ellipse(0, 0, 5, 20, 0, 0, Math.PI * 2); x.fill();
  } else {
    // a cut: a long, open red line, bleeding along its length
    blot(14, 0.9, 16, 22, 112);
    x.fillStyle = 'rgba(190,34,22,1)';
    x.beginPath(); x.ellipse(0, 0, 6, 57, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = 'rgba(45,4,3,1)';
    x.beginPath(); x.ellipse(0, 0, 2.6, 52, 0, 0, Math.PI * 2); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class WoundDecals {
  readonly group = new THREE.Group();
  private meshes: Record<WoundKind, THREE.InstancedMesh>;
  private cap = 96;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const make = (kind: WoundKind) => {
      const map = woundTexture(kind);
      // wet (a sheen that catches the fire) and faintly self-lit, so a wound reads on a man standing in shadow
      const mat = bloodBlend(new THREE.MeshStandardMaterial({
        map, transparent: true, depthWrite: false, roughness: 0.3, metalness: 0, envMapIntensity: 0.5,
        emissive: new THREE.Color(1, 1, 1), emissiveMap: map, emissiveIntensity: 0.1,
        polygonOffset: true, polygonOffsetFactor: kind === 'stain' ? -8 : -10, polygonOffsetUnits: kind === 'stain' ? -16 : -20, side: THREE.DoubleSide,
      }));
      // a decal is a flat card on a round body: seen edge-on (his side, from your side) it would stand off him, so it
      // fades out at grazing angles — the wide stains firmly, the small wound marks only when nearly edge-on
      const [f0, f1] = kind === 'stain' ? [0.22, 0.55] : [0.05, 0.25];
      mat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>\n  diffuseColor.a *= smoothstep(${f0.toFixed(2)}, ${f1.toFixed(2)}, abs(dot(normal, normalize(vViewPosition))));`);
      };
      // the fade's numbers are baked into the shader: each kind needs its own program, not the first one compiled
      mat.customProgramCacheKey = () => 'wound-fade-' + kind;
      const m = new THREE.InstancedMesh(geo, mat, this.cap);
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = kind === 'stain' ? 1 : 2;
      m.name = `wounds-${kind}`;
      this.group.add(m);
      return m;
    };
    this.meshes = { stain: make('stain'), entry: make('entry'), exit: make('exit'), gash: make('gash') };
  }

  /**
   * Add a wound at a world point/normal. `tangent` is the slit's long axis (the blade's width) — projected onto
   * the surface. With a bone, the wound is stored in the bone's frame (its matrixWorld must be current).
   */
  add(owner: WoundOwner, part: number, bone: THREE.Object3D | null, point: THREE.Vector3, normal: THREE.Vector3,
    tangent: THREE.Vector3, size: number, kind: WoundKind, now: number, bleed = 4, stain = 0) {
    this.push(owner, part, bone, point, normal, tangent, size, kind, now, bleed);
    // the blood soaking out round it and running down (spreads over a few seconds; doesn't bleed by itself)
    if (stain > 0) this.push(owner, part, bone, point, normal, _UP, stain, 'stain', now, 0);
  }

  private push(owner: WoundOwner, part: number, bone: THREE.Object3D | null, point: THREE.Vector3, normal: THREE.Vector3,
    tangent: THREE.Vector3, size: number, kind: WoundKind, now: number, bleed: number) {
    const n = _n.copy(normal).normalize();
    const t = _t.copy(tangent).addScaledVector(n, -tangent.dot(n));
    if (t.lengthSq() < 1e-6) t.set(0, 1, 0).addScaledVector(n, -n.y);
    if (t.lengthSq() < 1e-6) t.set(1, 0, 0);
    t.normalize();
    let local: THREE.Vector3, nl: THREE.Vector3, tl: THREE.Vector3;
    if (bone) {
      // rigid frame of the bone without its scale (the body root is scaled)
      bone.matrixWorld.decompose(_p, _q, _s);
      _qi.copy(_q).invert();
      local = point.clone().sub(_p).applyQuaternion(_qi);
      nl = n.clone().applyQuaternion(_qi);
      tl = t.clone().applyQuaternion(_qi);
    } else {
      const pp = owner.pose[part];
      _qi.copy(pp.q).invert();
      local = point.clone().sub(pp.c).applyQuaternion(_qi);
      nl = n.clone().applyQuaternion(_qi);
      tl = t.clone().applyQuaternion(_qi);
    }
    owner.wounds.push({ part, bone, local, nLocal: nl, tLocal: tl, size, kind, bornT: now, bleedUntil: now + bleed, spin: (Math.random() - 0.5) * (kind === 'stain' ? 0.5 : 0.25) });
    if (owner.wounds.length > 20) owner.wounds.shift();
  }

  /** World position / normal of a wound (for bleeding). */
  worldOf(owner: WoundOwner, w: Wound, outP: THREE.Vector3, outN: THREE.Vector3) {
    if (w.bone) {
      w.bone.matrixWorld.decompose(_p, _q, _s);
      outP.copy(w.local).applyQuaternion(_q).add(_p);
      outN.copy(w.nLocal).applyQuaternion(_q);
    } else {
      const pp = owner.pose[w.part];
      outP.copy(w.local).applyQuaternion(pp.q).add(pp.c);
      outN.copy(w.nLocal).applyQuaternion(pp.q);
    }
    return outP;
  }

  render(owners: Iterable<WoundOwner>, now: number) {
    const count: Record<WoundKind, number> = { entry: 0, exit: 0, gash: 0, stain: 0 };
    for (const o of owners) {
      for (const w of o.wounds) {
        if (o.severed.has(w.part)) continue; // the limb's skin went with the gib
        const mesh = this.meshes[w.kind];
        const i = count[w.kind];
        if (i >= this.cap) continue;
        if (w.bone) {
          w.bone.matrixWorld.decompose(_p, _q, _s);
          _b.copy(w.local).applyQuaternion(_q).add(_p);
          _n.copy(w.nLocal).applyQuaternion(_q);
          _t.copy(w.tLocal).applyQuaternion(_q);
        } else {
          const pp = o.pose[w.part];
          _b.copy(w.local).applyQuaternion(pp.q).add(pp.c);
          _n.copy(w.nLocal).applyQuaternion(pp.q);
          _t.copy(w.tLocal).applyQuaternion(pp.q);
        }
        // a fresh wound opens over ~80 ms; its stain soaks outward over ~2.5 s (sitting a little low: it runs down)
        const age = now - w.bornT;
        const grow = w.kind === 'stain' ? 0.45 + 0.55 * (1 - Math.pow(1 - Math.min(1, age / 2.5), 2)) : Math.min(1, 0.35 + age / 0.08);
        _b.addScaledVector(_n, w.kind === 'stain' ? 0.006 : 0.007);
        if (w.kind === 'stain') _b.addScaledVector(_t, -0.14 * w.size * grow);
        const xAx = _s.crossVectors(_t, _n).normalize();
        _m.makeBasis(xAx, _t, _n);
        _q.setFromRotationMatrix(_m);
        if (w.spin) _q.multiply(_qi.setFromAxisAngle(_p.set(0, 0, 1), w.spin));
        const sz = w.size * grow;
        // (a stain runs down more than it spreads across: narrow, so it stays on the curve of him)
        _m2.compose(_b, _q, _p.set(sz * (w.kind === 'gash' ? 0.5 : w.kind === 'stain' ? 0.62 : 1), sz, 1));
        mesh.setMatrixAt(i, _m2);
        count[w.kind] = i + 1;
      }
    }
    for (const k of Object.keys(this.meshes) as WoundKind[]) {
      const m = this.meshes[k];
      m.count = count[k];
      m.visible = count[k] > 0;
      if (count[k]) m.instanceMatrix.needsUpdate = true;
    }
  }
}

// ── blood on the blade ────────────────────────────────────────────────────
/** A coat of blood laid over the blade (a slightly fattened copy of the blade/spearhead/shaft meshes), shown from
 *  the point back as far as it went in; wet and bright when fresh, darker as it dries, gone after ~40 s. */
interface Coat { parts: { mesh: THREE.Mesh; e13: number; e5: number }[]; mats: THREE.MeshStandardMaterial[]; uCut: { value: number }[]; uAlpha: { value: number }; cover: number; t: number }

export class BladeBlood {
  private coats = new Map<number, Coat>();

  private build(obj: THREE.Object3D): Coat | null {
    const sources: THREE.Mesh[] = [];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.name === 'blade' || m.name === 'spearhead' || m.name === 'shaft' || m.name === 'socket')) sources.push(m);
    });
    if (!sources.length) return null;
    obj.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const uAlpha = { value: 0 };
    const coat: Coat = { parts: [], mats: [], uCut: [], uAlpha, cover: 0, t: 0 };
    for (const src of sources) {
      const uCut = { value: 1e3 };
      const mat = bloodBlend(new THREE.MeshStandardMaterial({
        color: '#8a0b06', roughness: 0.2, metalness: 0.1, transparent: true, depthWrite: false,
        emissive: '#3a0302', emissiveIntensity: 0.35,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      }));
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uCut = uCut; sh.uniforms.uAlpha = uAlpha;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBloodP;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBloodP = position;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vBloodP;\nuniform float uCut;\nuniform float uAlpha;')
          .replace('#include <dithering_fragment>', `#include <dithering_fragment>
            float wob = 0.012 * sin(vBloodP.x * 230.0 + vBloodP.z * 90.0) + 0.008 * sin(vBloodP.x * 610.0);
            float streak = step(0.72, fract(sin(floor(vBloodP.x * 140.0) * 12.9898) * 43758.5453));
            float cut = uCut + wob - streak * 0.05;
            float a = smoothstep(cut - 0.004, cut + 0.004, vBloodP.y);
            gl_FragColor.a *= a * uAlpha;
            if (gl_FragColor.a < 0.01) discard;`);
      };
      const m = new THREE.Mesh(src.geometry, mat);
      m.name = 'blood-coat';
      // flat blades: a hair wider, a film thicker; round shafts: a sleeve
      if (src.name === 'shaft' || src.name === 'socket') m.scale.set(1.12, 1.0, 1.12); else m.scale.set(1.05, 1.0, 1.7);
      m.renderOrder = 3;
      m.frustumCulled = false;
      m.visible = false;
      src.add(m);
      // the source mesh's frame relative to the weapon (translation along / scale of local Y)
      const rel = new THREE.Matrix4().multiplyMatrices(inv, src.matrixWorld);
      coat.parts.push({ mesh: m, e13: rel.elements[13], e5: rel.elements[5] || 1 });
      coat.mats.push(mat);
      coat.uCut.push(uCut);
    }
    return coat;
  }

  /** Blood the blade from its point `tipY` (weapon frame) back `depth` metres. */
  bloody(id: number, obj: THREE.Object3D | null, tipY: number, depth: number) {
    if (!obj) return;
    let c = this.coats.get(id);
    if (!c) { const b = this.build(obj); if (!b) return; c = b; this.coats.set(id, c); }
    c.cover = Math.max(c.t > 20 ? 0 : c.cover, depth);
    c.t = 0;
    const cutW = tipY - c.cover - 0.01;
    c.parts.forEach((p, i) => { c.uCut[i].value = (cutW - p.e13) / p.e5; p.mesh.visible = true; });
  }

  update(dt: number) {
    for (const [id, c] of this.coats) {
      c.t += dt;
      // fresh → glistening; dries darker and duller; fades after 40 s
      c.uAlpha.value = c.t < 30 ? 0.95 : Math.max(0, 0.95 - (c.t - 30) / 10);
      const dry = Math.min(1, c.t / 14);
      for (const m of c.mats) { m.roughness = 0.2 + 0.5 * dry; m.color.setRGB(0.52 - 0.3 * dry, 0.018 - 0.008 * dry, 0.012 - 0.004 * dry); m.emissiveIntensity = 0.35 * (1 - 0.7 * dry); }
      if (c.uAlpha.value <= 0) { for (const p of c.parts) p.mesh.visible = false; c.cover = 0; }
      void id;
    }
  }

  forget(id: number) {
    const c = this.coats.get(id);
    if (!c) return;
    for (const p of c.parts) { p.mesh.removeFromParent(); }
    for (const m of c.mats) m.dispose();
    this.coats.delete(id);
  }
}
