import { FrameLoop } from '../core/FrameLoop.js';
import { applyCityLevelOverrides } from '../config/cityPerformance.js';
import { applyRangeLevelOverrides } from '../config/rangePerformance.js';
import { applyHordeLevelOverrides } from '../config/hordePerformance.js';
import {
  getPhotorealismPresetId,
  mergePhotorealismEnvironment,
} from '../config/photorealismPresets.js';
import { createRuntimeServices } from './createRuntimeServices.js';
import { HordeRuntimeFeature } from './features/horde/HordeRuntimeFeature.js';
import { InteriorRuntimeFeature } from './features/InteriorRuntimeFeature.js';
import { VehicleRuntimeFeature } from './features/VehicleRuntimeFeature.js';
import { DeathmatchRuntimeFeature } from './features/deathmatch/DeathmatchRuntimeFeature.js';
import { SimsRuntimeFeature } from './features/sims/SimsRuntimeFeature.js';
import { DogParkRuntimeFeature } from './features/dogPark/DogParkRuntimeFeature.js';
import { RuntimeCommands } from './RuntimeCommands.js';
import { RuntimeSnapshotStore } from './RuntimeSnapshotStore.js';
import { RuntimeVisibility } from './RuntimeVisibility.js';
import { RuntimeEnvironment } from './RuntimeEnvironment.js';
import { PipelinePrewarmer } from './PipelinePrewarmer.js';
import { RuntimeLifecycle } from './RuntimeLifecycle.js';
import { RuntimeLoader } from './RuntimeLoader.js';
import { RuntimeFramePipeline } from './RuntimeFramePipeline.js';
import { RuntimeDebugHost } from '../debug/runtime/RuntimeDebugHost.js';
import { createModeController } from './modes/createModeController.js';
import { validateFramePlan } from './runtimeFramePlan.js';

/**
 * Runtime kernel — owns system wiring, lifecycle, frame loop, and feature assembly.
 * Public callers use GameRuntime facade.
 * Adding a new system: register in createRuntimeServices / lifecycle / runtimeFramePlan /
 * feature modules — not GameRuntime.js.
 */
