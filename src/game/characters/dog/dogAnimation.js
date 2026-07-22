/**
 * Procedural dog animation via local-joint additives on the standing rest pose.
 * Rest pose is reset every tick; additives accumulate (never re-copy rest mid-frame).
 * Joint pitch is bone-local X — chains are authored with only X rest bends so
 * local Rx ≈ world pitch (swing forward/back).
 */

import * as THREE from 'three';
import {
  DOG_LEG_CHAINS,
  DOG_TAIL_BONES,
  DOG_EAR_BONES,
  resetDogRestPose,
} from './dogSkeleton.js';
import { DOG_PAW_MESH_PAD, DOG_GROUND_CONTACT_COMPRESSION } from './dogFootPlant.js';
import { solveDogLegIk } from './dogLegIk.js';
import { dogDebugState } from '../../config/dogDebugConfig.js';

const FIXED_DT = 1 / 60;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// Jaw hinge swing for a relaxed open-mouth pant (degrees), plus a fast small
// oscillation layered on top so a held-open mouth reads as panting, not stuck.
const JAW_OPEN_DEG = 26;
const PANT_WOBBLE_DEG = 4;
const PANT_FREQUENCY = 5.4;
// Leading-pivot turn: chest/shoulders arc toward the new heading ahead of the
// hips (SotC-horse-style); clamp keeps the spine twist from reading as broken
// on a sudden reversal.
const MAX_SPINE_TWIST_DEG = 30;
// Whole-body pitch/roll conforming to ground slope under the stance
// footprint — clamped so one bad ground sample (a cliff edge, a seam) can't
// flip the dog over.
const MAX_BODY_TILT_DEG = 28;

/** @typedef {'idle'|'walk'|'trot'|'sit'|'look'|'lie'|'flop'} DogBehavior */
/** @typedef {'closed'|'open'|'alert'} DogMouthState */

const GAIT = {
  walk: {
    frequency: 1.35,
    strideAmp: 0.42,
    liftAmp: 0.26,
    phases: { frontL: 0.0, frontR: 0.5, hindL: 0.75, hindR: 0.25 },
    speed: 0.5,
  },
  trot: {
    frequency: 2.1,
    strideAmp: 0.52,
    liftAmp: 0.32,
    phases: { frontL: 0.0, frontR: 0.5, hindL: 0.5, hindR: 0.0 },
    speed: 1.05,
  },
};

/**
 * @param {object} rig
 * @param {{ face?: { setBlink: Function, setGaze: Function } }} [opts]
 */
