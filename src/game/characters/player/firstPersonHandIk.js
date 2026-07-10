/**
 * First-person weapon hold (M4).
 *
 * Right hand: gun parented to mixamorigRightHand (great-sword pattern).
 * Left hand: optional two-bone IK onto left_hand_ik_target + debug rotation offsets.
 * Live offsets from gunDebugSocket (debug pane).
 */

import * as THREE from 'three';
import { findNamedBone } from './firstPersonRig.js';
import {
  getGunDebugGunQuaternion,
  getGunDebugHandQuaternion,
  getGunDebugLeftIkQuaternion,
  gunDebugSocket,
} from '../../weapons/gunDebugSocket.js';

const RIGHT_HAND_NAMES = ['mixamorigRightHand', 'mixamorig6RightHand', 'RightHand'];
const LEFT_HAND_NAMES = ['mixamorigLeftHand', 'mixamorig6LeftHand', 'LeftHand'];
const LEFT_ARM_NAMES = ['mixamorigLeftArm', 'mixamorig6LeftArm', 'LeftArm'];
const LEFT_FORE_NAMES = ['mixamorigLeftForeArm', 'mixamorig6LeftForeArm', 'LeftForeArm'];

// Strong solve: walk-cycle animation yanks the left arm every frame; we must
// fully re-reach the support each tick or the palm drifts off the handguard.
// 6 iters is enough for hand-parented guns; 14 was a noticeable FP frame cost.
const MAX_BONE_STEP = Math.PI;
const IK_ITERATIONS = 6;

const _handQuat = new THREE.Quaternion();
const _gunQuat = new THREE.Quaternion();
const _leftIkQuat = new THREE.Quaternion();
const _handWorld = new THREE.Vector3();
const _gripWorld = new THREE.Vector3();
const _supportWorld = new THREE.Vector3();
const _invHand = new THREE.Matrix4();
const _gripLocal = new THREE.Vector3();
const _parentWorldQuat = new THREE.Quaternion();
const _correctedLocalQuat = new THREE.Quaternion();
const _targetWorldQuat = new THREE.Quaternion();
const _offsetWorldQuat = new THREE.Quaternion();
const _bodyWorldQuat = new THREE.Quaternion();
const _poleHint = new THREE.Vector3();

// Two-bone IK scratch
const _upperPos = new THREE.Vector3();
const _lowerPos = new THREE.Vector3();
const _effPos = new THREE.Vector3();
const _targetOff = new THREE.Vector3();
const _reachDir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _fromDir = new THREE.Vector3();
const _toDir = new THREE.Vector3();
const _deltaQ = new THREE.Quaternion();
const _limitedQ = new THREE.Quaternion();
const _parentWQ = new THREE.Quaternion();
const _parentWI = new THREE.Quaternion();
const _localDelta = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/**
 * @param {THREE.Object3D} modelRoot
 * @param {THREE.Object3D} [bodyRoot]
 */
