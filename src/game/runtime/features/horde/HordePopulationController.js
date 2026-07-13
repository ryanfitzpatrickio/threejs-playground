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
export function attachHordePopulationController(target) {
  Object.assign(target, {
    _forceDemoteForEmergency() {
      const playerPosition = this.characterSystem?.character?.group?.position
        ?? this.enemySystem?.lastPlayerPosition
        ?? null;
      if (!playerPosition) return false;
      const minResidenceMs = HORDE_EMERGENCY_MIN_RESIDENCE * 1000;
      // No distance floor — combat needs a free slot even if the furthest actor
      // is still relatively close (still never demotes attackers/cuts/stagger).
      const candidate = this.enemySystem.findFurthestDemotableHordeActor(playerPosition, {
        minResidenceMs,
        demotionRadius: 0,
      });
      if (!candidate) return false;
      const descriptor = this.enemySystem.demoteHordeActorToDescriptor(candidate, {
        physicsSystem: this.physicsSystem,
        minResidenceMs,
        playerPosition,
        demotionRadius: 0,
      });
      if (!descriptor) return false;
      const proxy = this.hordeProxySystem?.addProxy?.(descriptor);
      if (!proxy) {
        this._spawnFullHordeDescriptor(descriptor, {
          countAsSpawn: false,
          respectFullLimit: false,
          replacingProxy: true,
        });
        return false;
      }
      return true;
    },
    _updateHordeFrontArc(playerPosition) {
      const centroid = this._hordeFrontArcCentroid ?? (this._hordeFrontArcCentroid = { x: 0, z: 0 });
      const count = this.hordeProxySystem?.mobCentroid?.(centroid) ?? 0;
      if (!playerPosition || count === 0) {
        if (this._hordeFrontArcActive) {
          this.enemySystem.setHordeFrontArc({ enabled: false });
          this._hordeFrontArcActive = false;
        }
        return;
      }
      const dx = centroid.x - playerPosition.x;
      const dz = centroid.z - playerPosition.z;
      if (dx * dx + dz * dz < 1e-6) return; // player on top of centroid — keep last
      const bearing = Math.atan2(dz, dx);
      this.enemySystem.setHordeFrontArc({ enabled: true, bearing });
      this._hordeFrontArcActive = true;
    },
    _processHordeDemotions(playerPosition) {
      if (!playerPosition || !this.hordeProxySystem?.ready) return 0;
      if (this.enemySystem.enemies.length < HORDE_FULL_ACTOR_LIMIT) return 0;
      if (!this.hordeProxySystem.hasPromotableNear(playerPosition, HORDE_PROXY_PROMOTION_RADIUS)) {
        return 0;
      }
    
      const minResidenceMs = HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000;
      const getFlowDistanceAt = (position) => this.getFlowDistanceAt(position);
      let demoted = 0;
      for (let i = 0; i < HORDE_PROXY_DEMOTIONS_PER_TICK; i += 1) {
        // Stop once we have freed a slot for the next promote pass this frame.
        if (this.enemySystem.enemies.length < HORDE_FULL_ACTOR_LIMIT) break;
        if (!this.hordeProxySystem.hasPromotableNear(playerPosition, HORDE_PROXY_PROMOTION_RADIUS)) {
          break;
        }
    
        // Rear of the mob = highest flow distance-to-goal among safe full actors.
        const candidate = this.enemySystem.findRearmostDemotableHordeActor(playerPosition, {
          minResidenceMs,
          demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
          getFlowDistanceAt,
        });
        if (!candidate) break;
    
        // Hysteresis in path distance: only demote when the rear full actor is
        // meaningfully behind the front of the promotable proxy mob (mob surged
        // past it). Falls back to euclidean when no field is built.
        const frontProxyFlow = this.hordeProxySystem.frontmostPromotableFlowDistance(
          playerPosition,
          HORDE_PROXY_PROMOTION_RADIUS,
        );
        const rearActorFlow = getFlowDistanceAt(candidate.model.position);
        if (Number.isFinite(frontProxyFlow) && Number.isFinite(rearActorFlow)) {
          if (rearActorFlow <= frontProxyFlow) break;
        } else {
          // No usable flow field — preserve the original euclidean guard.
          const nearestProxyDistSq = this.hordeProxySystem.nearestAgentDistanceSq(playerPosition);
          const dx = candidate.model.position.x - playerPosition.x;
          const dz = candidate.model.position.z - playerPosition.z;
          if (dx * dx + dz * dz <= nearestProxyDistSq) break;
        }
    
        const descriptor = this.enemySystem.demoteHordeActorToDescriptor(candidate, {
          physicsSystem: this.physicsSystem,
          minResidenceMs,
          playerPosition,
          demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
        });
        if (!descriptor) break;
        const proxy = this.hordeProxySystem.addProxy(descriptor);
        if (!proxy) {
          // Capacity full unexpectedly — re-promote to avoid losing the agent.
          this._spawnFullHordeDescriptor(descriptor, {
            countAsSpawn: false,
            respectFullLimit: false,
            replacingProxy: true,
          });
          break;
        }
        demoted += 1;
      }
      return demoted;
    },
    emergencyPromoteHordeProxy(proxyTarget) {
      if (!this.isHordePlaygroundActive() || !proxyTarget?.isHordeProxy) return null;
      const agent = proxyTarget.proxyAgent
        ?? this.hordeProxySystem?.findAgentById?.(proxyTarget.id);
      if (!agent || agent.health <= 0) return null;
    
      if (this.enemySystem.enemies.length >= HORDE_FULL_ACTOR_LIMIT) {
        const freed = this._forceDemoteForEmergency();
        if (!freed) return null;
      }
    
      const taken = this.hordeProxySystem.takeAgentById(agent.id);
      if (!taken) return null;
    
      const spawned = this._spawnFullHordeDescriptor({
        id: taken.id,
        archetype: taken.archetype,
        position: taken.position,
        yaw: taken.yaw,
        healthScale: taken.healthScale,
        health: taken.health,
        maxHealth: taken.maxHealth,
      }, {
        countAsSpawn: false,
        respectFullLimit: true,
        replacingProxy: true,
      });
      if (!spawned) {
        // Put the agent back so we never drop a living robot.
        this.hordeProxySystem.addProxy({
          id: taken.id,
          archetype: taken.archetype,
          position: taken.position,
          yaw: taken.yaw,
          healthScale: taken.healthScale,
          health: taken.health,
          maxHealth: taken.maxHealth,
          phase: taken.phaseOffset ?? taken.phase,
          ringAngle: taken.ringAngle,
          ringOffset: taken.ringOffset,
        });
        return null;
      }
    
      const enemy = this.enemySystem.enemies.find((entry) => entry.id === taken.id) ?? null;
      if (enemy) this.hordeProxySystem?.noteEmergencyPromote?.();
      return enemy;
    },
  });
}
