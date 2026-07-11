/**
 * First-person body helpers (port of dust-and-bullets playerBody pure functions).
 * M3: locomotion select, root-motion strip, spine aim-pitch, bone finders.
 * M4 will add weapon-hand IK onto gun anchors.
 */

import * as THREE from 'three';

export const AIM_PITCH_LIMIT = 1.25;
// Neck-local offset before world look-push. Y lifts above the stump; Z is tuned
// after the world-space eye push in CameraSystem (bone axes vary by rig).
export const NECK_CAMERA_OFFSET = new THREE.Vector3(0, 0.06, 0.02);
export const HAND_IK_MAX_DISTANCE = 2.2;
/** Near-zero bone scale for FP head hide (keeps hierarchy / skinning valid). */
export const FP_HIDE_BONE_SCALE = 0.001;
/** Neck shrinks more gently so collar weights don't crater the shoulders. */
export const FP_HIDE_NECK_SCALE = 0.08;

/** Weighted spine aim layers — applied after mixer update. */
export const SPINE_AIM_LAYERS = Object.freeze([
  { names: ['mixamorigSpine', 'mixamorig6Spine', 'Spine'], weight: 0.2 },
  { names: ['mixamorigSpine1', 'mixamorig6Spine1', 'Spine1'], weight: 0.28 },
  { names: ['mixamorigSpine2', 'mixamorig6Spine2', 'Spine2'], weight: 0.35 },
]);

const HEAD_BONE_NAMES = ['mixamorigHead', 'mixamorig6Head', 'Head'];
const NECK_BONE_NAMES = ['mixamorigNeck', 'mixamorig6Neck', 'Neck'];

const AIM_AXIS = new THREE.Vector3(1, 0, 0);
const _aimQuat = new THREE.Quaternion();

/** Max cover-peek lean, radians of spine roll at amount = ±1. */
export const LEAN_ANGLE_LIMIT = 0.52;
const LEAN_AXIS = new THREE.Vector3(0, 0, 1);
const _leanQuat = new THREE.Quaternion();

/**
 * 8-way locomotion key for armed FP stance.
 * @param {{forward:number, strafe:number, running:boolean, grounded:boolean}} motion
 * @returns {string}
 */
export function chooseLocomotion({ forward = 0, strafe = 0, running = false, grounded = true } = {}) {
  if (!grounded) return 'jump';

  const forwardAmount = Math.abs(forward);
  const strafeAmount = Math.abs(strafe);
  if (forwardAmount < 0.1 && strafeAmount < 0.1) return 'idle';

  if (forward > 0.1) {
    if (strafe > 0.2) return running ? 'runArcRight' : 'walkArcRight';
    if (strafe < -0.2) return running ? 'runArcLeft' : 'walkArcLeft';
    return running ? 'run' : 'walk';
  }

  if (forward < -0.1) {
    if (strafe > 0.2) return running ? 'runBackwardArcRight' : 'walkBackwardArcRight';
    if (strafe < -0.2) return running ? 'runBackwardArcLeft' : 'walkBackwardArcLeft';
    return running ? 'runBackward' : 'walkBackward';
  }

  if (running) return strafe > 0 ? 'runStrafeRight' : 'runStrafeLeft';
  return strafe > 0 ? 'strafeRight' : 'strafeLeft';
}

/** Collapse 8-way locomotion keys onto the rifle pack's available clips. */
const FP_RIFLE_KEY_ALIASES = Object.freeze({
  idle: 'idle',
  jump: 'jump',
  walk: 'walk',
  walkArcLeft: 'walk',
  walkArcRight: 'walk',
  run: 'run',
  runArcLeft: 'run',
  runArcRight: 'run',
  runStrafeLeft: 'strafeLeft',
  runStrafeRight: 'strafeRight',
  strafeLeft: 'strafeLeft',
  strafeRight: 'strafeRight',
  walkBackward: 'walkBackward',
  walkBackwardArcLeft: 'walkBackward',
  walkBackwardArcRight: 'walkBackward',
  runBackward: 'runBackward',
  runBackwardArcLeft: 'runBackward',
  runBackwardArcRight: 'runBackward',
});

