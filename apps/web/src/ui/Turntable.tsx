import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponClass } from '@ithaca/shared';
import { PREFAB_BUILDERS } from '../game/engine/weaponGeo';

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

function load(url: string): Promise<THREE.Object3D> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 9000);
      loader.load(url, (g) => { clearTimeout(t); res(g.scene); }, undefined, (e) => { clearTimeout(t); rej(e); });
    });
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p.then((o) => o.clone(true));
}

function Model({ url, cls, speed }: { url: string; cls: WeaponClass; speed: number }) {
  const [obj, setObj] = useState<THREE.Object3D | null>(null);
  const spin = useRef<THREE.Group>(null);
  useEffect(() => {
    let alive = true;
    load(url).catch(() => load(`/prefabs/${cls}.glb`)).catch(() => PREFAB_BUILDERS[cls]()).then((o) => {
      if (!alive) return;
      const box = new THREE.Box3().setFromObject(o);
      const size = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      const s = 1.6 / (Math.max(size.x, size.y, size.z) || 1);
      const g = new THREE.Group();
      o.position.sub(c);
      g.add(o);
      g.scale.setScalar(s);
      setObj(g);
    });
    return () => { alive = false; };
  }, [url, cls]);
  useFrame((_, dt) => { if (spin.current) spin.current.rotation.y += dt * speed; });
  // start three-quarter on (35°), not edge-on
  return <group ref={spin} rotation={[0, 0.61, 0]}>{obj && <primitive object={obj} />}</group>;
}

/** Soft studio reflections so bronze/steel read as metal instead of black. */
function Env() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const tex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = tex;
    scene.environmentIntensity = 0.55;
    return () => { scene.environment = null; tex.dispose(); pm.dispose(); };
  }, [gl, scene]);
  return null;
}

/** Small turntable for a forged weapon (forge overlay + armory display case). */
export function Turntable({ url, cls, speed = 1.1 }: { url: string; cls: WeaponClass; speed?: number }) {
  const env = useMemo(() => new THREE.Color('#0a0806'), []);
  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0.35, 2.6], fov: 38 }} gl={{ antialias: true, alpha: true }} style={{ position: 'absolute', inset: 0 }}>
      <color attach="background" args={[env]} />
      <ambientLight intensity={1.4} color="#b8c8dc" />
      <spotLight position={[0.6, 2.4, 2.2]} angle={0.6} penumbra={0.6} intensity={40} color="#ffe2b0" />
      <pointLight position={[1.6, 1.8, 2]} intensity={28} color="#ffb060" />
      <Env />
      <directionalLight position={[0, 3, 2]} intensity={1.6} color="#ffe2b0" />
      <directionalLight position={[-1.6, 1.2, 3]} intensity={2.4} color="#fff1dc" />
      <pointLight position={[-2, 0.5, -1.5]} intensity={6} color="#5d7aa0" />
      <hemisphereLight args={['#3a2a1a', '#0a0806', 0.6]} />
      <Suspense fallback={null}>
        <Model url={url} cls={cls} speed={speed} />
      </Suspense>
    </Canvas>
  );
}
