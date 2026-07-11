/**
 * Live gun socket / presentation offsets for the runtime debug pane.
 * firstPersonHandIk reads these every layout so tweaks are immediate.
 *
 * - hand*: attach pose under mixamorigRightHand (meters + Euler °)
 * - gun*: extra offset after grip snap, in gun/weapon local space (meters + Euler ° + scale)
 * - leftIk*: support-hand target offset on left_hand_ik_target + hand rotation °
 */

import * as THREE from 'three';
import { getGunSocketPreset } from './gunHandSocket.js';
import { GUN_CATALOG } from './gunProfile.js';
import { defaultGunIdFromQuery } from './loadGunView.js';

const _euler = new THREE.Euler(0, 0, 0, 'XYZ');

function cloneVec3(src) {
  return [Number(src?.[0]) || 0, Number(src?.[1]) || 0, Number(src?.[2]) || 0];
}

/**
 * Copy a catalog gun's socket preset into the live debug socket.
 * @param {string} [gunId]
 * @param {{ bump?: boolean }} [opts]
 */
export function applyGunSocketPreset(gunId, { bump = true } = {}) {
  const id = gunId || gunDebugSocket.selectedGunId || defaultGunIdFromQuery();
  const preset = getGunSocketPreset(id);
  gunDebugSocket.selectedGunId = id;
  gunDebugSocket.handPosition = cloneVec3(preset.handPosition);
  gunDebugSocket.handRotationDeg = cloneVec3(preset.handRotationDeg);
  gunDebugSocket.gunPosition = cloneVec3(preset.gunPosition);
  gunDebugSocket.gunRotationDeg = cloneVec3(preset.gunRotationDeg);
  gunDebugSocket.gunScale = Number.isFinite(preset.gunScale) && preset.gunScale > 1e-4
    ? preset.gunScale
    : 1;
  gunDebugSocket.leftIkEnabled = preset.leftIkEnabled !== false;
  gunDebugSocket.leftIkPosition = cloneVec3(preset.leftIkPosition);
  gunDebugSocket.leftIkRotationDeg = cloneVec3(preset.leftIkRotationDeg);
  gunDebugSocket.leftIkHandBlend = Number.isFinite(preset.leftIkHandBlend)
    ? preset.leftIkHandBlend
    : 1;
  gunDebugSocket.leftIkElbowPole = cloneVec3(preset.leftIkElbowPole);
  gunDebugSocket.leftIkElbowSwingDeg = Number.isFinite(preset.leftIkElbowSwingDeg)
    ? preset.leftIkElbowSwingDeg
    : 0;
  gunDebugSocket.leftIkElbowBendDeg = Number.isFinite(preset.leftIkElbowBendDeg)
    ? preset.leftIkElbowBendDeg
    : 0;
  gunDebugSocket.rightIkEnabled = preset.rightIkEnabled !== false;
  gunDebugSocket.rightIkPosition = cloneVec3(preset.rightIkPosition);
  gunDebugSocket.rightIkRotationDeg = cloneVec3(preset.rightIkRotationDeg);
  gunDebugSocket.rightIkHandBlend = Number.isFinite(preset.rightIkHandBlend)
    ? preset.rightIkHandBlend
    : 1;
  gunDebugSocket.rightIkElbowPole = cloneVec3(preset.rightIkElbowPole);
  gunDebugSocket.rightIkElbowSwingDeg = Number.isFinite(preset.rightIkElbowSwingDeg)
    ? preset.rightIkElbowSwingDeg
    : 0;
  gunDebugSocket.rightIkElbowBendDeg = Number.isFinite(preset.rightIkElbowBendDeg)
    ? preset.rightIkElbowBendDeg
    : 0;
  gunDebugSocket.aimPitchGun = Number.isFinite(preset.aimPitchGun)
    ? preset.aimPitchGun
    : -1;
  gunDebugSocket.aimPitchSpine = Number.isFinite(preset.aimPitchSpine)
    ? preset.aimPitchSpine
    : -0.6;
  if (bump) bumpGunDebugSocket();
  return gunDebugSocket;
}

const _initialPreset = getGunSocketPreset(defaultGunIdFromQuery());

/** @type {{
 *  selectedGunId: string,
 *  handPosition: [number, number, number],
 *  handRotationDeg: [number, number, number],
 *  gunPosition: [number, number, number],
 *  gunRotationDeg: [number, number, number],
 *  gunScale: number,
 *  leftIkEnabled: boolean,
 *  leftIkPosition: [number, number, number],
 *  leftIkRotationDeg: [number, number, number],
 *  leftIkHandBlend: number,
 *  leftIkElbowPole: [number, number, number],
 *  leftIkElbowSwingDeg: number,
 *  leftIkElbowBendDeg: number,
 *  rightIkEnabled: boolean,
 *  rightIkPosition: [number, number, number],
 *  rightIkRotationDeg: [number, number, number],
 *  rightIkHandBlend: number,
 *  rightIkElbowPole: [number, number, number],
 *  rightIkElbowSwingDeg: number,
 *  rightIkElbowBendDeg: number,
 *  revision: number,
 * }} */
