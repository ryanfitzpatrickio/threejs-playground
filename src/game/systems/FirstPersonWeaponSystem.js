/**
 * FirstPersonWeaponSystem (M3 + M4)
 *
 * On-foot first-person: head hide, spine aim, body yaw neck clamp, traversal gate,
 * gun equip, weapon-hand anchor + CCDIK (M4).
 */

import { GAME_CONFIG } from '../config/gameConfig.js';
import {
  applyFirstPersonBodyYaw,
  applySpineAimPitch,
  chooseLocomotion,
  isFirstPersonForwardIntent,
  mapLocomotionToPlaybackState,
  movementToLocomotionAxes,
  resolveSpineAimBones,
  setHeadHidden,
} from '../characters/player/firstPersonRig.js';
import {
  resolveWeaponHandIk,
  resolveWeaponLocomotionState,
} from '../characters/player/weaponLocomotion.js';
import { createFirstPersonHandIk } from '../characters/player/firstPersonHandIk.js';
import { defaultGunIdFromQuery, loadGunView } from '../weapons/loadGunView.js';
import { applyGunSocketPreset, gunDebugSocket } from '../weapons/gunDebugSocket.js';
import { meleeDebugSocket } from '../weapons/meleeDebugSocket.js';
import { sampleReloadLeftHand } from '../weapons/reloadIkDirector.js';
import {
  getReloadDebugPathOptions,
  reloadDebugSocket,
  resolveReloadDebugProgress,
} from '../weapons/reloadDebugSocket.js';
import { findMagazineMeshes } from '../weapons/magazineParts.js';
import * as THREE from 'three';

/** Reload IK scratch (module-scope, reused each frame). */
const _wpRest = new THREE.Vector3();
const _wpSocket = new THREE.Vector3();
const _wpBelt = new THREE.Vector3();
const _reloadLeftPos = new THREE.Vector3();
const _reloadLeftQuat = new THREE.Quaternion();
const _reloadLeftEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const _reloadSupportQuat = new THREE.Quaternion();
const _reloadWaypoints = { rest: _wpRest, magSocket: _wpSocket, belt: _wpBelt };
/** Legacy fallback when an old gun view has no authored belt-source marker. */
const RELOAD_BELT_DROP = 0.38;
const _reloadTargetLocal = new THREE.Matrix4();
const _reloadParentInverse = new THREE.Matrix4();
const _reloadWorldScale = new THREE.Vector3();
const _reloadParentWorldScale = new THREE.Vector3();
const _reloadInsertPos = new THREE.Vector3();
const _reloadInsertQuat = new THREE.Quaternion();
const _reloadMagWorldQuat = new THREE.Quaternion();
const _reloadAnchorScaled = new THREE.Vector3();
const _reloadTargetPos = new THREE.Vector3();
const _reloadTargetQuat = new THREE.Quaternion();
const _reloadTargetScale = new THREE.Vector3();
const _reloadInsertDir = new THREE.Vector3();
const _reloadPalmUp = new THREE.Vector3(0, 1, 0);
const _reloadBodyQuat = new THREE.Quaternion();
const _reloadBodyOffset = new THREE.Vector3();
/** View-space look pitch from the gameplay camera (+ = look up). */
const _aimLookDir = new THREE.Vector3();

/**
 * Resolve vertical aim from the camera's world look ray.
 * Do not use cameraSystem.pitch: in third person that value is orbit elevation
 * (positive = camera high = looking down), the opposite of first-person look pitch.
 */
function resolveAimLookPitch(cameraSystem) {
  const camera = cameraSystem?.camera;
  if (camera?.getWorldDirection) {
    camera.getWorldDirection(_aimLookDir);
    const y = THREE.MathUtils.clamp(_aimLookDir.y, -1, 1);
    if (Number.isFinite(y)) return Math.asin(y);
  }
  // FP-only fallback: pitch is look angle with + = up.
  return Number(cameraSystem?.pitch) || 0;
}

/** Mag-local insert fallback when socket→mag capture is unavailable. */
const _MAG_INSERT_LOCAL = Object.freeze({
  name: 'mag_insert',
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  unit: 'meters',
});
/**
 * Used once at mag_spawn to place the hold carrier at the palm (middle
 * metacarpal) relative to the IK hand bone. We do NOT parent the mag to the
 * finger bone — finger animation would slide the mag relative to the insert
 * aim every frame. Carrier stays on leftHandBone with a frozen hand-local offset.
 */
const RELOAD_PALM_BONE_NAMES = Object.freeze([
  'mixamorigLeftHandMiddle1',
  'mixamorig6LeftHandMiddle1',
  'LeftHandMiddle1',
]);

export class FirstPersonWeaponSystem {
  constructor() {
    this.active = false;
    this.fp = false;
    this.armed = false;
    this.locomotionKey = 'idle';
    this.playbackState = 'armedIdle';
    // Which hands keep IK for the current playback state, and whether the gun
    // rides the right hand (carry) instead of being body-anchored (sprint).
    this.handIkGate = { left: true, right: true, carry: false };
    this.spineAimBones = [];
    this._characterRef = null;
    this._headHidden = false;
    this.gateTraversal = true;

    /** @type {import('../characters/player/firstPersonHandIk.js').HandIkRig|null} */
    this.handIk = null;
    /** @type {import('../weapons/loadGunView.js').GunView|null} */
    this.gunView = null;
    this.equippedGunId = null;
    this._equipPromise = null;
    this._equipToken = 0;
    this._equipAttemptedId = null;
    this._ikSetupFailed = false;
    this.visibleWeapon = false;
    /** When true, gun is put away (Z holster / sword selected). */
    this.holstered = true;
    /** Current detachable-magazine cycle (AR4), or null for internal tubes. */
    this._reloadMagazineCycle = null;
    // Older Gunsmith profiles may not yet tag a magazine mesh. Keep a tiny
    // runtime proxy so reload feedback remains visible until a real part is
    // authored; tagged magazine meshes always take precedence.
    this._seatedFallbackMagazine = null;
    this._fallbackMagazineGeometry = null;
    this._fallbackMagazineMaterial = null;
  }

  /**
   * Hide/show the equipped firearm without disposing it.
   * @param {boolean} holstered
   */
  setHolstered(holstered) {
    this.holstered = Boolean(holstered);
    if (this.holstered) {
      this._setWeaponVisible(false);
      // Detach gun from hand IK so sword/melee (or unarmed) is not left in a
      // rifle/pistol grip pose after a hotkey switch.
      this.cancelReloadMagazineCycle();
      this.handIk?.setWeapon?.(null);
    } else if (this.gunView) {
      this._setWeaponVisible(true);
      // Re-parent after a holster detach (setWeapon(null) above).
      this.handIk?.setWeapon?.(this.gunView.root, this.gunView.anchors);
    }
  }

