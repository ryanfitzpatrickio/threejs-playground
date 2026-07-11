/**
 * First-person weapon hold (M4).
 *
 * The gun is anchored in BODY space (chest holder under bodyRoot), not parented to
 * a hand — so it can be moved freely in the debug pane and BOTH hands follow it:
 *   Right hand: two-bone IK onto grip_mount (dominant grip).
 *   Left hand:  two-bone IK onto left_hand_ik_target (support).
 * Each hand also palm-locks to its target orientation. Live offsets come from
 * gunDebugSocket (debug pane).
 */

import * as THREE from 'three';
import { findNamedBone } from './firstPersonRig.js';
import {
  getGunDebugGunQuaternion,
  getGunDebugHandQuaternion,
  getGunDebugLeftIkQuaternion,
  getGunDebugRightIkQuaternion,
  gunDebugSocket,
} from '../../weapons/gunDebugSocket.js';

const RIGHT_HAND_NAMES = ['mixamorigRightHand', 'mixamorig6RightHand', 'RightHand'];
const RIGHT_ARM_NAMES = ['mixamorigRightArm', 'mixamorig6RightArm', 'RightArm'];
const RIGHT_FORE_NAMES = ['mixamorigRightForeArm', 'mixamorig6RightForeArm', 'RightForeArm'];
const LEFT_HAND_NAMES = ['mixamorigLeftHand', 'mixamorig6LeftHand', 'LeftHand'];
const LEFT_ARM_NAMES = ['mixamorigLeftArm', 'mixamorig6LeftArm', 'LeftArm'];
const LEFT_FORE_NAMES = ['mixamorigLeftForeArm', 'mixamorig6LeftForeArm', 'LeftForeArm'];
// Chest holder: gun is parented to bodyRoot but positioned at this bone so the
// hold tracks torso height/bob while keeping intuitive body-aligned axes.
const CHEST_NAMES = [
  'mixamorigSpine2', 'mixamorig6Spine2', 'Spine2',
  'mixamorigSpine1', 'mixamorig6Spine1', 'Spine1',
  'mixamorigSpine', 'mixamorig6Spine', 'Spine',
];

// Strong solve: walk-cycle animation yanks the left arm every frame; we must
// fully re-reach the support each tick or the palm drifts off the handguard.
// 6 iters is enough for hand-parented guns; 14 was a noticeable FP frame cost.
const MAX_BONE_STEP = Math.PI;
const IK_ITERATIONS = 6;

// Body-local elbow pole fallbacks (used when the debug pole vector is ~zero).
// Left points left+down+fwd; right mirrors on X.
const LEFT_DEFAULT_POLE = [-1, -0.55, 0.35];
const RIGHT_DEFAULT_POLE = [1, -0.55, 0.35];
// Safety margin (m) kept inside the right arm's full span so the reach-clamped
// grip lands a touch short of full extension (solver also shrinks by ~0.008).
const REACH_CLAMP_MARGIN = 0.02;
// Seconds to blend a hand's IK influence fully in/out (sprint entry/exit etc.).
const IK_BLEND_TIME = 0.14;
// Carry snaps in fast (gun tracks the hand from the start) but eases out.
const CARRY_ATTACK_TIME = 0.03;

/** Move `current` toward `target` at most IK_BLEND_TIME⁻¹ per second. */
function rampWeight(current, target, dt) {
  const step = (Number.isFinite(dt) && dt > 0 ? dt : 1 / 60) / IK_BLEND_TIME;
  return current + THREE.MathUtils.clamp(target - current, -step, step);
}

