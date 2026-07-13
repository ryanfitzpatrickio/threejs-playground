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
import { bindRuntimeHost } from '../../bindRuntimeHost.js';

import { attachHordeSpawnController } from './HordeSpawnController.js';
import { attachHordePopulationController } from './HordePopulationController.js';
import { attachHordeCombatAdapter } from './HordeCombatAdapter.js';
import { attachHordeRuntimeSnapshot } from './hordeRuntimeSnapshot.js';

/**
 * Horde runtime feature coordinator — thin host for spawn/population/combat/telemetry.
 */
export class HordeRuntimeFeature {
  constructor(host) {
    this._host = host;
    this._hordeSpawnQueue = [];
    this._hordeSpawnQueueCursor = 0;
    this._hordeSpawnStats = {
      requestedTotal: 0,
      spawnedTotal: 0,
      lastBatch: 0,
      peakAlive: 0,
    };
    this._hordePlaygroundReady = false;
    this._hordePlaygroundLoading = null;
    this._hordeFrontArcActive = false;
    this._hordeFrontArcCentroid = null;
    this._hordeSpectaclePresetId = null;
    this._hordeSpectacleFullActorLimit = null;
    attachHordeSpawnController(this);
    attachHordePopulationController(this);
    attachHordeCombatAdapter(this);
    attachHordeRuntimeSnapshot(this);
    return bindRuntimeHost(this, host);
  }

}