export function createFirstPersonHandIk(modelRoot, bodyRoot = modelRoot) {
  if (!modelRoot) return null;

  const rightHandBone = findNamedBone(modelRoot, RIGHT_HAND_NAMES, /right.*hand/i);
  if (!rightHandBone) {
    console.warn('[firstPersonHandIk] missing right hand bone');
    return null;
  }

  const leftArmBone = findNamedBone(modelRoot, LEFT_ARM_NAMES, /left.*arm$/i);
  const leftForeArmBone = findNamedBone(modelRoot, LEFT_FORE_NAMES, /left.*fore.*arm/i);
  const leftHandBone = findNamedBone(modelRoot, LEFT_HAND_NAMES, /left.*hand/i);
  const leftReady = Boolean(leftArmBone && leftForeArmBone && leftHandBone);

  const weaponAnchor = new THREE.Group();
  weaponAnchor.name = 'RuntimeWeaponHandAnchor';
  rightHandBone.add(weaponAnchor);

  // Debug helper target (child of gun, offset from left_hand_ik_target).
  const leftIkTarget = new THREE.Object3D();
  leftIkTarget.name = 'runtime_left_ik_target';

  /** @type {THREE.Object3D|null} */
  let gunRoot = null;
  /** @type {THREE.Object3D|null} */
  let gripMount = null;
  /** @type {THREE.Object3D|null} */
  let leftSupport = null;
  let lastLayoutRevision = -1;

  function inheritedHandScale() {
    rightHandBone.updateWorldMatrix(true, false);
    const e = rightHandBone.matrixWorld.elements;
    const s = Math.hypot(e[0], e[1], e[2]);
    return Number.isFinite(s) && s > 1e-6 ? s : 1;
  }

  function layoutGunInHand({ force = false } = {}) {
    if (!gunRoot) return;
    const kickZ = Number(gunRoot.userData.weaponKickZ) || 0;
    const kickPitch = Number(gunRoot.userData.weaponKickPitch) || 0;
    const inspect = THREE.MathUtils.clamp(Number(gunRoot.userData.inspectBlend) || 0, 0, 1);
    const presentationActive = Math.abs(kickZ) > 1e-6
      || Math.abs(kickPitch) > 1e-6
      || inspect > 1e-4;

    if (!force && !presentationActive && lastLayoutRevision === gunDebugSocket.revision) {
      const inv = 1 / inheritedHandScale();
      const want = inv * (Number(gunDebugSocket.gunScale) || 1);
      if (Math.abs(gunRoot.scale.x - want) <= 1e-3) return;
    }

    const inv = 1 / inheritedHandScale();
    const userScale = Number(gunDebugSocket.gunScale);
    const scaleMul = Number.isFinite(userScale) && userScale > 1e-4 ? userScale : 1;

    gunRoot.scale.setScalar(inv);

    const [px, py, pz] = gunDebugSocket.handPosition;
    gunRoot.position.set(px * inv, py * inv, pz * inv);
    gunRoot.quaternion.copy(getGunDebugHandQuaternion(_handQuat));
    gunRoot.updateMatrixWorld(true);

    if (gripMount) {
      rightHandBone.getWorldPosition(_handWorld);
      gripMount.getWorldPosition(_gripWorld);
      _invHand.copy(rightHandBone.matrixWorld).invert();
      _gripLocal.copy(_gripWorld).applyMatrix4(_invHand);
      gunRoot.position.sub(_gripLocal);
    }

    const [ox, oy, oz] = gunDebugSocket.gunPosition;
    gunRoot.translateX(ox * inv);
    gunRoot.translateY(oy * inv);
    gunRoot.translateZ(oz * inv);
    gunRoot.quaternion.multiply(getGunDebugGunQuaternion(_gunQuat));
    gunRoot.scale.multiplyScalar(scaleMul);

    // M5/M7: apply kick/inspect once on top of the rest pose (never stack).
    if (presentationActive) {
      if (kickZ !== 0) gunRoot.translateZ(kickZ);
      if (kickPitch !== 0 || inspect > 1e-4) {
        gunRoot.rotateX(kickPitch + inspect * 0.55);
        gunRoot.rotateY(inspect * -0.85);
        gunRoot.rotateZ(inspect * 0.35);
      }
    }

    gunRoot.updateMatrixWorld(true);

    syncLeftIkTarget();
    lastLayoutRevision = gunDebugSocket.revision;
  }

  /** Place the left IK helper on the support anchor + debug position offset. */
  function syncLeftIkTarget() {
    if (!leftSupport || !gunRoot) {
      if (leftIkTarget.parent) leftIkTarget.parent.remove(leftIkTarget);
      return;
    }
    if (leftIkTarget.parent !== gunRoot) {
      gunRoot.add(leftIkTarget);
    }
    // Start from support anchor local pose, then add gun-local meter offset.
    leftSupport.updateWorldMatrix(true, false);
    gunRoot.updateWorldMatrix(true, false);
    // Support is already a child of gunRoot (anchor marker).
    leftIkTarget.position.copy(leftSupport.position);
    leftIkTarget.quaternion.copy(leftSupport.quaternion);
    const [lx, ly, lz] = gunDebugSocket.leftIkPosition;
    leftIkTarget.position.x += lx;
    leftIkTarget.position.y += ly;
    leftIkTarget.position.z += lz;
    // Apply debug hand rotation offset on top of support orientation.
    leftIkTarget.quaternion.multiply(getGunDebugLeftIkQuaternion(_leftIkQuat));
    leftIkTarget.updateMatrixWorld(true);
  }

  function setWeapon(nextGunRoot, anchors = {}) {
    if (gunRoot?.parent === weaponAnchor) {
      weaponAnchor.remove(gunRoot);
    }
    gunRoot = nextGunRoot || null;
    gripMount = anchors.grip_mount
      || gunRoot?.getObjectByName?.('gun_anchor_grip_mount')
      || null;
    leftSupport = anchors.left_hand_ik_target
      || gunRoot?.getObjectByName?.('gun_anchor_left_hand_ik_target')
      || null;

    if (gunRoot) {
      gunRoot.position.set(0, 0, 0);
      gunRoot.quaternion.identity();
      gunRoot.scale.set(1, 1, 1);
      weaponAnchor.add(gunRoot);
      layoutGunInHand({ force: true });
      gunRoot.visible = true;
    } else if (leftIkTarget.parent) {
      leftIkTarget.parent.remove(leftIkTarget);
    }
  }

  function updateWeaponFromRightHand() {
    if (!gunRoot) return;
    layoutGunInHand({ force: false });
  }

  /**
   * Pull left arm onto support target. Call after gun layout so the target is current.
   * Re-solves fully every frame so locomotion upper-body motion cannot leave the
   * palm behind / twisted off the handguard.
   */
  function updateLeftHandIk() {
    if (!gunDebugSocket.leftIkEnabled) return;
    if (!leftReady || !modelRoot || !leftHandBone || !gunRoot) return;

    // Always re-layout so the support target tracks the animated right-hand gun.
    layoutGunInHand({ force: true });
    modelRoot.updateMatrixWorld(true);
    gunRoot.updateMatrixWorld(true);
    syncLeftIkTarget();
    leftIkTarget.getWorldPosition(_supportWorld);

    // Elbow pole from debug (body-local) + optional swing around shoulder→hand.
    bodyRoot.getWorldQuaternion(_bodyWorldQuat);
    const pole = gunDebugSocket.leftIkElbowPole;
    const px = Number(pole?.[0]);
    const py = Number(pole?.[1]);
    const pz = Number(pole?.[2]);
    _poleHint
      .set(
        Number.isFinite(px) ? px : -1,
        Number.isFinite(py) ? py : -0.55,
        Number.isFinite(pz) ? pz : 0.35,
      )
      .applyQuaternion(_bodyWorldQuat);
    if (_poleHint.lengthSq() < 1e-8) {
      _poleHint.set(-1, -0.55, 0.35).applyQuaternion(_bodyWorldQuat);
    }

    const swingDeg = Number(gunDebugSocket.leftIkElbowSwingDeg) || 0;
    if (Math.abs(swingDeg) > 1e-4) {
      leftArmBone.getWorldPosition(_upperPos);
      _reachDir.copy(_supportWorld).sub(_upperPos);
      if (_reachDir.lengthSq() > 1e-8) {
        _reachDir.normalize();
        _deltaQ.setFromAxisAngle(_reachDir, THREE.MathUtils.degToRad(swingDeg));
        _poleHint.applyQuaternion(_deltaQ);
      }
    }
    _poleHint.normalize();

    const bendDeg = Number(gunDebugSocket.leftIkElbowBendDeg) || 0;

    for (let i = 0; i < IK_ITERATIONS; i += 1) {
      solveTwoBoneArm({
        root: modelRoot,
        upper: leftArmBone,
        lower: leftForeArmBone,
        effector: leftHandBone,
        target: _supportWorld,
        poleDirection: _poleHint,
        preferredElbowBendDeg: bendDeg,
      });
    }

    // Palm lock: target orientation already includes leftIkRotationDeg.
    // Always hard-copy when enabled — partial slerp against locomotion clips
    // leaves a permanent residual twist that reads as the hand "rotating away"
    // from the calibrated hold while walking. leftIkHandBlend is an on/off gate
    // (0 = keep animated wrist, >0 = fully lock to support target).
    lockLeftPalm();
  }

  function lockLeftPalm() {
    const blend = THREE.MathUtils.clamp(Number(gunDebugSocket.leftIkHandBlend) || 0, 0, 1);
    if (!(blend > 1e-4) || !leftHandBone?.parent) return;
    modelRoot.updateMatrixWorld(true);
    leftIkTarget.getWorldQuaternion(_targetWorldQuat);
    leftHandBone.parent.getWorldQuaternion(_parentWorldQuat).invert();
    _correctedLocalQuat.multiplyQuaternions(_parentWorldQuat, _targetWorldQuat);
    leftHandBone.quaternion.copy(_correctedLocalQuat).normalize();
    modelRoot.updateMatrixWorld(true);
  }

  function updateWeaponAimPose() { updateWeaponFromRightHand(); }
  function updateWeaponAnchorFromRightHand() { updateWeaponFromRightHand(); }
  function updateRightHandIk() {}

  function measure() {
    let rightHandToGripCm = null;
    let leftHandToSupportCm = null;
    if (rightHandBone && gripMount?.parent) {
      rightHandBone.getWorldPosition(_handWorld);
      gripMount.getWorldPosition(_gripWorld);
      rightHandToGripCm = _handWorld.distanceTo(_gripWorld) * 100;
    }
    if (leftHandBone && leftIkTarget.parent) {
      leftHandBone.getWorldPosition(_handWorld);
      leftIkTarget.getWorldPosition(_supportWorld);
      leftHandToSupportCm = _handWorld.distanceTo(_supportWorld) * 100;
    }
    return {
      ready: true,
      rightHandToGripCm,
      leftHandToSupportCm,
      hasGun: Boolean(gunRoot),
      hasLeftIk: leftReady && gunDebugSocket.leftIkEnabled,
      solver: 'handParented+leftIk',
      debugRevision: gunDebugSocket.revision,
    };
  }

  function dispose() {
    setWeapon(null);
    if (leftIkTarget.parent) leftIkTarget.parent.remove(leftIkTarget);
    if (weaponAnchor.parent) weaponAnchor.parent.remove(weaponAnchor);
  }

  return {
    weaponAnchor,
    modelRoot,
    bodyRoot,
    ready: true,
    rightHandBone,
    leftHandBone,
    setWeapon,
    layoutGunInHand,
    updateWeaponAimPose,
    updateWeaponFromRightHand,
    updateWeaponAnchorFromRightHand,
    updateRightHandIk,
    updateLeftHandIk,
    measure,
    dispose,
  };
}