/**
 * Map a chooseLocomotion key onto animation states.
 * With rifle pack loaded: `fp_idle` / `fp_walk` / …
 * Fallback: great-sword armed locomotion (still better than unarmed while holding a gun).
 */
export function mapLocomotionToPlaybackState(locoKey, { hasWeaponPack = false } = {}) {
  if (hasWeaponPack) {
    const key = FP_RIFLE_KEY_ALIASES[locoKey] || 'idle';
    return `fp_${key}`;
  }
  switch (locoKey) {
    case 'idle':
      return 'armedIdle';
    case 'jump':
      return 'jump';
    case 'run':
    case 'runArcLeft':
    case 'runArcRight':
    case 'runStrafeLeft':
    case 'runStrafeRight':
      return 'armedJog';
    case 'walk':
    case 'walkArcLeft':
    case 'walkArcRight':
    case 'strafeLeft':
    case 'strafeRight':
      return 'armedWalk';
    case 'runBackward':
    case 'runBackwardArcLeft':
    case 'runBackwardArcRight':
    case 'walkBackward':
    case 'walkBackwardArcLeft':
    case 'walkBackwardArcRight':
      return 'armedJog';
    default:
      return 'armedIdle';
  }
}

/** Zero horizontal hip translation so FP locomotion doesn't slide the body. */
export function stripHorizontalRootMotion(clip) {
  if (!clip?.tracks) return clip;
  const hipsTrack = clip.tracks.find((track) => track.name.endsWith('Hips.position'));
  if (!hipsTrack) return clip;
  const values = hipsTrack.values;
  const baseX = values[0];
  const baseZ = values[2];
  for (let i = 0; i < values.length; i += 3) {
    values[i] = baseX;
    values[i + 2] = baseZ;
  }
  return clip;
}

export function findNamedBone(root, names, pattern = null) {
  if (!root) return null;
  for (const name of names) {
    const bone = root.getObjectByName?.(name);
    if (bone) return bone;
  }
  if (!pattern) return null;
  let found = null;
  root.traverse?.((child) => {
    if (!found && child.isBone && pattern.test(child.name)) found = child;
  });
  return found;
}

export function findHeadBone(root) {
  return findNamedBone(root, HEAD_BONE_NAMES, /head/i);
}

export function findNeckBone(root) {
  return findNamedBone(root, NECK_BONE_NAMES, /neck/i);
}

export function resolveSpineAimBones(root) {
  const layers = [];
  for (const layer of SPINE_AIM_LAYERS) {
    const bone = findNamedBone(root, layer.names);
    if (bone) layers.push({ bone, weight: layer.weight });
  }
  return layers;
}

/**
 * Apply look-pitch across weighted spine bones (local X). Call after mixer update.
 *
 * This is an ADDITIVE offset on top of the mixer-written pose, which is only safe
 * if the mixer re-keys the spine every frame. A layered clip that omits the spine
 * (e.g. an upper-body reload that only keys the arms) leaves the bone untouched,
 * so a naive `quaternion.multiply` would compound each frame — `base × aim^n` —
 * and wind the whole torso up. We defend against that by caching, per bone, the
 * base we started from and the result we produced: if the bone still holds exactly
 * our last output, the mixer did NOT re-key it, so we restore the base before
 * re-applying (idempotent — no accumulation).
 *
 * @param {Array<{bone:THREE.Bone, weight:number}>} spineAimBones
 * @param {number} aimPitch  camera pitch (rad), positive look-down convention may vary
 */
export function applySpineAimPitch(spineAimBones, aimPitch = 0) {
  if (!spineAimBones?.length) return;
  const pitch = THREE.MathUtils.clamp(aimPitch, -AIM_PITCH_LIMIT, AIM_PITCH_LIMIT);
  for (const { bone, weight } of spineAimBones) {
    if (!bone) continue;
    const ud = bone.userData;
    // Mixer didn't re-key this bone this frame → still our last output → undo it.
    if (ud._spineAimBase && ud._spineAimOut
      && quatsClose(bone.quaternion, ud._spineAimOut)) {
      bone.quaternion.copy(ud._spineAimBase);
    }
    // Snapshot the fresh base, apply the aim offset, and remember the result.
    if (!ud._spineAimBase) ud._spineAimBase = new THREE.Quaternion();
    if (!ud._spineAimOut) ud._spineAimOut = new THREE.Quaternion();
    ud._spineAimBase.copy(bone.quaternion);
    _aimQuat.setFromAxisAngle(AIM_AXIS, pitch * weight);
    bone.quaternion.multiply(_aimQuat);
    ud._spineAimOut.copy(bone.quaternion);
  }
}

