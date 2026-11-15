// Instanced renderer for armored Greek warriors: a layered panoply over the capsule skeleton.
// One InstancedMesh per piece type (≈18 draw calls for every warrior on screen).
import * as THREE from 'three';
import { P, PART_DIM, type PartPose } from './humanoid';
import { faceTexture, shieldTexture } from './textures';
import {
  aspisFace, bracer, cloak, corinthianHelmet, corinthianSlit, crest, greave, linothorax, muscleCuirass, peltMantle, pilosCap, pteruges, stumpCap, trouserThigh, trouserCalf, lacing, circlet, brassTrim, quiver,
} from './armorGeo';
import type { Stump } from './enemies';
import { buildBlade, buildSpear } from './weaponGeo';
import { bakeWeapon, skinSet, weaponSkin } from './weaponSkins';

export type PropKind = 'none' | 'xiphos' | 'spear' | 'bow';
export type ShieldKind = 'none' | 'round';

export interface SlotLook {
  scale: number;
  skin: THREE.Color;
  chiton: THREE.Color;
  armor: 'muscle' | 'linothorax' | 'none';
  armorTint: THREE.Color;
  helmet: 'corinthian' | 'pilos' | 'none';
  helmetTint: THREE.Color;
  crest: 'none' | 'long' | 'trans';
  crestColor: THREE.Color;
  leather: THREE.Color;
  greaves: boolean;
  bracers: boolean;
  cloak: THREE.Color | null;
  prop: PropKind;
  shield: ShieldKind;
  shieldDevice: 'scorpion' | 'boar-blue' | 'lion-gilt' | 'boar-worn';
  pelt: THREE.Color | null;
  /** film details */
  trousers?: THREE.Color | null;
  lacing?: boolean;
  circlet?: boolean;
  trim?: THREE.Color | null;
  quiver?: boolean;
  boss: boolean;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
/** layers worn on the body (wound decals sit on the outermost of these or the skin) */
const WORN = ['limbs', 'head', 'chiton', 'skirt', 'muscle', 'lino', 'pteruges', 'belt', 'corinthian', 'pilos', 'greave', 'bracer', 'cloak', 'pelt', 'trouserThigh', 'trouserCalf', 'trim'];
const FLASH = new THREE.Color(1, 0.8, 0.55);
const LEG_SKIN_DARK = new THREE.Color('#3b2a1c');
const FACE_SHADOW = new THREE.Color('#5a4434');
const WHITE = new THREE.Color(1, 1, 1);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

interface Layer { mesh: THREE.InstancedMesh; perSlot: number; on: Uint8Array; shown: number }

export class ArmoredRenderer {
  readonly group = new THREE.Group();
  readonly capacity: number;
  readonly flash: Float32Array;
  private L: Record<string, Layer> = {};
  private m = new THREE.Matrix4();
  private sc = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private c = new THREE.Color();
  private tmpQ = new THREE.Quaternion().setFromAxisAngle(X, -1.25);
  private c2v = new THREE.Vector3();

