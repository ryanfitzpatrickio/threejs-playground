/**
 * Domestic cat procedural animation — fully procedural, no baked clips.
 *
 *   - analytic two-bone leg IK on all four digitigrade legs with soft paw plant
 *   - diagonal-couplet walk gait + spine sway/roll + head bob
 *   - flexible multi-bone spine: crouch, Halloween arch, play-bow stretch,
 *     sit-up on the haunches, loaf/curl
 *   - long spring/verlet tail (7 bones): idle sway, walk counter-swing, curl
 *   - independent mobile ears (forward-alert ↔ back-flat) with tip spring
 *   - procedural blink, gaze, whisker/breathing, jaw gape
 *   - behavior FSM + autopilot: idle, walk, stalk, pounce, sit, groom, alert,
 *     stretch, loaf, sleep-curl
 *
 * Facade API is duck-typed to the DogSimScene animation contract (same shape
 * the goose exposes) so the studio / free-roam drive it unchanged.
 */

import * as THREE from 'three';
import { CAT_CHAINS, CAT_FOOT_TIPS, CAT_CLAWS } from './catSkeleton.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

/** Studio clip catalog for the procedural cat (shown in the Dog Sim panel). */
export const CAT_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Walk', label: 'Walk', loop: true, behavior: 'walk' },
  { name: 'Trot', label: 'Trot', loop: true, behavior: 'trot' },
  { name: 'Stalk', label: 'Stalk', loop: true, behavior: 'stalk' },
  { name: 'Pounce', label: 'Pounce', loop: true, behavior: 'pounce' },
  { name: 'Play', label: 'Play', loop: true, behavior: 'play' },
  { name: 'Sit', label: 'Sit', loop: true, behavior: 'sit' },
  { name: 'Knead', label: 'Knead', loop: true, behavior: 'knead' },
  { name: 'Groom', label: 'Groom', loop: true, behavior: 'groom' },
  { name: 'Stretch', label: 'Stretch', loop: true, behavior: 'stretch' },
  { name: 'Loaf', label: 'Loaf', loop: true, behavior: 'loaf' },
  { name: 'Alert', label: 'Alert', loop: true, behavior: 'look' },
  { name: 'Sleep', label: 'Sleep (curl)', loop: true, behavior: 'lie' },
]);

const BEHAVIOR_TO_STATE = {
  idle: 'idle',
  walk: 'walk',
  trot: 'trot',
  run: 'trot',
  stalk: 'stalk',
  pounce: 'pounce',
  play: 'play',
  sit: 'sit',
  knead: 'knead',
  groom: 'groom',
  stretch: 'stretch',
  loaf: 'loaf',
  look: 'alert',
  lie: 'sleep',
  sleep: 'sleep',
};
const STATE_TO_CLIP = Object.freeze({
  idle: 'Idle', walk: 'Walk', trot: 'Trot', stalk: 'Stalk', pounce: 'Pounce',
  play: 'Play', sit: 'Sit', knead: 'Knead', groom: 'Groom', stretch: 'Stretch',
  loaf: 'Loaf', alert: 'Alert', sleep: 'Sleep',
});
const CLIP_TO_STATE = Object.freeze({
  Idle: 'idle', Walk: 'walk', Trot: 'trot', Stalk: 'stalk', Pounce: 'pounce',
  Play: 'play', Sit: 'sit', Knead: 'knead', Groom: 'groom', Stretch: 'stretch',
  Loaf: 'loaf', Alert: 'alert', Sleep: 'sleep',
});

/**
 * @param {{
 *   root: THREE.Group,
 *   model: THREE.Object3D,
 *   rig: ReturnType<import('./catSkeleton.js').createCatSkeleton>,
 *   uniforms: import('./catFurMaterial.js').CatUniforms,
 * }} ctx
 */