export function createDogAnimation(rig, opts = {}) {
  const face = opts.face ?? null;
  const phenotype = opts.phenotype ?? rig.phenotype ?? null;
  const motion = phenotype?.motion ?? {};
  const legLength = phenotype?.skeleton?.legLength ?? 1;
  const bones = rig.bonesByName;

  /** @type {DogBehavior} */
  let behavior = 'idle';
  let autopilot = true;
  let externalRootMotion = false;
  let gaitPhase = 0;
  let time = 0;
  let blinkT = 0;
  let nextBlink = 2.4;
  let blinkAmount = 0;
  let gazeYaw = 0;
  let gazePitch = 0;
  let gazeTargetYaw = 0;
  let gazeTargetPitch = 0;
  let breath = 0;
  let sitBlend = 0;
  /** 0..1 procedural side-flop timeline (for mud splash → ragdoll handoff). */
  let flopProgress = 0;
  let flopActive = false;
  let frozenBlink = false;
  let frozenBreeze = false;
  /** When true, AnimationMixer owns body bones — skip procedural pose writes. */
  let clipDriven = false;

  /** @type {DogMouthState} */
  let mouthState = 'closed';
  let mouthOpenBlend = 0;
  let alertEarBlend = 0;
  let pantPhase = 0;
  /** Last jaw pitch (deg) from mouth state — reapplied after clip mixer. */
  let lastJawPitchDeg = 0;

  const rootPos = new THREE.Vector3();
  const rootYaw = { value: 0 };
  /** Chest/shoulder lead yaw (rad) — turns toward desiredDir ahead of rootYaw. */
  let frontYaw = 0;
  /** Current pelvis→chest twist (rad), consumed by updateGait/applyPostClipOverlays. */
  let spineTwist = 0;
  /** Smoothed yaw velocity (rad/s) for chase-cam push/pull. */
  let yawRate = 0;
  /** Whole-body slope-conform tilt (rad), see updateGroundConformance. */
  let bodyPitch = 0;
  let bodyRoll = 0;
  /** Live measured/ramped speed (m/s) from setMoveIntent; null = no live speed fed. */
  let targetSpeedMps = null;
  /** getGroundHeight from the most recent update() — reused by applyPostClipOverlays,
   * which runs later in the same frame (after the clip mixer samples this tick's pose). */
  let lastGetGroundHeight;
  const moveVel = new THREE.Vector3();
  const desiredDir = new THREE.Vector3(0, 0, 1);
  const _forward = new THREE.Vector3();
  const _yawQ = new THREE.Quaternion();
  const _pitchQ = new THREE.Quaternion();
  const _rollQ = new THREE.Quaternion();
  const _confFL = new THREE.Vector3();
  const _confFR = new THREE.Vector3();
  const _confHL = new THREE.Vector3();
  const _confHR = new THREE.Vector3();
  const _confMidFront = new THREE.Vector3();
  const _confMidHind = new THREE.Vector3();
  const _confMidLeft = new THREE.Vector3();
  const _confMidRight = new THREE.Vector3();
  const _ikPawPos = new THREE.Vector3();
  const _ikTarget = { x: 0, y: 0, z: 0 };

  const earSpring = {
    L: { x: 0, z: 0, vx: 0, vz: 0 },
    R: { x: 0, z: 0, vx: 0, vz: 0 },
  };

  const legKeys = /** @type {const} */ (['frontL', 'frontR', 'hindL', 'hindR']);

  function setBehavior(next) {
    if (behavior === next) return;
    behavior = next;
  }

  function setDesiredDirection(x, z) {
    desiredDir.set(Number(x) || 0, 0, Number(z) || 0);
    if (desiredDir.lengthSq() < 1e-6) desiredDir.set(0, 0, 1);
    else desiredDir.normalize();
  }

  function setMoveIntent({
    x = 0, z = 0, sprint = false, moving = null, sit = false, look = false, speedMps = null,
  } = {}) {
    autopilot = false;
    // Live measured speed (already accel/decel-ramped by the controller) —
    // drives the continuous walk/trot gait blend in updateGait. Callers that
    // never pass this (autopilot/studio) keep the old discrete-table gait.
    targetSpeedMps = Number.isFinite(speedMps) ? Math.max(0, speedMps) : null;
    // Procedural flop owns the body until finished / ragdoll takes over.
    if (flopActive) return;
    const hasDirection = x * x + z * z > 1e-6;
    if (hasDirection) setDesiredDirection(x, z);
    const wantsMove = moving ?? hasDirection;
    // Sprint flag or live speed past walk → Run clip / trot gait.
    const speedRun = Number.isFinite(targetSpeedMps) && targetSpeedMps >= 2.35;
    if (sit) setBehavior('sit');
    else if (look) setBehavior('look');
    else if (wantsMove) setBehavior(sprint || speedRun ? 'trot' : 'walk');
    else setBehavior('idle');
  }

  /**
   * Start a procedural side-flop (crouch → roll → settle). Progress 0..1.
   * Impact / ragdoll handoff typically at ~0.42.
   */
  function startFlop() {
    flopActive = true;
    flopProgress = 0;
    sitBlend = 0;
    setBehavior('flop');
  }

  /**
   * @param {number} dt
   * @param {number} [durationSec=0.85]
   * @returns {number} flopProgress 0..1
   */
  function advanceFlop(dt, durationSec = 0.85) {
    if (!flopActive) return flopProgress;
    const dur = Math.max(0.2, durationSec);
    flopProgress = Math.min(1, flopProgress + Math.max(0, dt) / dur);
    return flopProgress;
  }

  function clearFlop() {
    flopActive = false;
    flopProgress = 0;
    if (behavior === 'flop') setBehavior('idle');
  }

  function getFlopProgress() {
    return flopProgress;
  }

  function isFlopping() {
    return flopActive;
  }

  /**
   * Soft side-flop pose (t∈[0,1]). Kept modest so the handoff to physics
   * doesn't start from a broken-looking joint configuration.
   * 0–0.35 crouch · 0.3–0.7 slow tip onto side · 0.65–1 settle.
   */
  function updateFlopPose(dt) {
    const t = flopProgress;
    const crouch = THREE.MathUtils.smoothstep(t, 0, 0.35);
    const roll = THREE.MathUtils.smoothstep(t, 0.28, 0.72);
    const settle = THREE.MathUtils.smoothstep(t, 0.6, 1.0);
    moveVel.set(0, 0, 0);
    yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
    frontYaw = THREE.MathUtils.damp(frontYaw, rootYaw.value, 7, dt);
    spineTwist = THREE.MathUtils.damp(spineTwist, 0, 8, dt);

    // Gentle drop — stay near ground without burying the mesh.
    const dropY = (-0.07 * crouch - 0.04 * roll) * legLength;
    rootPos.y = THREE.MathUtils.damp(rootPos.y, dropY, 4, dt);
    applyRootTransform();

    // ~70° side roll total (not 90°+) — readable flop without twisted spine.
    addLocalEuler('Pelvis', -crouch * 22 - roll * 10, roll * 6, roll * 62 + settle * 4);
    addLocalEuler('Spine', crouch * 12 - roll * 4, 0, roll * 14);
    addLocalEuler('Spine1', crouch * 6, 0, roll * 10);
    addLocalEuler('Chest', -crouch * 8 + roll * 4, 0, roll * 12);
    addLocalEuler('Neck', crouch * 10 - roll * 8, roll * 4, roll * -6);
    addLocalEuler('Head', roll * -6, 0, roll * 8);

    // Hind: fold under calmly; no flail.
    for (const key of ['hindL', 'hindR']) {
      const chain = DOG_LEG_CHAINS[key];
      const side = chain.side === 'L' ? 1 : -1;
      const under = chain.side === 'R' ? 1 : 0.55;
      addLocalEuler(chain.upper, -crouch * 36 * under + settle * 8, 0, side * roll * 10);
      addLocalEuler(chain.lower, crouch * 40 * under, 0, side * settle * 6);
      addLocalEuler(chain.pastern, -crouch * 18, 0, 0);
      addLocalEuler(chain.hip, 0, 0, side * (crouch * 6 + roll * 12));
    }
    // Front: soft plant, slight outward ease as weight rolls over.
    for (const key of ['frontL', 'frontR']) {
      const chain = DOG_LEG_CHAINS[key];
      const side = chain.side === 'L' ? 1 : -1;
      addLocalEuler(chain.upper, crouch * 12 + roll * 14, 0, side * roll * 16);
      addLocalEuler(chain.lower, -crouch * 10 + settle * 8, 0, side * settle * 8);
      addLocalEuler(chain.pastern, crouch * 6, 0, 0);
      addLocalEuler(chain.hip, 0, 0, side * (crouch * 4 + roll * 10));
    }
    // Soft tail curl over the hip.
    for (let i = 0; i < DOG_TAIL_BONES.length; i += 1) {
      const k = (i + 1) / DOG_TAIL_BONES.length;
      addLocalEuler(DOG_TAIL_BONES[i], settle * 12 * k, roll * -18 * k, 0);
    }
  }

  function setMouthState(next) {
    if (next !== 'closed' && next !== 'open' && next !== 'alert') return;
    if (mouthState === next) return;
    mouthState = next;
  }

  /**
   * Additive local euler on top of current pose (rest is applied once per tick).
   * @param {string} name
   * @param {number} dx deg
   * @param {number} dy deg
   * @param {number} dz deg
   */
  function addLocalEuler(name, dx, dy, dz) {
    const bone = bones.get(name);
    if (!bone) return;
    if (dx) bone.rotateX(THREE.MathUtils.degToRad(dx));
    if (dy) bone.rotateY(THREE.MathUtils.degToRad(dy));
    if (dz) bone.rotateZ(THREE.MathUtils.degToRad(dz));
  }

  function applyRootTransform() {
    rig.root.position.copy(rootPos);
    // Quaternion path avoids euler/quaternion desync on Bone. Yaw (world
    // heading) composes outermost so ground-conform pitch/roll (body-local
    // slope tilt) always rides along with wherever the dog is currently
    // facing, instead of fighting it.
    _yawQ.setFromAxisAngle(Y_AXIS, rootYaw.value);
    if (Math.abs(bodyPitch) > 1e-5 || Math.abs(bodyRoll) > 1e-5) {
      _pitchQ.setFromAxisAngle(X_AXIS, bodyPitch);
      _rollQ.setFromAxisAngle(Z_AXIS, bodyRoll);
      rig.root.quaternion.copy(_yawQ).multiply(_pitchQ).multiply(_rollQ);
    } else {
      rig.root.quaternion.copy(_yawQ);
    }
  }

  function updateAutopilot(dt) {
    if (!autopilot) return;
    desiredDir.applyAxisAngle(Y_AXIS, Math.sin(time * 0.15) * 0.35 * dt);
    desiredDir.y = 0;
    if (desiredDir.lengthSq() < 1e-6) desiredDir.set(0, 0, 1);
    desiredDir.normalize();

    const cycle = (time * 0.07) % 1;
    if (cycle < 0.5) setBehavior(Math.sin(time * 0.25) > 0.55 ? 'trot' : 'walk');
    else if (cycle < 0.68) setBehavior('idle');
    else if (cycle < 0.82) setBehavior('look');
    else setBehavior('sit');
  }

  /**
   * Car-like root yaw toward desiredDir. Shared by procedural gait and
   * clip-driven locomotion (clips own body bones; controller still needs turn).
   * @param {number} dt
   * @param {typeof GAIT.walk | null} [gait]
   */
  function updateRootSteer(dt, gait = null) {
    if (!gait) {
      yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
      frontYaw = THREE.MathUtils.damp(frontYaw, rootYaw.value, 8, dt);
      spineTwist = THREE.MathUtils.damp(spineTwist, 0, 8, dt);
      applyRootTransform();
      return;
    }
    // Gentle car-like steer: soft exponential toward the stick, rate-capped so
    // the body arcs instead of snapping. Trot turns a bit wider than walk.
    let dyaw = Math.atan2(desiredDir.x, desiredDir.z) - rootYaw.value;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const turnGain = gait === GAIT.trot ? 1.25 : 1.55;
    const maxTurnRate = gait === GAIT.trot ? 1.55 : 2.05;
    let yawStep = dyaw * (1 - Math.exp(-turnGain * dt));
    yawStep = THREE.MathUtils.clamp(yawStep, -maxTurnRate * dt, maxTurnRate * dt);
    rootYaw.value += yawStep;
    const rateAlpha = 1 - Math.exp(-10 * dt);
    yawRate = THREE.MathUtils.lerp(yawRate, yawStep / Math.max(dt, 1e-5), rateAlpha);

    // Leading pivot: chest arcs toward desiredDir well ahead of the hips —
    // frontYaw converges faster/tighter than rootYaw, and the gap between
    // them (spineTwist) is what updateGait/applyPostClipOverlays distribute
    // across Spine/Spine1/Chest/Neck as a Y twist, so the front legs (parented
    // to Chest) swing into the turn before the hind legs (parented to Pelvis).
    let frontDyaw = Math.atan2(desiredDir.x, desiredDir.z) - frontYaw;
    while (frontDyaw > Math.PI) frontDyaw -= Math.PI * 2;
    while (frontDyaw < -Math.PI) frontDyaw += Math.PI * 2;
    let frontStep = frontDyaw * (1 - Math.exp(-turnGain * 2.6 * dt));
    frontStep = THREE.MathUtils.clamp(frontStep, -maxTurnRate * 2.2 * dt, maxTurnRate * 2.2 * dt);
    frontYaw += frontStep;

    let twist = frontYaw - rootYaw.value;
    while (twist > Math.PI) twist -= Math.PI * 2;
    while (twist < -Math.PI) twist += Math.PI * 2;
    const maxTwistRad = THREE.MathUtils.degToRad(MAX_SPINE_TWIST_DEG);
    spineTwist = THREE.MathUtils.clamp(twist, -maxTwistRad, maxTwistRad);

    applyRootTransform();
  }

  /**
   * Continuously blend the walk/trot tables by measured speed instead of a
   * hard table swap — legs quicken/slow smoothly as the controller's real
   * (accel-clamped) speed ramps through the crossover. Callers that never
   * feed a live speed (autopilot/studio) fall back to the discrete table for
   * whichever behavior is active, unchanged from before.
   * @param {number|null} speedMps
   * @param {'walk'|'trot'} behaviorName
   */
  function blendedGait(speedMps, behaviorName) {
    const base = behaviorName === 'trot' ? GAIT.trot : GAIT.walk;
    if (!Number.isFinite(speedMps)) return base;
    const walkSpeed = GAIT.walk.speed * (motion.speed ?? 1);
    const trotSpeed = GAIT.trot.speed * (motion.speed ?? 1);
    const t = THREE.MathUtils.smoothstep(speedMps, walkSpeed * 0.55, trotSpeed * 1.05);
    return {
      frequency: THREE.MathUtils.lerp(GAIT.walk.frequency, GAIT.trot.frequency, t),
      strideAmp: THREE.MathUtils.lerp(GAIT.walk.strideAmp, GAIT.trot.strideAmp, t),
      liftAmp: THREE.MathUtils.lerp(GAIT.walk.liftAmp, GAIT.trot.liftAmp, t),
      speed: THREE.MathUtils.lerp(GAIT.walk.speed, GAIT.trot.speed, t),
      phases: {
        frontL: 0,
        frontR: 0.5,
        hindL: THREE.MathUtils.lerp(GAIT.walk.phases.hindL, GAIT.trot.phases.hindL, t),
        hindR: THREE.MathUtils.lerp(GAIT.walk.phases.hindR, GAIT.trot.phases.hindR, t),
      },
    };
  }

  /**
   * Whole-body pitch/roll so the dog visibly conforms to slopes/ramps even
   * standing still. Samples ground height under each paw's rest-stance XZ
   * (not the live gait swing position — that would couple tilt to stride
   * phase and jitter every step) and derives pitch from the front-vs-hind
   * height difference, roll from left-vs-right, each clamped so one bad
   * sample (a cliff edge, a terrain seam) can't flip the dog over.
   * @param {number} dt
   * @param {((x: number, z: number) => number) | undefined} getGroundHeight
   */
  function updateGroundConformance(dt, getGroundHeight) {
    if (typeof getGroundHeight !== 'function') {
      bodyPitch = THREE.MathUtils.damp(bodyPitch, 0, 6, dt);
      bodyRoll = THREE.MathUtils.damp(bodyRoll, 0, 6, dt);
      return;
    }
    const frontL = bones.get(DOG_LEG_CHAINS.frontL.paw);
    const frontR = bones.get(DOG_LEG_CHAINS.frontR.paw);
    const hindL = bones.get(DOG_LEG_CHAINS.hindL.paw);
    const hindR = bones.get(DOG_LEG_CHAINS.hindR.paw);
    if (!frontL || !frontR || !hindL || !hindR) return;
    frontL.getWorldPosition(_confFL);
    frontR.getWorldPosition(_confFR);
    hindL.getWorldPosition(_confHL);
    hindR.getWorldPosition(_confHR);

    const groundFL = getGroundHeight(_confFL.x, _confFL.z);
    const groundFR = getGroundHeight(_confFR.x, _confFR.z);
    const groundHL = getGroundHeight(_confHL.x, _confHL.z);
    const groundHR = getGroundHeight(_confHR.x, _confHR.z);
    if (!Number.isFinite(groundFL) || !Number.isFinite(groundFR)
      || !Number.isFinite(groundHL) || !Number.isFinite(groundHR)) {
      bodyPitch = THREE.MathUtils.damp(bodyPitch, 0, 6, dt);
      bodyRoll = THREE.MathUtils.damp(bodyRoll, 0, 6, dt);
      return;
    }

    const frontGround = (groundFL + groundFR) * 0.5;
    const hindGround = (groundHL + groundHR) * 0.5;
    const leftGround = (groundFL + groundHL) * 0.5;
    const rightGround = (groundFR + groundHR) * 0.5;

    _confMidFront.addVectors(_confFL, _confFR).multiplyScalar(0.5);
    _confMidHind.addVectors(_confHL, _confHR).multiplyScalar(0.5);
    _confMidLeft.addVectors(_confFL, _confHL).multiplyScalar(0.5);
    _confMidRight.addVectors(_confFR, _confHR).multiplyScalar(0.5);

    const bodyLen = Math.max(0.05, Math.hypot(
      _confMidFront.x - _confMidHind.x,
      _confMidFront.z - _confMidHind.z,
    ));
    const stanceX = Math.max(0.03, Math.hypot(
      _confMidLeft.x - _confMidRight.x,
      _confMidLeft.z - _confMidRight.z,
    ));

    const maxTilt = THREE.MathUtils.degToRad(MAX_BODY_TILT_DEG);
    // Positive X-axis rotation pushes a +Z (forward/chest) point DOWN, not up
    // (confirmed: THREE.Quaternion.setFromAxisAngle(X,+θ) applied to (0,0,1)
    // yields negative Y) — so the nose-up case (front higher than hind, e.g.
    // walking uphill) needs a NEGATIVE pitch, hence hind-minus-front here.
    const targetPitch = THREE.MathUtils.clamp(
      Math.atan2(hindGround - frontGround, bodyLen), -maxTilt, maxTilt,
    );
    const targetRoll = THREE.MathUtils.clamp(
      Math.atan2(leftGround - rightGround, stanceX), -maxTilt, maxTilt,
    );
    bodyPitch = THREE.MathUtils.damp(bodyPitch, targetPitch, 6, dt);
    bodyRoll = THREE.MathUtils.damp(bodyRoll, targetRoll, 6, dt);
  }

  /**
   * Local-X pitch: for down-pointing leg bones, negative X swings the paw +Z (forward).
   * Stance keeps feet near rest height — no tip-bone warping (that made tippy toes).
   * @param {number} dt
   * @param {typeof GAIT.walk} gait
   * @param {((x: number, z: number) => number) | undefined} [getGroundHeight]
   */
  function updateGait(dt, gait, getGroundHeight) {
    const breedScale = phenotype?.skeleton?.scale ?? 1;
    const supportOffset = Math.max(0, (DOG_PAW_MESH_PAD - DOG_GROUND_CONTACT_COMPRESSION) * breedScale);
    const frequency = gait.frequency * Math.sqrt(motion.speed ?? 1);
    const strideAmp = gait.strideAmp * (motion.stride ?? 1);
    const moveSpeed = gait.speed * (motion.speed ?? 1);
    gaitPhase = (gaitPhase + dt * frequency) % 1;

    updateRootSteer(dt, gait);

    _forward.set(Math.sin(rootYaw.value), 0, Math.cos(rootYaw.value));
    moveVel.copy(_forward).multiplyScalar(moveSpeed);
    if (!externalRootMotion) rootPos.addScaledVector(moveVel, dt);
    // Keep root on the floor — any root.y lifts the whole dog onto tippy toes.
    rootPos.y = 0;
    applyRootTransform();

    // Soft spine wave (small).
    const bob = Math.sin(gaitPhase * Math.PI * 2);
    // Leading-pivot twist: cumulative local-Y rotations compound down the
    // chain (Spine -> Spine1 -> Chest -> Neck), so weights are the *deltas*
    // between target world-twist fractions, not independent shares.
    const twistDeg = THREE.MathUtils.radToDeg(spineTwist);
    addLocalEuler('Spine', bob * 1.5, twistDeg * 0.33, 0);
    addLocalEuler('Spine1', 0, twistDeg * 0.33, 0);
    addLocalEuler('Chest', Math.sin(gaitPhase * Math.PI * 2 + 0.4) * 1.2, twistDeg * 0.34, 0);
    addLocalEuler('Neck', 0, twistDeg * 0.25, 0);
    addLocalEuler('Pelvis', -bob * 1.0, 0, 0);

    for (const key of legKeys) {
      const chain = DOG_LEG_CHAINS[key];
      const phase = (gaitPhase + gait.phases[key]) % 1;
      const swing = Math.sin(phase * Math.PI * 2);
      // Lift only during swing; keep mild so stance pads stay planted.
      const lift = Math.max(0, Math.sin(phase * Math.PI * 2));

      if (chain.front) {
        addLocalEuler(chain.upper, -swing * strideAmp * 26, 0, 0);
        addLocalEuler(chain.lower, -gait.liftAmp * lift * 24, 0, 0);
        // Pastern flexes on lift only; don't pitch the paw into pointe.
        addLocalEuler(chain.pastern, lift * 14 + swing * 4, 0, 0);
        addLocalEuler(chain.paw, -lift * 4, 0, 0);
      } else {
        addLocalEuler(chain.upper, -swing * strideAmp * 30, 0, 0);
        addLocalEuler(chain.lower, gait.liftAmp * lift * 28 + swing * 5, 0, 0);
        addLocalEuler(chain.pastern, -lift * 12 - swing * 6, 0, 0);
        addLocalEuler(chain.paw, lift * 4, 0, 0);
      }

      // Re-ground the FK swing against real terrain: sample height at the
      // paw's current (post-swing) XZ and IK-correct Y only, including the
      // same lift the FK just authored so ground clearance is measured
      // against the *local* terrain under the foot's own arc, not a flat
      // plane — this is what makes the swing read correctly on a slope.
      if (getGroundHeight && dogDebugState.proceduralLegIkEnabled) {
        const pawBone = bones.get(chain.paw);
        if (pawBone) {
          rig.root.updateMatrixWorld(true);
          pawBone.getWorldPosition(_ikPawPos);
          const groundY = getGroundHeight(_ikPawPos.x, _ikPawPos.z);
          if (Number.isFinite(groundY)) {
            const liftHeight = lift * gait.liftAmp * 0.05 * legLength * breedScale;
            _ikTarget.x = _ikPawPos.x;
            _ikTarget.y = groundY + supportOffset + liftHeight;
            _ikTarget.z = _ikPawPos.z;
            solveDogLegIk(rig, chain, _ikTarget);
          }
        }
      }
    }
  }

  function updateIdle(dt) {
    moveVel.set(0, 0, 0);
    yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
    frontYaw = THREE.MathUtils.damp(frontYaw, rootYaw.value, 8, dt);
    spineTwist = THREE.MathUtils.damp(spineTwist, 0, 8, dt);
    rootPos.y = THREE.MathUtils.damp(rootPos.y, 0, 8, dt);
    applyRootTransform();

    const shift = Math.sin(time * 0.55) * 1.0;
    addLocalEuler('Spine', Math.sin(breath) * 0.8, 0, shift * 0.15);
    addLocalEuler('Chest', Math.sin(breath) * 0.6, 0, 0);
    addLocalEuler('Pelvis', Math.sin(breath + 0.5) * 0.5, 0, -shift * 0.1);
    // Soft lateral weight only — never pitch legs off the floor.
    for (const key of legKeys) {
      const chain = DOG_LEG_CHAINS[key];
      addLocalEuler(chain.hip, 0, 0, Math.sin(time * 0.4 + key.length) * 0.8);
    }
  }

  /**
   * Real dog sit: rump down, hind legs folded under, front legs plant, chest up.
   * Pelvis uses *negative* local X so the spine ( +Z child) lifts relative to hips.
   */
  function updateSit(dt) {
    sitBlend = THREE.MathUtils.damp(sitBlend, 1, 2.2, dt);
    moveVel.set(0, 0, 0);
    yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
    frontYaw = THREE.MathUtils.damp(frontYaw, rootYaw.value, 8, dt);
    spineTwist = THREE.MathUtils.damp(spineTwist, 0, 8, dt);

    // Drop whole body so folded rump sits near ground. Milder than pre-S rest
    // because the camped hind chain already reaches lower when folded.
    const sitY = -0.12 * sitBlend * legLength * (motion.sitDepth ?? 1);
    rootPos.y = THREE.MathUtils.damp(rootPos.y, sitY, 3.5, dt);
    applyRootTransform();

    // Pelvis: negative pitch lifts chest relative to hips / drops rump feel.
    addLocalEuler('Pelvis', -sitBlend * 28, 0, 0);
    addLocalEuler('Spine', sitBlend * 18, 0, 0);
    addLocalEuler('Chest', -sitBlend * 8, 0, 0);
    addLocalEuler('Neck', sitBlend * 12, 0, 0);

    for (const key of ['hindL', 'hindR']) {
      const chain = DOG_LEG_CHAINS[key];
      // Slight hip socket settle — keep mild so pads don't punch through floor.
      const hipBone = bones.get(chain.hip);
      const hipRest = rig.restPositions.get(chain.hip);
      if (hipBone && hipRest) {
        hipBone.position.copy(hipRest);
        hipBone.position.y -= sitBlend * 0.04;
        hipBone.position.z += sitBlend * 0.03;
      }
      // Thigh folds forward (negative X), shin tucks, hock plants on pad.
      // Camped hind S already has long cranial femur + caudal tibia — hard
      // 78/112 over-folded the paw through the floor.
      addLocalEuler(chain.upper, -sitBlend * 58, 0, 0);
      addLocalEuler(chain.lower, sitBlend * 62, 0, 0);
      addLocalEuler(chain.pastern, -sitBlend * 36, 0, 0);
      addLocalEuler(chain.paw, sitBlend * 18, 0, 0);
      // Slight outward splay so haunches read wider.
      const side = chain.side === 'L' ? 1 : -1;
      addLocalEuler(chain.hip, 0, 0, side * sitBlend * 14);
    }
    for (const key of ['frontL', 'frontR']) {
      const chain = DOG_LEG_CHAINS[key];
      // Front legs stay load-bearing, slight rearward plant.
      addLocalEuler(chain.upper, sitBlend * 14, 0, 0);
      addLocalEuler(chain.lower, -sitBlend * 12, 0, 0);
      addLocalEuler(chain.pastern, sitBlend * 8, 0, 0);
      const side = chain.side === 'L' ? 1 : -1;
      addLocalEuler(chain.hip, 0, 0, side * sitBlend * 5);
    }
  }

  function updateTail(_dt, wagAmp) {
    const tailMotion = motion.tailMotion ?? phenotype?.tail?.motion ?? 1;
    const wag = Math.sin(time * 8.5) * wagAmp * 26 * tailMotion;
    const lift = (Math.sin(time * 3.1) * wagAmp * 8 + wagAmp * 4) * tailMotion;
    for (let i = 0; i < DOG_TAIL_BONES.length; i += 1) {
      const k = (i + 1) / DOG_TAIL_BONES.length;
      // Tail bones point roughly -Z; local Y wags side-to-side, X lifts.
      addLocalEuler(DOG_TAIL_BONES[i], lift * k, wag * k, 0);
    }
  }

  function updateEarSprings(dt) {
    // Alert mouth: ears pull back and pin in (twinged) — not a floppy flop.
    alertEarBlend = THREE.MathUtils.damp(alertEarBlend, mouthState === 'alert' ? 1 : 0, 7, dt);
    for (const side of ['L', 'R']) {
      const s = earSpring[side];
      const sideSign = side === 'L' ? 1 : -1;
      const idleX = Math.sin(time * 1.2 + (side === 'L' ? 0 : 1.2)) * 0.02 * (1 - alertEarBlend);
      // Tense: tip back / slightly up, fold toward the skull.
      const targetX = idleX + alertEarBlend * -0.42;
      const targetZ = alertEarBlend * 0.55 * sideSign;
      s.vx += (targetX - s.x) * 28 * dt;
      s.vz += (targetZ - s.z) * 28 * dt;
      s.vx *= Math.exp(-8 * dt);
      s.vz *= Math.exp(-8 * dt);
      s.x += s.vx * dt;
      s.z += s.vz * dt;
    }
  }

  function applyEarBones() {
    const earDynamics = motion.earDynamics ?? phenotype?.ears?.dynamics ?? 1;
    for (const side of ['L', 'R']) {
      const s = earSpring[side];
      const sideSign = side === 'L' ? 1 : -1;
      const names = DOG_EAR_BONES[side];
      for (let i = 0; i < names.length; i += 1) {
        const k = (i + 1) / names.length;
        addLocalEuler(
          names[i],
          s.x * k * 10 * earDynamics + alertEarBlend * k * -20,
          0,
          s.z * k * 8 * earDynamics * sideSign + alertEarBlend * k * 14 * sideSign,
        );
      }
    }
  }

  function updateEars(dt) {
    updateEarSprings(dt);
    applyEarBones();
  }

  /**
   * @param {number} dt
   * @param {{ bones?: boolean, mouthMesh?: boolean }} [opts]
   *   bones: Head/Neck/Jaw additives (need a rest reset same frame).
   *   mouthMesh: tongue/interior meshes — always safe during clip-driven body.
   */
  function updateFace(dt, { bones: affectBones = true, mouthMesh = true } = {}) {
    breath += dt * 2.1;
    if (!frozenBlink) {
      blinkT += dt;
      if (blinkT > nextBlink) {
        blinkAmount = 1;
        blinkT = 0;
        nextBlink = 1.8 + Math.random() * 2.6;
      }
      blinkAmount = THREE.MathUtils.damp(blinkAmount, 0, 14, dt);
    }
    if (behavior === 'look') {
      gazeTargetYaw = Math.sin(time * 0.65) * 0.28;
      gazeTargetPitch = Math.sin(time * 0.4) * 0.08;
    } else if (behavior === 'sit') {
      gazeTargetYaw = Math.sin(time * 0.3) * 0.1;
      gazeTargetPitch = 0.04;
    } else {
      gazeTargetYaw = Math.sin(time * 0.18) * 0.06;
      gazeTargetPitch = 0;
    }
    gazeYaw = THREE.MathUtils.damp(gazeYaw, gazeTargetYaw, 4, dt);
    gazePitch = THREE.MathUtils.damp(gazePitch, gazeTargetPitch, 4, dt);

    if (affectBones) {
      // Additive on top of sit/gait neck contributions (requires rest reset).
      addLocalEuler('Head', gazePitch * 36 + Math.sin(breath) * 1.0, gazeYaw * 38, 0);
      addLocalEuler('Neck', Math.sin(breath) * 0.6, gazeYaw * 14, 0);
    }

    // Jaw: damped toward closed / alert (half) / pant (full). Only pant gets
    // the fast wobble + tongue; alert holds a still half-open teeth show.
    const mouthTarget = mouthState === 'open' ? 1 : mouthState === 'alert' ? 0.5 : 0;
    const showTongue = mouthState === 'open';
    mouthOpenBlend = THREE.MathUtils.damp(mouthOpenBlend, mouthTarget, 6, dt);
    pantPhase += dt * PANT_FREQUENCY * (0.35 + (showTongue ? mouthOpenBlend : 0) * 0.65);
    const pantWobble = showTongue
      ? mouthOpenBlend * (Math.sin(pantPhase * Math.PI * 2) * 0.5 + 0.5)
      : 0;
    lastJawPitchDeg = mouthOpenBlend * JAW_OPEN_DEG + pantWobble * PANT_WOBBLE_DEG;
    if (affectBones) {
      addLocalEuler('Jaw', lastJawPitchDeg, 0, 0);
    }
    // Slow, irrational-ratio sine mix so the tongue's side-lean/curl wander
    // over several seconds instead of holding one fixed pose or ticking like
    // a metronome — every dog shares this drift but layers its own seeded
    // bias on top (in dogHeadFeatures.js) so no two dogs pant identically.
    const driftYaw = Math.sin(time * 0.41) * 0.6 + Math.sin(time * 0.71 + 1.3) * 0.4;
    const driftCurl = Math.sin(time * 0.53 + 2.1) * 0.5 + 0.5;
    // Mesh mouth/tongue keep animating under clip-driven body (jaw bone is
    // reapplied after the mixer via applyPostClipOverlays).
    if (mouthMesh) {
      face?.setMouthOpen(
        mouthOpenBlend,
        pantWobble,
        driftYaw,
        driftCurl,
        showTongue,
      );
    }

    if (affectBones) {
      const chest = bones.get('Chest');
      const restP = rig.restPositions.get('Chest');
      if (chest && restP) {
        chest.position.copy(restP);
        chest.position.y += Math.sin(breath) * 0.0012;
      }
    }

    face?.setBlink(blinkAmount);
    // Gaze mesh still tracks; head bone stays with the clip when !affectBones.
    face?.setGaze(gazeYaw, gazePitch);
  }

  /**
   * After AnimationMixer samples body bones: re-author Jaw (and ears) from rest
   * + mouth/ear state so pant/alert work while clips own the skeleton.
   * Safe every frame — copies rest first, never accumulates.
   */
  function applyPostClipOverlays() {
    if (!clipDriven) return;

    const jaw = bones.get('Jaw');
    const jawRest = rig.restQuaternions.get('Jaw');
    if (jaw && jawRest) {
      jaw.quaternion.copy(jawRest);
      if (Math.abs(lastJawPitchDeg) > 1e-4) {
        jaw.rotateX(THREE.MathUtils.degToRad(lastJawPitchDeg));
      }
    }

    // Ears are usually not in the retarget tracks — keep alert pin / flop alive.
    for (const side of ['L', 'R']) {
      for (const name of DOG_EAR_BONES[side]) {
        const bone = bones.get(name);
        const restQ = rig.restQuaternions.get(name);
        if (bone && restQ) bone.quaternion.copy(restQ);
      }
    }
    applyEarBones();

    // Leading-pivot spine twist, additive on top of the clip's sampled pose
    // (same pelvis->chest->neck distribution as updateGait) — this is what
    // gives the equid/horse clip pack the same front-leads-the-turn feel.
    if (Math.abs(spineTwist) > 1e-4) {
      const twistDeg = THREE.MathUtils.radToDeg(spineTwist);
      addLocalEuler('Spine', 0, twistDeg * 0.33, 0);
      addLocalEuler('Spine1', 0, twistDeg * 0.33, 0);
      addLocalEuler('Chest', 0, twistDeg * 0.34, 0);
      addLocalEuler('Neck', 0, twistDeg * 0.25, 0);
    }

    // Re-ground the clip's sampled leg poses against real terrain, same
    // analytic solver as the procedural gait's per-leg correction — but
    // walk/trot only (a jump/bark/sit clip's legs are legitimately off the
    // ground) and its own debug flag, since a baked clip's authored leg
    // silhouette is more at risk of visibly fighting the solver than a raw
    // FK swing is.
    if (
      (behavior === 'walk' || behavior === 'trot')
      && lastGetGroundHeight
      && dogDebugState.clipLegIkEnabled
    ) {
      const breedScale = phenotype?.skeleton?.scale ?? 1;
      const supportOffset = Math.max(0, (DOG_PAW_MESH_PAD - DOG_GROUND_CONTACT_COMPRESSION) * breedScale);
      for (const key of legKeys) {
        const chain = DOG_LEG_CHAINS[key];
        const pawBone = bones.get(chain.paw);
        if (!pawBone) continue;
        rig.root.updateMatrixWorld(true);
        pawBone.getWorldPosition(_ikPawPos);
        const groundY = lastGetGroundHeight(_ikPawPos.x, _ikPawPos.z);
        if (!Number.isFinite(groundY)) continue;
        _ikTarget.x = _ikPawPos.x;
        _ikTarget.y = groundY + supportOffset;
        _ikTarget.z = _ikPawPos.z;
        solveDogLegIk(rig, chain, _ikTarget);
      }
    }

    rig.root.updateMatrixWorld(true);
    rig.skeleton.update();
  }

  /**
   * @param {number} dt
   * @param {{ fixed?: boolean }} [opts]
   */
  function update(dt, opts = {}) {
    const steps = opts.fixed ? Math.max(1, Math.round(dt / FIXED_DT)) : 1;
    const stepDt = opts.fixed ? FIXED_DT : Math.min(dt, 0.05);
    const getGroundHeight = typeof opts.getGroundHeight === 'function' ? opts.getGroundHeight : undefined;
    lastGetGroundHeight = getGroundHeight;

    for (let s = 0; s < steps; s += 1) {
      time += stepDt;

      // Clip library owns body TRS via AnimationMixer. Skip gait/sit pose and
      // per-leg IK (that fights the clip's authored leg poses — same reason
      // footIkEnabled defaults off for clip mode). Whole-body pitch/roll is
      // independent of which system animates the legs, so it still runs here
      // — a slope should tilt the dog regardless of clip vs procedural gait.
      // Root yaw steering still runs — left/right aim is controller-owned.
      // Mouth mesh + state advance here; Jaw/ears reapply after mixer.
      if (clipDriven) {
        updateGroundConformance(stepDt, getGroundHeight);
        if (behavior === 'walk') updateRootSteer(stepDt, GAIT.walk);
        else if (behavior === 'trot') updateRootSteer(stepDt, GAIT.trot);
        else updateRootSteer(stepDt, null);
        updateEarSprings(stepDt); // bone write is post-mixer via applyPostClipOverlays
        updateFace(stepDt, { bones: false, mouthMesh: true });
        rig.root.updateMatrixWorld(true);
        rig.skeleton.update();
        continue;
      }

      resetDogRestPose(rig);

      updateAutopilot(stepDt);

      if (behavior === 'flop' || flopActive) {
        // A flopped dog isn't standing on the slope the same way — ease the
        // conform tilt back to level instead of fighting the flop's own pose.
        bodyPitch = THREE.MathUtils.damp(bodyPitch, 0, 6, stepDt);
        bodyRoll = THREE.MathUtils.damp(bodyRoll, 0, 6, stepDt);
        updateFlopPose(stepDt);
      } else {
        // Runs every non-flop behavior (idle/sit included) so a standing dog
        // tilts on a hill too, not just while walking/trotting.
        updateGroundConformance(stepDt, getGroundHeight);
        if (behavior === 'sit' || behavior === 'lie') {
          updateSit(stepDt);
        } else if (behavior === 'walk' || behavior === 'trot') {
          sitBlend = THREE.MathUtils.damp(sitBlend, 0, 4, stepDt);
          updateGait(stepDt, blendedGait(targetSpeedMps, behavior), getGroundHeight);
        } else {
          sitBlend = THREE.MathUtils.damp(sitBlend, 0, 4, stepDt);
          updateIdle(stepDt);
        }
      }

      const wag = behavior === 'flop' ? 0.15
        : behavior === 'sit' ? 0.6
          : behavior === 'idle' || behavior === 'look' ? 0.38
            : behavior === 'walk' ? 0.2
              : 0.1;
      if (behavior !== 'flop') updateTail(stepDt, wag);
      updateEars(stepDt);
      updateFace(stepDt);

      rig.root.updateMatrixWorld(true);
      rig.skeleton.update();
    }
  }

  return {
    update,
    setBehavior,
    getBehavior: () => behavior,
    setDesiredDirection,
    getDesiredDirection: () => desiredDir.clone(),
    setMoveIntent,
    startFlop,
    advanceFlop,
    clearFlop,
    getFlopProgress,
    isFlopping,
    setExternalRootMotion: (value) => { externalRootMotion = Boolean(value); },
    getExternalRootMotion: () => externalRootMotion,
    setClipDriven: (value) => { clipDriven = Boolean(value); },
    getClipDriven: () => clipDriven,
    /** Call after clip mixer sample so Jaw/ears + mouth stay authored. */
    applyPostClipOverlays,
    setMouthState,
    getMouthState: () => mouthState,
    setAutopilot: (v) => { autopilot = Boolean(v); },
    getAutopilot: () => autopilot,
    setFrozenBlink: (v) => { frozenBlink = Boolean(v); if (frozenBlink) blinkAmount = 0; },
    setFrozenBreeze: (v) => { frozenBreeze = Boolean(v); },
    isFrozenBreeze: () => frozenBreeze,
    getTime: () => time,
    setTime: (t) => { time = t; },
    getRootPosition: () => rootPos.clone(),
    setRootPosition: (x, y, z) => {
      rootPos.set(x, y, z);
      rig.root.position.copy(rootPos);
    },
    getRootYaw: () => rootYaw.value,
    setRootYaw: (y) => {
      rootYaw.value = y;
      frontYaw = y;
      spineTwist = 0;
      applyRootTransform();
    },
    getYawRate: () => yawRate,
    getFootSupport: () => {
      if (behavior !== 'walk' && behavior !== 'trot') {
        return { frontL: 1, frontR: 1, hindL: 1, hindR: 1 };
      }
      const gait = blendedGait(targetSpeedMps, behavior);
      const out = {};
      for (const key of legKeys) {
        const phase = (gaitPhase + gait.phases[key]) % 1;
        out[key] = Math.sin(phase * Math.PI * 2) < 0.15 ? 1 : 0;
      }
      return out;
    },
    getMoveSpeed: () => moveVel.length(),
    FIXED_DT,
  };
}