  initialize() {
    // no-op
  }

  start({ character } = {}) {
    this._bindCharacter(character);
  }

  _bindCharacter(character) {
    this._characterRef = character ?? null;
    const root = character?.animationController?.modelRoot
      || character?.modelRoot
      || character?.group;
    this.spineAimBones = root ? resolveSpineAimBones(root) : [];
    this._teardownIk();
    this._ikSetupFailed = false;
  }

  _ensureIk(character) {
    if (this.handIk?.ready) return this.handIk;
    if (this._ikSetupFailed) return null;
    const modelRoot = character?.animationController?.modelRoot
      || character?.modelRoot
      || null;
    if (!modelRoot) return null;
    // Parent weapon anchor to character.group so it tracks world pose with the
    // character; IK targets convert through bodyRoot (= character.group when available).
    const bodyRoot = character.group || modelRoot;
    this.handIk = createFirstPersonHandIk(modelRoot, bodyRoot);
    if (!this.handIk) {
      this._ikSetupFailed = true;
      console.warn('[FirstPersonWeaponSystem] hand IK setup failed');
    }
    return this.handIk;
  }

  _teardownIk() {
    this.cancelReloadMagazineCycle();
    if (this.gunView && this.handIk) {
      this.handIk.setWeapon(null);
    }
    this.handIk?.dispose?.();
    this.handIk = null;
  }

  /**
   * AR4 detachable-magazine lifecycle. WeaponSystem calls this at the gun's
   * discrete reload phases: remove the spent mesh once its physics clone is
   * released, carry a fresh clone on the left hand, then snap it into the gun.
   * @param {'mag_drop'|'mag_spawn'|'mag_seat'} phase
   */
  handleReloadMagazinePhase(phase) {
    const view = this.gunView;
    if (!view?.root || !view?.profile) return false;

    if (phase === 'mag_drop') {
      // Ignore duplicate events from a reload phase crossing more than once.
      if (this._reloadMagazineCycle?.root === view.root) return false;
      const annotated = findMagazineMeshes(view.root, view.profile)[0]?.mesh ?? null;
      const fallback = !annotated;
      const current = annotated
        ?? this._seatedFallbackMagazine
        ?? this._createFallbackMagazine();
      if (!current) return false;
      // Capture gun-local transform + world scale BEFORE unparenting. Meshy gun
      // parts often live at local scale ~1e-4 under a scaled import tree; when
      // the clone is later parented under the Mixamo armature (scale 0.01),
      // alignObjectAnchorToMatrix's unit-scale target would balloon them to
      // kilometers and the "fresh mag" reads as missing.
      current.updateWorldMatrix(true, false);
      current.getWorldScale(_reloadWorldScale);
      // Mag-local insert in meters: while seated, mag_socket is the feed lip.
      // Skip for unparented fallback proxies (they never sat in the well).
      const insertLocal = (!fallback && current.parent)
        ? this._captureMagazineInsertLocal(current, view.anchors?.mag_socket)
        : { ..._MAG_INSERT_LOCAL, unit: 'meters' };
      this._reloadMagazineCycle = {
        root: view.root,
        profile: view.profile,
        anchors: view.anchors,
        spentMag: current,
        originalParent: current.parent ?? view.root,
        originalLocal: {
          position: current.position.clone(),
          quaternion: current.quaternion.clone(),
          scale: current.scale.clone(),
        },
        originalWorldScale: _reloadWorldScale.clone(),
        insertLocal,
        fallback,
        freshMag: null,
      };
      // AR2 has already cloned the world pose into its falling physics prop.
      // Remove the original from the gun so the empty well reads correctly.
      current.removeFromParent();
      if (fallback) this._seatedFallbackMagazine = null;
      return true;
    }

    const cycle = this._reloadMagazineCycle;
    if (!cycle || cycle.root !== view.root) return false;

    if (phase === 'mag_spawn') {
      if (cycle.freshMag) return false;
      // Parent to the IK hand bone (not a finger). Finger bones keep animating
      // under the IK solve and would slide the mag around the insert aim.
      const holder = this.handIk?.leftHandBone;
      if (!holder) return false;

      const fresh = cycle.spentMag.clone(true);
      fresh.name = cycle.spentMag.name;

      // Freeze hold point + base palm pose once; later frames only re-apply
      // that frozen local transform (+ magCarry debug fudge).
      cycle.carryBasePosition = null;
      cycle.carryBaseQuaternion = null;
      cycle.carrierLocalPos = null;
      const carrier = this._ensureReloadMagCarrier(holder, cycle);
      carrier.add(fresh);
      if (cycle.originalWorldScale) fresh.scale.copy(cycle.originalWorldScale);
      else fresh.scale.set(1, 1, 1);
      cycle.freshMag = fresh;
      this._updateCarriedMagazinePose();
      return true;
    }

    if (phase === 'mag_seat') {
      const fresh = cycle.freshMag;
      if (!fresh || !cycle.originalParent) return false;

      // Always seat by world-aligning mag_insert → mag_socket. Restoring the
      // GLB local pose left the feed lip off the well (Meshy mesh origin ≠
      // socket); FP hid that, TP made it obvious.
      this._disposeReloadMagCarrier(cycle);
      if (!this._seatMagazineInsertToSocket(fresh, cycle)) return false;
      // Bake seated local so the next drop's originalLocal matches the well.
      cycle.originalLocal = {
        position: fresh.position.clone(),
        quaternion: fresh.quaternion.clone(),
        scale: fresh.scale.clone(),
      };
      if (cycle.fallback) this._seatedFallbackMagazine = fresh;
      cycle.freshMag = null;
      this._reloadMagazineCycle = null;
      return true;
    }

    return false;
  }

