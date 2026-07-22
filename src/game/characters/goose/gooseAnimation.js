/**
 * Canada goose procedural animation — fully procedural, no baked clips.
 *
 *   - analytic multi-bone leg IK: webbed plant, toe splay, walk waddle;
 *     flight leg tuck / landing stretch / water tuck
 *   - wing fold↔extend + cyclic flap (primary spread, dihedral), glide, dive
 *   - hybrid FK/IK neck: S-curve, alert, graze, hiss reach, flight streamline
 *   - spring tail fan; procedural blink, gaze, breathing, bill gape
 *   - behavior FSM + autopilot: graze, alert, walk, hiss, swim paddle,
 *     takeoff, fly flap/glide/dive, land feet, land water
 *
 * Facade API is duck-typed to createBirdAnimation (DogSimScene contract).
 */

import * as THREE from 'three';
import { GOOSE_CHAINS } from './gooseSkeleton.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _m0 = new THREE.Matrix4();

/** Studio clip catalog for the procedural goose (shown in Dog Sim panel). */
export const GOOSE_CLIP_CATALOG = Object.freeze([
  { name: 'Idle', label: 'Idle', loop: true, behavior: 'idle' },
  { name: 'Walk', label: 'Walk', loop: true, behavior: 'walk' },
  { name: 'Hiss', label: 'Hiss', loop: true, behavior: 'hiss' },
  { name: 'Swim', label: 'Swim', loop: true, behavior: 'swim' },
  { name: 'Flap', label: 'Flap (ground)', loop: true, behavior: 'flap' },
  { name: 'Takeoff', label: 'Takeoff', loop: true, behavior: 'takeoff' },
  { name: 'Fly Flap', label: 'Fly Flap', loop: true, behavior: 'fly_flap' },
  { name: 'Fly Glide', label: 'Fly Glide', loop: true, behavior: 'fly_glide' },
  { name: 'Fly Dive', label: 'Fly Dive', loop: true, behavior: 'fly_dive' },
  { name: 'Land Feet', label: 'Land (feet)', loop: true, behavior: 'land_feet' },
  { name: 'Land Water', label: 'Land (water)', loop: true, behavior: 'land_water' },
  { name: 'Glide', label: 'Glide (perch)', loop: true, behavior: 'look' },
  { name: 'Rest Pose', label: 'Rest Pose', loop: true, behavior: 'sit' },
]);

/** Map studio behaviors → goose FSM states. */
const BEHAVIOR_TO_STATE = {
  idle: 'idle',
  walk: 'walk',
  trot: 'flap',
  flap: 'flap',
  hiss: 'hiss',
  swim: 'swim',
  takeoff: 'takeoff',
  fly_flap: 'fly_flap',
  fly_glide: 'fly_glide',
  fly_dive: 'fly_dive',
  land_feet: 'land_feet',
  land_water: 'land_water',
  look: 'alert',
  sit: 'rest',
  lie: 'rest',
};
const CLIP_TO_STATE = {
  Idle: 'idle',
  Walk: 'walk',
  Hiss: 'hiss',
  Swim: 'swim',
  Flap: 'flap',
  Takeoff: 'takeoff',
  'Fly Flap': 'fly_flap',
  'Fly Glide': 'fly_glide',
  'Fly Dive': 'fly_dive',
  'Land Feet': 'land_feet',
  'Land Water': 'land_water',
  Glide: 'glide',
  'Rest Pose': 'rest',
};
const STATE_TO_CLIP = Object.freeze({
  idle: 'Idle',
  walk: 'Walk',
  flap: 'Flap',
  hiss: 'Hiss',
  swim: 'Swim',
  takeoff: 'Takeoff',
  fly_flap: 'Fly Flap',
  fly_glide: 'Fly Glide',
  fly_dive: 'Fly Dive',
  land_feet: 'Land Feet',
  land_water: 'Land Water',
  glide: 'Glide',
  rest: 'Rest Pose',
  alert: 'Glide',
  graze: 'Idle',
});

/** States that lift off the ground plant (visual altitude via model.y). */
const AIRBORNE_STATES = new Set([
  'takeoff', 'fly_flap', 'fly_glide', 'fly_dive', 'land_feet', 'land_water',
]);
/** Active cyclic wingbeat (ground display flap or flight flap / takeoff). */
const FLAP_WING_STATES = new Set(['flap', 'fly_flap', 'takeoff']);
/** Wings fully open (glide / dive / landing flare). */
const OPEN_WING_STATES = new Set([
  'flap', 'glide', 'hiss', 'takeoff', 'fly_flap', 'fly_glide', 'fly_dive',
  'land_feet', 'land_water',
]);

/**
 * @param {{
 *   root: THREE.Group,
 *   model: THREE.Object3D,
 *   rig: ReturnType<import('./gooseSkeleton.js').createGooseSkeleton>,
 *   uniforms: import('./goosePlumage.js').GooseUniforms,
 *   feathers?: { setSpread?: (t: number) => void, setTailFan?: (t: number) => void },
 * }} ctx
 */