export const gunDebugSocket = {
  selectedGunId: defaultGunIdFromQuery(),
  handPosition: cloneVec3(_initialPreset.handPosition),
  handRotationDeg: cloneVec3(_initialPreset.handRotationDeg),
  gunPosition: cloneVec3(_initialPreset.gunPosition),
  gunRotationDeg: cloneVec3(_initialPreset.gunRotationDeg),
  gunScale: _initialPreset.gunScale ?? 1,
  leftIkEnabled: _initialPreset.leftIkEnabled !== false,
  // Offset of the left-hand IK target relative to left_hand_ik_target (gun-local meters).
  leftIkPosition: cloneVec3(_initialPreset.leftIkPosition),
  // Extra Euler XYZ ° applied to the left hand after IK (hand-local after aiming at target).
  leftIkRotationDeg: cloneVec3(_initialPreset.leftIkRotationDeg),
  // 0 = keep animated wrist, >0 = hard-lock palm to support target (no soft slerp).
  leftIkHandBlend: _initialPreset.leftIkHandBlend ?? 1,
  // Body-local elbow pole (left/down/forward). Where the elbow points.
  leftIkElbowPole: cloneVec3(_initialPreset.leftIkElbowPole),
  // Rotate pole around shoulder→hand axis (degrees). Fast fine-tune of elbow plane.
  leftIkElbowSwingDeg: _initialPreset.leftIkElbowSwingDeg ?? 0,
  // Preferred interior elbow angle ° (0 = auto from grip distance). ~90 right angle, ~160 straight.
  leftIkElbowBendDeg: _initialPreset.leftIkElbowBendDeg ?? 0,
  // Right (dominant) hand IK: reach grip_mount so the trigger hand follows the gun.
  rightIkEnabled: _initialPreset.rightIkEnabled !== false,
  // Offset of the right-hand IK target relative to grip_mount (gun-local meters).
  rightIkPosition: cloneVec3(_initialPreset.rightIkPosition),
  // Extra Euler XYZ ° applied to the right hand after IK (hand-local after gripping).
  rightIkRotationDeg: cloneVec3(_initialPreset.rightIkRotationDeg),
  // 0 = keep animated wrist, >0 = hard-lock palm to grip target (no soft slerp).
  rightIkHandBlend: _initialPreset.rightIkHandBlend ?? 1,
  // Body-local elbow pole (right/down/forward). Where the right elbow points.
  rightIkElbowPole: cloneVec3(_initialPreset.rightIkElbowPole),
  // Rotate pole around shoulder→hand axis (degrees). Fast fine-tune of elbow plane.
  rightIkElbowSwingDeg: _initialPreset.rightIkElbowSwingDeg ?? 0,
  // Preferred interior elbow angle ° (0 = auto from grip distance). ~90 right angle, ~160 straight.
  rightIkElbowBendDeg: _initialPreset.rightIkElbowBendDeg ?? 0,
  // Vertical-aim response. Multipliers on camera look-pitch (per-gun when preset sets them):
  // aimPitchGun tilts the gun holder to follow the look (muzzle up/down);
  // aimPitchSpine bends the torso partway toward the aim. Negative = flip direction.
  aimPitchGun: Number.isFinite(_initialPreset.aimPitchGun) ? _initialPreset.aimPitchGun : -1,
  aimPitchSpine: Number.isFinite(_initialPreset.aimPitchSpine) ? _initialPreset.aimPitchSpine : -0.6,
  revision: 0,
};

export function bumpGunDebugSocket() {
  gunDebugSocket.revision += 1;
  return gunDebugSocket.revision;
}

/** Reset sockets to the catalog preset for the currently selected gun. */
export function resetGunDebugSocket() {
  applyGunSocketPreset(gunDebugSocket.selectedGunId, { bump: true });
}

/**
 * Zero gun-local / IK offsets so hands and presentation sit on the authored
 * Gunsmith anchors (grip_mount, left_hand_ik_target) with no fudge.
 *
 * Keeps body hold (handPosition / handRotationDeg), scale, elbow poles, and
 * aim-pitch multipliers — those are independent of anchor placement.
 * Use after fixing anchors so you can re-tune palms/elbows and Log for defaults.
 *
 * @returns {typeof gunDebugSocket}
 */