  /**
   * Capture mag_insert as a **scale-free meter offset** from mag origin to the
   * seated well (mag_socket), in the mag's local orientation frame.
   *
   * Gunsmith `mag_insert` is gun-space (not usable). Mesh-local worldToLocal
   * is also wrong after reparent: Meshy parts use local scale ~1e-4, so those
   * coords only make sense at that scale. Meters stay valid under any parent.
   */
  _captureMagazineInsertLocal(magMesh, socketAnchor) {
    if (!magMesh || !socketAnchor) {
      return { ..._MAG_INSERT_LOCAL, unit: 'meters' };
    }
    magMesh.updateWorldMatrix(true, false);
    socketAnchor.updateWorldMatrix(true, false);
    socketAnchor.getWorldPosition(_reloadInsertPos);
    magMesh.getWorldPosition(_reloadTargetPos);
    magMesh.getWorldQuaternion(_reloadMagWorldQuat);
    // World offset insert − origin, then into mag-local axes (still meters).
    _reloadInsertPos.sub(_reloadTargetPos);
    _reloadInsertPos.applyQuaternion(_reloadMagWorldQuat.clone().invert());
    socketAnchor.getWorldQuaternion(_reloadInsertQuat);
    // insertLocalQuat: magWorld * insertLocal = socketWorld
    _reloadMagWorldQuat.invert().multiply(_reloadInsertQuat);
    return {
      name: 'mag_insert',
      position: _reloadInsertPos.toArray(),
      quaternion: [
        _reloadMagWorldQuat.x,
        _reloadMagWorldQuat.y,
        _reloadMagWorldQuat.z,
        _reloadMagWorldQuat.w,
      ],
      scale: [1, 1, 1],
      unit: 'meters',
    };
  }

  /** Palm hold bone under the left hand, else the hand bone itself. */
  _resolveReloadPalmBone(leftHandBone) {
    if (!leftHandBone) return null;
    for (const name of RELOAD_PALM_BONE_NAMES) {
      const hit = leftHandBone.getObjectByName?.(name);
      if (hit) return hit;
    }
    let found = null;
    leftHandBone.traverse?.((obj) => {
      if (found || obj === leftHandBone) return;
      if (/left.*hand.*middle.*1$/i.test(obj.name || '')) found = obj;
    });
    return found || leftHandBone;
  }

  /**
   * Unit-scale carrier under the **left hand bone** (IK end effector). Palm
   * placement is a frozen hand-local offset sampled once from Middle1 so finger
   * animation cannot walk the mag around the insert aim.
   */
  _ensureReloadMagCarrier(handBone, cycle) {
    let carrier = cycle.magCarrier;
    if (!carrier || carrier.parent !== handBone) {
      carrier?.removeFromParent?.();
      carrier = new THREE.Group();
      carrier.name = 'ReloadMagCarrier';
      handBone.add(carrier);
      cycle.magCarrier = carrier;
    }
    handBone.updateWorldMatrix(true, false);
    // Freeze palm hold point in hand-local once per cycle.
    if (!cycle.carrierLocalPos) {
      const palm = this._resolveReloadPalmBone(handBone);
      if (palm && palm !== handBone) {
        palm.updateWorldMatrix(true, false);
        palm.getWorldPosition(_reloadTargetPos);
        handBone.worldToLocal(_reloadTargetPos);
        cycle.carrierLocalPos = _reloadTargetPos.clone();
      } else {
        cycle.carrierLocalPos = new THREE.Vector3(0, 0, 0);
      }
    }
    handBone.getWorldScale(_reloadParentWorldScale);
    const px = Math.abs(_reloadParentWorldScale.x) > 1e-8 ? _reloadParentWorldScale.x : 1;
    const py = Math.abs(_reloadParentWorldScale.y) > 1e-8 ? _reloadParentWorldScale.y : 1;
    const pz = Math.abs(_reloadParentWorldScale.z) > 1e-8 ? _reloadParentWorldScale.z : 1;
    carrier.position.copy(cycle.carrierLocalPos);
    carrier.quaternion.identity();
    // Counter armature scale so children use meters.
    carrier.scale.set(1 / px, 1 / py, 1 / pz);
    carrier.updateMatrix();
    carrier.updateMatrixWorld?.(true);
    return carrier;
  }

  _disposeReloadMagCarrier(cycle) {
    if (!cycle?.magCarrier) return;
    cycle.magCarrier.removeFromParent();
    cycle.magCarrier = null;
  }

  /**
   * Hold pose: mag_insert sits on the palm carrier origin; mag body hangs toward
   * the wrist (opposite Mixamo hand +Y / fingers). Built once per cycle and
   * frozen — setFromUnitVectors is pure, but we still cache so carry fudge
   * never stacks and insertLocal cannot drift mid-reload.
   */
  _alignMagazineInsertToPalm(object, insertLocal) {
    if (!object) return;
    const scale = object.scale.clone();
    const ap = insertLocal?.position || [0, 0, 0];
    _reloadInsertDir.set(ap[0], ap[1], ap[2]);
    const len = _reloadInsertDir.length();
    if (len > 1e-6) {
      _reloadInsertDir.multiplyScalar(1 / len);
      // Palm carrier: +Y toward fingers. Map mag origin→insert onto +Y so the
      // body (origin) sits at −Y (into the palm / toward the wrist).
      object.quaternion.setFromUnitVectors(_reloadInsertDir, _reloadPalmUp);
    } else {
      object.quaternion.identity();
    }
    _reloadAnchorScaled.set(ap[0], ap[1], ap[2]).applyQuaternion(object.quaternion);
    // Insert at carrier origin (palm).
    object.position.copy(_reloadAnchorScaled).negate();
    object.scale.copy(scale);
    object.updateMatrix();
    object.updateMatrixWorld?.(true);
  }

  /**
   * Fresh mag on the left hand (belt → seat): frozen palm-insert base + live
   * magCarryPosition / magCarryRotationDeg. Rebases every frame so debug
   * sliders update without stacking.
   */
  _updateCarriedMagazinePose() {
    const cycle = this._reloadMagazineCycle;
    const fresh = cycle?.freshMag;
    if (!fresh || !cycle) return;
    const holder = this.handIk?.leftHandBone;
    if (!holder) return;
    // Keep carrier on the hand bone with frozen palm offset + counter-scale.
    this._ensureReloadMagCarrier(holder, cycle);
    if (fresh.parent !== cycle.magCarrier) cycle.magCarrier.add(fresh);

    if (cycle.originalWorldScale) fresh.scale.copy(cycle.originalWorldScale);

    if (!cycle.carryBasePosition || !cycle.carryBaseQuaternion) {
      this._alignMagazineInsertToPalm(fresh, cycle.insertLocal || _MAG_INSERT_LOCAL);
      cycle.carryBasePosition = fresh.position.clone();
      cycle.carryBaseQuaternion = fresh.quaternion.clone();
    } else {
      fresh.position.copy(cycle.carryBasePosition);
      fresh.quaternion.copy(cycle.carryBaseQuaternion);
    }

    if (reloadDebugSocket.enabled) {
      const [px, py, pz] = reloadDebugSocket.magCarryPosition || [0, 0, 0];
      const [rx, ry, rz] = reloadDebugSocket.magCarryRotationDeg || [0, 0, 0];
      if (px || py || pz) {
        fresh.position.x += Number(px) || 0;
        fresh.position.y += Number(py) || 0;
        fresh.position.z += Number(pz) || 0;
      }
      if (rx || ry || rz) {
        _reloadLeftEuler.set(
          THREE.MathUtils.degToRad(Number(rx) || 0),
          THREE.MathUtils.degToRad(Number(ry) || 0),
          THREE.MathUtils.degToRad(Number(rz) || 0),
          'XYZ',
        );
        _reloadInsertQuat.setFromEuler(_reloadLeftEuler);
        fresh.quaternion.multiply(_reloadInsertQuat);
      }
    }
    fresh.updateMatrix();
    fresh.updateMatrixWorld?.(true);
  }

