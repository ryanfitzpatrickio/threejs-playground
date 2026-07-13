import * as THREE from 'three';
import { createOfficeInteriorLevel } from '../../world/office/createOfficeInteriorLevel.js';
import { installInteriorEnvironment } from '../../world/office/officeInteriorEnv.js';
import { floorCountFromBuilding } from '../../world/office/generateOfficeLayout.js';
import {
  OFFICE_INTERIOR_OWNER,
  INTERIOR_BASE_Y,
  INTERIOR_SLOT_SPACING,
  INTERIOR_SLOTS_PER_ROW,
  buildingSeed,
} from '../runtimeConstants.js';
import { bindRuntimeHost } from '../bindRuntimeHost.js';

/** Office-interior session: cache, lighting suppression, enter/exit, doors, elevator. */
export class InteriorRuntimeFeature {
  constructor(host) {
    this._host = host;
    this.insideBuilding = null;
    this.screenFade = { alpha: 0 };
    this._elevatorTransition = null;
    this._interiorCache = new Map();
    this._interiorSlotCount = 0;
    return bindRuntimeHost(this, host);
  }


  _teleportPlayer(character, target, { yaw } = {}) {
    const shiftX = target.x - character.group.position.x;
    const shiftY = target.y - character.group.position.y;
    const shiftZ = target.z - character.group.position.z;
    character.group.position.set(target.x, target.y, target.z);
    if (yaw != null) {
      character.group.rotation.y = yaw;
      if (this.cameraSystem) {
        this.cameraSystem.yaw = yaw;
        this.cameraSystem.camera.rotation.set(this.cameraSystem.pitch, yaw, 0, 'YXZ');
      }
    }
    const cam = this.cameraSystem?.camera;
    if (cam) cam.position.set(cam.position.x + shiftX, cam.position.y + shiftY, cam.position.z + shiftZ);
    if (this.cameraSystem?.smoothedTarget) {
      this.cameraSystem.smoothedTarget.set(
        this.cameraSystem.smoothedTarget.x + shiftX,
        this.cameraSystem.smoothedTarget.y + shiftY,
        this.cameraSystem.smoothedTarget.z + shiftZ,
      );
    }
  }

  // Build-or-reuse the interior for a building. Built once (at a fresh slot far
  // below the map), then kept resident + hidden and cached for the session, so
  // re-entering the same building costs nothing.

  _getOrBuildInterior(building, door) {
    const key = buildingSeed(building);
    const cached = this._interiorCache.get(key);
    if (cached) return cached;

    const slot = this._interiorSlotCount;
    this._interiorSlotCount += 1;
    const origin = {
      x: (slot % INTERIOR_SLOTS_PER_ROW) * INTERIOR_SLOT_SPACING,
      y: INTERIOR_BASE_Y,
      z: Math.floor(slot / INTERIOR_SLOTS_PER_ROW) * INTERIOR_SLOT_SPACING,
    };
    const interior = createOfficeInteriorLevel({
      width: Math.max(8, door.footprint.width - 1.5),
      depth: Math.max(8, door.footprint.depth - 1.5),
      doorFacade: door.facade,
      origin,
      seed: key,
      floorCount: floorCountFromBuilding(building),
    });
    interior.group.visible = false;
    interior.slot = slot;
    this.sceneSystem.scene.add(interior.group);
    for (const collider of interior.colliders) {
      this.physicsSystem.createStaticCollider(collider, `${OFFICE_INTERIOR_OWNER}-${slot}`);
    }
    this._interiorCache.set(key, interior);
    return interior;
  }

