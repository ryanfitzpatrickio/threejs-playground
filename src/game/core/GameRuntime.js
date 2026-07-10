import * as THREE from 'three';
import { rainWind } from '../systems/weatherUniforms.js';
import { syncTerrainViewDistance, syncTerrainAtmosphereFromSky } from '../systems/terrainAerialUniforms.js';
import { syncTerrainCloudShadow } from '../systems/terrainCloudShadowUniforms.js';
import { syncCloudReach } from '../render/cloud/cloudReachUniforms.js';
import { advanceTerrainParallaxWind, syncTerrainParallaxOffset } from '../systems/terrainParallaxUniforms.js';
import { FrameStats } from './FrameStats.js';
import { FrameLoop } from './FrameLoop.js';
import { AllocationSampler } from './AllocationSampler.js';
import { RenderRateLimiter } from './RenderRateLimiter.js';
import { AnimationStateSystem } from '../systems/AnimationStateSystem.js';
import { CameraSystem } from '../systems/CameraSystem.js';
import { CharacterSystem } from '../systems/CharacterSystem.js';
import { resolveJacketMode } from '../characters/mara/jacketConfig.js';
import { CombatSystem } from '../systems/CombatSystem.js';
import { FirstPersonWeaponSystem } from '../systems/FirstPersonWeaponSystem.js';
import { WeaponSystem } from '../systems/WeaponSystem.js';
import { ShootingRangeSystem } from '../systems/ShootingRangeSystem.js';
import { defaultGunIdFromQuery } from '../weapons/loadGunView.js';
import { EnemySystem } from '../systems/EnemySystem.js';
import { CrowdSystem } from '../systems/CrowdSystem.js';
import { EnemyCutSystem } from '../systems/EnemyCutSystem.js';
import { DestructiblePropSystem } from '../systems/DestructiblePropSystem.js';
import { HorseSystem, HORSE_GROUND_OFFSET } from '../systems/HorseSystem.js';
import { InputSystem } from '../systems/InputSystem.js';
import { LevelSystem } from '../systems/LevelSystem.js';
import { BuildingEntrySystem } from '../systems/BuildingEntrySystem.js';
import { createOfficeInteriorLevel } from '../world/office/createOfficeInteriorLevel.js';
import { installInteriorEnvironment } from '../world/office/officeInteriorEnv.js';
import { installRangeEnvironment } from '../world/installRangeEnvironment.js';
import { floorCountFromBuilding } from '../world/office/generateOfficeLayout.js';
import { LedgeHangSystem } from '../systems/LedgeHangSystem.js';
import { LedgeTraversalSystem } from '../systems/LedgeTraversalSystem.js';
import { MovementSystem } from '../systems/MovementSystem.js';
import { MountSystem } from '../systems/MountSystem.js';
import { PlayerDamageSystem } from '../systems/PlayerDamageSystem.js';
import { PhysicsSystem, PHYSICS_FIXED_STEP, VEHICLE_PHYSICS_FIXED_STEP } from '../systems/PhysicsSystem.js';
import { RendererSystem } from '../systems/RendererSystem.js';
import { RopeSystem } from '../systems/RopeSystem.js';
import { SceneSystem } from '../systems/SceneSystem.js';
import { SlideSystem } from '../systems/SlideSystem.js';
import { TraversalRouterSystem } from '../systems/TraversalRouterSystem.js';
import { VaultSystem } from '../systems/VaultSystem.js';
import { WallClimbSystem } from '../systems/WallClimbSystem.js';
import { WallRunSystem } from '../systems/WallRunSystem.js';
import { TelekinesisSystem } from '../systems/TelekinesisSystem.js';
import { HookSwingSystem } from '../systems/HookSwingSystem.js';
import { WingsuitSystem } from '../systems/WingsuitSystem.js';
import { WingsuitFlightSystem } from '../systems/WingsuitFlightSystem.js';
import { AbilitySystem } from '../systems/AbilitySystem.js';
import { RallyCinematicDemo } from '../systems/RallyCinematicDemo.js';
import { VehicleSystem } from '../systems/VehicleSystem.js';
import { VehicleDamageSystem } from '../systems/VehicleDamageSystem.js';
import { WeatherSystem } from '../systems/WeatherSystem.js';
import { computeRunOverHits, computeRunOverLaunch } from '../vehicles/runOver.js';
import { BaseVehicle } from '../vehicles/BaseVehicle.js';
import { QuadBikeVehicle } from '../vehicles/QuadBikeVehicle.js';
import { spawnVehicleOptions } from '../vehicles/garageBuilds.js';
import { getActiveWorldMapSync } from '../../world/worldMap/worldMapScenes.js';
import { sanitizeWebGPUVertexBuffers } from '../geometry/prepareWebGPUGeometry.js';
import { applyCityLevelOverrides } from '../config/cityPerformance.js';
import { applyRangeLevelOverrides } from '../config/rangePerformance.js';
import {
  getPhotorealismPresetId,
  mergePhotorealismEnvironment,
  setPhotorealismPresetId,
} from '../config/photorealismPresets.js';
import {
  getShaderDebugSnapshot,
  applyShaderDebugSnapshot,
  clearOverridesForFolders,
  clearAllUserOverrides,
  clearLutDirty,
} from '../debug/shaderDebugRegistry.js';
import { registerBuiltinShaderDebug } from 'virtual:dreamfall-shader-debug';
import {
  cycleCameraFeel,
  getCameraFeel,
  getComfortEnabled,
  getOnFootFirstPerson,
  setCameraFeel,
  setComfortEnabled,
  setOnFootFirstPerson,
} from '../config/cameraComfort.js';

// Office interiors live persistently far below the map, one slot per building,
// built lazily on first entry and cached for the session. Entering is then a pure
// teleport (no rebuild / no material recompile) — the swap only reassigns the
// LevelSystem facade pointer. See _enterBuilding/_exitBuilding.
const OFFICE_INTERIOR_OWNER = 'office-interior';
const INTERIOR_BASE_Y = -1000;
const INTERIOR_SLOT_SPACING = 300;
const INTERIOR_SLOTS_PER_ROW = 24;
const SNAPSHOT_INTERVAL_NORMAL_MS = 100;
const SNAPSHOT_INTERVAL_HEAVY_MS = 250;
const SNAPSHOT_HEAVY_VEHICLE_SPEED = 18;
const FULL_SNAPSHOT_INTERVAL_MS = 1000;

