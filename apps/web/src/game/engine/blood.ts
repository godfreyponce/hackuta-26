// Blood that reads in a dim, firelit hall: flying drops drawn as wet streaks (instanced camera-facing quads stretched
// along their velocity — one draw call), and blood on the floor (splats where drops land, pools spreading under the
// dead — two instanced draw calls). Procedural textures only (no image files).
import * as THREE from 'three';
import { rand } from './math';

/**
 * Blood marks the frame's alpha as it draws: colour blends as usual, but alpha becomes dst·(1 − src). Everything else
 * leaves alpha at 1 (opaque surfaces, and three's normal blending keeps it ≥ 0.75), so after the scene renders
 * 1 − alpha is a blood mask, and the night grade (gradeEffect.ts) keeps blood red instead of greying it.
 */
export function bloodBlend<M extends THREE.Material>(m: M): M {
  m.transparent = true;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return m;
}

// ── flying drops ──────────────────────────────────────────────────────────
const DROP_VERT = /* glsl */ `
  attribute float aSide; attribute float aEnd;
  attribute vec3 iHead; attribute vec3 iVel; attribute vec4 iData; // width, alive, shade, age 0..1
  varying vec2 vUv; varying float vShade; varying float vFade;
  void main() {
    vec3 tailOff = iVel * 0.014;
    float L = length(tailOff);
    if (L > 0.07) { tailOff *= 0.07 / L; L = 0.07; }
    float w = iData.x;
    vec3 dir = L > 1e-4 ? tailOff / L : vec3(0.0, 1.0, 0.0);
    float len = max(L, w * 1.1);
    vec3 head = iHead + dir * w * 0.45;
    vec3 tail = iHead - dir * len;
    vec3 p = mix(head, tail, aEnd);
    vec3 side = normalize(cross(dir, normalize(cameraPosition - p)) + vec3(1e-5, 0.0, 0.0));
    p += side * aSide * w * 0.5 * mix(1.0, 0.5, aEnd);
    vUv = vec2(aSide, aEnd);
    vShade = iData.z;
    vFade = iData.y * (1.0 - smoothstep(0.75, 1.0, iData.w));
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const DROP_FRAG = /* glsl */ `
  uniform vec3 uFresh; uniform vec3 uDark;
  varying vec2 vUv; varying float vShade; varying float vFade;
  void main() {
    if (vFade < 0.01) discard;
    float across = abs(vUv.x);
    float a = smoothstep(1.0, 0.5, across) * smoothstep(0.0, 0.18, vUv.y + 0.04) * smoothstep(1.0, 0.45, vUv.y);
    // a wet drop: dark rim, a lit core and a pin of firelight on it
    vec3 c = mix(uFresh, uDark, vShade * 0.7 + across * 0.5);
    c += vec3(0.1, 0.02, 0.012) * smoothstep(0.3, 0.0, abs(vUv.x + 0.25)) * smoothstep(0.5, 0.1, vUv.y);
    gl_FragColor = vec4(c, a * vFade);
    if (gl_FragColor.a < 0.02) discard;
  }`;

export interface DropOpts {
  /** base velocity (m/s) */
  vel: THREE.Vector3;
  /** velocity jitter (m/s) */
  spread: number;
  n: number;
  /** drop width (m) */
  size: [number, number];
  life?: [number, number];
  posJitter?: number;
  /** 0 bright arterial … 1 dark venous */
  shade?: number;
  drag?: number;
}

export class BloodDrops {
  readonly mesh: THREE.Mesh;
  private cap = 900;
  private head: Float32Array;
  private vel: Float32Array;
  private data: Float32Array;
  private age: Float32Array;
  private max: Float32Array;
  private drag: Float32Array;
  private next = 0;
  private live = 0;
  private iHead: THREE.InstancedBufferAttribute;
  private iVel: THREE.InstancedBufferAttribute;
  private iData: THREE.InstancedBufferAttribute;
  /** a drop hit the floor (x, z, its width) */
  onFloor: ((x: number, z: number, w: number) => void) | null = null;

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute([-1, 1, -1, 1], 1));
    g.setAttribute('aEnd', new THREE.Float32BufferAttribute([0, 0, 1, 1], 1));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    this.head = new Float32Array(this.cap * 3);
    this.vel = new Float32Array(this.cap * 3);
    this.data = new Float32Array(this.cap * 4);
    this.age = new Float32Array(this.cap);
    this.max = new Float32Array(this.cap);
    this.drag = new Float32Array(this.cap);
    this.iHead = new THREE.InstancedBufferAttribute(this.head, 3).setUsage(THREE.DynamicDrawUsage);
    this.iVel = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iHead', this.iHead); g.setAttribute('iVel', this.iVel); g.setAttribute('iData', this.iData);
    g.instanceCount = 0; // nothing drawn until a drop flies
    // unlit, so the colours are what the eye gets before the grade: a deep wet red that still reads in the shadows
    const mat = bloodBlend(new THREE.ShaderMaterial({
      vertexShader: DROP_VERT, fragmentShader: DROP_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uFresh: { value: new THREE.Color(0.3, 0.006, 0.006) }, uDark: { value: new THREE.Color(0.085, 0.002, 0.002) } },
    }));
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'blood-drops';
  }

  emit(pos: THREE.Vector3, o: DropOpts) {
    const pj = o.posJitter ?? 0.01;
    for (let k = 0; k < o.n; k++) {
      const i = this.next; this.next = (this.next + 1) % this.cap;
      this.head[i * 3] = pos.x + rand(-pj, pj); this.head[i * 3 + 1] = pos.y + rand(-pj, pj); this.head[i * 3 + 2] = pos.z + rand(-pj, pj);
      // a few fast and fine, most heavier and slower
      const f = Math.random();
      const sp = 0.55 + f * 0.9;
      this.vel[i * 3] = o.vel.x * sp + rand(-o.spread, o.spread);
      this.vel[i * 3 + 1] = o.vel.y * sp + rand(-o.spread, o.spread);
      this.vel[i * 3 + 2] = o.vel.z * sp + rand(-o.spread, o.spread);
      const w = rand(o.size[0], o.size[1]) * (1.25 - 0.5 * f);
      this.data[i * 4] = w; this.data[i * 4 + 1] = 1; this.data[i * 4 + 2] = Math.min(1, Math.max(0, (o.shade ?? 0.3) + rand(-0.2, 0.2))); this.data[i * 4 + 3] = 0;
      this.age[i] = 0;
      this.max[i] = o.life ? rand(o.life[0], o.life[1]) : rand(0.7, 1.3);
      this.drag[i] = o.drag ?? 0.6;
    }
    this.live = this.cap;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.cap;
  }

  update(dt: number) {
    if (!this.live) return;
    let any = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.data[i * 4 + 1] < 0.5) continue;
      any++;
      this.age[i] += dt;
      if (this.age[i] >= this.max[i]) { this.data[i * 4 + 1] = 0; continue; }
      const o = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[o] *= d; this.vel[o + 2] *= d;
      this.vel[o + 1] = this.vel[o + 1] * d - 9.8 * dt;
      this.head[o] += this.vel[o] * dt; this.head[o + 1] += this.vel[o + 1] * dt; this.head[o + 2] += this.vel[o + 2] * dt;
      if (this.head[o + 1] <= 0.004) {
        // it lands: a splat where it fell (drops of a decent size only)
        this.data[i * 4 + 1] = 0;
        if (this.data[i * 4] > 0.012 && this.onFloor) this.onFloor(this.head[o], this.head[o + 2], this.data[i * 4]);
        continue;
      }
      this.data[i * 4 + 3] = this.age[i] / this.max[i];
    }
    if (!any) { this.live = 0; (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0; }
    this.iHead.needsUpdate = true; this.iVel.needsUpdate = true; this.iData.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.cap; i++) this.data[i * 4 + 1] = 0;
    this.iData.needsUpdate = true;
    this.live = 0;
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
  }
}

// ── blood on the floor ────────────────────────────────────────────────────
function splatTexture(kind: 'splat' | 'pool'): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d')!;
  let seed = kind === 'splat' ? 5 : 19;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  x.translate(S / 2, S / 2);
  const blob = (px: number, py: number, r: number, a: number) => {
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(150,12,8,${a})`); g.addColorStop(0.75, `rgba(120,8,6,${a * 0.95})`); g.addColorStop(1, 'rgba(90,5,4,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
  };
  if (kind === 'splat') {
    blob(0, 0, 46, 1);
    for (let i = 0; i < 9; i++) { const a = rnd() * Math.PI * 2, d = 20 + rnd() * 30; blob(Math.cos(a) * d, Math.sin(a) * d, 14 + rnd() * 16, 0.95); }
    // flung satellite drops and their streaks
    for (let i = 0; i < 22; i++) {
      const a = rnd() * Math.PI * 2, d = 55 + rnd() * 62, r = 2 + rnd() * 6;
      blob(Math.cos(a) * d, Math.sin(a) * d, r * 1.4, 1);
      x.strokeStyle = 'rgba(125,9,6,0.8)'; x.lineWidth = r * 0.7;
      x.beginPath(); x.moveTo(Math.cos(a) * (d - 14), Math.sin(a) * (d - 14)); x.lineTo(Math.cos(a) * d, Math.sin(a) * d); x.stroke();
    }
  } else {
    // a pool: an irregular wet sheet, darker and thicker toward the middle
    for (let i = 0; i < 16; i++) { const a = rnd() * Math.PI * 2, d = rnd() * 48; blob(Math.cos(a) * d, Math.sin(a) * d * 0.85, 52 + rnd() * 36, 1); }
    const g = x.createRadialGradient(0, 0, 0, 0, 0, 80);
    g.addColorStop(0, 'rgba(60,3,2,0.65)'); g.addColorStop(1, 'rgba(60,3,2,0)');
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, 80, 0, Math.PI * 2); x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