/** True when two quaternions represent the same orientation (sign-agnostic). */
function quatsClose(a, b, eps = 1e-6) {
  return Math.abs(Math.abs(a.dot(b)) - 1) <= eps;
}

/**
 * Additive cover-peek lean — roll the weighted spine bones about the forward (Z)
 * axis. Call after the mixer update (same seam as applySpineAimPitch). The packs
 * ship no lean mocap, so this is a procedural layer shared by FP + TP.
 * @param {Array<{bone:THREE.Bone, weight:number}>} spineBones
 * @param {number} amount  [-1,1]; +1 = lean right (swap sign if it reads inverted)
 */
export function applyLeanRoll(spineBones, amount = 0) {
  if (!spineBones?.length) return;
  const roll = -THREE.MathUtils.clamp(amount, -1, 1) * LEAN_ANGLE_LIMIT;
  for (const { bone, weight } of spineBones) {
    if (!bone) continue;
    _leanQuat.setFromAxisAngle(LEAN_AXIS, roll * weight);
    bone.quaternion.multiply(_leanQuat);
  }
}

function scaleBoneForFpHide(bone, hidden, scaleKey, hideScale) {
  if (!bone) return;
  if (hidden) {
    if (!bone.userData[scaleKey]) {
      bone.userData[scaleKey] = bone.scale.clone();
    }
    bone.scale.setScalar(hideScale);
  } else if (bone.userData[scaleKey]) {
    bone.scale.copy(bone.userData[scaleKey]);
    delete bone.userData[scaleKey];
  } else {
    bone.scale.set(1, 1, 1);
  }
}

/**
 * Hide (or restore) head + neck for FP camera so the "neck nub" doesn't fill the view.
 * Uses scale so hierarchy / skinning stay intact. Neck is only partially collapsed
 * to avoid cratering collar/shoulder weights.
 *
 * @returns {{head:THREE.Object3D|null, neck:THREE.Object3D|null}}
 */
export function setHeadHidden(root, hidden) {
  const head = findHeadBone(root);
  const neck = findNeckBone(root);
  scaleBoneForFpHide(head, hidden, '_fpHeadScale', FP_HIDE_BONE_SCALE);
  // If neck is an ancestor of head, scaling neck also scales head — still set head
  // explicitly so head-only rigs and restore paths stay correct.
  scaleBoneForFpHide(neck, hidden, '_fpNeckScale', FP_HIDE_NECK_SCALE);
  return { head, neck };
}

/**
 * World position for the FP camera from neck bone + offset.
 * Falls back to character origin + eye height if no neck.
 */
export function getNeckCameraWorldPosition(root, out = new THREE.Vector3(), offset = NECK_CAMERA_OFFSET) {
  const neck = findNeckBone(root);
  if (neck) {
    neck.getWorldPosition(out);
    const worldQuat = new THREE.Quaternion();
    neck.getWorldQuaternion(worldQuat);
    const localOffset = offset.clone().applyQuaternion(worldQuat);
    out.add(localOffset);
    return out;
  }
  if (root?.getWorldPosition) {
    root.getWorldPosition(out);
    out.y += 1.62;
  }
  return out;
}

/**
 * Convert CameraSystem yaw → character.group.rotation.y convention.
 *
 * Camera yaw 0 looks along world −Z (`forward = (-sin y, 0, -cos y)`).
 * Body yaw from MovementSystem uses `atan2(vx, vz)`, so facing −Z is `π`.
 */
export function cameraYawToBodyYaw(cameraYaw) {
  return cameraYaw + Math.PI;
}

