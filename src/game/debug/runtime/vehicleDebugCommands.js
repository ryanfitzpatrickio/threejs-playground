import * as THREE from 'three';
import {
  getShaderDebugSnapshot,
  applyShaderDebugSnapshot,
  clearOverridesForFolders,
  clearAllUserOverrides,
  clearLutDirty,
} from '../shaderDebugRegistry.js';
import { setPhotorealismPresetId } from '../../config/photorealismPresets.js';
import {
  findChassisDebugVehicle,
  normalizeHorseBoneCommandOptions,
  normalizeSaddleCommandOptions,
  normalizeGripCommandOptions,
  vectorFromObject,
  riderTransformEuler,
  riderBoneDump,
} from '../../runtime/runtimeHelpers.js';
import { buildLimbSeverPlane } from '../../systems/soldierPartialCut.js';
import { BaseVehicle } from '../../vehicles/BaseVehicle.js';

/** Domain debug commands for __DREAMFALL_DEBUG__. @param {object} rt */
export function createVehicleDebugCommands(rt) {
  return createCommands.call(rt);
}

function createCommands() {
  return {
    vehicleJumpDiag: (enabled = true, threshold = 0.25) => {
      this._jumpDiagEnabled = enabled !== false;
      this._jumpDiagThreshold = threshold;
      if (this._jumpDiagEnabled) {
        this._jumpDiagLog = [];
        this._jumpDiagPrevVy = null;
      }
      return { recording: this._jumpDiagEnabled, threshold: this._jumpDiagThreshold };
    },
    dumpVehicleJumpDiag: () => {
      const log = this._jumpDiagLog ?? [];
      // Inter-event gaps (s) reveal a fixed interval (timing) vs irregular (terrain).
      const gaps = [];
      for (let i = 1; i < log.length; i += 1) gaps.push(+(log[i].t - log[i - 1].t).toFixed(2));
      const streamingHits = log.filter((e) => e.streaming).length;
      const longFrameHits = log.filter((e) => e.frameMs > 22).length;
      const snapshotHits = log.filter((e) => e.willSnapshot).length;
      return {
        events: log.length,
        gapsSec: gaps,
        // Correlations: which context accompanies the jumps.
        onStreamingFrames: streamingHits,
        onLongFrames_gt22ms: longFrameHits,
        onSnapshotFrames: snapshotHits,
        log,
      };
    },
    getVehicleChassis: (vehicleId) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, vehicleId);
      return vehicle?.getChassisOverlayTransform?.() ?? { error: 'vehicle chassis overlay not ready' };
    },
    setVehicleChassis: (options = {}) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, options.vehicleId);
      if (!vehicle) return { error: 'vehicle chassis overlay not ready' };
      return vehicle.setChassisOverlayTransform(options);
    },
    adjustVehicleChassis: (options = {}) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, options.vehicleId);
      if (!vehicle) return { error: 'vehicle chassis overlay not ready' };
      return vehicle.adjustChassisOverlayTransform(options);
    },
    resetVehicleChassis: (vehicleId) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, vehicleId);
      if (!vehicle) return { error: 'vehicle chassis overlay not ready' };
      return vehicle.resetChassisOverlayTransform();
    },
    getVehicleFrame: (vehicleId) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, vehicleId);
      return vehicle?.getFrameParameters?.() ?? { error: 'vehicle frame not ready' };
    },
    setVehicleFrame: (options = {}) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, options.vehicleId);
      if (!vehicle) return { error: 'vehicle frame not ready' };
      return vehicle.setFrameParameters(options, this.physicsSystem);
    },
    adjustVehicleFrame: (options = {}) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, options.vehicleId);
      if (!vehicle) return { error: 'vehicle frame not ready' };
      return vehicle.adjustFrameParameters(options, this.physicsSystem);
    },
    resetVehicleFrame: (vehicleId) => {
      const vehicle = findChassisDebugVehicle(this.vehicleSystem, vehicleId);
      if (!vehicle) return { error: 'vehicle frame not ready' };
      return vehicle.resetFrameParameters(this.physicsSystem);
    },
    spawnVehicle: async ({ domain = 'ground', config = {}, ahead = 5 } = {}) => {
      const character = this.characterSystem.character;
      if (!character || this.vehicleSystem.status !== 'ready') {
        return { error: 'vehicle system not ready', snapshot: this.snapshot() };
      }
      const yaw = character.group.rotation.y ?? 0;
      const position = new THREE.Vector3(
        character.group.position.x - Math.sin(yaw) * ahead,
        character.group.position.y,
        character.group.position.z - Math.cos(yaw) * ahead,
      );
      const vehicle = new BaseVehicle({ domain, config, position, rotationY: yaw });
      await this.vehicleSystem.spawnVehicle({ vehicle });
      return this.snapshot();
    },
    diagnoseVehicleSpawn: ({ ahead = 5 } = {}) => {
      const character = this.characterSystem.character;
      if (!character) return { error: 'no character' };
      const yaw = character.group.rotation.y ?? 0;
      const pos = new THREE.Vector3(
        character.group.position.x - Math.sin(yaw) * ahead,
        character.group.position.y,
        character.group.position.z - Math.cos(yaw) * ahead,
      );
      const ground0 = this.levelSystem.getGroundHeightAt(pos, 0);
      const groundMax = this.levelSystem.getGroundHeightAt(pos, 2.1);
      // Cast straight down through the spawn column to find the real collider top.
      const physics = this.physicsSystem;
      let colliderTopY = null;
      let hasCollider = false;
      if (physics?.world && physics?.RAPIER) {
        const from = { x: pos.x, y: pos.y + 300, z: pos.z };
        const ray = new physics.RAPIER.Ray(from, { x: 0, y: -1, z: 0 });
        const hit = physics.world.castRay(ray, 2000, true);
        if (hit) {
          hasCollider = true;
          colliderTopY = from.y - hit.timeOfImpact;
        }
      }
      return {
        player: {
          x: +character.group.position.x.toFixed(2),
          y: +character.group.position.y.toFixed(2),
          z: +character.group.position.z.toFixed(2),
        },
        spawn: { x: +pos.x.toFixed(2), z: +pos.z.toFixed(2) },
        analyticGround0: ground0 == null ? null : +ground0.toFixed(2),
        analyticGroundMax: groundMax == null ? null : +groundMax.toFixed(2),
        hasColliderUnderSpawn: hasCollider,
        colliderTopY: colliderTopY == null ? null : +colliderTopY.toFixed(2),
        // The tell: if hasCollider is false, the car falls forever (no terrain
        // heightfield streamed here). If analyticGround0 sits far ABOVE
        // colliderTopY, the snap floats the car and it drops.
        analyticMinusCollider:
          colliderTopY == null ? null : +(ground0 - colliderTopY).toFixed(2),
        physicsStatus: physics?.status ?? null,
        staticBodies: physics?.snapshot?.()?.staticBodies ?? null,
        // Owner-key census: terrain heightfields are owner-keyed 't:cx:cz'. If
        // terrainOwners is 0, terrain heightfields are NEVER built in this scene
        // (a wiring problem); if >0 but none near the spawn, they stream but the
        // spawn chunk's build was missed/removed.
        terrainOwners: physics?.staticBodiesByOwner
          ? [...physics.staticBodiesByOwner.keys()].filter((k) => String(k).startsWith('t:')).length
          : null,
        playerChunk: (() => {
          const cs = 32; // TERRAIN_PARAMS.chunkSize
          const cw = (v) => Math.floor((v + cs * 0.5) / cs);
          return `t:${cw(character.group.position.x)}:${cw(character.group.position.z)}`;
        })(),
        terrainOwnerKeys: physics?.staticBodiesByOwner
          ? [...physics.staticBodiesByOwner.keys()].filter((k) => String(k).startsWith('t:')).sort()
          : null,
      };
    },
    enterVehicleByName: async (name) => {
      const character = this.characterSystem.character;
      const target = this.vehicleSystem.vehicles.find((vehicle) => vehicle.name === name);
      if (!character || !target) return { entered: false, error: 'vehicle not found' };
      if (this.vehicleSystem.activeVehicle) {
        this.vehicleSystem._exit({ character, level: this.levelSystem });
      }
      const entered = await this.vehicleSystem.enterVehicle(character, target);
      return {
        entered,
        vehicleKind: target.vehicleKind ?? 'car',
        animationState: character.vehicle?.animationState ?? null,
        handTargets: Boolean(character.vehicle?.handTargets?.left && character.vehicle?.handTargets?.right),
        footTargets: Boolean(character.vehicle?.footTargets?.left && character.vehicle?.footTargets?.right),
      };
    },
  };
}
