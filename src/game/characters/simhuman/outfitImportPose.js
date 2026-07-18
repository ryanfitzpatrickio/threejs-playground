/**
 * Body pose helpers for the Outfit Import Studio.
 *
 * Weight transfer is spatial: the body must match the cloth pose (often
 * arms-down Meshy) before Blender DATA_TRANSFER.
 *
 * Local-euler offsets are unreliable across UBC/UE vs Rigify bind rolls, so
 * named presets use **world-space bone aiming**. Bake JSON still exports local
 * euler deltas relative to bind so Blender can reproduce the same pose.
 */

import * as THREE from 'three';

/** @typedef {{ x?: number, y?: number, z?: number }} EulerDeg */
/** @typedef {Record<string, EulerDeg>} BodyPoseDict */

export const OUTFIT_IMPORT_POSE_PRESETS = Object.freeze({
  rest: Object.freeze({ procedure: 'rest' }),
  'a-pose': Object.freeze({ procedure: 'a-pose' }),
  'arms-down': Object.freeze({ procedure: 'arms-down' }),
  'arms-forward': Object.freeze({ procedure: 'arms-forward' }),
  crouch: Object.freeze({ procedure: 'crouch' }),
});

/** Macro slider definitions. Applied after / with the named procedure. */
export const OUTFIT_IMPORT_MACRO_SLIDERS = Object.freeze([
  Object.freeze({
    id: 'armDown',
    label: 'Arm down',
    min: 0,
    max: 100,
    default: 0,
    unit: '%',
    /** 0 = bind height, 100 = full world-down */
    kind: 'armDownBlend',
  }),
  Object.freeze({
    id: 'armOut',
    label: 'Arm out',
    min: -40,
    max: 90,
    default: 0,
    unit: '°',
    /**
     * Lateral aim: + = away from torso (A-pose / wide sleeves),
     * − = toward torso (inward). Degrees-ish mapped to direction mix.
     */
    kind: 'armOut',
  }),
  Object.freeze({
    id: 'elbow',
    label: 'Elbow bend',
    min: 0,
    max: 120,
    default: 0,
    unit: '°',
    kind: 'elbow',
  }),
  Object.freeze({
    id: 'spineBend',
    label: 'Spine bend',
    min: -30,
    max: 40,
    default: 0,
    unit: '°',
    kind: 'spine',
  }),
  Object.freeze({
    id: 'thighSpread',
    label: 'Thigh spread',
    min: -15,
    max: 40,
    default: 0,
    unit: '°',
    kind: 'thigh',
  }),
  Object.freeze({
    id: 'kneeBend',
    label: 'Knee bend',
    min: 0,
    max: 110,
    default: 0,
    unit: '°',
    kind: 'knee',
  }),
]);

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _target = new THREE.Vector3();
const _align = new THREE.Quaternion();
const _worldQ = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _localQ = new THREE.Quaternion();
const _deltaQ = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _qRest = new THREE.Quaternion();
const _down = new THREE.Vector3(0, -1, 0);
const _forward = new THREE.Vector3(0, 0, 1);
const _armTarget = new THREE.Vector3();
const _rootInverse = new THREE.Matrix4();
const _boneRelative = new THREE.Matrix4();
const _boneDelta = new THREE.Matrix4();
const _identityMatrix = new THREE.Matrix4();

/**
 * World aim direction for an upper arm: mostly down, with lateral "out" mix.
 * @param {'L'|'R'} side
 * @param {number} outAmount 0 = pure down, 1 = 45° A-pose out, can be >1 or negative (in)
 */
export function armAimDirection(side, outAmount = 0) {
  // Character left is typically +X in UBC/glTF Y-up. Out = away from midline.
  const lateral = side === 'R' ? -1 : 1;
  // Map outAmount: 0 → (0,-1,0), 1 → roughly 35° from vertical outward.
  const out = Number(outAmount) || 0;
  _armTarget.set(lateral * out, -1, 0);
  if (_armTarget.lengthSq() < 1e-10) _armTarget.copy(_down);
  else _armTarget.normalize();
  return _armTarget;
}

/**
 * Resolve bone by name with DEF- / sanitized fallbacks.
 * @param {Record<string, THREE.Bone>} bonesMap
 * @param {string} name
 */
