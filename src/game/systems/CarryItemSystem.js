/**
 * Ground pickups the player can carry in both hands (propane tank first).
 *
 * - E / mount near a world pickup → attach to spine and enter carry pose.
 * - E again while carrying → drop at feet.
 * - After animation: tank rides the torso; hands IK onto grip markers.
 *
 * Animation layering (upper-body hold + locomotion legs) lives in
 * AnimationStateSystem via `character.carrying`.
 */

import * as THREE from 'three';
import {
  applyPropaneCarryGripDebug,
  getPropaneCarryDebugQuaternion,
  getPropaneCarryIkConfig,
  propaneCarryDebugSocket,
} from '../items/propaneCarryDebugSocket.js';

const PICKUP_REACH_M = 2.1;
const DROP_FORWARD_M = 0.55;

const _tmpPos = new THREE.Vector3();
const _dropPos = new THREE.Vector3();
const _dropQuat = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _carryQuat = new THREE.Quaternion();

export class CarryItemSystem {
  constructor() {
    /** @type {Array<object>} */
    this.worldPickups = [];
    /** @type {object|null} */
    this.held = null;
    this._scene = null;
    this._levelGroup = null;
  }

  /**
   * Bind level-authored pickups (called when the horde / level finishes loading).
   * @param {{ scene?: THREE.Scene, level?: object }} opts
   */
  bindLevel({ scene = null, level = null } = {}) {
    this.releaseHeld({ drop: false });
    this.worldPickups = [];
    this._scene = scene;
    this._levelGroup = level?.group ?? null;

    const list = level?.propaneTanks ?? level?.carryPickups ?? null;
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (entry?.group) this.worldPickups.push(entry);
      }
    }
  }

  /**
   * Pre-animation: resolve pickup / drop on interact edge.
   * Sets `character.carrying` so AnimationStateSystem can layer the hold pose.
   */
  update({ character = null, input = null, movement = null, weaponSystem = null } = {}) {
    if (!character) return;

    // mountPressed is already a one-frame edge from InputSystem (E / interact).
    const mountPressed = Boolean(input?.mountPressed);

    const busy = Boolean(
      movement?.hanging
      || movement?.wallRunning
      || movement?.wallClimbing
      || movement?.ledgeTraversing
      || movement?.rope
      || movement?.driving
      || movement?.mounting
      || movement?.sliding
      || character.vehicle
      || character.mount,
    );

    if (this.held) {
      character.carrying = true;
      character.carriedItem = this.held;
      // Soft-block sword presentation while hands are full.
      if (character.sword?.group) character.sword.group.visible = false;
      if (mountPressed && !busy) {
        this.dropHeld(character);
      }
      return;
    }

    character.carrying = false;
    character.carriedItem = null;

    if (!mountPressed || busy) return;

    const nearest = this._findNearestPickup(character.group?.position);
    if (nearest) this.pickup(nearest, character, weaponSystem);
  }

  /**
   * Post-animation: keep the held mesh on the torso and pull hands to grips.
   */
  postAnimation({
    character = null,
    firstPersonWeaponSystem = null,
    delta = 1 / 60,
  } = {}) {
    if (!this.held || !character) return;

    this._attachHeldToCharacter(character);
    this._applyCarryHandIk(character, firstPersonWeaponSystem, delta);
  }

  pickup(item, character, weaponSystem = null) {
    if (!item?.group || this.held) return false;

    // Detach from level group into the character (or scene) hierarchy.
    item.group.parent?.remove(item.group);
    item.group.visible = true;
    item.group.matrixAutoUpdate = true;
    item.group.traverse?.((obj) => {
      obj.matrixAutoUpdate = true;
      if (obj.isMesh) {
        obj.matrixAutoUpdate = true;
      }
    });

    this.held = item;
    item.held = true;
    character.carrying = true;
    character.carriedItem = item;

    // Sheathe so the great-sword socket doesn't fight two-hand carry, and so
    // AnimationStateSystem uses the carry upper-body branch instead of armed.
    if (character.combat) {
      character.combat.weapon = 'sheathed';
      character.combat.armed = false;
      character.combat.animationOverride = null;
      character.combat.attack = null;
    }
    if (character.sword?.group) character.sword.group.visible = false;
    if (weaponSystem && 'holstered' in weaponSystem) {
      weaponSystem.holstered = true;
    }

    this._attachHeldToCharacter(character);
    return true;
  }

  dropHeld(character) {
    if (!this.held) return;
    const item = this.held;
    const group = item.group;

    // Place on the ground a step in front of the player.
    // While carried, scale is inflated to cancel the Mixamo bone hierarchy
    // (~1/0.017). That MUST be reset to 1 before reparenting to the level or
    // the tank freezes at ~60× and floats above the player.
    const feet = character?.group?.position;
    const yaw = character?.group?.rotation?.y ?? 0;
    if (group) {
      if (typeof group.removeFromParent === 'function') group.removeFromParent();
      else group.parent?.remove(group);

      if (feet) {
        _dropPos.set(
          feet.x + Math.sin(yaw) * DROP_FORWARD_M,
          feet.y,
          feet.z + Math.cos(yaw) * DROP_FORWARD_M,
        );
        _dropQuat.setFromAxisAngle(_yAxis, yaw);
      } else {
        group.getWorldPosition(_dropPos);
        _dropPos.y = 0;
        _dropQuat.identity();
      }

      // Parent-null: local transform == world transform.
      group.scale.set(1, 1, 1);
      group.position.copy(_dropPos);
      group.quaternion.copy(_dropQuat);
      group.updateMatrix();

      const host = this._levelGroup ?? this._scene;
      if (host && typeof host.attach === 'function') {
        // attach() rewrites local TRS so the world pose stays put under host.
        host.attach(group);
      } else if (host) {
        host.add(group);
      }
      // Defensive: host should be unit-scale; never leave carry cancel-scale on.
      group.scale.set(1, 1, 1);
      group.updateMatrixWorld(true);
    }

    item.held = false;
    this.held = null;
    if (character) {
      character.carrying = false;
      character.carriedItem = null;
    }
  }

  releaseHeld({ drop = true } = {}) {
    if (!this.held) return;
    const item = this.held;
    item.held = false;
    if (drop && item.group) {
      if (typeof item.group.removeFromParent === 'function') item.group.removeFromParent();
      else item.group.parent?.remove(item.group);
      item.group.scale.set(1, 1, 1);
      item.group.rotation.set(0, 0, 0);
      this._levelGroup?.add(item.group);
    }
    this.held = null;
  }

  _findNearestPickup(playerPos) {
    if (!playerPos || !this.worldPickups.length) return null;
    let best = null;
    let bestDist = PICKUP_REACH_M;
    for (const item of this.worldPickups) {
      if (!item?.group || item.held || item.group.visible === false) continue;
      item.group.getWorldPosition(_tmpPos);
      // Compare on XZ; tank base sits at ground Y.
      const dx = _tmpPos.x - playerPos.x;
      const dz = _tmpPos.z - playerPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < bestDist) {
        bestDist = dist;
        best = item;
      }
    }
    return best;
  }

  _attachHeldToCharacter(character) {
    const item = this.held;
    const group = item?.group;
    if (!group) return;

    const modelRoot = character.animationController?.modelRoot;
    const spine = modelRoot?.getObjectByName?.('mixamorigSpine2')
      ?? modelRoot?.getObjectByName?.('mixamorigSpine1')
      ?? modelRoot?.getObjectByName?.('mixamorigSpine')
      ?? (typeof character.group?.add === 'function' ? character.group : null);

    if (!spine || typeof spine.add !== 'function') return;

    // Cancel inherited Mixamo bone scale (same idea as the great sword): child
    // scale = 1/parentWorldScale so the tank stays real-world metres. Local
    // position is also expressed in bone space (metres * inv). Live offsets
    // come from propaneCarryDebugSocket (debug panel "Propane Tank" folder).
    spine.updateWorldMatrix(true, false);
    const he = spine.matrixWorld.elements;
    const inherited = Math.hypot(he[0], he[1], he[2]);
    const inv = Number.isFinite(inherited) && inherited > 1e-6 ? 1 / inherited : 1;
    const midY = (item.height ?? 0.9) * 0.45;
    const dbg = propaneCarryDebugSocket;
    const ox = Number(dbg.socketPosition?.[0]) || 0;
    const oy = Number(dbg.socketPosition?.[1]) || 0;
    const oz = Number(dbg.socketPosition?.[2]) || 0;
    const scaleMul = Math.max(0.05, Number(dbg.socketScale) || 1);

    if (group.parent !== spine) {
      spine.add(group);
    }

    // Want mid-body near socketPosition in metres relative to spine.
    // worldMid = parentScale * (localPos + midY * childScale) with childScale=inv*scaleMul
    // With scaleMul≈1: localPos = (socket - (0, midY, 0)) * inv
    // Extra scaleMul grows the mesh; mid offset tracks it so the body stays centered.
    const childScale = inv * scaleMul;
    group.position.set(
      ox * inv,
      (oy - midY * scaleMul) * inv,
      oz * inv,
    );
    group.quaternion.copy(getPropaneCarryDebugQuaternion(dbg.socketRotationDeg, _carryQuat));
    group.scale.setScalar(childScale);

    // Grip markers + IK follow tank pose (arms track the grips).
    applyPropaneCarryGripDebug(item);
    group.updateMatrixWorld(true);
  }

  _applyCarryHandIk(character, firstPersonWeaponSystem, delta) {
    const item = this.held;
    if (!item?.leftGrip || !item?.rightGrip) return;

    // Prefer the shared FP/melee IK solver when available.
    const ik = firstPersonWeaponSystem?.handIk
      ?? firstPersonWeaponSystem?._ensureIk?.(character);
    if (ik?.updateMeleeHandIk) {
      const root = character.animationController?.modelRoot || character.group;
      root?.updateMatrixWorld?.(true);
      ik.updateMeleeHandIk({
        rightTarget: item.rightGrip,
        leftTarget: item.leftGrip,
        config: getPropaneCarryIkConfig(),
        dt: Number(delta) || 1 / 60,
      });
      root?.updateMatrixWorld?.(true);
    }
  }

  snapshot() {
    return {
      worldPickups: this.worldPickups.length,
      holding: Boolean(this.held),
      heldKind: this.held?.kind ?? null,
    };
  }

  dispose() {
    this.releaseHeld({ drop: false });
    for (const item of this.worldPickups) {
      item.dispose?.();
    }
    this.worldPickups = [];
    this._scene = null;
    this._levelGroup = null;
  }
}
