// Blade trails (research: player trail when the tip moves > 3 m/s, fade ~150 ms; enemy blades trail
// during their active strike frames). One additive triangle strip per trail.
import * as THREE from 'three';

const N = 24; // samples kept per trail (3 interpolated per frame so fast arcs stay round)

const VERT = /* glsl */ `
  attribute float aAlpha;
  varying float vAlpha;
  varying float vEdge;
  attribute float aEdge;
  void main() {
    vAlpha = aAlpha;
    vEdge = aEdge;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  varying float vAlpha;
  varying float vEdge;
  void main() {
    vec3 c = mix(uColor, uCore, vEdge * vEdge);
    gl_FragColor = vec4(c, vAlpha * (0.25 + 0.75 * vEdge));
  }
`;

class Trail {
  readonly mesh: THREE.Mesh;
  private base: THREE.Vector3[] = [];
  private tip: THREE.Vector3[] = [];
  private age: number[] = [];
  private pos: Float32Array;
  private alpha: Float32Array;
  private geo: THREE.BufferGeometry;

  constructor(color: string, core: string) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 2 * 3);
    this.alpha = new Float32Array(N * 2);
    const edge = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { edge[i * 2] = 0; edge[i * 2 + 1] = 1; }
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uColor: { value: new THREE.Color(color) }, uCore: { value: new THREE.Color(core) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  /** Push a sample if active; age everything; rebuild the strip. */
  update(base: THREE.Vector3 | null, tip: THREE.Vector3 | null, active: boolean, dt: number, life = 0.15) {
    for (let i = 0; i < this.age.length; i++) this.age[i] += dt;
    if (active && base && tip) {
      const pb = this.base[0], pt = this.tip[0];
      if (pb && pt && this.age[0] < dt * 1.5) {
        for (const k of [1 / 3, 2 / 3]) { this.base.unshift(pb.clone().lerp(base, k)); this.tip.unshift(pt.clone().lerp(tip, k)); this.age.unshift(dt * (1 - k)); }
      }
      this.base.unshift(base.clone()); this.tip.unshift(tip.clone()); this.age.unshift(0);
      while (this.base.length > N) { this.base.pop(); this.tip.pop(); this.age.pop(); }
    }
    while (this.age.length && this.age[this.age.length - 1] > life) { this.base.pop(); this.tip.pop(); this.age.pop(); }
    const n = this.base.length;
    for (let i = 0; i < N; i++) {
      const j = Math.min(i, Math.max(0, n - 1));
      const b = this.base[j], t = this.tip[j];
      if (!b || !t || n < 2) { this.alpha[i * 2] = this.alpha[i * 2 + 1] = 0; continue; }
      // trail hugs the outer 60% of the blade
      this.pos.set([b.x + (t.x - b.x) * 0.4, b.y + (t.y - b.y) * 0.4, b.z + (t.z - b.z) * 0.4], i * 6);
      this.pos.set([t.x, t.y, t.z], i * 6 + 3);
      const a = i < n ? Math.max(0, 1 - this.age[j] / life) * (1 - i / N) : 0;
      this.alpha[i * 2] = a; this.alpha[i * 2 + 1] = a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

export class Trails {
  readonly group = new THREE.Group();
  private player: Record<'left' | 'right', Trail>;
  private enemy: Trail[] = [];
  constructor() {
    this.player = { left: new Trail('#c49a4a', '#fff1d0'), right: new Trail('#c49a4a', '#fff1d0') };
    this.group.add(this.player.left.mesh, this.player.right.mesh);
    for (let i = 0; i < 3; i++) { const t = new Trail('#a8321f', '#ffd28a'); this.enemy.push(t); this.group.add(t.mesh); }
  }
  updatePlayer(side: 'left' | 'right', base: THREE.Vector3 | null, tip: THREE.Vector3 | null, speed: number, dt: number) {
    this.player[side].update(base, tip, speed > 2.5, dt, 0.1 + 0.08 * Math.min(1, Math.max(0, (speed - 3) / 7)));
  }
  updateEnemies(list: { base: THREE.Vector3; tip: THREE.Vector3 }[], dt: number) {
    for (let i = 0; i < this.enemy.length; i++) {
      const s = list[i];
      this.enemy[i].update(s?.base ?? null, s?.tip ?? null, !!s, dt, 0.18);
    }
  }
}
