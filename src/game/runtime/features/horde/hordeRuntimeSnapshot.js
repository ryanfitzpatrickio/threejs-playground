import * as THREE from 'three';
import {
  HORDE_INITIAL_SPAWN_BURST,
  HORDE_IMMEDIATE_SPAWN_LIMIT,
  HORDE_FULL_ACTOR_LIMIT,
  HORDE_FULL_SHADOW_CASTER_LIMIT,
  HORDE_FULL_ACTOR_MIN_RESIDENCE,
  HORDE_EMERGENCY_MIN_RESIDENCE,
  HORDE_FULL_SPAWN_BATCH_PER_FRAME,
  HORDE_MAX_ENEMY_COUNT,
  HORDE_PROXY_DEMOTION_RADIUS,
  HORDE_PROXY_DEMOTIONS_PER_TICK,
  HORDE_PROXY_PROMOTION_RADIUS,
  HORDE_SPAWN_BATCH_PER_FRAME,
  HORDE_SUPPRESSION_PER_DAMAGE,
  HORDE_KNOCKBACK_BASE,
  HORDE_KNOCKBACK_PER_DAMAGE,
  HORDE_KNOCKBACK_DAMAGE_CAP,
  HORDE_ATTACK_TOKEN_LIMIT,
  HORDE_MAX_DETAILED_RAGDOLLS,
  HORDE_EXPLOSION_MAX_DETAILED,
  HORDE_EXPLOSION_DEFAULT_RADIUS,
  HORDE_DEFAULT_ENEMY_COUNT,
  clampHordeEnemyCount,
  getHordeSpectaclePreset,
} from '../../../config/hordePerformanceConfig.js';

/** Attach horde methods onto a host instance (HordeRuntimeFeature). */
export function attachHordeRuntimeSnapshot(target) {
  Object.assign(target, {
    isHordePlaygroundActive() {
      return this.levelMode === 'horde' || this._hordePlaygroundReady === true;
    },
    hordeScaleSnapshot() {
      const proxies = this.hordeProxySystem?.snapshot?.() ?? null;
      const cut = this.enemyCutSystem?.snapshot?.() ?? null;
      let attackers = 0;
      for (const enemy of this.enemySystem?.enemies ?? []) {
        if (enemy.state === 'attack') attackers += 1;
      }
      return {
        enabled: this.isHordePlaygroundActive(),
        nativeHordeLevel: this.levelMode === 'horde',
        cap: HORDE_MAX_ENEMY_COUNT,
        defaultGate: HORDE_DEFAULT_ENEMY_COUNT,
        spectaclePreset: this._hordeSpectaclePresetId ?? 'default',
        alive: this._hordeAliveEnemyCount(),
        occupied: this._hordeVisibleEnemyCount(),
        fullActors: this.enemySystem?.enemies?.length ?? 0,
        proxies: this.hordeProxySystem?.agents?.length ?? 0,
        proxyLiving: proxies?.living ?? 0,
        proxyCorpses: proxies?.corpses ?? 0,
        fullActorLimit: this._hordeSpectacleFullActorLimit ?? HORDE_FULL_ACTOR_LIMIT,
        attackTokenLimit: this.enemySystem?.attackTokenLimit ?? HORDE_ATTACK_TOKEN_LIMIT,
        attackers,
        maxDetailedRagdolls: HORDE_MAX_DETAILED_RAGDOLLS,
        detailedRagdolls: cut?.detailedRagdolls ?? cut?.rigRagdollProps ?? 0,
        queued: this._hordePendingSpawnCount(),
        requestedTotal: this._hordeSpawnStats.requestedTotal,
        spawnedTotal: this._hordeSpawnStats.spawnedTotal,
        lastBatch: this._hordeSpawnStats.lastBatch,
        peakAlive: this._hordeSpawnStats.peakAlive,
        spawnBatchPerFrame: HORDE_SPAWN_BATCH_PER_FRAME,
        fullSpawnBatchPerFrame: HORDE_FULL_SPAWN_BATCH_PER_FRAME,
        promotionRadius: HORDE_PROXY_PROMOTION_RADIUS,
        demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
        minResidenceSec: HORDE_FULL_ACTOR_MIN_RESIDENCE,
        promoted: proxies?.promoted ?? 0,
        demoted: proxies?.demoted ?? 0,
        emergencyPromoted: proxies?.emergencyPromoted ?? 0,
        lightweightKills: proxies?.lightweightKills ?? 0,
        areaKills: proxies?.areaKills ?? 0,
        poseCatalogSize: proxies?.poseCatalogSize ?? 0,
        stableSlots: proxies?.stableSlots ?? false,
        geometrySource: proxies?.geometrySource ?? null,
        proxyDrawCalls: proxies?.drawCalls ?? 0,
        combatGrid: proxies?.combatGrid ?? null,
        spatial: this.enemySystem?.spatialSnapshot?.() ?? null,
      };
    },
    applyHordeSpectaclePreset(presetId = 'default') {
      const preset = getHordeSpectaclePreset(presetId);
      this._hordeSpectaclePresetId = preset.id;
      this._hordeSpectaclePreset = preset;
    
      // Tip combat budgets.
      this.enemySystem.attackTokenLimit = preset.attackTokens ?? HORDE_ATTACK_TOKEN_LIMIT;
      if (Number.isFinite(preset.fullActorLimit)) {
        // Soft note only — full actor hard cap remains HORDE_FULL_ACTOR_LIMIT for
        // promote safety; lower spectacle tiers may prefer fewer tip actors.
        this._hordeSpectacleFullActorLimit = preset.fullActorLimit;
      }
    
      // Density flock tuning (readability columns / front).
      this.hordeProxySystem?.applySpectacleTuning?.({
        flock: preset.flock,
        farWalkWeight: preset.farWalkWeight,
        farWalkDistance: preset.farWalkDistance,
      });
    
      // Atmosphere — soft fog so depth bands separate tip from body.
      this._applyHordeSpectacleAtmosphere(preset);
    
      return {
        id: preset.id,
        label: preset.label,
        count: preset.count,
        attackTokens: preset.attackTokens,
        fullActorLimit: preset.fullActorLimit,
      };
    },
    _applyHordeSpectacleAtmosphere(preset) {
      // Fog is optional spectacle chrome; only force it on the dedicated horde map.
      if (this.levelMode !== 'horde' || !preset) return;
      const fogOn = preset.fogEnabled === true;
      const density = preset.fogDensity ?? 0.007;
      const colorHex = preset.fogColor ?? 0xb8c0c8;
      const level = this.levelSystem?.level;
      if (level?.hordeEnvironment) {
        level.hordeEnvironment.fogEnabled = fogOn;
        level.hordeEnvironment.fogDensity = density;
        level.hordeEnvironment.fogColor = colorHex;
      }
      this.sceneSystem?.setSceneFogEnabled?.(fogOn);
      if (!fogOn) return;
      // Linear scene fog: density maps to far plane so higher spectacle = denser haze.
      const far = Math.min(160, Math.max(55, 0.55 / Math.max(0.003, density)));
      const near = far * 0.32;
      const fog = this.sceneSystem?._sceneFog;
      if (fog) {
        fog.near = near;
        fog.far = far;
        fog.color?.setHex?.(colorHex);
      }
    },
  });
}
