/**
 * Live melee presentation/debug values. The sword remains hand-parented in
 * third person; these values adjust that socket and the optional sheath socket
 * without changing the authored asset or combat trace anchors.
 */

import * as THREE from 'three';

const _euler = new THREE.Euler(0, 0, 0, 'XYZ');
const _quat = new THREE.Quaternion();

const cloneVec3 = (src, fallback = [0, 0, 0]) => [
  Number.isFinite(Number(src?.[0])) ? Number(src[0]) : fallback[0],
  Number.isFinite(Number(src?.[1])) ? Number(src[1]) : fallback[1],
  Number.isFinite(Number(src?.[2])) ? Number(src[2]) : fallback[2],
];

/** Tuned Violet Tempest hand/IK/sheath defaults (2026-07-13 live fit). */
export const MELEE_DEBUG_DEFAULTS = Object.freeze({
  handPosition: Object.freeze([-0.195, 0.065, -0.055]),
  handRotationDeg: Object.freeze([29, -11.5, 15.5]),
  handScale: 0.71,
  leftIkEnabled: true,
  leftIkPosition: Object.freeze([0.02, 0.01, 0.1]),
  leftIkRotationDeg: Object.freeze([-70.5, -94, 39]),
  leftIkHandBlend: 1,
  leftIkElbowPole: Object.freeze([-0.15, -0.8, 0.25]),
  leftIkElbowSwingDeg: 0,
  leftIkElbowBendDeg: 0,
  rightIkEnabled: true,
  rightIkPosition: Object.freeze([0.285, -0.295, -0.01]),
  rightIkRotationDeg: Object.freeze([-141, -180, 172]),
  rightIkHandBlend: 1,
  rightIkElbowPole: Object.freeze([-0.6, -1, 0.15]),
  rightIkElbowSwingDeg: 31,
  rightIkElbowBendDeg: 0,
  sheathPosition: Object.freeze([0.015, -0.115, -0.145]),
  sheathRotationDeg: Object.freeze([4, -11.5, -4]),
  sheathScale: 0.74,
});

export const meleeDebugSocket = {
  handPosition: cloneVec3(MELEE_DEBUG_DEFAULTS.handPosition),
  handRotationDeg: cloneVec3(MELEE_DEBUG_DEFAULTS.handRotationDeg),
  handScale: MELEE_DEBUG_DEFAULTS.handScale,
  leftIkEnabled: MELEE_DEBUG_DEFAULTS.leftIkEnabled,
  leftIkPosition: cloneVec3(MELEE_DEBUG_DEFAULTS.leftIkPosition),
  leftIkRotationDeg: cloneVec3(MELEE_DEBUG_DEFAULTS.leftIkRotationDeg),
  leftIkHandBlend: MELEE_DEBUG_DEFAULTS.leftIkHandBlend,
  leftIkElbowPole: cloneVec3(MELEE_DEBUG_DEFAULTS.leftIkElbowPole),
  leftIkElbowSwingDeg: MELEE_DEBUG_DEFAULTS.leftIkElbowSwingDeg,
  leftIkElbowBendDeg: MELEE_DEBUG_DEFAULTS.leftIkElbowBendDeg,
  rightIkEnabled: MELEE_DEBUG_DEFAULTS.rightIkEnabled,
  rightIkPosition: cloneVec3(MELEE_DEBUG_DEFAULTS.rightIkPosition),
  rightIkRotationDeg: cloneVec3(MELEE_DEBUG_DEFAULTS.rightIkRotationDeg),
  rightIkHandBlend: MELEE_DEBUG_DEFAULTS.rightIkHandBlend,
  rightIkElbowPole: cloneVec3(MELEE_DEBUG_DEFAULTS.rightIkElbowPole),
  rightIkElbowSwingDeg: MELEE_DEBUG_DEFAULTS.rightIkElbowSwingDeg,
  rightIkElbowBendDeg: MELEE_DEBUG_DEFAULTS.rightIkElbowBendDeg,
  sheathPosition: cloneVec3(MELEE_DEBUG_DEFAULTS.sheathPosition),
  sheathRotationDeg: cloneVec3(MELEE_DEBUG_DEFAULTS.sheathRotationDeg),
  sheathScale: MELEE_DEBUG_DEFAULTS.sheathScale,
  revision: 0,
};

export function bumpMeleeDebugSocket() {
  meleeDebugSocket.revision += 1;
  return meleeDebugSocket.revision;
}

export function resetMeleeDebugSocket() {
  for (const key of ['handPosition', 'handRotationDeg', 'leftIkPosition', 'leftIkRotationDeg', 'leftIkElbowPole', 'rightIkPosition', 'rightIkRotationDeg', 'rightIkElbowPole', 'sheathPosition', 'sheathRotationDeg']) {
    meleeDebugSocket[key] = cloneVec3(MELEE_DEBUG_DEFAULTS[key]);
  }
  for (const key of ['handScale', 'leftIkHandBlend', 'leftIkElbowSwingDeg', 'leftIkElbowBendDeg', 'rightIkHandBlend', 'rightIkElbowSwingDeg', 'rightIkElbowBendDeg', 'sheathScale']) {
    meleeDebugSocket[key] = MELEE_DEBUG_DEFAULTS[key];
  }
  meleeDebugSocket.leftIkEnabled = MELEE_DEBUG_DEFAULTS.leftIkEnabled;
  meleeDebugSocket.rightIkEnabled = MELEE_DEBUG_DEFAULTS.rightIkEnabled;
  bumpMeleeDebugSocket();
  return meleeDebugSocket;
}

