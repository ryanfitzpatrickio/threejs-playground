/**
 * Live propane-tank carry debug values.
 *
 * Socket pose is metres / degrees relative to the spine carry bone.
 * Hands IK onto the tank grips — move the tank (or grip offsets) and the arms follow.
 */

import * as THREE from 'three';

const _euler = new THREE.Euler(0, 0, 0, 'XYZ');
const _quat = new THREE.Quaternion();

const cloneVec3 = (src, fallback = [0, 0, 0]) => [
  Number.isFinite(Number(src?.[0])) ? Number(src[0]) : fallback[0],
  Number.isFinite(Number(src?.[1])) ? Number(src[1]) : fallback[1],
  Number.isFinite(Number(src?.[2])) ? Number(src[2]) : fallback[2],
];

/** Authored defaults (live-tuned 2026-07-17 carry fit). */
export const PROPANE_CARRY_DEBUG_DEFAULTS = Object.freeze({
  // Spine-relative tank pose (metres / Euler °). Mid-body of the tank aims here.
  socketPosition: Object.freeze([0.33, -0.52, 0.785]),
  socketRotationDeg: Object.freeze([-27.5, 0, 11.5]),
  /** Multiplier on the Mixamo scale-cancel (1 = real-world metres). */
  socketScale: 1,

  // Grip markers in tank-local space (metres). Hands IK to these.
  leftGripPosition: Object.freeze([-0.26, -0.045, 0.5]),
  leftGripRotationDeg: Object.freeze([105.5, 0, 31.5]),
  rightGripPosition: Object.freeze([0.5, -0.445, -0.5]),
  rightGripRotationDeg: Object.freeze([-180, 58.5, -47]),

  // Two-bone arm IK onto the grips.
  leftIkEnabled: true,
  rightIkEnabled: true,
  leftIkHandBlend: 1,
  rightIkHandBlend: 1,
  leftIkElbowPole: Object.freeze([0.5, -0.55, -0.9]),
  rightIkElbowPole: Object.freeze([-0.75, -0.35, 2]),
  leftIkElbowSwingDeg: -12,
  rightIkElbowSwingDeg: 4,
  leftIkElbowBendDeg: 46,
  rightIkElbowBendDeg: 124,
});

export const propaneCarryDebugSocket = {
  socketPosition: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.socketPosition),
  socketRotationDeg: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.socketRotationDeg),
  socketScale: PROPANE_CARRY_DEBUG_DEFAULTS.socketScale,
  leftGripPosition: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.leftGripPosition),
  leftGripRotationDeg: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.leftGripRotationDeg),
  rightGripPosition: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.rightGripPosition),
  rightGripRotationDeg: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.rightGripRotationDeg),
  leftIkEnabled: PROPANE_CARRY_DEBUG_DEFAULTS.leftIkEnabled,
  rightIkEnabled: PROPANE_CARRY_DEBUG_DEFAULTS.rightIkEnabled,
  leftIkHandBlend: PROPANE_CARRY_DEBUG_DEFAULTS.leftIkHandBlend,
  rightIkHandBlend: PROPANE_CARRY_DEBUG_DEFAULTS.rightIkHandBlend,
  leftIkElbowPole: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.leftIkElbowPole),
  rightIkElbowPole: cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS.rightIkElbowPole),
  leftIkElbowSwingDeg: PROPANE_CARRY_DEBUG_DEFAULTS.leftIkElbowSwingDeg,
  rightIkElbowSwingDeg: PROPANE_CARRY_DEBUG_DEFAULTS.rightIkElbowSwingDeg,
  leftIkElbowBendDeg: PROPANE_CARRY_DEBUG_DEFAULTS.leftIkElbowBendDeg,
  rightIkElbowBendDeg: PROPANE_CARRY_DEBUG_DEFAULTS.rightIkElbowBendDeg,
  revision: 0,
};

export function bumpPropaneCarryDebugSocket() {
  propaneCarryDebugSocket.revision += 1;
  return propaneCarryDebugSocket.revision;
}