function solveTwoBoneArm({
  root,
  upper,
  lower,
  effector,
  target,
  poleDirection,
  preferredElbowBendDeg = 0,
}) {
  root.updateMatrixWorld(true);
  upper.getWorldPosition(_upperPos);
  lower.getWorldPosition(_lowerPos);
  effector.getWorldPosition(_effPos);

  const upperLength = _upperPos.distanceTo(_lowerPos);
  const lowerLength = _lowerPos.distanceTo(_effPos);
  if (upperLength <= 1e-4 || lowerLength <= 1e-4) return;

  _targetOff.copy(target).sub(_upperPos);
  const maxReach = Math.max(1e-4, upperLength + lowerLength - 0.008);
  const minReach = Math.max(1e-4, Math.abs(upperLength - lowerLength) + 0.008);
  let targetDistance = THREE.MathUtils.clamp(_targetOff.length(), minReach, maxReach);
  if (_targetOff.lengthSq() <= 1e-8) return;

  // Optional preferred interior elbow angle (degrees between upper & lower bones).
  // 180 ≈ straight, 90 ≈ right angle. Only pulls the solve closer when reachable so
  // the hand still aims at the support target direction.
  if (preferredElbowBendDeg > 1e-3 && preferredElbowBendDeg < 179.5) {
    const alpha = THREE.MathUtils.degToRad(preferredElbowBendDeg);
    const cosA = Math.cos(alpha);
    const dPrefSq = upperLength * upperLength + lowerLength * lowerLength
      - 2 * upperLength * lowerLength * cosA;
    if (dPrefSq > 0) {
      const dPref = Math.sqrt(dPrefSq);
      // More bend ⇒ shorter shoulder→hand distance. Only enforce when it bends more
      // than the geometric grip distance (never stretch past the support).
      targetDistance = THREE.MathUtils.clamp(
        Math.min(targetDistance, dPref),
        minReach,
        maxReach,
      );
    }
  }

  _reachDir.copy(_targetOff).normalize();
  _pole.copy(poleDirection).addScaledVector(_reachDir, -poleDirection.dot(_reachDir));
  if (_pole.lengthSq() <= 1e-8) {
    _pole.set(0, 1, 0).addScaledVector(_reachDir, -_reachDir.y);
  }
  if (_pole.lengthSq() <= 1e-8) return;
  _pole.normalize();

  const elbowAlong = THREE.MathUtils.clamp(
    (upperLength * upperLength + targetDistance * targetDistance - lowerLength * lowerLength)
      / (2 * targetDistance),
    -upperLength,
    upperLength,
  );
  const elbowSide = Math.sqrt(Math.max(0, upperLength * upperLength - elbowAlong * elbowAlong));
  _elbow
    .copy(_upperPos)
    .addScaledVector(_reachDir, elbowAlong)
    .addScaledVector(_pole, elbowSide);

  rotateBoneToward({
    bone: upper,
    fromWorld: _lowerPos,
    toWorld: _elbow,
    originWorld: _upperPos,
    maxAngle: MAX_BONE_STEP,
  });

  root.updateMatrixWorld(true);
  lower.getWorldPosition(_lowerPos);
  effector.getWorldPosition(_effPos);

  // When bend is forced short of the support, still point forearm at the real grip.
  rotateBoneToward({
    bone: lower,
    fromWorld: _effPos,
    toWorld: target,
    originWorld: _lowerPos,
    maxAngle: MAX_BONE_STEP,
  });

  root.updateMatrixWorld(true);
}