  _enterBuilding(character) {
    const entry = this.buildingEntrySystem.state;
    const exteriorLevel = this.levelSystem.level;
    if (!entry.building || !entry.doorAnchor || !exteriorLevel || this.insideBuilding) return;

    const interior = this._getOrBuildInterior(entry.building, entry.doorAnchor);
    interior.group.visible = true;
    exteriorLevel.group.visible = false;

    this.insideBuilding = {
      interior,
      exteriorLevel,
      returnPosition: character.group.position.clone(),
      enteredAt: performance.now(),
      currentFloor: 0,
      atElevator: false,
      nearbyDoor: null,
    };
    // Facade over the interior so ground/blocking/streaming queries use it. The
    // interior's colliders already live in the physics world (below the map).
    this.levelSystem.level = interior;
    this._suppressOutdoorLighting();
    this.cameraSystem.setInteriorFirstPerson(true);
    this.rendererSystem.setSceneContext('interior');
    const spawn = interior.spawnPoint.clone();
    const groundY = interior.getGroundHeightAt(spawn, 0.28);
    spawn.y = groundY;
    // The pocket interior entrance is mirrored relative to the exterior door.
    // Turn the player/camera around so entry looks into the office, not back at
    // the interior face of the doorway.
    this._teleportPlayer(character, spawn, { yaw: interior.spawnYaw + Math.PI });
  }

  // Turn off the scene-level sun / hemisphere / sky IBL / background while inside
  // so the interior's own lights (emissive panels + hemisphere + point) read
  // instead of being washed out by the outdoor environment. Restored on exit; the
  // per-frame sky/env re-install is skipped while inside (see update()).

  _suppressOutdoorLighting() {
    const scene = this.sceneSystem.scene;
    this._savedLighting = {
      environment: scene.environment,
      environmentIntensity: scene.environmentIntensity,
      environmentRotationY: scene.environmentRotation.y,
      background: scene.background,
      fog: scene.fog,
    };
    this.sceneSystem.setSunEnabled(false);
    this.sceneSystem.setHemisphereEnabled(false);
    this.sceneSystem.skySystem?.setVisible(false);
    installInteriorEnvironment(scene, this.rendererSystem.renderer, {
      size: this.qualityPreset.environment?.environmentMapSize >= 256 ? 128 : 64,
    });
    scene.background = new THREE.Color(0x090a0d);
    scene.fog = null;
  }

  _restoreOutdoorLighting() {
    const saved = this._savedLighting;
    if (!saved) return;
    const scene = this.sceneSystem.scene;
    this.sceneSystem.setSunEnabled(true);
    this.sceneSystem.setHemisphereEnabled(true);
    this.sceneSystem.skySystem?.setVisible(true);
    scene.environment = saved.environment;
    scene.environmentIntensity = saved.environmentIntensity;
    scene.environmentRotation.y = saved.environmentRotationY;
    scene.background = saved.background;
    scene.fog = saved.fog;
    this._savedLighting = null;
    this.rendererSystem.installEnvironment(scene, this.sceneSystem.skySystem);
  }

  // True when the player is standing in the interior doorway (where the exit
  // prompt shows). The spawn point sits a step further in than this zone, so you
  // never spawn already "at the door".

  _isAtInteriorDoor(character) {
    const inside = this.insideBuilding;
    if (!inside || inside.currentFloor !== 0) return false;
    const t = inside.interior.exitTrigger;
    if (!t) return false;
    const p = character.group.position;
    return p.x >= t.minX && p.x <= t.maxX && p.z >= t.minZ && p.z <= t.maxZ;
  }

  _isAtElevator(character) {
    const inside = this.insideBuilding;
    if (!inside || inside.interior.floorCount <= 1) return false;
    const t = inside.interior.elevatorTriggers?.[inside.currentFloor];
    if (!t) return false;
    const p = character.group.position;
    return p.x >= t.minX && p.x <= t.maxX && p.z >= t.minZ && p.z <= t.maxZ;
  }

  _readElevatorFloorInput(input) {
    const inside = this.insideBuilding;
    if (!inside) return null;
    for (let i = 1; i <= 9; i += 1) {
      if (input[`elevatorFloor${i}`]) {
        const floor = i - 1;
        if (floor < inside.interior.floorCount) return floor;
      }
    }
    return null;
  }

  _startElevatorRide(character, targetFloor) {
    const inside = this.insideBuilding;
    if (!inside || targetFloor === inside.currentFloor) return;
    if (targetFloor < 0 || targetFloor >= inside.interior.floorCount) return;
    this._elevatorTransition = { phase: 'fadeOut', targetFloor, character, t: 0 };
  }

