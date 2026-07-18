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

const FIXED_DT = 1 / 60;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
// Jaw hinge swing for a relaxed open-mouth pant (degrees), plus a fast small
// oscillation layered on top so a held-open mouth reads as panting, not stuck.
const JAW_OPEN_DEG = 26;
const PANT_WOBBLE_DEG = 4;
const PANT_FREQUENCY = 5.4;

/** @typedef {'idle'|'walk'|'trot'|'sit'|'look'|'lie'} DogBehavior */
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
  let frozenBlink = false;
  let frozenBreeze = false;
  /** When true, AnimationMixer owns body bones — skip procedural pose writes. */
  let clipDriven = false;

  /** @type {DogMouthState} */
  let mouthState = 'closed';
  let mouthOpenBlend = 0;
  let alertEarBlend = 0;
  let pantPhase = 0;

  const rootPos = new THREE.Vector3();
  const rootYaw = { value: 0 };
  /** Smoothed yaw velocity (rad/s) for chase-cam push/pull. */
  let yawRate = 0;
  const moveVel = new THREE.Vector3();
  const desiredDir = new THREE.Vector3(0, 0, 1);
  const _forward = new THREE.Vector3();
  const _yawQ = new THREE.Quaternion();

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

  function setMoveIntent({ x = 0, z = 0, sprint = false, moving = null, sit = false, look = false } = {}) {
    autopilot = false;
    const hasDirection = x * x + z * z > 1e-6;
    if (hasDirection) setDesiredDirection(x, z);
    const wantsMove = moving ?? hasDirection;
    if (sit) setBehavior('sit');
    else if (look) setBehavior('look');
    else if (wantsMove) setBehavior(sprint ? 'trot' : 'walk');
    else setBehavior('idle');
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
    // Quaternion path avoids euler/quaternion desync on Bone.
    _yawQ.setFromAxisAngle(Y_AXIS, rootYaw.value);
    rig.root.quaternion.copy(_yawQ);
    rig.root.rotation.set(0, rootYaw.value, 0, 'XYZ');
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
   * Local-X pitch: for down-pointing leg bones, negative X swings the paw +Z (forward).
   * Stance keeps feet near rest height — no tip-bone warping (that made tippy toes).
   * @param {number} dt
   * @param {typeof GAIT.walk} gait
   */
  function updateGait(dt, gait) {
    const frequency = gait.frequency * Math.sqrt(motion.speed ?? 1);
    const strideAmp = gait.strideAmp * (motion.stride ?? 1);
    const moveSpeed = gait.speed * (motion.speed ?? 1);
    gaitPhase = (gaitPhase + dt * frequency) % 1;

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

    _forward.set(Math.sin(rootYaw.value), 0, Math.cos(rootYaw.value));
    moveVel.copy(_forward).multiplyScalar(moveSpeed);
    if (!externalRootMotion) rootPos.addScaledVector(moveVel, dt);
    // Keep root on the floor — any root.y lifts the whole dog onto tippy toes.
    rootPos.y = 0;
    applyRootTransform();

    // Soft spine wave (small).
    const bob = Math.sin(gaitPhase * Math.PI * 2);
    addLocalEuler('Spine', bob * 1.5, 0, 0);
    addLocalEuler('Chest', Math.sin(gaitPhase * Math.PI * 2 + 0.4) * 1.2, 0, 0);
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
    }
  }

  function updateIdle(dt) {
    moveVel.set(0, 0, 0);
    yawRate = THREE.MathUtils.lerp(yawRate, 0, 1 - Math.exp(-6 * dt));
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

    // Drop whole body so folded rump sits near ground.
    const sitY = -0.18 * sitBlend * legLength * (motion.sitDepth ?? 1);
    rootPos.y = THREE.MathUtils.damp(rootPos.y, sitY, 3.5, dt);
    applyRootTransform();

    // Pelvis: negative pitch lifts chest relative to hips / drops rump feel.
    addLocalEuler('Pelvis', -sitBlend * 32, 0, 0);
    addLocalEuler('Spine', sitBlend * 20, 0, 0);
    addLocalEuler('Chest', -sitBlend * 8, 0, 0);
    addLocalEuler('Neck', sitBlend * 12, 0, 0);

    for (const key of ['hindL', 'hindR']) {
      const chain = DOG_LEG_CHAINS[key];
      // Drop hip sockets so folded haunches reach the floor.
      const hipBone = bones.get(chain.hip);
      const hipRest = rig.restPositions.get(chain.hip);
      if (hipBone && hipRest) {
        hipBone.position.copy(hipRest);
        hipBone.position.y -= sitBlend * 0.1;
        hipBone.position.z += sitBlend * 0.02;
      }
      // Thigh folds forward (negative X), shin tucks hard, hock plants on pad.
      addLocalEuler(chain.upper, -sitBlend * 78, 0, 0);
      addLocalEuler(chain.lower, sitBlend * 112, 0, 0);
      addLocalEuler(chain.pastern, -sitBlend * 58, 0, 0);
      addLocalEuler(chain.paw, sitBlend * 26, 0, 0);
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

  function updateEars(dt) {
    const earDynamics = motion.earDynamics ?? phenotype?.ears?.dynamics ?? 1;
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

  /**
   * @param {number} dt
   * @param {{ bones?: boolean }} [opts] When bones is false, only mesh face
   *   features update — used while AnimationMixer owns Head/Neck/Jaw (clip
   *   one-shots). Additive bone rotates must not run without a rest reset or
   *   they accumulate (head spun a full turn over the Death hold).
   */
  function updateFace(dt, { bones: affectBones = true } = {}) {
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
    if (affectBones) {
      addLocalEuler('Jaw', mouthOpenBlend * JAW_OPEN_DEG + pantWobble * PANT_WOBBLE_DEG, 0, 0);
    }
    // Slow, irrational-ratio sine mix so the tongue's side-lean/curl wander
    // over several seconds instead of holding one fixed pose or ticking like
    // a metronome — every dog shares this drift but layers its own seeded
    // bias on top (in dogHeadFeatures.js) so no two dogs pant identically.
    const driftYaw = Math.sin(time * 0.41) * 0.6 + Math.sin(time * 0.71 + 1.3) * 0.4;
    const driftCurl = Math.sin(time * 0.53 + 2.1) * 0.5 + 0.5;
    // Mesh mouth/tongue still ok during clip-driven hold (jaw bone stays put).
    face?.setMouthOpen(
      affectBones ? mouthOpenBlend : 0,
      affectBones ? pantWobble : 0,
      affectBones ? driftYaw : 0,
      affectBones ? driftCurl : 0,
      affectBones && showTongue,
    );

    if (affectBones) {
      const chest = bones.get('Chest');
      const restP = rig.restPositions.get('Chest');
      if (chest && restP) {
        chest.position.copy(restP);
        chest.position.y += Math.sin(breath) * 0.0012;
      }
    }

    face?.setBlink(blinkAmount);
    face?.setGaze(affectBones ? gazeYaw : 0, affectBones ? gazePitch : 0);
  }

  /**
   * @param {number} dt
   * @param {{ fixed?: boolean }} [opts]
   */
  function update(dt, opts = {}) {
    const steps = opts.fixed ? Math.max(1, Math.round(dt / FIXED_DT)) : 1;
    const stepDt = opts.fixed ? FIXED_DT : Math.min(dt, 0.05);

    for (let s = 0; s < steps; s += 1) {
      time += stepDt;

      // Clip one-shots (Death splash, Jump, …) own bone TRS via AnimationMixer.
      // Resetting to rest here would yank the body off the last death frame.
      // Face mesh can still blink, but Head/Neck/Jaw bone additives must not
      // run — without a rest reset they accumulate (full head spin on hold).
      if (clipDriven) {
        updateFace(stepDt, { bones: false });
        applyRootTransform();
        rig.root.updateMatrixWorld(true);
        rig.skeleton.update();
        continue;
      }

      resetDogRestPose(rig);

      updateAutopilot(stepDt);

      if (behavior === 'sit' || behavior === 'lie') {
        updateSit(stepDt);
      } else if (behavior === 'walk') {
        sitBlend = THREE.MathUtils.damp(sitBlend, 0, 4, stepDt);
        updateGait(stepDt, GAIT.walk);
      } else if (behavior === 'trot') {
        sitBlend = THREE.MathUtils.damp(sitBlend, 0, 4, stepDt);
        updateGait(stepDt, GAIT.trot);
      } else {
        sitBlend = THREE.MathUtils.damp(sitBlend, 0, 4, stepDt);
        updateIdle(stepDt);
      }

      const wag = behavior === 'sit' ? 0.6
        : behavior === 'idle' || behavior === 'look' ? 0.38
          : behavior === 'walk' ? 0.2
            : 0.1;
      updateTail(stepDt, wag);
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
    setExternalRootMotion: (value) => { externalRootMotion = Boolean(value); },
    getExternalRootMotion: () => externalRootMotion,
    setClipDriven: (value) => { clipDriven = Boolean(value); },
    getClipDriven: () => clipDriven,
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
      applyRootTransform();
    },
    getYawRate: () => yawRate,
    getFootSupport: () => {
      if (behavior !== 'walk' && behavior !== 'trot') {
        return { frontL: 1, frontR: 1, hindL: 1, hindR: 1 };
      }
      const gait = behavior === 'trot' ? GAIT.trot : GAIT.walk;
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