const _handQuat = new THREE.Quaternion();
const _gunQuat = new THREE.Quaternion();
const _leftIkQuat = new THREE.Quaternion();
const _rightIkQuat = new THREE.Quaternion();
const _handWorld = new THREE.Vector3();
const _gripWorld = new THREE.Vector3();
const _supportWorld = new THREE.Vector3();
const _holderPos = new THREE.Vector3();
const _clampPoint = new THREE.Vector3();
const _anchorLocal = new THREE.Matrix4();
const _anchorScale = new THREE.Vector3();
// Procedural left-hand override (reload director) scratch.
const _overrideWorld = new THREE.Matrix4();
const _overrideLocal = new THREE.Matrix4();
const _overrideQuat = new THREE.Quaternion();
const _parentWorldQuat = new THREE.Quaternion();
const _correctedLocalQuat = new THREE.Quaternion();
const _targetWorldQuat = new THREE.Quaternion();
const _bodyWorldQuat = new THREE.Quaternion();
const _savedArm = new THREE.Quaternion();
const _savedFore = new THREE.Quaternion();
const _savedHand = new THREE.Quaternion();
const _blendTmp = new THREE.Quaternion();
// Hand-carry scratch (gun rides the right hand during sprint).
const _bodyMat = new THREE.Matrix4();
const _socketMat = new THREE.Matrix4();
const _carryLocal = new THREE.Matrix4();
const _adsSocketLocal = new THREE.Matrix4();
const _adsDesiredWorld = new THREE.Matrix4();
const _adsDesiredLocal = new THREE.Matrix4();
const _adsEyeReliefMatrix = new THREE.Matrix4();
const _blendMat = new THREE.Matrix4();
const _localMat = new THREE.Matrix4();
const _pA = new THREE.Vector3();
const _pB = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _sA = new THREE.Vector3();
const _sB = new THREE.Vector3();
const _unitScale = new THREE.Vector3(1, 1, 1);
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

  const rightArmBone = findNamedBone(modelRoot, RIGHT_ARM_NAMES, /right.*arm$/i);
  const rightForeArmBone = findNamedBone(modelRoot, RIGHT_FORE_NAMES, /right.*fore.*arm/i);
  const rightReady = Boolean(rightArmBone && rightForeArmBone && rightHandBone);

  const leftArmBone = findNamedBone(modelRoot, LEFT_ARM_NAMES, /left.*arm$/i);
  const leftForeArmBone = findNamedBone(modelRoot, LEFT_FORE_NAMES, /left.*fore.*arm/i);
  const leftHandBone = findNamedBone(modelRoot, LEFT_HAND_NAMES, /left.*hand/i);
  const leftReady = Boolean(leftArmBone && leftForeArmBone && leftHandBone);

  const chestBone = findNamedBone(modelRoot, CHEST_NAMES, /spine/i);

  // Body-space holder: parented to bodyRoot (aligned to body yaw axes), re-based
  // on the chest bone each layout so the gun tracks torso height without being
  // yanked by the arm animation.
  const weaponAnchor = new THREE.Group();
  weaponAnchor.name = 'RuntimeWeaponHandAnchor';
  bodyRoot.add(weaponAnchor);

  // Debug helper targets (children of gun, offset from the grip / support anchors).
  const leftIkTarget = new THREE.Object3D();
  leftIkTarget.name = 'runtime_left_ik_target';
  const rightIkTarget = new THREE.Object3D();
  rightIkTarget.name = 'runtime_right_ik_target';

  /** @type {THREE.Object3D|null} */
  let gunRoot = null;
  /** @type {THREE.Object3D|null} */
  let gripMount = null;
  /** @type {THREE.Object3D|null} */
  let leftSupport = null;
  /** Authored eye/sight socket pulled onto the gameplay camera during ADS. */
  let adsCamera = null;
  let adsViewCamera = null;
  let adsOverrideAnchor = null;
  let adsEyeRelief = 0;
  let adsBlend = 0;
  let lastAppliedAdsBlend = -1;
  let lastLayoutRevision = -1;
  let holderAimPitch = 0;
  // Per-hand IK influence [0..1], ramped toward the caller's target so gated
  // states (sprint) blend the hands off/on instead of snapping.
  let leftIkWeight = 0;
  let rightIkWeight = 0;
  // Hand-carry: gun rides the right hand (frozen relative pose) during sprint.
  let carryWeight = 0;
  let carryActive = false;
  let _lastRightIkStatus = '';
  // Reload director (AR3): when set, the left IK target follows this world
  // position instead of the gun's support anchor. Orientation defaults to the
  // rest support anchor; an optional world quaternion overrides for reload
  // debug palm tweaks.
  /** @type {THREE.Vector3|null} */
  let leftProceduralTarget = null;
  /** @type {THREE.Quaternion|null} */
  let leftProceduralQuat = null;

  function inheritedHolderScale() {
    weaponAnchor.updateWorldMatrix(true, false);
    const e = weaponAnchor.matrixWorld.elements;
    const s = Math.hypot(e[0], e[1], e[2]);
    return Number.isFinite(s) && s > 1e-6 ? s : 1;
  }

  // Re-base the holder on the chest bone (position only) in bodyRoot-local space,
  // keeping identity orientation so gun offsets read as +X left / +Y up / +Z fwd.
  function syncHolder() {
    bodyRoot.updateWorldMatrix(true, false);
    if (chestBone) {
      chestBone.updateWorldMatrix(true, false);
      chestBone.getWorldPosition(_holderPos);
      bodyRoot.worldToLocal(_holderPos);
      weaponAnchor.position.copy(_holderPos);
    } else {
      weaponAnchor.position.set(0, 0, 0);
    }
    weaponAnchor.quaternion.identity();
    weaponAnchor.scale.set(1, 1, 1);
    // Vertical aim: tilt the whole hold about the body-lateral (X) axis so the
    // muzzle follows the look. Both hands IK to the tilted gun; the spine bend
    // (applied upstream) moves the shoulders toward it so reach stays sane.
    if (holderAimPitch) weaponAnchor.rotateX(holderAimPitch);
    weaponAnchor.updateMatrixWorld(true);
  }

  /** Set the gun-holder aim tilt (rad, already signed/scaled by caller). */
  function setAimPitch(pitch) {
    holderAimPitch = Number.isFinite(pitch)
      ? THREE.MathUtils.clamp(pitch, -1.4, 1.4)
      : 0;
  }

  function layoutGunInHand({ force = false } = {}) {
    if (!gunRoot) return;
    const kickZ = Number(gunRoot.userData.weaponKickZ) || 0;
    const kickPitch = Number(gunRoot.userData.weaponKickPitch) || 0;
    const kickYaw = Number(gunRoot.userData.weaponKickYaw) || 0;
    const kickRoll = Number(gunRoot.userData.weaponKickRoll) || 0;
    const inspect = THREE.MathUtils.clamp(Number(gunRoot.userData.inspectBlend) || 0, 0, 1);
    const adsPoseAnchor = adsOverrideAnchor || adsCamera;
    const adsActive = Boolean(adsPoseAnchor && adsViewCamera && adsBlend > 1e-4);
    const adsChanged = Math.abs(adsBlend - lastAppliedAdsBlend) > 1e-5;
    const presentationActive = Math.abs(kickZ) > 1e-6
      || Math.abs(kickPitch) > 1e-6
      || Math.abs(kickYaw) > 1e-6
      || Math.abs(kickRoll) > 1e-6
      || inspect > 1e-4
      || adsActive
      || adsChanged;

    // Always track the chest so the hold follows torso bob even on early-out.
    syncHolder();

    if (!force && !presentationActive && lastLayoutRevision === gunDebugSocket.revision) {
      const inv = 1 / inheritedHolderScale();
      const want = inv * (Number(gunDebugSocket.gunScale) || 1);
      if (Math.abs(gunRoot.scale.x - want) <= 1e-3) return;
    }

    const inv = 1 / inheritedHolderScale();
    const userScale = Number(gunDebugSocket.gunScale);
    const scaleMul = Number.isFinite(userScale) && userScale > 1e-4 ? userScale : 1;

    gunRoot.scale.setScalar(inv);

    // Base gun pose in body(chest) space, then extra gun-local offset/rotation.
    const [px, py, pz] = gunDebugSocket.handPosition;
    gunRoot.position.set(px * inv, py * inv, pz * inv);
    gunRoot.quaternion.copy(getGunDebugHandQuaternion(_handQuat));
    gunRoot.updateMatrixWorld(true);

    const [ox, oy, oz] = gunDebugSocket.gunPosition;
    gunRoot.translateX(ox * inv);
    gunRoot.translateY(oy * inv);
    gunRoot.translateZ(oz * inv);
    gunRoot.quaternion.multiply(getGunDebugGunQuaternion(_gunQuat));
    gunRoot.scale.multiplyScalar(scaleMul);

    // M5/M7: apply kick/inspect once on top of the rest pose (never stack).
    if (presentationActive) {
      if (kickZ !== 0) gunRoot.translateZ(kickZ);
      if (kickPitch !== 0 || kickYaw !== 0 || kickRoll !== 0 || inspect > 1e-4) {
        gunRoot.rotateX(kickPitch + inspect * 0.55);
        gunRoot.rotateY(kickYaw + inspect * -0.85);
        gunRoot.rotateZ(kickRoll + inspect * 0.35);
      }
    }

    // Inverse of the traditional "move camera to sight" ADS setup: keep the
    // gameplay camera untouched and solve the gun transform that places the
    // authored adsCamera socket on the camera eye and sight axis. Because the gun
    // remains under the shared body holder, both hand IK targets follow it.
    if (adsActive) {
      gunRoot.updateWorldMatrix(true, false);
      adsPoseAnchor.updateWorldMatrix(true, false);
      adsViewCamera.updateWorldMatrix(true, false);
      weaponAnchor.updateWorldMatrix(true, false);

      // desiredGunWorld = gameplayCameraWorld * inverse(adsSocketInGunSpace)
      _adsSocketLocal.copy(gunRoot.matrixWorld).invert().multiply(adsPoseAnchor.matrixWorld);
      // Authored viewport scale controls its aperture only; it must never scale
      // the entire weapon when used as the ADS presentation socket.
      _adsSocketLocal.decompose(_pA, _qA, _sA);
      _adsSocketLocal.compose(_pA, _qA, _unitScale);
      _adsDesiredWorld.copy(adsViewCamera.matrixWorld);
      if (adsEyeRelief > 0) {
        _adsEyeReliefMatrix.makeTranslation(0, 0, -adsEyeRelief);
        _adsDesiredWorld.multiply(_adsEyeReliefMatrix);
      }
      _adsDesiredWorld.multiply(_adsSocketLocal.invert());
      _adsDesiredLocal
        .copy(weaponAnchor.matrixWorld)
        .invert()
        .multiply(_adsDesiredWorld)
        .decompose(_pB, _qB, _sB);
      gunRoot.position.lerp(_pB, adsBlend);
      gunRoot.quaternion.slerp(_qB, adsBlend);
      gunRoot.scale.lerp(_sB, adsBlend);
    }

    gunRoot.updateMatrixWorld(true);

    syncLeftIkTarget();
    syncRightIkTarget();
    // The reach safety is useful for hip locomotion, but it must not pull an
    // aligned sight back off the camera centerline while ADS is active.
    if (!adsActive) applyReachClamp();
    lastAppliedAdsBlend = adsBlend;
    lastLayoutRevision = gunDebugSocket.revision;
  }

  /**
   * Set the first-person ADS presentation for the next layout.
   * `adsCamera` is authored in Gunsmith; `camera` remains the gameplay camera.
   */
  function setAdsPose(camera, blend = 0, presentationAnchor = null, eyeRelief = 0) {
    adsViewCamera = camera || null;
    adsBlend = THREE.MathUtils.clamp(Number(blend) || 0, 0, 1);
    adsOverrideAnchor = presentationAnchor || null;
    adsEyeRelief = Math.max(0, Number(eyeRelief) || 0);
  }

  // Keep the right grip within the right arm's reach: the run animation swings the
  // shoulder fore-aft past what the arm can span, so pull the WHOLE gun toward the
  // shoulder by the overshoot. The gun is the shared anchor, so the left hand
  // follows — both hands stay glued and the gun retracts slightly at run extremes
  // instead of the right hand detaching.
  function applyReachClamp() {
    if (!gunDebugSocket.rightIkEnabled || !rightReady || !gripMount || !gunRoot) return;
    // Only clamp while the right hand is actually gripping; scale by the blend
    // weight so the gun stops being pulled as the hand blends off (sprint).
    if (rightIkWeight <= 1e-3) return;
    // Rigid bone lengths (invariant under pose) → max span, minus a small margin.
    rightArmBone.getWorldPosition(_upperPos);
    rightForeArmBone.getWorldPosition(_lowerPos);
    rightHandBone.getWorldPosition(_handWorld);
    const reach = _upperPos.distanceTo(_lowerPos)
      + _lowerPos.distanceTo(_handWorld)
      - REACH_CLAMP_MARGIN;
    if (!(reach > 0)) return;
    rightIkTarget.getWorldPosition(_gripWorld);
    const dist = _upperPos.distanceTo(_gripWorld);
    if (dist <= reach) return;
    // Shift the gun world-origin toward the shoulder by the overshoot (× weight).
    _reachDir.copy(_upperPos).sub(_gripWorld);
    if (_reachDir.lengthSq() < 1e-8) return;
    _reachDir.normalize().multiplyScalar((dist - reach) * rightIkWeight);
    gunRoot.getWorldPosition(_clampPoint).add(_reachDir);
    weaponAnchor.worldToLocal(_clampPoint);
    gunRoot.position.copy(_clampPoint);
    gunRoot.updateMatrixWorld(true);
    syncLeftIkTarget();
    syncRightIkTarget();
  }

  /**
   * Place an IK helper on a gun anchor, in gun-local space, plus debug pos/rot
   * offset. Anchor pose is resolved via matrices so nested anchors work too.
   */
  function syncIkTarget(ikTarget, anchor, posOffset, rotQuat) {
    if (!anchor || !gunRoot) {
      if (ikTarget.parent) ikTarget.parent.remove(ikTarget);
      return;
    }
    if (ikTarget.parent !== gunRoot) {
      gunRoot.add(ikTarget);
    }
    anchor.updateWorldMatrix(true, false);
    gunRoot.updateWorldMatrix(true, false);
    _anchorLocal.copy(gunRoot.matrixWorld).invert().multiply(anchor.matrixWorld);
    _anchorLocal.decompose(ikTarget.position, ikTarget.quaternion, _anchorScale);
    ikTarget.position.x += Number(posOffset?.[0]) || 0;
    ikTarget.position.y += Number(posOffset?.[1]) || 0;
    ikTarget.position.z += Number(posOffset?.[2]) || 0;
    ikTarget.quaternion.multiply(rotQuat);
    ikTarget.updateMatrixWorld(true);
  }

  /** Left support helper on left_hand_ik_target + debug offset. */
  function syncLeftIkTarget() {
    // Reload override: place the target at a caller-supplied world pose.
    if (leftProceduralTarget && gunRoot) {
      if (leftIkTarget.parent !== gunRoot) gunRoot.add(leftIkTarget);
      gunRoot.updateWorldMatrix(true, false);
      if (leftProceduralQuat) {
        _overrideQuat.copy(leftProceduralQuat);
      } else if (leftSupport) {
        leftSupport.updateWorldMatrix(true, false);
        leftSupport.getWorldQuaternion(_overrideQuat);
      } else {
        _overrideQuat.identity();
      }
      _overrideWorld.compose(leftProceduralTarget, _overrideQuat, _unitScale);
      _overrideLocal.copy(gunRoot.matrixWorld).invert().multiply(_overrideWorld);
      _overrideLocal.decompose(leftIkTarget.position, leftIkTarget.quaternion, _anchorScale);
      leftIkTarget.updateMatrixWorld(true);
      return;
    }
    syncIkTarget(
      leftIkTarget,
      leftSupport,
      gunDebugSocket.leftIkPosition,
      getGunDebugLeftIkQuaternion(_leftIkQuat),
    );
  }

  /**
   * AR3 seam: steer the left IK target to a world position (reload director), or
   * pass null to return the left hand to the gun's support anchor.
   * @param {THREE.Vector3|{x:number,y:number,z:number}|null} worldPosition
   * @param {THREE.Quaternion|{x:number,y:number,z:number,w:number}|null} [worldQuaternion]
   *        Optional palm orientation. When null, uses left_hand_ik_target's world quat.
   */
  function setLeftHandProceduralTarget(worldPosition, worldQuaternion = null) {
    if (!worldPosition) {
      leftProceduralTarget = null;
      leftProceduralQuat = null;
      return;
    }
    if (!leftProceduralTarget) leftProceduralTarget = new THREE.Vector3();
    leftProceduralTarget.set(worldPosition.x, worldPosition.y, worldPosition.z);
    if (worldQuaternion && Number.isFinite(worldQuaternion.w)) {
      if (!leftProceduralQuat) leftProceduralQuat = new THREE.Quaternion();
      leftProceduralQuat.set(
        worldQuaternion.x,
        worldQuaternion.y,
        worldQuaternion.z,
        worldQuaternion.w,
      ).normalize();
    } else {
      leftProceduralQuat = null;
    }
  }

  /** Right grip helper on grip_mount + debug offset. */
  function syncRightIkTarget() {
    syncIkTarget(
      rightIkTarget,
      gripMount,
      gunDebugSocket.rightIkPosition,
      getGunDebugRightIkQuaternion(_rightIkQuat),
    );
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
    adsCamera = anchors.adsCamera
      || gunRoot?.getObjectByName?.('gun_anchor_adsCamera')
      || null;

    if (gunRoot) {
      gunRoot.position.set(0, 0, 0);
      gunRoot.quaternion.identity();
      gunRoot.scale.set(1, 1, 1);
      weaponAnchor.add(gunRoot);
      layoutGunInHand({ force: true });
      gunRoot.visible = true;
    } else {
      adsCamera = null;
      adsViewCamera = null;
      adsOverrideAnchor = null;
      adsEyeRelief = 0;
      adsBlend = 0;
      lastAppliedAdsBlend = -1;
      if (leftIkTarget.parent) leftIkTarget.parent.remove(leftIkTarget);
      if (rightIkTarget.parent) rightIkTarget.parent.remove(rightIkTarget);
    }
  }

  function updateWeaponFromRightHand() {
    if (!gunRoot) return;
    layoutGunInHand({ force: false });
  }

  /**
   * Pull one arm onto its gun anchor target. Re-solves fully every frame so
   * locomotion upper-body motion cannot leave the palm behind / twisted off the
   * anchor. Palm-locks to the target orientation when blend > 0 (hard copy —
   * a soft slerp against loco clips leaves a permanent residual twist).
   */
  function solveArmToTarget({
    armBone,
    foreArmBone,
    handBone,
    ikTarget,
    poleArr,
    defaultPole,
    swingDeg,
    bendDeg,
    blend,
    weight = 1,
  }) {
    // Remember the animated pose so a partial weight blends IK ↔ animation.
    const blendable = weight < 0.999;
    if (blendable) {
      _savedArm.copy(armBone.quaternion);
      _savedFore.copy(foreArmBone.quaternion);
      _savedHand.copy(handBone.quaternion);
    }

    ikTarget.getWorldPosition(_supportWorld);

    // Elbow pole from debug (body-local) + optional swing around shoulder→hand.
    bodyRoot.getWorldQuaternion(_bodyWorldQuat);
    const px = Number(poleArr?.[0]);
    const py = Number(poleArr?.[1]);
    const pz = Number(poleArr?.[2]);
    _poleHint
      .set(
        Number.isFinite(px) ? px : defaultPole[0],
        Number.isFinite(py) ? py : defaultPole[1],
        Number.isFinite(pz) ? pz : defaultPole[2],
      )
      .applyQuaternion(_bodyWorldQuat);
    if (_poleHint.lengthSq() < 1e-8) {
      _poleHint.fromArray(defaultPole).applyQuaternion(_bodyWorldQuat);
    }

    if (Math.abs(swingDeg) > 1e-4) {
      armBone.getWorldPosition(_upperPos);
      _reachDir.copy(_supportWorld).sub(_upperPos);
      if (_reachDir.lengthSq() > 1e-8) {
        _reachDir.normalize();
        _deltaQ.setFromAxisAngle(_reachDir, THREE.MathUtils.degToRad(swingDeg));
        _poleHint.applyQuaternion(_deltaQ);
      }
    }
    _poleHint.normalize();

    for (let i = 0; i < IK_ITERATIONS; i += 1) {
      solveTwoBoneArm({
        root: modelRoot,
        upper: armBone,
        lower: foreArmBone,
        effector: handBone,
        target: _supportWorld,
        poleDirection: _poleHint,
        preferredElbowBendDeg: bendDeg,
      });
    }

    // Palm lock: target orientation already includes the debug IK rotation.
    if (blend > 1e-4 && handBone.parent) {
      modelRoot.updateMatrixWorld(true);
      ikTarget.getWorldQuaternion(_targetWorldQuat);
      handBone.parent.getWorldQuaternion(_parentWorldQuat).invert();
      _correctedLocalQuat.multiplyQuaternions(_parentWorldQuat, _targetWorldQuat);
      handBone.quaternion.copy(_correctedLocalQuat).normalize();
      modelRoot.updateMatrixWorld(true);
    }

    // Blend the solved arm back toward the animated pose by (1 - weight).
    if (blendable) {
      _blendTmp.copy(armBone.quaternion);
      armBone.quaternion.slerpQuaternions(_savedArm, _blendTmp, weight);
      _blendTmp.copy(foreArmBone.quaternion);
      foreArmBone.quaternion.slerpQuaternions(_savedFore, _blendTmp, weight);
      _blendTmp.copy(handBone.quaternion);
      handBone.quaternion.slerpQuaternions(_savedHand, _blendTmp, weight);
      modelRoot.updateMatrixWorld(true);
    }
  }

  /**
   * Pull the right (dominant) arm onto grip_mount so the trigger hand follows the
   * gun. `target` (0/1) is the gate goal; the influence ramps toward it so a state
   * that frees the hand (sprint) blends off/on without a snap.
   */
  function updateRightHandIk({ target = 1, dt = 1 / 60 } = {}) {
    const skip = !gunDebugSocket.rightIkEnabled ? 'disabled'
      : !gunRoot ? 'no-gun'
      : !rightReady ? `no-right-arm-bones(arm=${!!rightArmBone},fore=${!!rightForeArmBone},hand=${!!rightHandBone})`
      : !gripMount ? 'no-grip_mount-anchor'
      : 'active';
    if (skip !== _lastRightIkStatus) {
      _lastRightIkStatus = skip;
      console.info('[firstPersonHandIk] right-hand IK:', skip);
    }
    const goal = skip === 'active' ? THREE.MathUtils.clamp(Number(target) || 0, 0, 1) : 0;
    rightIkWeight = rampWeight(rightIkWeight, goal, dt);
    if (skip !== 'active' || rightIkWeight <= 1e-3) return;

    // Re-layout so the grip target tracks the body-anchored gun this frame.
    layoutGunInHand({ force: true });
    modelRoot.updateMatrixWorld(true);
    gunRoot.updateMatrixWorld(true);
    syncRightIkTarget();

    solveArmToTarget({
      armBone: rightArmBone,
      foreArmBone: rightForeArmBone,
      handBone: rightHandBone,
      ikTarget: rightIkTarget,
      poleArr: gunDebugSocket.rightIkElbowPole,
      defaultPole: RIGHT_DEFAULT_POLE,
      swingDeg: Number(gunDebugSocket.rightIkElbowSwingDeg) || 0,
      bendDeg: Number(gunDebugSocket.rightIkElbowBendDeg) || 0,
      blend: THREE.MathUtils.clamp(Number(gunDebugSocket.rightIkHandBlend) || 0, 0, 1),
      weight: rightIkWeight,
    });
  }

  /** Pull the left (support) arm onto left_hand_ik_target (ramped like the right). */
  function updateLeftHandIk({ target = 1, dt = 1 / 60 } = {}) {
    const canIk = gunDebugSocket.leftIkEnabled && leftReady && modelRoot && leftHandBone && gunRoot;
    const goal = canIk ? THREE.MathUtils.clamp(Number(target) || 0, 0, 1) : 0;
    leftIkWeight = rampWeight(leftIkWeight, goal, dt);
    if (!canIk || leftIkWeight <= 1e-3) return;

    layoutGunInHand({ force: true });
    modelRoot.updateMatrixWorld(true);
    gunRoot.updateMatrixWorld(true);
    syncLeftIkTarget();

    solveArmToTarget({
      armBone: leftArmBone,
      foreArmBone: leftForeArmBone,
      handBone: leftHandBone,
      ikTarget: leftIkTarget,
      poleArr: gunDebugSocket.leftIkElbowPole,
      defaultPole: LEFT_DEFAULT_POLE,
      swingDeg: Number(gunDebugSocket.leftIkElbowSwingDeg) || 0,
      bendDeg: Number(gunDebugSocket.leftIkElbowBendDeg) || 0,
      blend: THREE.MathUtils.clamp(Number(gunDebugSocket.leftIkHandBlend) || 0, 0, 1),
      weight: leftIkWeight,
    });
  }

  /**
   * Carry the gun in the right hand instead of body-anchoring it. On the rising
   * edge (carry begins) the gun's pose RELATIVE TO the right hand is frozen while
   * it's still held, so socket == body-anchored at that instant (pop-free), then
   * the gun rides the hand as it animates. Blends body ↔ socket by carryWeight so
   * entry/exit are smooth. Call after the hand IK (which laid out the body pose).
   */
  function applyHandCarry({ target = 0, dt = 1 / 60 } = {}) {
    const canCarry = Boolean(rightReady && rightHandBone && gunRoot);
    const goal = canCarry ? THREE.MathUtils.clamp(Number(target) || 0, 0, 1) : 0;
    // Snap carry IN fast (socket == held pose at that instant, so it's already
    // pop-free) and let the gun track the real hand; blend OUT gently back to the
    // body anchor. A slow blend-in makes the gun lag the chest while the hand
    // sprints ahead.
    const blendTime = goal > carryWeight ? CARRY_ATTACK_TIME : IK_BLEND_TIME;
    const step = (Number.isFinite(dt) && dt > 0 ? dt : 1 / 60) / blendTime;
    carryWeight += THREE.MathUtils.clamp(goal - carryWeight, -step, step);
    if (carryWeight <= 1e-3) {
      carryActive = false;
      // While body-anchored and firmly gripped, keep the held gun-in-hand
      // transform fresh so carry starts from a true grip (not the arm mid-blend).
      if (canCarry && rightIkWeight > 0.9) {
        gunRoot.updateWorldMatrix(true, false);
        rightHandBone.updateWorldMatrix(true, false);
        _carryLocal.copy(rightHandBone.matrixWorld).invert().multiply(gunRoot.matrixWorld);
      }
      return;
    }

    gunRoot.updateWorldMatrix(true, false);
    rightHandBone.updateWorldMatrix(true, false);
    _bodyMat.copy(gunRoot.matrixWorld);
    // Use the last firmly-gripped relationship captured above; don't recapture on
    // the rising edge (the hand has already started blending toward the sprint pose).
    carryActive = true;
    _socketMat.multiplyMatrices(rightHandBone.matrixWorld, _carryLocal);

    // Blend body-anchored ↔ hand-socketed world poses by carryWeight.
    _bodyMat.decompose(_pA, _qA, _sA);
    _socketMat.decompose(_pB, _qB, _sB);
    _pA.lerp(_pB, carryWeight);
    _qA.slerp(_qB, carryWeight);
    _sA.lerp(_sB, carryWeight);
    _blendMat.compose(_pA, _qA, _sA);

    // Convert the blended world pose into weaponAnchor-local and write the gun.
    weaponAnchor.updateWorldMatrix(true, false);
    _localMat.copy(weaponAnchor.matrixWorld).invert().multiply(_blendMat);
    _localMat.decompose(gunRoot.position, gunRoot.quaternion, gunRoot.scale);
    gunRoot.updateMatrixWorld(true);
    syncLeftIkTarget();
    syncRightIkTarget();
  }

  function updateWeaponAimPose() { updateWeaponFromRightHand(); }
  function updateWeaponAnchorFromRightHand() { updateWeaponFromRightHand(); }

  function measure() {
    let rightHandToGripCm = null;
    let leftHandToSupportCm = null;
    // Right hand distance to its live IK target (grip_mount + rightIk offset).
    if (rightHandBone && rightIkTarget.parent) {
      rightHandBone.getWorldPosition(_handWorld);
      rightIkTarget.getWorldPosition(_gripWorld);
      rightHandToGripCm = _handWorld.distanceTo(_gripWorld) * 100;
    } else if (rightHandBone && gripMount?.parent) {
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
      hasRightIk: rightReady && gunDebugSocket.rightIkEnabled,
      hasLeftIk: leftReady && gunDebugSocket.leftIkEnabled,
      adsBlend,
      solver: 'bodyAnchored+dualIk',
      debugRevision: gunDebugSocket.revision,
    };
  }

  function dispose() {
    setWeapon(null);
    if (leftIkTarget.parent) leftIkTarget.parent.remove(leftIkTarget);
    if (rightIkTarget.parent) rightIkTarget.parent.remove(rightIkTarget);
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
    setAimPitch,
    setAdsPose,
    layoutGunInHand,
    updateWeaponAimPose,
    updateWeaponFromRightHand,
    updateWeaponAnchorFromRightHand,
    updateRightHandIk,
    updateLeftHandIk,
    setLeftHandProceduralTarget,
    applyHandCarry,
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
