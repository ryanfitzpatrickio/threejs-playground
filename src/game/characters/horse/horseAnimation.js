/**
 * Horse v2 procedural animation — fully procedural, no baked clips.
 *
 *   - analytic multi-bone leg IK on all four legs: two-bone upper solve
 *     (shoulder/elbow, hip/stifle) + distal chain placement (cannon → fetlock
 *     → pastern → hoof) with pastern flex under load and hoof-roll breakover
 *   - procedural gait system with authentic footfall tables:
 *       walk   4-beat lateral sequence  (LH → LF → RH → RF)
 *       trot   2-beat diagonal couplets (LF+RH / RF+LH)
 *       canter 3-beat with a lead + suspension
 *       gallop 4-beat transverse with suspension
 *     plus smooth speed/amplitude transitions between them
 *   - dynamic spine bending (canter/gallop back wave) + weight shifting
 *   - spring/verlet tail chain (12 bones) with idle sway + gallop banner
 *   - spring-damped independently-swivelling ears
 *   - facial expressions: snort (head toss + nostril flare), chew (jaw grind
 *     + lip wiggle), alert; procedural blink, breathing, muscle flex
 *   - behavior FSM + autopilot: idle, graze, walk, trot, canter, gallop,
 *     alert, snort, chew, rest (hip-shot hind leg)
 *
 * Facade API is duck-typed to the DogSimScene animation contract (same shape
 * as the cat/goose facades) so the studio / free-roam drive it unchanged.
 */

import * as THREE from 'three';
import { HORSE_CHAINS, HORSE_HOOF_TIPS, HORSE_DIMS } from './horseSkeleton.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

const D = HORSE_DIMS;

/** Studio clip catalog for the procedural horse (shown in the Dog Sim panel). */
export const HORSE_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Graze', label: 'Graze', loop: true, behavior: 'graze' },
  { name: 'Walk', label: 'Walk', loop: true, behavior: 'walk' },
  { name: 'Trot', label: 'Trot', loop: true, behavior: 'trot' },
  { name: 'Canter', label: 'Canter', loop: true, behavior: 'canter' },
  { name: 'Gallop', label: 'Gallop', loop: true, behavior: 'gallop' },
  { name: 'Alert', label: 'Alert', loop: true, behavior: 'look' },
  { name: 'Snort', label: 'Snort', loop: true, behavior: 'snort' },
  { name: 'Chew', label: 'Chew', loop: true, behavior: 'chew' },
  { name: 'Rest', label: 'Rest (hip-shot)', loop: true, behavior: 'sit' },
]);

const BEHAVIOR_TO_STATE = {
  idle: 'idle',
  graze: 'graze',
  walk: 'walk',
  trot: 'trot',
  canter: 'canter',
  gallop: 'gallop',
  run: 'gallop',
  look: 'alert',
  alert: 'alert',
  snort: 'snort',
  chew: 'chew',
  sit: 'rest',
  rest: 'rest',
  lie: 'rest',
  sleep: 'rest',
};
const STATE_TO_CLIP = Object.freeze({
  idle: 'Idle', graze: 'Graze', walk: 'Walk', trot: 'Trot', canter: 'Canter',
  gallop: 'Gallop', alert: 'Alert', snort: 'Snort', chew: 'Chew', rest: 'Rest',
});
const CLIP_TO_STATE = Object.freeze({
  Idle: 'idle', Graze: 'graze', Walk: 'walk', Trot: 'trot', Canter: 'canter',
  Gallop: 'gallop', Alert: 'alert', Snort: 'snort', Chew: 'chew', Rest: 'rest',
});

/**
 * Footfall phase offsets (fraction of stride) + cadence/stride per gait.
 * walk: lateral sequence LH, LF, RH, RF at quarter intervals.
 * trot: diagonal pairs. canter: right lead 3-beat. gallop: transverse 4-beat.
 */