  /**
   * Seat the fresh mag under its gun parent so captured mag_insert (meters in
   * mag-local axes) coincides with mag_socket in world space. Works under the
   * scaled Meshy import tree (parent-local ≠ meters).
   */
  _seatMagazineInsertToSocket(fresh, cycle) {
    const parent = cycle?.originalParent;
    const socket = cycle?.anchors?.mag_socket;
    const insert = cycle?.insertLocal || _MAG_INSERT_LOCAL;
    if (!fresh || !parent || !socket) return false;

    parent.updateWorldMatrix(true, false);
    socket.updateWorldMatrix(true, false);
    socket.getWorldPosition(_reloadTargetPos);
    socket.getWorldQuaternion(_reloadTargetQuat);

    // magWorldQuat * insertLocalQuat = socketWorldQuat
    const iq = insert.quaternion || [0, 0, 0, 1];
    _reloadInsertQuat.set(iq[0], iq[1], iq[2], iq[3]).normalize();
    _reloadMagWorldQuat.copy(_reloadTargetQuat).multiply(_reloadInsertQuat.clone().invert());

    // magOrigin = socketPos − R * insertMeters
    const ip = insert.position || [0, 0, 0];
    _reloadAnchorScaled.set(ip[0], ip[1], ip[2]).applyQuaternion(_reloadMagWorldQuat);
    _reloadInsertPos.copy(_reloadTargetPos).sub(_reloadAnchorScaled);

    // Authored mesh local scale under the gun (Meshy ~1e-4); derive from world if missing.
    if (cycle.originalLocal?.scale) {
      fresh.scale.copy(cycle.originalLocal.scale);
    } else if (cycle.originalWorldScale) {
      parent.getWorldScale(_reloadParentWorldScale);
      const px = Math.abs(_reloadParentWorldScale.x) > 1e-8 ? _reloadParentWorldScale.x : 1;
      const py = Math.abs(_reloadParentWorldScale.y) > 1e-8 ? _reloadParentWorldScale.y : 1;
      const pz = Math.abs(_reloadParentWorldScale.z) > 1e-8 ? _reloadParentWorldScale.z : 1;
      fresh.scale.set(
        cycle.originalWorldScale.x / px,
        cycle.originalWorldScale.y / py,
        cycle.originalWorldScale.z / pz,
      );
    }

    parent.add(fresh);
    // Bake world origin into parent-local (accounts for parent scale).
    _reloadTargetPos.copy(_reloadInsertPos);
    parent.worldToLocal(_reloadTargetPos);
    fresh.position.copy(_reloadTargetPos);
    parent.getWorldQuaternion(_reloadSupportQuat);
    fresh.quaternion.copy(_reloadSupportQuat).invert().multiply(_reloadMagWorldQuat);
    fresh.updateMatrix();
    fresh.updateMatrixWorld?.(true);
    return true;
  }

  /**
   * Place magazine so its insert (meter offset in mag-local axes) matches
   * `targetMatrix` in the parent space (unit-scale parents only).
   */
  _alignMagazineAnchorPreserveScale(object, objectAnchor, targetMatrix) {
    if (!object || !targetMatrix) return;
    const scale = object.scale.clone();
    targetMatrix.decompose(_reloadTargetPos, _reloadTargetQuat, _reloadTargetScale);

    const ap = objectAnchor?.position || [0, 0, 0];
    const aq = objectAnchor?.quaternion || [0, 0, 0, 1];
    _reloadInsertQuat.set(aq[0], aq[1], aq[2], aq[3]).normalize();
    object.quaternion.copy(_reloadTargetQuat).multiply(_reloadInsertQuat.clone().invert());

    _reloadAnchorScaled.set(ap[0], ap[1], ap[2]);
    _reloadAnchorScaled.applyQuaternion(object.quaternion);
    object.position.copy(_reloadTargetPos).sub(_reloadAnchorScaled);
    object.scale.copy(scale);
    object.updateMatrix();
    object.updateMatrixWorld?.(true);
  }

  /**
   * Set an object's local scale so its world scale matches `worldScale`.
   * Required when reparenting Meshy mag parts onto differently-scaled parents
   * (gun import tree vs Mixamo armature).
   */
  _applyMagazineWorldScale(object, worldScale) {
    if (!object || !worldScale) return;
    const parent = object.parent;
    if (!parent) {
      object.scale.copy(worldScale);
      object.updateMatrix();
      return;
    }
    parent.updateWorldMatrix(true, false);
    parent.getWorldScale(_reloadParentWorldScale);
    const px = Math.abs(_reloadParentWorldScale.x) > 1e-8 ? _reloadParentWorldScale.x : 1;
    const py = Math.abs(_reloadParentWorldScale.y) > 1e-8 ? _reloadParentWorldScale.y : 1;
    const pz = Math.abs(_reloadParentWorldScale.z) > 1e-8 ? _reloadParentWorldScale.z : 1;
    object.scale.set(worldScale.x / px, worldScale.y / py, worldScale.z / pz);
    object.updateMatrix();
    object.updateMatrixWorld?.(true);
  }

  /** Restore the original magazine when a reload is interrupted before seating. */
  cancelReloadMagazineCycle() {
    const cycle = this._reloadMagazineCycle;
    if (!cycle) return false;
    if (cycle.freshMag?.parent) cycle.freshMag.removeFromParent();
    this._disposeReloadMagCarrier(cycle);
    if (cycle.spentMag && cycle.originalParent && !cycle.spentMag.parent) {
      cycle.originalParent.add(cycle.spentMag);
      if (cycle.fallback) this._seatedFallbackMagazine = cycle.spentMag;
    }
    this._reloadMagazineCycle = null;
    return true;
  }