  constructor(capacity: number) {
    this.capacity = capacity;
    this.flash = new Float32Array(capacity);
    const metal = () => new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.88, roughness: 0.42, envMapIntensity: 1.1 });
    const cloth = (side: THREE.Side = THREE.FrontSide) => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.93, side });
    const skin = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.72 });

    const capsule = new THREE.CapsuleGeometry(1, 2, 3, 8);
    const headGeo = new THREE.SphereGeometry(1, 14, 10);
    headGeo.scale(0.9, 1.05, 0.95);
    headGeo.rotateY(Math.PI);
    const chitonGeo = new THREE.CapsuleGeometry(0.165, 0.25, 3, 10);
    chitonGeo.scale(1.15, 1, 0.78);
    const skirtGeo = new THREE.CylinderGeometry(0.16, 0.22, 0.34, 12, 1, true);
    skirtGeo.translate(0, -0.1, 0);
    const beltGeo = new THREE.TorusGeometry(0.19, 0.022, 5, 16);
    beltGeo.scale(1.12, 1, 0.86);
    beltGeo.rotateX(Math.PI / 2);
    beltGeo.translate(0, 0.07, 0);
    // the wooers' arms are the same textured bronze / ash / leather as Odysseus' own (shared skins, a group per skin)
    // xiphos: point toward −Y in the hand frame (the forearm points down); tip ≈ 0.63 m like the deflection segment
    const xiphos = bakeWeapon(buildBlade(0.69), new THREE.Matrix4().makeRotationX(Math.PI));
    // dory: butt-spike 0.5 m behind the fist, leaf head ending ≈ 1.8 m ahead along −Y; leather wrap at the fist
    const dory = buildSpear(2.2);
    const doryGrip = dory.getObjectByName('grip');
    if (doryGrip) doryGrip.position.y = 0.255;
    const spear = bakeWeapon(dory, new THREE.Matrix4().makeTranslation(0, 0.255, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI)));
    const arc: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) { const t = (i / 10) * 2 - 1; arc.push(new THREE.Vector3(0, t * 0.55, -0.12 * (1 - t * t))); }
    const bowCurve = new THREE.CatmullRomCurve3(arc);
    const bowGeo = new THREE.TubeGeometry(bowCurve, 24, 0.016, 6, false);
    { // grain along the limbs (tube u runs along the curve → swap into v, metres per 0.5 m tile)
      const uv = bowGeo.getAttribute('uv') as THREE.BufferAttribute;
      const L = bowCurve.getLength();
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), (uv.getX(i) * L) / 0.5);
    }

    const shieldMat = (d: Parameters<typeof shieldTexture>[0], f: Parameters<typeof shieldTexture>[1], metal = 0.75) => {
      const map = shieldTexture(d, f).clone();
      map.center.set(0.5, 0.5);
      map.rotation = Math.PI / 2; // cylinder-cap UVs are quarter-turned
      map.needsUpdate = true;
      // hammered-bronze relief and roughness from the weapon skins (shared image, tiled ×5 across the face)
      const cs = skinSet('cast');
      const tiled = (t: THREE.Texture) => { const c = t.clone(); c.repeat.set(5, 5); c.needsUpdate = true; return c; };
      return new THREE.MeshStandardMaterial({ map, metalness: metal, roughness: 0.62, roughnessMap: tiled(cs.orm), normalMap: tiled(cs.normal), normalScale: new THREE.Vector2(0.6, 0.6) });
    };

    const add = (key: string, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], perSlot = 1, shadow = false, color = true) => {
      const mesh = new THREE.InstancedMesh(geo, mat, capacity * perSlot);
      mesh.frustumCulled = false;
      mesh.castShadow = shadow;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const white = new THREE.Color(1, 1, 1);
      for (let i = 0; i < mesh.count; i++) { mesh.setMatrixAt(i, ZERO); if (color) mesh.setColorAt(i, white); }
      this.group.add(mesh);
      this.L[key] = { mesh, perSlot, on: new Uint8Array(capacity * perSlot), shown: 0 };
      mesh.visible = false;
    };
    add('limbs', capsule, skin, 8, false);
    add('head', headGeo, new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.75 }), 1, false, true);
    add('chiton', chitonGeo, cloth(), 1, false);
    add('skirt', skirtGeo, cloth(THREE.DoubleSide), 1, false);
    add('muscle', muscleCuirass(), metal(), 1, true);
    add('lino', linothorax(), cloth(THREE.DoubleSide), 1, true);
    add('pteruges', pteruges(), cloth(), 1, false);
    add('belt', beltGeo, metal(), 1, false);
    // lathe bells are wound inward — render both sides so the bronze closes over the face
    const helmMetal = () => { const m = metal(); m.side = THREE.DoubleSide; return m; };
    add('corinthian', corinthianHelmet(), helmMetal(), 1, false);
    add('pilos', pilosCap(), helmMetal(), 1, false);
    add('slit', corinthianSlit(), new THREE.MeshBasicMaterial({ color: '#070504', side: THREE.DoubleSide }), 1, false, false);
    const handGeo = new THREE.SphereGeometry(1, 8, 6);
    handGeo.scale(0.045, 0.06, 0.035);
    add('hands', handGeo, skin, 2, false);
    add('crestLong', crest(false), cloth(THREE.DoubleSide), 1, false);
    add('crestTrans', crest(true), cloth(THREE.DoubleSide), 1, false);
    add('greave', greave(), metal(), 2, false);
    add('bracer', bracer(), metal(), 2, false);
    add('cloak', cloak(), cloth(THREE.DoubleSide), 1, false);
    add('xiphos', xiphos.geometry, xiphos.materials, 1, false, false);
    add('spear', spear.geometry, spear.materials, 1, false, false);
    add('bow', bowGeo, weaponSkin('bow-wood') ?? new THREE.MeshStandardMaterial({ color: '#3b2a1c', roughness: 0.7 }), 1, false, false);
    // (the revelers' feast-hall shields: painted hide over a thin bronze facing — duller than a storeroom aspis, so the
    // device reads in the firelight instead of a black mirror filling your view)
    add('aspis-scorpion', aspisFace(0.86), shieldMat('scorpion', 'bronze', 0.35), 1, true, false);
    add('aspis-boar-blue', aspisFace(0.9), shieldMat('boar', 'blue', 0.12), 1, true, false);
    add('aspis-lion-gilt', aspisFace(1.0), shieldMat('lion', 'gilt', 0.9), 1, false, false);
    add('aspis-boar-worn', aspisFace(0.9), shieldMat('boar', 'worn', 0.7), 1, false, false);
    add('pelt', peltMantle(), cloth(THREE.DoubleSide), 1, false);
    add('trouserThigh', trouserThigh(), cloth(THREE.DoubleSide), 2, false);
    add('trouserCalf', trouserCalf(), cloth(THREE.DoubleSide), 2, false);
    add('lacing', lacing(), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 }), 2, false);
    add('circlet', circlet(), new THREE.MeshStandardMaterial({ color: '#D4AF5A', metalness: 1, roughness: 0.25 }), 1, false, false);
    add('trim', brassTrim(), metal(), 1, false);
    add('quiver', quiver(), new THREE.MeshStandardMaterial({ color: '#4a3020', roughness: 0.75 }), 1, false, false);
    add('stump', stumpCap(), new THREE.MeshStandardMaterial({ color: '#6a1410', roughness: 0.45, emissive: '#2a0604', emissiveIntensity: 0.6 }), 1 * 8, false, false);
  }

  private set(key: string, slot: number, k: number, m: THREE.Matrix4 | null, color?: THREE.Color) {
    const l = this.L[key];
    const i = slot * l.perSlot + k;
    l.mesh.setMatrixAt(i, m ?? ZERO);
    const on = m ? 1 : 0;
    if (l.on[i] !== on) { l.shown += on ? 1 : -1; l.on[i] = on; }
    if (color && l.mesh.instanceColor) l.mesh.setColorAt(i, color);
  }

  /**
   * First surface of this warrior's worn layers (chiton, cuirass, belt, skirt, cloak, greaves… and the capsule body
   * when there's no realistic one) along a ray — where a wound decal has to sit to be seen over the clothing.
   */
  surfaceRay(slot: number, origin: THREE.Vector3, dir: THREE.Vector3, far: number): { point: THREE.Vector3; normal: THREE.Vector3; dist: number } | null {
    const rc = this.rayCaster ??= new THREE.Raycaster();
    rc.set(origin, dir.clone().normalize()); rc.near = 0; rc.far = far;
    const probe = this.rayProbe ??= new THREE.Mesh();
    let best: { point: THREE.Vector3; normal: THREE.Vector3; dist: number } | null = null;
    for (const key of WORN) {
      const l = this.L[key];
      if (!l) continue;
      for (let k = 0; k < l.perSlot; k++) {
        const i = slot * l.perSlot + k;
        if (!l.on[i]) continue;
        probe.geometry = l.mesh.geometry;
        probe.material = l.mesh.material;
        l.mesh.getMatrixAt(i, probe.matrixWorld);
        const hits: THREE.Intersection[] = [];
        probe.raycast(rc, hits);
        for (const h of hits) {
          if (best && h.distance >= best.dist) continue;
          const n = h.face ? h.face.normal.clone().transformDirection(probe.matrixWorld) : dir.clone().negate();
          if (n.dot(rc.ray.direction) > 0) n.negate(); // (double-sided cloth: face the ray)
          best = { point: h.point.clone(), normal: n, dist: h.distance };
        }
      }
    }
    return best;
  }
  private rayCaster: THREE.Raycaster | null = null;
  private rayProbe: THREE.Mesh | null = null;

  hide(slot: number) {
    for (const key of Object.keys(this.L)) for (let k = 0; k < this.L[key].perSlot; k++) this.set(key, slot, k, null);
  }

  private tint(base: THREE.Color, slot: number) {
    const fl = this.flash[slot];
    return fl > 0 ? this.c.copy(base).lerp(FLASH, fl * 0.75) : base;
  }

  /** Compose a head piece at the skull anchor: raised `dy` (head frame, metres) and scaled per axis. */
  private fit(anchor: THREE.Vector3, q: THREE.Quaternion, s: number, dy: number, kx: number, ky: number, kz: number) {
    this.v.set(0, dy * s, 0).applyQuaternion(q).add(anchor);
    this.sc.set(kx * s, ky * s, kz * s);
    return this.m.compose(this.v, q, this.sc);
  }

  /** Compose a piece riding on a part (part center/quaternion, uniform scale). */
  private on(p: PartPose, s: number) { this.sc.setScalar(s); return this.m.compose(p.c, p.q, this.sc); }

  write(slot: number, pose: PartPose[], look: SlotLook, opts: { shieldBroken?: boolean; forward?: THREE.Vector3; propVisible?: boolean; stumps?: Stump[]; broken?: boolean; skinned?: boolean; shells?: boolean; head?: THREE.Vector3 | null }) {
    const s = look.scale;
    const sk = !!opts.skinned; // realistic body present → no capsule skin layers
    const sh = !!opts.shells; // cuirass / greaves / bracers / pelt / trousers are grown from the body
    const anchor = opts.head ?? null; // skull centre at eye height → helmets fitted to the real head
    // limbs (skin; lower legs darker where sandals/greaves sit)
    const limbParts = [P.UArmL, P.LArmL, P.UArmR, P.LArmR, P.ULegL, P.LLegL, P.ULegR, P.LLegR];
    for (let k = 0; k < 8; k++) {
      const pi = limbParts[k];
      const d = PART_DIM[pi];
      const p = pose[pi];
      this.sc.set(d.r * s, ((d.hh + d.r) / 2) * s, d.r * s);
      this.m.compose(p.c, p.q, this.sc);
      const lower = pi === P.LLegL || pi === P.LLegR;
      const upperArm = pi === P.UArmL || pi === P.UArmR;
      // chiton sleeves on the upper arms; laced leather on bare shins
      this.set('limbs', slot, k, sk ? null : this.m, this.tint(upperArm ? look.chiton : lower && !look.greaves ? LEG_SKIN_DARK : look.skin, slot));
    }
    const head = pose[P.Head], torso = pose[P.Torso], pel = pose[P.Pelvis];
    this.sc.setScalar(PART_DIM[P.Head].r * s * 1.05);
    this.set('head', slot, 0, sk ? null : this.m.compose(head.c, head.q, this.sc), look.helmet === 'corinthian' ? FACE_SHADOW : WHITE);
    this.set('chiton', slot, 0, sk && look.armor !== 'none' ? null : this.on(torso, s), this.tint(look.chiton, slot));
    this.set('skirt', slot, 0, this.on(pel, s), look.chiton);
    this.set('muscle', slot, 0, !sh && look.armor === 'muscle' ? this.on(torso, s) : null, this.tint(look.armorTint, slot));
    this.set('lino', slot, 0, !sh && look.armor === 'linothorax' ? this.on(torso, s) : null, this.tint(look.armorTint, slot));
    this.set('pteruges', slot, 0, look.armor !== 'none' ? this.on(pel, s) : null, look.leather);
    this.set('belt', slot, 0, sh && look.armor !== 'none' ? null : this.on(pel, s), look.armorTint);
    // helmets: fitted to the measured skull (eye line → slit / brow band) when the real head is known
    const corin = anchor ? this.fit(anchor, head.q, s, 0.01 - 0.042 * 0.86, 0.7, 0.86, 0.8) : this.on(head, s);
    this.set('corinthian', slot, 0, look.helmet === 'corinthian' ? corin : null, this.tint(look.helmetTint, slot));
    this.set('slit', slot, 0, look.helmet === 'corinthian' ? corin : null);
    this.set('crestLong', slot, 0, look.helmet === 'corinthian' && look.crest === 'long' ? corin : null, look.crestColor);
    this.set('crestTrans', slot, 0, look.helmet === 'corinthian' && look.crest === 'trans' ? corin : null, look.crestColor);
    const pil = anchor ? this.fit(anchor, head.q, s, 0.003, 0.72, 0.8, 0.8) : this.on(head, s);
    this.set('pilos', slot, 0, look.helmet === 'pilos' ? pil : null, look.helmetTint);
    if (!anchor) {
      this.set('crestLong', slot, 0, look.helmet !== 'none' && look.crest === 'long' ? this.on(head, s) : null, look.crestColor);
      this.set('crestTrans', slot, 0, look.helmet !== 'none' && look.crest === 'trans' ? this.on(head, s) : null, look.crestColor);
    }
    for (const [k, part] of [[0, P.LArmL], [1, P.LArmR]] as const) {
      const p = pose[part];
      if (sk || (k === 0 && look.shield !== 'none' && !opts.shieldBroken)) { this.set('hands', slot, k, null); continue; } // real hands / fist behind the aspis
      this.v.set(0, -0.045 * s, 0).applyQuaternion(p.q).add(p.b);
      this.sc.setScalar(s);
      this.set('hands', slot, k, this.m.compose(this.v, p.q, this.sc), this.tint(look.skin, slot));
    }
    this.set('greave', slot, 0, !sh && look.greaves ? this.on(pose[P.LLegL], s) : null, look.armorTint);
    this.set('greave', slot, 1, !sh && look.greaves ? this.on(pose[P.LLegR], s) : null, look.armorTint);
    this.set('bracer', slot, 0, !sh && look.bracers ? this.on(pose[P.LArmL], s) : null, look.armorTint);
    this.set('bracer', slot, 1, !sh && look.bracers ? this.on(pose[P.LArmR], s) : null, look.armorTint);
    this.set('cloak', slot, 0, look.cloak ? this.on(torso, s) : null, look.cloak ?? undefined);

    const handR = pose[P.LArmR];
    const showProp = opts.propVisible !== false;
    if (look.prop === 'xiphos' && showProp) {
      this.q.copy(handR.q).multiply(this.tmpQ);
      this.sc.setScalar(s);
      this.set('xiphos', slot, 0, this.m.compose(handR.b, this.q, this.sc));
    } else this.set('xiphos', slot, 0, null);
    if (look.prop === 'spear' && showProp) {
      this.q.copy(handR.q).multiply(new THREE.Quaternion().setFromAxisAngle(X, -Math.PI / 2 + 0.3));
      this.sc.setScalar(s);
      this.m.compose(handR.b, this.q, this.sc);
      this.set('spear', slot, 0, this.m);
    } else this.set('spear', slot, 0, null);
    const armL = pose[P.LArmL];
    const fwd = opts.forward ?? this.v.set(0, 0, 1).applyQuaternion(pel.q);
    if (look.prop === 'bow' && showProp) {
      this.q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), fwd);
      this.sc.setScalar(s);
      this.set('bow', slot, 0, this.m.compose(armL.b, this.q, this.sc));
    } else this.set('bow', slot, 0, null);
    for (const dev of ['scorpion', 'boar-blue', 'lion-gilt', 'boar-worn'] as const) {
      const key = `aspis-${dev}`;
      if (look.shield === 'round' && !opts.shieldBroken && look.shieldDevice === dev) {
        const c = new THREE.Vector3().copy(armL.c).addScaledVector(fwd, 0.13 * s);
        this.q.setFromUnitVectors(Z, fwd);
        this.sc.setScalar(s);
        this.set(key, slot, 0, this.m.compose(c, this.q, this.sc));
      } else this.set(key, slot, 0, null);
    }
    this.set('pelt', slot, 0, !sh && look.pelt ? this.on(torso, s) : null, look.pelt ?? undefined);
    const tr = sh ? null : look.trousers ?? null;
    this.set('trouserThigh', slot, 0, tr ? this.on(pose[P.ULegL], s) : null, tr ?? undefined);
    this.set('trouserThigh', slot, 1, tr ? this.on(pose[P.ULegR], s) : null, tr ?? undefined);
    this.set('trouserCalf', slot, 0, tr ? this.on(pose[P.LLegL], s) : null, tr ?? undefined);
    this.set('trouserCalf', slot, 1, tr ? this.on(pose[P.LLegR], s) : null, tr ?? undefined);
    this.set('lacing', slot, 0, look.lacing ? this.on(pose[P.LLegL], s) : null, look.leather);
    this.set('lacing', slot, 1, look.lacing ? this.on(pose[P.LLegR], s) : null, look.leather);
    this.set('circlet', slot, 0, look.circlet ? (anchor ? this.fit(anchor, head.q, s, 0, 1, 1, 1) : this.on(head, s)) : null);
    this.set('trim', slot, 0, !sh && look.trim && look.armor !== 'none' ? this.on(torso, s) : null, look.trim ?? undefined);
    this.set('quiver', slot, 0, look.quiver ? this.on(torso, s) : null);
    // wound caps on severed joints
    const stumps = opts.stumps ?? [];
    for (let k = 0; k < 8; k++) {
      const st = stumps[k];
      if (!st) { this.set('stump', slot, k, null); continue; }
      const p = pose[st.part];
      this.v.copy(st.local).applyQuaternion(p.q).add(p.c);
      // cap faces outward along the local offset direction
      this.q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.c2v.copy(st.local).normalize()).premultiply(p.q);
      const r = PART_DIM[st.part === P.Torso ? P.Head : st.part].r * s * (st.part === P.Head ? 0.55 : 0.95);
      this.sc.set(r, r, r);
      this.set('stump', slot, k, this.m.compose(this.v, this.q, this.sc));
    }
    // posture broken: brass rim flash pulses (finisher window)
    if (opts.broken) this.flash[slot] = Math.max(this.flash[slot], 0.45 + 0.25 * Math.sin(performance.now() / 90));
  }

  /** World-space segment of the warrior's sword (for deflection tests). */
  swordSegment(pose: PartPose[], look: SlotLook, base: THREE.Vector3, tip: THREE.Vector3) {
    const handR = pose[P.LArmR];
    base.copy(handR.b);
    const len = look.prop === 'spear' ? 1.6 : 0.62;
    this.q.copy(handR.q).multiply(look.prop === 'spear' ? new THREE.Quaternion().setFromAxisAngle(X, -Math.PI / 2 + 0.3) : this.tmpQ);
    tip.set(0, -len * look.scale, 0).applyQuaternion(this.q).add(base);
    if (look.prop === 'spear') tip.set(0, -1.75 * look.scale, 0).applyQuaternion(this.q).add(base);
  }

  commit() {
    for (const key of Object.keys(this.L)) {
      const mesh = this.L[key].mesh;
      // a layer nobody is wearing costs nothing (no draw call, no shadow pass)
      mesh.visible = this.L[key].shown > 0;
      if (!mesh.visible) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