function rotateBoneToward({ bone, fromWorld, toWorld, originWorld, maxAngle }) {
  _fromDir.copy(fromWorld).sub(originWorld);
  _toDir.copy(toWorld).sub(originWorld);
  if (_fromDir.lengthSq() <= 1e-8 || _toDir.lengthSq() <= 1e-8) return;
  _fromDir.normalize();
  _toDir.normalize();
  const dot = THREE.MathUtils.clamp(_fromDir.dot(_toDir), -1, 1);
  if (dot > 0.99999) return;
  _deltaQ.setFromUnitVectors(_fromDir, _toDir);
  limitRotation(_deltaQ, maxAngle, _limitedQ);
  applyWorldRotationDelta(bone, _limitedQ);
}

function limitRotation(rotation, maxAngle, out) {
  if (!(maxAngle > 0)) {
    out.copy(rotation);
    return out;
  }
  const w = THREE.MathUtils.clamp(rotation.w, -1, 1);
  const signed = 2 * Math.acos(w);
  const a = Number.isFinite(signed) ? Math.abs(signed) : 0;
  if (!Number.isFinite(a) || a <= maxAngle) {
    out.copy(rotation);
    return out;
  }
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-6) {
    out.identity();
    return out;
  }
  _axis.set(rotation.x / s, rotation.y / s, rotation.z / s);
  out.setFromAxisAngle(_axis, (signed < 0 ? -1 : 1) * maxAngle);
  return out;
}

function applyWorldRotationDelta(bone, worldDelta) {
  if (!bone.parent) return;
  bone.parent.getWorldQuaternion(_parentWQ);
  _parentWI.copy(_parentWQ).invert();
  _localDelta.copy(_parentWI).multiply(worldDelta).multiply(_parentWQ);
  bone.quaternion.premultiply(_localDelta).normalize();
}

export function findRightHandBone(root) {
  return findNamedBone(root, RIGHT_HAND_NAMES, /right.*hand/i);
}