  /** Visible replacement for unannotated legacy guns; origin is the insert lip. */
  _createFallbackMagazine() {
    if (!this._fallbackMagazineGeometry) {
      this._fallbackMagazineGeometry = new THREE.BoxGeometry(0.055, 0.18, 0.040);
      this._fallbackMagazineMaterial = new THREE.MeshStandardMaterial({
        color: 0x24272a,
        roughness: 0.46,
        metalness: 0.68,
      });
    }
    const root = new THREE.Group();
    root.name = 'runtime_reload_magazine';
    root.userData.reloadFallbackMagazine = true;
    const mesh = new THREE.Mesh(this._fallbackMagazineGeometry, this._fallbackMagazineMaterial);
    mesh.name = 'runtime_reload_magazine_mesh';
    // The group origin is at the feed-lip / mag_insert point; the body hangs
    // beneath it when snapped to mag_socket.
    mesh.position.y = -0.09;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return root;
  }

  _clearFallbackMagazine() {
    this._seatedFallbackMagazine?.removeFromParent?.();
    this._seatedFallbackMagazine = null;
  }

  /**
   * Equip a catalog gun (async). Safe to call repeatedly; last call wins.
   * @param {string} [gunId]
   */
  async equipGun(gunId = defaultGunIdFromQuery()) {
    const token = ++this._equipToken;
    this._equipAttemptedId = gunId;
    this._equipPromise = (async () => {
      try {
        const view = await loadGunView(gunId);
        if (token !== this._equipToken) {
          view.dispose();
          return null;
        }
        if (this.gunView) {
          this.cancelReloadMagazineCycle();
          this._clearFallbackMagazine();
          this.handIk?.setWeapon(null);
          this.gunView.dispose();
        }
        this.gunView = view;
        this.equippedGunId = view.id;
        // Load per-gun hand / support-IK defaults (e.g. midnight-glock fit).
        applyGunSocketPreset(view.id);
        const character = this._characterRef;
        if (character) {
          const ik = this._ensureIk(character);
          ik?.setWeapon(view.root, view.anchors);
          ik?.layoutGunInHand?.({ force: true });
        }
        this._setWeaponVisible(this.active);
        return view;
      } catch (err) {
        console.warn('[FirstPersonWeaponSystem] equipGun failed', gunId, err);
        return null;
      } finally {
        if (token === this._equipToken) {
          this._equipPromise = null;
        }
      }
    })();
    return this._equipPromise;
  }

  _setWeaponVisible(visible) {
    this.visibleWeapon = Boolean(visible);
    if (this.gunView?.root) {
      this.gunView.root.visible = this.visibleWeapon;
    }
  }

  /**
   * Head/neck scale-down for on-foot first person so the head mesh never fills
   * the view — drawn gun/sword and unarmed/stowed holster alike.
   * Also keeps the back sheath out of first person (clips the camera / body).
   */
  _syncHeadHide(character, { fp, driving }) {
    // Independent of drawn loadout: stowed/unarmed FP still sees the body and
    // would clip the head without this.
    const wantHide = Boolean(fp && !driving);
    if (wantHide) this._ensureHeadHidden(character);
    else this._restoreHead(character);
    this._syncSheathVisibility(character, { fp });
  }

  /** Sheath stays on the back in third person; never shown in first person. */
  _syncSheathVisibility(character, { fp }) {
    const sheath = character?.sword?.sheath?.group
      || character?.combat?.sword?.sheath?.group
      || null;
    if (!sheath) return;
    const wantVisible = !fp;
    if (sheath.visible !== wantVisible) {
      sheath.visible = wantVisible;
    }
  }

  /**
   * Called early in the frame (before traversal/combat) to gate input when FP armed.
   * Gun stance only when a firearm is the drawn loadout weapon (WeaponSystem).
   *
   * @param {{ input: object, character: object, cameraSystem: object, weaponSystem?: object }} ctx
   */
  processInput({ input, character, cameraSystem, weaponSystem = null }) {
    const fp = Boolean(cameraSystem?.usesOnFootFirstPerson?.());
    const driving = Boolean(character?.vehicle);
    const gunDrawn = weaponSystem
      ? weaponSystem.isGunDrawn()
      : (!this.holstered && Boolean(this.gunView));
    // The gun hold (equip / visibility / hand IK / weaponClass / firing) runs in
    // BOTH first and third person. `fp` only gates the FP-camera extras (head hide,
    // FP body yaw, full-body animationOverride). Sword still needs the head hide.
    this.armed = Boolean(gunDrawn && !driving);
    this.fp = fp && this.armed;
    this.active = this.armed;

    if (!this.armed) {
      this._clearOverride(character);
      this._syncHeadHide(character, { fp, driving });
      this._setWeaponVisible(false);
      return input;
    }

    if (character && character !== this._characterRef) {
      this._bindCharacter(character);
    }

    // Ensure the equipped loadout gun is loaded (WeaponSystem picks the id).
    if (typeof window !== 'undefined' && window?.location) {
      const wantedGun = weaponSystem?.isGunEquipped?.()
        ? weaponSystem.equippedId
        : defaultGunIdFromQuery();
      if (wantedGun && !this.gunView && !this._equipPromise && this._equipAttemptedId !== wantedGun) {
        void this.equipGun(wantedGun);
      } else if (this.gunView && !this.holstered) {
        this._setWeaponVisible(true);
        const ik = this.handIk || this._ensureIk(character);
        // Always re-bind: holster/sword may have cleared setWeapon(null).
        if (ik && this.gunView.root && this.gunView.root.parent !== ik.weaponAnchor) {
          ik.setWeapon(this.gunView.root, this.gunView.anchors);
        }
      }
    }

    if (!input) return input;

    let next = input;
    // Gate most traversal while a firearm is drawn in FP. Slide stays allowed
    // (tap C / Ctrl while running) in both first and third person.
    if (this.gateTraversal) {
      next = {
        ...next,
        vaultPressed: false,
        wallRunPressed: false,
        wallClimbPressed: false,
        ledgeGrabPressed: false,
        ropePressed: false,
        wingsuitPressed: false,
        wingsuitTogglePressed: false,
        hookPressed: false,
        hookFirePressed: false,
        hookFire: false,
        hookFireDoubleTapped: false,
        abilityPressed: false,
      };
    }

    // Fire seamlessly overrides sprint: keep WASD move and the Shift key held,
    // but drop sprint speed/gait for as long as the trigger is down. Releasing
    // fire while still holding Shift resumes sprint without re-tapping.
    const fireHeld = Boolean(
      next.mousePrimaryHeld
      || next.fireHeld
      || next.lightAttackPressed
      || next.firePressed,
    );
    if (fireHeld) {
      next = { ...next, suppressSprint: true };
    }

    return next;
  }