export function createCatAnimation(ctx) {
  const { rig } = ctx;
  const bones = rig.bonesByName;
  const bind = rig.worldBindPos;
  const B = (name) => bones.get(name);

  // ---- bind bookkeeping ------------------------------------------------------
  const restLocalPos = new Map();
  bones.forEach((b, name) => {
    if (name === 'Head') return;
    restLocalPos.set(name, b.position.clone());
  });

  function resetPose() {
    bones.forEach((b, name) => {
      if (name === 'Head') return;
      b.quaternion.identity();
      b.scale.setScalar(1);
      const p = restLocalPos.get(name);
      if (p) b.position.copy(p);
    });
  }

  function armToWorld(local, out) {
    out.copy(local);
    ctx.model.localToWorld(out);
    return out;
  }

  /** Aim `bone` so its child (bind offset) points toward targetWorld. */
  function aimBone(boneName, childName, targetWorld, blend = 1) {
    const bone = B(boneName);
    const parent = bone.parent;
    parent.updateWorldMatrix(true, false);
    _m0.copy(parent.matrixWorld).invert();
    const targetLocal = _v0.copy(targetWorld).applyMatrix4(_m0);
    const boneLocal = bone.position;
    const restDir = _v1.copy(bind.get(childName)).sub(bind.get(boneName));
    const wantDir = _v2.copy(targetLocal).sub(boneLocal);
    if (wantDir.lengthSq() < 1e-10 || restDir.lengthSq() < 1e-10) return;
    _q0.setFromUnitVectors(restDir.normalize(), wantDir.normalize());
    if (blend < 1) _q0.slerp(_q1.identity(), 1 - blend);
    bone.quaternion.premultiply(_q0);
    bone.updateMatrixWorld(true);
  }

  function spin(boneName, axis, angle) {
    if (Math.abs(angle) < 1e-6) return;
    const bone = B(boneName);
    if (!bone) return;
    _q0.setFromAxisAngle(axis, angle);
    bone.quaternion.multiply(_q0);
  }

  /**
   * Two-bone IK: place `endName` (a joint) at targetWorld by aiming top→mid and
   * mid→end. Pole vector keeps the knee/elbow bending sagittally.
   * @param {number} poleSign +1 bends knee forward (fore), −1 aft (hind hock)
   */
  function solveTwoBone(topName, midName, endName, targetLocal, poleSign) {
    const top = B(topName);
    top.parent.updateWorldMatrix(true, false);
    const topWorld = top.getWorldPosition(new THREE.Vector3());
    const endWorld = armToWorld(targetLocal, new THREE.Vector3());
    const L1 = bind.get(midName).clone().sub(bind.get(topName)).length();
    const L2 = bind.get(endName).clone().sub(bind.get(midName)).length();

    const toTarget = endWorld.clone().sub(topWorld);
    const dist = Math.min(toTarget.length(), (L1 + L2) * 0.999);
    if (dist < 1e-5) return;
    const a = Math.acos(THREE.MathUtils.clamp(
      (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1));
    const dir = toTarget.clone().normalize();
    // Pole: body-forward (+Z) in world; bend the joint toward/away from it.
    const pole = armToWorld(_v0.set(0, 0, poleSign), new THREE.Vector3())
      .sub(armToWorld(_v1.set(0, 0, 0), new THREE.Vector3()))
      .normalize();
    const bendAxis = _v1.crossVectors(dir, pole).normalize();
    if (bendAxis.lengthSq() < 1e-8) bendAxis.set(1, 0, 0);
    const kneeDir = dir.clone().applyAxisAngle(bendAxis, -a);
    const midWorld = topWorld.clone().addScaledVector(kneeDir, L1);
    aimBone(topName, midName, midWorld);
    aimBone(midName, endName, endWorld);
  }

  // ---- state -----------------------------------------------------------------
  let behavior = 'idle';
  let fsmState = 'idle';
  let currentClip = 'Idle';
  let autopilot = false;
  let autopilotTimer = 0;
  let autopilotPhase = 0;
  let mouthState = 'closed';
  let time = 0;
  let rootYaw = 0;
  let yawRate = 0;
  const rootPos = new THREE.Vector3();
  let frozenBlink = false;
  let frozenBreeze = false;
  let clipDriven = false;
  let externalRootMotion = false;
  /** @type {{ x:number, z:number, moving:boolean } | null} */
  let moveIntent = null;

  const pose = {
    crouch: 0, crouchT: 0,          // 0 stand … 1 belly low
    backArch: 0, backArchT: 0,      // −1 dip … +1 Halloween arch
    stretchFwd: 0, stretchFwdT: 0,  // play-bow: front down, rear up
    sitAmt: 0, sitAmtT: 0,          // 0 stand … 1 sit on haunches
    lieAmt: 0, lieAmtT: 0,          // 0 … 1 lying / loaf / curl
    walkAmp: 0, walkAmpT: 0,
    headRaise: 0, headRaiseT: 0,
    headPitch: 0, headPitchT: 0,
    headYaw: 0, headYawT: 0,
    earRot: 0, earRotT: 0,          // −1 flat back … 0 neutral … +1 forward
    tailCurlT: 0, tailCurl: 0,
    tailLiftT: 0, tailLift: 0,
    jawOpen: 0, jawOpenT: 0,
    bodyPitch: 0, bodyPitchT: 0,
    clawExtend: 0, clawExtendT: 0,   // 0 sheathed … 1 fully protracted
  };
  let gaitPhase = 0;
  let groomPhase = 0;
  let kneadPhase = 0;
  let whiskerTwitch = 0;
  let blinkTimer = 1.8;
  let blinkT = 1;
  // tail springs (yaw sway + lift)
  let tailYaw = 0; let tailYawVel = 0;
  let tailLiftS = 0; let tailLiftVel = 0;
  // ear tip springs
  const earTip = { L: 0, R: 0, Lv: 0, Rv: 0 };

  function syncJawTarget() {
    if (mouthState === 'open') pose.jawOpenT = 0.5;
    else if (mouthState === 'alert') pose.jawOpenT = 0.18; // slight pant / meow
    else pose.jawOpenT = 0;
  }

  function setState(next) {
    if (fsmState === next) { syncJawTarget(); return; }
    fsmState = next;
    let crouch = 0, backArch = 0, stretchFwd = 0, sitAmt = 0, lieAmt = 0;
    let walkAmp = 0, headRaise = 0, headPitch = 0, earRot = 0.15;
    let tailCurl = 0, tailLift = 0.2, bodyPitch = 0, clawExtend = 0;

    switch (next) {
      case 'idle': tailLift = 0.25; headRaise = 0.0; headPitch = 0.06; break;
      case 'walk': walkAmp = 0.7; tailLift = 0.35; earRot = 0.25; break;
      case 'trot': walkAmp = 1.0; tailLift = 0.5; headRaise = 0.1; earRot = 0.4; break;
      case 'stalk':
        crouch = 0.85; walkAmp = 0.35; headRaise = -0.1; headPitch = 0.15;
        earRot = 0.7; tailLift = -0.2; tailCurl = 0.1; clawExtend = 0.5; break;
      case 'pounce':
        crouch = 0.5; backArch = 0.2; headRaise = 0.1; earRot = 0.8;
        tailLift = 0.4; bodyPitch = -0.05; clawExtend = 1; break;
      case 'play':
        // Playful crouch-and-bat: rump up, forepaws swiping, tail lashing.
        crouch = 0.4; backArch = 0.12; headRaise = 0.05; earRot = 0.75;
        tailLift = 0.35; clawExtend = 0.5; break;
      case 'sit':
        sitAmt = 1; headRaise = 0.25; tailCurl = 0.4; tailLift = -0.1;
        earRot = 0.2; break;
      case 'knead':
        // Sit up on the haunches and rhythmically press the fore paws with
        // protracted claws ("making biscuits").
        sitAmt = 0.7; headRaise = 0.15; tailCurl = 0.35; earRot = 0.1;
        clawExtend = 0.7; break;
      case 'groom':
        sitAmt = 0.8; headPitch = 0.9; headYawTargetHold(); tailCurl = 0.5;
        earRot = -0.1; break;
      case 'stretch':
        stretchFwd = 1; headRaise = -0.2; tailLift = 0.6; earRot = 0.1; break;
      case 'loaf':
        lieAmt = 0.6; crouch = 0.9; headRaise = 0.05; tailCurl = 0.6;
        earRot = 0.15; break;
      case 'sleep':
        lieAmt = 1; crouch = 1; headPitch = 0.7; tailCurl = 1;
        earRot = -0.05; break;
      case 'alert':
        headRaise = 0.55; earRot = 1; tailLift = 0.4; break;
      default: break;
    }
    pose.crouchT = crouch;
    pose.backArchT = backArch;
    pose.stretchFwdT = stretchFwd;
    pose.sitAmtT = sitAmt;
    pose.lieAmtT = lieAmt;
    pose.walkAmpT = walkAmp;
    pose.headRaiseT = headRaise;
    pose.headPitchT = headPitch;
    pose.earRotT = earRot;
    pose.tailCurlT = tailCurl;
    pose.tailLiftT = tailLift;
    pose.bodyPitchT = bodyPitch;
    pose.clawExtendT = clawExtend;
    if (next === 'walk' || next === 'trot' || next === 'stalk') gaitPhase = 0;
    if (next === 'groom') groomPhase = 0;
    if (next === 'knead' || next === 'play') kneadPhase = 0;
    syncJawTarget();
  }

  // groom sweeps the head yaw side to side; hold a small target here.
  function headYawTargetHold() { pose.headYawT = -0.2; }

  function smooth(cur, target, rate, dt) {
    return THREE.MathUtils.lerp(cur, target, 1 - Math.exp(-rate * dt));
  }

  /**
   * Ankle target (armature space) for one leg: bind ankle modified by crouch,
   * stride, sit tuck, stretch. side ∈ L/R, fore ∈ bool.
   */
  function ankleTarget(fore, side, phase, amp) {
    const ankleName = fore ? `Hand_${side}` : `Foot_${side}`;
    const base = bind.get(ankleName).clone();
    const s = side === 'L' ? 1 : -1;

    // crouch lowers the ankle (body sinks toward the paws)
    base.y -= pose.crouch * 0.045;

    // walk stride: lift + fore/aft swing
    if (amp > 0.001) {
      const lift = Math.max(0, Math.sin(phase)) * 0.05 * amp;
      const strideZ = -Math.cos(phase) * 0.06 * amp;
      base.y += lift;
      base.z += strideZ;
    }

    // play-bow stretch: front paws reach forward+down, rear stays planted, hips up
    if (pose.stretchFwd > 0.01) {
      if (fore) { base.z += pose.stretchFwd * 0.08; base.y -= pose.stretchFwd * 0.02; }
      else { base.y += pose.stretchFwd * 0.01; }
    }

    // sit: hind hocks fold forward/under, haunches drop; front stays vertical
    if (pose.sitAmt > 0.01) {
      if (fore) {
        base.y -= pose.sitAmt * 0.01;
      } else {
        base.z += pose.sitAmt * 0.055;
        base.y -= pose.sitAmt * 0.028;
        base.x += s * pose.sitAmt * 0.006;
      }
    }

    // knead: fore paws alternately press up/down ("making biscuits")
    if (fsmState === 'knead' && fore) {
      const ph = side === 'L' ? kneadPhase : kneadPhase + Math.PI;
      base.z += 0.05;
      base.y += 0.05 + Math.sin(ph) * 0.045;
    }

    // play: fore paws bat/swipe forward-up at the toy
    if (fsmState === 'play' && fore) {
      const ph = side === 'L' ? kneadPhase : kneadPhase + Math.PI * 0.6;
      const swipe = Math.max(0, Math.sin(ph));
      base.z += 0.04 + swipe * 0.07;
      base.y += 0.03 + swipe * 0.08;
      base.x += s * swipe * 0.02;
    }

    // loaf / sleep: tuck all paws in under the body
    if (pose.lieAmt > 0.01) {
      base.z = THREE.MathUtils.lerp(base.z, fore ? 0.10 : -0.06, pose.lieAmt * 0.7);
      base.x = THREE.MathUtils.lerp(base.x, s * 0.03, pose.lieAmt * 0.5);
      base.y = THREE.MathUtils.lerp(base.y, 0.03, pose.lieAmt * 0.5);
    }
    return base;
  }

  function applyFrame(dt) {
    // -- param springs --
    pose.crouch = smooth(pose.crouch, pose.crouchT, 4.0, dt);
    pose.backArch = smooth(pose.backArch, pose.backArchT, 4.0, dt);
    pose.stretchFwd = smooth(pose.stretchFwd, pose.stretchFwdT, 3.5, dt);
    pose.sitAmt = smooth(pose.sitAmt, pose.sitAmtT, 3.5, dt);
    pose.lieAmt = smooth(pose.lieAmt, pose.lieAmtT, 3.0, dt);
    pose.walkAmp = smooth(pose.walkAmp, pose.walkAmpT, externalRootMotion ? 9 : 3.6, dt);
    pose.headRaise = smooth(pose.headRaise, pose.headRaiseT, 5, dt);
    pose.headPitch = smooth(pose.headPitch, pose.headPitchT, 5, dt);
    pose.headYaw = smooth(pose.headYaw, pose.headYawT, 4, dt);
    pose.earRot = smooth(pose.earRot, pose.earRotT, 6, dt);
    pose.tailCurl = smooth(pose.tailCurl, pose.tailCurlT, 3.5, dt);
    pose.tailLift = smooth(pose.tailLift, pose.tailLiftT, 3.5, dt);
    pose.jawOpen = smooth(pose.jawOpen, pose.jawOpenT, 9, dt);
    pose.bodyPitch = smooth(pose.bodyPitch, pose.bodyPitchT, 4, dt);
    pose.clawExtend = smooth(pose.clawExtend, pose.clawExtendT, 7, dt);

    ctx.model.position.set(0, 0, 0);
    resetPose();
    const rootBone = rig.rootBone;

    // ---- phases -------------------------------------------------------------
    const walking = pose.walkAmp > 0.02;
    const stepHz = fsmState === 'trot' ? 3.0 : fsmState === 'stalk' ? 1.3 : 2.1;
    if (walking) gaitPhase += dt * Math.PI * 2 * stepHz;
    if (fsmState === 'groom') groomPhase += dt * Math.PI * 2 * 1.1;
    if (fsmState === 'knead') kneadPhase += dt * Math.PI * 2 * 1.4;
    if (fsmState === 'play') kneadPhase += dt * Math.PI * 2 * 2.6;
    const amp = pose.walkAmp;

    // Diagonal couplets: FL+HR (phase A), FR+HL (phase B).
    const phA = gaitPhase;
    const phB = gaitPhase + Math.PI;

    // body waddle / roll / bob
    const sway = Math.sin(gaitPhase) * 0.006 * amp;
    const rollA = Math.sin(gaitPhase) * 0.05 * amp;
    const bob = Math.abs(Math.cos(gaitPhase)) * -0.006 * amp;
    rootBone.position.x += sway;
    rootBone.position.y += bob - pose.crouch * 0.03 - pose.sitAmt * 0.02 - pose.lieAmt * 0.05;
    _q0.setFromAxisAngle(AXIS_Z, -rollA);
    rootBone.quaternion.multiply(_q0);
    if (Math.abs(pose.bodyPitch) > 1e-4) {
      _q0.setFromAxisAngle(AXIS_X, pose.bodyPitch);
      rootBone.quaternion.multiply(_q0);
    }

    // ---- spine flex: distribute arch/dip + sit + stretch along the chain ----
    const spineNames = CAT_CHAINS.spine.slice(1); // spine_0..4
    const nS = spineNames.length;
    for (let i = 0; i < nS; i += 1) {
      const t = i / (nS - 1); // 0 lumbar … 1 withers
      // Halloween arch bows the mid-back up (about −X lifts the back).
      const arch = pose.backArch * Math.sin(t * Math.PI) * 0.16;
      // Sit: rotate the rear spine upright so the chest rises.
      const sit = pose.sitAmt * (0.55 - t) * 0.5;
      // Stretch: dip the front, raise the rear (opposite of sit).
      const str = pose.stretchFwd * (t - 0.5) * 0.5;
      // Loaf/sleep: gentle overall curl.
      const curl = pose.lieAmt * Math.sin(t * Math.PI) * 0.1;
      spin(spineNames[i], AXIS_X, -(arch + sit + str + curl));
    }
    // subtle breathing swell on the chest
    const breathe = frozenBreeze ? 0 : Math.sin(time * 2.4) * 0.5 + 0.5;
    B('chest').scale.setScalar(1 + breathe * 0.02);

    rootBone.updateMatrixWorld(true);
    ctx.model.updateMatrixWorld(true);

    // ---- legs: four-leg IK --------------------------------------------------
    // fore: bend elbow forward (poleSign +1); hind: hock bends aft (poleSign −1)
    const legs = [
      { fore: true, side: 'L', ph: phA },
      { fore: false, side: 'R', ph: phA },
      { fore: true, side: 'R', ph: phB },
      { fore: false, side: 'L', ph: phB },
    ];
    for (const leg of legs) {
      const target = ankleTarget(leg.fore, leg.side, leg.ph, amp);
      if (leg.fore) {
        solveTwoBone(`humerus_${leg.side}`, `radius_${leg.side}`, `Hand_${leg.side}`, target, 1);
        // plant fingers forward-down
        const toe = bind.get(`Fingers_tip_${leg.side}`).clone()
          .sub(bind.get(`Hand_${leg.side}`)).add(target);
        toe.y = Math.max(0.006, target.y - 0.03);
        aimBone(`Hand_${leg.side}`, `Fingers_tip_${leg.side}`, armToWorld(toe, new THREE.Vector3()));
      } else {
        solveTwoBone(`femur_${leg.side}`, `tibia_${leg.side}`, `Foot_${leg.side}`, target, -1);
        // metatarsus down to the toe ball, then toe tip forward
        const ball = bind.get(`Toes_${leg.side}`).clone()
          .sub(bind.get(`Foot_${leg.side}`)).add(target);
        ball.y = Math.max(0.008, target.y - 0.075);
        aimBone(`Foot_${leg.side}`, `Toes_${leg.side}`, armToWorld(ball, new THREE.Vector3()));
        const tip = ball.clone(); tip.z += 0.03; tip.y = Math.max(0.005, ball.y - 0.02);
        aimBone(`Toes_${leg.side}`, `Toes_tip_${leg.side}`, armToWorld(tip, new THREE.Vector3()));
        // toe roll during push-off
        if (walking) spin(`Toes_${leg.side}`, AXIS_X, Math.max(0, -Math.sin(leg.ph)) * 0.4 * amp);
      }
    }

    // ---- neck + head (short FK chain) ---------------------------------------
    let headBob = 0;
    if (walking) headBob = Math.sin(gaitPhase * 2) * 0.03 * amp;
    const idleSway = frozenBreeze ? 0 : Math.sin(time * 0.8) * 0.02;
    const groomYaw = fsmState === 'groom' ? Math.sin(groomPhase) * 0.5 : 0;
    const raise = pose.headRaise;
    spin('neck_0', AXIS_X, -raise * 0.35 + pose.headPitch * 0.25 + headBob * 0.5);
    spin('neck_1', AXIS_X, -raise * 0.25 + pose.headPitch * 0.35);
    spin('neck_0', AXIS_Y, (pose.headYaw + idleSway * 0.3 + groomYaw * 0.4));
    spin('head', AXIS_X, -raise * 0.1 + pose.headPitch * 0.6 + headBob);
    spin('head', AXIS_Y, (pose.headYaw * 0.6 + groomYaw * 0.6));

    // ---- jaw ----------------------------------------------------------------
    if (pose.jawOpen > 1e-3) spin('jaw', AXIS_X, pose.jawOpen * 0.5);

    // ---- ears (mobile) ------------------------------------------------------
    const er = pose.earRot;
    for (const side of ['L', 'R']) {
      // forward-alert rotates the pinna about X (cup forward); flat-back reverses.
      spin(`ear_${side}_0`, AXIS_X, er * 0.35);
      spin(`ear_${side}_0`, AXIS_Y, (side === 'L' ? -1 : 1) * (0.2 - er * 0.25));
      // ear-tip spring: react to head motion + a light twitch
      const twitch = frozenBlink ? 0 : Math.sin(time * 3 + (side === 'L' ? 0 : 1.7)) * 0.02;
      const targetTip = er * 0.2 + twitch;
      const k = 40, c = 8;
      const key = side;
      earTip[`${key}v`] += (targetTip - earTip[key]) * k * dt;
      earTip[`${key}v`] *= Math.exp(-c * dt);
      earTip[key] += earTip[`${key}v`] * dt;
      spin(`ear_${side}_1`, AXIS_X, earTip[key]);
    }

    // ---- tail spring --------------------------------------------------------
    const tailYawTarget = walking ? Math.sin(gaitPhase - 0.8) * 0.12 * amp
      : fsmState === 'idle' ? (frozenBreeze ? 0 : Math.sin(time * 1.3) * 0.06)
        : fsmState === 'stalk' ? Math.sin(time * 2.5) * 0.14
          : 0;
    const kS = 24, kD = 6.5;
    tailYawVel += (tailYawTarget - tailYaw) * kS * dt; tailYawVel *= Math.exp(-kD * dt);
    tailYaw += tailYawVel * dt;
    tailLiftVel += (pose.tailLift - tailLiftS) * kS * dt; tailLiftVel *= Math.exp(-kD * dt);
    tailLiftS += tailLiftVel * dt;

    const tailNames = CAT_CHAINS.tail;
    for (let i = 0; i < tailNames.length; i += 1) {
      const t = i / (tailNames.length - 1);
      // base lift bows the whole tail up; curl coils the tip around toward the body
      spin(tailNames[i], AXIS_X, -tailLiftS * 0.28 + pose.tailCurl * 0.18);
      spin(tailNames[i], AXIS_Y, tailYaw * (0.3 + t * 0.5) + pose.tailCurl * 0.22 * t);
    }

    // ---- claws: retract (sheathed) ↔ protract, with a knead flex ------------
    if (pose.clawExtend > 1e-3) {
      const kneadFlex = fsmState === 'knead' ? Math.sin(kneadPhase) * 0.15 : 0;
      for (const [clawBone, , side, fore] of CAT_CLAWS) {
        const ph = side === 'L' ? kneadPhase : kneadPhase + Math.PI;
        const flex = fore ? Math.max(0, Math.sin(ph)) * kneadFlex : 0;
        spin(clawBone, AXIS_X, -(pose.clawExtend * 0.9 + flex));
      }
    }

    // ---- eyes: gaze + blink -------------------------------------------------
    whiskerTwitch = Math.max(0, whiskerTwitch - dt * 3.5);
    if (!frozenBlink) {
      blinkTimer -= dt;
      if (blinkTimer <= 0) {
        blinkTimer = 2.4 + Math.random() * 3.5;
        blinkT = 0;
        whiskerTwitch = 1; // a blink jostles the whiskers
      }
      blinkT = Math.min(1, blinkT + dt * 8);
      const closed = Math.sin(Math.min(1, blinkT) * Math.PI);
      const openY = fsmState === 'sleep' ? 0.12 : 1;
      B('eye_L').scale.y = openY * (1 - closed * 0.85);
      B('eye_R').scale.y = openY * (1 - closed * 0.85);
    }
    // Whisker light dynamics: idle tremor + alert/stalk forward tension + blink jostle.
    const whiskerBase = (fsmState === 'alert' || fsmState === 'stalk') ? 0.55
      : fsmState === 'knead' ? 0.35 : 0.15;
    if (ctx.uniforms?.whiskerSway) {
      ctx.uniforms.whiskerSway.value = Math.min(1, whiskerBase + whiskerTwitch * 0.6);
    }

    ctx.model.updateMatrixWorld(true);
    groundFeet();
    rig.skeleton.update?.();
  }

  function groundFeet() {
    ctx.model.updateMatrixWorld(true);
    let minY = Infinity;
    for (const name of CAT_FOOT_TIPS) {
      const b = B(name);
      if (!b) continue;
      b.getWorldPosition(_v0);
      minY = Math.min(minY, _v0.y - 0.004);
    }
    if (!Number.isFinite(minY)) return;
    if (Math.abs(minY) < 5e-4) return;
    ctx.model.position.y = -minY;
    ctx.model.updateMatrixWorld(true);
  }

  // ---- facade ---------------------------------------------------------------
  return {
    setBehavior(id) {
      behavior = String(id ?? 'idle');
      setState(BEHAVIOR_TO_STATE[behavior] ?? 'idle');
      currentClip = STATE_TO_CLIP[fsmState] ?? 'Idle';
    },
    getBehavior: () => behavior,
    setAutopilot(on) { autopilot = Boolean(on); autopilotTimer = 0; },
    getAutopilot: () => autopilot,
    setMoveIntent({ x = 0, z = 0, sprint = false, moving = null, sit = false, look = false } = {}) {
      autopilot = false;
      const hasDir = x * x + z * z > 1e-6;
      const wantsMove = moving ?? hasDir;
      moveIntent = hasDir || wantsMove ? { x, z, moving: wantsMove } : null;
      const holdPose = fsmState === 'sleep' || fsmState === 'groom'
        || fsmState === 'pounce' || fsmState === 'knead' || fsmState === 'play';
      if (sit) { behavior = 'sit'; setState('sit'); }
      else if (look) { behavior = 'look'; setState('alert'); }
      else if (wantsMove) {
        behavior = sprint ? 'trot' : 'walk';
        setState(sprint ? 'trot' : 'walk');
      } else if (!wantsMove && !holdPose) { behavior = 'idle'; setState('idle'); }
      currentClip = STATE_TO_CLIP[fsmState] ?? 'Idle';
    },
    setExternalRootMotion(on) { externalRootMotion = Boolean(on); },
    getExternalRootMotion: () => externalRootMotion,
    setMouthState(id) { mouthState = String(id ?? 'closed'); syncJawTarget(); },
    getMouthState: () => mouthState,
    setTime(t) { time = Number(t) || 0; },
    getTime: () => time,
    setRootPosition(x, y, z) { rootPos.set(x, y, z); ctx.root.position.copy(rootPos); },
    getRootPosition: () => rootPos.clone(),
    setRootYaw(yaw) { rootYaw = Number(yaw) || 0; ctx.root.rotation.y = rootYaw; },
    getRootYaw: () => rootYaw,
    getYawRate: () => yawRate,
    getMoveSpeed: () => {
      if (fsmState === 'walk') return 0.5;
      if (fsmState === 'trot') return 1.1;
      if (fsmState === 'stalk') return 0.22;
      if (fsmState === 'pounce') return 1.6;
      return 0;
    },
    setFrozenBlink(on) {
      frozenBlink = Boolean(on);
      if (frozenBlink) { B('eye_L').scale.y = 1; B('eye_R').scale.y = 1; }
    },
    setFrozenBreeze(on) { frozenBreeze = Boolean(on); },
    isFrozenBreeze: () => frozenBreeze,
    isFrozenBlink: () => frozenBlink,
    setClipDriven(on) { clipDriven = Boolean(on); },
    getClipDriven: () => clipDriven,
    playClip(name) {
      const state = CLIP_TO_STATE[name];
      if (!state) return false;
      currentClip = name;
      behavior = Object.keys(BEHAVIOR_TO_STATE).find((k) => BEHAVIOR_TO_STATE[k] === state) ?? state;
      setState(state);
      return true;
    },
    getCurrentClip: () => currentClip ?? STATE_TO_CLIP[fsmState] ?? 'Idle',
    setGazeYaw(yaw) { pose.headYawT = THREE.MathUtils.clamp(Number(yaw) || 0, -1.0, 1.0); },
    setEarRot(v) { pose.earRotT = THREE.MathUtils.clamp(Number(v) || 0, -1, 1); },
    getState: () => fsmState,
    getCoreBounds() {
      const names = [
        'hips', 'spine_2', 'spine_4', 'head', 'chest',
        'Foot_L', 'Foot_R', 'Hand_L', 'Hand_R',
        'Toes_tip_L', 'Toes_tip_R', 'Fingers_tip_L', 'Fingers_tip_R', 'tail_3',
      ];
      const box = new THREE.Box3();
      let any = false;
      ctx.root.updateMatrixWorld(true);
      for (const name of names) {
        const bone = bones.get(name);
        if (!bone) continue;
        bone.getWorldPosition(_v0);
        box.expandByPoint(_v0);
        any = true;
      }
      if (!any) box.setFromObject(ctx.root);
      return box;
    },
    update(dt) {
      time += dt;
      if (autopilot && !frozenBlink) {
        autopilotTimer -= dt;
        if (autopilotTimer <= 0) {
          autopilotPhase = (autopilotPhase + 1) % 11;
          // Matches the spec autopilot set (idle, stalk, pounce, play, groom,
          // alert, sleep-curl) plus walk/sit/knead/stretch for a fuller loop.
          const cycle = ['idle', 'walk', 'alert', 'stalk', 'pounce', 'play', 'sit', 'knead', 'groom', 'stretch', 'idle'];
          const next = cycle[autopilotPhase];
          behavior = next;
          setState(BEHAVIOR_TO_STATE[next] ?? next);
          autopilotTimer = next === 'pounce' ? 1.3 : 2.4 + (autopilotPhase % 3) * 0.6;
        }
      }
      if (moveIntent?.moving && (moveIntent.x * moveIntent.x + moveIntent.z * moveIntent.z) > 1e-6) {
        const targetYaw = Math.atan2(moveIntent.x, moveIntent.z);
        let dyaw = targetYaw - rootYaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        const stepv = THREE.MathUtils.clamp(dyaw * (1 - Math.exp(-3.5 * dt)), -2.5 * dt, 2.5 * dt);
        rootYaw += stepv;
        yawRate = THREE.MathUtils.lerp(yawRate, stepv / Math.max(dt, 1e-5), 1 - Math.exp(-10 * dt));
      } else {
        yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
      }
      applyFrame(Math.max(1e-4, dt));
      // Park/studio controllers may write world XZ onto the outer group; sample
      // that when external root motion is on instead of snapping back to rootPos.
      if (externalRootMotion) {
        rootPos.copy(ctx.root.position);
      } else {
        ctx.root.position.copy(rootPos);
      }
      ctx.root.rotation.y = rootYaw;
    },
  };
}
