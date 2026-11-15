// First-person body ("as if in VR"): Odysseus's own armoured body under the camera. The torso and legs stand
// where the player stands (lean/crouch follow), and the arms run shoulder → elbow → wrist to the gauntlets.
// With the webcam, the elbow bends toward the player's real elbow (Part C's tracked skeleton); with keyboard
// and mouse it hangs naturally (down, out, a little back). The head and the body's bare hands stay collapsed:
// the camera is the head, and the bronze gauntlets are the hands.
import * as THREE from 'three';
import type { Hand } from '@ithaca/shared';
import { P, RIG, newAnim, newPose, solvePose } from './humanoid';
import { lookFor } from './panoply';
import { SkinnedBody, type BodyTemplate } from './skinnedBody';
import type { HandView } from './weapons';

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _w = new THREE.Vector3();
const _off = new THREE.Vector3();

/**
 * Two-bone IK: shoulder S, target T, bone lengths L1/L2, bend toward `pole`. Writes the elbow and wrist.
 * Out of reach, the arm straightens toward T (the shoulder may already have rolled forward).
 */
function solveArm(S: THREE.Vector3, T: THREE.Vector3, L1: number, L2: number, pole: THREE.Vector3, elbow: THREE.Vector3, wrist: THREE.Vector3) {
  _d.subVectors(T, S);
  let dist = _d.length();
  if (dist < 1e-4) { _d.set(0, -1, 0); dist = 1e-4; }
  _d.multiplyScalar(1 / dist);
  dist = THREE.MathUtils.clamp(dist, Math.abs(L1 - L2) + 0.02, (L1 + L2) * 0.999);
  wrist.copy(S).addScaledVector(_d, dist);
  const a = (L1 * L1 + dist * dist - L2 * L2) / (2 * dist);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  _p.subVectors(pole, S);
  _p.addScaledVector(_d, -_p.dot(_d));
  if (_p.lengthSq() < 1e-6) _p.set(0, -1, 0).addScaledVector(_d, -_d.y);
  _p.normalize();
  elbow.copy(S).addScaledVector(_d, a).addScaledVector(_p, h);
}

export interface PlayerBodyInput {
  eye: THREE.Vector3;          // camera position (world)
  yaw: number;                 // view yaw (0 = looking down −Z)
  crouch: number;              // 0..1
  hands: Record<Hand, HandView>;
  /** tracked elbows (world), webcam only */
  elbows?: Partial<Record<Hand, THREE.Vector3 | null>>;
}

export class PlayerBody {
  readonly body: SkinnedBody;
  private pose = newPose();
  private anim = newAnim();
  private readonly s: number;
  private readonly elbowS: Record<Hand, THREE.Vector3> = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  private warm = false;

  constructor(tpl: BodyTemplate, eyeHeight: number) {
    this.body = new SkinnedBody(tpl);
    const look = lookFor('hero', true, 'none');
    // sized so his eyes are the camera (head centre a hair above the eye line)
    this.s = (eyeHeight + 0.03) / (RIG.spineY + RIG.headY);
    look.scale = this.s;
    this.body.setLook(look);
    this.body.root.scale.setScalar(this.body.baseScale * this.s);
    this.body.hideBones(['head', 'neck', 'handL', 'handR']);
    this.body.root.visible = false;
  }

  get root() { return this.body.root; }

  update(inp: PlayerBodyInput, dt: number) {
    const s = this.s;
    const an = this.anim;
    // crouch: knees bend and the whole body drops with the eye
    an.legL = [0.55 * inp.crouch, 1.1 * inp.crouch];
    an.legR = [0.55 * inp.crouch, 1.1 * inp.crouch];
    an.bob = 0;
    an.lean = 0.12; // a fighter's forward set over the hips
    // the head centre sits ~7 cm behind the eyes; put the feet under it
    const bodyYaw = Math.PI + inp.yaw;
    _off.set(0, 0, 0.07).applyAxisAngle(new THREE.Vector3(0, 1, 0), inp.yaw);
    const headY = (RIG.spineY + RIG.headY) * s;
    const pos = _w.set(inp.eye.x + _off.x, inp.eye.y + 0.03 - headY, inp.eye.z + _off.z);
    solvePose(this.pose, pos, bodyYaw, s, an);

    // arms: IK from his shoulders to the gauntlets
    const L1 = RIG.uarm * s, L2 = RIG.larm * s;
    for (const side of ['left', 'right'] as const) {
      const up = side === 'left' ? P.UArmL : P.UArmR;
      const lo = side === 'left' ? P.LArmL : P.LArmR;
      const hv = inp.hands[side];
      const S = this.pose[up].a.clone();
      const sx = side === 'left' ? -1 : 1; // world-ish: rotate the side offset with the view
      const toHand = _p.subVectors(hv.pos, S);
      // reaching far: the shoulder rolls forward toward the hand (up to 9 cm), as a real reach does
      const over = toHand.length() - (L1 + L2 + 0.06);
      if (over > 0) S.addScaledVector(toHand.normalize(), Math.min(0.09, over));
      // pole: the tracked elbow if we have one, else down / out / a little back
      const tracked = inp.elbows?.[side];
      const want = tracked ?? new THREE.Vector3(sx * 0.32, -0.55, 0.18).applyAxisAngle(new THREE.Vector3(0, 1, 0), inp.yaw).add(S);
      const k = this.warm ? 1 - Math.exp(-18 * dt) : 1; // the pole is smoothed (tracked elbows are noisy)
      this.elbowS[side].lerp(want, k);
      // the wrist stops ~6 cm short of the grip, inside the gauntlet's cuff
      const E = this.pose[up].b, W = this.pose[lo].b;
      solveArm(S, hv.pos, L1, L2 + 0.06, this.elbowS[side], E, W);
      W.addScaledVector(_d.subVectors(E, W).normalize(), 0.06);
      this.pose[up].a.copy(S);
      this.pose[up].c.addVectors(S, E).multiplyScalar(0.5);
      this.pose[lo].a.copy(E);
      this.pose[lo].c.addVectors(E, W).multiplyScalar(0.5);
    }
    this.warm = true;
    this.body.apply(this.pose);
  }

  setVisible(v: boolean) { this.body.root.visible = v; if (!v) this.warm = false; }
}