const GAITS = Object.freeze({
  walk: { hz: 0.95, lift: 0.09, stride: 0.24, off: { FL: 0.25, FR: 0.75, HL: 0.0, HR: 0.5 }, duty: 0.62, bob: 0.012, roll: 0.03, pitch: 0.0 },
  trot: { hz: 1.55, lift: 0.14, stride: 0.32, off: { FL: 0.0, FR: 0.5, HL: 0.5, HR: 0.0 }, duty: 0.5, bob: 0.028, roll: 0.02, pitch: 0.012 },
  canter: { hz: 1.7, lift: 0.19, stride: 0.44, off: { FL: 0.34, FR: 0.62, HL: 0.0, HR: 0.28 }, duty: 0.44, bob: 0.05, roll: 0.025, pitch: 0.05 },
  gallop: { hz: 2.1, lift: 0.24, stride: 0.58, off: { FL: 0.5, FR: 0.64, HL: 0.0, HR: 0.14 }, duty: 0.38, bob: 0.06, roll: 0.02, pitch: 0.08 },
});

/**
 * @param {{
 *   root: THREE.Group,
 *   model: THREE.Object3D,
 *   rig: ReturnType<import('./horseSkeleton.js').createHorseSkeleton>,
 *   uniforms: import('./horseCoatMaterial.js').HorseUniforms,
 * }} ctx
 */