export function findBone(bonesMap, name) {
  if (!bonesMap || !name) return null;
  if (bonesMap[name]?.isBone) return bonesMap[name];
  if (!name.startsWith('DEF-') && bonesMap[`DEF-${name}`]?.isBone) {
    return bonesMap[`DEF-${name}`];
  }
  const stripped = name.startsWith('DEF-') ? name.slice(4) : name;
  if (bonesMap[stripped]?.isBone) return bonesMap[stripped];
  // Sanitized (no punctuation) — matches AnimationMixer / toRuntimeRigifyBoneName
  const sanitized = name.replace(/[\[\]\.:/]/g, '');
  if (bonesMap[sanitized]?.isBone) return bonesMap[sanitized];
  const lower = name.toLowerCase();
  for (const [k, bone] of Object.entries(bonesMap)) {
    if (!bone?.isBone) continue;
    if (k.toLowerCase() === lower) return bone;
    if (k.replace(/[\[\]\.:/]/g, '').toLowerCase() === sanitized.toLowerCase()) return bone;
  }
  // Fuzzy: ends with upper_arm.L / upperarml etc.
  const tail = stripped.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, bone] of Object.entries(bonesMap)) {
    if (!bone?.isBone) continue;
    const kt = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (kt === tail || kt.endsWith(tail) || tail.endsWith(kt)) return bone;
  }
  return null;
}

/**
 * @param {Record<string, THREE.Bone>} bonesMap
 * @returns {Map<string, THREE.Quaternion>}
 */
export function captureRestQuaternions(bonesMap = {}) {
  const rest = new Map();
  const seen = new Set();
  for (const [name, bone] of Object.entries(bonesMap)) {
    if (!bone?.isBone || seen.has(bone)) continue;
    seen.add(bone);
    const q = bone.quaternion.clone();
    rest.set(bone.name, q);
    rest.set(name, q);
    const san = bone.name.replace(/[\[\]\.:/]/g, '');
    rest.set(san, q);
  }
  return rest;
}

/**
 * Capture bind-pose bone matrices relative to the model root.
 *
 * Blender and Three.js use different local bone rolls, so local Euler or
 * quaternion deltas are not portable between them. World-space deltas in the
 * source glTF coordinate system are portable after one Y-up → Z-up conversion.
 * @param {Record<string, THREE.Bone>} bonesMap
 * @param {THREE.Object3D} root
 * @returns {Map<THREE.Bone, THREE.Matrix4>}
 */
export function captureRestWorldMatrices(bonesMap = {}, root) {
  const rest = new Map();
  if (!root) return rest;
  root.updateWorldMatrix(true, true);
  _rootInverse.copy(root.matrixWorld).invert();
  const seen = new Set();
  for (const bone of Object.values(bonesMap)) {
    if (!bone?.isBone || seen.has(bone)) continue;
    seen.add(bone);
    bone.updateWorldMatrix(true, false);
    rest.set(bone, new THREE.Matrix4().multiplyMatrices(_rootInverse, bone.matrixWorld));
  }
  return rest;
}

/**
 * Serialize exact current-vs-bind world deltas for Blender.
 * Matrix arrays use Three.js/glTF column-major layout.
 * @param {Record<string, THREE.Bone>} bonesMap
 * @param {Map<THREE.Bone, THREE.Matrix4>} restWorldMatrices
 * @param {THREE.Object3D} root
 */
export function capturePoseWorldDeltas(bonesMap = {}, restWorldMatrices, root) {
  const bones = {};
  if (!root || !restWorldMatrices?.size) {
    return { format: 'bone-world-delta-v1', space: 'gltf-y-up', bones };
  }
  root.updateWorldMatrix(true, true);
  _rootInverse.copy(root.matrixWorld).invert();
  const seen = new Set();
  for (const bone of Object.values(bonesMap)) {
    if (!bone?.isBone || seen.has(bone)) continue;
    seen.add(bone);
    const rest = restWorldMatrices.get(bone);
    if (!rest) continue;
    bone.updateWorldMatrix(true, false);
    _boneRelative.multiplyMatrices(_rootInverse, bone.matrixWorld);
    _boneDelta.multiplyMatrices(_boneRelative, rest.clone().invert());
    const elements = _boneDelta.elements;
    const identity = _identityMatrix.elements;
    let maxDelta = 0;
    for (let i = 0; i < 16; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs(elements[i] - identity[i]));
    }
    if (maxDelta < 1e-7) continue;
    bones[bone.name] = elements.map((value) => Math.round(value * 1e7) / 1e7);
  }
  return { format: 'bone-world-delta-v1', space: 'gltf-y-up', bones };
}