export function getMeleeDebugQuaternion(values, out = _quat) {
  _euler.set(
    THREE.MathUtils.degToRad(Number(values?.[0]) || 0),
    THREE.MathUtils.degToRad(Number(values?.[1]) || 0),
    THREE.MathUtils.degToRad(Number(values?.[2]) || 0),
    'XYZ',
  );
  return out.setFromEuler(_euler);
}

/** Apply the live socket values to an attached sword. */
export function applyMeleeDebugSocket(sword) {
  const group = sword?.group;
  if (!group?.userData?.meleeSocketBase) return false;
  const base = group.userData.meleeSocketBase;
  const parentScale = Number(base.parentScale) > 1e-6 ? base.parentScale : 1;

  group.position.set(
    base.position[0] + meleeDebugSocket.handPosition[0] / parentScale,
    base.position[1] + meleeDebugSocket.handPosition[1] / parentScale,
    base.position[2] + meleeDebugSocket.handPosition[2] / parentScale,
  );
  group.quaternion.copy(base.quaternion).multiply(getMeleeDebugQuaternion(meleeDebugSocket.handRotationDeg));
  group.scale.setScalar(base.scale * Math.max(0.01, Number(meleeDebugSocket.handScale) || 1));

  const sheath = sword.sheath?.group;
  const sheathBase = sheath?.userData?.meleeSocketBase;
  if (sheath && sheathBase) {
    const sheathParentScale = Number(sheathBase.parentScale) > 1e-6 ? sheathBase.parentScale : 1;
    sheath.position.set(
      sheathBase.position[0] + meleeDebugSocket.sheathPosition[0] / sheathParentScale,
      sheathBase.position[1] + meleeDebugSocket.sheathPosition[1] / sheathParentScale,
      sheathBase.position[2] + meleeDebugSocket.sheathPosition[2] / sheathParentScale,
    );
    sheath.quaternion.copy(sheathBase.quaternion).multiply(getMeleeDebugQuaternion(meleeDebugSocket.sheathRotationDeg));
    sheath.scale.setScalar(sheathBase.scale * Math.max(0.01, Number(meleeDebugSocket.sheathScale) || 1));
  }

  if (sword.leftGrip) {
    sword.leftGrip.position.set(...meleeDebugSocket.leftIkPosition);
    sword.leftGrip.quaternion.copy(getMeleeDebugQuaternion(meleeDebugSocket.leftIkRotationDeg));
  }
  if (sword.rightGrip) {
    sword.rightGrip.position.set(...meleeDebugSocket.rightIkPosition);
    sword.rightGrip.quaternion.copy(getMeleeDebugQuaternion(meleeDebugSocket.rightIkRotationDeg));
  }
  group.updateMatrixWorld(true);
  sheath?.updateMatrixWorld?.(true);
  return true;
}

export function logMeleeDebugSocket() {
  const snapshot = {
    handPosition: [...meleeDebugSocket.handPosition],
    handRotationDeg: [...meleeDebugSocket.handRotationDeg],
    handScale: meleeDebugSocket.handScale,
    leftIkEnabled: meleeDebugSocket.leftIkEnabled,
    leftIkPosition: [...meleeDebugSocket.leftIkPosition],
    leftIkRotationDeg: [...meleeDebugSocket.leftIkRotationDeg],
    leftIkHandBlend: meleeDebugSocket.leftIkHandBlend,
    leftIkElbowPole: [...meleeDebugSocket.leftIkElbowPole],
    leftIkElbowSwingDeg: meleeDebugSocket.leftIkElbowSwingDeg,
    leftIkElbowBendDeg: meleeDebugSocket.leftIkElbowBendDeg,
    rightIkEnabled: meleeDebugSocket.rightIkEnabled,
    rightIkPosition: [...meleeDebugSocket.rightIkPosition],
    rightIkRotationDeg: [...meleeDebugSocket.rightIkRotationDeg],
    rightIkHandBlend: meleeDebugSocket.rightIkHandBlend,
    rightIkElbowPole: [...meleeDebugSocket.rightIkElbowPole],
    rightIkElbowSwingDeg: meleeDebugSocket.rightIkElbowSwingDeg,
    rightIkElbowBendDeg: meleeDebugSocket.rightIkElbowBendDeg,
    sheathPosition: [...meleeDebugSocket.sheathPosition],
    sheathRotationDeg: [...meleeDebugSocket.sheathRotationDeg],
    sheathScale: meleeDebugSocket.sheathScale,
  };
  console.info('[melee-debug] socket', snapshot);
  return snapshot;
}
