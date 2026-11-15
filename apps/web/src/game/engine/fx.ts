// CPU-simulated point particles, one draw call per system. Used for hearth fire, embers, sparks,
// Greek-fire explosions, dust and the golden storeroom glow.
import * as THREE from 'three';
import { flameTexture, glowTexture, smokeTexture } from './textures';
import { rand } from './math';
import { BloodDrops, BloodFloor, bloodBlend } from './blood';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  uniform float uScale;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  varying vec4 vColor;
  void main() {
    vec4 t = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
    if (gl_FragColor.a < 0.004) discard;
  }
`;

export interface EmitOpts {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  spread?: number;         // velocity jitter (m/s)
  posJitter?: number;
  life?: [number, number];
  size?: [number, number]; // world-ish size
  color: THREE.ColorRepresentation;
  color2?: THREE.ColorRepresentation; // fade-to color
  alpha?: number;
  gravity?: number;        // m/s² (negative = rises)
  drag?: number;
  grow?: number;           // size multiplier over life
}

export class Particles {
  readonly points: THREE.Points;
  private cap: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private grow: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private a0: Float32Array;
  private sizeAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;
  private posAttr: THREE.BufferAttribute;
  private next = 0;
  private alive = 0;
  private tmpC = new THREE.Color();
  private tmpC2 = new THREE.Color();

  constructor(cap: number, map: THREE.Texture, blending: THREE.Blending) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.c0 = new Float32Array(cap * 3);
    this.c1 = new Float32Array(cap * 3);
    this.a0 = new Float32Array(cap);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -12), 60);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uMap: { value: map }, uScale: { value: 600 } },
      transparent: true, depthWrite: false, blending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewportHeight(px: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = px * 0.9;
  }

  emit(n: number, o: EmitOpts) {
    this.tmpC.set(o.color);
    this.tmpC2.set(o.color2 ?? o.color);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.cap;
      const pj = o.posJitter ?? 0;
      this.pos[i * 3] = o.pos.x + rand(-pj, pj);
      this.pos[i * 3 + 1] = o.pos.y + rand(-pj, pj);
      this.pos[i * 3 + 2] = o.pos.z + rand(-pj, pj);
      const s = o.spread ?? 0;
      this.vel[i * 3] = (o.vel?.x ?? 0) + rand(-s, s);
      this.vel[i * 3 + 1] = (o.vel?.y ?? 0) + rand(-s, s);
      this.vel[i * 3 + 2] = (o.vel?.z ?? 0) + rand(-s, s);
      const L = o.life ? rand(o.life[0], o.life[1]) : 1;
      this.life[i] = L;
      this.maxLife[i] = L;
      this.size0[i] = o.size ? rand(o.size[0], o.size[1]) : 0.1;
      this.grow[i] = o.grow ?? 1;
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
      this.c0[i * 3] = this.tmpC.r; this.c0[i * 3 + 1] = this.tmpC.g; this.c0[i * 3 + 2] = this.tmpC.b;
      this.c1[i * 3] = this.tmpC2.r; this.c1[i * 3 + 1] = this.tmpC2.g; this.c1[i * 3 + 2] = this.tmpC2.b;
      this.a0[i] = o.alpha ?? 1;
    }
    this.alive = this.cap;
  }

  update(dt: number) {
    if (this.alive === 0) return;
    const size = this.sizeAttr.array as Float32Array;
    const col = this.colorAttr.array as Float32Array;
    let any = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) { size[i] = 0; col[i * 4 + 3] = 0; continue; }
      any++;
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i]; // 0..1
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      size[i] = this.size0[i] * (1 + (this.grow[i] - 1) * t);
      col[i * 4] = this.c0[i * 3] + (this.c1[i * 3] - this.c0[i * 3]) * t;
      col[i * 4 + 1] = this.c0[i * 3 + 1] + (this.c1[i * 3 + 1] - this.c0[i * 3 + 1]) * t;
      col[i * 4 + 2] = this.c0[i * 3 + 2] + (this.c1[i * 3 + 2] - this.c0[i * 3 + 2]) * t;
      const fadeIn = Math.min(1, t * 8);
      col[i * 4 + 3] = this.a0[i] * fadeIn * (1 - t) * (1 - t * 0.2);
    }
    if (any === 0) this.alive = 0;
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }
}

/** All FX systems for the scene. */
/**
 * Streak sparks (one draw call): instanced camera-facing quads from head to tail = pos − vel·22 ms, white-hot HDR
 * cooling to orange, gravity + drag, one floor bounce. Bronze is non-sparking, so bronze contacts are short.
 */
class StreakSparks {
  readonly mesh: THREE.Mesh;
  private cap = 256;
  private head: Float32Array;
  private vel: Float32Array;
  private life: Float32Array; // (t 0..1, alive)
  private age: Float32Array;
  private max: Float32Array;
  private bounced: Uint8Array;
  private next = 0;
  private iHead: THREE.InstancedBufferAttribute;
  private iVel: THREE.InstancedBufferAttribute;
  private iLife: THREE.InstancedBufferAttribute;
  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute([-1, 1, -1, 1], 1));
    g.setAttribute('aEnd', new THREE.Float32BufferAttribute([0, 0, 1, 1], 1));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    this.head = new Float32Array(this.cap * 3);
    this.vel = new Float32Array(this.cap * 3);
    this.life = new Float32Array(this.cap * 2);
    this.age = new Float32Array(this.cap);
    this.max = new Float32Array(this.cap);
    this.bounced = new Uint8Array(this.cap);
    this.iHead = new THREE.InstancedBufferAttribute(this.head, 3).setUsage(THREE.DynamicDrawUsage);
    this.iVel = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    this.iLife = new THREE.InstancedBufferAttribute(this.life, 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iHead', this.iHead); g.setAttribute('iVel', this.iVel); g.setAttribute('iLife', this.iLife);
    g.instanceCount = this.cap;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aSide; attribute float aEnd; attribute vec3 iHead; attribute vec3 iVel; attribute vec2 iLife;
        varying float vT; varying float vEnd; varying float vAlive;
        void main() {
          vec3 tailOff = iVel * 0.022;
          float L = length(tailOff);
          if (L > 0.25) tailOff *= 0.25 / L;
          vec3 head = iHead, tail = iHead - tailOff;
          vec3 p = mix(head, tail, aEnd);
          vec3 seg = normalize(head - tail + vec3(1e-5, 2e-5, 0.0));
          vec3 side = normalize(cross(seg, normalize(cameraPosition - p)));
          p += side * aSide * 0.0055 * (1.0 - aEnd * 0.6);
          vT = iLife.x; vEnd = aEnd; vAlive = iLife.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vT; varying float vEnd; varying float vAlive;
        void main() {
          if (vAlive < 0.5) discard;
          vec3 c = mix(vec3(3.2, 2.9, 2.2), vec3(2.0, 1.1, 0.35), smoothstep(0.0, 0.35, vT));
          c = mix(c, vec3(0.5, 0.08, 0.02), smoothstep(0.35, 1.0, vT));
          gl_FragColor = vec4(c, (1.0 - vT) * (1.0 - vEnd * 0.7));
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }
  emit(pos: THREE.Vector3, axis: THREE.Vector3, cone: number, n: number, speed: number, life: [number, number]) {
    const t = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
    const a = axis.clone().normalize();
    t.set(1, 0, 0); if (Math.abs(a.x) > 0.9) t.set(0, 1, 0);
    b.crossVectors(a, t).normalize(); t.crossVectors(b, a).normalize();
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % this.cap;
      const th = Math.random() * cone, ph = Math.random() * Math.PI * 2;
      d.copy(a).multiplyScalar(Math.cos(th)).addScaledVector(t, Math.sin(th) * Math.cos(ph)).addScaledVector(b, Math.sin(th) * Math.sin(ph));
      const sp = speed * rand(0.6, 1.4);
      this.head.set([pos.x, pos.y, pos.z], i * 3);
      this.vel.set([d.x * sp, d.y * sp, d.z * sp], i * 3);
      this.age[i] = 0; this.max[i] = rand(life[0], life[1]); this.bounced[i] = 0;
      this.life[i * 2] = 0; this.life[i * 2 + 1] = 1;
    }
  }
  update(dt: number) {
    const drag = Math.exp(-2.2 * dt);
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i * 2 + 1] < 0.5) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.max[i]) { this.life[i * 2 + 1] = 0; continue; }
      const o = i * 3;
      this.vel[o + 1] -= 9.8 * dt;
      this.vel[o] *= drag; this.vel[o + 1] *= drag; this.vel[o + 2] *= drag;
      this.head[o] += this.vel[o] * dt; this.head[o + 1] += this.vel[o + 1] * dt; this.head[o + 2] += this.vel[o + 2] * dt;
      if (this.head[o + 1] <= 0.01 && !this.bounced[i]) {
        this.bounced[i] = 1; this.head[o + 1] = 0.01;
        this.vel[o + 1] = -0.35 * this.vel[o + 1]; this.vel[o] *= 0.6; this.vel[o + 2] *= 0.6;
      }
      this.life[i * 2] = this.age[i] / this.max[i];
    }
    this.iHead.needsUpdate = true; this.iVel.needsUpdate = true; this.iLife.needsUpdate = true;
  }
}

/** Contact flash: 4 pooled star sprites, HDR so they clear the bloom threshold; ≤ 3 full-strength per second. */
class ClashFlash {
  readonly group = new THREE.Group();
  private pool: { s: THREE.Sprite; t: number; life: number; size: number }[] = [];
  private recent: number[] = [];
  private clock = 0;
  constructor() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d')!;
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,240,210,0.8)'); g.addColorStop(1, 'rgba(255,200,120,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    x.globalCompositeOperation = 'lighter';
    for (const [len, w] of [[62, 3], [62, 3], [30, 2], [30, 2]] as const) {
      x.save(); x.translate(64, 64);
      x.rotate(len === 62 ? (this.pool.length ? 0 : 0) : Math.PI / 4);
      const lg = x.createLinearGradient(-len, 0, len, 0);
      lg.addColorStop(0, 'rgba(255,230,190,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,230,190,0)');
      x.fillStyle = lg; x.fillRect(-len, -w / 2, len * 2, w);
      x.restore();
      x.rotate(Math.PI / 2);
    }
    const tex = new THREE.CanvasTexture(c);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(4.0, 3.5, 2.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
      const s = new THREE.Sprite(m); s.visible = false; s.renderOrder = 8;
      this.group.add(s);
      this.pool.push({ s, t: 1, life: 0.07, size: 0.1 });
    }
  }
  fire(pos: THREE.Vector3, size: number) {
    this.recent = this.recent.filter((t) => this.clock - t < 1);
    const strength = this.recent.length < 3 ? 1 : 0.3; // photosensitivity: ≤ 3 full flashes per second
    this.recent.push(this.clock);
    const p = this.pool.reduce((a, b) => (a.t > b.t ? a : b));
    p.t = 0; p.size = size; p.life = 0.07;
    p.s.position.copy(pos);
    p.s.material.rotation = Math.random() * Math.PI;
    (p.s.material as THREE.SpriteMaterial).opacity = strength;
    p.s.visible = true;
  }
  update(dt: number) {
    this.clock += dt;
    for (const p of this.pool) {
      if (!p.s.visible) continue;
      p.t += dt / p.life;
      if (p.t >= 1) { p.s.visible = false; continue; }
      const k = (1 - p.t) * (1 - p.t);
      p.s.scale.setScalar(p.size * (0.7 + 0.3 * k));
      (p.s.material as THREE.SpriteMaterial).color.setRGB(4.0 * k, 3.5 * k, 2.6 * k);
    }
  }
}

export type ContactKind = 'clash' | 'parry' | 'beat' | 'block' | 'glance' | 'helmet' | 'armour' | 'shield';

export class Fx {
  readonly group = new THREE.Group();
  readonly add: Particles;   // additive: fire, sparks, embers, gold
  readonly flame: Particles; // additive flame sprites
  readonly smoke: Particles; // normal: smoke, dust
  readonly gore: Particles;  // normal: fine blood mist
  /** blood in flight: wet streaks along their velocity (readable at play distance in the dim hall) */
  readonly drops = new BloodDrops();
  /** blood on the floor: splats where drops land, pools under the dead */
  readonly floorBlood = new BloodFloor();
  private emberAcc = 0;
  private flameAcc = 0;
  private tmp = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  hearth: THREE.Vector3 | null = null;
  braziers: THREE.Vector3[] = [];
  private streaks = new StreakSparks();
  private flash = new ClashFlash();

  constructor() {
    this.add = new Particles(900, glowTexture(), THREE.AdditiveBlending);
    this.flame = new Particles(220, flameTexture(), THREE.AdditiveBlending);
    this.smoke = new Particles(260, smokeTexture(), THREE.NormalBlending);
    this.smoke.points.renderOrder = 4;
    this.gore = new Particles(500, smokeTexture(), THREE.NormalBlending);
    this.gore.points.renderOrder = 4;
    bloodBlend(this.gore.points.material as THREE.Material);
    this.group.add(this.smoke.points, this.gore.points, this.flame.points, this.add.points, this.streaks.mesh, this.flash.group, this.drops.mesh, this.floorBlood.group);
    // a drop that lands leaves its mark (a little wider than the drop: it spreads)
    this.drops.onFloor = (x, z, w) => this.floorBlood.splat(x, z, Math.min(0.2, w * rand(4, 7)));
  }

  /**
   * Weapon contact: streak sparks in a cone around the contact normal leaning along the slide, plus a star flash.
   * `v` = relative speed (m/s). Counts/lifetimes per contact kind (research brief).
   */
  contact(pos: THREE.Vector3, normal: THREE.Vector3, tangent: THREE.Vector3 | null, v: number, kind: ContactKind) {
    const axis = this.tmpV2.copy(normal).normalize();
    if (tangent && tangent.lengthSq() > 1e-6) axis.addScaledVector(this.tmp.copy(tangent).normalize(), kind === 'glance' ? 2.5 : 1.2).normalize();
    const sp = 0.35 * v + 1.5;
    const deg = THREE.MathUtils.degToRad;
    switch (kind) {
      case 'clash': this.streaks.emit(pos, axis, deg(55), Math.round(12 + 1.5 * Math.min(12, v)), sp, [0.12, 0.35]); this.flash.fire(pos, 0.1 + 0.08 * Math.min(1, v / 10)); break;
      case 'parry': this.streaks.emit(pos, axis, deg(60), Math.round(rand(45, 60)), sp * 1.3, [0.18, 0.5]); this.flash.fire(pos, 0.22); break;
      case 'beat': this.streaks.emit(pos, axis, deg(55), Math.round(rand(14, 20)), sp, [0.12, 0.32]); this.flash.fire(pos, 0.12); break;
      case 'block': this.streaks.emit(pos, axis, deg(50), Math.round(rand(5, 8)), sp * 0.6, [0.08, 0.2]); this.flash.fire(pos, 0.06); break;
      case 'glance': this.streaks.emit(pos, axis, deg(20), Math.round(rand(6, 12)), sp, [0.1, 0.28]); break;
      case 'helmet': this.streaks.emit(pos, axis, deg(45), Math.round(rand(8, 12)), sp, [0.1, 0.3]); this.flash.fire(pos, 0.07); break;
      case 'armour': this.streaks.emit(pos, axis, deg(45), Math.round(rand(4, 6)), sp, [0.08, 0.22]); break;
      case 'shield':
        this.streaks.emit(pos, axis, deg(45), Math.round(rand(0, 3)), sp, [0.08, 0.2]);
        this.smoke.emit(Math.round(rand(6, 10)), { pos, vel: this.tmpV.copy(normal).multiplyScalar(1.6), spread: 1.2, life: [0.4, 0.8], size: [0.02, 0.04], color: '#5a3d22', alpha: 0.9, gravity: 9, drag: 1.5 });
        break;
    }
  }

  setViewportHeight(px: number) {
    this.add.setViewportHeight(px);
    this.flame.setViewportHeight(px);
    this.smoke.setViewportHeight(px);
    this.gore.setViewportHeight(px);
  }

  update(dt: number, ambientDt: number) {
    // ambient fire runs on the ambient clock (slows in slow-mo too)
    if (this.hearth) {
      this.flameAcc += ambientDt * 130;
      while (this.flameAcc > 1) {
        this.flameAcc -= 1;
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.55;
        this.flame.emit(1, {
          pos: this.tmp.set(this.hearth.x + Math.cos(a) * r, 0.45, this.hearth.z + Math.sin(a) * r),
          vel: this.tmpV.set(0, rand(1.4, 2.6), 0), spread: 0.18, life: [0.45, 0.9], size: [0.22, 0.48],
          color: '#ff9a3c', color2: '#a8300f', alpha: 0.24, grow: 0.35, gravity: -1.3,
        });
      }
      this.emberAcc += ambientDt * 26;
      while (this.emberAcc > 1) {
        this.emberAcc -= 1;
        this.add.emit(1, {
          pos: this.tmp.set(this.hearth.x + rand(-0.8, 0.8), rand(0.5, 1.0), this.hearth.z + rand(-0.8, 0.8)),
          vel: this.tmpV.set(rand(-0.2, 0.2), rand(0.6, 1.8), rand(-0.2, 0.2)), spread: 0.35, life: [1.6, 3.4], size: [0.02, 0.045],
          color: '#ffd08a', color2: '#ff5a1a', alpha: 1, gravity: -0.25, drag: 0.3,
        });
        if (Math.random() < 0.6) this.smoke.emit(1, {
          pos: this.tmp.set(this.hearth.x + rand(-0.4, 0.4), 1.6, this.hearth.z + rand(-0.4, 0.4)),
          vel: this.tmpV.set(0, rand(0.9, 1.3), 0), spread: 0.12, life: [4.5, 6.5], size: [0.7, 1.1], grow: 3.2,
          color: '#3a3836', alpha: 0.18, gravity: -0.15,
        });
      }
      for (const b of this.braziers) {
        if (Math.random() < ambientDt * 18) this.flame.emit(1, {
          pos: this.tmp.set(b.x + rand(-0.12, 0.12), b.y, b.z + rand(-0.12, 0.12)),
          vel: this.tmpV.set(0, rand(0.5, 1.0), 0), spread: 0.08, life: [0.35, 0.6], size: [0.25, 0.4],
          color: '#ff9a40', color2: '#7a2a0a', alpha: 0.32, grow: 0.5, gravity: -0.5,
        });
      }
    }
    this.add.update(dt);
    this.streaks.update(dt);
    this.flash.update(dt);
    this.flame.update(ambientDt);
    this.smoke.update(dt);
    this.gore.update(dt);
    this.drops.update(dt);
    this.floorBlood.update(dt);
  }

  sparks(pos: THREE.Vector3, dir: THREE.Vector3 | null, n = 14, color = '#ffd28a') {
    this.add.emit(n, {
      pos, vel: dir ? this.tmpV.copy(dir).multiplyScalar(2.5) : undefined, spread: 2.6, life: [0.15, 0.45], size: [0.015, 0.035],
      color, color2: '#ff6a1a', gravity: 9, drag: 1.5,
    });
  }

  dust(pos: THREE.Vector3, n = 8) {
    this.smoke.emit(n, { pos, spread: 0.8, life: [0.6, 1.2], size: [0.25, 0.45], grow: 2.2, color: '#5d5246', alpha: 0.3, gravity: -0.2, drag: 2 });
  }

  hitPuff(pos: THREE.Vector3, dir: THREE.Vector3, dmg = 20) {
    // flesh hit: a burst of blood off the wound (thrown on along the blade's travel and up out of the wound), a red
    // mist that reads from across the hall, and a puff of cloth fibre
    const n = Math.min(34, 10 + Math.round(dmg / 2));
    const v = this.tmpV.copy(dir).normalize().multiplyScalar(1.9).add(this.tmpV2.set(0, 0.9, 0));
    this.drops.emit(pos, { vel: v, spread: 1.3, n, size: [0.01, 0.026], life: [0.5, 1.0], shade: 0.25 });
    this.mist(pos, dir, 0.6 + Math.min(1, dmg / 40));
    this.smoke.emit(3, { pos, vel: this.tmpV.copy(dir).multiplyScalar(1.0), spread: 0.6, life: [0.3, 0.5], size: [0.1, 0.18], grow: 2, color: '#3a1d17', alpha: 0.3, drag: 3 });
  }

  /** a quick cloud of fine blood droplets: makes a hit read at a distance, gone in half a second */
  mist(pos: THREE.Vector3, dir: THREE.Vector3, k = 1) {
    this.gore.emit(Math.round(5 * k + 2), { pos, vel: this.tmpV.copy(dir).normalize().multiplyScalar(0.7), spread: 0.45, posJitter: 0.03, life: [0.25, 0.5], size: [0.08, 0.15], grow: 2.4, color: '#7d0a07', color2: '#3a0504', alpha: 0.55, gravity: 1.5, drag: 3.5 });
  }

  /** severed limb / stump: stylized arterial spray */
  blood(pos: THREE.Vector3, dir: THREE.Vector3, n = 10) {
    const v = this.tmpV.copy(dir).normalize().multiplyScalar(2.2).add(this.tmpV2.set(0, 1.2, 0));
    this.drops.emit(pos, { vel: v, spread: 1.1, n: Math.round(n * 1.3), size: [0.011, 0.028], life: [0.6, 1.2], shade: 0.15, drag: 0.5 });
    if (n >= 8) this.mist(pos, dir, n / 14);
  }

  /** a directed jet of blood (stab entry / exit, pull-out, an artery) */
  spurt(pos: THREE.Vector3, dir: THREE.Vector3, n = 12, speed = 2.6, spread = 0.45) {
    const v = this.tmpV.copy(dir).normalize().multiplyScalar(speed);
    this.drops.emit(pos, { vel: v, spread, n: Math.round(n * 1.25), size: [0.009, 0.024], life: [0.6, 1.2], shade: 0.1, drag: 0.4 });
    if (n >= 10) this.mist(pos, dir, n / 16);
  }

  /** heavy drops falling off a blade or a wound */
  drip(pos: THREE.Vector3, n = 1) {
    this.drops.emit(pos, { vel: this.tmpV.set(0, -0.3, 0), spread: 0.05, n, size: [0.011, 0.02], life: [1.2, 1.8], posJitter: 0.006, shade: 0.45, drag: 0.1 });
  }

  /** a pool of blood spreading under a body (a floor point; `size` = its final width, m) */
  pool(pos: THREE.Vector3, size = 0.9, growS = 6) { this.floorBlood.pool(pos.x, pos.z, size, growS); }

  /** a new match: the hall floor is scrubbed */
  clearBlood() { this.floorBlood.clear(); this.drops.clear(); }

  explosion(pos: THREE.Vector3) {
    this.flame.emit(40, { pos, spread: 4.5, life: [0.35, 0.8], size: [0.8, 1.6], grow: 1.6, color: '#fff0c0', color2: '#c03a10', alpha: 0.9, drag: 4, gravity: -1.5 });
    this.add.emit(70, { pos, spread: 9, life: [0.4, 1.3], size: [0.03, 0.07], color: '#ffd08a', color2: '#ff4a10', gravity: 7, drag: 1.2 });
    this.smoke.emit(24, { pos, spread: 2.2, life: [1.4, 2.6], size: [0.8, 1.4], grow: 2.4, color: '#1d1916', alpha: 0.5, gravity: -0.6, drag: 1.8 });
  }

  gold(pos: THREE.Vector3, n = 20) {
    this.add.emit(n, { pos, spread: 1.4, life: [0.5, 1.2], size: [0.03, 0.07], color: '#fff1b8', color2: '#c49a4a', gravity: -0.4, drag: 1 });
  }

  trail(pos: THREE.Vector3, color = '#ffc06a', size = 0.03) {
    this.add.emit(1, { pos, spread: 0.05, life: [0.18, 0.32], size: [size * 0.7, size], color, color2: '#a9431a', alpha: 0.8 });
  }

  heal(pos: THREE.Vector3) {
    this.add.emit(30, { pos, spread: 0.6, life: [0.6, 1.2], size: [0.02, 0.05], color: '#cfe8d8', color2: '#6e9c88', gravity: -1.2, drag: 1 });
  }
}