interface FloorMark { x: number; z: number; rot: number; size: number; grow: number; born: number; y: number }

class FloorLayer {
  readonly mesh: THREE.InstancedMesh;
  private marks: FloorMark[] = [];
  private next = 0;
  private dirty = false;
  constructor(private cap: number, kind: 'splat' | 'pool', private lift: number) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const map = splatTexture(kind);
    const mat = bloodBlend(new THREE.MeshStandardMaterial({
      map, transparent: true, depthWrite: false, roughness: 0.18, metalness: 0.05, envMapIntensity: 0.6,
      emissive: new THREE.Color(1, 1, 1), emissiveMap: map, emissiveIntensity: 0.1,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    }));
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 1;
    this.mesh.name = `blood-${kind}`;
  }
  add(x: number, z: number, size: number, grow: number, now: number) {
    const m: FloorMark = { x, z, rot: Math.random() * Math.PI * 2, size, grow, born: now, y: this.lift + (this.next % 7) * 0.0004 };
    if (this.marks.length < this.cap) this.marks.push(m); else this.marks[this.next % this.cap] = m;
    this.next++;
    this.dirty = true;
  }
  update(now: number) {
    const m4 = _m4, q = _q, s = _s, p = _p;
    let growing = false;
    for (const m of this.marks) if (m.grow > 0 && now - m.born < m.grow) growing = true;
    if (!growing && !this.dirty) return;
    this.dirty = false;
    this.marks.forEach((m, i) => {
      const k = m.grow > 0 ? Math.min(1, (now - m.born) / m.grow) : 1;
      const e = m.grow > 0 ? 1 - Math.pow(1 - k, 2.2) : 1;
      const sz = Math.max(1e-3, m.size * (m.grow > 0 ? 0.08 + 0.92 * e : 1));
      q.setFromAxisAngle(_Y, m.rot);
      m4.compose(p.set(m.x, m.y, m.z), q, s.set(sz, 1, sz));
      this.mesh.setMatrixAt(i, m4);
    });
    this.mesh.count = this.marks.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.marks.length = 0; this.next = 0; this.mesh.count = 0; this.dirty = false; }
}
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);

export class BloodFloor {
  readonly group = new THREE.Group();
  private splats = new FloorLayer(240, 'splat', 0.003);
  private pools = new FloorLayer(24, 'pool', 0.0025);
  private t = 0;
  private recent = 0;
  constructor() { this.group.add(this.pools.mesh, this.splats.mesh); this.group.name = 'blood-floor'; }
  /** a drop (or a gout) hit the floor */
  splat(x: number, z: number, size: number) {
    if (this.recent > 40) return; // a storm of drops doesn't recycle the whole floor in one second
    this.recent++;
    this.splats.add(x, z, size, 0, this.t);
  }
  /** a pool spreading under a body over `growS` seconds */
  pool(x: number, z: number, size: number, growS: number) { this.pools.add(x, z, size, growS, this.t); }
  update(dt: number) {
    this.t += dt;
    this.recent = Math.max(0, this.recent - dt * 40);
    this.splats.update(this.t);
    this.pools.update(this.t);
  }
  clear() { this.splats.clear(); this.pools.clear(); }
}
