// The Hall of Odysseus — a Mycenaean megaron: round central hearth, red down-tapering columns,
// fresco bands, clerestory windows, smoke-hole moonlight, feast tables, two far doors and the
// storeroom door Telemachus runs to. ~30 m × 12 m. Player stands at z≈0 looking down −Z.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, GROUPS } from './physics';
import { columnTexture, floorTexture, wallTexture, woodTexture } from './textures';
import { LIGHT } from '../../theme';
import { buildAspis } from './weaponGeo';

export const HALL = {
  halfWidth: 6,
  zNear: 3,
  zFar: -27,
  height: 7.2,
  hearth: new THREE.Vector3(0, 0, -13),
  hearthRadius: 1.45,
  doors: [new THREE.Vector3(-2.6, 0, -26.4), new THREE.Vector3(2.6, 0, -26.4)],
  storeroom: new THREE.Vector3(5.9, 1.2, -7.5),
  eye: new THREE.Vector3(0, 1.65, 0),
  columnX: 3.25,
  columnZ: [-4.2, -8.6, -13, -17.4, -21.8],
  rackZ: -0.9,
  rackTop: 1.12,
};

export interface HallRig {
  group: THREE.Group;
  staticHandles: Set<number>;
  hearthLight: THREE.PointLight;
  storeroomLight: THREE.PointLight;
  storeroomDoor: THREE.Object3D;
  moonShaft: THREE.Mesh;
  windowMat: THREE.MeshStandardMaterial;
  flickers: { light: THREE.PointLight; base: number; seed: number; rate: number }[];
  update(t: number, dt: number): void;
  setStoreroomGlow(v: number): void;
  dispose(): void;
}

function addStaticCuboid(world: InstanceType<typeof RAPIER.World>, set: Set<number>, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotY = 0) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz)
    .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY)));
  const col = world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setCollisionGroups(GROUPS.static).setFriction(0.8).setRestitution(0.15), body);
  set.add(col.handle);
}

