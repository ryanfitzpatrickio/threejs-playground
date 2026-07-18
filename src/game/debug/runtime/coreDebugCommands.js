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

/** Domain debug commands for __DREAMFALL_DEBUG__. @param {object} rt */
export function createCoreDebugCommands(rt) {
  return createCommands.call(rt);
}

function createCommands() {
  return {
    snapshot: () => this.snapshot(),
    getScene: () => this.sceneSystem?.scene,
    getThree: () => THREE,
    getCamera: () => this.cameraSystem?.camera,
    getCharacter: () => this.characterSystem?.character,
    getLevelHandles: () => ({
      colliderIndex: this.levelSystem?.level?.colliderIndex ?? null,
      colliders: this.levelSystem?.level?.colliders ?? null,
      geometryIndex: this.levelSystem?.level?.geometryIndex ?? null,
      mudField: this.levelSystem?.mudField ?? this.levelSystem?.level?.mudField ?? null,
      hordeSpawnPoints: this.levelSystem?.level?.hordeSpawnPoints ?? null,
      levelName: this.levelSystem?.level?.name ?? null,
      levelMode: this.levelMode,
    }),
    spawnHordeEnemies: (opts) => this.spawnHordeEnemies(opts ?? {}),
    ensureHordePlaygroundReady: () => this.ensureHordePlaygroundReady(),
    isHordePlaygroundActive: () => this.isHordePlaygroundActive(),
    spawnHordeBenchmark: (opts) => this.spawnHordeBenchmark(opts ?? {}),
    sampleHordeBenchmark: () => this.sampleHordeBenchmark(),
    fillHordeToPreset: (id, opts) => this.fillHordeToPreset(id, opts ?? {}),
    fillHordeToCount: (count, opts) => this.fillHordeToCount(count, opts ?? {}),
    applyHordeSpectaclePreset: (id) => this.applyHordeSpectaclePreset(id),
    applyHordeExplosion: (opts) => this.applyHordeExplosion(opts ?? {}),
    propaneTanks: () => this.propaneTankSystem?.snapshot?.() ?? { enabled: false },
    ignitePropaneTank: ({ id = null } = {}) => this.propaneTankSystem?.igniteTank?.(
      id,
      this.characterSystem?.character?.group?.position ?? null,
    ) ?? { ok: false, reason: 'no-system' },
    detonatePropaneTank: ({ id = null } = {}) => this.propaneTankSystem?.detonateTank?.(
      id,
      this.characterSystem?.character?.group?.position ?? null,
    ) ?? { ok: false, reason: 'no-system' },
    spawnPropaneTank: ({ x = null, y = null, z = null, seed = Date.now() } = {}) => {
      const player = this.characterSystem?.character?.group?.position;
      return this.propaneTankSystem?.spawnTank?.({
        x: Number.isFinite(x) ? x : (player?.x ?? 0) + 1.5,
        y: Number.isFinite(y) ? y : player?.y ?? 0,
        z: Number.isFinite(z) ? z : player?.z ?? 0,
        seed,
      }) ?? { ok: false, reason: 'no-system' };
    },
    clearHordeEnemies: () => this.clearHordeEnemies(),
    applyHordeHealthScale: () => this.applyHordeHealthScale(),
    hordeScaleSnapshot: () => this.hordeScaleSnapshot(),
    /** Mall LightProbeGrid GI status (docs/horde-gi-plan.md). */
    getHordeGi: () => this.hordeGi?.getSnapshot?.() ?? { status: 'none', hint: 'not horde or GI not constructed' },
    setHordeGiHelper: (on = true) => this.hordeGi?.setHelperVisible?.(Boolean(on))
      ?? { ok: false, reason: 'no-horde-gi' },
    setHordeGiEnabled: (on = true) => this.hordeGi?.setContribEnabled?.(Boolean(on))
      ?? { ok: false, reason: 'no-horde-gi' },
    setHordeGiIntensity: (v = 1) => this.hordeGi?.setIntensity?.(v)
      ?? { ok: false, reason: 'no-horde-gi' },
    rebakeHordeGi: () => {
      this.hordeGi?.rebake?.();
      return this.hordeGi?.getSnapshot?.() ?? { ok: false, reason: 'no-horde-gi' };
    },
    getHordeDebug: () => ({
      ...(this.enemySystem?.behaviorMods ?? {}),
      enemyCount: this._hordeVisibleEnemyCount(),
      ...this.hordeScaleSnapshot(),
      gi: this.hordeGi?.getSnapshot?.() ?? null,
      levelMode: this.levelMode,
      playgroundReady: this.isHordePlaygroundActive(),
      proxyReady: this.hordeProxySystem?.ready === true,
      navMesh: this.hordeProxySystem?.snapshot?.()?.navMesh ?? null,
    }),
    setHordeNavMeshVisible: async (visible = true) => {
      const scene = this.sceneSystem?.scene;
      const result = await this.hordeProxySystem?.setNavMeshDebugVisible?.(
        Boolean(visible),
        scene,
      );
      return result ?? { ok: false, reason: 'no-proxy-system' };
    },
    projectHordeNav: ({ x, z, y = 0 } = {}) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        return { ok: false, reason: 'need-x-z' };
      }
      return this.hordeProxySystem?.projectToNav?.(x, z, y)
        ?? { ok: false, reason: 'no-proxy-system' };
    },
    dumpMudRuts: () => this._mudRutsSnapshot(),
    forceMudRut: (depth = 0.18, radius = 0.45) => {
      const field = this.levelSystem?.mudField ?? this.levelSystem?.level?.mudField ?? null;
      if (!field) return { ok: false, error: 'no mudField (need rally + surface mud/wet)' };
      const focus = this.vehicleSystem?.activeVehicle?.group?.position
        ?? this.characterSystem?.character?.group?.position;
      if (!focus) return { ok: false, error: 'no focus position' };
      field.setCenter(focus.x, focus.z);
      // Dual wheel lines + centreline so a sample under the car is non-zero.
      const yaw = this.cameraSystem?.yaw ?? 0;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = -fz;
      const rz = fx;
      for (const side of [-0.75, 0, 0.75]) {
        for (let s = -1.5; s <= 4; s += 0.35) {
          field.stampBrush(
            focus.x + fx * s + rx * side,
            focus.z + fz * s + rz * side,
            radius,
            {
              depth,
              wetness: 0.95,
              tread: 1,
              directionX: fx,
              directionZ: fz,
              kind: 'vehicle',
            },
          );
        }
      }
      field.ensureTexture();
      field.syncTexture();
      return { ok: true, ...this._mudRutsSnapshot() };
    },
    probeGround: (x, y, z, radius = 0.5) => this.levelSystem
      ?.getGroundHeightAt(new THREE.Vector3(x, y, z), radius),
    resetFrameStats: () => {
      this.frameStats.reset();
      return this.snapshot();
    },
    setRenderCap60: (enabled) => this.setRenderCap60(enabled),
    setTimingHud: (enabled) => {
      this.showTimingHud = Boolean(enabled);
      return this.snapshot();
    },
    setTimeOfDay: (timeOfDay) => {
      if (this.sceneSystem.skySystem) {
        this.sceneSystem.skySystem.dynamicDay = false;
        this.sceneSystem.skySystem.setTimeOfDay(timeOfDay);
      }
      this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
      return this.snapshot();
    },
    sceneStats: () => {
      const scene = this.sceneSystem?.scene;
      const tally = Object.create(null);
      let totalMeshes = 0;
      let totalTriangles = 0;
      if (scene) {
        scene.traverse((child) => {
          if (!child.isMesh) return;
          totalMeshes += 1;
          const geom = child.geometry;
          const triCount = geom?.index
            ? geom.index.count / 3
            : (geom?.attributes?.position?.count ?? 0) / 3;
          totalTriangles += triCount;
          // Bucket by the leading capitalized words of the name ("Merged Skyscrapers X" → "Merged Skyscrapers").
          const base = (child.name || '<unnamed>').replace(/\s*[\d\w-]*$/,'');
          const key = base.trim() || child.name || '<unnamed>';
          const entry = tally[key] ?? (tally[key] = { meshes: 0, triangles: 0 });
          entry.meshes += 1;
          entry.triangles += triCount;
        });
      }
      return { totalMeshes, totalTriangles: Math.round(totalTriangles), tally };
    },
    furnitureStats: () => this.levelSystem?.level?.cityChunks
      ? this.snapshot().level?.city?.furniture ?? null
      : null,
    startAllocationSample: (durationMs = 3000) => this.allocationSampler.start(durationMs),
    stopAllocationSample: () => this.allocationSampler.stop(),
    allocationSampleReport: () => this.allocationSampler.report(),
    sceneChunks: () => {
      const scene = this.sceneSystem?.scene;
      const out = [];
      if (scene) {
        scene.traverse((child) => {
          if (!child.name?.startsWith('Generator City Chunk')) return;
          out.push({
            name: child.name,
            meshes: child.children
              .filter((c) => c.isMesh || c.isInstancedMesh)
              .map((c) => ({ name: c.name, tris: c.geometry?.index ? c.geometry.index.count / 3 : (c.geometry?.attributes?.position?.count ?? 0) / 3 })),
          });
        });
      }
      return out;
    },
    setCollisionDebugVisible: (visible) => {
      this.levelSystem.setCollisionDebugVisible(visible);
      return this.snapshot();
    },
    toggleCollisionDebug: () => {
      this.levelSystem.toggleCollisionDebug();
      return this.snapshot();
    },
    setShadows: (enabled) => {
      const on = Boolean(enabled);
      if (this.rendererSystem.renderer?.shadowMap) {
        this.rendererSystem.renderer.shadowMap.enabled = on;
      }
      if (this.sceneSystem?.sun) {
        this.sceneSystem.sun.castShadow = on;
      }
      // Toggling shadowMap.enabled recompiles every node-material pipeline;
      // re-prime the horde proxy instance bindings so they rebuild at full
      // capacity instead of the current (small) live count.
      this.hordeProxySystem?.markPipelinesDirty?.();
      return this.snapshot();
    },
    setWorldZoneOverlay: (enabled) => {
      const visible = Boolean(enabled);
      this.sceneSystem?.scene?.traverse?.((object) => {
        if (object.userData?.worldZoneOverlay === true) {
          object.visible = visible;
        }
      });
      return this.snapshot();
    },
    setSun: (enabled) => this.sceneSystem.setSunEnabled(Boolean(enabled)),
    setHemisphere: (enabled) => this.sceneSystem.setHemisphereEnabled(Boolean(enabled)),
    setBladeDebug: (enabled) => {
      const combat = this.combatSystem;
      if (!combat) return this.snapshot();
      combat._bladeDebugEnabled = Boolean(enabled);
      if (!combat._bladeDebugEnabled) combat._clearBladeDebug?.();
      return this.snapshot();
    },
    setPlayerHands: (boneNameOrOptions = {}, options = {}) => {
      this.mountSystem.setRiderGrip(normalizeGripCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    setplayerhands: (boneNameOrOptions = {}, options = {}) => {
      this.mountSystem.setRiderGrip(normalizeGripCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    adjustPlayerHands: (boneNameOrOptions = {}, options = {}) => {
      this.mountSystem.adjustRiderGrip(normalizeGripCommandOptions(boneNameOrOptions, options));
      return this.snapshot();
    },
    resetPlayerHands: () => {
      this.mountSystem.resetRiderGrip();
      return this.snapshot();
    },
    placeCharacter: ({ position, velocity, verticalVelocity, grounded } = {}) => {
      const character = this.characterSystem.character;

      if (!character) {
        return this.snapshot();
      }

      if (position) {
        character.group.position.set(
          Number.isFinite(position.x) ? position.x : character.group.position.x,
          Number.isFinite(position.y) ? position.y : character.group.position.y,
          Number.isFinite(position.z) ? position.z : character.group.position.z,
        );
      }

      if (velocity) {
        character.velocity.set(
          Number.isFinite(velocity.x) ? velocity.x : character.velocity.x,
          Number.isFinite(velocity.y) ? velocity.y : character.velocity.y,
          Number.isFinite(velocity.z) ? velocity.z : character.velocity.z,
        );
      }

      if (Number.isFinite(verticalVelocity)) {
        character.verticalVelocity = verticalVelocity;
      }

      if (typeof grounded === 'boolean') {
        character.grounded = grounded;
      }

      character.hang = null;
      character.mount = null;
      character.wallRun = null;
      character.wallClimb = null;
      character.rope = null;
      character.hookSwing = null;
      character.vault = null;
      character.vehicle = null;
      character.traversalAction = null;
      return this.snapshot();
    },
    startRallyCinematicDemo: () => this.startRallyCinematicDemo(),
    stopRallyCinematicDemo: () => this.stopRallyCinematicDemo(),
    toggleRallyCinematicDemo: () => this.toggleRallyCinematicDemo(),
  };
}
