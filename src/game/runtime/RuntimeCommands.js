import {
  cycleCameraFeel,
  getCameraFeel,
  getComfortEnabled,
  getOnFootFirstPerson,
  setCameraFeel,
  setComfortEnabled,
  setOnFootFirstPerson,
} from '../config/cameraComfort.js';
import { bindRuntimeHost } from './bindRuntimeHost.js';

/** UI-facing command surface (photo, camera, cloth, loadout, rally cinematic). */
export class RuntimeCommands {
  constructor(host) {
    this._host = host;

    return bindRuntimeHost(this, host);
  }


  setRenderCap60(enabled) {
    this.renderCap60 = Boolean(enabled);
    this.renderRateLimiter.reset();
    return this.snapshot();
  }

  setPhotoMode(enabled) {
    this.cameraSystem.setPhotoMode(enabled);
    if (enabled && document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.();
    }
    this.emitSnapshot();
  }

  setPhotoModeLive(enabled) {
    this.cameraSystem.setPhotoModeLive(enabled);
    this.emitSnapshot(performance.now(), { force: true });
  }

  /**
   * Player control lock for live photo mode: free-fly owns look/WASD, while
   * physics, animation, hand IK, and an explicit weapon reload still advance.
   */

  _photoModeLockedInput(input) {
    return {
      ...input,
      moveX: 0,
      moveZ: 0,
      forward: false,
      backward: false,
      left: false,
      right: false,
      lookX: 0,
      lookY: 0,
      zoomDelta: 0,
      jump: false,
      jumpPressed: false,
      jumpReleased: false,
      jumpDoubleTapped: false,
      wallRunJump: false,
      brace: false,
      bracePressed: false,
      slide: false,
      slidePressed: false,
      leftPressed: false,
      rightPressed: false,
      lightAttackPressed: false,
      heavyAttackPressed: false,
      mousePrimaryHeld: false,
      mouseSecondaryHeld: false,
      mouseMiddleHeld: false,
      mouseMiddlePressed: false,
      drawSheathePressed: false,
      grabSlamPressed: false,
      // R remains a weapon-only action in live camera mode: reload survives,
      // while its normal unarmed shoulder-throw alias stays locked.
      reloadPressed: Boolean(input?.reloadPressed || input?.shoulderThrowPressed),
      shoulderThrowPressed: false,
      cutModePressed: false,
      cutModeReleased: false,
      cutCommitPressed: false,
      cutCancelPressed: false,
      telekinesisPressed: false,
      telekinesisReleased: false,
      telekinesisHeld: false,
      hookFire: false,
      hookFirePressed: false,
      hookAimHeld: false,
      abilityPressed: false,
      abilityHeld: false,
      abilityDoubleTapped: false,
      wingsuitTogglePressed: false,
      wingsuitHeld: false,
      rearViewHeld: false,
      dodgeDirection: null,
      mountPressed: false,
      crouchHeld: false,
      leanLeftHeld: false,
      leanRightHeld: false,
      inspectHeld: false,
      gunSlotPressed: null,
    };
  }

  startRallyCinematicDemo() {
    if (this.levelMode !== 'rally') {
      console.warn('[rally-cinematic] only available in rally mode');
      return this.snapshot();
    }
    if (this.rallyCinematicDemo.active) {
      return this.snapshot();
    }
    const vehicle = this.vehicleSystem?.activeVehicle;
    if (!vehicle) {
      console.warn('[rally-cinematic] enter a vehicle first');
      return this.snapshot();
    }
    const ok = this.rallyCinematicDemo.start({
      vehicle,
      level: this.levelSystem,
      physics: this.physicsSystem,
      camera: this.cameraSystem.camera,
    });
    if (ok) {
      this.vehicleSystem.cinematicDemoActive = true;
      if (document.pointerLockElement === this.canvas) {
        document.exitPointerLock?.();
      }
      this.emitSnapshot();
    } else {
      console.warn('[rally-cinematic] failed to build track cameras');
    }
    return this.snapshot();
  }

  stopRallyCinematicDemo() {
    if (!this.rallyCinematicDemo.active) {
      return this.snapshot();
    }
    this.rallyCinematicDemo.stop();
    this.vehicleSystem.cinematicDemoActive = false;
    if (this.vehicleSystem.activeVehicle) {
      delete this.vehicleSystem.activeVehicle.autopilot;
    }
    this.emitSnapshot();
    return this.snapshot();
  }

  toggleRallyCinematicDemo() {
    if (this.rallyCinematicDemo.active) {
      return this.stopRallyCinematicDemo();
    }
    return this.startRallyCinematicDemo();
  }

  setPhotoSetting(name, value) {
    this.cameraSystem.setPhotoSetting(name, value);
    this.emitSnapshot();
  }

  cycleVehicleCameraMode() {
    if (!this.vehicleSystem?.activeVehicle) {
      return this.snapshot();
    }
    this.cameraSystem.cycleVehicleCameraMode();
    this.emitSnapshot();
    return this.snapshot();
  }