export function buildHall(world: InstanceType<typeof RAPIER.World> | null): HallRig {
  const group = new THREE.Group();
  group.name = 'hall';
  const staticHandles = new Set<number>();
  const W = HALL.halfWidth, H = HALL.height;
  const len = HALL.zNear - HALL.zFar;
  const zMid = (HALL.zNear + HALL.zFar) / 2;

  // ── materials ──
  const floorMat = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.92, metalness: 0, color: '#9a8f80' });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.95, color: '#a69a88' });
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.85, color: '#8a7a68' });
  const beamMat = new THREE.MeshStandardMaterial({ color: '#17120e', roughness: 0.9 });
  const colMat = new THREE.MeshStandardMaterial({ map: columnTexture(), roughness: 0.8, color: '#b0a090' });
  const capMat = new THREE.MeshStandardMaterial({ color: '#15110e', roughness: 0.7 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#4c443a', roughness: 0.95 });
  const hearthMat = new THREE.MeshStandardMaterial({ color: '#6b3b26', roughness: 0.9 });
  const hearthRim = new THREE.MeshStandardMaterial({ color: '#a2643a', roughness: 0.8 });
  const windowMat = new THREE.MeshStandardMaterial({ color: '#0d1420', emissive: '#3c566e', emissiveIntensity: 0.55 });
  const doorVoidMat = new THREE.MeshBasicMaterial({ color: '#0a0f17' });

  // ── floor / walls / ceiling ──
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, len), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, zMid);
  floor.receiveShadow = true;
  group.add(floor);

  const wallGeo: THREE.BufferGeometry[] = [];
  const side = new THREE.PlaneGeometry(len, H);
  const left = side.clone(); left.rotateY(Math.PI / 2); left.translate(-W, H / 2, zMid); wallGeo.push(left);
  const right = side.clone(); right.rotateY(-Math.PI / 2); right.translate(W, H / 2, zMid); wallGeo.push(right);
  const end = new THREE.PlaneGeometry(W * 2, H);
  const far = end.clone(); far.translate(0, H / 2, HALL.zFar); wallGeo.push(far);
  const near = end.clone(); near.rotateY(Math.PI); near.translate(0, H / 2, HALL.zNear); wallGeo.push(near);
  const walls = new THREE.Mesh(mergeGeometries(wallGeo), wallMat);
  walls.receiveShadow = true;
  group.add(walls);

  // ceiling with beams (dark, sooty)
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, len), beamMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, H, zMid);
  group.add(ceiling);
  const beams: THREE.BufferGeometry[] = [];
  for (let z = HALL.zNear - 1.5; z > HALL.zFar; z -= 2.2) {
    const b = new THREE.BoxGeometry(W * 2, 0.32, 0.28); b.translate(0, H - 0.16, z); beams.push(b);
  }
  for (const x of [-HALL.columnX, HALL.columnX]) {
    const b = new THREE.BoxGeometry(0.4, 0.45, len); b.translate(x, H - 0.6, zMid); beams.push(b);
  }
  group.add(new THREE.Mesh(mergeGeometries(beams), beamMat));

  // clerestory windows (high, moonlit)
  const winGeo: THREE.BufferGeometry[] = [];
  for (let z = -3; z > HALL.zFar + 2; z -= 4.6) {
    for (const sx of [-1, 1]) {
      const g = new THREE.PlaneGeometry(1.1, 0.8);
      g.rotateY(sx < 0 ? Math.PI / 2 : -Math.PI / 2);
      g.translate(sx * (W - 0.02), H - 1.6, z);
      winGeo.push(g);
    }
  }
  group.add(new THREE.Mesh(mergeGeometries(winGeo), windowMat));

  // ── columns (instanced: shaft, capital, base) ──
  const colPositions: THREE.Vector3[] = [];
  for (const z of HALL.columnZ) for (const x of [-HALL.columnX, HALL.columnX]) colPositions.push(new THREE.Vector3(x, 0, z));
  const colH = H - 0.85;
  const shaftGeo = new THREE.CylinderGeometry(0.4, 0.3, colH, 14); // Minoan/Mycenaean: wider at the top
  shaftGeo.translate(0, colH / 2 + 0.2, 0);
  const capGeo = mergeGeometries([
    (() => { const g = new THREE.CylinderGeometry(0.58, 0.44, 0.32, 14); g.translate(0, colH + 0.36, 0); return g; })(),
    (() => { const g = new THREE.BoxGeometry(1.0, 0.18, 1.0); g.translate(0, colH + 0.6, 0); return g; })(),
  ]);
  const baseGeo = new THREE.CylinderGeometry(0.46, 0.5, 0.2, 14); baseGeo.translate(0, 0.1, 0);
  const shafts = new THREE.InstancedMesh(shaftGeo, colMat, colPositions.length);
  const caps = new THREE.InstancedMesh(capGeo, capMat, colPositions.length);
  const bases = new THREE.InstancedMesh(baseGeo, stoneMat, colPositions.length);
  const m = new THREE.Matrix4();
  colPositions.forEach((p, i) => {
    m.makeTranslation(p.x, 0, p.z);
    shafts.setMatrixAt(i, m); caps.setMatrixAt(i, m); bases.setMatrixAt(i, m);
  });
  shafts.castShadow = true; shafts.receiveShadow = true;
  caps.castShadow = false;
  group.add(shafts, caps, bases);

  // ── hearth ──
  const hearth = new THREE.Mesh(new THREE.CylinderGeometry(HALL.hearthRadius, HALL.hearthRadius + 0.08, 0.32, 28), hearthMat);
  hearth.position.set(HALL.hearth.x, 0.16, HALL.hearth.z);
  hearth.receiveShadow = true;
  group.add(hearth);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(HALL.hearthRadius - 0.02, 0.07, 6, 32), hearthRim);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(HALL.hearth.x, 0.33, HALL.hearth.z);
  group.add(rim);
  const coals = new THREE.Mesh(new THREE.CircleGeometry(HALL.hearthRadius - 0.15, 24),
    new THREE.MeshStandardMaterial({ color: '#1a0c06', emissive: '#ff5a1a', emissiveIntensity: 1.4 }));
  coals.rotation.x = -Math.PI / 2;
  coals.position.set(HALL.hearth.x, 0.335, HALL.hearth.z);
  group.add(coals);

  // moonlight shaft through the smoke-hole (additive, no light cost)
  const shaftMat = new THREE.MeshBasicMaterial({ color: '#5d7aa0', transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const moonShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.9, H, 20, 1, true), shaftMat);
  moonShaft.position.set(HALL.hearth.x + 0.5, H / 2, HALL.hearth.z - 0.4);
  moonShaft.rotation.z = 0.08;
  group.add(moonShaft);

  // ── feast tables & benches ──
  const tableGeo: THREE.BufferGeometry[] = [];
  const benchGeo: THREE.BufferGeometry[] = [];
  const tables: { x: number; z: number; len: number }[] = [
    { x: -4.75, z: -8.6, len: 7.2 }, { x: -4.75, z: -18.6, len: 7.2 },
    { x: 4.75, z: -12.8, len: 6.4 }, { x: 4.75, z: -21.5, len: 5.2 },
  ];
  for (const t of tables) {
    const top = new THREE.BoxGeometry(1.0, 0.08, t.len); top.translate(t.x, 0.82, t.z); tableGeo.push(top);
    for (const dz of [-t.len / 2 + 0.3, t.len / 2 - 0.3]) for (const dx of [-0.38, 0.38]) {
      const leg = new THREE.BoxGeometry(0.1, 0.8, 0.1); leg.translate(t.x + dx, 0.4, t.z + dz); tableGeo.push(leg);
    }
    const bx = t.x + (t.x < 0 ? 0.85 : -0.85);
    const bench = new THREE.BoxGeometry(0.36, 0.08, t.len - 0.4); bench.translate(bx, 0.46, t.z); benchGeo.push(bench);
    for (const dz of [-t.len / 2 + 0.5, t.len / 2 - 0.5]) {
      const leg = new THREE.BoxGeometry(0.3, 0.44, 0.08); leg.translate(bx, 0.22, t.z + dz); benchGeo.push(leg);
    }
    if (world) {
      addStaticCuboid(world, staticHandles, t.x, 0.82, t.z, 0.5, 0.04, t.len / 2);
      addStaticCuboid(world, staticHandles, t.x, 0.4, t.z, 0.4, 0.4, t.len / 2 - 0.3);
    }
  }
  const tableMesh = new THREE.Mesh(mergeGeometries(tableGeo), woodMat);
  tableMesh.castShadow = true; tableMesh.receiveShadow = true;
  group.add(tableMesh);
  group.add(new THREE.Mesh(mergeGeometries(benchGeo), woodMat));

  // feast clutter: kylikes, bread, platters (instanced)
  const cupGeo = new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.03, 0), new THREE.Vector2(0.012, 0.03), new THREE.Vector2(0.012, 0.06), new THREE.Vector2(0.08, 0.08), new THREE.Vector2(0.085, 0.09)], 10);
  const cups = new THREE.InstancedMesh(cupGeo, new THREE.MeshStandardMaterial({ color: '#C49A4A', metalness: 1, roughness: 0.3 }), 40);
  const breadGeo = new THREE.SphereGeometry(0.1, 7, 5); breadGeo.scale(1.3, 0.55, 1);
  const breads = new THREE.InstancedMesh(breadGeo, new THREE.MeshStandardMaterial({ color: '#8a5a2c', roughness: 0.9 }), 24);
  let ci = 0, bi = 0;
  const q = new THREE.Quaternion();
  for (const t of tables) {
    for (let z = t.z - t.len / 2 + 0.4; z < t.z + t.len / 2 - 0.3; z += 0.55) {
      const tipped = Math.random() < 0.25;
      q.setFromEuler(new THREE.Euler(tipped ? Math.PI / 2 : 0, Math.random() * 6, 0));
      if (ci < 40) cups.setMatrixAt(ci++, m.compose(new THREE.Vector3(t.x + (Math.random() - 0.5) * 0.6, tipped ? 0.94 : 0.86, z), q, new THREE.Vector3(1, 1, 1)));
      if (bi < 24 && Math.random() < 0.5) breads.setMatrixAt(bi++, m.compose(new THREE.Vector3(t.x + (Math.random() - 0.5) * 0.5, 0.88, z + 0.2), q.identity(), new THREE.Vector3(1, 1, 1)));
    }
  }
  cups.count = ci; breads.count = bi;
  group.add(cups, breads);

  // ── shields hung on the walls (instanced bronze aspides) ──
  const aspis = buildAspis(0.8);
  const shieldGeos: THREE.BufferGeometry[] = [];
  aspis.updateMatrixWorld(true);
  aspis.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const g = (o as THREE.Mesh).geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      // keep only position/normal so different primitive types merge
      for (const key of Object.keys(g.attributes)) if (key !== 'position' && key !== 'normal') g.deleteAttribute(key);
      shieldGeos.push(g.index ? g.toNonIndexed() : g);
    }
  });
  const shieldGeo = mergeGeometries(shieldGeos);
  shieldGeo.rotateX(Math.PI / 2); // face +Z
  const wallShields = new THREE.InstancedMesh(shieldGeo, new THREE.MeshStandardMaterial({ color: '#7d5e38', metalness: 0.9, roughness: 0.4 }), 16);
  let si = 0;
  for (let z = -2.8; z > HALL.zFar + 2; z -= 3.3) {
    for (const sx of [-1, 1]) {
      if (sx > 0 && Math.abs(z - HALL.storeroom.z) < 1.6) continue;
      if (si >= 16) break;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sx < 0 ? Math.PI / 2 : -Math.PI / 2);
      wallShields.setMatrixAt(si++, m.compose(new THREE.Vector3(sx * (W - 0.06), 3.1, z), q, new THREE.Vector3(1, 1, 1)));
    }
  }
  wallShields.count = si;
  group.add(wallShields);

  // ── far doors (to the courtyard) ──
  const lintelGeo: THREE.BufferGeometry[] = [];
  for (const d of HALL.doors) {
    const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 3.0), doorVoidMat);
    voidPlane.position.set(d.x, 1.5, HALL.zFar + 0.03);
    group.add(voidPlane);
    const l = new THREE.BoxGeometry(2.4, 0.4, 0.5); l.translate(d.x, 3.2, HALL.zFar + 0.2); lintelGeo.push(l);
    for (const sx of [-1, 1]) { const j = new THREE.BoxGeometry(0.3, 3.2, 0.5); j.translate(d.x + sx * 1.05, 1.6, HALL.zFar + 0.2); lintelGeo.push(j); }
  }
  // the great threshold where Odysseus stands (stone step behind the player)
  const thr = new THREE.BoxGeometry(W * 2, 0.12, 1.6); thr.translate(0, 0.06, 1.6); lintelGeo.push(thr);
  group.add(new THREE.Mesh(mergeGeometries(lintelGeo), stoneMat));

  // ── storeroom door (right wall, near the player) ──
  const sr = HALL.storeroom;
  const frame = new THREE.Mesh(mergeGeometries([
    (() => { const g = new THREE.BoxGeometry(0.5, 0.35, 1.9); g.translate(0, 2.55, 0); return g; })(),
    (() => { const g = new THREE.BoxGeometry(0.5, 2.6, 0.25); g.translate(0, 1.3, -0.82); return g; })(),
    (() => { const g = new THREE.BoxGeometry(0.5, 2.6, 0.25); g.translate(0, 1.3, 0.82); return g; })(),
  ]), stoneMat);
  frame.position.set(W - 0.2, 0, sr.z);
  group.add(frame);
  const srGlowMat = new THREE.MeshBasicMaterial({ color: '#ffb54a', transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false });
  const srGlow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.35), srGlowMat);
  srGlow.rotation.y = -Math.PI / 2;
  srGlow.position.set(W - 0.05, 1.18, sr.z);
  group.add(srGlow);
  const doorPivot = new THREE.Group();
  doorPivot.position.set(W - 0.12, 0, sr.z - 0.7);
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.3, 1.4), woodMat);
  leaf.position.set(0, 1.15, 0.7);
  leaf.castShadow = false;
  doorPivot.add(leaf);
  group.add(doorPivot);

  // ── weapon rack in front of the player ──
  const rackGeo: THREE.BufferGeometry[] = [];
  const rz = HALL.rackZ, rt = HALL.rackTop;
  const top = new THREE.BoxGeometry(1.5, 0.08, 0.38); top.translate(0.05, rt, rz); rackGeo.push(top);
  for (const dx of [-0.62, 0.72]) { const l = new THREE.BoxGeometry(0.08, rt, 0.3); l.translate(dx, rt / 2, rz); rackGeo.push(l); }
  const peg = new THREE.BoxGeometry(0.06, 0.5, 0.06); peg.translate(-0.55, rt + 0.25, rz - 0.1); rackGeo.push(peg);
  const ring = new THREE.TorusGeometry(0.05, 0.012, 5, 12); ring.rotateX(Math.PI / 2); ring.translate(0.55, rt + 0.04, rz); rackGeo.push(ring);
  const rack = new THREE.Mesh(mergeGeometries(rackGeo.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); return g; })), woodMat);
  rack.castShadow = false; rack.receiveShadow = true;
  group.add(rack);

  // ── lights ──
  const hemi = new THREE.HemisphereLight(LIGHT.ambientSky, LIGHT.ambientGround, 0.6);
  group.add(hemi);
  const moon = new THREE.DirectionalLight(LIGHT.moon, 0.55);
  moon.position.set(3, 14, -10);
  moon.target.position.set(0, 0, -13);
  group.add(moon, moon.target);

  const hearthLight = new THREE.PointLight(LIGHT.hearth, 170, 0, 2);
  hearthLight.position.set(HALL.hearth.x, 1.6, HALL.hearth.z);
  hearthLight.castShadow = true;
  hearthLight.shadow.mapSize.set(512, 512);
  hearthLight.shadow.bias = -0.004;
  hearthLight.shadow.camera.near = 0.3;
  hearthLight.shadow.camera.far = 22;
  group.add(hearthLight);

  const flickers: HallRig['flickers'] = [{ light: hearthLight, base: 170, seed: 1.3, rate: 5.5 }];
  const mkLight = (color: string, intensity: number, x: number, y: number, z: number, rate = 6) => {
    const l = new THREE.PointLight(color, intensity, 0, 2);
    l.position.set(x, y, z);
    group.add(l);
    flickers.push({ light: l, base: intensity, seed: Math.random() * 10, rate });
    return l;
  };
  for (const d of HALL.doors) mkLight(LIGHT.brazier, 38, d.x * 1.55, 1.6, HALL.zFar + 1.4, 7);
  mkLight(LIGHT.brazier, 26, -W + 0.4, 2.4, -6.4, 6);
  mkLight(LIGHT.brazier, 26, W - 0.4, 2.4, -19.5, 6.5);
  mkLight(LIGHT.brazier, 9, -1.5, 1.7, -1.4, 4.5); // tripod brazier by the player
  const storeroomLight = new THREE.PointLight('#ffc66a', 0, 0, 2);
  storeroomLight.position.set(W - 0.8, 1.6, sr.z);
  group.add(storeroomLight);

  // tripod brazier mesh by the player + door braziers
  const brazierGeo: THREE.BufferGeometry[] = [];
  const mkBrazier = (x: number, z: number, s = 1) => {
    const bowl = new THREE.CylinderGeometry(0.28 * s, 0.14 * s, 0.18 * s, 10); bowl.translate(x, 1.12 * s, z); brazierGeo.push(bowl.toNonIndexed());
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leg = new THREE.CylinderGeometry(0.018 * s, 0.018 * s, 1.1 * s, 4);
      leg.rotateZ(0.12); leg.rotateY(a);
      leg.translate(x + Math.cos(a) * 0.12 * s, 0.55 * s, z + Math.sin(a) * 0.12 * s);
      brazierGeo.push(leg.toNonIndexed());
    }
  };
  mkBrazier(-1.5, -1.4, 0.95);
  for (const d of HALL.doors) mkBrazier(d.x * 1.55, HALL.zFar + 1.4, 1);
  brazierGeo.forEach((g) => { for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k); });
  group.add(new THREE.Mesh(mergeGeometries(brazierGeo), new THREE.MeshStandardMaterial({ color: '#6a5232', metalness: 0.9, roughness: 0.45 })));

  // ── physics colliders ──
  if (world) {
    addStaticCuboid(world, staticHandles, 0, -0.5, zMid, W, 0.5, len / 2);           // floor
    addStaticCuboid(world, staticHandles, 0, H + 0.5, zMid, W, 0.5, len / 2);         // ceiling
    addStaticCuboid(world, staticHandles, -W - 0.5, H / 2, zMid, 0.5, H / 2, len / 2); // walls
    addStaticCuboid(world, staticHandles, W + 0.5, H / 2, zMid, 0.5, H / 2, len / 2);
    addStaticCuboid(world, staticHandles, 0, H / 2, HALL.zFar - 0.5, W, H / 2, 0.5);
    addStaticCuboid(world, staticHandles, 0, H / 2, HALL.zNear + 0.5, W, H / 2, 0.5);
    addStaticCuboid(world, staticHandles, 0.05, HALL.rackTop / 2, HALL.rackZ, 0.75, HALL.rackTop / 2, 0.19); // rack
    for (const p of colPositions) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, colH / 2 + 0.2, p.z));
      const col = world.createCollider(RAPIER.ColliderDesc.cylinder(colH / 2, 0.36).setCollisionGroups(GROUPS.static).setFriction(0.9), body);
      staticHandles.add(col.handle);
    }
    const hb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(HALL.hearth.x, 0.16, HALL.hearth.z));
    staticHandles.add(world.createCollider(RAPIER.ColliderDesc.cylinder(0.16, HALL.hearthRadius).setCollisionGroups(GROUPS.static), hb).handle);
  }

  let srGlow01 = 0;
  const rig: HallRig = {
    group, staticHandles, hearthLight, storeroomLight, storeroomDoor: doorPivot, moonShaft, windowMat, flickers,
    update(t, dt) {
      for (const f of flickers) {
        // layered noise at 3–8 Hz, ±20%
        const n = Math.sin(t * f.rate + f.seed) * 0.5 + Math.sin(t * f.rate * 1.73 + f.seed * 2.1) * 0.3 + Math.sin(t * f.rate * 3.1 + f.seed * 0.7) * 0.2;
        f.light.intensity = f.base * (1 + n * 0.2);
      }
      shaftMat.opacity = 0.06 + Math.sin(t * 0.3) * 0.012;
      // storeroom door: swings open with the glow, then eases shut
      doorPivot.rotation.y = THREE.MathUtils.lerp(doorPivot.rotation.y, -srGlow01 * 1.6, 1 - Math.exp(-10 * dt));
      srGlowMat.opacity = srGlow01 * 0.85;
      storeroomLight.intensity = srGlow01 * 40;
      srGlow01 = Math.max(0, srGlow01 - dt * 0.35);
    },
    setStoreroomGlow(v) { srGlow01 = Math.max(srGlow01, v); },
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[];
          (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
        }
      });
    },
  };
  return rig;
}
