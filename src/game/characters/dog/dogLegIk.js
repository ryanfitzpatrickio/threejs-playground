/**
 * Analytic two-bone (law-of-cosines) leg IK for the procedural dog rig,
 * adapted from MaraAnimationController's world-space two-bone solver
 * (solveTwoBoneArmIk/rotateBoneToward/applyWorldRotationDelta/limitRotation).
 *
 * Dog legs are a single hinge each — local-X rotation only, see
 * dogSkeleton.js ("chains are authored with only X rest bends so local Rx ≈
 * world pitch"). No external pole vector is supplied: the current upper→lower
 * direction already lies in the hinge's bend plane, so using it as the pole
 * both picks the correct bend side for free and keeps the solve continuous
 * with whatever FK swing pose ran earlier this tick (no knee/hock flip).
 *
 * Lengths are measured from live bone world positions (not bind pose) each
 * call — rotating a bone never moves its own world position or its
 * rigid-child segment length, so this is exact regardless of the breed-scale
 * wrapper around `rig.root` or any pose already applied this frame.
 */

import * as THREE from 'three';

const _upperPos = new THREE.Vector3();
const _lowerPos = new THREE.Vector3();
const _effectorPos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _targetOffset = new THREE.Vector3();
const _reachDir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _poleProjected = new THREE.Vector3();
const _elbowTarget = new THREE.Vector3();
const _currentDir = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _deltaRotation = new THREE.Quaternion();
const _limitedRotation = new THREE.Quaternion();
const _parentWorldRotation = new THREE.Quaternion();
const _parentWorldRotationInverse = new THREE.Quaternion();
const _localDelta = new THREE.Quaternion();
const _identity = new THREE.Quaternion();

function limitRotation(rotation, maxAngle, out) {
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(rotation.w, -1, 1));
  if (!Number.isFinite(angle) || angle <= maxAngle) {
    out.copy(rotation);
    return out;
  }
  out.copy(_identity).slerp(rotation, maxAngle / angle);
  return out;
}

function applyWorldRotationDelta(bone, worldDelta) {
  bone.parent.getWorldQuaternion(_parentWorldRotation);
  _parentWorldRotationInverse.copy(_parentWorldRotation).invert();
  _localDelta
    .copy(_parentWorldRotationInverse)
    .multiply(worldDelta)
    .multiply(_parentWorldRotation);
  bone.quaternion.premultiply(_localDelta).normalize();
}

function rotateBoneToward(root, bone, fromWorld, toWorld, originWorld, maxAngle) {
  _currentDir.copy(fromWorld).sub(originWorld);
  _desiredDir.copy(toWorld).sub(originWorld);
  if (_currentDir.lengthSq() < 1e-8 || _desiredDir.lengthSq() < 1e-8) return;
  _currentDir.normalize();
  _desiredDir.normalize();
  _deltaRotation.setFromUnitVectors(_currentDir, _desiredDir);
  limitRotation(_deltaRotation, maxAngle, _limitedRotation);
  applyWorldRotationDelta(bone, _limitedRotation);
  root.updateMatrixWorld(true);
}

/**
 * Solve one dog leg chain onto a world-space paw target.
 * @param {{ root: THREE.Object3D, bonesByName: Map<string, THREE.Bone> }} rig
 * @param {{ upper: string, lower: string, paw: string }} chain a DOG_LEG_CHAINS entry
 * @param {{ x: number, y: number, z: number }} targetWorld
 * @param {number} [maxAnglePerBone] radians, per-bone rotation clamp this call
 *   (converges over a few ticks instead of snapping on a sudden target jump)
 */
export function solveDogLegIk(rig, chain, targetWorld, maxAnglePerBone = 0.5) {
  const bones = rig.bonesByName;
  const upper = bones.get(chain.upper);
  const lower = bones.get(chain.lower);
  const paw = bones.get(chain.paw);
  if (!upper || !lower || !paw) return;

  const root = rig.root;
  root.updateMatrixWorld(true);
  upper.getWorldPosition(_upperPos);
  lower.getWorldPosition(_lowerPos);
  paw.getWorldPosition(_effectorPos);

  const upperLength = _upperPos.distanceTo(_lowerPos);
  const lowerLength = _lowerPos.distanceTo(_effectorPos);
  if (upperLength <= 1e-4 || lowerLength <= 1e-4) return;

  _target.set(targetWorld.x, targetWorld.y, targetWorld.z);
  _targetOffset.copy(_target).sub(_upperPos);
  const targetDistanceRaw = _targetOffset.length();
  if (targetDistanceRaw <= 1e-6) return;

  const margin = Math.min(0.006, (upperLength + lowerLength) * 0.02);
  const maxReach = Math.max(1e-4, upperLength + lowerLength - margin);
  const minReach = Math.max(1e-4, Math.abs(upperLength - lowerLength) + margin);
  const targetDistance = THREE.MathUtils.clamp(targetDistanceRaw, minReach, maxReach);

  _reachDir.copy(_targetOffset).normalize();

  // Pole = current upper->lower direction, projected off the reach axis —
  // keeps whichever side the FK swing already bent the joint toward.
  _pole.copy(_lowerPos).sub(_upperPos);
  _poleProjected.copy(_pole).addScaledVector(_reachDir, -_pole.dot(_reachDir));
  if (_poleProjected.lengthSq() < 1e-8) {
    _poleProjected.set(0, 1, 0).addScaledVector(_reachDir, -_reachDir.y);
  }
  if (_poleProjected.lengthSq() < 1e-8) return;
  _poleProjected.normalize();

  const elbowAlong = THREE.MathUtils.clamp(
    (upperLength * upperLength + targetDistance * targetDistance - lowerLength * lowerLength)
      / (2 * targetDistance),
    -upperLength,
    upperLength,
  );
  const elbowSide = Math.sqrt(Math.max(0, upperLength * upperLength - elbowAlong * elbowAlong));
  _elbowTarget
    .copy(_upperPos)
    .addScaledVector(_reachDir, elbowAlong)
    .addScaledVector(_poleProjected, elbowSide);

  rotateBoneToward(root, upper, _lowerPos, _elbowTarget, _upperPos, maxAnglePerBone);

  root.updateMatrixWorld(true);
  lower.getWorldPosition(_lowerPos);
  paw.getWorldPosition(_effectorPos);
  rotateBoneToward(root, lower, _effectorPos, _target, _lowerPos, maxAnglePerBone);

  root.updateMatrixWorld(true);
}
