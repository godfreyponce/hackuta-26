import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { BloomEffect, ChromaticAberrationEffect, EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { Engine } from './engine/Engine';
import { GradeEffect } from './gradeEffect';
import { engineCallbacks, runtime } from './runtime';
import { LIGHT } from '../theme';
import { useApp } from '../state/store';

const params = new URLSearchParams(location.search);
const SHADOWS = params.get('shadows') !== '0';
const PERF = params.get('perf') === '1';
const perfAcc = { frames: 0, t: 0, calls: 0, tris: 0 };
let shadowFrame = 0;

/** Firelit environment for bronze reflections (procedural, no HDRI download). */
function makeEnvironment(gl: THREE.WebGLRenderer) {
  const env = new THREE.Scene();
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.MeshBasicMaterial({ color: '#120d09', side: THREE.BackSide }));
  env.add(sphere);
  const fire = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff8a3a').multiplyScalar(3) }));
  fire.position.set(0, -2, -7);
  env.add(fire);
  const fire2 = fire.clone();
  fire2.scale.setScalar(0.6);
  fire2.position.set(-5, -1, 3);
  env.add(fire2);
  const moon = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.2), new THREE.MeshBasicMaterial({ color: new THREE.Color('#5d7aa0').multiplyScalar(1.4), side: THREE.DoubleSide }));
  moon.position.set(0, 9, -2);
  moon.rotation.x = Math.PI / 2;
  env.add(moon);
  const pmrem = new THREE.PMREMGenerator(gl);
  const tex = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  return tex;
}

function EngineMount({ onReady }: { onReady: (e: Engine) => void }) {
  const { scene, camera, gl, size } = useThree();
  const engineRef = useRef<Engine | null>(null);
  const composerRef = useRef<EffectComposer | null>(null);
  const fx = useRef<{ grade: GradeEffect; chroma: ChromaticAberrationEffect } | null>(null);

  useEffect(() => {
    let disposed = false;
    scene.background = new THREE.Color('#0b0907');
    scene.fog = new THREE.FogExp2(LIGHT.fog, 0.028);
    scene.environment = makeEnvironment(gl);
    (scene as THREE.Scene & { environmentIntensity?: number }).environmentIntensity = 0.55;
    gl.toneMapping = THREE.NoToneMapping;
    gl.shadowMap.enabled = SHADOWS;
    gl.shadowMap.type = THREE.PCFShadowMap;
    gl.shadowMap.autoUpdate = false; // hearth shadow cube refreshed every 3rd frame (6 passes each)
    runtime.canvas = gl.domElement;

    const composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new BloomEffect({ luminanceThreshold: 0.82, luminanceSmoothing: 0.25, intensity: 0.55, mipmapBlur: true, radius: 0.7 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    const grade = new GradeEffect();
    const chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0, 0), radialModulation: true, modulationOffset: 0.2 });
    composer.addPass(new EffectPass(camera, bloom, tone, grade));
    composer.addPass(new EffectPass(camera, chroma));
    composerRef.current = composer;
    fx.current = { grade, chroma };

    Engine.create(scene, camera as THREE.PerspectiveCamera, engineCallbacks()).then((e) => {
      if (disposed) { e.dispose(); return; }
      engineRef.current = e;
      runtime.engine = e;
      if (import.meta.env.DEV || new URLSearchParams(location.search).get('debug') === '1') {
        (window as unknown as { __engine: Engine }).__engine = e;
        (window as unknown as { __combatLog: unknown[] }).__combatLog = [];
      }
      if (runtime.input) e.setInput(runtime.input);
      e.resize(size.width, size.height);
      onReady(e);
    }).catch((err) => {
      console.error('[engine] failed to start', err);
    });
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      runtime.engine = null;
      composer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    composerRef.current?.setSize(size.width, size.height);
    engineRef.current?.resize(size.width, size.height);
    fx.current?.grade.set('uAspect', size.width / size.height);
  }, [size.width, size.height]);

  useFrame((state, delta) => {
    const e = engineRef.current;
    if (e) {
      e.tick(delta);
      const p = e.post;
      const g = fx.current?.grade;
      if (g) {
        g.set('uSat', p.sat);
        g.set('uFlash', p.flash);
        g.set('uHeal', p.heal);
        g.set('uLetterbox', p.letterbox);
        g.set('uTime', state.clock.elapsedTime);
      }
      fx.current?.chroma.offset.set(p.chroma * 0.0022, p.chroma * 0.0014);
    }
    gl.info.autoReset = false;
    gl.info.reset();
    shadowFrame = (shadowFrame + 1) % 3;
    if (SHADOWS && shadowFrame === 0) gl.shadowMap.needsUpdate = true;
    composerRef.current?.render(delta);
    if (PERF) {
      perfAcc.frames++;
      perfAcc.t += delta;
      perfAcc.calls = gl.info.render.calls;
      perfAcc.tris = gl.info.render.triangles;
      if (perfAcc.t >= 0.5) {
        const el = document.getElementById('perf');
        if (el) el.textContent = `${Math.round(perfAcc.frames / perfAcc.t)} fps · ${perfAcc.calls} draw calls · ${(perfAcc.tris / 1000).toFixed(0)}k tris`;
        perfAcc.frames = 0; perfAcc.t = 0;
      }
    }
  }, 1);

  return null;
}

export function GameView() {
  const [ready, setReady] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const screen = useApp((s) => s.screen);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const input = runtime.input as { setTarget?: (el: HTMLElement | null) => void } | null;
    input?.setTarget?.(el);
  }, [ready, screen]);

  return (
    <div ref={hostRef} className={`game-host ${screen === 'game' ? 'is-playing' : ''}`} aria-hidden={screen !== 'game'}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false }}
        camera={{ fov: 50, near: 0.04, far: 80, position: [0, 2.2, 1.8] }}
        shadows={SHADOWS ? 'percentage' : false}
        flat
      >
        <EngineMount onReady={() => setReady(true)} />
      </Canvas>
      {!ready && <div className="engine-loading">Kindling the hearth…</div>}
      {PERF && <div id="perf" className="chip" style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 20 }}>…</div>}
    </div>
  );
}