/** Reset all bones to captured rest locals. */
export function resetBonesToRest(bonesMap, restQuats) {
  if (!bonesMap || !restQuats) return;
  const seen = new Set();
  for (const bone of Object.values(bonesMap)) {
    if (!bone?.isBone || seen.has(bone)) continue;
    seen.add(bone);
    const rest = restQuats.get(bone.name);
    if (rest) {
      bone.quaternion.copy(rest);
      bone.matrixAutoUpdate = true;
    }
  }
}

/**
 * Rotate a bone in world space so its along-axis aims at `worldDir` (unit).
 * blend 0 = unchanged, 1 = full aim.
 * @returns {boolean}
 */
export function aimBoneWorldDirection(bone, childBone, worldDir, blend = 1) {
  if (!bone?.isBone) return false;
  const b = THREE.MathUtils.clamp(blend, 0, 1);
  if (b < 1e-6) return false;

  bone.updateWorldMatrix(true, false);
  childBone?.updateWorldMatrix?.(true, false);

  // Bone along-axis in world: prefer head→child, else local +Y transformed.
  if (childBone?.isBone) {
    _vA.setFromMatrixPosition(bone.matrixWorld);
    _vB.setFromMatrixPosition(childBone.matrixWorld);
    _dir.subVectors(_vB, _vA);
  } else if (bone.children?.length) {
    const ch = bone.children.find((c) => c.isBone) ?? bone.children[0];
    _vA.setFromMatrixPosition(bone.matrixWorld);
    _vB.setFromMatrixPosition(ch.matrixWorld);
    _dir.subVectors(_vB, _vA);
  } else {
    _dir.set(0, 1, 0).transformDirection(bone.matrixWorld);
  }

  if (_dir.lengthSq() < 1e-10) return false;
  _dir.normalize();
  _target.copy(worldDir).normalize();

  // Already aligned?
  const dot = THREE.MathUtils.clamp(_dir.dot(_target), -1, 1);
  if (dot > 0.999) return true;

  // Full rotation that maps current bone axis → target direction.
  const fullAlign = new THREE.Quaternion().setFromUnitVectors(_dir, _target);
  if (b >= 1 - 1e-6) {
    _align.copy(fullAlign);
  } else {
    // Partial aim: slerp from identity toward fullAlign by blend.
    _align.identity().slerp(fullAlign, b);
  }

  bone.getWorldQuaternion(_worldQ);
  // Apply align in world space: q' = align * q
  _worldQ.premultiply(_align);

  if (bone.parent) {
    bone.parent.updateWorldMatrix(true, false);
    bone.parent.getWorldQuaternion(_parentQ);
    _localQ.copy(_parentQ).invert().multiply(_worldQ);
  } else {
    _localQ.copy(_worldQ);
  }
  bone.quaternion.copy(_localQ).normalize();
  bone.matrixAutoUpdate = true;
  return true;
}

/** Local euler degrees additive on rest. */
export function applyLocalEulerOffset(bone, restQuat, eulerDeg, order = 'XYZ') {
  if (!bone?.isBone || !restQuat) return false;
  const x = THREE.MathUtils.degToRad(Number(eulerDeg?.x) || 0);
  const y = THREE.MathUtils.degToRad(Number(eulerDeg?.y) || 0);
  const z = THREE.MathUtils.degToRad(Number(eulerDeg?.z) || 0);
  if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-8) {
    bone.quaternion.copy(restQuat);
    return false;
  }
  _euler.set(x, y, z, order);
  _quat.setFromEuler(_euler);
  _qRest.copy(restQuat).multiply(_quat);
  bone.quaternion.copy(_qRest).normalize();
  bone.matrixAutoUpdate = true;
  return true;
}

/**
 * Apply a named procedure + macro sliders onto bones (already at rest).
 * @returns {{ applied: number, details: string[] }}
 */