/** Normalize angle delta into (−π, π]. */
export function shortestAngleDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Soft neck twist limit (~±50° default). Looking past this rotates the body so
 * the camera never peers into the chest/shoulder interior.
 *
 * Within the limit the body stays put (natural look-around). Outside, body yaw
 * is hard-clamped so relative camera–body yaw never exceeds maxNeckYaw.
 *
 * When `straighten` is true (forward movement), the body turns to fully face
 * the camera look direction — clearing any stand-still neck offset.
 *
 * @param {THREE.Object3D} body  character.group
 * @param {number} cameraYaw    CameraSystem.yaw
 * @param {{maxNeckYaw?:number, straighten?:boolean, delta?:number, straightenSmoothing?:number}} [opts]
 * @returns {{bodyYaw:number, relativeYaw:number, turned:boolean, straightened:boolean}}
 */
export function applyFirstPersonBodyYaw(body, cameraYaw, {
  maxNeckYaw = 0.72, // ~41° — short of full shoulder; past this body follows
  straighten = false,
  delta = 1 / 60,
  straightenSmoothing = 16,
} = {}) {
  if (!body) {
    return { bodyYaw: 0, relativeYaw: 0, turned: false, straightened: false };
  }

  const facingYaw = cameraYawToBodyYaw(cameraYaw);
  let bodyYaw = body.rotation.y;
  const relative = shortestAngleDelta(bodyYaw, facingYaw);

  if (straighten) {
    // Moving forward: blend body fully onto camera facing (no neck offset).
    const rate = Math.max(0, straightenSmoothing);
    const alpha = rate <= 0 || !(delta > 0)
      ? 1
      : 1 - Math.exp(-rate * delta);
    bodyYaw = bodyYaw + relative * alpha;
    body.rotation.y = bodyYaw;
    const nextRel = shortestAngleDelta(bodyYaw, facingYaw);
    return {
      bodyYaw,
      relativeYaw: nextRel,
      turned: Math.abs(relative) > 1e-5,
      straightened: true,
    };
  }

  const limit = Math.max(0, maxNeckYaw);
  const clampedRel = THREE.MathUtils.clamp(relative, -limit, limit);
  const nextBodyYaw = facingYaw - clampedRel;
  const turned = Math.abs(relative) > limit + 1e-5;
  body.rotation.y = nextBodyYaw;
  return { bodyYaw: nextBodyYaw, relativeYaw: clampedRel, turned, straightened: false };
}

/**
 * True when the player is driving significant forward locomotion (not pure
 * strafe/backpedal). Used to straighten the FP body onto the look direction.
 */
export function isFirstPersonForwardIntent(input, character = null) {
  const axes = movementToLocomotionAxes(
    { speed: character?.speed ?? 0 },
    input || {},
  );
  // Forward stick/keys dominate; small residual from noise ignored.
  return axes.forward > 0.15;
}

/**
 * Build camera-relative forward/strafe inputs in [-1,1] for chooseLocomotion.
 */
export function movementToLocomotionAxes(movement, input) {
  // InputSystem: moveX = right-left, moveZ = backward-forward (so forward key → moveZ = -1).
  const strafe = Number(input?.strafe ?? input?.moveX ?? 0) || 0;
  let forward = Number(input?.forward ?? 0) || 0;
  if (input?.moveZ != null || input?.moveY != null) {
    // Convert engine moveZ (back-positive) to locomotion forward (front-positive).
    const moveZ = Number(input.moveZ ?? input.moveY ?? 0) || 0;
    forward = -moveZ;
  }
  if (Math.abs(forward) > 0.01 || Math.abs(strafe) > 0.01) {
    return { forward, strafe };
  }
  // Approximate from movement intent if present.
  const intent = movement?.moveIntent || movement?.wishDir;
  if (intent && (Math.abs(intent.x) > 0.01 || Math.abs(intent.z) > 0.01)) {
    return {
      forward: -intent.z || 0,
      strafe: intent.x || 0,
    };
  }
  const speed = movement?.speed ?? 0;
  if (speed > 0.4) {
    return { forward: 1, strafe: 0 };
  }
  return { forward: 0, strafe: 0 };
}
