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
export function attachHordeCombatAdapter(target) {
  Object.assign(target, {
    getHordeCombatTargets({ focus = null, radius = 28 } = {}) {
      const full = this.getCutTargets?.() ?? this.enemySystem?.enemies ?? [];
      if (!this.isHordePlaygroundActive() || !this.hordeProxySystem?.ready) return full;
      let proxies;
      if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.z)) {
        proxies = this.hordeProxySystem.getHitTargetsNear?.(focus.x, focus.z, radius)
          ?? this.hordeProxySystem.getHitTargets?.()
          ?? [];
      } else {
        proxies = this.hordeProxySystem.getHitTargets?.() ?? [];
      }
      if (!proxies.length) return full;
      return full.concat(proxies);
    },
    applyHordeExplosion({
      point,
      radius = HORDE_EXPLOSION_DEFAULT_RADIUS,
      damage = 200,
      maxDetailed = HORDE_EXPLOSION_MAX_DETAILED,
    } = {}) {
      if (!this.isHordePlaygroundActive() || !point) {
        return { hit: 0, killed: 0, detailed: 0, fullHits: 0 };
      }
      const x = point.x;
      const z = point.z;
      const r = Math.max(0.1, Number(radius) || HORDE_EXPLOSION_DEFAULT_RADIUS);
      const dmg = Math.max(0, Number(damage) || 0);
      const detailedBudget = Math.max(0, Math.floor(Number(maxDetailed) || 0));
    
      // Suppression wall under the blast.
      this.depositSuppression(point, dmg);
    
      const proxyResult = this.hordeProxySystem?.applyAreaDamage?.({
        x, z, radius: r, damage: dmg,
      }) ?? { hit: 0, killed: 0, damaged: [] };
    
      // Full actors in radius — damage HP; queue detailed deaths against budget.
      let fullHits = 0;
      let detailed = 0;
      const rSq = r * r;
      const fullVictims = [];
      for (const enemy of this.enemySystem?.enemies ?? []) {
        if (!enemy?.model?.position || enemy.defeated || enemy.pendingCorpse) continue;
        const dx = enemy.model.position.x - x;
        const dz = enemy.model.position.z - z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > rSq) continue;
        fullVictims.push({ enemy, distanceSq });
      }
      fullVictims.sort((a, b) => a.distanceSq - b.distanceSq);
    
      let fullKills = 0;
      for (const { enemy, distanceSq } of fullVictims) {
        fullHits += 1;
        enemy.health = Math.max(0, (enemy.health ?? 100) - dmg);
        this.applyTipKnockback(enemy, dmg);
        if ((enemy.health ?? 0) > 0) continue;
    
        fullKills += 1;
        enemy.health = 0;
        enemy.pendingCorpse = true;
        this.enemySystem.markDefeated(enemy, 'explosion');
        const dist = Math.sqrt(distanceSq);
        const outward = dist > 1e-4
          ? {
            x: ((enemy.model.position.x - x) / dist) * 5.5,
            y: 3.2,
            z: ((enemy.model.position.z - z) / dist) * 5.5,
          }
          : { x: 0, y: 3.2, z: 0 };
    
        if (
          detailed < detailedBudget
          && this.enemyCutSystem?.canAffordDetailedRagdoll?.(HORDE_MAX_DETAILED_RAGDOLLS)
        ) {
          const smashed = this.enemyCutSystem.smashEnemyToRagdoll({
            enemy,
            launchVelocity: outward,
            physicsSystem: this.physicsSystem,
            enemySystem: this.enemySystem,
            propSystem: this.propSystem,
          });
          if (smashed) {
            detailed += 1;
            this.enemyCutSystem.enforceDetailedRagdollBudget?.(HORDE_MAX_DETAILED_RAGDOLLS);
            continue;
          }
        }
        // Budget exhausted or smash failed → instanced fallen corpse.
        this.convertHordeDeathToProxyCorpse(enemy);
      }
    
      return {
        hit: proxyResult.hit + fullHits,
        killed: proxyResult.killed + fullKills,
        detailed,
        fullHits,
        fullKills,
        proxyHits: proxyResult.hit,
        proxyKills: proxyResult.killed,
      };
    },
    convertHordeDeathToProxyCorpse(enemy) {
      if (!this.isHordePlaygroundActive() || !enemy?.model) return false;
      const baseMax = enemy.baseMaxHealth ?? enemy.maxHealth ?? 100;
      const healthScale = baseMax > 0 ? (enemy.maxHealth ?? baseMax) / baseMax : 1;
      const descriptor = {
        id: enemy.id,
        archetype: enemy.archetype,
        position: enemy.model.position.clone?.()
          ?? { x: enemy.model.position.x, y: enemy.model.position.y, z: enemy.model.position.z },
        yaw: enemy.model.rotation?.y ?? 0,
        health: 0,
        maxHealth: enemy.maxHealth ?? baseMax,
        healthScale,
      };
      this.physicsSystem?.removeEnemyCollider?.(enemy);
      this.enemySystem?.releasePlayerSlot?.(enemy);
      const removed = this.enemySystem?.despawnEnemy?.(enemy, { physicsSystem: this.physicsSystem });
      if (!removed) {
        // despawn may have already removed via smash paths; still try corpse.
      }
      const corpse = this.hordeProxySystem?.addCorpseProxy?.(descriptor)
        ?? this.hordeProxySystem?.addProxy?.(descriptor);
      return Boolean(corpse);
    },
    resolveHordeCombatTarget(target, { damage = 0, point = null, suppressOnly = false } = {}) {
      if (!target) return null;
    
      // Impact point for the suppression deposit: prefer the explicit hit point,
      // else the target's own position.
      const impact = point ?? target.proxyAgent?.position ?? target.model?.position ?? null;
      if (impact && damage > 0) this.depositSuppression(impact, damage);
    
      // suppressOnly: deposit + pass through, no promotion / knockback / damage
      // (the caller's own hit path owns those, e.g. unarmed stagger).
      if (suppressOnly) return target;
    
      if (!target.isHordeProxy) {
        // Full-actor (tip) hit — physics knockback shove.
        this.applyTipKnockback(target, damage);
        return target;
      }
    
      const promoted = this.emergencyPromoteHordeProxy(target);
      if (promoted) {
        // The proxy just became a tip actor — shove it too.
        this.applyTipKnockback(promoted, damage);
        return promoted;
      }
      if (damage > 0) {
        this.hordeProxySystem?.applyLightweightDamage?.(target, damage);
      }
      return null;
    },
    getFlowDistanceAt(position) {
      const field = this.hordeProxySystem?.flowField;
      if (!field || !position) return Infinity;
      return this.hordeProxySystem.sampleFlowDistance(position.x, position.z);
    },
    depositSuppression(point, amount) {
      if (!this.isHordePlaygroundActive() || !point) return;
      const scaled = Math.max(0, Number(amount) || 0) * HORDE_SUPPRESSION_PER_DAMAGE;
      if (scaled <= 0) return;
      this.hordeProxySystem?.depositSuppression?.(point.x, point.z, scaled);
    },
    applyTipKnockback(enemy, damage) {
      if (!this.isHordePlaygroundActive() || !enemy?.model?.position) return;
      const pos = enemy.model.position;
      const flow = this.hordeProxySystem?.sampleFlowDir?.(pos.x, pos.z) ?? { x: 0, z: 0 };
      let dirX = -flow.x;
      let dirZ = -flow.z;
      if (Math.hypot(dirX, dirZ) < 1e-3) {
        // No local flow (unreachable/goal cell) — fall back to player→actor.
        const player = this.characterSystem?.character?.group?.position
          ?? this.enemySystem?.lastPlayerPosition ?? null;
        if (player) {
          dirX = pos.x - player.x;
          dirZ = pos.z - player.z;
        } else {
          dirZ = 1;
        }
      }
      const power = HORDE_KNOCKBACK_BASE + Math.min(HORDE_KNOCKBACK_DAMAGE_CAP, Math.max(0, damage) * HORDE_KNOCKBACK_PER_DAMAGE);
      this.enemySystem.applyKnockback(enemy, { direction: { x: dirX, z: dirZ }, power });
    },
  });
}
