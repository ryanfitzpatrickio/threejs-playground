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
export function attachHordeSpawnController(target) {
  Object.assign(target, {
    _spawnHordeSmokeBots() {
      let count = 0;
      try {
        if (typeof window !== 'undefined') {
          const raw = new URLSearchParams(window.location.search).get('hordeCount');
          if (raw != null && raw !== '') {
            count = clampHordeEnemyCount(raw);
          }
        }
      } catch {
        // ignore
      }
      if (count <= 0) {
        count = Number(this.enemySystem?.behaviorMods?.bootCount) || 0;
      }
      if (count > 0) {
        this.spawnHordeEnemies({ count, archetype: 'mixed' });
      }
    },
    async ensureHordePlaygroundReady() {
      if (this._hordePlaygroundReady && this.hordeProxySystem?.ready) {
        return { ok: true, already: true, levelMode: this.levelMode };
      }
      if (this._hordePlaygroundLoading) {
        return this._hordePlaygroundLoading;
      }
      this._hordePlaygroundLoading = (async () => {
        try {
          if (!this.sceneSystem?.scene) {
            return { ok: false, reason: 'no-scene' };
          }
          await this.enemySystem.preloadArchetypes(this.sceneSystem.scene, {
            archetypes: ['cyclop', 'tessy', 'faceless'],
          });
          if (!this.hordeProxySystem.ready) {
            const level = this.levelSystem?.level;
            await this.hordeProxySystem.load(this.sceneSystem.scene, {
              enemySystem: this.enemySystem,
              colliders: level?.colliders ?? null,
              getGroundHeightAt: level?.getGroundHeightAt
                ? (position, radius, options) => level.getGroundHeightAt(position, radius, options)
                : null,
              bounds: null,
            });
          } else {
            // Rebind flow field to the current level colliders when jumping maps.
            const level = this.levelSystem?.level;
            this.hordeProxySystem.setLevelContext?.({
              colliders: level?.colliders ?? null,
              getGroundHeightAt: level?.getGroundHeightAt
                ? (position, radius, options) => level.getGroundHeightAt(position, radius, options)
                : null,
            });
          }
          if (!this.hordeProxySystem.ready) {
            return { ok: false, reason: 'proxy-load-failed', error: this.hordeProxySystem.error };
          }
          this.enemySystem.status = 'ready';
          this.enemySystem.setHordeShadowCasterLimit?.(HORDE_FULL_SHADOW_CASTER_LIMIT);
          if (!Number.isFinite(this.enemySystem.attackTokenLimit)
            || this.enemySystem.attackTokenLimit === Infinity) {
            this.enemySystem.attackTokenLimit = HORDE_ATTACK_TOKEN_LIMIT;
          }
          this._hordePlaygroundReady = true;
          return { ok: true, already: false, levelMode: this.levelMode };
        } catch (error) {
          console.warn('[GameRuntime] ensureHordePlaygroundReady failed', error);
          return { ok: false, reason: 'error', error: String(error?.message ?? error) };
        } finally {
          this._hordePlaygroundLoading = null;
        }
      })();
      return this._hordePlaygroundLoading;
    },
    async spawnHordeBenchmark({
      count = HORDE_DEFAULT_ENEMY_COUNT,
      archetype = 'mixed',
      passive = true,
      frozen = false,
      presetId = null,
    } = {}) {
      const ready = await this.ensureHordePlaygroundReady();
      if (!ready.ok) return { ok: false, reason: ready.reason ?? 'not-ready', ready };
      if (presetId) this.applyHordeSpectaclePreset(presetId);
      // Stabilize behavior mods for the soak without permanently mutating debug UI.
      const mods = this.enemySystem?.behaviorMods;
      const prev = mods
        ? {
          passive: mods.passive,
          frozen: mods.frozen,
          invulnerable: mods.invulnerable,
        }
        : null;
      if (mods) {
        mods.passive = Boolean(passive);
        mods.frozen = Boolean(frozen);
        mods.invulnerable = true; // no accidental deaths mid-sample
      }
      this.clearHordeEnemies();
      const spawn = this.spawnHordeEnemies({ count, archetype });
      return {
        ok: true,
        spawn,
        passive: Boolean(passive),
        frozen: Boolean(frozen),
        prevMods: prev,
        scale: this.hordeScaleSnapshot(),
      };
    },
    sampleHordeBenchmark() {
      const frame = this.frameStats?.summary?.() ?? null;
      const scale = this.hordeScaleSnapshot();
      const proxies = this.hordeProxySystem?.snapshot?.() ?? null;
      const enemies = this.enemySystem?.snapshot?.() ?? null;
      const physics = this.physicsSystem?.snapshot?.() ?? null;
      const renderer = this.rendererSystem?.snapshot?.() ?? null;
      let heapUsedMb = null;
      try {
        if (typeof performance !== 'undefined' && performance.memory?.usedJSHeapSize) {
          heapUsedMb = Number((performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1));
        }
      } catch {
        heapUsedMb = null;
      }
      return {
        at: Date.now(),
        levelMode: this.levelMode,
        frame,
        scale,
        proxies: proxies
          ? {
            count: proxies.count,
            living: proxies.living,
            drawCalls: proxies.drawCalls,
            sectorCount: proxies.sectorCount,
            occupiedSectors: proxies.occupiedSectors,
            geometrySource: proxies.geometrySource,
            gpuWalk: proxies.gpuWalk,
            peakCount: proxies.peakCount,
          }
          : null,
        enemies: enemies
          ? {
            count: enemies.count ?? this.enemySystem?.enemies?.length ?? 0,
            spatial: enemies.spatial ?? this.enemySystem?.spatialSnapshot?.() ?? null,
          }
          : { count: this.enemySystem?.enemies?.length ?? 0 },
        physics: physics
          ? { enemyBodies: physics.enemyBodies ?? null }
          : null,
        renderer: renderer
          ? {
            drawStats: renderer.drawStats ?? null,
            fps: renderer.fps ?? null,
          }
          : null,
        heapUsedMb,
      };
    },
    spawnHordeEnemies({ count, archetype } = {}) {
      if (!this.isHordePlaygroundActive() && !this.hordeProxySystem?.ready) {
        // Allow full-only spawns if archetypes were preloaded without proxy ready.
        const hasAssets = this.enemySystem?.getArchetypeAsset?.('faceless')
          || this.enemySystem?.getArchetypeAsset?.('cyclop');
        if (!hasAssets) {
          return {
            spawned: 0,
            queued: 0,
            requested: clampHordeEnemyCount(count ?? 0),
            accepted: 0,
            capped: false,
            cap: HORDE_MAX_ENEMY_COUNT,
            total: this._hordeVisibleEnemyCount(),
            error: 'horde-assets-not-ready',
            hint: 'await ensureHordePlaygroundReady() first',
          };
        }
      }
      this.enemySystem.status = 'ready';
      const mods = this.enemySystem?.behaviorMods ?? {};
      const requested = clampHordeEnemyCount(count ?? mods.spawnCount);
      const pendingBefore = this._hordePendingSpawnCount();
      const proxyCount = this.hordeProxySystem?.agents?.length ?? 0;
      const available = Math.max(
        0,
        HORDE_MAX_ENEMY_COUNT - this.enemySystem.enemies.length - proxyCount - pendingBefore,
      );
      const accepted = Math.min(requested, available);
      this._hordeSpawnStats.requestedTotal += requested;
      if (accepted <= 0) {
        return {
          spawned: 0,
          queued: pendingBefore,
          requested,
          accepted: 0,
          capped: requested > 0,
          cap: HORDE_MAX_ENEMY_COUNT,
          total: this._hordeVisibleEnemyCount(),
        };
      }
    
      const archKey = archetype ?? mods.archetype ?? 'mixed';
      const pool = archKey === 'mixed'
        ? ['faceless', 'tessy', 'cyclop']
        : [archKey];
    
      const descriptors = this._buildHordeSpawnDescriptors({
        count: accepted,
        pool,
        startIndex: this.enemySystem.enemies.length + proxyCount + pendingBefore,
      });
    
      const immediateCount = accepted <= HORDE_IMMEDIATE_SPAWN_LIMIT
        ? accepted
        : Math.min(accepted, HORDE_INITIAL_SPAWN_BURST);
      let spawned = 0;
      for (let i = 0; i < immediateCount; i += 1) {
        if (this._spawnHordeDescriptor(descriptors[i])) spawned += 1;
      }
      if (immediateCount < descriptors.length) {
        this._compactHordeSpawnQueue();
        this._hordeSpawnQueue.push(...descriptors.slice(immediateCount));
      }
    
      this._hordeSpawnStats.lastBatch = spawned;
      this._hordeSpawnStats.peakAlive = Math.max(
        this._hordeSpawnStats.peakAlive,
        this._hordeVisibleEnemyCount(),
      );
    
      return {
        spawned,
        queued: this._hordePendingSpawnCount(),
        requested,
        accepted,
        capped: accepted < requested,
        cap: HORDE_MAX_ENEMY_COUNT,
        archetype: archKey,
        total: this._hordeVisibleEnemyCount(),
      };
    },
    _buildHordeSpawnDescriptors({ count, pool, startIndex = 0 }) {
      const mods = this.enemySystem?.behaviorMods ?? {};
    
      const gates = this.levelSystem.level?.hordeSpawnPoints ?? [];
      const playerPos = this.characterSystem.character?.group?.position
        ?? this.levelSystem.level?.spawnPoint
        ?? new THREE.Vector3();
      const spawn = this.levelSystem.level?.spawnPoint ?? playerPos;
    
      let ranked = gates.length
        ? [...gates].sort((a, b) => b.position.distanceToSquared(spawn) - a.position.distanceToSquared(spawn))
        : null;
    
      if (!ranked || ranked.length === 0) {
        ranked = Array.from({ length: Math.max(1, count) }, (_, i) => {
          const ang = (i / Math.max(1, count)) * Math.PI * 2;
          const r = 12;
          return {
            position: new THREE.Vector3(
              playerPos.x + Math.sin(ang) * r,
              playerPos.y,
              playerPos.z + Math.cos(ang) * r,
            ),
            yaw: ang + Math.PI,
          };
        });
      }
    
      this.enemySystem.status = 'ready';
    
      const healthScale = Number(mods.healthScale);
      const hs = Number.isFinite(healthScale) ? Math.max(0.1, healthScale) : 1;
      const lateral = new THREE.Vector3();
      const inward = new THREE.Vector3();
      const descriptors = [];
    
      for (let i = 0; i < count; i += 1) {
        const ordinal = startIndex + i;
        const gate = ranked[ordinal % ranked.length];
        const arch = pool[ordinal % pool.length];
        const slot = Math.floor(ordinal / ranked.length);
        const side = (slot % 2 === 0 ? 1 : -1) * (0.9 + Math.floor(slot / 2) * 1.15);
        const yaw = gate.yaw ?? 0;
        lateral.set(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(side);
        inward.set(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(slot * 1.4);
        const position = gate.position.clone().add(lateral).add(inward);
        const groundY = this.levelSystem.getGroundHeightAt(position, 0.5);
        if (Number.isFinite(groundY)) position.y = groundY;
    
        // Full actors enter through arena gates. Overflow proxies must stay inside
        // the visible combat space instead of inheriting the unbounded gate-layer
        // offset used for hundreds of descriptors.
        const proxyAngle = ordinal * 2.399963229728653;
        const proxyRadius = 14 + (ordinal % 9) * 0.72;
        const proxyPosition = new THREE.Vector3(
          playerPos.x + Math.sin(proxyAngle) * proxyRadius,
          playerPos.y,
          playerPos.z + Math.cos(proxyAngle) * proxyRadius,
        );
        const proxyGroundY = this.levelSystem.getGroundHeightAt(proxyPosition, 0.5);
        if (Number.isFinite(proxyGroundY)) proxyPosition.y = proxyGroundY;
        const proxyYaw = Math.atan2(
          playerPos.x - proxyPosition.x,
          playerPos.z - proxyPosition.z,
        );
    
        descriptors.push({
          archetype: arch,
          position,
          yaw,
          proxyPosition,
          proxyYaw,
          healthScale: hs,
        });
      }
      return descriptors;
    },
    _spawnHordeDescriptor(descriptor, { allowFull = true } = {}) {
      if (!descriptor || this._hordeVisibleEnemyCount() >= HORDE_MAX_ENEMY_COUNT) return null;
      if (
        allowFull
        && (
          this.enemySystem.enemies.length < HORDE_FULL_ACTOR_LIMIT
          || !this.hordeProxySystem?.ready
        )
      ) {
        return this._spawnFullHordeDescriptor(descriptor, {
          respectFullLimit: this.hordeProxySystem?.ready === true,
        }) ? 'full' : null;
      }
      const proxy = this.hordeProxySystem?.addProxy?.(descriptor);
      if (!proxy) {
        return this._spawnFullHordeDescriptor(descriptor, { respectFullLimit: false }) ? 'full' : null;
      }
      this._hordeSpawnStats.spawnedTotal += 1;
      return 'proxy';
    },
    _spawnFullHordeDescriptor(
      descriptor,
      { countAsSpawn = true, respectFullLimit = true, replacingProxy = false } = {},
    ) {
      if (
        !descriptor
        || (respectFullLimit && this.enemySystem.enemies.length >= HORDE_FULL_ACTOR_LIMIT)
        || (!replacingProxy && this._hordeVisibleEnemyCount() >= HORDE_MAX_ENEMY_COUNT)
      ) return false;
      this.enemySystem.status = 'ready';

      // Snap tip spawns onto the nav surface (same bake as proxies).
      let spawnPos = descriptor.position;
      const nav = this.hordeProxySystem?.projectToNav?.(
        spawnPos?.x,
        spawnPos?.z,
        spawnPos?.y ?? 0,
      );
      if (nav?.ok) {
        if (spawnPos?.clone) {
          spawnPos = spawnPos.clone();
          spawnPos.x = nav.x;
          spawnPos.z = nav.z;
          if (Number.isFinite(nav.y)) spawnPos.y = nav.y;
        } else if (spawnPos) {
          spawnPos = { x: nav.x, y: nav.y ?? spawnPos.y ?? 0, z: nav.z };
        }
      }

      const enemy = this.enemySystem.spawnEnemy(descriptor.archetype, spawnPos, {
        yaw: descriptor.yaw,
        id: descriptor.id ?? null,
      });
      if (!enemy) return false;
    
      if (enemy.baseMaxHealth == null) {
        enemy.baseMaxHealth = enemy.maxHealth ?? 100;
      }
      enemy.maxHealth = enemy.baseMaxHealth * descriptor.healthScale;
      enemy.health = Number.isFinite(descriptor.health)
        ? Math.min(enemy.maxHealth, Math.max(0, descriptor.health))
        : enemy.maxHealth;
    
      // Limb-region triangle masks warm lazily on first gun sever (M3), not on every
      // spawn/promotion — avoids multi-ms hitches when filling the full-actor cap.
      this.physicsSystem.addEnemyCollider(enemy);
      if (countAsSpawn) this._hordeSpawnStats.spawnedTotal += 1;
      return true;
    },
    _processHordeSpawnQueue(limit = HORDE_SPAWN_BATCH_PER_FRAME) {
      const pending = this._hordePendingSpawnCount();
      if (pending <= 0 || !this.isHordePlaygroundActive()) {
        this._hordeSpawnStats.lastBatch = 0;
        return 0;
      }
      let spawned = 0;
      let fullSpawned = 0;
      const batch = Math.min(pending, Math.max(0, Math.floor(limit)));
      for (let i = 0; i < batch; i += 1) {
        const descriptor = this._hordeSpawnQueue[this._hordeSpawnQueueCursor];
        this._hordeSpawnQueueCursor += 1;
        const result = this._spawnHordeDescriptor(descriptor, {
          allowFull: fullSpawned < HORDE_FULL_SPAWN_BATCH_PER_FRAME,
        });
        if (result) spawned += 1;
        if (result === 'full') fullSpawned += 1;
      }
      this._hordeSpawnStats.lastBatch = spawned;
      this._hordeSpawnStats.peakAlive = Math.max(
        this._hordeSpawnStats.peakAlive,
        this._hordeVisibleEnemyCount(),
      );
      if (this._hordeSpawnQueueCursor >= this._hordeSpawnQueue.length) {
        this._hordeSpawnQueue.length = 0;
        this._hordeSpawnQueueCursor = 0;
      }
      return spawned;
    },
    _hordePendingSpawnCount() {
      return Math.max(0, this._hordeSpawnQueue.length - this._hordeSpawnQueueCursor);
    },
    _hordeVisibleEnemyCount() {
      return (this.enemySystem?.enemies?.length ?? 0) + (this.hordeProxySystem?.agents?.length ?? 0);
    },
    _hordeAliveEnemyCount() {
      let fullAlive = 0;
      for (const enemy of this.enemySystem?.enemies ?? []) {
        if (enemy.defeated || enemy.pendingCorpse || (enemy.health ?? 0) <= 0) continue;
        fullAlive += 1;
      }
      const proxyAlive = this.hordeProxySystem?.countLiving?.()
        ?? (this.hordeProxySystem?.agents?.length ?? 0);
      return fullAlive + proxyAlive;
    },
    _compactHordeSpawnQueue() {
      if (this._hordeSpawnQueueCursor <= 0) return;
      if (this._hordeSpawnQueueCursor >= this._hordeSpawnQueue.length) {
        this._hordeSpawnQueue.length = 0;
        this._hordeSpawnQueueCursor = 0;
        return;
      }
      this._hordeSpawnQueue = this._hordeSpawnQueue.slice(this._hordeSpawnQueueCursor);
      this._hordeSpawnQueueCursor = 0;
    },
    clearHordeEnemies() {
      this._hordeSpawnQueue.length = 0;
      this._hordeSpawnQueueCursor = 0;
      this._hordeSpawnStats.lastBatch = 0;
      this.hordeProxySystem?.clear?.();
      this.enemySystem.clearEnemies({
        physicsSystem: this.physicsSystem,
        weaponSystem: this.weaponSystem,
      });
      this.enemyCutSystem?.clearProps?.();
      return { cleared: true, remaining: this.enemySystem.enemies.length };
    },
    async fillHordeToPreset(presetId = 'default', { archetype = 'mixed' } = {}) {
      const ready = await this.ensureHordePlaygroundReady();
      if (!ready.ok) return { ok: false, reason: ready.reason ?? 'not-ready', ready };
      const applied = this.applyHordeSpectaclePreset(presetId);
      this.clearHordeEnemies();
      const result = this.spawnHordeEnemies({
        count: applied.count,
        archetype,
      });
      return {
        ok: true,
        preset: applied,
        spawn: result,
        alive: this._hordeAliveEnemyCount(),
        occupied: this._hordeVisibleEnemyCount(),
        levelMode: this.levelMode,
      };
    },
    async fillHordeToCount(count, { archetype = 'mixed', presetId = null } = {}) {
      const ready = await this.ensureHordePlaygroundReady();
      if (!ready.ok) return { ok: false, reason: ready.reason ?? 'not-ready', ready };
      if (presetId) this.applyHordeSpectaclePreset(presetId);
      this.clearHordeEnemies();
      const target = clampHordeEnemyCount(count);
      const result = this.spawnHordeEnemies({ count: target, archetype });
      return {
        ok: true,
        target,
        spawn: result,
        alive: this._hordeAliveEnemyCount(),
        occupied: this._hordeVisibleEnemyCount(),
        levelMode: this.levelMode,
      };
    },
    applyHordeHealthScale() {
      const hs = Number(this.enemySystem?.behaviorMods?.healthScale);
      const scale = Number.isFinite(hs) ? Math.max(0.1, hs) : 1;
      let updated = 0;
      for (const enemy of this.enemySystem.enemies) {
        if (enemy.pendingCorpse || enemy.defeated) continue;
        if (enemy.baseMaxHealth == null) {
          enemy.baseMaxHealth = enemy.maxHealth ?? 100;
        }
        enemy.maxHealth = enemy.baseMaxHealth * scale;
        enemy.health = enemy.maxHealth;
        updated += 1;
      }
      return { updated, healthScale: scale };
    },
  });
}