  /**
   * After movement, set combat.animationOverride from locomotion key when FP packs exist.
   */
  update({ delta, input, movement, character, cameraSystem, weaponSystem = null }) {
    const fp = Boolean(cameraSystem?.usesOnFootFirstPerson?.());
    const driving = Boolean(character?.vehicle);
    const gunDrawn = weaponSystem
      ? weaponSystem.isGunDrawn()
      : (!this.holstered && Boolean(this.gunView));
    this.armed = Boolean(gunDrawn && !driving);
    this.fp = fp && this.armed;
    this.active = this.armed;

    if (!character) return;

    if (!this.armed) {
      this._clearOverride(character);
      this._syncHeadHide(character, { fp, driving });
      this._setWeaponVisible(false);
      return;
    }

    if (character !== this._characterRef || this.spineAimBones.length === 0) {
      this._bindCharacter(character);
      if (this.gunView) {
        const ik = this._ensureIk(character);
        ik?.setWeapon(this.gunView.root, this.gunView.anchors);
      }
    }

    // Don't fight sword combat overrides mid-attack/draw.
    const combat = character.combat;
    if (combat?.attack || (combat?.weapon && combat.weapon !== 'sheathed' && combat.weapon !== 'armed')) {
      this._syncHeadHide(character, { fp, driving });
      this._setWeaponVisible(false);
      return;
    }

    const { forward, strafe } = movementToLocomotionAxes(movement, input);
    // Movement.sprinting already drops while suppressSprint is set; also gate
    // brace/speed heuristics so residual sprint velocity can't re-select the
    // sprint clip for a frame after the fire button goes down.
    const fireHeld = Boolean(
      input?.suppressSprint
      || input?.mousePrimaryHeld
      || input?.fireHeld
      || input?.lightAttackPressed
      || input?.firePressed,
    );
    const sprinting = !fireHeld && Boolean(
      movement?.sprinting
      || input?.sprint
      || input?.sprintHeld
      || input?.brace
      || (movement?.speed ?? 0) > 5.5,
    );
    const grounded = !(movement?.airborne);
    // Any equipped gun animates; default an unknown/kindless view to the rifle
    // family (never fall back to open-handed unarmed with a visible gun).
    const weaponKind = this.gunView?.gun?.weaponKind
      ?? (this.gunView?.root ? 'rifle' : null);
    const aiming = Boolean(character.combat?.aiming);
    const stance = character.combat?.stance === 'crouch' ? 'crouch' : 'stand';

    // Shared FP/TP resolver drives the 8-way / crouch / aim clip choice.
    const resolved = weaponKind
      ? resolveWeaponLocomotionState({
        weaponKind, stance, aiming, forward, strafe, sprinting, grounded,
        turning: character.combat?.turning ?? null,
      })
      : null;
    this.locomotionKey = resolved?.state ?? 'idle';

    if (!character.combat) {
      character.combat = {
        weapon: 'sheathed',
        armed: false,
        animationOverride: null,
        comboStep: 0,
        attack: null,
        lockMovement: false,
        bufferedLight: false,
        sword: null,
      };
    }

    const hasGun = Boolean(this.gunView?.root);
    const ctrl = character.animationController;
    // Gun out → weapon locomotion (rifle_/pistol_ 8-way) with a graceful fallback
    // to the legacy fp_*/armed* pack while the richer clips stream in. Never leave
    // unarmed idle/jog playing with a visible gun (open palms + floating rifle).
    if (hasGun && resolved) {
      let state = resolved.state;
      if (!ctrl?.hasState?.(state)) {
        // Not loaded yet → legacy single-direction fallback.
        const hasWeaponPack = Boolean(ctrl?.hasState?.('fp_idle'));
        const legacyKey = chooseLocomotion({ forward, strafe, running: sprinting, grounded });
        state = mapLocomotionToPlaybackState(legacyKey, { hasWeaponPack });
        if (!ctrl?.hasState?.(state)) {
          state = ctrl?.hasState?.('fp_idle')
            ? 'fp_idle'
            : (ctrl?.hasState?.('armedIdle') ? 'armedIdle' : 'idle');
        }
      }
      this.playbackState = state;
      // weaponClass drives the shared resolver in BOTH modes (third person via the
      // AnimationStateSystem weaponClass branch + MovementSystem aim/turn).
      character.combat.weaponClass = resolved.kind;
      if (this.fp) {
        // First person owns a full-body clip via animationOverride (short-circuits
        // AnimationStateSystem). Third person leaves it null so that system's own
        // weaponClass branch resolves (correct velocity/aim facing + footwork/reload).
        character.combat.fpWeaponStance = true;
        character.combat.animationOverride = state;
      } else {
        character.combat.fpWeaponStance = false;
        const ov = character.combat.animationOverride;
        if (ov && (ov.startsWith('fp_') || ov.startsWith('armed') || ov.startsWith('rifle_') || ov.startsWith('pistol_'))) {
          character.combat.animationOverride = null;
        }
      }
      if (character.combat.weapon === 'sheathed') {
        character.combat.armed = false;
      }
    } else {
      this.playbackState = 'locomotion';
      character.combat.fpWeaponStance = false;
      character.combat.weaponClass = null;
      const ov = character.combat.animationOverride;
      if (ov && (ov.startsWith('fp_') || ov.startsWith('armed') || ov.startsWith('rifle_') || ov.startsWith('pistol_'))) {
        character.combat.animationOverride = null;
      }
      if (character.combat.weapon === 'sheathed') {
        character.combat.armed = false;
      }
    }

    // Per-animation hand-IK gating (e.g. sprint frees the left arm, keeps the
    // right on the grip). Keyed off the clip actually playing.
    this.handIkGate = resolveWeaponHandIk(this.playbackState);

    this._syncHeadHide(character, { fp, driving });
    this._setWeaponVisible(true);
  }