  _tickElevatorTransition(delta, character) {
    const tr = this._elevatorTransition;
    if (!tr) return;
    const fadeDur = 0.28;
    tr.t += delta;
    if (tr.phase === 'fadeOut') {
      this.screenFade.alpha = Math.min(1, tr.t / fadeDur);
      if (tr.t >= fadeDur) {
        this._completeElevatorTeleport(tr.targetFloor, tr.character ?? character);
        tr.phase = 'loading';
        tr.t = 0;
        this.screenFade.alpha = 1;

        // A lazily-built floor can have new materials/pipelines. Keep the screen
        // fully black until WebGPU finishes compiling that floor, otherwise the
        // fade reveals a partial room or stalls halfway through fading in.
        const floorGroup = this.insideBuilding?.interior?.builtFloors?.get(tr.targetFloor)?.floorGroup;
        const renderer = this.rendererSystem?.renderer;
        const camera = this.cameraSystem?.camera;
        if (renderer?.compileAsync && floorGroup && camera) {
          tr.compilePromise = renderer.compileAsync(floorGroup, camera)
            .catch(() => {})
            .finally(() => {
              if (this._elevatorTransition !== tr || tr.phase !== 'loading') return;
              tr.phase = 'fadeIn';
              tr.t = 0;
            });
        } else {
          tr.phase = 'fadeIn';
        }
      }
      return;
    }
    if (tr.phase === 'loading') {
      this.screenFade.alpha = 1;
      return;
    }
    this.screenFade.alpha = Math.max(0, 1 - tr.t / fadeDur);
    if (tr.t >= fadeDur) this._elevatorTransition = null;
  }

  _completeElevatorTeleport(targetFloor, character) {
    const inside = this.insideBuilding;
    if (!inside) return;
    const { interior } = inside;
    const slot = interior.slot ?? 0;
    const newColliders = interior.buildFloor(targetFloor);
    for (const collider of newColliders) {
      this.physicsSystem.createStaticCollider(collider, `${OFFICE_INTERIOR_OWNER}-${slot}-f${targetFloor}`);
    }
    interior.setActiveFloor(targetFloor);
    inside.currentFloor = targetFloor;
    const spawn = interior.elevatorSpawns[targetFloor]?.clone();
    if (spawn) {
      spawn.y = interior.getGroundHeightAt(spawn, 0.28);
      const yaw = interior.elevatorSpawnYaws?.[targetFloor] ?? interior.spawnYaw;
      this._teleportPlayer(character, spawn, { yaw });
    }
  }

  _exitBuilding(character) {
    const inside = this.insideBuilding;
    if (!inside) return;
    // Keep the interior resident (hidden) so re-entry is free — just swap the
    // facade back, reveal the exterior, and teleport up.
    inside.interior.group.visible = false;
    inside.exteriorLevel.group.visible = true;
    this.levelSystem.level = inside.exteriorLevel;
    this._restoreOutdoorLighting();
    this.cameraSystem.setInteriorFirstPerson(false);
    this.rendererSystem.setSceneContext('exterior');
    this._teleportPlayer(character, inside.returnPosition);
    this.insideBuilding = null;
  }

  buildingEntrySnapshot() {
    if (!this.insideBuilding) {
      return { ...this.buildingEntrySystem.snapshot(), action: 'enter' };
    }
    return {
      prompt: this.insideBuilding.atDoor === true
        || (this.insideBuilding.atElevator === true && this.insideBuilding.interior.floorCount > 1)
        || this.insideBuilding.nearbyDoor != null,
      action: this.insideBuilding.atDoor
        ? 'exit'
        : (this.insideBuilding.atElevator && this.insideBuilding.interior.floorCount > 1)
          ? 'elevator'
          : this.insideBuilding.nearbyDoor
            ? (this.insideBuilding.nearbyDoor.door.open ? 'close-door' : 'open-door')
            : null,
      floor: this.insideBuilding.currentFloor,
      floorCount: this.insideBuilding.interior.floorCount,
    };
  }

}