export class RuntimeKernel {
  constructor({
    canvas,
    qualityPreset = {},
    qualityLevel = 'high',
    onSnapshot,
    levelMode = 'city',
    networkSystem = null,
  }) {
    this.canvas = canvas;
    this.levelMode = ['world', 'wilds', 'rally', 'range', 'horde', 'highway', 'deathmatch', 'sims', 'dog-park'].includes(levelMode) ? levelMode : 'city';
    this.qualityLevel = qualityLevel;
    // App-owned deathmatch socket (optional). Offline deathmatch leaves this null.
    this.networkSystem = networkSystem ?? null;
    this.qualityPreset = applyHordeLevelOverrides(
      applyRangeLevelOverrides(
        applyCityLevelOverrides(qualityPreset, qualityLevel, this.levelMode),
        this.levelMode,
      ),
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

    const services = createRuntimeServices({
      canvas,
      qualityPreset: this.qualityPreset,
      levelMode: this.levelMode,
    });
    Object.assign(this, services);

    this.renderCap60 = Boolean(qualityPreset.renderCap60);
    this._visibilityPaused = false;
    this.showTimingHud = false;
    this._onVisibilityChange = () => this.handleVisibilityChange();

    // Features / mode controllers / stores (host = this kernel)
    this.hordeGi = null;
    this.hordeFeature = new HordeRuntimeFeature(this);
    this.interiorFeature = new InteriorRuntimeFeature(this);
    this.vehicleFeature = new VehicleRuntimeFeature(this);
    this.deathmatchFeature = this.levelMode === 'deathmatch'
      ? new DeathmatchRuntimeFeature(this)
      : null;
    this.simsFeature = new SimsRuntimeFeature(this);
    this.dogParkFeature = new DogParkRuntimeFeature(this);
    this.commands = new RuntimeCommands(this);
    this.snapshotStore = new RuntimeSnapshotStore(this);
    this.visibility = new RuntimeVisibility(this);
    this.environment = new RuntimeEnvironment(this);
    this.prewarmer = new PipelinePrewarmer(this);
    this.lifecycle = new RuntimeLifecycle(this);

    this.loader = new RuntimeLoader(this);
    this.framePipeline = new RuntimeFramePipeline(this);
    this.debugHost = new RuntimeDebugHost(this);
    this.modeController = createModeController(this.levelMode, this);
    this.highwayMode = this.levelMode === 'highway' ? this.modeController : null;
    validateFramePlan();

    // Compatibility: interior state mirrored for existing snapshot/update paths
    // that still read this.insideBuilding etc. via feature getters below.
  }

  get insideBuilding() { return this.interiorFeature.insideBuilding; }
  set insideBuilding(v) { this.interiorFeature.insideBuilding = v; }
  get screenFade() { return this.interiorFeature.screenFade; }
  set screenFade(v) { this.interiorFeature.screenFade = v; }
  get _elevatorTransition() { return this.interiorFeature._elevatorTransition; }
  set _elevatorTransition(v) { this.interiorFeature._elevatorTransition = v; }
  get _interiorCache() { return this.interiorFeature._interiorCache; }
  get _interiorSlotCount() { return this.interiorFeature._interiorSlotCount; }
  set _interiorSlotCount(v) { this.interiorFeature._interiorSlotCount = v; }

  // Horde state mirrors
  get _hordeSpawnQueue() { return this.hordeFeature._hordeSpawnQueue; }
  set _hordeSpawnQueue(v) { this.hordeFeature._hordeSpawnQueue = v; }
  get _hordeSpawnQueueCursor() { return this.hordeFeature._hordeSpawnQueueCursor; }
  set _hordeSpawnQueueCursor(v) { this.hordeFeature._hordeSpawnQueueCursor = v; }
  get _hordeSpawnStats() { return this.hordeFeature._hordeSpawnStats; }
  set _hordeSpawnStats(v) { this.hordeFeature._hordeSpawnStats = v; }
  get _hordePlaygroundReady() { return this.hordeFeature._hordePlaygroundReady; }
  set _hordePlaygroundReady(v) { this.hordeFeature._hordePlaygroundReady = v; }
  get _hordePlaygroundLoading() { return this.hordeFeature._hordePlaygroundLoading; }
  set _hordePlaygroundLoading(v) { this.hordeFeature._hordePlaygroundLoading = v; }


  _spawnHordeSmokeBots(...args) {
    return this.hordeFeature._spawnHordeSmokeBots(...args);
  }


  isHordePlaygroundActive(...args) {
    return this.hordeFeature.isHordePlaygroundActive(...args);
  }


  async ensureHordePlaygroundReady(...args) {
    return await this.hordeFeature.ensureHordePlaygroundReady(...args);
  }


  spawnHordeBenchmark(...args) { return this.hordeFeature.spawnHordeBenchmark(...args); }

  sampleHordeBenchmark(...args) {
    return this.hordeFeature.sampleHordeBenchmark(...args);
  }


  spawnHordeEnemies(...args) {
    return this.hordeFeature.spawnHordeEnemies(...args);
  }


  _buildHordeSpawnDescriptors(...args) {
    return this.hordeFeature._buildHordeSpawnDescriptors(...args);
  }


  _spawnHordeDescriptor(...args) {
    return this.hordeFeature._spawnHordeDescriptor(...args);
  }


  _spawnFullHordeDescriptor(...args) { return this.hordeFeature._spawnFullHordeDescriptor(...args); }

  getHordeCombatTargets(...args) {
    return this.hordeFeature.getHordeCombatTargets(...args);
  }


  applyHordeExplosion(...args) { return this.hordeFeature.applyHordeExplosion(...args); }

  convertHordeDeathToProxyCorpse(...args) {
    return this.hordeFeature.convertHordeDeathToProxyCorpse(...args);
  }


  emergencyPromoteHordeProxy(...args) {
    return this.hordeFeature.emergencyPromoteHordeProxy(...args);
  }


  resolveHordeCombatTarget(...args) {
    return this.hordeFeature.resolveHordeCombatTarget(...args);
  }


  _forceDemoteForEmergency(...args) {
    return this.hordeFeature._forceDemoteForEmergency(...args);
  }


  _processHordeSpawnQueue(...args) {
    return this.hordeFeature._processHordeSpawnQueue(...args);
  }


  _hordePendingSpawnCount(...args) {
    return this.hordeFeature._hordePendingSpawnCount(...args);
  }


  _hordeVisibleEnemyCount(...args) {
    return this.hordeFeature._hordeVisibleEnemyCount(...args);
  }


  _hordeAliveEnemyCount(...args) {
    return this.hordeFeature._hordeAliveEnemyCount(...args);
  }


  getFlowDistanceAt(...args) {
    return this.hordeFeature.getFlowDistanceAt(...args);
  }


  depositSuppression(...args) {
    return this.hordeFeature.depositSuppression(...args);
  }


  applyTipKnockback(...args) {
    return this.hordeFeature.applyTipKnockback(...args);
  }


  _updateHordeFrontArc(...args) {
    return this.hordeFeature._updateHordeFrontArc(...args);
  }


  _processHordeDemotions(...args) {
    return this.hordeFeature._processHordeDemotions(...args);
  }


  _compactHordeSpawnQueue(...args) {
    return this.hordeFeature._compactHordeSpawnQueue(...args);
  }


  hordeScaleSnapshot(...args) {
    return this.hordeFeature.hordeScaleSnapshot(...args);
  }


  clearHordeEnemies(...args) {
    return this.hordeFeature.clearHordeEnemies(...args);
  }


  applyHordeSpectaclePreset(...args) {
    return this.hordeFeature.applyHordeSpectaclePreset(...args);
  }


  _applyHordeSpectacleAtmosphere(...args) {
    return this.hordeFeature._applyHordeSpectacleAtmosphere(...args);
  }


  async fillHordeToPreset(...args) {
    return await this.hordeFeature.fillHordeToPreset(...args);
  }


  async fillHordeToCount(...args) {
    return await this.hordeFeature.fillHordeToCount(...args);
  }


  applyHordeHealthScale(...args) {
    return this.hordeFeature.applyHordeHealthScale(...args);
  }


  _teleportPlayer(...args) {
    return this.interiorFeature._teleportPlayer(...args);
  }


  _getOrBuildInterior(...args) {
    return this.interiorFeature._getOrBuildInterior(...args);
  }


  _enterBuilding(...args) {
    return this.interiorFeature._enterBuilding(...args);
  }


  _suppressOutdoorLighting(...args) {
    return this.interiorFeature._suppressOutdoorLighting(...args);
  }


  _restoreOutdoorLighting(...args) {
    return this.interiorFeature._restoreOutdoorLighting(...args);
  }


  _isAtInteriorDoor(...args) {
    return this.interiorFeature._isAtInteriorDoor(...args);
  }


  _isAtElevator(...args) {
    return this.interiorFeature._isAtElevator(...args);
  }


  _readElevatorFloorInput(...args) {
    return this.interiorFeature._readElevatorFloorInput(...args);
  }


  _startElevatorRide(...args) {
    return this.interiorFeature._startElevatorRide(...args);
  }


  _tickElevatorTransition(...args) {
    return this.interiorFeature._tickElevatorTransition(...args);
  }


  _completeElevatorTeleport(...args) {
    return this.interiorFeature._completeElevatorTeleport(...args);
  }


  _exitBuilding(...args) {
    return this.interiorFeature._exitBuilding(...args);
  }


  buildingEntrySnapshot(...args) {
    return this.interiorFeature.buildingEntrySnapshot(...args);
  }


  async _initializeHighwayVehicles(...args) {
    return await this.highwayMode?._initializeHighwayVehicles?.(...args);
  }


  _highwayProtectedVehicles(...args) {
    return this.highwayMode?._highwayProtectedVehicles?.(...args) ?? new Set();
  }


  _resolveHighwayDebugFlag(...args) {
    return this.highwayMode?._resolveHighwayDebugFlag?.(...args) ?? false;
  }


  _spawnHighwayTestPlatform(...args) {
    return this.highwayMode?._spawnHighwayTestPlatform?.(...args) ?? null;
  }


  _spawnHighwayCombatDeck(...args) {
    return this.highwayMode?._spawnHighwayCombatDeck?.(...args) ?? null;
  }


  _applyVehicleRunOver(...args) {
    return this.vehicleFeature._applyVehicleRunOver(...args);
  }


  setRenderCap60(...args) {
    return this.commands.setRenderCap60(...args);
  }


  setPhotoMode(...args) {
    return this.commands.setPhotoMode(...args);
  }


  setPhotoModeLive(...args) {
    return this.commands.setPhotoModeLive(...args);
  }


  _photoModeLockedInput(...args) {
    return this.commands._photoModeLockedInput(...args);
  }


  startRallyCinematicDemo(...args) {
    return this.commands.startRallyCinematicDemo(...args);
  }


  stopRallyCinematicDemo(...args) {
    return this.commands.stopRallyCinematicDemo(...args);
  }


  toggleRallyCinematicDemo(...args) {
    return this.commands.toggleRallyCinematicDemo(...args);
  }


  setPhotoSetting(...args) {
    return this.commands.setPhotoSetting(...args);
  }


  cycleVehicleCameraMode(...args) {
    return this.commands.cycleVehicleCameraMode(...args);
  }


  setVehicleCameraMode(...args) {
    return this.commands.setVehicleCameraMode(...args);
  }


  setCameraComfortEnabled(...args) {
    return this.commands.setCameraComfortEnabled(...args);
  }


  setCameraFeel(...args) {
    return this.commands.setCameraFeel(...args);
  }


  setOnFootFirstPersonEnabled(...args) {
    return this.commands.setOnFootFirstPersonEnabled(...args);
  }


  setWeaponShakeScale(...args) {
    return this.commands.setWeaponShakeScale(...args);
  }


  async equipGun(...args) {
    return await this.commands.equipGun(...args);
  }


  equipWeapon(...args) {
    return this.commands.equipWeapon(...args);
  }


  equipAbility(...args) {
    return this.commands.equipAbility(...args);
  }


  cycleAbility(...args) {
    return this.commands.cycleAbility(...args);
  }


  cycleCameraFeel(...args) {
    return this.commands.cycleCameraFeel(...args);
  }


  getClothColliderEditorSnapshot(...args) {
    return this.commands.getClothColliderEditorSnapshot(...args);
  }


  setClothColliderEditorEnabled(...args) {
    return this.commands.setClothColliderEditorEnabled(...args);
  }


  selectClothCollider(...args) {
    return this.commands.selectClothCollider(...args);
  }


  addClothCollider(...args) {
    return this.commands.addClothCollider(...args);
  }


  updateClothCollider(...args) {
    return this.commands.updateClothCollider(...args);
  }


  updateJacketSocketTransform(...args) {
    return this.commands.updateJacketSocketTransform(...args);
  }


  removeClothCollider(...args) {
    return this.commands.removeClothCollider(...args);
  }


  async resetJacketCloth(...args) {
    return await this.commands.resetJacketCloth(...args);
  }


  importClothColliderProfile(...args) {
    return this.commands.importClothColliderProfile(...args);
  }


  exportClothColliderProfile(...args) {
    return this.commands.exportClothColliderProfile(...args);
  }


  snapshotIntervalMs(...args) {
    return this.snapshotStore.snapshotIntervalMs(...args);
  }


  shouldEmitSnapshot(timeMs = performance.now()) {
    return this.snapshotStore.shouldEmitSnapshot(timeMs);
  }

  emitSnapshot(timeMs = performance.now(), { force = false } = {}) {
    return this.snapshotStore.emitSnapshot(...arguments);
  }

  snapshot(...args) {
    return this.snapshotStore.snapshot(...args);
  }


  timingSnapshot(...args) {
    return this.snapshotStore.timingSnapshot(...args);
  }


  _mudRutsSnapshot(...args) {
    return this.snapshotStore._mudRutsSnapshot(...args);
  }


  handleVisibilityChange(...args) {
    return this.visibility.handleVisibilityChange(...args);
  }


  _applyPhotorealismRuntime(...args) {
    return this.environment._applyPhotorealismRuntime(...args);
  }


  _syncTerrainEnvironment(...args) {
    return this.environment._syncTerrainEnvironment(...args);
  }


  async _runPrewarm(...args) {
    return await this.prewarmer._runPrewarm(...args);
  }


  async _prewarmShaders(...args) {
    return await this.prewarmer._prewarmShaders(...args);
  }


  _updatePrewarmingFrame(...args) {
    return this.prewarmer._updatePrewarmingFrame(...args);
  }


  queueStreamingCompile(...args) {
    return this.prewarmer.queueStreamingCompile(...args);
  }


  _aborted(...args) {
    return this.lifecycle._aborted(...args);
  }


  _setLoadProgress(...args) {
    return this.lifecycle._setLoadProgress(...args);
  }


  _tryEnterRunning(...args) {
    return this.lifecycle._tryEnterRunning(...args);
  }


  async _waitNearFieldReady(...args) {
    return await this.lifecycle._waitNearFieldReady(...args);
  }



  async start() {
    return this.loader.start();
  }

  async _streamAssetsInBackground() {
    return this.loader.streamAssetsInBackground();
  }

  update(timeMs) {
    return this.framePipeline.update(timeMs);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._loadGeneration += 1;
    this.stage = 'disposed';
    this.frameLoop.stop();
    this.rendererSystem.setGodRaysLight?.(null);
    this.sceneSystem.clearRangeShadows?.();
    this.rendererSystem.setAnimationLoop(null);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    try {
      this.hordeGi?.dispose?.();
    } catch { /* ignore */ }
    this.hordeGi = null;
    this.inputSystem.dispose();
    this.vaultSystem.dispose();
    this.mountSystem.dispose();
    this.combatSystem.dispose();
    this.firstPersonWeaponSystem.dispose();
    this.weaponSystem.dispose();
    this.shootingRangeSystem.dispose();
    this.aquariumBreachSystem?.dispose?.();
    this.propaneTankSystem?.dispose?.();
    this.hordeProxySystem.dispose();
    this.enemySystem.dispose();
    this.crowdSystem.dispose?.();
    this.propSystem.dispose();
    this.carryItemSystem?.dispose?.();
    this.enemyCutSystem.dispose();
    this.horseSystem.dispose();
    // Highway / platform bookkeeping before VehicleSystem / LevelSystem teardown.
    this.highwayTrafficSystem?.dispose?.();
    this.highwayTrafficSystem = null;
    this._highwayPlayerVehicle = null;
    this._highwayTestPlatform = null;
    this.carLeapSystem?.dispose?.();
    this.platformRidingSystem?.dispose?.();
    this.vehicleDamageSystem.dispose();
    this.vehicleSystem.dispose();
    this.rallyCinematicDemo?.stop?.();
    this.ledgeHangSystem.dispose();
    this.deathmatchFeature?.dispose?.();
    this.deathmatchFeature = null;
    this.simsFeature?.dispose?.();
    this.dogParkFeature?.dispose?.();
    this.remotePlayerSystem?.dispose?.();
    this.characterSystem.dispose();
    this.levelSystem.dispose();
    this.physicsSystem.dispose();
    this.hookSwingSystem.dispose();
    this.weatherSystem.dispose();
    this.sceneSystem.dispose?.();
    this.rendererSystem.dispose();

    this.debugHost?.uninstall?.();
  }

  /** Late-bind the App-owned deathmatch socket after kernel construction. */
  setNetworkSystem(network) {
    this.networkSystem = network ?? null;
    this.deathmatchFeature?.setNetworkSystem?.(this.networkSystem);
  }


  installDebugBridge() {
    return this.debugHost.install();
  }

  getCutTargets() {
    return [
      ...this.enemySystem.enemies,
      ...this.propSystem.props,
      ...this.enemyCutSystem.getRecuttableChunkTargets(),
    ];
  }



}

export function createRuntimeKernel(options) {
  return new RuntimeKernel(options);
}