export function resetPropaneCarryDebugSocket() {
  for (const key of [
    'socketPosition',
    'socketRotationDeg',
    'leftGripPosition',
    'leftGripRotationDeg',
    'rightGripPosition',
    'rightGripRotationDeg',
    'leftIkElbowPole',
    'rightIkElbowPole',
  ]) {
    propaneCarryDebugSocket[key] = cloneVec3(PROPANE_CARRY_DEBUG_DEFAULTS[key]);
  }
  for (const key of [
    'socketScale',
    'leftIkHandBlend',
    'rightIkHandBlend',
    'leftIkElbowSwingDeg',
    'rightIkElbowSwingDeg',
    'leftIkElbowBendDeg',
    'rightIkElbowBendDeg',
  ]) {
    propaneCarryDebugSocket[key] = PROPANE_CARRY_DEBUG_DEFAULTS[key];
  }
  propaneCarryDebugSocket.leftIkEnabled = PROPANE_CARRY_DEBUG_DEFAULTS.leftIkEnabled;
  propaneCarryDebugSocket.rightIkEnabled = PROPANE_CARRY_DEBUG_DEFAULTS.rightIkEnabled;
  bumpPropaneCarryDebugSocket();
  return propaneCarryDebugSocket;
}

export function getPropaneCarryDebugQuaternion(values, out = _quat) {
  _euler.set(
    THREE.MathUtils.degToRad(Number(values?.[0]) || 0),
    THREE.MathUtils.degToRad(Number(values?.[1]) || 0),
    THREE.MathUtils.degToRad(Number(values?.[2]) || 0),
    'XYZ',
  );
  return out.setFromEuler(_euler);
}

/** IK config object consumed by firstPersonHandIk.updateMeleeHandIk. */
export function getPropaneCarryIkConfig() {
  const s = propaneCarryDebugSocket;
  return {
    leftIkEnabled: s.leftIkEnabled === true,
    rightIkEnabled: s.rightIkEnabled === true,
    leftIkHandBlend: s.leftIkHandBlend,
    rightIkHandBlend: s.rightIkHandBlend,
    leftIkElbowPole: s.leftIkElbowPole,
    rightIkElbowPole: s.rightIkElbowPole,
    leftIkElbowSwingDeg: s.leftIkElbowSwingDeg,
    rightIkElbowSwingDeg: s.rightIkElbowSwingDeg,
    leftIkElbowBendDeg: s.leftIkElbowBendDeg,
    rightIkElbowBendDeg: s.rightIkElbowBendDeg,
  };
}

/**
 * Apply live grip marker offsets onto a held tank (tank-local space).
 * @param {object} item createPropaneTank result
 */
export function applyPropaneCarryGripDebug(item) {
  if (!item) return false;
  const s = propaneCarryDebugSocket;
  if (item.leftGrip) {
    item.leftGrip.position.set(...s.leftGripPosition);
    item.leftGrip.quaternion.copy(getPropaneCarryDebugQuaternion(s.leftGripRotationDeg));
  }
  if (item.rightGrip) {
    item.rightGrip.position.set(...s.rightGripPosition);
    item.rightGrip.quaternion.copy(getPropaneCarryDebugQuaternion(s.rightGripRotationDeg));
  }
  return true;
}

export function logPropaneCarryDebugSocket() {
  const s = propaneCarryDebugSocket;
  const snapshot = {
    socketPosition: [...s.socketPosition],
    socketRotationDeg: [...s.socketRotationDeg],
    socketScale: s.socketScale,
    leftGripPosition: [...s.leftGripPosition],
    leftGripRotationDeg: [...s.leftGripRotationDeg],
    rightGripPosition: [...s.rightGripPosition],
    rightGripRotationDeg: [...s.rightGripRotationDeg],
    leftIkEnabled: s.leftIkEnabled,
    rightIkEnabled: s.rightIkEnabled,
    leftIkHandBlend: s.leftIkHandBlend,
    rightIkHandBlend: s.rightIkHandBlend,
    leftIkElbowPole: [...s.leftIkElbowPole],
    rightIkElbowPole: [...s.rightIkElbowPole],
    leftIkElbowSwingDeg: s.leftIkElbowSwingDeg,
    rightIkElbowSwingDeg: s.rightIkElbowSwingDeg,
    leftIkElbowBendDeg: s.leftIkElbowBendDeg,
    rightIkElbowBendDeg: s.rightIkElbowBendDeg,
  };
  console.info('[propane-carry-debug] socket', snapshot);
  return snapshot;
}