  /**
   * After AnimationStateSystem mixer write: spine bend toward the look pitch, then
   * body-anchored gun with both-hand IK onto grip/support (all debug-tunable).
   * Sword melee IK runs when the gun is not drawn — even if a holstered gunView
   * is still cached from the last firearm equip.
   */
  postAnimation({ character, cameraSystem, delta = 1 / 60 }) {
    if (!character) return;
    const sword = character.sword;
    const swordActive = Boolean(sword?.group?.visible && character.combat?.weapon !== 'sheathed');
    if (!this.active && !swordActive) return;

    const root = character.animationController?.modelRoot || character.group;
    root?.updateMatrixWorld?.(true);

    // Melee grip IK when sword is out and the firearm is not the active draw.
    if (swordActive && !this.active) {
      const meleeIk = this.handIk || this._ensureIk(character);
      meleeIk?.updateMeleeHandIk?.({
        rightTarget: sword.rightGrip ?? sword.group,
        leftTarget: sword.leftGrip ?? null,
        config: meleeDebugSocket,
        dt: Number(delta) || 1 / 60,
      });
      root?.updateMatrixWorld?.(true);
      return;
    }

    // Gun path only while the firearm is the drawn loadout (this.active).
    if (!this.active || !this.gunView) return;
    const ik = this.handIk || this._ensureIk(character);
    if (!ik?.ready) return;

    if (this.gunView.root && this.gunView.root.parent !== ik.weaponAnchor) {
      ik.setWeapon(this.gunView.root, this.gunView.anchors);
    }

    // Vertical aim: bend the spine partway toward the look and tilt the gun
    // holder the full amount so the muzzle tracks the camera look ray.
    // Look pitch comes from the camera world direction (+ = up), not from
    // cameraSystem.pitch (orbit elevation is opposite-signed in third person).
    // Signs/scale are live-tunable via gunDebugSocket.aimPitch* (negative flips).
    const lookPitch = resolveAimLookPitch(cameraSystem);
    applySpineAimPitch(this.spineAimBones, lookPitch * (Number(gunDebugSocket.aimPitchSpine) || 0));
    root?.updateMatrixWorld?.(true);
    ik.setAimPitch?.(lookPitch * (Number(gunDebugSocket.aimPitchGun) || 0));
    // Keep the gameplay camera fixed. In first person, move the gun so its
    // Gunsmith-authored adsCamera socket meets the camera eye instead.
    const scopeViewport = this.gunView.scopeViewport;
    ik.setAdsPose?.(
      cameraSystem?.camera ?? null,
      this.fp ? (this.gunView.gun?.ads ?? 0) : 0,
      scopeViewport?.mesh ?? null,
      scopeViewport?.config?.eyeRelief ?? 0,
    );
    this.gunView.scopeViewport?.setAds?.(
      this.fp ? (this.gunView.gun?.ads ?? 0) : 0,
    );

    ik.updateWeaponFromRightHand?.();
    // Gun is body-anchored: both hands IK onto it after layout, gated per
    // animation (this.handIkGate). We always call the updaters so the IK
    // influence ramps toward its target (0/1) — a gated state (e.g. sprint frees
    // both arms) blends off/on with no snap. Reload frees the left (it grabs the
    // magazine from the reload clip) rather than pinning it to the foregrip.
    const dt = Number(delta) || 1 / 60;
    ik.updateRightHandIk?.({ target: this.handIkGate.right ? 1 : 0, dt });
    // Reload steers the left hand through the magazine-change path (AR3) instead
    // of dropping its IK. The right hand keeps gripping throughout. Scrub mode
    // previews the same path from the Reload debug folder without a live reload.
    let leftTarget = this.handIkGate.left ? 1 : 0;
    const gun = this.gunView.gun;
    const isReloading = Boolean(character.combat?.reloading && gun?.isReloading);
    const pathT = gun?.reloadPhaseTiming
      ? resolveReloadDebugProgress(gun.reloadProgress, isReloading)
      : null;
    if (pathT != null && this._resolveReloadWaypoints(gun)) {
      // Path fudge is authored in body-local meters (+X left, +Y up, +Z fwd).
      // Convert to world here so turning 180° does not push the hand the wrong way.
      const bodyRoot = character.group || ik.bodyRoot || root;
      const pathOpts = this._reloadPathOptionsInWorld(getReloadDebugPathOptions(), bodyRoot);
      sampleReloadLeftHand(
        pathT,
        gun.reloadPhaseTiming,
        _reloadWaypoints,
        _reloadLeftPos,
        pathOpts,
      );
      this._resolveReloadLeftHandQuat(_reloadLeftQuat);
      ik.setLeftHandProceduralTarget?.(_reloadLeftPos, _reloadLeftQuat);
      leftTarget = 1;
    } else {
      ik.setLeftHandProceduralTarget?.(null);
      if (character.combat?.reloading) leftTarget = 0; // shotgun / unauthored → free the hand
    }
    ik.updateLeftHandIk?.({ target: leftTarget, dt });
    // Fresh mag rides the palm: re-apply insert base + mag-carry debug offsets
    // after the hand has solved so sliders update live on the belt→seat path.
    this._updateCarriedMagazinePose();
    // Carry (sprint): after the IK laid out the body pose, ride the gun on the
    // right hand from the frozen held transform so it stays in-hand, not floating.
    ik.applyHandCarry?.({ target: this.handIkGate.carry ? 1 : 0, dt });
    root?.updateMatrixWorld?.(true);
  }

  /**
   * Resolve the reload IK waypoints (foregrip rest, mag_socket, belt source)
   * into the shared world-space scratch. AR4 uses the authored
   * `mag_belt_source` marker, falling back only for legacy views.
   */
  _resolveReloadWaypoints(gun) {
    const anchors = this.gunView?.anchors;
    const restAnchor = anchors?.left_hand_ik_target;
    const socketAnchor = anchors?.mag_socket;
    const beltAnchor = anchors?.mag_belt_source;
    if (!restAnchor || !socketAnchor) return false;
    restAnchor.updateWorldMatrix(true, false);
    socketAnchor.updateWorldMatrix(true, false);
    restAnchor.getWorldPosition(_wpRest);
    socketAnchor.getWorldPosition(_wpSocket);
    if (!Number.isFinite(_wpSocket.x) || !Number.isFinite(_wpRest.x)) return false;
    if (beltAnchor) {
      beltAnchor.updateWorldMatrix(true, false);
      beltAnchor.getWorldPosition(_wpBelt);
    } else {
      _wpBelt.copy(_wpSocket);
      _wpBelt.y -= RELOAD_BELT_DROP;
    }
    if (!Number.isFinite(_wpBelt.x)) return false;
    return true;
  }

