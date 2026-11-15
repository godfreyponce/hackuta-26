// Bronze gauntlets driven by HandState. Local frame: +Y = forward (fingers), +Z = back of hand.
// The left bracer carries a diegetic health inlay (research: wrist-worn health preferred in VR).
import * as THREE from 'three';
import type { Hand } from '@ithaca/shared';
import { RAPIER, GROUPS } from './physics';

const bronze = () => new THREE.MeshStandardMaterial({ color: '#6A5236', metalness: 0.88, roughness: 0.42, transparent: true, opacity: 1 });

export class Gauntlet {
  readonly root = new THREE.Group();
  readonly body: InstanceType<typeof RAPIER.RigidBody>;
  private fingers: { base: THREE.Group; tip: THREE.Group }[] = [];
  private thumb: { base: THREE.Group; tip: THREE.Group };
  private mats: THREE.MeshStandardMaterial[] = [];
  private inlay: THREE.Mesh | null = null;
  private inlayMat: THREE.MeshStandardMaterial | null = null;
  private opacity = 1;
  grip = 0;

  constructor(readonly side: Hand, world: InstanceType<typeof RAPIER.World>) {
    const sx = side === 'right' ? 1 : -1;
    const mat = bronze();
    const matEdge = new THREE.MeshStandardMaterial({ color: '#8A6A40', metalness: 0.95, roughness: 0.3, transparent: true });
    const leather = new THREE.MeshStandardMaterial({ color: '#2e1f14', roughness: 0.9, transparent: true });
    this.mats.push(mat, matEdge, leather);

    const glove = new THREE.MeshStandardMaterial({ color: '#3B2A1D', roughness: 0.82, transparent: true });
    this.mats.push(glove);
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.095, 0.034), glove);
    palm.position.set(0, 0.02, 0);
    this.root.add(palm);
    const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.02, 0.04), matEdge);
    knuckle.position.set(0, 0.07, 0.004);
    this.root.add(knuckle);
    // slim vambrace: in first person a fat bracer near the lens swallows the bottom of the screen
    // closed vambrace (leather end caps) — never an open bore staring at the camera
    const bracer = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.05, 0.2, 10, 1, false), [mat, leather, leather]);
    bracer.position.set(0, -0.135, -0.004);
    this.root.add(bracer);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.008, 5, 14), matEdge);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.set(0, -0.04, -0.004);
    this.root.add(cuff);
    const cuff2 = cuff.clone();
    cuff2.position.y = -0.23;
    this.root.add(cuff2);
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.06, 10), leather);
    wrap.position.set(0, -0.06, -0.004);
    this.root.add(wrap);

    const segGeo = new THREE.BoxGeometry(0.019, 0.042, 0.021);
    segGeo.translate(0, 0.021, 0);
    for (let i = 0; i < 4; i++) {
      const base = new THREE.Group();
      base.position.set((i - 1.5) * 0.022, 0.07, 0);
      const s1 = new THREE.Mesh(segGeo, glove);
      base.add(s1);
      const tip = new THREE.Group();
      tip.position.y = 0.042;
      const s2 = new THREE.Mesh(segGeo, glove);
      s2.scale.set(0.92, 0.8, 0.92);
      tip.add(s2);
      base.add(tip);
      this.root.add(base);
      this.fingers.push({ base, tip });
    }
    const tb = new THREE.Group();
    tb.position.set(-0.046 * sx, 0.0, -0.008);
    tb.rotation.z = 0.7 * sx;
    tb.add(new THREE.Mesh(segGeo, glove));
    const tt = new THREE.Group();
    tt.position.y = 0.042;
    tt.add(new THREE.Mesh(segGeo, glove));
    tb.add(tt);
    this.root.add(tb);
    this.thumb = { base: tb, tip: tt };

    if (side === 'left') {
      this.inlayMat = new THREE.MeshStandardMaterial({ color: '#3a1a0a', emissive: '#ffb25a', emissiveIntensity: 1.6, transparent: true });
      this.inlay = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.15, 0.008), this.inlayMat);
      this.inlay.position.set(0, -0.12, 0.052);
      this.root.add(this.inlay);
      this.mats.push(this.inlayMat);
    }
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).renderOrder = 2; });

    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1.3, -0.4));
    world.createCollider(RAPIER.ColliderDesc.ball(0.065).setCollisionGroups(GROUPS.held), this.body);
  }

  setHealth(h01: number) {
    if (!this.inlay || !this.inlayMat) return;
    const k = Math.max(0.02, h01);
    this.inlay.scale.y = k;
    this.inlay.position.y = -0.195 + 0.075 * k;
    this.inlayMat.emissive.set(h01 < 0.35 ? '#ff3a22' : '#ffb25a');
  }

  update(pos: THREE.Vector3, quat: THREE.Quaternion, grip: number, visible: boolean, holding: boolean, dt: number) {
    if (visible) {
      this.root.position.copy(pos);
      this.root.quaternion.copy(quat);
      this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    }
    const target = visible ? 1 : 0.3;
    this.opacity += (target - this.opacity) * (1 - Math.exp(-8 * dt));
    for (const m of this.mats) m.opacity = this.opacity;
    // fingers curl toward the palm (−Z); a held weapon caps the curl
    this.grip += (grip - this.grip) * (1 - Math.exp(-20 * dt));
    const g = holding ? Math.min(this.grip, 0.75) : this.grip;
    for (const f of this.fingers) { f.base.rotation.x = -g * 1.35; f.tip.rotation.x = -g * 1.5; }
    this.thumb.base.rotation.x = -g * 0.9;
    this.thumb.tip.rotation.x = -g * 0.8;
  }
}