export function applyPoseProcedure(bonesMap, restQuats, {
  procedure = 'rest',
  macros = {},
} = {}) {
  resetBonesToRest(bonesMap, restQuats);
  const details = [];
  let applied = 0;

  const armL = findBone(bonesMap, 'DEF-upper_arm.L');
  const armR = findBone(bonesMap, 'DEF-upper_arm.R');
  const foreL = findBone(bonesMap, 'DEF-forearm.L.001') || findBone(bonesMap, 'DEF-forearm.L');
  const foreR = findBone(bonesMap, 'DEF-forearm.R.001') || findBone(bonesMap, 'DEF-forearm.R');
  const handL = findBone(bonesMap, 'DEF-hand.L');
  const handR = findBone(bonesMap, 'DEF-hand.R');
  const shoulderL = findBone(bonesMap, 'DEF-shoulder.L');
  const shoulderR = findBone(bonesMap, 'DEF-shoulder.R');

  // Back-compat: old sessions used armAbduct as "down amount".
  const armDownMacro = THREE.MathUtils.clamp(
    Number(macros.armDown ?? macros.armAbduct) || 0,
    0,
    100,
  ) / 100;
  // Outward mix: slider degrees → direction weight. + = out, − = in.
  // 0° ≈ pure hang, 45° ≈ classic A-pose lateral, 90° ≈ nearly T.
  const armOutDeg = Number(macros.armOut);
  const armOutSlider = Number.isFinite(armOutDeg) ? armOutDeg : null;

  let armBlend = 0;
  let forwardBlend = 0;
  /** Baseline outward for named hang presets (A-pose bias, not glued-in). */
  let outBase = 0;
  if (procedure === 'arms-down') {
    armBlend = 0.92;
    outBase = 0.55; // default slight A-pose so sleeves aren't glued to ribs
  } else if (procedure === 'a-pose') {
    armBlend = 0.55;
    outBase = 0.85;
  } else if (procedure === 'arms-forward') {
    forwardBlend = 0.85;
    outBase = 0.2;
  } else if (armDownMacro > 1e-4) {
    // Down from rest with no preset: start a little out.
    outBase = 0.35;
  }
  // Slider alone can drive arms down from rest.
  armBlend = Math.max(armBlend, armDownMacro);
  // Arm-out slider is additive on the preset base: + = wider, − = more inward.
  // 45 on the slider ≈ +1.0 lateral weight vs the down axis.
  const outAdjust = (armOutSlider != null ? armOutSlider : 0) / 45;
  let outAmount = outBase + outAdjust;

  if (armBlend > 1e-4) {
    const dirL = armAimDirection('L', outAmount).clone();
    const dirR = armAimDirection('R', outAmount).clone();
    if (armL && aimBoneWorldDirection(armL, foreL || handL, dirL, armBlend)) {
      applied += 1;
      details.push(`arm.L↓${Math.round(armBlend * 100)}% out${outAmount >= 0 ? '+' : ''}${outAmount.toFixed(2)}`);
    }
    if (armR && aimBoneWorldDirection(armR, foreR || handR, dirR, armBlend)) {
      applied += 1;
      details.push(`arm.R↓${Math.round(armBlend * 100)}%`);
    }
    // Shoulders follow a weaker version of the same aim (helps wide sleeves).
    if (shoulderL && aimBoneWorldDirection(shoulderL, armL, dirL, armBlend * 0.3)) {
      applied += 1;
    }
    if (shoulderR && aimBoneWorldDirection(shoulderR, armR, dirR, armBlend * 0.3)) {
      applied += 1;
    }
  }

  if (forwardBlend > 1e-4) {
    if (armL && aimBoneWorldDirection(armL, foreL || handL, _forward, forwardBlend)) {
      applied += 1;
      details.push('upper_arm.L→fwd');
    }
    if (armR && aimBoneWorldDirection(armR, foreR || handR, _forward, forwardBlend)) {
      applied += 1;
      details.push('upper_arm.R→fwd');
    }
  }

  // Elbow bend (local)
  const elbow = Number(macros.elbow) || 0;
  const elbowExtra = procedure === 'arms-down' ? 12 : 0;
  const elbowDeg = elbow + elbowExtra;
  if (Math.abs(elbowDeg) > 0.5) {
    for (const [bone, restName] of [
      [foreL, 'DEF-forearm.L.001'],
      [foreR, 'DEF-forearm.R.001'],
    ]) {
      if (!bone) continue;
      const rest = restQuats.get(bone.name) ?? restQuats.get(restName);
      if (applyLocalEulerOffset(bone, rest, { x: elbowDeg, y: 0, z: 0 })) {
        applied += 1;
        details.push(`elbow ${Math.round(elbowDeg)}°`);
      }
    }
  }

  // Spine
  const spine = Number(macros.spineBend) || 0;
  if (Math.abs(spine) > 0.5 || procedure === 'crouch') {
    const s = procedure === 'crouch' ? spine + 14 : spine;
    for (const [name, scale] of [
      ['DEF-spine', 0.45],
      ['DEF-spine.001', 0.3],
      ['DEF-spine.002', 0.15],
    ]) {
      const bone = findBone(bonesMap, name);
      const rest = bone && (restQuats.get(bone.name) ?? restQuats.get(name));
      if (bone && rest && applyLocalEulerOffset(bone, rest, { x: s * scale, y: 0, z: 0 })) {
        applied += 1;
      }
    }
    if (Math.abs(s) > 0.5) details.push(`spine ${Math.round(s)}°`);
  }

  // Thighs / knees
  const thigh = Number(macros.thighSpread) || 0;
  const knee = Number(macros.kneeBend) || (procedure === 'crouch' ? 55 : 0);
  const thighCrouch = procedure === 'crouch' ? -30 : 0;
  if (Math.abs(thigh) + Math.abs(thighCrouch) > 0.5) {
    for (const [name, sign] of [['DEF-thigh.L', -1], ['DEF-thigh.R', 1]]) {
      const bone = findBone(bonesMap, name);
      const rest = bone && (restQuats.get(bone.name) ?? restQuats.get(name));
      if (bone && rest && applyLocalEulerOffset(bone, rest, {
        x: thighCrouch,
        y: 0,
        z: sign * (thigh || (procedure === 'crouch' ? 8 : 0)),
      })) {
        applied += 1;
      }
    }
  }
  if (Math.abs(knee) > 0.5) {
    for (const name of [
      'DEF-shin.L', 'DEF-shin.R',
      'DEF-shin.L.001', 'DEF-shin.R.001',
      'DEF-thigh.L.001', 'DEF-thigh.R.001',
    ]) {
      const bone = findBone(bonesMap, name);
      const rest = bone && (restQuats.get(bone.name) ?? restQuats.get(name));
      // shin.001 is shin on UBC; thigh.L.001 may be shin chain mid
      const isShin = /shin|thigh\.[LR]\.001/i.test(name);
      if (!isShin) continue;
      if (bone && rest && applyLocalEulerOffset(bone, rest, { x: knee * 0.9, y: 0, z: 0 })) {
        applied += 1;
      }
    }
    details.push(`knee ${Math.round(knee)}°`);
  }

  if (procedure === 'rest' && armBlend < 1e-4 && applied === 0) {
    details.push('rest');
  }

  // Report missing critical bones
  if ((procedure === 'arms-down' || armDownMacro > 0) && !armL && !armR) {
    details.push('WARN: no upper_arm bones found');
  }

  return { applied, details };
}