  /**
   * Reload path offsets are stored body-local (+X left, +Y up, +Z forward —
   * same as the chest-anchored gun hold). sampleReloadLeftHand adds them in
   * world meters, so convert with the body yaw/orientation first.
   * `extractDrop` stays world-down (pure −Y) and is not rotated.
   */
  _reloadPathOptionsInWorld(opts, bodyRoot) {
    if (!opts || !bodyRoot) return opts;
    bodyRoot.updateWorldMatrix?.(true, false);
    bodyRoot.getWorldQuaternion?.(_reloadBodyQuat);
    const map = (arr) => {
      if (!arr) return null;
      _reloadBodyOffset.set(Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0);
      if (_reloadBodyOffset.lengthSq() < 1e-12) return arr;
      _reloadBodyOffset.applyQuaternion(_reloadBodyQuat);
      return [_reloadBodyOffset.x, _reloadBodyOffset.y, _reloadBodyOffset.z];
    };
    return {
      restOffset: map(opts.restOffset),
      socketOffset: map(opts.socketOffset),
      extractOffset: map(opts.extractOffset),
      beltOffset: map(opts.beltOffset),
      handPosition: map(opts.handPosition),
      extractDrop: opts.extractDrop,
    };
  }

  /**
   * Palm orientation for the reload path: support-anchor world quat × debug
   * handRotationDeg (Euler XYZ). When debug is off, pure support orientation.
   */
  _resolveReloadLeftHandQuat(out) {
    const restAnchor = this.gunView?.anchors?.left_hand_ik_target;
    if (restAnchor) {
      restAnchor.updateWorldMatrix(true, false);
      restAnchor.getWorldQuaternion(_reloadSupportQuat);
    } else {
      _reloadSupportQuat.identity();
    }
    out.copy(_reloadSupportQuat);
    if (!reloadDebugSocket.enabled) return out;
    const [rx, ry, rz] = reloadDebugSocket.handRotationDeg || [0, 0, 0];
    if (!rx && !ry && !rz) return out;
    _reloadLeftEuler.set(
      THREE.MathUtils.degToRad(Number(rx) || 0),
      THREE.MathUtils.degToRad(Number(ry) || 0),
      THREE.MathUtils.degToRad(Number(rz) || 0),
      'XYZ',
    );
    // Scratch (not `out`) — setFromEuler then multiply onto the support pose.
    _reloadInsertQuat.setFromEuler(_reloadLeftEuler);
    out.multiply(_reloadInsertQuat);
    return out;
  }

  /**
   * After CameraSystem look input: body yaw neck clamp / forward straighten.
   */
  postCamera({ character, cameraSystem, input = null, delta = 1 / 60 }) {
    // FP-only: the third-person aim-facing yaw is owned by MovementSystem.
    if (!this.fp || !character?.group || !cameraSystem) return;
    const cam = GAME_CONFIG.camera;
    const maxNeckYaw = cam.onFootFirstPersonMaxNeckYaw ?? 0.72;
    // A visible shoulder weapon must follow the view yaw. Leaving the body at
    // the unarmed neck-limit offset aims the rifle ~40 degrees off-camera and
    // pushes the entire hold out of frame even when the clip itself is valid.
    const weaponAimLocked = Boolean(this.gunView && this.visibleWeapon);
    applyFirstPersonBodyYaw(character.group, cameraSystem.yaw, {
      maxNeckYaw,
      straighten: weaponAimLocked || isFirstPersonForwardIntent(input, character),
      delta,
      straightenSmoothing: cam.onFootFirstPersonStraightenSmoothing ?? 16,
    });
    character.fpBodyYawLocked = true;
  }

  _ensureHeadHidden(character) {
    const root = character?.animationController?.modelRoot || character?.group;
    if (!root) return;
    setHeadHidden(root, true);
    this._headHidden = true;
    // Sims / household mode parks Mara off-lot and must stay non-rendered.
    // Forcing the group visible here was re-showing her in the distance.
    if (character.group && !character.hiddenForSims) character.group.visible = true;
  }

  _restoreHead(character) {
    if (!this._headHidden) return;
    const root = character?.animationController?.modelRoot
      || character?.group
      || this._characterRef?.animationController?.modelRoot
      || this._characterRef?.group;
    if (root) setHeadHidden(root, false);
    this._headHidden = false;
  }

  /**
   * Drop gun stance flags when the firearm is no longer drawn.
   * Must run in third person too: TP keeps fpWeaponStance false while weaponClass
   * is still set for rifle/pistol loco — early-outing on fp only left sword with
   * gun movement/aim after pressing 1.
   */
  _clearOverride(character) {
    if (!character?.combat) return;
    const combat = character.combat;
    const hadGunStance = Boolean(
      combat.fpWeaponStance
      || combat.weaponClass
      || combat.aiming
      || combat.reloading,
    );
    const ov = combat.animationOverride;
    const gunOverride = Boolean(
      ov
      && (ov === this.playbackState
        || (typeof ov === 'string' && (
          ov.startsWith('armed')
          || ov.startsWith('fp_')
          || ov.startsWith('rifle_')
          || ov.startsWith('pistol_')
        ))),
    );
    if (!hadGunStance && !gunOverride) return;

    combat.fpWeaponStance = false;
    combat.weaponClass = null;
    combat.aiming = false;
    combat.reloading = false;
    if (!combat.attack && gunOverride) {
      combat.animationOverride = null;
    }
    // Sword forceDraw may already have set weapon=armed; only demote if still sheathed.
    if (combat.weapon === 'sheathed') {
      combat.armed = false;
    }
  }

  snapshot() {
    const ikMeasure = this.handIk?.measure?.() ?? null;
    return {
      active: this.active,
      locomotionKey: this.locomotionKey,
      playbackState: this.playbackState,
      spineBones: this.spineAimBones.length,
      headHidden: this._headHidden,
      gateTraversal: this.gateTraversal,
      equippedGunId: this.equippedGunId,
      weaponVisible: this.visibleWeapon,
      handIk: ikMeasure,
      handIkGate: this.handIkGate,
      scopeViewport: this.gunView?.scopeViewport
        ? {
          active: this.gunView.scopeViewport.active,
          magnification: this.gunView.scopeViewport.config?.magnification ?? null,
          resolution: this.gunView.scopeViewport.config?.resolution ?? null,
        }
        : null,
      gun: this.gunView?.gun?.snapshot?.() ?? null,
    };
  }

  dispose() {
    this._equipToken += 1;
    this.cancelReloadMagazineCycle();
    this._clearFallbackMagazine();
    this._restoreHead(this._characterRef);
    if (this.gunView) {
      this.handIk?.setWeapon(null);
      this.gunView.dispose();
      this.gunView = null;
    }
    this._teardownIk();
    this._fallbackMagazineGeometry?.dispose?.();
    this._fallbackMagazineMaterial?.dispose?.();
    this._fallbackMagazineGeometry = null;
    this._fallbackMagazineMaterial = null;
    this._characterRef = null;
    this.spineAimBones = [];
    this.equippedGunId = null;
  }
}