  setVehicleCameraMode(mode) {
    this.cameraSystem.setVehicleCameraMode(mode);
    this.emitSnapshot();
    return this.snapshot();
  }

  setCameraComfortEnabled(enabled) {
    setComfortEnabled(Boolean(enabled));
    this.cameraSystem.setComfortOptions({
      enabled: getComfortEnabled(),
      feel: getCameraFeel(),
    });
    this.emitSnapshot();
    return this.snapshot();
  }

  setCameraFeel(feel) {
    const normalized = setCameraFeel(feel);
    this.cameraSystem.setComfortOptions({
      enabled: getComfortEnabled(),
      feel: normalized,
    });
    this.emitSnapshot();
    return this.snapshot();
  }

  setOnFootFirstPersonEnabled(enabled) {
    setOnFootFirstPerson(Boolean(enabled));
    this.cameraSystem.setOnFootFirstPerson(getOnFootFirstPerson());
    this.emitSnapshot();
    return this.snapshot();
  }

  setWeaponShakeScale(value) {
    this.cameraSystem.setWeaponShakeScale(value);
    this.emitSnapshot();
    return this.snapshot();
  }

  /** Equip a catalog gun immediately (debug pane / console) and draw it. */

  async equipGun(gunId) {
    this.weaponSystem.equipAndDraw(gunId, {
      character: this.characterSystem.character,
      combatSystem: this.combatSystem,
      firstPersonWeaponSystem: this.firstPersonWeaponSystem,
    });
    const view = await this.firstPersonWeaponSystem.equipGun(gunId);
    this.emitSnapshot();
    return view?.id ?? null;
  }

  /** Equip sword or gun by loadout id (debug). Holstered stays as-is unless draw=true. */

  equipWeapon(weaponId, { draw = true } = {}) {
    if (draw) {
      this.weaponSystem.equipAndDraw(weaponId, {
        character: this.characterSystem.character,
        combatSystem: this.combatSystem,
        firstPersonWeaponSystem: this.firstPersonWeaponSystem,
      });
    } else {
      this.weaponSystem.equip(weaponId);
      this.weaponSystem.processLoadout({
        input: { zoomDelta: 0, drawSheathePressed: false },
        character: this.characterSystem.character,
        combatSystem: this.combatSystem,
        firstPersonWeaponSystem: this.firstPersonWeaponSystem,
      });
    }
    this.emitSnapshot();
    return this.weaponSystem.equippedId;
  }

  /** Equip a traversal ability (swing / wingsuit). */

  equipAbility(abilityId) {
    const id = this.abilitySystem.equip(abilityId);
    this.emitSnapshot();
    return id;
  }

  cycleAbility(dir = 1) {
    const id = this.abilitySystem.cycle(dir);
    this.emitSnapshot();
    return id;
  }

  cycleCameraFeel() {
    const next = cycleCameraFeel(getCameraFeel());
    return this.setCameraFeel(next);
  }

  getClothColliderEditorSnapshot() {
    return this.characterSystem.character?.clothColliderEditor?.snapshot?.() ?? null;
  }

  setClothColliderEditorEnabled(enabled) {
    if (enabled && document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.();
    }
    const snapshot = this.characterSystem.character?.clothColliderEditor?.setEnabled?.(enabled) ?? null;
    this.emitSnapshot();
    return snapshot;
  }

  selectClothCollider(id) {
    const snapshot = this.characterSystem.character?.clothColliderEditor?.select?.(id) ?? null;
    this.emitSnapshot();
    return snapshot;
  }

  addClothCollider(spec) {
    const snapshot = this.characterSystem.character?.clothColliderEditor?.add?.(spec) ?? null;
    this.emitSnapshot();
    return snapshot;
  }

  updateClothCollider(id, patch) {
    const snapshot = this.characterSystem.character?.clothColliderEditor?.update?.(id, patch) ?? null;
    this.emitSnapshot();
    return snapshot;
  }

  updateJacketSocketTransform(patch) {
    const snapshot = this.characterSystem.character?.clothColliderEditor?.updateJacketTransform?.(patch) ?? null;
    this.emitSnapshot();
    return snapshot;
  }

  removeClothCollider(id) {
    const snapshot = this.characterSystem.character?.clothColliderEditor?.remove?.(id) ?? null;
    this.emitSnapshot();
    return snapshot;
  }

  async resetJacketCloth() {
    const snapshot = await this.characterSystem.character?.clothColliderEditor?.resetCloth?.();
    this.emitSnapshot();
    return snapshot ?? null;
  }

  importClothColliderProfile(profile) {
    const snapshot = this.characterSystem.character?.clothColliderEditor?.importProfile?.(profile) ?? null;
    this.emitSnapshot();
    return snapshot;
  }

  exportClothColliderProfile() {
    return this.characterSystem.character?.clothColliderEditor?.exportProfile?.() ?? null;
  }

}