export function snapGunDebugSocketToAnchors() {
  gunDebugSocket.gunPosition = [0, 0, 0];
  gunDebugSocket.gunRotationDeg = [0, 0, 0];
  gunDebugSocket.leftIkEnabled = true;
  gunDebugSocket.leftIkPosition = [0, 0, 0];
  gunDebugSocket.leftIkRotationDeg = [0, 0, 0];
  gunDebugSocket.leftIkHandBlend = 1;
  gunDebugSocket.leftIkElbowSwingDeg = 0;
  gunDebugSocket.leftIkElbowBendDeg = 0;
  gunDebugSocket.rightIkEnabled = true;
  gunDebugSocket.rightIkPosition = [0, 0, 0];
  gunDebugSocket.rightIkRotationDeg = [0, 0, 0];
  gunDebugSocket.rightIkHandBlend = 1;
  gunDebugSocket.rightIkElbowSwingDeg = 0;
  gunDebugSocket.rightIkElbowBendDeg = 0;
  bumpGunDebugSocket();
  return gunDebugSocket;
}

export function getGunDebugHandQuaternion(out = new THREE.Quaternion()) {
  const [x, y, z] = gunDebugSocket.handRotationDeg;
  _euler.set(
    THREE.MathUtils.degToRad(x),
    THREE.MathUtils.degToRad(y),
    THREE.MathUtils.degToRad(z),
    'XYZ',
  );
  return out.setFromEuler(_euler);
}

export function getGunDebugGunQuaternion(out = new THREE.Quaternion()) {
  const [x, y, z] = gunDebugSocket.gunRotationDeg;
  _euler.set(
    THREE.MathUtils.degToRad(x),
    THREE.MathUtils.degToRad(y),
    THREE.MathUtils.degToRad(z),
    'XYZ',
  );
  return out.setFromEuler(_euler);
}

export function getGunDebugLeftIkQuaternion(out = new THREE.Quaternion()) {
  const [x, y, z] = gunDebugSocket.leftIkRotationDeg;
  _euler.set(
    THREE.MathUtils.degToRad(x),
    THREE.MathUtils.degToRad(y),
    THREE.MathUtils.degToRad(z),
    'XYZ',
  );
  return out.setFromEuler(_euler);
}

export function getGunDebugRightIkQuaternion(out = new THREE.Quaternion()) {
  const [x, y, z] = gunDebugSocket.rightIkRotationDeg;
  _euler.set(
    THREE.MathUtils.degToRad(x),
    THREE.MathUtils.degToRad(y),
    THREE.MathUtils.degToRad(z),
    'XYZ',
  );
  return out.setFromEuler(_euler);
}

export function listGunDebugOptions() {
  /** @type {Record<string, string>} */
  const options = {};
  for (const entry of GUN_CATALOG) {
    options[entry.label] = entry.id;
  }
  return options;
}

export function logGunDebugSocket() {
  const snap = {
    selectedGunId: gunDebugSocket.selectedGunId,
    handPosition: [...gunDebugSocket.handPosition],
    handRotationDeg: [...gunDebugSocket.handRotationDeg],
    gunPosition: [...gunDebugSocket.gunPosition],
    gunRotationDeg: [...gunDebugSocket.gunRotationDeg],
    gunScale: gunDebugSocket.gunScale,
    leftIkEnabled: gunDebugSocket.leftIkEnabled,
    leftIkPosition: [...gunDebugSocket.leftIkPosition],
    leftIkRotationDeg: [...gunDebugSocket.leftIkRotationDeg],
    leftIkHandBlend: gunDebugSocket.leftIkHandBlend,
    leftIkElbowPole: [...gunDebugSocket.leftIkElbowPole],
    leftIkElbowSwingDeg: gunDebugSocket.leftIkElbowSwingDeg,
    leftIkElbowBendDeg: gunDebugSocket.leftIkElbowBendDeg,
    rightIkEnabled: gunDebugSocket.rightIkEnabled,
    rightIkPosition: [...gunDebugSocket.rightIkPosition],
    rightIkRotationDeg: [...gunDebugSocket.rightIkRotationDeg],
    rightIkHandBlend: gunDebugSocket.rightIkHandBlend,
    rightIkElbowPole: [...gunDebugSocket.rightIkElbowPole],
    rightIkElbowSwingDeg: gunDebugSocket.rightIkElbowSwingDeg,
    rightIkElbowBendDeg: gunDebugSocket.rightIkElbowBendDeg,
    aimPitchGun: gunDebugSocket.aimPitchGun,
    aimPitchSpine: gunDebugSocket.aimPitchSpine,
  };
  console.info('[gun-debug] socket', snap);
  return snap;
}
