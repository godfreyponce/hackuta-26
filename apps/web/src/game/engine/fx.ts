// CPU-simulated point particles, one draw call per system. Used for hearth fire, embers, sparks,
// Greek-fire explosions, dust and the golden storeroom glow.
import * as THREE from 'three';
import { flameTexture, glowTexture, smokeTexture } from './textures';
import { rand } from './math';

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
export class Fx {
  readonly group = new THREE.Group();
  readonly add: Particles;   // additive: fire, sparks, embers, gold
  readonly flame: Particles; // additive flame sprites
  readonly smoke: Particles; // normal: smoke, dust
  readonly gore: Particles;  // normal: blood droplets
  private emberAcc = 0;
  private flameAcc = 0;
  private tmp = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  hearth: THREE.Vector3 | null = null;
  braziers: THREE.Vector3[] = [];

  constructor() {
    this.add = new Particles(900, glowTexture(), THREE.AdditiveBlending);
    this.flame = new Particles(220, flameTexture(), THREE.AdditiveBlending);
    this.smoke = new Particles(260, smokeTexture(), THREE.NormalBlending);
    this.smoke.points.renderOrder = 4;
    this.gore = new Particles(500, glowTexture(), THREE.NormalBlending);
    this.gore.points.renderOrder = 4;
    this.group.add(this.smoke.points, this.gore.points, this.flame.points, this.add.points);
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
    this.flame.update(ambientDt);
    this.smoke.update(dt);
    this.gore.update(dt);
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
    // flesh hit: dark crimson spray scaled by damage + cloth dust
    const n = Math.min(26, 6 + Math.round(dmg / 3));
    this.gore.emit(n, { pos, vel: this.tmpV.copy(dir).multiplyScalar(1.8), spread: 1.4, life: [0.35, 0.7], size: [0.025, 0.06], color: '#7a1410', color2: '#2a0806', alpha: 0.95, gravity: 9, drag: 1.2 });
    this.smoke.emit(4, { pos, vel: this.tmpV.copy(dir).multiplyScalar(1.0), spread: 0.6, life: [0.3, 0.5], size: [0.1, 0.18], grow: 2, color: '#3a1d17', alpha: 0.35, drag: 3 });
  }

  /** severed limb / stump: stylized arterial spray */
  blood(pos: THREE.Vector3, dir: THREE.Vector3, n = 10) {
    this.gore.emit(n, { pos, vel: this.tmpV.copy(dir).multiplyScalar(2.2).add(this.tmpV2.set(0, 1.2, 0)), spread: 1.1, life: [0.4, 0.9], size: [0.02, 0.055], color: '#8a1712', color2: '#2a0806', alpha: 0.95, gravity: 9.8, drag: 0.8 });
  }

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
