/**
 * Live arm-space: open the upper arms sideways after animation.
 *
 * Only DEF-upper_arm is touched (no clavicle shrug).
 *
 * Method: take the arm's current aim direction (from the idle/walk clip),
 * add a pure character-lateral (+/−X) component, and re-aim the humerus.
 * Forward/back (Z) from the clip is preserved so we never pitch the arms
 * into a cave-man reach — that was the bug with world-axis rotation.
 */

import * as THREE from 'three';
import { aimBoneWorldDirection, findBone } from './outfitImportPose.js';

/** Positive = arms out; negative = arms in. */
export const ARM_SPACE_MIN = -1;
export const ARM_SPACE_MAX = 1.5;
export const DEFAULT_ARM_SPACE = 0;

/**
 * How hard +1 pulls the aim toward pure lateral.
 * 1.0 ≈ equal down + out; higher = more A-pose.
 */
const LATERAL_PULL = 1.15;

const _rootQ = new THREE.Quaternion();
const _invRootQ = new THREE.Quaternion();
const _armPos = new THREE.Vector3();
const _childPos = new THREE.Vector3();
const _armDir = new THREE.Vector3();
const _localDir = new THREE.Vector3();
const _target = new THREE.Vector3();

export function sanitizeArmSpace(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_ARM_SPACE;
  return Math.min(ARM_SPACE_MAX, Math.max(ARM_SPACE_MIN, num));
}

/**
 * @param {{ bones?: Record<string, THREE.Bone>, object?: THREE.Object3D, group?: THREE.Object3D, skinnedMeshes?: THREE.SkinnedMesh[] }} model
 * @param {number} armSpace
 */
export function applyArmRaisePose(model, armSpace) {
  const amount = sanitizeArmSpace(armSpace);
  if (!model?.bones || Math.abs(amount) < 1e-4) return false;

  const root = model.group ?? model.object;
  if (!root) return false;

  root.getWorldQuaternion(_rootQ);
  _invRootQ.copy(_rootQ).invert();

  // Full re-aim at |amount|≥1; partial blend keeps some of the clip pose.
  const blend = Math.min(1, Math.abs(amount) * 0.92);
  let applied = 0;
  if (openUpperArm(model.bones, 'L', amount, blend)) applied += 1;
  if (openUpperArm(model.bones, 'R', amount, blend)) applied += 1;
  if (applied === 0) return false;

  if (model.skinnedMeshes?.length) {
    for (const mesh of model.skinnedMeshes) mesh.skeleton?.update?.();
  } else {
    model.object?.updateMatrixWorld?.(true);
  }
  return true;
}

/**
 * @param {Record<string, THREE.Bone>} bones
 * @param {'L'|'R'} side
 * @param {number} amount signed armSpace
 * @param {number} blend 0..1 aim strength
 */
function openUpperArm(bones, side, amount, blend) {
  const arm = findBone(bones, `DEF-upper_arm.${side}`);
  if (!arm) return false;
  const child = findBone(bones, `DEF-forearm.${side}.001`)
    || findBone(bones, `DEF-forearm.${side}`)
    || findBone(bones, `DEF-hand.${side}`);

  arm.updateWorldMatrix(true, false);
  child?.updateWorldMatrix?.(true, false);

  // Live humerus direction from the clip (shoulder → elbow).
  if (child) {
    _armPos.setFromMatrixPosition(arm.matrixWorld);
    _childPos.setFromMatrixPosition(child.matrixWorld);
    _armDir.subVectors(_childPos, _armPos);
  } else {
    _armDir.set(0, 1, 0).transformDirection(arm.matrixWorld);
  }
  if (_armDir.lengthSq() < 1e-10) return false;
  _armDir.normalize();

  // Character-local: X right, Y up, Z forward.
  _localDir.copy(_armDir).applyQuaternion(_invRootQ);

  // glTF/UBC: +X = character right. Open left toward −X, right toward +X.
  // Positive amount adds outward; negative tucks in (subtracts outward).
  const outward = side === 'L' ? -1 : 1;
  _localDir.x += outward * amount * LATERAL_PULL;

  // Keep forward/back from the clip — only lateral changes. Zeroing Z would
  // flatten a natural idle reach; growing |Z| was the cave-man look.
  // After adding X, re-normalize so we don't lengthen into a new pitch.
  if (_localDir.lengthSq() < 1e-10) return false;
  _localDir.normalize();

  _target.copy(_localDir).applyQuaternion(_rootQ).normalize();
  return aimBoneWorldDirection(arm, child, _target, blend);
}