export function createHorseAnimation(ctx) {
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
   * Two-bone IK: place `endName` (a joint) at targetLocal (armature space) by
   * aiming top→mid and mid→end. Pole keeps the joint bending sagittally.
   * @param {number} poleSign +1 bends mid-joint toward +Z (stifle forward),
   *   −1 toward −Z (elbow/hock aft). Horse faces +Z.
   */
  function solveTwoBone(topName, midName, endName, targetLocal, poleSign) {
    const top = B(topName);
    top.parent.updateWorldMatrix(true, false);
    const topWorld = top.getWorldPosition(new THREE.Vector3());
    const endWorld = armToWorld(_v2.copy(targetLocal), new THREE.Vector3());
    const L1 = bind.get(midName).clone().sub(bind.get(topName)).length();
    const L2 = bind.get(endName).clone().sub(bind.get(midName)).length();

    const toTarget = endWorld.clone().sub(topWorld);
    const dist = Math.min(toTarget.length(), (L1 + L2) * 0.999);
    if (dist < 1e-5) return;
    const a = Math.acos(THREE.MathUtils.clamp(
      (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1));
    const dir = toTarget.clone().normalize();
    // Pole is a pure armature-Z direction so mid-joint prefers +Z or −Z.
    const pole = armToWorld(_v0.set(0, 0, poleSign), new THREE.Vector3())
      .sub(armToWorld(_v1.set(0, 0, 0), new THREE.Vector3()))
      .normalize();
    // bendAxis = dir × pole; rotating dir by +a around it swings the mid
    // joint toward the pole (+Z for poleSign +1, −Z for −1).
    const bendAxis = _v1.crossVectors(dir, pole).normalize();
    if (bendAxis.lengthSq() < 1e-8) bendAxis.set(1, 0, 0);
    const midDir = dir.clone().applyAxisAngle(bendAxis, a);
    const midWorld = topWorld.clone().addScaledVector(midDir, L1);
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
    walkAmp: 0, walkAmpT: 0,        // gait blend 0 halt … 1 full stride
    gaitMix: 0, gaitMixT: 0,        // 0 walk, 1 trot, 2 canter, 3 gallop
    grazeAmt: 0, grazeAmtT: 0,      // neck down to grass
    headRaise: 0, headRaiseT: 0,
    headPitch: 0, headPitchT: 0,
    headYaw: 0, headYawT: 0,
    earRot: 0.2, earRotT: 0.2,      // −1 pinned back … +1 pricked forward
    tailLift: 0.1, tailLiftT: 0.1,
    jawOpen: 0, jawOpenT: 0,
    restShift: 0, restShiftT: 0,    // hip-shot resting hind leg
    nostril: 0, nostrilT: 0,        // flare 0..1
    bodyPitch: 0, bodyPitchT: 0,
  };
  let gaitPhase = 0;      // stride phase [0..1)
  let chewPhase = 0;
  let snortTimer = 0;
  let blinkTimer = 2.2;
  let blinkT = 1;
  let earWanderTimer = 0;
  const earTarget = { L: 0, R: 0 };
  const earTip = { L: 0, R: 0, Lv: 0, Rv: 0 };
  // tail springs (yaw sway + lift)
  let tailYaw = 0; let tailYawVel = 0;
  let tailLiftS = 0; let tailLiftVel = 0;

  function syncJawTarget() {
    if (mouthState === 'open') pose.jawOpenT = 0.5;
    else if (mouthState === 'alert') pose.jawOpenT = 0.12;
    else if (fsmState === 'chew' || fsmState === 'graze') pose.jawOpenT = 0.12;
    else pose.jawOpenT = 0;
  }

  function setState(next) {
    if (fsmState === next) { syncJawTarget(); return; }
    fsmState = next;
    let walkAmp = 0, gaitMix = 0, grazeAmt = 0, headRaise = 0, headPitch = 0;
    let earRot = 0.2, tailLift = 0.1, restShift = 0, nostril = 0.1, bodyPitch = 0;

    switch (next) {
      case 'idle': headRaise = 0.1; break;
      case 'graze': grazeAmt = 1; earRot = 0.05; tailLift = 0.05; break;
      case 'walk': walkAmp = 0.85; gaitMix = 0; earRot = 0.3; break;
      case 'trot': walkAmp = 1; gaitMix = 1; headRaise = 0.15; earRot = 0.4; nostril = 0.3; break;
      case 'canter': walkAmp = 1; gaitMix = 2; headRaise = 0.1; earRot = 0.4; tailLift = 0.3; nostril = 0.5; break;
      case 'gallop': walkAmp = 1; gaitMix = 3; headRaise = -0.05; headPitch = 0.15; earRot = -0.2; tailLift = 0.5; nostril = 1; bodyPitch = 0.02; break;
      case 'alert': headRaise = 0.55; earRot = 1; tailLift = 0.35; nostril = 0.55; break;
      case 'snort': headRaise = 0.35; earRot = 0.8; nostril = 1; snortTimer = 0; break;
      case 'chew': headRaise = 0.05; earRot = 0.1; chewPhase = 0; break;
      case 'rest': restShift = 1; headRaise = -0.12; headPitch = 0.18; earRot = -0.25; tailLift = 0.02; break;
      default: break;
    }
    pose.walkAmpT = walkAmp;
    pose.gaitMixT = gaitMix;
    pose.grazeAmtT = grazeAmt;
    pose.headRaiseT = headRaise;
    pose.headPitchT = headPitch;
    pose.earRotT = earRot;
    pose.tailLiftT = tailLift;
    pose.restShiftT = restShift;
    pose.nostrilT = nostril;
    pose.bodyPitchT = bodyPitch;
    if (next === 'chew' || next === 'graze') chewPhase = 0;
    syncJawTarget();
  }

  function smooth(cur, target, rate, dt) {
    return THREE.MathUtils.lerp(cur, target, 1 - Math.exp(-rate * dt));
  }

  /** Blend the four gait tables by pose.gaitMix (fractional between gaits). */
  function gaitParams() {
    const order = [GAITS.walk, GAITS.trot, GAITS.canter, GAITS.gallop];
    const g = THREE.MathUtils.clamp(pose.gaitMix, 0, 3);
    const i0 = Math.min(2, Math.floor(g));
    const i1 = Math.min(3, i0 + 1);
    const f = g - i0;
    const a = order[i0];
    const b = order[i1];
    const lerp = (ka, kb) => THREE.MathUtils.lerp(ka, kb, f);
    return {
      hz: lerp(a.hz, b.hz),
      lift: lerp(a.lift, b.lift),
      stride: lerp(a.stride, b.stride),
      duty: lerp(a.duty, b.duty),
      bob: lerp(a.bob, b.bob),
      roll: lerp(a.roll, b.roll),
      pitch: lerp(a.pitch, b.pitch),
      off: {
        FL: lerp(a.off.FL, b.off.FL),
        FR: lerp(a.off.FR, b.off.FR),
        HL: lerp(a.off.HL, b.off.HL),
        HR: lerp(a.off.HR, b.off.HR),
      },
    };
  }

  /**
   * Stance/swing profile for one leg: phase ∈ [0,1). Returns lift (0 on the
   * ground) + strideZ (fore/aft sweep, world-locked plant during stance: the
   * hoof sweeps BACKWARD at constant rate through stance, forward in swing).
   */
  function legCycle(phase, g) {
    const p = ((phase % 1) + 1) % 1;
    if (p < g.duty) {
      // stance: hoof planted, body passes over → sweep back linearly
      const t = p / g.duty;
      return { lift: 0, sweep: THREE.MathUtils.lerp(0.5, -0.5, t), stance: 1 - Math.abs(t - 0.5) * 2, breakover: t > 0.85 ? (t - 0.85) / 0.15 : 0 };
    }
    // swing: protract with a lifted arc
    const t = (p - g.duty) / (1 - g.duty);
    return { lift: Math.sin(t * Math.PI), sweep: THREE.MathUtils.lerp(-0.5, 0.5, t), stance: 0, breakover: 0 };
  }

  /**
   * Fetlock target (armature space) for one leg + its cycle sample.
   * fore ∈ bool, side ∈ 'L'|'R'.
   */
  function fetlockTarget(fore, side, cyc, g, amp) {
    const name = fore ? `fetlock_F_${side}` : `fetlock_H_${side}`;
    const base = bind.get(name).clone();

    if (amp > 0.001) {
      base.z += cyc.sweep * g.stride * amp;
      base.y += cyc.lift * g.lift * amp;
      // pastern sinks under load at mid-stance (fetlock drops)
      base.y -= cyc.stance * 0.028 * amp;
    }

    // graze: fore legs square, slight fore weight shift
    if (pose.grazeAmt > 0.01 && fore) base.z += pose.grazeAmt * 0.02;

    // rest: hip-shot — the LEFT hind unloads onto the toe tip
    if (!fore && side === 'L' && pose.restShift > 0.01) {
      base.y += pose.restShift * 0.055;
      base.z -= pose.restShift * 0.04;
    }
    return base;
  }

  function applyFrame(dt) {
    // -- param springs --
    pose.walkAmp = smooth(pose.walkAmp, pose.walkAmpT, externalRootMotion ? 9 : 3.2, dt);
    pose.gaitMix = smooth(pose.gaitMix, pose.gaitMixT, 2.6, dt);
    pose.grazeAmt = smooth(pose.grazeAmt, pose.grazeAmtT, 2.2, dt);
    pose.headRaise = smooth(pose.headRaise, pose.headRaiseT, 4.5, dt);
    pose.headPitch = smooth(pose.headPitch, pose.headPitchT, 4.5, dt);
    pose.headYaw = smooth(pose.headYaw, pose.headYawT, 4, dt);
    pose.earRot = smooth(pose.earRot, pose.earRotT, 6, dt);
    pose.tailLift = smooth(pose.tailLift, pose.tailLiftT, 3.5, dt);
    pose.jawOpen = smooth(pose.jawOpen, pose.jawOpenT, 8, dt);
    pose.restShift = smooth(pose.restShift, pose.restShiftT, 3, dt);
    pose.nostril = smooth(pose.nostril, pose.nostrilT, 6, dt);
    pose.bodyPitch = smooth(pose.bodyPitch, pose.bodyPitchT, 4, dt);

    ctx.model.position.set(0, 0, 0);
    resetPose();
    const rootBone = rig.rootBone;
    const g = gaitParams();

    // ---- phases ---------------------------------------------------------------
    const walking = pose.walkAmp > 0.02;
    if (walking) gaitPhase += dt * g.hz;
    if (fsmState === 'chew' || fsmState === 'graze') chewPhase += dt * Math.PI * 2 * 1.3;
    if (fsmState === 'snort') snortTimer += dt;
    const amp = pose.walkAmp;
    const strideTau = gaitPhase * Math.PI * 2;

    // ---- body: bob / roll / gallop pitch + weight shifting --------------------
    const bob = Math.abs(Math.sin(strideTau)) * -g.bob * amp;
    const sway = Math.sin(strideTau) * 0.012 * amp * (1 - pose.gaitMix * 0.25);
    const roll = Math.sin(strideTau) * g.roll * amp;
    const gallopPitch = Math.sin(strideTau) * g.pitch * amp;
    rootBone.position.x += sway;
    rootBone.position.y += bob - pose.restShift * 0.012;
    _q0.setFromAxisAngle(AXIS_Z, -roll - pose.restShift * 0.035);
    rootBone.quaternion.multiply(_q0);
    _q0.setFromAxisAngle(AXIS_X, gallopPitch + pose.bodyPitch);
    rootBone.quaternion.multiply(_q0);

    // ---- spine wave: back flexes/extends with the hind drive at speed ---------
    const spineNames = HORSE_CHAINS.spine.slice(1); // spine_0..9
    const nS = spineNames.length;
    const backWave = Math.sin(strideTau + Math.PI * 0.3) * g.pitch * 0.7 * amp;
    for (let i = 0; i < nS; i += 1) {
      const t = i / (nS - 1);
      const flex = backWave * Math.sin(t * Math.PI);
      // graze drops the base of the neck via the front thoracic vertebrae
      const grazeDip = pose.grazeAmt * Math.max(0, t - 0.55) * 0.22;
      spin(spineNames[i], AXIS_X, -(flex + grazeDip));
      // walk: slight lateral bend following the sway
      if (amp > 0.01 && pose.gaitMix < 0.5) {
        spin(spineNames[i], AXIS_Y, Math.sin(strideTau) * 0.02 * amp * Math.sin(t * Math.PI));
      }
    }

    // ---- breathing + muscle flex ----------------------------------------------
    const breathHz = 0.35 + pose.gaitMix * 0.5 + pose.nostril * 0.4;
    const breathe = frozenBreeze ? 0.5 : Math.sin(time * Math.PI * 2 * breathHz) * 0.5 + 0.5;
    B('chest').scale.setScalar(1 + breathe * 0.025);
    B('belly').scale.setScalar(1 + breathe * 0.015);
    // flank jiggle with the hind drive
    const flankFlex = walking ? Math.max(0, Math.sin(strideTau)) * 0.03 * amp : 0;
    B('flank_L').scale.setScalar(1 + flankFlex);
    B('flank_R').scale.setScalar(1 + Math.max(0, -Math.sin(strideTau)) * 0.03 * amp);
    // shoulder/haunch muscle masses slide with leg swing (skin sliding read)
    if (walking) {
      const shSlide = Math.sin(strideTau + Math.PI * (g.off.FL * 2)) * 0.02 * amp;
      B('shoulder_L').position.z += shSlide;
      B('shoulder_R').position.z -= shSlide;
      const hnSlide = Math.sin(strideTau + Math.PI * (g.off.HL * 2)) * 0.02 * amp;
      B('haunch_L').position.z += hnSlide;
      B('haunch_R').position.z -= hnSlide;
    }

    rootBone.updateMatrixWorld(true);
    ctx.model.updateMatrixWorld(true);

    // ---- legs: analytic IK -----------------------------------------------------
    const legs = [
      { fore: true, side: 'L', off: g.off.FL },
      { fore: true, side: 'R', off: g.off.FR },
      { fore: false, side: 'L', off: g.off.HL },
      { fore: false, side: 'R', off: g.off.HR },
    ];
    for (const leg of legs) {
      const cyc = legCycle(gaitPhase + leg.off, g);
      const target = fetlockTarget(leg.fore, leg.side, cyc, g, amp);
      const S = leg.side;
      if (leg.fore) {
        // knee target: above the fetlock along the bind cannon, folding back in swing
        const knee = target.clone();
        knee.y += bind.get(`carpus_${S}`).y - bind.get(`fetlock_F_${S}`).y;
        knee.z += (bind.get(`carpus_${S}`).z - bind.get(`fetlock_F_${S}`).z)
          - cyc.lift * 0.16 * amp; // carpal fold in swing
        knee.y += cyc.lift * 0.05 * amp;
        // elbow bends AFT (pole −1); scapula gets a slight stride rotation first
        spin(`scapula_${S}`, AXIS_X, cyc.sweep * 0.18 * amp);
        B(`scapula_${S}`).updateMatrixWorld(true);
        solveTwoBone(`humerus_${S}`, `radius_${S}`, `carpus_${S}`, knee, -1);
        // distal chain: knee → cannon → fetlock
        const cannonMid = target.clone();
        cannonMid.y += (bind.get(`cannon_F_${S}`).y - bind.get(`fetlock_F_${S}`).y) * 0.9;
        aimBone(`carpus_${S}`, `cannon_F_${S}`, armToWorld(cannonMid.clone().add(_v0.set(0, 0.02, 0)), new THREE.Vector3()));
        aimBone(`cannon_F_${S}`, `fetlock_F_${S}`, armToWorld(target, new THREE.Vector3()));
        // pastern: forward-down, sinking under stance load, snapping in swing
        const pastern = bind.get(`hoof_F_${S}`).clone().sub(bind.get(`fetlock_F_${S}`)).add(target);
        pastern.y = Math.max(0.03, pastern.y - cyc.stance * 0.02 + cyc.lift * 0.05);
        aimBone(`fetlock_F_${S}`, `hoof_F_${S}`, armToWorld(pastern, new THREE.Vector3()));
        // hoof: flat in stance, breakover roll at push-off, toe drop in swing
        const toe = bind.get(`hoofTip_F_${S}`).clone().sub(bind.get(`hoof_F_${S}`)).add(pastern);
        toe.y = Math.max(0.004, toe.y - 0.03 + cyc.lift * 0.03);
        aimBone(`hoof_F_${S}`, `hoofTip_F_${S}`, armToWorld(toe, new THREE.Vector3()));
        if (walking) spin(`hoof_F_${S}`, AXIS_X, cyc.breakover * 0.55 * amp);
      } else {
        // hock target derived from the fetlock along the bind cannon
        const hock = target.clone();
        hock.y += bind.get(`tarsus_${S}`).y - bind.get(`fetlock_H_${S}`).y;
        hock.z += (bind.get(`tarsus_${S}`).z - bind.get(`fetlock_H_${S}`).z)
          - cyc.lift * 0.10 * amp;
        hock.y += cyc.lift * 0.04 * amp;
        // stifle bends FORWARD (pole +1), hock folds automatically via the chain
        solveTwoBone(`femur_${S}`, `tibia_${S}`, `tarsus_${S}`, hock, 1);
        const cannonMid = target.clone();
        cannonMid.y += (bind.get(`cannon_H_${S}`).y - bind.get(`fetlock_H_${S}`).y) * 0.9;
        aimBone(`tarsus_${S}`, `cannon_H_${S}`, armToWorld(cannonMid.clone().add(_v0.set(0, 0.02, 0)), new THREE.Vector3()));
        aimBone(`cannon_H_${S}`, `fetlock_H_${S}`, armToWorld(target, new THREE.Vector3()));
        const pastern = bind.get(`hoof_H_${S}`).clone().sub(bind.get(`fetlock_H_${S}`)).add(target);
        pastern.y = Math.max(0.03, pastern.y - cyc.stance * 0.02 + cyc.lift * 0.05);
        // hip-shot rest: the resting hind tips onto the toe
        if (S === 'L' && pose.restShift > 0.01) pastern.y += pose.restShift * 0.03;
        aimBone(`fetlock_H_${S}`, `hoof_H_${S}`, armToWorld(pastern, new THREE.Vector3()));
        const toe = bind.get(`hoofTip_H_${S}`).clone().sub(bind.get(`hoof_H_${S}`)).add(pastern);
        toe.y = Math.max(0.004, toe.y - 0.03 + cyc.lift * 0.03);
        if (S === 'L' && pose.restShift > 0.01) toe.y = 0.004; // toe stays down
        aimBone(`hoof_H_${S}`, `hoofTip_H_${S}`, armToWorld(toe, new THREE.Vector3()));
        if (walking) spin(`hoof_H_${S}`, AXIS_X, cyc.breakover * 0.5 * amp);
      }
    }

    // ---- neck + head -----------------------------------------------------------
    // Walk/canter head-nod (horses nod at walk + canter, steady at trot).
    const nodGain = walking ? (pose.gaitMix < 0.5 ? 1 - pose.gaitMix : Math.max(0, pose.gaitMix - 1.5)) : 0;
    const headNod = Math.sin(strideTau) * 0.05 * amp * nodGain;
    const idleSway = frozenBreeze ? 0 : Math.sin(time * 0.6) * 0.015;
    // snort: sharp head toss up then settle
    const toss = fsmState === 'snort'
      ? Math.max(0, Math.sin(Math.min(snortTimer * 6, Math.PI))) * 0.5
      : 0;
    const neckNames = HORSE_CHAINS.neck;
    // Graze: base-weighted pitch profile so the neck EXTENDS down toward the
    // grass instead of coiling (uniform per-joint angles curl the chain).
    const grazeProfile = [0.42, 0.40, 0.36, 0.30, 0.24, 0.16, 0.10];
    for (let i = 0; i < neckNames.length; i += 1) {
      const t = (i + 1) / neckNames.length;
      const grazeArc = pose.grazeAmt * grazeProfile[i];
      const raise = -pose.headRaise * 0.10 - toss * 0.09;
      spin(neckNames[i], AXIS_X, grazeArc + raise + headNod * 0.25 * t);
      spin(neckNames[i], AXIS_Y, (pose.headYaw * 0.5 + idleSway) * t * 0.35);
    }
    // graze counter-flexes at the poll (head rotates BACK relative to the
    // steep neck) so the muzzle axis ends near-vertical on the grass — the
    // real grazing posture — instead of tucking under the chest.
    spin('head', AXIS_X, pose.grazeAmt * -1.35 + pose.headPitch * 0.6 - toss * 0.3 + headNod);
    spin('head', AXIS_Y, pose.headYaw * 0.55);

    // ---- jaw / lips / chew -----------------------------------------------------
    const chewGrind = (fsmState === 'chew' || (fsmState === 'graze' && pose.grazeAmt > 0.5))
      ? Math.sin(chewPhase) : 0;
    if (pose.jawOpen > 1e-3 || Math.abs(chewGrind) > 1e-3) {
      spin('jaw', AXIS_X, pose.jawOpen * 0.35 + Math.max(0, chewGrind) * 0.10);
      spin('jaw', AXIS_Y, chewGrind * 0.06); // lateral grind
      spin('lip_lower', AXIS_X, chewGrind * 0.2);
    }
    // prehensile upper lip wiggles while grazing
    if (pose.grazeAmt > 0.3) spin('lip_upper', AXIS_X, Math.sin(chewPhase * 1.7) * 0.18 * pose.grazeAmt);

    // ---- nostrils: flare with effort + breathing, snort pulse ------------------
    const snortPulse = fsmState === 'snort'
      ? Math.max(0, Math.sin(Math.min(snortTimer * 9, Math.PI))) : 0;
    const flare = 1 + pose.nostril * 0.35 + breathe * 0.08 * (0.4 + pose.nostril) + snortPulse * 0.4;
    B('nostril_L').scale.setScalar(flare);
    B('nostril_R').scale.setScalar(flare);

    // ---- ears: independent wander + state target + tip springs -----------------
    if (!frozenBlink) {
      earWanderTimer -= dt;
      if (earWanderTimer <= 0) {
        earWanderTimer = 0.8 + Math.random() * 2.2;
        const which = Math.random() < 0.5 ? 'L' : 'R';
        earTarget[which] = (Math.random() - 0.5) * 1.2;
      }
    }
    const er = pose.earRot;
    for (const side of ['L', 'R']) {
      const wander = frozenBlink ? 0 : earTarget[side] * 0.35 * (1 - Math.abs(er));
      spin(`ear_${side}_0`, AXIS_X, er * 0.30 - Math.max(0, -er) * 0.4);
      spin(`ear_${side}_0`, AXIS_Y, (side === 'L' ? -1 : 1) * (0.25 - er * 0.3) + wander);
      const twitch = frozenBlink ? 0 : Math.sin(time * 2.6 + (side === 'L' ? 0 : 1.7)) * 0.02;
      const targetTip = er * 0.18 + twitch + wander * 0.3;
      const k = 38, c = 8;
      earTip[`${side}v`] += (targetTip - earTip[side]) * k * dt;
      earTip[`${side}v`] *= Math.exp(-c * dt);
      earTip[side] += earTip[`${side}v`] * dt;
      spin(`ear_${side}_1`, AXIS_X, earTip[side]);
    }

    // ---- tail: spring chain (idle swish, walk counter-sway, gallop banner) -----
    const tailYawTarget = walking ? Math.sin(strideTau - 0.7) * 0.10 * amp
      : fsmState === 'idle' || fsmState === 'graze'
        ? (frozenBreeze ? 0 : Math.sin(time * 1.1) * 0.10 + Math.sin(time * 3.7) * 0.02)
        : 0;
    const kS = 22, kD = 6;
    tailYawVel += (tailYawTarget - tailYaw) * kS * dt; tailYawVel *= Math.exp(-kD * dt);
    tailYaw += tailYawVel * dt;
    tailLiftVel += (pose.tailLift - tailLiftS) * kS * dt; tailLiftVel *= Math.exp(-kD * dt);
    tailLiftS += tailLiftVel * dt;

    const tailNames = HORSE_CHAINS.tail;
    for (let i = 0; i < tailNames.length; i += 1) {
      const t = i / (tailNames.length - 1);
      // lift raises the dock; the hair mass trails with a soft lag wave
      const lag = walking ? Math.sin(strideTau - t * 2.2) * 0.03 * amp : 0;
      spin(tailNames[i], AXIS_X, -tailLiftS * (0.22 - t * 0.1) + lag);
      spin(tailNames[i], AXIS_Y, tailYaw * (0.25 + t * 0.6));
    }

    // ---- mane bones: soft lag off the neck sway --------------------------------
    const maneLag = frozenBreeze ? 0 : Math.sin(time * 1.5) * 0.02 + yawRate * -0.03;
    for (let i = 0; i < 10; i += 1) {
      spin(`mane_${i}`, AXIS_Z, maneLag * (0.4 + (i / 9) * 0.6));
    }

    // ---- eyes: blink via eye-bone squash under shader-darkened lids ------------
    if (!frozenBlink) {
      blinkTimer -= dt;
      if (blinkTimer <= 0) {
        blinkTimer = 2.6 + Math.random() * 3.5;
        blinkT = 0;
      }
      blinkT = Math.min(1, blinkT + dt * 7);
      const closed = Math.sin(Math.min(1, blinkT) * Math.PI);
      const openY = fsmState === 'rest' ? 0.4 : 1;
      B('eye_L').scale.y = openY * (1 - closed * 0.85);
      B('eye_R').scale.y = openY * (1 - closed * 0.85);
    }

    ctx.model.updateMatrixWorld(true);
    groundHooves();
    rig.skeleton.update?.();
  }

  function groundHooves() {
    ctx.model.updateMatrixWorld(true);
    let minY = Infinity;
    for (const name of HORSE_HOOF_TIPS) {
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
      const holdPose = fsmState === 'graze' || fsmState === 'rest' || fsmState === 'snort';
      if (sit) { behavior = 'sit'; setState('rest'); }
      else if (look) { behavior = 'look'; setState('alert'); }
      else if (wantsMove) {
        behavior = sprint ? 'gallop' : 'trot';
        setState(sprint ? 'gallop' : 'trot');
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
      if (fsmState === 'walk') return 1.6;
      if (fsmState === 'trot') return 3.4;
      if (fsmState === 'canter') return 6.0;
      if (fsmState === 'gallop') return 9.5;
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
        'hips', 'spine_3', 'spine_7', 'spine_9', 'chest', 'head', 'muzzle',
        'carpus_L', 'carpus_R', 'tarsus_L', 'tarsus_R',
        'hoofTip_F_L', 'hoofTip_F_R', 'hoofTip_H_L', 'hoofTip_H_R', 'tail_3',
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
          const cycle = ['idle', 'graze', 'chew', 'look', 'walk', 'trot', 'canter', 'gallop', 'walk', 'snort', 'sit'];
          const next = cycle[autopilotPhase];
          behavior = next;
          setState(BEHAVIOR_TO_STATE[next] ?? next);
          autopilotTimer = next === 'snort' ? 1.4 : 2.6 + (autopilotPhase % 3) * 0.7;
        }
      }
      if (moveIntent?.moving && (moveIntent.x * moveIntent.x + moveIntent.z * moveIntent.z) > 1e-6) {
        const targetYaw = Math.atan2(moveIntent.x, moveIntent.z);
        let dyaw = targetYaw - rootYaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        // heavier animal → slower yaw authority than the cat
        const stepv = THREE.MathUtils.clamp(dyaw * (1 - Math.exp(-2.6 * dt)), -1.8 * dt, 1.8 * dt);
        rootYaw += stepv;
        yawRate = THREE.MathUtils.lerp(yawRate, stepv / Math.max(dt, 1e-5), 1 - Math.exp(-10 * dt));
      } else {
        yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
      }
      applyFrame(Math.max(1e-4, dt));
      // When a park/studio controller owns the outer actor group, sample its
      // position into rootPos instead of stomping it back to the last setRoot.
      // Yaw still comes from the gait intent (setMoveIntent).
      if (externalRootMotion) {
        rootPos.copy(ctx.root.position);
      } else {
        ctx.root.position.copy(rootPos);
      }
      ctx.root.rotation.y = rootYaw;
    },
  };
}