// Deterministic seed for a building's interior so the same building regenerates
// the same office each time (P1 WFC will consume it).
function buildingSeed(building) {
  const key = `${building?.name ?? ''}:${Math.round(building?.minX ?? 0)}:${Math.round(building?.minZ ?? 0)}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

export class GameRuntime {
  constructor({ canvas, qualityPreset = {}, qualityLevel = 'high', onSnapshot, levelMode = 'city' }) {
    this.canvas = canvas;
    this.levelMode = ['world', 'wilds', 'rally', 'range'].includes(levelMode) ? levelMode : 'city';
    this.qualityLevel = qualityLevel;
    this.qualityPreset = applyRangeLevelOverrides(
      applyCityLevelOverrides(qualityPreset, qualityLevel, this.levelMode),
      this.levelMode,
    );
    this.baseEnvironment = { ...this.qualityPreset.environment };
    this.photorealismPresetId = getPhotorealismPresetId();
    if (this.photorealismPresetId) {
      this.qualityPreset = {
        ...this.qualityPreset,
        environment: mergePhotorealismEnvironment(this.baseEnvironment, this.photorealismPresetId),
      };
    }
    this.onSnapshot = onSnapshot ?? (() => {});
    this.frameLoop = new FrameLoop((timeMs) => this.update(timeMs));
    this.lastSnapshotAt = 0;
    this.lastFullSnapshotAt = 0;
    this._lastFullSnapshot = null;
    this.lastFrameAt = 0;
    this.stage = 'created';
    this.disposed = false;
    this.coreSceneReady = false;
    this._prewarmingStarted = false;
    this._streamingCompileQueue = [];
    this._streamingCompileActive = false;
    // Play-ready barrier (single writer of stage='running' via _tryEnterRunning).
    this._loadGeneration = 0;
    this._systemsReady = false;
    this._prewarmFinished = false;
    this._nearFieldReady = false;
    this.simEnabled = false;
    this.inputEnabled = false;
    this._loadSubs = {
      level: 0,
      character: 0,
      near_field: 0,
      pipelines: 0,
      systems: 0,
    };
    this.loadProgress = {
      phase: 'level',
      label: 'Loading…',
      fraction: 0,
      detail: {},
      ready: false,
    };

    this.sceneSystem = new SceneSystem();
    this.rendererSystem = new RendererSystem({ canvas, qualityPreset: this.qualityPreset });
    this.cameraSystem = new CameraSystem();
    this.inputSystem = new InputSystem({ target: canvas });
    this.levelSystem = new LevelSystem();
    this.buildingEntrySystem = new BuildingEntrySystem();
    // Active office-interior session (null when outside). Set by _enterBuilding.
    this.insideBuilding = null;
    this.screenFade = { alpha: 0 };
    this._elevatorTransition = null;
    // Persistent interiors, keyed by building seed; built once, kept resident
    // below the map and reused (hidden when outside).
    this._interiorCache = new Map();
    this._interiorSlotCount = 0;
    this.characterSystem = new CharacterSystem();
    this.combatSystem = new CombatSystem();
    this.firstPersonWeaponSystem = new FirstPersonWeaponSystem();
    this.weaponSystem = new WeaponSystem();
    this.shootingRangeSystem = new ShootingRangeSystem();
    this.enemySystem = new EnemySystem();
    this.crowdSystem = new CrowdSystem();
    this.enemyCutSystem = new EnemyCutSystem();
    this.propSystem = new DestructiblePropSystem({
      cutPieceLifetime: qualityPreset.destructiblePropCutLifetime ?? 45,
    });
    this.playerDamageSystem = new PlayerDamageSystem();
    // Enemy attacks call back into the damage funnel; AnimationStateSystem reads
    // the resulting character.hitReaction state.
    this.enemySystem.playerDamageSystem = this.playerDamageSystem;
    this.horseSystem = new HorseSystem();
    this.physicsSystem = new PhysicsSystem();
    this.ledgeHangSystem = new LedgeHangSystem();
    this.ledgeTraversalSystem = new LedgeTraversalSystem();
    this.wallRunSystem = new WallRunSystem();
    this.wallClimbSystem = new WallClimbSystem();
    this.ropeSystem = new RopeSystem();
    this.vaultSystem = new VaultSystem();
    this.slideSystem = new SlideSystem();
    this.mountSystem = new MountSystem();
    this.movementSystem = new MovementSystem();
    this.traversalRouterSystem = new TraversalRouterSystem();
    this.animationStateSystem = new AnimationStateSystem();
    this.telekinesisSystem = new TelekinesisSystem();
    this.hookSwingSystem = new HookSwingSystem();
    this.wingsuitSystem = new WingsuitSystem();
    this.wingsuitFlightSystem = new WingsuitFlightSystem();
    this.abilitySystem = new AbilitySystem();
    this.vehicleSystem = new VehicleSystem();
    this.rallyCinematicDemo = new RallyCinematicDemo();
    this.vehicleDamageSystem = new VehicleDamageSystem();
    this.weatherSystem = new WeatherSystem();
    this.frameStats = new FrameStats();
    this.allocationSampler = new AllocationSampler();
    this.postCutSlowMoTimer = 0;
    this.renderCap60 = Boolean(qualityPreset.renderCap60);
    this.renderRateLimiter = new RenderRateLimiter(60);
    this._visibilityPaused = false;
    this.showTimingHud = false;
    this._onVisibilityChange = () => this.handleVisibilityChange();
  }

  async start() {
    if (this.disposed) {
      return;
    }

    this.stage = 'loading';
    // Do not emitSnapshot yet — camera/renderer are not initialized (snapshot
    // reads camera.aspect). Progress is seeded here; first emit is after camera init.
    this.loadProgress = {
      phase: 'level',
      label: 'Starting…',
      fraction: 0,
      detail: {},
      ready: false,
    };
    this.installDebugBridge();
    this.sceneSystem.initialize(this.qualityPreset);
    // Register after sky/provider init so uniform defaults match the live preset.
    // Dev-only via virtual:dreamfall-shader-debug (prod = inert stub).
    try {
      registerBuiltinShaderDebug(this);
    } catch (err) {
      console.warn('[shader-debug] registerBuiltinShaderDebug failed', err);
    }
    await this.rendererSystem.initialize();
    if (this.disposed) {
      return;
    }
    // Animated rally spectators bake flipbook frames whose per-frame instance
    // count varies every tick; WebGPU captures that count into the instance
    // binding at pipeline-build time. Weather/env changes (and resize) call
    // invalidatePipeline, rebuilding those bindings at a stale small count so
    // the crowd flickers. Re-prime the current level's crowd on each invalidate
    // (looked up dynamically so it survives level swaps). The bare scene-fog
    // toggle path is covered separately in the debug bridge.
    this.rendererSystem.onPipelineInvalidated = () => {
      this.levelSystem.level?.spectatorCrowd?.markPipelinesDirty?.();
    };
    // Rally starts at midday under rain. Bake sky + IBL with the overcast
    // profile before the first environment capture so startup matches the live
    // weather (setWeather below still wires rain VFX/audio).
    // Range: clear morning sky so the open-roof warehouse gets strong env-map IBL.
    if (this.levelMode === 'rally' && !this.photorealismPresetId) {
      this.sceneSystem.skySystem?.setTimeOfDay?.(0.5);
      this.sceneSystem.skySystem?.setWeather?.('rain');
      this.sceneSystem.setWeather?.('rain');
      this.sceneSystem.setSceneFogEnabled?.(true);
      this.rendererSystem.setWeather?.('rain');
    } else if (this.levelMode === 'range') {
      this.sceneSystem.skySystem?.setTimeOfDay?.(0.42);
      this.sceneSystem.skySystem?.setWeather?.('clear');
      this.sceneSystem.setWeather?.('clear');
      this.sceneSystem.setSceneFogEnabled?.(false);
      this.rendererSystem.setWeather?.('clear');
    } else if (this.photorealismPresetId) {
      this.sceneSystem.skySystem?.setWeather?.('clear');
      this.sceneSystem.setWeather?.('clear');
      this.sceneSystem.setSceneFogEnabled?.(false);
      this.rendererSystem.setWeather?.('clear');
    }
    this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
    if (this.levelMode === 'range' && this.sceneSystem.scene) {
      // Stronger sky PMREM so timber materials read outdoors light through open roof.
      this.sceneSystem.scene.environmentIntensity = 0.95;
    }
    // Hand the volumetric sky/cloud provider (if active) to the renderer so its
    // cloud composite can be inserted into the post pipeline.
    this.rendererSystem.cloudSkyProvider = this.sceneSystem.skySystem?.provider ?? null;
    this.weatherSystem.initialize({
      rendererSystem: this.rendererSystem,
      sceneSystem: this.sceneSystem,
      levelSystem: this.levelSystem,
      qualityPreset: this.qualityPreset,
    });
    if (this.photorealismPresetId || this.levelMode === 'range') {
      this.weatherSystem.setWeather('clear');
    } else if (this.levelMode === 'rally') {
      this.weatherSystem.setWeather('rain');
    }
    // setWeather resets environmentIntensity from the quality preset — restore
    // the open-roof IBL boost after clear weather is applied.
    if (this.levelMode === 'range' && this.sceneSystem.scene) {
      this.sceneSystem.scene.environmentIntensity = 0.95;
    }

    this.cameraSystem.initialize(this.sceneSystem.scene, this.qualityPreset);
    this.cameraSystem.setComfortOptions({
      enabled: getComfortEnabled(),
      feel: getCameraFeel(),
    });
    this.cameraSystem.setOnFootFirstPerson(getOnFootFirstPerson());
    this.sceneSystem.skySystem?.attachToCamera?.(this.cameraSystem.camera);
    this.sceneSystem.setShadowCamera(this.cameraSystem.camera);
    this.enemyCutSystem.initialize(this.sceneSystem.scene, this.qualityPreset);
    this.combatSystem.initialize(this.sceneSystem.scene);
    this.cameraSystem.resize(this.rendererSystem.getViewport());
    this.inputSystem.connect();
    document.addEventListener('visibilitychange', this._onVisibilityChange);
    this.emitSnapshot();

    // Launch the animation loop immediately so the page feels instant.
    // Update() will no-op gracefully until core assets are ready.
    this.lastFrameAt = performance.now();
    await this.rendererSystem.setAnimationLoop((timeMs) => this.update(timeMs));
    if (this.disposed) {
      return;
    }

    // Stream in heavy assets in the background. The loop is already running.
    this._streamAssetsInBackground().catch((err) => {
      console.error('Asset streaming failed', err);
    });
  }

  _applyPhotorealismRuntime() {
    // K9: photorealism look preset clears the entire shader override map.
    clearAllUserOverrides();
    const env = this.photorealismPresetId
      ? mergePhotorealismEnvironment(this.baseEnvironment, this.photorealismPresetId)
      : { ...this.baseEnvironment };
    this.qualityPreset.environment = env;
    this.sceneSystem.skySystem?.updateEnvironmentConfig?.(env);
    if (this.photorealismPresetId) {
      this.weatherSystem?.setWeather?.('clear');
      this.sceneSystem.setSceneFogEnabled?.(false);
    }
    this.rendererSystem.applyEnvironmentPreset(env);
    this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
  }

  _syncTerrainEnvironment(delta = 0) {
    const env = this.qualityPreset.environment ?? {};
    const viewDistance = this.levelSystem.level?.viewDistance
      ?? this.rendererSystem.viewDistance
      ?? this.cameraSystem?.camera?.far;
    if (this.rendererSystem.cloudSkyProvider) {
      syncCloudReach({
        viewDistance,
        fogMaxDistance: this.rendererSystem.fogMaxDistance,
        environmentPreset: env,
      });
    }
    if (!this.levelSystem.level?.terrainReach) return;
    syncTerrainAtmosphereFromSky(this.sceneSystem.skySystem, env);
    syncTerrainCloudShadow(this.rendererSystem.cloudSkyProvider?.cloudShadow ?? null);
    advanceTerrainParallaxWind(delta);
  }

  getCutTargets() {
    return [
      ...this.enemySystem.enemies,
      ...this.propSystem.props,
      ...this.enemyCutSystem.getRecuttableChunkTargets(),
    ];
  }

  _aborted(generation) {
    return this.disposed || generation !== this._loadGeneration;
  }

  _setLoadProgress({ phase, label, detail, sub } = {}) {
    if (sub && typeof sub === 'object') {
      for (const [key, value] of Object.entries(sub)) {
        if (!(key in this._loadSubs)) continue;
        const next = Math.min(1, Math.max(0, Number(value) || 0));
        this._loadSubs[key] = Math.max(this._loadSubs[key] ?? 0, next);
      }
    }
    const weights = {
      level: 0.15,
      character: 0.15,
      near_field: 0.25,
      pipelines: 0.3,
      systems: 0.15,
    };
    let fraction = 0;
    for (const [key, weight] of Object.entries(weights)) {
      fraction += weight * (this._loadSubs[key] ?? 0);
    }
    fraction = Math.max(this.loadProgress.fraction, Math.min(1, fraction));
    this.loadProgress = {
      phase: phase ?? this.loadProgress.phase,
      label: label ?? this.loadProgress.label,
      fraction,
      detail: { ...this.loadProgress.detail, ...(detail ?? {}) },
      ready: this.stage === 'running',
    };
    this.emitSnapshot(performance.now(), { force: true });
  }

  _tryEnterRunning() {
    if (this.disposed) return;
    if (!this._systemsReady || !this._prewarmFinished || !this._nearFieldReady) return;
    if (this.stage === 'running') return;
    // Prewarm deliberately renders expensive first-seen shader/shadow contexts.
    // Do not report those loading frames as gameplay FPS.
    this.frameStats.reset();
    this.stage = 'running';
    this.inputEnabled = true;
    this.simEnabled = true;
    this._setLoadProgress({
      phase: 'ready',
      label: 'Ready',
      sub: {
        level: 1,
        character: 1,
        near_field: 1,
        pipelines: 1,
        systems: 1,
      },
      detail: { prewarm: null },
    });
    // _setLoadProgress sets ready from stage; ensure ready true after stage write
    this.loadProgress = { ...this.loadProgress, ready: true, fraction: 1 };
    this.emitSnapshot(performance.now(), { force: true });
  }

  async _waitNearFieldReady({ generation, timeoutMs = 20_000 } = {}) {
    if (this.levelSystem.isNearFieldReady()) {
      this._setLoadProgress({
        phase: 'near_field',
        label: 'Near field ready',
        sub: { near_field: 1 },
      });
      return true;
    }
    const start = performance.now();
    while (!this._aborted(generation)) {
      if (this.levelSystem.isNearFieldReady()) {
        this._setLoadProgress({
          phase: 'near_field',
          label: 'Near field ready',
          sub: { near_field: 1 },
        });
        return true;
      }
      const elapsed = performance.now() - start;
      if (elapsed > timeoutMs) {
        console.warn('[GameRuntime] near-field wait timed out; entering play fail-open');
        this._setLoadProgress({
          phase: 'near_field',
          label: 'Near field timeout',
          sub: { near_field: 1 },
        });
        return true;
      }
      const fraction = Math.min(0.95, elapsed / timeoutMs);
      this._setLoadProgress({
        phase: 'near_field',
        label: 'Streaming nearby world…',
        sub: { near_field: fraction },
        detail: {
          nearField: { completed: 0, total: 1, label: 'streaming' },
        },
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  }

  async _streamAssetsInBackground() {
    const gen = this._loadGeneration;
    this._setLoadProgress({ phase: 'level', label: 'Loading world…', sub: { level: 0.05 } });

    await this.levelSystem.loadBaseLevel(this.sceneSystem.scene, this.qualityPreset, this.levelMode, this.rendererSystem.renderer);
    if (this._aborted(gen)) {
      return;
    }
    this._setLoadProgress({ phase: 'level', label: 'World loaded', sub: { level: 1 } });

    const levelViewDistance = this.levelSystem.level?.viewDistance;
    if (Number.isFinite(levelViewDistance) && levelViewDistance > 0) {
      this.cameraSystem.camera.far = levelViewDistance;
      this.cameraSystem.camera.updateProjectionMatrix();
      this.sceneSystem.setViewDistance?.(levelViewDistance);
      syncTerrainViewDistance(
        levelViewDistance,
        {
          ...(this.qualityPreset.environment ?? {}),
          terrainReach: this.levelSystem.level?.terrainReach,
        },
      );
      syncTerrainAtmosphereFromSky(
        this.sceneSystem.skySystem,
        this.qualityPreset.environment ?? {},
      );
      this.rendererSystem.setViewDistance?.(levelViewDistance);
      if (this.rendererSystem.cloudSkyProvider) {
        syncCloudReach({
          viewDistance: levelViewDistance,
          fogMaxDistance: this.rendererSystem.fogMaxDistance,
          environmentPreset: this.qualityPreset.environment ?? {},
        });
      }
    }

    this._setLoadProgress({ phase: 'character', label: 'Loading character…', sub: { character: 0.1 } });
    await this.characterSystem.loadMara(this.sceneSystem.scene);
    if (this._aborted(gen) || !this.characterSystem.character) {
      return;
    }

    // Jacket cloth (three-simplecloth on WebGPU). Skipped when jacketExperiments is off
    // (see gameConfig); ?jacket=cloth still forces it on for one-off tuning.
    if (resolveJacketMode() !== 'off') {
      await this.characterSystem.attachJacketCloth(this.rendererSystem.renderer);
    }
    if (this._aborted(gen)) return;

    this._setLoadProgress({ phase: 'character', label: 'Character ready', sub: { character: 1 } });
    this.coreSceneReady = true;
    // Unlock stream + full render path. Never wait on near-field under 'loading'.
    this.stage = 'prewarming';
    this._prewarmingStarted = true;
    this.inputEnabled = false;
    this.simEnabled = false;
    this.emitSnapshot(performance.now(), { force: true });

    // Prewarm needs live rAF renders (pipeline batches); start under prewarming.
    const prewarmPromise = this._runPrewarm(gen);
    // Near-field wait yields so update() can pump city streaming.
    const nearFieldPromise = this._waitNearFieldReady({ generation: gen, timeoutMs: 20_000 })
      .then((ok) => {
        if (this._aborted(gen)) return;
        this._nearFieldReady = ok !== false;
        this._tryEnterRunning();
      });

    // Snap character to the actual ground height of the (possibly edited) terrain.
    // This prevents spawning inside or below the heightfield surface, which causes "stuck" behavior.
    // We do it before physics body creation so the Rapier capsule starts above the surface.
    const character = this.characterSystem.character;
    if (character && this.levelSystem.level?.spawnPoint) {
      character.group.position.copy(this.levelSystem.level.spawnPoint);
      if (character.velocity) character.velocity.set(0, 0, 0);
      character.verticalVelocity = 0;
    }

    if (character && typeof this.levelSystem.getGroundHeightAt === 'function') {
      const p = character.group.position;
      const ground = this.levelSystem.getGroundHeightAt(p, 0.5);
      if (Number.isFinite(ground)) {
        character.group.position.y = ground;
        if (character.velocity) character.velocity.set(0, 0, 0);
        character.verticalVelocity = 0;
        character.grounded = true;
        // clear any traversal states so it doesn't think it's stuck in a wall/ledge
        character.hang = null;
        character.mount = null;
        character.wallRun = null;
        character.wallClimb = null;
        character.vault = null;
        character.hookSwing = null;
        character.vehicle = null;
      }
    }

    this._setLoadProgress({ phase: 'systems', label: 'Loading systems…', sub: { systems: 0.05 } });

    // Rally / range are purpose-built scenes — skip open-world ambient systems.
    if (this.levelMode !== 'rally' && this.levelMode !== 'range') {
      await this.horseSystem.load(this.sceneSystem.scene, {
        position: horseSpawnPosition(character?.group.position, this.levelSystem),
        getGroundHeightAt: (position) => horseGroundHeight(this.levelSystem, position),
      });
      if (this._aborted(gen)) return;

      await this.enemySystem.load(this.sceneSystem.scene, {
        playerPosition: character?.group.position,
        level: this.levelSystem,
      });
      if (this._aborted(gen)) return;

      await this.crowdSystem.load(this.sceneSystem.scene, {
        level: this.levelSystem,
        playerPosition: character?.group.position ?? new THREE.Vector3(),
      });
      if (this._aborted(gen)) return;

      await this.propSystem.load(this.sceneSystem.scene, {
        playerPosition: character?.group.position,
        level: this.levelSystem,
      });
      if (this._aborted(gen)) return;
    }
    this._setLoadProgress({ phase: 'systems', label: 'Initializing physics…', sub: { systems: 0.45 } });

    await this.physicsSystem.initialize({
      level: this.levelSystem.level,
      character: this.characterSystem.character,
      enemies: [...this.enemySystem.enemies, ...this.propSystem.props],
    });
    if (this._aborted(gen)) {
      return;
    }

    this.animationStateSystem.start({
      character: this.characterSystem.character,
    });

    this.vehicleSystem.initialize({
      physics: this.physicsSystem,
      scene: this.sceneSystem.scene,
      level: this.levelSystem,
      weatherSystem: this.weatherSystem,
      vehicleDamageSystem: this.vehicleDamageSystem,
    });
    // Fixed-step hooks: interpolation pose capture and vehicle integration once
    // per physics tick.
    this.physicsSystem.stepHooks = {
      beforeTick: () => this.vehicleSystem?.capturePrevPoses(),
      integrate: (dt, tick) => this.vehicleSystem?.integrateStep(dt, tick),
    };
    this.vehicleDamageSystem.initialize({
      physics: this.physicsSystem,
      scene: this.sceneSystem.scene,
    });

    this._setLoadProgress({ phase: 'systems', label: 'Spawning vehicles…', sub: { systems: 0.7 } });

    // One garage build beside the player on every map except the collision test
    // track, which spawns two autopilot chassis cars from opposite directions.
    // Indoor range has no vehicles.
    if (this.levelMode !== 'range') {
      const worldMap = getActiveWorldMapSync();
      if (isCollisionTestMap(worldMap)) {
        await spawnCollisionTestVehicles(this.vehicleSystem);
      } else {
        const carPosition = this.levelMode === 'rally'
          ? new THREE.Vector3(-129, 0, 136)
          : carSpawnPosition(this.horseSystem, character?.group.position);
        const carYaw = this.levelMode === 'rally'
          ? -Math.PI / 4
          : (this.horseSystem.group?.rotation.y ?? 0);
        const garageVehicleOptions = spawnVehicleOptions(this.levelMode);
        const VehicleConstructor = garageVehicleOptions.vehicleKind === 'quad'
          ? QuadBikeVehicle
          : BaseVehicle;
        const spawnCar = await this.vehicleSystem.spawnVehicle({
          vehicle: new VehicleConstructor({
            ...garageVehicleOptions,
            name: 'Spawn Car',
            position: carPosition,
            rotationY: carYaw,
          }),
        });
        if (this.levelMode === 'rally' && character && spawnCar) {
          await this.vehicleSystem.enterVehicle(character, spawnCar, { warmup: true });
        }
        if (this.levelMode === 'rally') {
          const quadSpawns = [
            { name: 'Rally Quad 1', position: new THREE.Vector3(-124.5, 0, 132.5), rotationY: -Math.PI / 4 },
            { name: 'Rally Quad 2', position: new THREE.Vector3(-121.5, 0, 136), rotationY: -Math.PI / 4 },
          ];
          const parkedQuadSpawns = garageVehicleOptions.vehicleKind === 'quad'
            ? quadSpawns.slice(1)
            : quadSpawns;
          for (const spec of parkedQuadSpawns) {
            await this.vehicleSystem.spawnVehicle({ vehicle: new QuadBikeVehicle(spec) });
          }
        }
      }
    }
    if (this._aborted(gen)) {
      return;
    }

    this.hookSwingSystem.initialize(this.sceneSystem.scene);

    this.combatSystem.start({
      character: this.characterSystem.character,
    });
    this.firstPersonWeaponSystem.start({
      character: this.characterSystem.character,
    });
    this.weaponSystem.initialize(this.sceneSystem.scene);

    // Shooting range: force first-person + equip a gun for the session (training focus).
    if (this.levelMode === 'range') {
      this.cameraSystem.setOnFootFirstPerson(true);
      this.weaponSystem.equipAndDraw(defaultGunIdFromQuery(), {
        character: this.characterSystem.character,
        combatSystem: this.combatSystem,
        firstPersonWeaponSystem: this.firstPersonWeaponSystem,
      });
      this.shootingRangeSystem.start(this.sceneSystem.scene, {
        spawns: this.levelSystem.level?.rangeTargets ?? [],
      });
      const spawnYaw = this.levelSystem.level?.spawnYaw;
      if (Number.isFinite(spawnYaw) && this.characterSystem.character) {
        this.characterSystem.character.yaw = spawnYaw;
        this.cameraSystem.yaw = spawnYaw;
      }
      // Clear outdoor sky for open roof + warehouse HDR as scene.environment IBL.
      const rangeEnv = this.levelSystem.level?.rangeEnvironment ?? {};
      if (Number.isFinite(rangeEnv.timeOfDay)) {
        this.sceneSystem.skySystem?.setTimeOfDay?.(rangeEnv.timeOfDay);
      }
      this.sceneSystem.skySystem?.setWeather?.(rangeEnv.weather ?? 'clear');
      this.sceneSystem.setWeather?.(rangeEnv.weather ?? 'clear');
      this.sceneSystem.setSceneFogEnabled?.(rangeEnv.fogEnabled === true);
      this.rendererSystem.setWeather?.(rangeEnv.weather ?? 'clear');
      try {
        await installRangeEnvironment(
          this.sceneSystem.scene,
          this.rendererSystem.renderer,
          {
            intensity: rangeEnv.intensity ?? 1.05,
            rotationY: rangeEnv.environmentRotationY ?? 0.35,
            asBackground: rangeEnv.asBackground === true,
          },
        );
      } catch (err) {
        console.warn('[GameRuntime] warehouse environment failed; keeping sky PMREM', err);
        this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
        if (Number.isFinite(rangeEnv.intensity)) {
          this.sceneSystem.scene.environmentIntensity = rangeEnv.intensity;
        }
      }
    }

    // ?fp=1 forces on-foot first person for M3 checks / playground.
    try {
      if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('fp') === '1') {
        setOnFootFirstPerson(true);
        this.cameraSystem.setOnFootFirstPerson(true);
      }
    } catch {
      // ignore
    }

    this._systemsReady = true;
    this._setLoadProgress({ phase: 'systems', label: 'Systems ready', sub: { systems: 1 } });
    this._tryEnterRunning();

    await prewarmPromise;
    if (this._aborted(gen)) return;
    this._tryEnterRunning();

    await nearFieldPromise;
    if (this._aborted(gen)) return;
    this._tryEnterRunning();
  }

  // The driven car ragdolls + flings any live enemy it runs into. Detection is a
  // cheap analytic footprint overlap in the chassis-local frame (enemies are
  // kinematic, not rigid bodies — see runOver.js); each hit spawns a full-body
  // ragdoll launched up and along the car's travel direction. Capped per frame so
  // ploughing a crowd can't stack CSG ragdoll spawns into one spike.
  _applyVehicleRunOver() {
    const vehicle = this.vehicleSystem?.activeVehicle;
    const cfg = vehicle?.config?.runOver;
    if (!vehicle || vehicle.domain !== 'ground' || !cfg?.enabled) {
      return;
    }
    const frame = vehicle.getRunOverFrame();
    const enemies = this.enemySystem?.enemies;
    // computeRunOverHits collects into a fresh array, so it is safe that the loop
    // below removes enemies (which splices enemySystem.enemies) as it ragdolls them.
    const hits = computeRunOverHits({ frame, enemies, cfg });
    for (const { enemy, sideSign } of hits) {
      const launch = computeRunOverLaunch({ frame, sideSign, cfg });
      this.enemyCutSystem.smashEnemyToRagdoll({
        enemy,
        launchVelocity: launch,
        physicsSystem: this.physicsSystem,
        enemySystem: this.enemySystem,
        propSystem: this.propSystem,
      });
    }
  }

  async _runPrewarm(generation) {
    try {
      await this._prewarmShaders(generation);
    } catch {
      // Non-fatal — first real frames may still compile anything missed.
    }
    if (this._aborted(generation)) return;
    this._prewarmFinished = true;
    this._setLoadProgress({
      phase: 'pipelines',
      label: 'Shaders ready',
      sub: { pipelines: 1 },
      detail: { prewarm: this._cityPrewarmProgress },
    });
    this._tryEnterRunning();
  }

  async _prewarmShaders(generation) {
    const renderer = this.rendererSystem.renderer;
    const scene = this.sceneSystem.scene;
    const camera = this.cameraSystem.camera;
    const warmup = this.levelSystem.level?.createPipelineWarmupGroup?.() ?? null;

    try {
      this._setLoadProgress({
        phase: 'pipelines',
        label: 'Warming shaders…',
        sub: { pipelines: 0.05 },
      });
      // compileAsync turns small instance/skeleton arrays into vertex uniform
      // buffers. WebGPU rejects zero-byte bindings, so strip impossible empty
      // render objects before Three builds the asynchronous render list.
      sanitizeWebGPUVertexBuffers(scene);
      if (renderer && typeof renderer.compileAsync === 'function' && scene && camera) {
        // Three r185's async pipeline descriptor is incomplete for the custom
        // MeshSSSNodeMaterial used by hero foliage (missing depthStencil), which
        // poisons the prewarm command stream. Let those bounded objects compile
        // through their real render context instead of compileAsync(scene).
        const restoreUnsafeMaterials = hideUnsafeAsyncCompileObjects(scene);
        try {
          await renderer.compileAsync(scene, camera);
        } finally {
          restoreUnsafeMaterials();
        }
      }
      if (this._aborted(generation)) return;

      // Compile one material's Mesh + InstancedMesh pair at a time. A single
      // scene containing every city TSL material monopolized Chromium for
      // minutes; small batches keep the loading loop responsive while still
      // presenting each variant to the real lights, shadows, and SSAO pass.
      const children = warmup ? [...warmup.children] : [];
      const totalBatches = Math.max(1, Math.ceil(children.length / 2));
      this._cityPrewarmProgress = { completed: 0, total: totalBatches };
      if (children.length === 0) {
        this._setLoadProgress({
          phase: 'pipelines',
          label: 'Warming shaders…',
          sub: { pipelines: 0.85 },
          detail: { prewarm: this._cityPrewarmProgress },
        });
      }
      for (let index = 0; index < children.length; index += 2) {
        if (this._aborted(generation)) return;
        const batch = new THREE.Group();
        batch.name = `City Pipeline Warmup Batch ${index / 2}`;
        batch.add(...children.slice(index, index + 2));
        scene.add(batch);
        try {
          // Do not call compileAsync(scene) for every pair: that repeatedly
          // re-analyzes the entire live scene and made the warmup take minutes.
          // The active animation loop renders this small batch through the real
          // color/shadow/prepass pipeline on the next two frames.
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await new Promise((resolve) => requestAnimationFrame(resolve));
        } finally {
          batch.removeFromParent();
        }
        this._cityPrewarmProgress.completed += 1;
        const pipelineFrac = this._cityPrewarmProgress.completed / totalBatches;
        this._setLoadProgress({
          phase: 'pipelines',
          label: 'Warming shaders…',
          sub: { pipelines: 0.1 + pipelineFrac * 0.85 },
          detail: { prewarm: { ...this._cityPrewarmProgress } },
        });
      }

    } catch (e) {
      // Non-fatal
    } finally {
      // compileAsync can reject before covering every real RenderPipeline
      // context. Keep a few full render frames so shadow/SSAO caches populate.
      for (let frame = 0; frame < 4; frame += 1) {
        if (this._aborted(generation)) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      warmup?.removeFromParent();
      warmup?.userData?.disposeWarmup?.();
      if (!this._aborted(generation) && this._cityPrewarmProgress) {
        this._cityPrewarmProgress = {
          completed: this._cityPrewarmProgress.total,
          total: this._cityPrewarmProgress.total,
        };
      } else {
        this._cityPrewarmProgress = null;
      }
    }
  }

  update(timeMs) {
    if (this._visibilityPaused) {
      this.lastFrameAt = timeMs;
      return;
    }
    if (this.renderCap60) {
      if (!this.renderRateLimiter.shouldRun(timeMs)) return;
    }
    const frameMs = timeMs - this.lastFrameAt;
    const delta = Math.min(Math.max(frameMs / 1000, 0), 0.05);
    this.lastFrameAt = timeMs;

    if (!this.characterSystem?.character) {
      this.emitSnapshot();
      return;
    }
    if (this.stage === 'loading') {
      this.emitSnapshot();
      return;
    }

    // During prewarming: pump streaming + full render so city near-field and
    // pipeline batches advance. Gameplay sim/input stay off until play-ready.
    if (this.stage === 'prewarming' && this.simEnabled === false) {
      this._updatePrewarmingFrame(timeMs, delta, frameMs);
      return;
    }

    let input = this.inputSystem.getState();
    if (!this.inputEnabled) {
      input = {
        ...input,
        moveX: 0,
        moveZ: 0,
        jump: false,
        jumpPressed: false,
        brace: false,
        bracePressed: false,
        slide: false,
        slidePressed: false,
        lightAttackPressed: false,
        heavyAttackPressed: false,
        drawSheathePressed: false,
        shoulderThrowPressed: false,
        cutModePressed: false,
        telekinesisPressed: false,
        hookFirePressed: false,
        hookAimHeld: false,
        abilityPressed: false,
        abilityDoubleTapped: false,
        wingsuitTogglePressed: false,
        dodgeDirection: null,
        mountPressed: false,
        lookX: 0,
        lookY: 0,
        photoModePressed: false,
        collisionDebugPressed: false,
      };
    }
    if (
      this.inputEnabled
      && !this._forestAmbienceAwake
      && (input.forward || input.backward || input.left || input.right || input.jumpPressed)
    ) {
      if (this.levelSystem.level?.wakeForestAmbience?.()) {
        this._forestAmbienceAwake = true;
      }
    }
    const character = this.characterSystem.character;
    if (this.inputEnabled && input.photoModePressed) {
      this.setPhotoMode(!this.cameraSystem.photoMode);
    }
    if (this.cameraSystem.photoMode) {
      this.cameraSystem.updatePhotoMode({ delta, input });
      this.rendererSystem.resizeIfNeeded((viewport) => this.cameraSystem.resize(viewport));
      if (this.sceneSystem.skySystem?.update(delta, this.cameraSystem?.camera)) {
        this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
      }
      this.rendererSystem.render({
        scene: this.sceneSystem.scene,
        camera: this.cameraSystem.camera,
      });
      this.emitSnapshot(timeMs);
      return;
    }
    // Building enter/exit. Handled before the movement/ability pipeline so the E
    // (mount/interact) press is consumed here (returning early skips vehicle mount
    // and ability use this frame; the input edge is already cleared by getState()).
    // `prompt` is last frame's detection — one frame stale is imperceptible.
    if (this.insideBuilding) {
      if (this._elevatorTransition) {
        this._tickElevatorTransition(delta, character);
        this.emitSnapshot(timeMs);
        return;
      }
      this.insideBuilding.atDoor = this._isAtInteriorDoor(character);
      this.insideBuilding.atElevator = this._isAtElevator(character);
      this.insideBuilding.interior.updateDoors?.(delta);
      this.insideBuilding.nearbyDoor = this.insideBuilding.interior.getNearbyDoor?.(character.group.position) ?? null;
      if (this.insideBuilding.atDoor && input.mountPressed) {
        this._exitBuilding(character);
        this.emitSnapshot();
        return;
      }
      if (this.insideBuilding.atElevator && !this.insideBuilding.atDoor
        && this.insideBuilding.interior.floorCount > 1) {
        const floorPick = this._readElevatorFloorInput(input);
        if (floorPick != null) {
          this._startElevatorRide(character, floorPick);
          this.emitSnapshot();
          return;
        }
        if (input.mountPressed) {
          const fc = this.insideBuilding.interior.floorCount;
          const next = (this.insideBuilding.currentFloor + 1) % fc;
          this._startElevatorRide(character, next);
          this.emitSnapshot();
          return;
        }
        if (input.bracePressed) {
          const fc = this.insideBuilding.interior.floorCount;
          const prev = (this.insideBuilding.currentFloor - 1 + fc) % fc;
          this._startElevatorRide(character, prev);
          this.emitSnapshot();
          return;
        }
      }
      if (!this.insideBuilding.atDoor && !this.insideBuilding.atElevator
        && this.insideBuilding.nearbyDoor && input.mountPressed) {
        this.insideBuilding.interior.toggleDoor(
          this.insideBuilding.nearbyDoor.door,
          character.group.position,
        );
        this.emitSnapshot();
        return;
      }
    } else if (this.buildingEntrySystem.state.prompt && input.mountPressed) {
      this._enterBuilding(character);
      this.emitSnapshot();
      return;
    }

    this.weatherSystem.update(delta, character.group.position, {
      inVehicle: Boolean(this.vehicleSystem?.activeVehicle),
    });

    this.levelSystem.level?.updateForestEnvironment?.({
      sunDirection: this.sceneSystem.skySystem?.sunDirection,
      windVector: rainWind.value,
    });

    const ambPos = this.vehicleSystem?.activeVehicle?.group?.position
      ?? character?.group?.position;
    if (ambPos) {
      this.levelSystem.level?.updateForestAmbience?.(ambPos, delta);
    }

    if (input.collisionDebugPressed) {
      this.levelSystem.toggleCollisionDebug();
    }

    let streamingMs = 0;
    let streamingActive = false;
    if (character) {
      const streamStart = performance.now();
      const mountedHorse = this.mountSystem?.state !== 'idle'
        ? this.horseSystem?.group
        : null;
      const streamingFocus = this.vehicleSystem?.activeVehicle?.group?.position
        ?? mountedHorse?.position
        ?? character.group.position;
      const viewPos = this.cameraSystem?.camera?.position ?? streamingFocus;
      const streamingChanges = this.levelSystem.updateStreaming(streamingFocus, {
        viewPosition: viewPos,
      });
      const builtColliders = this.physicsSystem.applyStreamingChanges(streamingChanges);
      streamingMs = performance.now() - streamStart;
      streamingActive =
        builtColliders > 0 ||
        (streamingChanges?.addedChunks?.length ?? 0) > 0 ||
        (streamingChanges?.removedChunkKeys?.length ?? 0) > 0 ||
        (streamingChanges?.terrainVisualChanges ?? 0) > 0;

      // Pre-warm render pipelines for freshly attached chunks. WebGPU compiles pipelines
      // asynchronously; kicking this off at attach time (while the chunk is still offscreen,
      // prefetched seconds ahead) lets compilation land during the prefetch window instead of
      // stalling the chunk's first on-screen render.
      if ((streamingChanges?.addedChunks?.length ?? 0) > 0) {
        this.queueStreamingCompile(streamingChanges.addedChunks.map((chunk) => chunk.group));
      }

      // Drive the shadow volume to follow the active locomotion root (the sun is otherwise locked to
      // the origin, so shadows disappear once you walk away from spawn). Placed here
      // so both render paths (cut-mode + normal) are covered by one call; the one-frame
      // lag behind movement is invisible because the follow point is texel-snapped.
      this.sceneSystem.updateShadowFollow(streamingFocus);
      this.sceneSystem.updateStreetLights(streamingFocus);
    }
    this.frameStats.recordSystem('streaming', streamingMs);

    // Always run a little BVH warmup (even during streaming). Newly attached chunks
    // enqueue their meshes; this prevents raycasts (hook, ledge, avoidance) from
    // hitting computeBoundsTree on the hot path.
    this.frameStats.start('bvh');
    this.levelSystem.warmupGeometryRaycasts({
      maxMs: streamingActive ? 1 : 2,
      maxCount: streamingActive ? 2 : 8,
    });
    this.frameStats.endSection();

    // Crowd update early (after streaming, before heavy systems). Phase 1/2 stub is trivial cost.
    // No side effects on enemy/cut/physics/streaming (internal status guard).
    this.frameStats.start('crowd');
    if (this.crowdSystem) {
      this.crowdSystem.update({
        delta,
        playerPosition: character?.group?.position,
        level: this.levelSystem,
      });
    }
    this.frameStats.endSection();

    // Update the cut system. Pass unscaled delta so aiming remains responsive.
    this.frameStats.start('cut');
    const cutMode = this.enemyCutSystem.update({
      delta,
      input,
      character,
      camera: this.cameraSystem.camera,
      enemies: this.getCutTargets(),
      enemySystem: this.enemySystem,
      propSystem: this.propSystem,
      physicsSystem: this.physicsSystem,
    });
    this.frameStats.endSection();

    // Hand off to combat animation when the cut system wants to start the swing
    // (V release after aiming). This was previously not wired, breaking the aim cut.
    if (cutMode?.startSwing) {
      this.combatSystem.beginAimCut({
        combat: character.combat,
        orientation: cutMode.orientation,
      });
    }

    // 1. Detect transition to committed cuts and set the slow-mo timer
    if (this.enemyCutSystem.justCut) {
      this.enemyCutSystem.justCut = false;
      this.postCutSlowMoTimer = 2.5; // real-world seconds
    }

    // 2. Decrement the slow-motion timer
    if (this.postCutSlowMoTimer > 0) {
      this.postCutSlowMoTimer -= delta;
      if (this.postCutSlowMoTimer < 0) {
        this.postCutSlowMoTimer = 0;
      }
    }

    // 3. Calculate time scale: slow-mo when aiming (0.05) or after cutting (ramping up to 1.0)
    let timeScale = 1.0;
    if (this.enemyCutSystem.state === 'aiming') {
      timeScale = 0.05; // 5% speed
    } else if (this.postCutSlowMoTimer > 0) {
      const t = this.postCutSlowMoTimer / 2.5;
      timeScale = 0.05 + 0.95 * (1 - t);
    }

    const scaledDelta = delta * timeScale;

    // 4. Plan this frame's fixed physics steps from the REAL frame delta, so sim
    //    speed no longer depends on the display refresh rate (a 120 Hz monitor
    //    runs steps every other frame; a 30 fps stall catches up with extra
    //    steps). Slow-mo scales time entering the accumulator while the solver
    //    step remains fixed. Nothing steps before the movement
    //    system, so planning here (after timeScale is known) is safe.
    this.physicsSystem.beginFrame({
      delta,
      timeScale,
      fixedStep: this.vehicleSystem?.activeVehicle
        ? VEHICLE_PHYSICS_FIXED_STEP
        : PHYSICS_FIXED_STEP,
    });

    // 5. Construct gameplay input: lock locomotion/combat when aiming, but allow rotating/positioning the plane
    let gameplayInput = input;
    if (this.rallyCinematicDemo?.active) {
      gameplayInput = {
        ...input,
        moveX: 0,
        moveZ: 0,
        jump: false,
        jumpPressed: false,
        brace: false,
        bracePressed: false,
        slide: false,
        slidePressed: false,
        lightAttackPressed: false,
        heavyAttackPressed: false,
        drawSheathePressed: false,
        shoulderThrowPressed: false,
        cutModePressed: false,
        telekinesisPressed: false,
        hookFirePressed: false,
        hookAimHeld: false,
        abilityPressed: false,
        abilityDoubleTapped: false,
        wingsuitTogglePressed: false,
        dodgeDirection: null,
        mountPressed: false,
        lookX: 0,
        lookY: 0,
      };
    } else if (this.enemyCutSystem.state === 'aiming') {
      gameplayInput = {
        ...input,
        moveX: 0,
        moveZ: 0,
        jump: false,
        slide: false,
        brace: false,
        lightAttackPressed: false,
        heavyAttackPressed: false,
        drawSheathePressed: false,
      };
    }

    // Weapon loadout first: scroll cycles sword/guns, Z holsters/draws equipped.
    // Sword starts drawn; guns join the same list after the great sword.
    gameplayInput = this.weaponSystem.processLoadout({
      input: gameplayInput,
      character,
      combatSystem: this.combatSystem,
      firstPersonWeaponSystem: this.firstPersonWeaponSystem,
    }) ?? gameplayInput;

    // Equip/activate traversal abilities (swing, wingsuit) before vehicle/mount/FP.
    // F maps onto hook/wingsuit flags for the equipped ability.
    gameplayInput = this.abilitySystem.processInput({
      input: gameplayInput,
      firstPersonWeaponSystem: this.firstPersonWeaponSystem,
      weaponSystem: this.weaponSystem,
    }) ?? gameplayInput;

    this.horseSystem.update({ delta: scaledDelta });
    // Advance damage timers / regen BEFORE enemies deal damage this frame (so a
    // reaction set last frame decays, and a fresh one set this frame isn't).
    this.playerDamageSystem.update({ delta: scaledDelta, player: character });
    this.frameStats.start('enemy');
    this.enemySystem.update({
      delta: scaledDelta,
      player: character,
      level: this.levelSystem,
    });
    this.physicsSystem.syncEnemyColliders(this.getCutTargets());
    this.frameStats.endSection();

    this.frameStats.start('movement');

    // Vehicles run before the mount/horse path so they can claim the mount key
    // when one is in range or being driven, and so their controls are smoothed
    // before the fixed physics steps integrate them (via stepHooks). Returns a
    // locked input clone while driving.
    const routedVehicle = this.vehicleSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      level: this.levelSystem,
      camera: this.cameraSystem.camera,
    });
    gameplayInput = routedVehicle.input ?? gameplayInput;

    // Run enemies down: the driven car ragdolls + launches any enemy it ploughs into.
    // Runs after the vehicle update (chassis pose/velocity are current) and before
    // the world step so the new ragdoll bodies simulate this frame.
    this._applyVehicleRunOver();
    this.vehicleDamageSystem.update({
      delta: scaledDelta,
      vehicles: this.vehicleSystem.vehicles,
    });

    this.mountSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      horseSystem: this.horseSystem,
      level: this.levelSystem,
    });

    // FP weapon stance gates traversal intent before the router / combat consume it.
    // Only active when the loadout firearm is drawn (not sword / not holstered).
    gameplayInput = this.firstPersonWeaponSystem.processInput({
      input: gameplayInput,
      character,
      cameraSystem: this.cameraSystem,
      weaponSystem: this.weaponSystem,
    }) ?? gameplayInput;

    const routedTraversal = this.traversalRouterSystem.update({
      input: gameplayInput,
      character,
      level: this.levelSystem,
      wallClimbSystem: this.wallClimbSystem,
    });
    gameplayInput = routedTraversal.input ?? gameplayInput;

    gameplayInput = this.combatSystem.processInput({ input: gameplayInput, character, enemies: this.enemySystem.enemies });

    let movement = this.movementSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      level: this.levelSystem,
      physics: this.physicsSystem,
      cameraBasis: this.cameraSystem.getMovementBasis(),
    });

    movement = this.ledgeHangSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
      wallClimbSystem: this.wallClimbSystem,
      cameraBasis: this.cameraSystem.getMovementBasis(),
    });

    movement = this.ledgeTraversalSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      cameraBasis: this.cameraSystem.getMovementBasis(),
    });

    movement = this.wallRunSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
    });

    movement = this.slideSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
    });

    movement = this.vaultSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
    });

    movement = this.wallClimbSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
      ledgeHangSystem: this.ledgeHangSystem,
    });

    movement = this.ropeSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
      physics: this.physicsSystem,
    });

    // Wingsuit before hook so grappling out of a glide can exit the wingsuit first,
    // then let the hook fire on the same frame off the boosted velocity.
    movement = this.wingsuitFlightSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
      physics: this.physicsSystem,
    });

    movement = this.hookSwingSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
      camera: this.cameraSystem.camera,
    });
    this.frameStats.endSection();

    // FP weapon locomotion override (M3) — sets animationOverride before anim system.
    this.firstPersonWeaponSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      cameraSystem: this.cameraSystem,
      weaponSystem: this.weaponSystem,
    });

    this.frameStats.start('animation');
    this.animationStateSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      movement,
      character,
      level: this.levelSystem,
    });
    this.frameStats.endSection();

    // Spine aim → weapon anchor → hand IK (same order as dust-and-bullets playerBody).
    this.firstPersonWeaponSystem.postAnimation({
      character,
      cameraSystem: this.cameraSystem,
    });

    // Bone-driven visuals read final bone poses after animation has settled.
    this.frameStats.start('wingsuit');
    this.wingsuitSystem.update({ delta: scaledDelta, character });
    this.frameStats.endSection();

    if (resolveJacketMode() !== 'off') {
      this.frameStats.start('jacket');
      this.characterSystem.updateProceduralJacket(scaledDelta);
      this.frameStats.endSection();

      // Jacket cloth simulation (three-simplecloth). Update *after* the animation mixer
      // has written the current bone matrices so the cloth can read the live body pose.
      if (character?.jacketCloth?.update) {
        try {
          character.jacketCloth.update(scaledDelta);
        } catch (e) {
          // Fail-soft; cloth is purely visual.
        }
      }
    }

    // Telekinesis after animation (to read fresh hand bone), before physics step.
    // Phase 1: basic grab + orbit on loose cut chunks. Input consumed internally.
    this.frameStats.start('telekinesis');
    this.telekinesisSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      physicsSystem: this.physicsSystem,
      propSystem: this.propSystem,
      enemyCutSystem: this.enemyCutSystem,
      enemySystem: this.enemySystem,
      camera: this.cameraSystem.camera,
      enemies: this.enemySystem.enemies,
    });
    this.frameStats.endSection();

    this.frameStats.start('combat');
    this.combatSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      enemies: this.getCutTargets(),
      physicsSystem: this.physicsSystem,
      enemySystem: this.enemySystem,
      propSystem: this.propSystem,
      enemyCutSystem: this.enemyCutSystem,
    });
    this.frameStats.endSection();

    this.ropeSystem.alignCharacterHandsToSocket({ character });
    this.frameStats.start('physics');
    // Run this frame's planned fixed steps if the on-foot movement path hasn't
    // already (moveCharacter steps mid-frame, preserving the old ordering for the
    // traversal systems' post-step queries). Vehicle force integration, the
    // legacy high-speed slicing, and interpolation pose capture all run inside
    // via physicsSystem.stepHooks.
    this.physicsSystem.stepPlanned();
    this.frameStats.endSection();
    // Move vehicle visuals to the pose interpolated between the last two physics
    // steps (alpha = fraction of a step accumulated but not yet simulated) and
    // re-seat the rider on it, so the camera and render track a smooth car at any
    // display refresh rate.
    this.vehicleSystem?.syncVisualPoses(this.physicsSystem.interpolationAlpha, character);
    // Mud/wet tyre ruts: stamp from FRESH wheel contact telemetry (post-integrate),
    // follow the car with deformCenter, upload the deform DataTexture.
    this.vehicleSystem?.syncMudFieldAfterPhysics?.(character, scaledDelta);
    this.frameStats.start('cutProps');
    this.enemyCutSystem.syncPhysicsProps(this.physicsSystem, this.physicsSystem.interpolationAlpha);
    this.frameStats.endSection();
    this.telekinesisSystem.updateThrownImpacts({
      enemies: this.enemySystem.enemies,
      physicsSystem: this.physicsSystem,
      enemySystem: this.enemySystem,
      enemyCutSystem: this.enemyCutSystem,
      propSystem: this.propSystem,
    });
    this.ropeSystem.syncRopeVisuals({
      level: this.levelSystem,
      physics: this.physicsSystem,
      character,
    });
    this.hookSwingSystem.syncVisuals({
      character,
      animationController: character.animationController,
    });

    const cameraInput = { ...input };
    const inVehicle = Boolean(this.vehicleSystem?.activeVehicle);
    cameraInput.rearViewHeld = inVehicle && Boolean(input.rearViewHeld || input.wingsuitHeld);
    if (this.enemyCutSystem.state === 'aiming' || inVehicle) {
      cameraInput.lookX = 0;
      cameraInput.lookY = 0;
    }

    if (this.rallyCinematicDemo?.active) {
      this.rallyCinematicDemo.update(scaledDelta, {
        vehicle: this.vehicleSystem?.activeVehicle,
        camera: this.cameraSystem.camera,
        level: this.levelSystem,
      });
    } else {
      this.cameraSystem.update({
        delta: scaledDelta,
        target: character.group.position,
        viewport: this.rendererSystem.getViewport(),
        input: cameraInput,
        rootMotionActive: isRootMotionCameraSmoothingActive(character),
        character,
        vehicle: this.vehicleSystem?.activeVehicle ?? null,
      });
    }

    // FP body yaw after look input: turn torso past neck limit so the camera
    // never stares into chest/shoulder interiors; forward move straightens body.
    this.firstPersonWeaponSystem.postCamera({
      character,
      cameraSystem: this.cameraSystem,
      input: cameraInput,
      delta: scaledDelta,
    });

    // M5–M7 hitscan fire / ADS / damage after camera so the ray matches look.
    this.frameStats.start('weapon');
    this.weaponSystem.update({
      delta: scaledDelta,
      input: gameplayInput,
      character,
      cameraSystem: this.cameraSystem,
      physicsSystem: this.physicsSystem,
      enemySystem: this.enemySystem,
      enemyCutSystem: this.enemyCutSystem,
      propSystem: this.propSystem,
      firstPersonWeaponSystem: this.firstPersonWeaponSystem,
      vehicleDamageSystem: this.vehicleDamageSystem,
      vehicleSystem: this.vehicleSystem,
      shootingRangeSystem: this.shootingRangeSystem,
    });
    this.frameStats.endSection();

    if (this.shootingRangeSystem.enabled) {
      this.shootingRangeSystem.update({
        delta: scaledDelta,
        input: gameplayInput,
        gunId: this.firstPersonWeaponSystem.equippedGunId,
        character,
        level: this.levelSystem.level,
        cameraSystem: this.cameraSystem,
      });
    }

    this.rendererSystem.resizeIfNeeded((viewport) => {
      this.cameraSystem.resize(viewport);
    });

    // Detect a nearby enterable building (on-foot only) and raise the HUD prompt.
    this.buildingEntrySystem.update({
      level: this.levelSystem.level,
      position: character.group.position,
      camera: this.cameraSystem.camera,
      enabled: !this.vehicleSystem?.activeVehicle && this.mountSystem?.state !== 'mounted',
    });

    // Skip the sky/env advance while inside a building so the suppressed interior
    // lighting isn't re-installed each frame.
    if (!this.insideBuilding && this.sceneSystem.skySystem?.update(delta, this.cameraSystem?.camera)) {
      this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
    }
    this._syncTerrainEnvironment(delta);

    const spectatorCrowd = this.levelSystem.level?.spectatorCrowd;
    if (spectatorCrowd?.update) {
      const activeVehicle = this.vehicleSystem?.activeVehicle;
      const focus = activeVehicle
        ? {
          position: activeVehicle.model?.position ?? character.group.position,
          speed: activeVehicle.speed ?? 0,
        }
        : character.group.position;
      spectatorCrowd.update(delta, this.cameraSystem.camera, focus);
    }

    const renderStart = performance.now();
    this.rendererSystem.render({
      scene: this.sceneSystem.scene,
      camera: this.cameraSystem.camera,
      // SSAO's nested scene pre-pass is the worst possible companion to a
      // first-seen terrain object. Reuse the previous AO target until the
      // bounded streaming/compile queue is quiet.
      deferExpensivePasses: streamingActive || this._streamingCompileActive,
    });
    spectatorCrowd?.onAfterRender?.();
    const renderMs = performance.now() - renderStart;

    this.frameStats.recordSystem('render', renderMs);
    this.frameStats.record(frameMs, streamingMs, renderMs, streamingActive);

    // Temporary: vehicle vertical-jump diagnostic. Toggle from the console with
    // __DREAMFALL_DEBUG__.vehicleJumpDiag(true), drive until a jump, then
    // __DREAMFALL_DEBUG__.dumpVehicleJumpDiag(). Records every frame whose chassis
    // vy changed sharply, with the context that would explain a TIMING-based jump
    // (long frame / GC), a STREAMING-based one, or a SNAPSHOT/React stall.
    if (this._jumpDiagEnabled) {
      const veh = this.vehicleSystem?.activeVehicle;
      const vy = veh ? veh.linearVelocity.y : 0;
      const dVy = vy - (this._jumpDiagPrevVy ?? vy);
      this._jumpDiagPrevVy = vy;
      const snapped = this.shouldEmitSnapshot(timeMs);
      if (veh && Math.abs(dVy) > (this._jumpDiagThreshold ?? 0.25)) {
        (this._jumpDiagLog ??= []).push({
          t: +(timeMs / 1000).toFixed(2),
          frameMs: +frameMs.toFixed(1),
          dVy: +dVy.toFixed(3),
          vy: +vy.toFixed(3),
          spd: +veh.speed.toFixed(1),
          streaming: !!streamingActive,
          builtColliders: streamingActive ? 1 : 0,
          willSnapshot: snapped,
        });
        if (this._jumpDiagLog.length > 200) this._jumpDiagLog.shift();
      }
    }

    this.emitSnapshot(timeMs);
  }

  /**
   * Stream + render only while stage is prewarming. Keeps city radius attach and
   * pipeline batch rAF compiles alive without running movement/combat/vehicles.
   */
  _updatePrewarmingFrame(timeMs, delta, frameMs) {
    const character = this.characterSystem.character;
    if (!character) {
      this.emitSnapshot();
      return;
    }

    this.rendererSystem.resizeIfNeeded((viewport) => {
      this.cameraSystem.resize(viewport);
    });

    let streamingMs = 0;
    let streamingActive = false;
    const streamStart = performance.now();
    const streamingFocus = character.group.position;
    const viewPos = this.cameraSystem?.camera?.position ?? streamingFocus;
    const streamingChanges = this.levelSystem.updateStreaming(streamingFocus, {
      viewPosition: viewPos,
    });
    const builtColliders = this.physicsSystem.applyStreamingChanges?.(streamingChanges) ?? 0;
    streamingMs = performance.now() - streamStart;
    streamingActive =
      builtColliders > 0 ||
      (streamingChanges?.addedChunks?.length ?? 0) > 0 ||
      (streamingChanges?.removedChunkKeys?.length ?? 0) > 0 ||
      (streamingChanges?.terrainVisualChanges ?? 0) > 0;

    if ((streamingChanges?.addedChunks?.length ?? 0) > 0) {
      this.queueStreamingCompile(streamingChanges.addedChunks.map((chunk) => chunk.group));
    }

    this.sceneSystem.updateShadowFollow?.(streamingFocus);
    this.sceneSystem.updateStreetLights?.(streamingFocus);
    this.frameStats.recordSystem('streaming', streamingMs);

    this.frameStats.start('bvh');
    this.levelSystem.warmupGeometryRaycasts({
      maxMs: streamingActive ? 1 : 2,
      maxCount: streamingActive ? 2 : 8,
    });
    this.frameStats.endSection();

    this.levelSystem.level?.updateForestEnvironment?.({
      sunDirection: this.sceneSystem.skySystem?.sunDirection,
      windVector: rainWind.value,
    });

    // Hold camera on spawn so prewarm batches and shadows compile from a stable view.
    this.cameraSystem.update({
      delta,
      target: character.group.position,
      viewport: this.rendererSystem.getViewport(),
      input: { lookX: 0, lookY: 0, rearViewHeld: false },
      rootMotionActive: false,
      character,
      vehicle: null,
    });

    if (this.sceneSystem.skySystem?.update(delta, this.cameraSystem?.camera)) {
      this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
    }
    this._syncTerrainEnvironment(delta);

    const renderStart = performance.now();
    this.rendererSystem.render({
      scene: this.sceneSystem.scene,
      camera: this.cameraSystem.camera,
      deferExpensivePasses: streamingActive || this._streamingCompileActive,
    });
    const renderMs = performance.now() - renderStart;
    this.frameStats.recordSystem('render', renderMs);
    this.frameStats.record(frameMs, streamingMs, renderMs, streamingActive);
    this.emitSnapshot(timeMs);
  }

  queueStreamingCompile(roots = []) {
    const renderer = this.rendererSystem.renderer;
    const camera = this.cameraSystem.camera;

    for (const root of roots) {
      if (!root) continue;
      sanitizeWebGPUVertexBuffers(root);
      if (renderer?.compileAsync && camera) {
        // Hide the chunk group until its render pipelines/materials are pre-warmed.
        // This prevents the next renderer.render() from stalling on first-seen
        // pipeline compilation (which shows up as main-thread jank).
        root.visible = false;
        this._streamingCompileQueue.push(root);
      } else {
        root.visible = true;
      }
    }

    if (!renderer?.compileAsync || !camera) {
      return;
    }

    if (this._streamingCompileActive) {
      return;
    }

    this._streamingCompileActive = true;
    const drain = async () => {
      while (!this.disposed && this._streamingCompileQueue.length > 0) {
        const root = this._streamingCompileQueue.shift();
        try {
          await renderer.compileAsync(root, camera);
        } catch (_) {
          // Non-fatal; first visible render can compile anything this missed.
        }
        // Reveal only after compile attempt completes (success or fail-open).
        if (root) root.visible = true;
      }
      this._streamingCompileActive = false;
    };

    drain();
  }

  // Teleport the character AND shift the chase camera by the same delta, so the
  // framing stays continuous across a large (pocket) teleport instead of the
  // camera flying across the world to catch up.
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

  snapshotIntervalMs() {
    const vehicleSpeed = this.vehicleSystem?.activeVehicle?.speed ?? 0;
    return this.cameraSystem?.photoMode
      || this.insideBuilding
      || vehicleSpeed >= SNAPSHOT_HEAVY_VEHICLE_SPEED
      ? SNAPSHOT_INTERVAL_HEAVY_MS
      : SNAPSHOT_INTERVAL_NORMAL_MS;
  }

  shouldEmitSnapshot(timeMs = performance.now()) {
    return timeMs - this.lastSnapshotAt >= this.snapshotIntervalMs();
  }

  emitSnapshot(timeMs = performance.now(), { force = false } = {}) {
    if (!force && !this.shouldEmitSnapshot(timeMs)) return false;
    this.lastSnapshotAt = timeMs;
    const full = force
      || !this._lastFullSnapshot
      || timeMs - this.lastFullSnapshotAt >= FULL_SNAPSHOT_INTERVAL_MS;
    this.onSnapshot(this.snapshot({ full }));
    if (full) this.lastFullSnapshotAt = timeMs;
    return true;
  }

  handleVisibilityChange() {
    this._visibilityPaused = document.visibilityState === 'hidden';
    this.lastFrameAt = performance.now();
    this.physicsSystem.stepAccumulator = 0;
    for (const vehicle of this.vehicleSystem?.vehicles ?? []) {
      vehicle.engineAudio?.mute?.(this._visibilityPaused);
      vehicle.tireEffects?.mute?.(this._visibilityPaused);
      vehicle.exteriorIdleAudio?.mute?.(this._visibilityPaused);
      vehicle.crashAudio?.mute?.(this._visibilityPaused);
    }
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

  snapshot({ full = true } = {}) {
    const playerObj = this.characterSystem.character?.group?.position;
    if (!full && this._lastFullSnapshot) {
      const renderer = this.rendererSystem.snapshot({ includeDrawStats: false });
      return {
        ...this._lastFullSnapshot,
        stage: this.stage,
        loadProgress: this.loadProgress,
        prewarm: this._cityPrewarmProgress,
        frame: this.frameStats.summary(),
        allocation: this.allocationSampler.status(),
        player: playerObj
          ? { x: playerObj.x, z: playerObj.z, yaw: this.cameraSystem.yaw ?? 0 }
          : null,
        buildingEntry: this.buildingEntrySnapshot(),
        screenFade: { alpha: this.screenFade.alpha },
        photorealismPreset: this.photorealismPresetId,
        animation: this.animationStateSystem.snapshot(),
        combat: this.combatSystem.snapshot(),
        firstPersonWeapon: this.firstPersonWeaponSystem.snapshot(),
        weapon: this.weaponSystem.snapshot(),
        ability: this.abilitySystem.snapshot(),
        shootingRange: this.shootingRangeSystem.snapshot(),
        character: this.characterSystem.snapshot(),
        vehicles: this.vehicleSystem.snapshot(),
        camera: this.cameraSystem.snapshot(),
        renderer: {
          ...renderer,
          drawStats: this._lastFullSnapshot.renderer?.drawStats ?? null,
        },
        viewport: this.rendererSystem.getViewport(),
        timing: this.timingSnapshot(),
        rallyCinematic: this.rallyCinematicDemo?.snapshot?.() ?? { active: false },
      };
    }

    const result = {
      stage: this.stage,
      loadProgress: this.loadProgress,
      prewarm: this._cityPrewarmProgress,
      frame: this.frameStats.summary(),
      allocation: this.allocationSampler.status(),
      player: playerObj
        ? { x: playerObj.x, z: playerObj.z, yaw: this.cameraSystem.yaw ?? 0 }
        : null,
      level: this.levelSystem.snapshot(),
      mudRuts: this._mudRutsSnapshot(),
      buildingEntry: this.buildingEntrySnapshot(),
      screenFade: { alpha: this.screenFade.alpha },
      physics: this.physicsSystem.snapshot(),
      ledgeHang: this.ledgeHangSystem.snapshot(),
      ledgeTraversal: this.ledgeTraversalSystem.snapshot(this.characterSystem.character),
      traversalRouter: this.traversalRouterSystem.snapshot(),
      wallRun: this.wallRunSystem.snapshot(this.characterSystem.character),
      wallClimb: this.wallClimbSystem.snapshot(),
      rope: this.ropeSystem.snapshot(this.characterSystem.character),
      hookSwing: this.hookSwingSystem.snapshot(this.characterSystem.character),
      vault: this.vaultSystem.snapshot(this.characterSystem.character),
      mount: this.mountSystem.snapshot(),
      ability: this.abilitySystem.snapshot(),
      animation: this.animationStateSystem.snapshot(),
      combat: this.combatSystem.snapshot(),
      firstPersonWeapon: this.firstPersonWeaponSystem.snapshot(),
      weapon: this.weaponSystem.snapshot(),
      shootingRange: this.shootingRangeSystem.snapshot(),
      character: this.characterSystem.snapshot(),
      crowd: this.crowdSystem?.snapshot?.() ?? null,
      spectatorCrowd: this.levelSystem.level?.spectatorCrowd?.snapshot?.() ?? null,
      enemies: this.enemySystem.snapshot(),
      enemyCut: this.enemyCutSystem.snapshot(),
      horse: this.horseSystem.snapshot(),
      vehicles: this.vehicleSystem.snapshot(),
      camera: this.cameraSystem.snapshot(),
      scene: this.sceneSystem.snapshot(),
      renderer: this.rendererSystem.snapshot(),
      photorealismPreset: this.photorealismPresetId,
      viewport: this.rendererSystem.getViewport(),
      timing: this.timingSnapshot(),
      telekinesis: this.telekinesisSystem.snapshot(),
      rallyCinematic: this.rallyCinematicDemo?.snapshot?.() ?? { active: false },
    };
    this._lastFullSnapshot = result;
    return result;
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

  timingSnapshot() {
    return {
      simTime: this.physicsSystem.simTime,
      stepsPerFrame: this.physicsSystem.stepsLastFrame,
      alpha: this.physicsSystem.interpolationAlpha,
      renderCap60: this.renderCap60,
      visibilityPaused: this._visibilityPaused,
      showHud: this.showTimingHud,
    };
  }

  _mudRutsSnapshot() {
    const field = this.levelSystem?.mudField ?? this.levelSystem?.level?.mudField ?? null;
    const scene = this.sceneSystem?.scene;
    const ribbons = [];
    scene?.traverse?.((obj) => {
      if (!obj?.isMesh) return;
      if (!/Mud Rally|Wet Rally/.test(obj.name || '')) return;
      ribbons.push({
        name: obj.name,
        verts: obj.geometry?.attributes?.position?.count ?? 0,
        hasPositionNode: Boolean(obj.material?.positionNode),
        hasColorNode: Boolean(obj.material?.colorNode),
      });
    });
    const center = field?.centerUniform?.value;
    const focus = this.vehicleSystem?.activeVehicle?.group?.position
      ?? this.characterSystem?.character?.group?.position
      ?? null;
    let sample = null;
    if (field && focus) {
      const s = field.sampleAt(focus.x, focus.z);
      sample = {
        depth: Number(s.depth.toFixed(4)),
        wetness: Number(s.wetness.toFixed(3)),
        tread: Number(s.tread.toFixed(3)),
        normalized: Number((s.depth / (field.maxDepth || 1)).toFixed(3)),
      };
    }
    const vehicles = this.vehicleSystem?.vehicles ?? [];
    return {
      hasMudField: Boolean(field),
      activeCells: field?.activeCount ?? 0,
      maxDepth: field?.maxDepth ?? null,
      footprint: field?.footprint ?? null,
      hasTexture: Boolean(field?.texture),
      hasOrientation: Boolean(field?.orientationTexture),
      prewornPoints: field?.prewornCount ?? 0,
      center: center
        ? { x: Number(center.x.toFixed(2)), z: Number((center.y ?? center.z ?? 0).toFixed(2)) }
        : null,
      focus: focus
        ? { x: Number(focus.x.toFixed(2)), z: Number(focus.z.toFixed(2)) }
        : null,
      sampleAtFocus: sample,
      ribbons,
      vehicles: vehicles.map((v) => ({
        groundSurface: v.groundSurface,
        speed: Number((v.speed ?? 0).toFixed(2)),
        wheels: (v.wheelTelemetry ?? []).map((w, i) => ({
          i,
          inContact: Boolean(w?.inContact),
          surface: w?.surface ?? v.groundSurface,
          rutDepth: Number((w?.rutDepth ?? 0).toFixed(3)),
        })),
      })),
    };
  }

  installDebugBridge() {
    this.debugBridge = {
      snapshot: () => this.snapshot(),
      getScene: () => this.sceneSystem?.scene,
      getThree: () => THREE,
      getCamera: () => this.cameraSystem?.camera,
      getCharacter: () => this.characterSystem?.character,
      // Perf-verification handles (verify-city-stage-performance.mjs). Returns the
      // raw level internals so the harness can assert collider-index consistency,
      // frozen-matrix validity, and run numeric ground-height parity checks
      // against the flat collider array. Same JS realm — methods are callable.
      getLevelHandles: () => ({
        colliderIndex: this.levelSystem?.level?.colliderIndex ?? null,
        colliders: this.levelSystem?.level?.colliders ?? null,
        geometryIndex: this.levelSystem?.level?.geometryIndex ?? null,
        mudField: this.levelSystem?.mudField ?? this.levelSystem?.level?.mudField ?? null,
      }),
      /** Mud/wet tyre-rut diagnostics: __DREAMFALL_DEBUG__.dumpMudRuts() */
      dumpMudRuts: () => this._mudRutsSnapshot(),
      /**
       * Force a deep test rut under the player/car (bypasses surface gates).
       *   __DREAMFALL_DEBUG__.forceMudRut()
       * If still invisible after this, the shader/material path is broken.
       * If visible, live stamping/surface gates are the issue.
       */
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
      setLightMode: (mode = 'hemisphere') => {
        const normalizedMode = mode === 'clustered' ? 'clustered' : 'hemisphere';
        this.rendererSystem.setLightingMode(normalizedMode);
        this.sceneSystem.setLightingMode(normalizedMode);
        this.sceneSystem.updateStreetLights(this.characterSystem.character?.group.position);
        return this.snapshot();
      },
      toggleLightMode: () => {
        const currentMode = this.rendererSystem.snapshot()?.lightingMode ?? 'hemisphere';
        const nextMode = currentMode === 'clustered' ? 'hemisphere' : 'clustered';
        this.rendererSystem.setLightingMode(nextMode);
        this.sceneSystem.setLightingMode(nextMode);
        this.sceneSystem.updateStreetLights(this.characterSystem.character?.group.position);
        return this.snapshot();
      },
      getLightMode: () => this.rendererSystem.snapshot()?.lightingMode ?? 'hemisphere',
      setTimeOfDay: (timeOfDay) => {
        if (this.sceneSystem.skySystem) {
          this.sceneSystem.skySystem.dynamicDay = false;
          this.sceneSystem.skySystem.setTimeOfDay(timeOfDay);
        }
        this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
        return this.snapshot();
      },
      setExposure: (exposure) => {
        this.rendererSystem.setExposure(exposure);
        return this.snapshot();
      },
      setWeather: (weather = 'clear') => {
        this.weatherSystem.setWeather(weather);
        return this.snapshot();
      },
      setPhotorealismPreset: (presetId = null) => {
        const normalized = presetId && presetId !== 'default' ? presetId : null;
        this.photorealismPresetId = setPhotorealismPresetId(normalized);
        this._applyPhotorealismRuntime();
        this.emitSnapshot();
        return this.snapshot();
      },
      // Traverse the scene and tally meshes by name (prefers the shared prefix).
      // Used to verify draw-call optimizations (e.g. building mesh-merge) actually
      // collapsed individual meshes. Use `renderer.info.render.drawCalls` (per frame)
      // for live GPU draw-call counts; `info.render.calls` is lifetime cumulative.
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
      // City furniture batching: one instanced draw per material signature city-wide.
      furnitureStats: () => this.levelSystem?.level?.cityChunks
        ? this.snapshot().level?.city?.furniture ?? null
        : null,
      startAllocationSample: (durationMs = 3000) => this.allocationSampler.start(durationMs),
      stopAllocationSample: () => this.allocationSampler.stop(),
      allocationSampleReport: () => this.allocationSampler.report(),
      // Dump each loaded city-chunk group and the meshes it contains. Used to
      // confirm streamed (worker-built) chunks attach to the scene and that
      // building merges ran in them too (not just the initial main-thread chunk).
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
      // Render-feature toggles (surfaced via the 'P' debug panel). Each mutates a
      // system + returns a fresh snapshot so the UI stays reactive.
      setFog: (enabled) => {
        this.weatherSystem.setWeather(enabled ? 'fog' : 'clear');
        return this.snapshot();
      },
      setSceneFog: (enabled) => {
        const result = this.sceneSystem.setSceneFogEnabled(Boolean(enabled));
        // Toggling scene.fog recompiles the crowd's basic material and rebuilds
        // its instanced pipelines outside invalidatePipeline, so re-prime here.
        this.levelSystem.level?.spectatorCrowd?.markPipelinesDirty?.();
        return result;
      },
      setShadows: (enabled) => {
        const on = Boolean(enabled);
        if (this.rendererSystem.renderer?.shadowMap) {
          this.rendererSystem.renderer.shadowMap.enabled = on;
        }
        if (this.sceneSystem?.sun) {
          this.sceneSystem.sun.castShadow = on;
        }
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
      setStreetLights: (enabled) => this.sceneSystem.setStreetLightsVisible(Boolean(enabled)),
      setSun: (enabled) => this.sceneSystem.setSunEnabled(Boolean(enabled)),
      setHemisphere: (enabled) => this.sceneSystem.setHemisphereEnabled(Boolean(enabled)),
      setHeadlights: (enabled) => this.vehicleSystem.setHeadlightsEnabled(Boolean(enabled)),
      // --- Vehicle vertical-jump diagnostic (temporary) ---
      // vehicleJumpDiag(true) starts recording sharp chassis vy changes while
      // driving; dumpVehicleJumpDiag() prints them with timing/streaming context so
      // we can tell a timing/GC jump from a streaming or snapshot one.
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
      setBladeDebug: (enabled) => {
        const combat = this.combatSystem;
        if (!combat) return this.snapshot();
        combat._bladeDebugEnabled = Boolean(enabled);
        if (!combat._bladeDebugEnabled) combat._clearBladeDebug?.();
        return this.snapshot();
      },
      forceHang: ({ ledgeName, mode, along } = {}) => {
        const character = this.characterSystem.character;
        const ledges = this.levelSystem.level?.ledges ?? [];
        const hangableLedges = ledges.filter((entry) => entry.y >= 1.7);
        const ledge =
          hangableLedges.find((entry) => entry.name === ledgeName) ??
          hangableLedges.find((entry) => entry.face === 'front') ??
          hangableLedges[0] ??
          ledges.find((entry) => entry.name === ledgeName) ??
          ledges[0];

        if (!character || !ledge) {
          return this.snapshot();
        }

        this.ledgeHangSystem.attachToLedge({
          character,
          ledge: {
            ...ledge,
            along: Number.isFinite(along) ? along : (ledge.min + ledge.max) * 0.5,
          },
          mode,
        });

        return this.snapshot();
      },
      forceWallClimb: ({ surfaceName, u = 0, v = 2.2 } = {}) => {
        const character = this.characterSystem.character;
        const surface =
          this.levelSystem.level?.climbSurfaces?.find((entry) => entry.name === surfaceName) ??
          this.levelSystem.level?.climbSurfaces?.[0];

        if (!character || !surface) {
          return this.snapshot();
        }

        this.wallClimbSystem.attach({
          character,
          surface: {
            ...surface,
            origin: vectorFromObject(surface.origin),
            normal: vectorFromObject(surface.normal),
            tangent: vectorFromObject(surface.tangent),
            up: vectorFromObject(surface.up),
            u,
            v,
          },
          input: { brace: false },
        });
        this.wallClimbSystem.snapActiveClimbToSurface(character);

        return this.snapshot();
      },
      forceWallRun: ({ surfaceName, u, v = 1.45, direction = 1 } = {}) => {
        const character = this.characterSystem.character;
        const surface =
          this.levelSystem.level?.wallRunSurfaces?.find((entry) => entry.name === surfaceName || `${entry.blockName} Wall Run Surface` === surfaceName) ??
          this.levelSystem.level?.wallRunSurfaces?.[0];

        if (!character || !surface) {
          return this.snapshot();
        }

        const hydratedSurface = {
          ...surface,
          origin: vectorFromObject(surface.origin),
          normal: vectorFromObject(surface.normal),
          tangent: vectorFromObject(surface.tangent),
          up: vectorFromObject(surface.up),
          u: Number.isFinite(u) ? u : (surface.minU + surface.maxU) * 0.5,
          v,
        };
        this.wallRunSystem.attach({
          character,
          surface: hydratedSurface,
          direction: direction < 0 ? -1 : 1,
        });

        return this.snapshot();
      },
      forceRope: ({ ropeName } = {}) => {
        const character = this.characterSystem.character;
        const rope =
          this.levelSystem.level?.ropes?.find((entry) => entry.name === ropeName) ??
          this.levelSystem.level?.ropes?.[0];

        if (!character || !rope) {
          return this.snapshot();
        }

        character.group.position.set(rope.anchor.x, rope.anchor.y - 2.65, rope.anchor.z);
        this.ropeSystem.attach({
          character,
          rope: {
            ...rope,
            anchor: vectorFromObject(rope.anchor),
            point: new THREE.Vector3(rope.anchor.x, rope.anchor.y - 2.65, rope.anchor.z),
            grabDistance: 2.65,
            swingTangent: vectorFromObject(rope.swingTangent),
          },
        });

        return this.snapshot();
      },
      forceHookSwing: () => {
        const character = this.characterSystem.character;
        if (!character) {
          return this.snapshot();
        }

        const candidate = this.levelSystem.findHookAttachCandidate({
          camera: this.cameraSystem.camera,
          playerPosition: character.group.position,
        });

        if (!candidate) {
          return { error: 'no hook candidate', snapshot: this.snapshot() };
        }

        this.hookSwingSystem.fireHook({
          character,
          candidate,
          movement: { direction: new THREE.Vector3(0, 0, -1), verticalVelocity: 0 },
        });
        return this.snapshot();
      },
      adjustSaddle: (boneNameOrOptions = {}, options = {}) => {
        this.horseSystem.adjustSaddle(normalizeSaddleCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      setSaddle: (boneNameOrOptions = {}, options = {}) => {
        this.horseSystem.setSaddle(normalizeSaddleCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      adjustSaddleOffset: (boneNameOrOptions = {}, options = {}) => {
        this.horseSystem.adjustSaddleOffset(normalizeSaddleCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      setSaddleOffset: (boneNameOrOptions = {}, options = {}) => {
        this.horseSystem.setSaddleOffset(normalizeSaddleCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      dumpHorseBones: (filter) => this.horseSystem.dumpBones(filter),
      adjustHorseBone: (boneNameOrOptions = {}, options = {}) => {
        return this.horseSystem.adjustBone(normalizeHorseBoneCommandOptions(boneNameOrOptions, options));
      },
      setHorseBone: (boneNameOrOptions = {}, options = {}) => {
        return this.horseSystem.setBone(normalizeHorseBoneCommandOptions(boneNameOrOptions, options));
      },
      resetHorseBone: (boneNameOrOptions = {}) => {
        return this.horseSystem.resetBone(normalizeHorseBoneCommandOptions(boneNameOrOptions));
      },
      setHorseFrontLegBend: (options = {}) => {
        this.horseSystem.setFrontLegBendCorrection(options);
        return this.snapshot();
      },
      resetHorseFrontLegBend: () => {
        this.horseSystem.resetFrontLegBendCorrection();
        return this.snapshot();
      },
      setHorseFrontLegIk: (options = {}) => {
        this.horseSystem.setFrontLegIk(options);
        return this.snapshot();
      },
      resetHorseFrontLegIk: () => {
        this.horseSystem.resetFrontLegIk();
        return this.snapshot();
      },
      setRiderSocket: (boneNameOrOptions = {}, options = {}) => {
        this.mountSystem.setRiderSocket(normalizeSaddleCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      adjustRiderSocket: (boneNameOrOptions = {}, options = {}) => {
        this.mountSystem.adjustRiderSocket(normalizeSaddleCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      resetRiderSocket: () => {
        this.mountSystem.resetRiderSocket();
        return this.snapshot();
      },
      setRiderGrip: (boneNameOrOptions = {}, options = {}) => {
        this.mountSystem.setRiderGrip(normalizeGripCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      adjustRiderGrip: (boneNameOrOptions = {}, options = {}) => {
        this.mountSystem.adjustRiderGrip(normalizeGripCommandOptions(boneNameOrOptions, options));
        return this.snapshot();
      },
      resetRiderGrip: () => {
        this.mountSystem.resetRiderGrip();
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

      // --- Sword socket tuning (hand attachment) ---
      dumpSwordSocket: () => {
        const character = this.characterSystem.character;
        const sword = character?.sword;
        if (!sword?.group) {
          return { error: 'no sword attached' };
        }
        const g = sword.group;
        const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
        return {
          position: { x: g.position.x, y: g.position.y, z: g.position.z },
          rotationDegrees: {
            x: THREE.MathUtils.radToDeg(e.x),
            y: THREE.MathUtils.radToDeg(e.y),
            z: THREE.MathUtils.radToDeg(e.z),
          },
          scale: g.scale.x,
          quaternion: [g.quaternion.x, g.quaternion.y, g.quaternion.z, g.quaternion.w],
        };
      },
      setSwordSocket: (options = {}) => {
        const character = this.characterSystem.character;
        const sword = character?.sword;
        if (!sword?.group) {
          console.warn('No sword attached');
          return this.snapshot();
        }
        const g = sword.group;
        if (options.position) {
          g.position.set(
            Number.isFinite(options.position.x) ? options.position.x : g.position.x,
            Number.isFinite(options.position.y) ? options.position.y : g.position.y,
            Number.isFinite(options.position.z) ? options.position.z : g.position.z
          );
        }
        if (options.rotationDegrees) {
          const current = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
          const rd = options.rotationDegrees;
          const e = new THREE.Euler(
            Number.isFinite(rd.x) ? THREE.MathUtils.degToRad(rd.x) : current.x,
            Number.isFinite(rd.y) ? THREE.MathUtils.degToRad(rd.y) : current.y,
            Number.isFinite(rd.z) ? THREE.MathUtils.degToRad(rd.z) : current.z,
            'XYZ'
          );
          g.quaternion.setFromEuler(e);
        }
        if (Number.isFinite(options.scale)) {
          g.scale.setScalar(options.scale);
        }
        return this.snapshot();
      },
      adjustSwordSocket: (options = {}) => {
        const character = this.characterSystem.character;
        const sword = character?.sword;
        if (!sword?.group) {
          console.warn('No sword attached');
          return this.snapshot();
        }
        const g = sword.group;
        if (options.position) {
          g.position.x += Number(options.position.x) || 0;
          g.position.y += Number(options.position.y) || 0;
          g.position.z += Number(options.position.z) || 0;
        }
        if (options.rotationDegrees) {
          const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'XYZ');
          const rd = options.rotationDegrees;
          e.x += Number.isFinite(rd.x) ? THREE.MathUtils.degToRad(rd.x) : 0;
          e.y += Number.isFinite(rd.y) ? THREE.MathUtils.degToRad(rd.y) : 0;
          e.z += Number.isFinite(rd.z) ? THREE.MathUtils.degToRad(rd.z) : 0;
          g.quaternion.setFromEuler(e);
        }
        if (Number.isFinite(options.scale)) {
          g.scale.multiplyScalar(options.scale);
        }
        return this.snapshot();
      },
      resetSwordSocket: () => {
        const character = this.characterSystem.character;
        const sword = character?.sword;
        if (!sword?.group) {
          console.warn('No sword attached');
          return this.snapshot();
        }
        const g = sword.group;
        // Match the baked defaults
        g.position.set(0, 5, 2);
        g.quaternion.setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(180),
          0,
          THREE.MathUtils.degToRad(-44),
          'XYZ'
        ));
        return this.snapshot();
      },
      // Authored body shell socketed to the generated car frame. All transforms
      // are local to the vehicle; rotations use degrees. When vehicleId is omitted,
      // commands target the car you are driving, then the first car with a body shell.
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
      // --- Rider roll diagnostics (temporary) ---
      // Spawn a test vehicle just ahead of the player and step onto it with the
      // mount key (F). domain: 'ground' | 'air' | 'water'. Returns the snapshot.
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
      // Diagnose why a spawned vehicle falls through: compares the analytic ground
      // (what the spawn snap uses) against whether a physics collider actually
      // exists under the spawn point (Rapier downward raycast). Run in the scene
      // where the car drops: __DREAMFALL_DEBUG__.diagnoseVehicleSpawn()
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
      forceMount: () => {
        const character = this.characterSystem.character;
        if (character && this.mountSystem.state === 'idle' && this.horseSystem.status === 'ready') {
          this.mountSystem.startMount(character);
        }
        return this.snapshot();
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
      setHorseYaw: (degrees = 0) => {
        if (this.horseSystem.group) {
          this.horseSystem.group.rotation.set(
            0,
            THREE.MathUtils.degToRad(degrees),
            0,
          );
        }
        return this.snapshot();
      },
      setRiderTimeScale: (scale = 1) => {
        const action = this.characterSystem.character?.animationController?.currentAction;
        if (action) {
          action.setEffectiveTimeScale(scale);
        }
        return this.snapshot();
      },
      dumpRiderBones: () => riderBoneDump(this.characterSystem.character),
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
      // Bisect a soldier so both halves exercise the ragdoll. By default cuts
      // the nearest soldier with a horizontal plane through its waist; pass
      // { enemyId } to target a specific one, and { normal: [x,y,z] } /
      // { heightFactor } to orient/place the plane (a vertical normal splits the
      // body left/right and throws the halves visibly apart, good for inspecting
      // articulation).
      cutNearestSoldier: ({ heightFactor = 0.5, enemyId = null, normal = [0, 1, 0] } = {}) => {
        const character = this.characterSystem.character;
        const enemies = this.enemySystem?.enemies ?? [];
        const origin = character?.group?.position ?? new THREE.Vector3();

        let target = null;
        if (enemyId != null) {
          target = enemies.find((e) => e?.id === enemyId && e?.archetype === 'soldier' && e.model) ?? null;
        } else {
          let nearestDistSq = Infinity;
          for (const enemy of enemies) {
            if (enemy?.archetype !== 'soldier' || !enemy.model) continue;
            const distSq = enemy.model.position.distanceToSquared(origin);
            if (distSq < nearestDistSq) {
              nearestDistSq = distSq;
              target = enemy;
            }
          }
        }
        if (!target) {
          return { cut: false, reason: 'no soldier found' };
        }

        const box = new THREE.Box3().setFromObject(target.model, true);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
        // Horizontal plane: place it at the requested body-height fraction
        // (waist cut). Anything else: run it through the body center so the cut
        // bisects the soldier cleanly (heightFactor is ignored).
        const constant = Math.abs(n.y) > 0.9
          ? -(box.min.y + size.y * heightFactor)
          : -center.dot(n);
        const plane = new THREE.Plane(n, constant);
        const ok = this.enemyCutSystem.applyDirectCut({
          enemy: target,
          plane,
          physicsSystem: this.physicsSystem,
          enemySystem: this.enemySystem,
          propSystem: this.propSystem,
          cutSystem: this.enemyCutSystem,
        });
        return {
          cut: !!ok,
          enemyId: target.id,
          position: { x: Number(target.model.position.x.toFixed(2)), y: Number(target.model.position.y.toFixed(2)), z: Number(target.model.position.z.toFixed(2)) },
          normal: [Number(n.x.toFixed(2)), Number(n.y.toFixed(2)), Number(n.z.toFixed(2))],
          constant: Number(constant.toFixed(2)),
          result: this.enemyCutSystem.lastResult,
        };
      },
      // World positions + types of every live cut prop (for verifying a cut
      // actually spawned visible pieces and where they ended up).
      cutProps: () => {
        const props = this.enemyCutSystem?.props ?? [];
        return props.map((prop) => {
          let position = null;
          if (prop.type === 'rigRagdoll') {
            const first = prop.ragdollBodies?.[0]?.body;
            if (first) {
              try {
                const w = prop.physicsWorld;
                const f = (w && first.handle != null) ? w.bodies.get(first.handle) : first;
                const t = f ? f.translation() : null;
                if (t) position = { x: Number(t.x.toFixed(2)), y: Number(t.y.toFixed(2)), z: Number(t.z.toFixed(2)) };
              } catch {}
            }
          } else if (prop.body) {
            try {
              const w = prop.physicsWorld;
              const f = (w && prop.body.handle != null) ? w.bodies.get(prop.body.handle) : prop.body;
              const t = f ? f.translation() : null;
              if (t) position = { x: Number(t.x.toFixed(2)), y: Number(t.y.toFixed(2)), z: Number(t.z.toFixed(2)) };
            } catch {}
          }
          return {
            type: prop.type,
            region: prop.region?.primary ?? null,
            verts: prop.ownedGeometries?.reduce((sum, g) => sum + (g?.attributes?.position?.count ?? 0), 0) ?? null,
            position,
            age: Number((prop.age ?? 0).toFixed(2)),
            visible: prop.root?.visible ?? prop.mesh?.visible ?? null,
          };
        });
      },
      startRallyCinematicDemo: () => this.startRallyCinematicDemo(),
      stopRallyCinematicDemo: () => this.stopRallyCinematicDemo(),
      toggleRallyCinematicDemo: () => this.toggleRallyCinematicDemo(),
      // Shader debug registry (docs/tsl-shader-debug-tweaking-plan.md)
      dumpShaderParams: () => getShaderDebugSnapshot(),
      applyShaderParams: (obj, opts) => applyShaderDebugSnapshot(obj, opts),
      // K5: rebake LUT only — no automatic PMREM reinstall.
      rebakeAtmosphereLut: () => {
        const provider = this.rendererSystem.cloudSkyProvider
          ?? this.sceneSystem.skySystem?.provider
          ?? null;
        const renderer = this.rendererSystem.renderer;
        if (!provider?.atmosphereLUT || !renderer) {
          return { ok: false, reason: 'no provider/renderer' };
        }
        try {
          provider.atmosphereLUT.markDirty();
          provider.prepareEnvironment(renderer);
          clearLutDirty();
          return { ok: true };
        } catch (err) {
          console.warn('[shader-debug] rebakeAtmosphereLut failed', err);
          return { ok: false, reason: err?.message ?? 'bake failed' };
        }
      },
      // K9: clear shape/lighting/wind pins BEFORE applying so systemWrite stamps
      // the full preset (clear-after would leave hybrid uniforms).
      setCloudPreset: (name) => {
        clearOverridesForFolders(['Clouds Shape', 'Clouds Lighting', 'Clouds Wind']);
        this.sceneSystem.skySystem?.setCloudPreset?.(name);
        return this.snapshot();
      },
      equipGun: (gunId) => this.equipGun(gunId),
      equipWeapon: (weaponId, opts) => this.equipWeapon(weaponId, opts),
      equipAbility: (abilityId) => this.equipAbility(abilityId),
      cycleAbility: (dir) => this.cycleAbility(dir),
      ability: () => this.abilitySystem.snapshot(),
      firstPersonWeapon: () => this.firstPersonWeaponSystem.snapshot(),
      weapon: () => this.weaponSystem.snapshot(),
    };
    globalThis.__DREAMFALL_DEBUG__ = this.debugBridge;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._loadGeneration += 1;
    this.stage = 'disposed';
    this.frameLoop.stop();
    this.rendererSystem.setAnimationLoop(null);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this.inputSystem.dispose();
    this.vaultSystem.dispose();
    this.mountSystem.dispose();
    this.combatSystem.dispose();
    this.firstPersonWeaponSystem.dispose();
    this.weaponSystem.dispose();
    this.shootingRangeSystem.dispose();
    this.enemySystem.dispose();
    this.crowdSystem.dispose?.();
    this.propSystem.dispose();
    this.enemyCutSystem.dispose();
    this.horseSystem.dispose();
    this.vehicleDamageSystem.dispose();
    this.vehicleSystem.dispose();
    this.rallyCinematicDemo?.stop?.();
    this.ledgeHangSystem.dispose();
    this.characterSystem.dispose();
    this.levelSystem.dispose();
    this.physicsSystem.dispose();
    this.hookSwingSystem.dispose();
    this.weatherSystem.dispose();
    this.sceneSystem.dispose?.();
    this.rendererSystem.dispose();

    if (globalThis.__DREAMFALL_DEBUG__ === this.debugBridge) {
      delete globalThis.__DREAMFALL_DEBUG__;
    }
  }
}

function hideUnsafeAsyncCompileObjects(scene) {
  const hidden = [];
  scene.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const unsafe = materials.some((material) =>
      material?.type === 'MeshSSSNodeMaterial'
      || material?.constructor?.name === 'MeshSSSNodeMaterial');
    if (!unsafe || object.visible === false) return;
    hidden.push(object);
    object.visible = false;
  });
  return () => {
    for (const object of hidden) object.visible = true;
  };
}

function isRootMotionCameraSmoothingActive(character) {
  return Boolean(character?.traversalAction || character?.hang?.transition || character?.wallRun?.active || character?.wallClimb?.active || character?.rope?.active || character?.hookSwing?.active || character?.vault?.active);
}

function horseSpawnPosition(characterPosition, levelSystem) {
  const position = new THREE.Vector3(
    (characterPosition?.x ?? 0) + 4.2,
    characterPosition?.y ?? 0,
    (characterPosition?.z ?? 0) - 3.6,
  );
  const ground = horseGroundHeight(levelSystem, position);

  if (Number.isFinite(ground)) {
    position.y = ground + HORSE_GROUND_OFFSET;
  }

  return position;
}

function horseGroundHeight(levelSystem, position) {
  return levelSystem.getGroundHeightAt(position, 0.7, {
    // Reject roofs and other tall city geometry near the spawn footprint while
    // still allowing ordinary terrain/road variation beneath the horse.
    maxStepUp: 0.65,
    maxSnapDown: 8,
    requiredInset: 0.12,
  });
}

function carSpawnPosition(horseSystem, characterPosition) {
  const horse = horseSystem.group;
  const position = horse?.position.clone() ?? characterPosition?.clone() ?? new THREE.Vector3();
  const side = new THREE.Vector3(1, 0, 0);

  if (horse) side.applyQuaternion(horse.quaternion).setY(0).normalize();
  return position.addScaledVector(side, 4.2);
}

const COLLISION_TEST_MAP_NAME = 'collision test track';

function isCollisionTestMap(worldMap) {
  return (worldMap?.name ?? '').trim().toLowerCase() === COLLISION_TEST_MAP_NAME;
}

async function spawnCollisionTestVehicles(vehicleSystem) {
  const target = { x: 0, z: 0 };
  const specs = [
    { name: 'West Runner', position: new THREE.Vector3(-80, 0, 0), rotationY: Math.PI / 2 },
    { name: 'East Runner', position: new THREE.Vector3(80, 0, 0), rotationY: -Math.PI / 2 },
  ];
  for (const spec of specs) {
    await vehicleSystem.spawnVehicle({
      vehicle: new BaseVehicle({
        name: spec.name,
        position: spec.position,
        rotationY: spec.rotationY,
        autopilot: { target, throttle: 1 },
      }),
    });
  }
}

function findChassisDebugVehicle(vehicleSystem, vehicleId = null) {
  const vehicles = vehicleSystem?.vehicles ?? [];
  if (vehicleId) {
    return vehicles.find((vehicle) => vehicle.id === vehicleId) ?? null;
  }
  if (vehicleSystem?.activeVehicle) return vehicleSystem.activeVehicle;
  return vehicles.find((vehicle) => vehicle.chassisOverlay) ?? vehicles[0] ?? null;
}

function normalizeHorseBoneCommandOptions(boneNameOrOptions, options = {}) {
  const normalized = typeof boneNameOrOptions === 'string'
    ? { ...options, boneName: boneNameOrOptions }
    : { ...(boneNameOrOptions ?? {}) };

  if (!normalized.rotationDegrees && normalized.rotation) {
    normalized.rotationDegrees = normalized.rotation;
  }

  if (!normalized.position && normalized.pos) {
    normalized.position = normalized.pos;
  }

  return normalized;
}

function normalizeSaddleCommandOptions(boneNameOrOptions, options = {}) {
  const normalized = normalizeHorseBoneCommandOptions(boneNameOrOptions, options);

  if (!normalized.position && normalized.offset) {
    normalized.position = normalized.offset;
  }

  return normalized;
}

function normalizeGripCommandOptions(boneNameOrOptions, options = {}) {
  return normalizeSaddleCommandOptions(boneNameOrOptions, options);
}

function vectorFromObject(source) {
  return new THREE.Vector3(source.x, source.y, source.z);
}

const riderEuler = new THREE.Euler(0, 0, 0, 'XYZ');

function riderTransformEuler(object) {
  const quaternion = object.quaternion;
  riderEuler.setFromQuaternion(quaternion, 'XYZ');
  const deg = (value) => Number(THREE.MathUtils.radToDeg(value).toFixed(2));

  return {
    quat: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    yawDeg: deg(riderEuler.y),
    pitchDeg: deg(riderEuler.x),
    rollDeg: deg(riderEuler.z),
  };
}

function riderBoneDump(character) {
  const controller = character?.animationController;
  const modelRoot = controller?.modelRoot;

  if (!modelRoot) {
    return { error: 'no rider model root' };
  }

  const bones = [];
  modelRoot.traverse((object) => {
    if (object.isBone) {
      const quaternion = object.quaternion;
      bones.push({ name: object.name, q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
    }
  });

  return {
    mountState: character?.mount?.state ?? null,
    animState: controller.currentState,
    group: riderTransformEuler(character.group),
    modelRoot: riderTransformEuler(modelRoot),
    bones,
  };
}