/**
 * Measure local euler deltas from rest → current for Blender bake JSON.
 * @returns {BodyPoseDict}
 */
export function capturePoseDeltas(bonesMap, restQuats) {
  /** @type {BodyPoseDict} */
  const pose = {};
  const seen = new Set();
  for (const bone of Object.values(bonesMap)) {
    if (!bone?.isBone || seen.has(bone)) continue;
    seen.add(bone);
    const rest = restQuats.get(bone.name);
    if (!rest) continue;
    // rest * delta = current  =>  delta = inv(rest) * current
    _deltaQ.copy(rest).invert().multiply(bone.quaternion).normalize();
    _euler.setFromQuaternion(_deltaQ, 'XYZ');
    const x = THREE.MathUtils.radToDeg(_euler.x);
    const y = THREE.MathUtils.radToDeg(_euler.y);
    const z = THREE.MathUtils.radToDeg(_euler.z);
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 0.15) continue;
    // Prefer DEF- style name for Blender
    const name = bone.name.startsWith('DEF-') || bone.name.startsWith('def')
      ? bone.name
      : (bone.name.includes('upper_arm') || bone.name.includes('spine')
        ? bone.name
        : bone.name);
    pose[name] = {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      z: Math.round(z * 100) / 100,
    };
  }
  return pose;
}

/** List bone names (for debug UI). */
export function listBoneNames(bonesMap) {
  const names = new Set();
  for (const bone of Object.values(bonesMap)) {
    if (bone?.isBone) names.add(bone.name);
  }
  return [...names].sort();
}
