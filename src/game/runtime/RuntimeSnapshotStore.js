import {
  SNAPSHOT_INTERVAL_NORMAL_MS,
  SNAPSHOT_INTERVAL_HEAVY_MS,
  SNAPSHOT_HEAVY_VEHICLE_SPEED,
  FULL_SNAPSHOT_INTERVAL_MS,
} from './runtimeConstants.js';
import {
  getCameraFeel,
  getComfortEnabled,
  getOnFootFirstPerson,
} from '../config/cameraComfort.js';
import { getPhotorealismPresetId } from '../config/photorealismPresets.js';
import { bindRuntimeHost } from './bindRuntimeHost.js';

/** Snapshot cadence and full/partial composition. */
export class RuntimeSnapshotStore {
  constructor(host) {
    this._host = host;

    return bindRuntimeHost(this, host);
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

  snapshot({ full = true } = {}) {
    const playerObj = this.characterSystem.character?.group?.position;
    if (!full && this._lastFullSnapshot) {
      const renderer = this.rendererSystem.snapshot({ includeDrawStats: false });
      return {
        ...this._lastFullSnapshot,
        stage: this.stage,
        loadProgress: this.loadProgress,
        prewarm: this._cityPrewarmProgress,
        hordeScale: this.hordeScaleSnapshot(),
        hordeProxies: this.hordeProxySystem.snapshot(),
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
        vehicles: this.vehicleSystem.snapshot(
          this.characterSystem.character,
          this.platformRidingSystem,
        ),
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
      hordeScale: this.hordeScaleSnapshot(),
      hordeProxies: this.hordeProxySystem.snapshot(),
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
      vehicles: this.vehicleSystem.snapshot(
        this.characterSystem.character,
        this.platformRidingSystem,
      ),
      highwayTraffic: this.highwayTrafficSystem?.snapshot?.() ?? null,
      platforms: this.platformRidingSystem?.snapshot?.() ?? null,
      carLeap: this.carLeapSystem?.snapshot?.(this.characterSystem.character) ?? null,
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

}