export function createGooseAnimation(ctx) {
  const { rig } = ctx;
  const bones = rig.bonesByName;
  const bind = rig.worldBindPos;

  // ---- bind bookkeeping ------------------------------------------------------
  /** Rest local quaternions are identity; rest local positions cached. */
  const restLocalPos = new Map();
  bones.forEach((b, name) => {
    if (name === 'Head') return;
    restLocalPos.set(name, b.position.clone());
  });

  const B = (name) => bones.get(name);

  /** Reset the whole rig to bind before layering the frame's pose. */
  function resetPose() {
    bones.forEach((b, name) => {
      if (name === 'Head') return;
      b.quaternion.identity();
      b.scale.setScalar(1);
      const p = restLocalPos.get(name);
      if (p) b.position.copy(p);
    });
  }

  /**
   * Aim `bone` so its child (bind offset) points toward targetWorld.
   * Assumes parent world matrices are current.
   */
  function aimBone(boneName, childName, targetWorld, blend = 1) {
    const bone = B(boneName);
    const parent = bone.parent;
    parent.updateWorldMatrix(true, false);
    _m0.copy(parent.matrixWorld).invert();
    const targetLocal = _v0.copy(targetWorld).applyMatrix4(_m0);
    const boneLocal = bone.position;
    const restDir = _v1.copy(bind.get(childName)).sub(bind.get(boneName));
    // rest child dir in parent space == world space at bind (identity rotations)
    const wantDir = _v2.copy(targetLocal).sub(boneLocal);
    if (wantDir.lengthSq() < 1e-10 || restDir.lengthSq() < 1e-10) return;
    _q0.setFromUnitVectors(restDir.normalize(), wantDir.normalize());
    if (blend < 1) _q0.slerp(_q1.identity(), 1 - blend);
    bone.quaternion.premultiply(_q0);
    bone.updateMatrixWorld(true);
  }

  /** Rotate a bone by axis/angle in its parent space (post-multiplied). */
  function spin(boneName, axis, angle) {
    if (Math.abs(angle) < 1e-6) return;
    const bone = B(boneName);
    _q0.setFromAxisAngle(axis, angle);
    bone.quaternion.multiply(_q0);
  }

  const AXIS_X = new THREE.Vector3(1, 0, 0);
  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const AXIS_Z = new THREE.Vector3(0, 0, 1);

  /**
   * Bind / armature-local point → current world.
   * Free-roam writes yaw+XZ on `ctx.root`; IK targets authored in bind space
   * must ride that transform or legs aim at the unrotated plant and the body
   * collapses / drags.
   */
  function armToWorld(local, out) {
    out.copy(local);
    ctx.model.localToWorld(out);
    return out;
  }

  // ---- neck: parametric S-curve ------------------------------------------------
  // Chain: spine_3 (fixed body anchor) → neck_0..11 → head. Only cervicals aim.
  const neckBindPts = GOOSE_CHAINS.neck.map((n) => bind.get(n).clone());
  const neckBase = neckBindPts[0];
  const headBind = bind.get('head');

  /**
   * Generate neck target points for pose params, blending FROM the bind
   * S-curve so params (0,0,0) reproduce bind exactly.
   * raise:  -1 graze … 0 rest … +1 alert-tall
   * reach:  forward head extension (m)
   * yaw:    gaze yaw (radians)
   * stream: 0 bind S … 1 flight streamline (neck out, head ahead of back)
   */
  function neckTargets(raise, reach, yaw, stream = 0) {
    const pts = [];
    const n = neckBindPts.length;
    // Flight head: ahead of the breast, near back height — classic goose silhouette
    // (neck straight out, not the tall standing S). Slight droop mid-neck.
    const flightHeadY = neckBase.y + 0.02;
    const flightHeadZ = neckBase.z + 0.40 + reach * 0.5;
    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1);
      const p = neckBindPts[i].clone();
      if (raise > 0) {
        // Alert: straighten the S toward a taller column, head up + slightly back.
        const straight = _v3.copy(neckBase).lerp(
          _v0.set(0, headBind.y + 0.05, neckBase.z + 0.02),
          t,
        );
        p.lerp(straight, raise * 0.85 * Math.sin(t * Math.PI * 0.5));
      } else if (raise < 0) {
        // Graze: unroll the neck forward-down toward the ground ahead.
        const g = -raise;
        const down = _v3.set(
          0,
          THREE.MathUtils.lerp(neckBase.y, 0.045, Math.pow(t, 1.35)),
          THREE.MathUtils.lerp(neckBase.z, neckBase.z + 0.34, Math.sin(t * Math.PI * 0.5) * 1.15),
        );
        p.lerp(down, g);
      }
      p.z += reach * t * t;
      if (stream > 1e-4) {
        // Unroll into a nearly-straight forward tube (ref: neck in line with body).
        // Soft-start along the chain: keep the first cervicals near the bind
        // S-curve so the breast/neck junction doesn't hinge into a white lump.
        const streamAmt = stream * THREE.MathUtils.smoothstep(t, 0.06, 0.62);
        const streamP = _v0.set(
          0,
          THREE.MathUtils.lerp(neckBase.y, flightHeadY, t)
            - Math.sin(t * Math.PI) * 0.018, // soft mid droop
          THREE.MathUtils.lerp(neckBase.z, flightHeadZ, t),
        );
        p.lerp(streamP, streamAmt);
      }
      if (Math.abs(yaw) > 1e-4) {
        const dy = p.clone().sub(neckBase);
        dy.applyAxisAngle(AXIS_Y, yaw * Math.pow(t, 1.4));
        p.copy(neckBase).add(dy);
      }
      pts.push(p);
    }
    return pts;
  }

  /**
   * Orient head in world space: bill (+Z) on the horizon along current heading,
   * crown (+Y) toward world up. Used on ground; flight uses stream + slight bill tip.
   * @param {number} billElev rad — + tips bill up, − tips bill down
   */
  function levelHeadBill(billElev = 0) {
    const head = B('head');
    const parent = head.parent;
    if (!head || !parent) return;
    parent.updateWorldMatrix(true, false);
    head.updateWorldMatrix(true, false);

    // Bill heading from current orientation → flatten to horizon.
    _v0.set(0, 0, 1).transformDirection(head.matrixWorld);
    const hx = _v0.x;
    const hz = _v0.z;
    const hLen = Math.hypot(hx, hz);
    if (hLen < 1e-6) _v0.set(0, 0, 1);
    else _v0.set(hx / hLen, 0, hz / hLen);

    const ce = Math.cos(billElev);
    const se = Math.sin(billElev);
    const wantFwd = _v1.set(_v0.x * ce, se, _v0.z * ce).normalize();
    const wantRight = _v2.set(0, 1, 0).cross(wantFwd);
    if (wantRight.lengthSq() < 1e-8) wantRight.set(1, 0, 0);
    else wantRight.normalize();
    const wantUp = _v0.copy(wantFwd).cross(wantRight).normalize();

    _m0.makeBasis(wantRight, wantUp, wantFwd);
    _q0.setFromRotationMatrix(_m0);
    _q1.setFromRotationMatrix(
      new THREE.Matrix4().extractRotation(parent.matrixWorld),
    );
    head.quaternion.copy(_q1).invert().multiply(_q0).normalize();
    head.updateMatrixWorld(true);
  }

  function applyNeck(raise, reach, yaw, headPitchExtra = 0, stream = 0) {
    const targets = neckTargets(raise, reach, yaw, stream);
    // Aim neck_0 → head only. Never rotate spine_3 — that bone owns the breast
    // mesh, and aiming it at a streamed neck_0 ballooned a white lump at the
    // collar during flight. Body stays put; cervicals carry the pose.
    // GOOSE_CHAINS.neck = [spine_3, neck_0..11, head]
    for (let i = 1; i < GOOSE_CHAINS.neck.length - 1; i += 1) {
      const boneName = GOOSE_CHAINS.neck[i];
      const childName = GOOSE_CHAINS.neck[i + 1];
      if (!childName) break;
      aimBone(boneName, childName, armToWorld(targets[i + 1], _v3));
    }
    // headPitchExtra > 0 tips bill down. Flight stream: hold bill nearly level
    // with the extended neck (parallel to the back), slight natural droop.
    levelHeadBill(-headPitchExtra);
  }

  // ---- legs: analytic IK ---------------------------------------------------------
  /**
   * Place a foot: aim femur→knee and tibia→ankle so the ankle lands at
   * `ankleLocal` (armature/bind space), then plant/roll the toes.
   * @param {boolean} [streamAft] flight trail — webs hang further back along −Z
   */
  function solveLeg(side, ankleLocal, footRoll = 0, toeSplay = 0, streamAft = false) {
    const hipName = `femur_${side}`;
    const kneeName = `tibia_${side}`;
    const ankleName = `Foot_${side}`;

    const hip = bind.get(hipName);
    const L1 = bind.get(kneeName).clone().sub(hip).length();
    const L2 = bind.get(ankleName).clone().sub(bind.get(kneeName)).length();

    B(hipName).parent.updateWorldMatrix(true, false);
    const hipWorld = B(hipName).getWorldPosition(new THREE.Vector3());
    const ankleWorld = armToWorld(ankleLocal, new THREE.Vector3());

    // Two-bone IK; knee pole uses body-forward (+Z) so the chain stays sagittal.
    const toTarget = ankleWorld.clone().sub(hipWorld);
    const dist = Math.min(toTarget.length(), (L1 + L2) * 0.999);
    const a = Math.acos(THREE.MathUtils.clamp(
      (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1));
    const dir = toTarget.clone().normalize();
    const pole = armToWorld(_v0.set(0, 0, 1), new THREE.Vector3())
      .sub(armToWorld(_v1.set(0, 0, 0), new THREE.Vector3()))
      .normalize();
    if (pole.lengthSq() < 1e-8) pole.set(0, 0, 1);
    const bendAxis = _v1.crossVectors(dir, pole).normalize();
    if (bendAxis.lengthSq() < 1e-8) bendAxis.set(1, 0, 0);
    // Flight trail: reverse bend so the "knee" sits above the trailing line
    // instead of bulging forward under the belly.
    const kneeDir = dir.clone().applyAxisAngle(bendAxis, streamAft ? a : -a);
    const kneeWorld = hipWorld.clone().addScaledVector(kneeDir, L1);

    aimBone(hipName, kneeName, kneeWorld);
    aimBone(kneeName, ankleName, ankleWorld);

    // Plant: vertical column + push-off roll. Flight: stream webs further aft (−Z).
    const ballBind = bind.get(`Toes_${side}`).clone().sub(bind.get(ankleName));
    let ballLocal;
    if (streamAft) {
      // Hang toes back toward the rectrices, close to the ankle x.
      ballLocal = ankleLocal.clone().add(new THREE.Vector3(0, -0.04, -0.09));
    } else {
      ballLocal = ankleLocal.clone().add(
        new THREE.Vector3(0, ballBind.y, ballBind.z * Math.cos(footRoll)),
      );
      ballLocal.y = Math.max(0.012, ballLocal.y - Math.sin(footRoll) * 0.02);
    }
    aimBone(ankleName, `Toes_${side}`, armToWorld(ballLocal, new THREE.Vector3()));
    if (streamAft) {
      // Point the whole web aft; close lateral fans.
      spin(`Toes_${side}`, AXIS_X, 0.9);
      spin(`toe_in_${side}`, AXIS_Y, side === 'L' ? 0.15 : -0.15);
      spin(`toe_out_${side}`, AXIS_Y, side === 'L' ? -0.15 : 0.15);
    } else {
      if (footRoll > 0.001) spin(`Toes_${side}`, AXIS_X, -footRoll * 0.8);
      if (Math.abs(toeSplay) > 0.001) {
        spin(`toe_in_${side}`, AXIS_Y, side === 'L' ? toeSplay : -toeSplay);
        spin(`toe_out_${side}`, AXIS_Y, side === 'L' ? -toeSplay : toeSplay);
      }
    }
  }

  // ---- wings: fold ↔ extend + flap ----------------------------------------------
  /** Extended-pose armature-local targets per wing joint (span ~1.55 m total). */
  function wingTargets(side, flapAngle, spread) {
    const s = side === 'L' ? 1 : -1;
    const sh = bind.get(`shoulder_${side}`).clone();
    const roll = flapAngle; // + up, - down (about the body Z axis at shoulder)
    const dihedral = 0.12 + roll;
    const e = sh.clone().add(new THREE.Vector3(s * 0.24 * Math.cos(dihedral), 0.24 * Math.sin(dihedral), -0.015));
    const w = e.clone().add(new THREE.Vector3(s * 0.26 * Math.cos(roll * 1.15), 0.26 * Math.sin(roll * 1.15), 0.02 * spread));
    const h = w.clone().add(new THREE.Vector3(s * 0.24 * Math.cos(roll * 1.3), 0.24 * Math.sin(roll * 1.3), -0.03));
    const tip = h.clone().add(new THREE.Vector3(s * 0.16 * Math.cos(roll * 1.45), 0.16 * Math.sin(roll * 1.45), -0.05 - 0.05 * spread));
    return { elbow: e, wrist: w, hand: h, tip };
  }

  /** openT: 0 folded (bind) … 1 extended. */
  function applyWing(side, openT, flapAngle, spread) {
    if (openT < 1e-3) return; // folded == bind
    const t = wingTargets(side, flapAngle, spread);
    const chain = [
      [`shoulder_${side}`, `wing_0_${side}`, t.elbow],
      [`wing_0_${side}`, `wing_1_${side}`, t.wrist],
      [`wing_1_${side}`, `wing_2_${side}`, t.hand],
      [`wing_2_${side}`, `wing_tip_${side}`, t.tip],
    ];
    for (const [boneName, childName, target] of chain) {
      const bindChild = bind.get(childName).clone();
      const blended = bindChild.lerp(target, openT);
      aimBone(boneName, childName, armToWorld(blended, _v3));
    }
  }

  // ---- state -----------------------------------------------------------------------
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
  let clipDriven = true; // studio always sets true for birds; we stay procedural
  let externalRootMotion = false;
  /**
   * When non-null (e.g. dog-park controller owns world altitude on root.y),
   * model.position.y is forced to this value instead of pose.flyHeight.
   * @type {number | null}
   */
  let flightAltitudeOverride = null;
  /** @type {{ x: number, z: number, moving: boolean } | null} */
  let moveIntent = null;

  // continuous pose params (spring-smoothed toward state targets)
  const pose = {
    neckRaise: 0, neckRaiseT: 0,
    neckReach: 0, neckReachT: 0,
    gazeYaw: 0, gazeYawT: 0,
    wingOpen: 0, wingOpenT: 0,
    crouch: 0, crouchT: 0,
    walkAmp: 0, walkAmpT: 0,
    billOpen: 0, billOpenT: 0,
    headPitch: 0, headPitchT: 0,
    bodyPitch: 0, bodyPitchT: 0,
    /** 0 = standing S-curve, 1 = flight streamline (neck out, head ahead of back). */
    neckStream: 0, neckStreamT: 0,
    /** 0 = plant stance, 1 = flight trail (feet hanging aft in line with the tail). */
    legTuck: 0, legTuckT: 0,
    /** Visual altitude above plant (m); airborne states hold the bird off floor. */
    flyHeight: 0, flyHeightT: 0,
    /** Surface-swim foot paddle amplitude. */
    paddleAmp: 0, paddleAmpT: 0,
  };
  let gaitPhase = 0;
  let flapPhase = 0;
  let hissPhase = 0;
  let paddlePhase = 0;
  let blinkTimer = 1.6;
  let blinkT = 1; // 1 = open
  // tail spring
  let tailYaw = 0; let tailYawVel = 0;
  let tailLift = 0; let tailLiftVel = 0;

  function syncBillTarget() {
    // Hiss forces a wide gape; mouth UI can open the bill for pant/alert.
    if (fsmState === 'hiss') pose.billOpenT = 1;
    else if (mouthState === 'open') pose.billOpenT = 0.62;
    else if (mouthState === 'alert') pose.billOpenT = 0.22;
    else pose.billOpenT = 0;
  }

  /**
   * Pose targets per FSM state. Flight states set leg tuck + altitude so
   * studio/free-roam can preview takeoff / cruise / dive / land without clips.
   */
  function setState(next) {
    if (fsmState === next) {
      syncBillTarget();
      return;
    }
    fsmState = next;

    // Defaults (ground idle)
    let neckRaise = 0;
    let neckReach = 0;
    let neckStream = 0;
    let wingOpen = 0;
    let crouch = 0;
    let walkAmp = 0;
    let headPitch = 0;
    let bodyPitch = 0;
    let legTuck = 0;
    let flyHeight = 0;
    let paddleAmp = 0;

    switch (next) {
      case 'alert':
        neckRaise = 0.85;
        break;
      case 'graze':
        neckRaise = -1;
        neckReach = 0.05;
        break;
      case 'rest':
        neckRaise = -0.12;
        crouch = 1;
        break;
      case 'walk':
        walkAmp = 1;
        break;
      case 'hiss':
        neckRaise = 0.42;
        neckReach = 0.16;
        wingOpen = 0.48;
        crouch = 0.12;
        headPitch = 0.35;
        bodyPitch = 0.12;
        break;
      case 'flap': // ground display flap
        neckRaise = 0.55;
        neckReach = 0.03;
        wingOpen = 1;
        headPitch = 0.05;
        bodyPitch = -0.06;
        break;
      case 'glide': // perched / display wings open
        wingOpen = 1;
        neckRaise = 0.2;
        break;
      case 'swim':
        neckRaise = 0.2;
        crouch = 0.55;
        legTuck = 0.35;
        flyHeight = 0.02;
        paddleAmp = 1;
        break;
      case 'takeoff':
        // Neck streams forward in line with the body (ref: flight silhouette).
        neckStream = 0.9;
        neckReach = 0.04;
        wingOpen = 1;
        legTuck = 0.75;
        flyHeight = 0.55;
        headPitch = 0.08; // bill slightly down along the neck line
        bodyPitch = -0.28;
        break;
      case 'fly_flap':
        neckStream = 1;
        neckReach = 0.02;
        wingOpen = 1;
        legTuck = 1;
        flyHeight = 1.05;
        headPitch = 0.1;
        bodyPitch = -0.05;
        break;
      case 'fly_glide':
        neckStream = 1;
        neckReach = 0.02;
        wingOpen = 1;
        legTuck = 1;
        flyHeight = 1.1;
        headPitch = 0.08;
        bodyPitch = -0.03;
        break;
      case 'fly_dive':
        neckStream = 1;
        neckReach = 0.06;
        wingOpen = 0.92;
        legTuck = 1;
        flyHeight = 0.85;
        headPitch = 0.35; // bill tips with the dive
        bodyPitch = 0.72;
        break;
      case 'land_feet':
        neckStream = 0.75;
        neckReach = 0.03;
        wingOpen = 0.88;
        legTuck = 0.08;
        flyHeight = 0.22;
        headPitch = 0.12;
        bodyPitch = 0.18;
        break;
      case 'land_water':
        neckStream = 0.85;
        neckReach = 0.03;
        wingOpen = 0.72;
        legTuck = 1;
        flyHeight = 0.1;
        headPitch = 0.1;
        bodyPitch = 0.1;
        crouch = 0.2;
        break;
      default:
        break;
    }

    pose.neckRaiseT = neckRaise;
    pose.neckReachT = neckReach;
    pose.neckStreamT = neckStream;
    pose.wingOpenT = wingOpen;
    pose.crouchT = crouch;
    pose.walkAmpT = walkAmp;
    pose.headPitchT = headPitch;
    pose.bodyPitchT = bodyPitch;
    pose.legTuckT = legTuck;
    pose.flyHeightT = flyHeight;
    pose.paddleAmpT = paddleAmp;

    if (FLAP_WING_STATES.has(next)) flapPhase = 0;
    if (next === 'hiss') hissPhase = 0;
    if (next === 'swim') paddlePhase = 0;
    syncBillTarget();
  }

  function smooth(cur, target, rate, dt) {
    return THREE.MathUtils.lerp(cur, target, 1 - Math.exp(-rate * dt));
  }

  function applyFrame(dt) {
    // -- param springs --
    pose.neckRaise = smooth(pose.neckRaise, pose.neckRaiseT, 4.5, dt);
    pose.neckReach = smooth(pose.neckReach, pose.neckReachT, 4.5, dt);
    pose.gazeYaw = smooth(pose.gazeYaw, pose.gazeYawT, 3.5, dt);
    pose.wingOpen = smooth(pose.wingOpen, pose.wingOpenT, 3.2, dt);
    pose.crouch = smooth(pose.crouch, pose.crouchT, 3.0, dt);
    // Free-roam needs a snappy walk blend so the first steps don't look slumped.
    pose.walkAmp = smooth(
      pose.walkAmp,
      pose.walkAmpT,
      externalRootMotion ? 10 : 3.5,
      dt,
    );
    pose.billOpen = smooth(pose.billOpen, pose.billOpenT, 8, dt);
    pose.headPitch = smooth(pose.headPitch, pose.headPitchT, 5, dt);
    pose.bodyPitch = smooth(pose.bodyPitch, pose.bodyPitchT, 4, dt);
    pose.neckStream = smooth(pose.neckStream, pose.neckStreamT, 4.0, dt);
    pose.legTuck = smooth(pose.legTuck, pose.legTuckT, 4.0, dt);
    pose.flyHeight = smooth(pose.flyHeight, pose.flyHeightT, 3.2, dt);
    pose.paddleAmp = smooth(pose.paddleAmp, pose.paddleAmpT, 4.0, dt);

    // Clear plant offset; airborne states re-apply flyHeight after pose.
    ctx.model.position.set(0, 0, 0);

    resetPose();
    const rootBone = rig.rootBone;

    // ---- phases ------------------------------------------------------------------
    const walking = pose.walkAmp > 0.02;
    const flapping = FLAP_WING_STATES.has(fsmState) && pose.wingOpen > 0.15;
    const hissing = fsmState === 'hiss';
    const swimming = pose.paddleAmp > 0.05;
    const airborne = AIRBORNE_STATES.has(fsmState) || pose.flyHeight > 0.08;
    const stepHz = 2.1;
    if (walking) gaitPhase += dt * Math.PI * 2 * stepHz;
    if (hissing) hissPhase += dt * Math.PI * 2 * 3.2;
    if (FLAP_WING_STATES.has(fsmState)) {
      const hz = fsmState === 'takeoff' ? 3.4 : fsmState === 'fly_flap' ? 2.9 : 2.6;
      flapPhase += dt * Math.PI * 2 * hz;
    }
    if (swimming) paddlePhase += dt * Math.PI * 2 * 1.7;
    const phL = gaitPhase;
    const phR = gaitPhase + Math.PI;
    const amp = pose.walkAmp;
    const tuck = pose.legTuck;

    // Waddle / flap heave / dive bank
    const sway = Math.sin(gaitPhase) * 0.055 * amp;
    const rollA = Math.sin(gaitPhase) * 0.115 * amp;
    const yawWag = Math.sin(gaitPhase) * 0.07 * amp;
    const bob = Math.abs(Math.cos(gaitPhase)) * -0.008 * amp;
    const flapBob = flapping ? Math.sin(flapPhase) * 0.022 * pose.wingOpen : 0;
    const hissShake = hissing ? Math.sin(hissPhase) * 0.012 : 0;
    const diveBank = fsmState === 'fly_dive' ? Math.sin(time * 1.1) * 0.06 : 0;

    rootBone.position.x += sway * 0.4 + hissShake * 0.35;
    rootBone.position.y += bob - pose.crouch * 0.16 + flapBob;
    _q0.setFromAxisAngle(AXIS_Z, -rollA + diveBank + (hissing ? Math.sin(hissPhase * 0.5) * 0.04 : 0));
    rootBone.quaternion.multiply(_q0);
    _q0.setFromAxisAngle(AXIS_Y, yawWag);
    rootBone.quaternion.multiply(_q0);
    if (Math.abs(pose.bodyPitch) > 1e-4) {
      _q0.setFromAxisAngle(AXIS_X, pose.bodyPitch);
      rootBone.quaternion.multiply(_q0);
    }
    // Breathing: subtle chest swell (crop + keel scale).
    const breathe = frozenBreeze ? 0 : Math.sin(time * 2.2) * 0.5 + 0.5;
    B('spine_1').scale.setScalar(1 + breathe * 0.012 * (airborne ? 0.6 : 1));
    rootBone.updateMatrixWorld(true);
    ctx.model.updateMatrixWorld(true);

    // ---- legs --------------------------------------------------------------------
    // plant (walk) · paddle (swim) · trail aft under tail (flight) · extend (land feet)
    const tail1 = bind.get('tail_1');
    const tail2 = bind.get('tail_2');
    for (const [side, ph] of [['L', phL], ['R', phR]]) {
      const ankleBind = bind.get(`Foot_${side}`);
      const hipBind = bind.get(`femur_${side}`);
      const s = side === 'L' ? 1 : -1;

      // Plant / walk target in armature space
      const lift = Math.max(0, Math.sin(ph)) * 0.052 * amp;
      const strideZ = -Math.cos(ph) * 0.075 * amp;
      const plant = new THREE.Vector3(
        ankleBind.x + sway * 0.15,
        Math.max(0.045, ankleBind.y + lift),
        ankleBind.z + (walking ? strideZ : 0),
      );

      // Flight trail: feet hang BACK in line with the tail (not under the belly).
      // Waterfowl stream tarsi aft under the caudal axis, nearly on the midline.
      const trailZ = THREE.MathUtils.lerp(tail1.z, tail2.z, 0.75); // ~-0.28, under rectrices
      const trailY = THREE.MathUtils.lerp(tail1.y, tail2.y, 0.4) - 0.04; // hang just below tail
      const tucked = new THREE.Vector3(
        s * 0.008,
        trailY,
        trailZ,
      );

      // Landing feet-out: stretch slightly forward/down of plant for reach
      const landReach = new THREE.Vector3(
        ankleBind.x * 1.05,
        Math.max(0.02, ankleBind.y * 0.55),
        ankleBind.z + 0.05,
      );

      // Swim paddle: alternate feet under the body, pushing aft
      const paddlePh = side === 'L' ? paddlePhase : paddlePhase + Math.PI;
      const paddle = new THREE.Vector3(
        hipBind.x * 0.7,
        Math.max(0.02, hipBind.y - 0.12 + Math.max(0, Math.sin(paddlePh)) * 0.04),
        hipBind.z + 0.02 - Math.cos(paddlePh) * 0.07 * pose.paddleAmp,
      );

      let targetLocal;
      if (swimming && tuck < 0.55) {
        targetLocal = plant.clone().lerp(paddle, pose.paddleAmp);
      } else if (fsmState === 'land_feet') {
        // Blend trail→extended reach as legTuck drops
        targetLocal = landReach.clone().lerp(tucked, tuck);
      } else if (tuck > 0.02) {
        targetLocal = plant.clone().lerp(tucked, tuck);
      } else {
        targetLocal = plant;
      }

      const streamAft = tuck > 0.45 && !swimming;
      const roll = walking && tuck < 0.2
        ? Math.max(0, -Math.sin(ph)) * 0.5 * amp
        : 0;
      const splay = walking && tuck < 0.2
        ? Math.max(0, Math.sin(ph)) * 0.18
        : swimming ? 0.12 : 0;
      solveLeg(side, targetLocal, roll, splay, streamAft);
    }

    // ---- neck + head-bob -----------------------------------------------------------
    let bobReach = 0;
    if (walking) {
      const c = (gaitPhase / (Math.PI * 2)) % 1;
      const snap = THREE.MathUtils.smoothstep(c, 0.62, 0.86);
      bobReach = (snap - 0.5) * 0.028 * amp;
    }
    const idleSway = frozenBreeze ? 0 : Math.sin(time * 0.9) * 0.012;
    const hissReachPulse = hissing ? Math.sin(hissPhase) * 0.018 : 0;
    const hissYawWobble = hissing ? Math.sin(hissPhase * 0.7) * 0.06 : 0;
    applyNeck(
      pose.neckRaise,
      pose.neckReach + bobReach + hissReachPulse
        + (fsmState === 'idle' ? idleSway * 0.4 : 0),
      pose.gazeYaw + hissYawWobble,
      pose.headPitch,
      pose.neckStream,
    );

    // ---- bill (jaw) ----------------------------------------------------------------
    if (pose.billOpen > 1e-3 && B('jaw')) {
      const gape = pose.billOpen * (hissing ? 0.72 : 0.48);
      const pulse = hissing ? 1 + Math.sin(hissPhase * 1.3) * 0.08 : 1;
      spin('jaw', AXIS_X, gape * pulse);
    }

    // ---- wings -----------------------------------------------------------------------
    if (pose.wingOpen > 1e-3) {
      let flapAngle = 0.22;
      let spread = 0.55;
      if (fsmState === 'fly_flap' || fsmState === 'takeoff') {
        // Powerful flight / takeoff beat
        const power = fsmState === 'takeoff' ? 1.15 : 1.0;
        flapAngle = Math.sin(flapPhase) * 1.15 * power;
        spread = 0.75 + 0.25 * Math.max(0, Math.sin(flapPhase - 0.55));
      } else if (fsmState === 'flap') {
        flapAngle = Math.sin(flapPhase) * 1.05;
        spread = 0.7 + 0.3 * Math.max(0, Math.sin(flapPhase - 0.55));
      } else if (fsmState === 'fly_glide' || fsmState === 'glide') {
        flapAngle = 0.16 + (frozenBreeze ? 0 : Math.sin(time * 1.2) * 0.04);
        spread = 1;
      } else if (fsmState === 'fly_dive') {
        // Wings partially folded back, slight dihedral flutter
        flapAngle = -0.35 + Math.sin(time * 4.5) * 0.06;
        spread = 0.35;
      } else if (fsmState === 'land_feet' || fsmState === 'land_water') {
        // Landing flare: high angle of attack, broad spread
        flapAngle = 0.55 + Math.sin(time * 2.2) * 0.08;
        spread = fsmState === 'land_water' ? 0.7 : 0.9;
      } else if (fsmState === 'hiss') {
        flapAngle = 0.28 + Math.sin(hissPhase * 0.9) * 0.1;
        spread = 0.45 + Math.sin(hissPhase * 0.55) * 0.08;
      }
      applyWing('L', pose.wingOpen, flapAngle, spread);
      applyWing('R', pose.wingOpen, flapAngle, spread);
      ctx.feathers?.setSpread?.(pose.wingOpen * spread);
    } else {
      ctx.feathers?.setSpread?.(0);
    }

    // ---- tail spring ---------------------------------------------------------------
    const tailYawTarget = walking ? Math.sin(gaitPhase - 0.9) * 0.14 * amp
      : hissing ? Math.sin(hissPhase * 0.4) * 0.1
        : fsmState === 'fly_dive' ? Math.sin(time * 2) * 0.08
          : 0;
    const tailLiftTarget = pose.crouch * 0.25
      + (FLAP_WING_STATES.has(fsmState) ? 0.35 : 0)
      + (fsmState === 'fly_glide' ? 0.15 : 0)
      + (fsmState === 'fly_dive' ? -0.2 : 0)
      + (hissing ? 0.4 : 0)
      + (fsmState === 'land_feet' || fsmState === 'land_water' ? 0.25 : 0);
    const kSpring = 26; const kDamp = 7.5;
    tailYawVel += (tailYawTarget - tailYaw) * kSpring * dt; tailYawVel *= Math.exp(-kDamp * dt);
    tailYaw += tailYawVel * dt;
    tailLiftVel += (tailLiftTarget - tailLift) * kSpring * dt; tailLiftVel *= Math.exp(-kDamp * dt);
    tailLift += tailLiftVel * dt;
    spin('tail_0', AXIS_Y, tailYaw * 0.5);
    spin('tail_1', AXIS_Y, tailYaw * 0.35);
    spin('tail_2', AXIS_Y, tailYaw * 0.25);
    spin('tail_0', AXIS_X, -tailLift * 0.4);
    spin('tail_1', AXIS_X, -tailLift * 0.3);
    ctx.feathers?.setTailFan?.(Math.min(
      1,
      Math.abs(tailYawVel) * 2
        + (FLAP_WING_STATES.has(fsmState) ? 0.55 : 0)
        + (fsmState === 'fly_glide' ? 0.35 : 0)
        + (hissing ? 0.65 : 0),
    ));

    // ---- blink ---------------------------------------------------------------------
    if (!frozenBlink) {
      blinkTimer -= dt;
      if (blinkTimer <= 0) {
        blinkTimer = 1.8 + Math.random() * 3.2;
        blinkT = 0;
      }
      blinkT = Math.min(1, blinkT + dt * 9);
      const closed = Math.sin(Math.min(1, blinkT) * Math.PI);
      B('eye_L').scale.y = 1 - closed * 0.85;
      B('eye_R').scale.y = 1 - closed * 0.85;
    }

    ctx.model.updateMatrixWorld(true);
    // Altitude: park controller may own world Y on root (override=0 on model).
    // Studio free-roam uses pose.flyHeight on the armature.
    if (flightAltitudeOverride != null) {
      ctx.model.position.y = flightAltitudeOverride;
      ctx.model.updateMatrixWorld(true);
    } else if (fsmState === 'swim') {
      ctx.model.position.y = pose.flyHeight;
      ctx.model.updateMatrixWorld(true);
    } else if (airborne || pose.flyHeight > 0.05) {
      ctx.model.position.y = pose.flyHeight;
      ctx.model.updateMatrixWorld(true);
    } else if (tuck < 0.45) {
      groundFeet();
    }
    rig.skeleton.update?.();
  }

  function groundFeet() {
    // model.position was cleared at the start of applyFrame; this is a
    // one-shot plant for the posed frame (not an accumulator).
    ctx.model.updateMatrixWorld(true);
    let minY = Infinity;
    for (const name of ['Toes_tip_L', 'Toes_tip_R', 'Toes_L', 'Toes_R']) {
      const b = B(name);
      if (!b) continue;
      b.getWorldPosition(_v0);
      // Web pads sit a few mm below the ball joint.
      minY = Math.min(minY, _v0.y - 0.006);
    }
    if (!Number.isFinite(minY)) return;
    if (Math.abs(minY) < 5e-4) return;
    ctx.model.position.y = -minY;
    ctx.model.updateMatrixWorld(true);
  }

  // ---- facade ---------------------------------------------------------------------
  return {
    setBehavior(id) {
      behavior = String(id ?? 'idle');
      setState(BEHAVIOR_TO_STATE[behavior] ?? behavior);
      currentClip = STATE_TO_CLIP[fsmState] ?? 'Idle';
    },
    getBehavior: () => behavior,
    setAutopilot(on) {
      autopilot = Boolean(on);
      autopilotTimer = 0;
    },
    getAutopilot: () => autopilot,
    /**
     * Studio / free-roam locomotion (mirrors dogAnimation.setMoveIntent).
     */
    setMoveIntent({
      x = 0,
      z = 0,
      sprint = false,
      moving = null,
      sit = false,
      look = false,
    } = {}) {
      autopilot = false;
      const hasDirection = x * x + z * z > 1e-6;
      const wantsMove = moving ?? hasDirection;
      moveIntent = hasDirection || wantsMove
        ? { x, z, moving: wantsMove }
        : null;
      // Free-roam locomotion only overrides when not in a display / flight pose.
      const holdPose = fsmState === 'hiss'
        || FLAP_WING_STATES.has(fsmState)
        || AIRBORNE_STATES.has(fsmState)
        || fsmState === 'swim'
        || fsmState === 'glide';
      if (sit) {
        behavior = 'sit';
        setState('rest');
      } else if (look) {
        behavior = 'look';
        setState('alert');
      } else if (wantsMove && !AIRBORNE_STATES.has(fsmState) && fsmState !== 'swim') {
        // Ground free-roam: walk only (flight poses are studio-selected).
        behavior = 'walk';
        setState('walk');
        if (sprint) pose.walkAmpT = 1;
      } else if (!wantsMove && !holdPose) {
        behavior = 'idle';
        setState('idle');
      }
      currentClip = STATE_TO_CLIP[fsmState] ?? 'Idle';
    },
    setExternalRootMotion(on) { externalRootMotion = Boolean(on); },
    getExternalRootMotion: () => externalRootMotion,
    /**
     * Park: pass 0 so flight altitude lives on root.y (not double-applied on model).
     * Studio: leave null to use pose.flyHeight.
     * @param {number | null} y
     */
    setFlightAltitudeOverride(y) {
      flightAltitudeOverride = y == null ? null : Number(y) || 0;
    },
    getFlightAltitudeOverride: () => flightAltitudeOverride,
    setMouthState(id) {
      mouthState = String(id ?? 'closed');
      syncBillTarget();
    },
    getMouthState: () => mouthState,
    setTime(t) { time = Number(t) || 0; },
    getTime: () => time,
    setRootPosition(x, y, z) {
      rootPos.set(x, y, z);
      ctx.root.position.copy(rootPos);
    },
    getRootPosition: () => rootPos.clone(),
    setRootYaw(yaw) {
      rootYaw = Number(yaw) || 0;
      ctx.root.rotation.y = rootYaw;
    },
    getRootYaw: () => rootYaw,
    getYawRate: () => yawRate,
    getMoveSpeed: () => {
      if (fsmState === 'walk') return 0.42;
      if (fsmState === 'swim') return 0.28;
      if (fsmState === 'takeoff' || fsmState === 'fly_flap') return 1.4;
      if (fsmState === 'fly_glide') return 1.1;
      if (fsmState === 'fly_dive') return 1.8;
      if (fsmState === 'land_feet' || fsmState === 'land_water') return 0.5;
      if (fsmState === 'flap') return 0.55;
      return 0;
    },
    setFrozenBlink(on) {
      frozenBlink = Boolean(on);
      if (frozenBlink) {
        B('eye_L').scale.y = 1;
        B('eye_R').scale.y = 1;
      }
    },
    setFrozenBreeze(on) { frozenBreeze = Boolean(on); },
    isFrozenBreeze: () => frozenBreeze,
    isFrozenBlink: () => frozenBlink,
    setClipDriven(on) { clipDriven = Boolean(on); },
    getClipDriven: () => clipDriven,
    applyPostClipOverlays() {
      if (flightAltitudeOverride != null) {
        ctx.model.position.y = flightAltitudeOverride;
        ctx.model.updateMatrixWorld(true);
      } else if (AIRBORNE_STATES.has(fsmState) || pose.flyHeight > 0.05) {
        ctx.model.position.y = pose.flyHeight;
        ctx.model.updateMatrixWorld(true);
      } else if (pose.legTuck < 0.45) {
        groundFeet();
      }
    },
    playClip(name) {
      const state = CLIP_TO_STATE[name];
      if (!state) return false;
      currentClip = name;
      // Mirror behavior id for studio buttons / free-roam display.
      behavior = state === 'flap' ? 'trot'
        : state === 'glide' ? 'look'
          : state === 'rest' ? 'sit'
            : state === 'alert' ? 'look'
              : state;
      setState(state);
      return true;
    },
    getCurrentClip: () => currentClip ?? STATE_TO_CLIP[fsmState] ?? 'Idle',
    /** Poser hook for harness/gaze tweaking. */
    setGazeYaw(yaw) { pose.gazeYawT = THREE.MathUtils.clamp(Number(yaw) || 0, -1.2, 1.2); },
    setNeckRaise(v) { pose.neckRaiseT = THREE.MathUtils.clamp(Number(v) || 0, -1, 1); },
    getState: () => fsmState,
    getCoreBounds() {
      const names = [
        'hips', 'spine_0', 'spine_2', 'head', 'neck_5',
        'Foot_L', 'Foot_R', 'Toes_tip_L', 'Toes_tip_R', 'tail_1',
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
          autopilotPhase = (autopilotPhase + 1) % 10;
          // Ground life + a short flight loop so autopilot demos takeoff→cruise→land.
          const cycle = [
            'idle', 'graze', 'walk', 'alert',
            'takeoff', 'fly_flap', 'fly_glide', 'fly_dive',
            'land_feet', 'idle',
          ];
          const next = cycle[autopilotPhase];
          behavior = next;
          setState(next);
          autopilotTimer = next.startsWith('fly') || next === 'takeoff' || next.startsWith('land')
            ? 2.0
            : 2.6 + (autopilotPhase % 3) * 0.7;
        }
      }
      if (moveIntent?.moving && (moveIntent.x * moveIntent.x + moveIntent.z * moveIntent.z) > 1e-6) {
        const targetYaw = Math.atan2(moveIntent.x, moveIntent.z);
        let dyaw = targetYaw - rootYaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        const step = THREE.MathUtils.clamp(dyaw * (1 - Math.exp(-3.0 * dt)), -2.0 * dt, 2.0 * dt);
        rootYaw += step;
        yawRate = THREE.MathUtils.lerp(yawRate, step / Math.max(dt, 1e-5), 1 - Math.exp(-10 * dt));
      } else {
        yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
      }
      applyFrame(Math.max(1e-4, dt));
      ctx.root.position.copy(rootPos);
      ctx.root.rotation.y = rootYaw;
    },
  };
}
