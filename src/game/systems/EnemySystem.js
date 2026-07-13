import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { shortestAngleDelta } from '../utils/angleUtils.js';
import { flattenObjectForWebGPU } from '../geometry/prepareWebGPUGeometry.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import { ENEMY_ARCHETYPES, getArchetype } from '../config/enemyArchetypes.js';
import { hordeDebugState } from '../config/hordeDebugConfig.js';
import { UniformSpatialGrid } from './UniformSpatialGrid.js';
import {
  countLostLimbs,
  createSoldierLimbState,
  isEnemyMovingBackward,
  isSoldierDisabilityClip,
  isSoldierLowerLimbLossPosture,
  isSoldierCrawlLocomotionClip,
  isSoldierProneLocomotionClip,
  pickHeadMissingClip,
  resolveSoldierCollisionHeight,
  resolveSoldierInnerRotationX,
  resolveSoldierLocomotionClip,
  resolveSoldierLocomotionSpeed,
  resolveSoldierPostureOffsetFallback,
  resolveSoldierTargetHipsHeight,
  soldierPostureOffsetCacheKey,
} from './soldierPartialCut.js';
import {
  createSoldierSplitActionMaps,
  isSoldierArmSplitLocomotion,
  isSoldierSingleLegSplitLocomotion,
  isSoldierSplitAnimationLabel,
  isSoldierStationaryState,
  resolveSoldierArmMissingUpperClip,
  resolveSoldierLegMissingUpperClip,
  resolveSoldierSplitLowerClip,
  soldierSplitAnimationLabel,
} from './soldierSplitAnimation.js';

const ENEMY_COUNT = 0;
// Defaults/fallbacks only; per-enemy scale + collision come from ENEMY_ARCHETYPES.
// ENEMY_GROUND_OFFSET backs snap/spawn when an enemy lacks one; ENEMY_COLLISION_RADIUS
// sizes PLAYER_SLOT_SPACING below (kept at the human soldier's footprint).
const ENEMY_GROUND_OFFSET = -0.05;
const ENEMY_COLLISION_RADIUS = 0.42;
/** Set each EnemySystem.update for helpers that only receive `level`. */
let _snapPlatformsFrame = null;

// Per-archetype model + capability config lives in
// src/game/config/enemyArchetypes.js (pure-data, importable from node). The
// three capability profiles (rigProfile / cutProfile / limbLossProfile) replace
// the old literal `archetype === 'soldier'` gates; `boneScheme` stays as the
// low-level rig key for EnemyCutSystem.BONE_SCHEMES.

// Which archetype spawns at each enemy index. Index 0 is a robot so the original
// creature rig + rigid cut path stays exercised next to the soldiers.
const ENEMY_SPAWN_PLAN = Array.from({ length: ENEMY_COUNT }, (_, index) => (
  index === 0 ? 'robot' : 'soldier'
));
const ENEMY_ANIMATION_FADE_SECONDS = 0.18;
const SOLDIER_DISABILITY_CUT_FADE_SECONDS = 0.58;
const SOLDIER_DISABILITY_LOCOMOTION_FADE_SECONDS = 0.32;
// Snappy fade for survivable partial-cut reactions (arm / one-leg / crawl). The
// severed limb is already gone — geometry is clipped at the seam — so a long
// cross-fade just reads as the soldier keeps moving normally for half a second
// before the missing-limb animation kicks in. One-leg/crawl also use it for the
// fast drop to the ground (fall-like).
const SOLDIER_DISABILITY_CUT_REACT_FADE_SECONDS = 0.15;
const ENEMY_ATTACK_RANGE = 3.35;
const ENEMY_HOLD_RANGE = ENEMY_ATTACK_RANGE + 0.55;
/** Max |Δy| for melee — ground bots must not bite a player on a train roof. */
const ENEMY_ATTACK_HEIGHT_RANGE = 1.65;
const ENEMY_CHASE_RANGE = 11;
const ENEMY_ATTACK_COOLDOWN_SECONDS = 1.15;
const ENEMY_BITE_DAMAGE = 8;
const ENEMY_MAX_HEALTH = 100;
const ENEMY_WALK_SPEED = 0.75;
const ENEMY_RUN_SPEED = 2.15;
const ENEMY_TURN_SPEED = 8;
const SOLDIER_POSTURE_BLEND_SPEED = 9;
const ENEMY_SEPARATION_PADDING = 0.18;
const ENEMY_FULL_ANIMATION_DISTANCE = 18;
const ENEMY_REDUCED_ANIMATION_DISTANCE = 38;
const ENEMY_MID_ANIMATION_STEP = 1 / 20;
const ENEMY_FAR_ANIMATION_STEP = 1 / 10;
const ENEMY_MAX_ANIMATION_ACCUMULATOR = 0.22;
// Safety cap on full-rate (every-frame) mixers for close enemies to limit stack
// cost during clusters + simultaneous state fades/crossfades. Attacks/holds
// bypass the cap for responsiveness.
const MAX_SIMULTANEOUS_CLOSE_FULL_ANIM = 7;
// Clipmap shadow passes multiply every caster submission. Keep nearby contact
// shadows, but retire enemy casters before their screen-space benefit vanishes.
const ENEMY_SHADOW_DISTANCE = 14;
const ENEMY_SNAPSHOT_DETAIL_LIMIT = 64;
const PLAYER_SLOT_RADIUS = 3.35;
const PLAYER_SLOT_RELEASE_RANGE = ENEMY_CHASE_RANGE + 2.5;
const PLAYER_SLOT_MIN_RADIUS = 2.35;
const PLAYER_SLOT_CANDIDATES = 24;
const PLAYER_SLOT_SPACING = ENEMY_COLLISION_RADIUS * 2 + ENEMY_SEPARATION_PADDING;
/**
 * Horde-only (M2): full-actor attack slots are restricted to a cone facing the
 * incoming mob bearing instead of the 360° ring, so the tip attacks from the
 * mob side. Non-horde encirclement is unchanged (this gate stays off unless
 * GameRuntime calls setHordeFrontArc in horde mode).
 */
const HORDE_FRONT_ARC_HALF_ANGLE = (80 * Math.PI) / 180;
const PATROL_POINT_REACHED_DISTANCE = 0.45;
const SPAWN_OFFSETS = [
  // central intersection area (3)
  new THREE.Vector3( 8.5, 0,  6.2),
  new THREE.Vector3(-9.1, 0,  7.8),
  new THREE.Vector3( 7.3, 0, -8.4),
  // east street (positive x, 3)
  new THREE.Vector3(18, 0,  2.5),
  new THREE.Vector3(32, 0, -1.8),
  new THREE.Vector3(47, 0,  3.1),
  // west street (negative x, 3)
  new THREE.Vector3(-19, 0,  1.7),
  new THREE.Vector3(-33, 0, -2.9),
  new THREE.Vector3(-49, 0,  4.2),
  // north street (positive z, 3)
  new THREE.Vector3( 1.8, 0, 19),
  new THREE.Vector3(-2.5, 0, 34),
  new THREE.Vector3( 4.1, 0, 51),
  // south street (negative z, 3)
  new THREE.Vector3( 2.2, 0, -20),
  new THREE.Vector3(-3.7, 0, -35),
  new THREE.Vector3( 0.9, 0, -52),
];
const PATROL_OFFSETS = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(2.4, 0, 1.2),
  new THREE.Vector3(-1.8, 0, 2.1),
  new THREE.Vector3(1.2, 0, -2.2),
];

const enemyMoveDirection = new THREE.Vector3();
const enemyTargetPosition = new THREE.Vector3();
const enemySeparationDelta = new THREE.Vector3();
const playerSlotCandidatePosition = new THREE.Vector3();
const playerSlotApproachDirection = new THREE.Vector3();
const sampleHipsWorld = new THREE.Vector3();

export class EnemySystem {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Enemy Group';
    this.enemies = [];
    this.status = 'idle';
    this.error = null;
    this.clipNames = [];
    this.lastPlayerPosition = null;
    this.sharedAssetRoot = null;
    // Horde-only front-arc for attack-slot allocation (M2). Off by default so
    // soldier / normal-mode encirclement keeps the full 360° ring.
    this._hordeFrontArc = { enabled: false, bearing: 0, halfAngle: HORDE_FRONT_ARC_HALF_ANGLE };
    this._hordeShadowCasterLimit = Infinity;
    this._hordeShadowCasterIds = null;
    this.playerSlots = Array.from({ length: ENEMY_COUNT }, (_, index) => ({
      index,
      holderId: null,
      position: new THREE.Vector3(),
      angle: null,
      radius: null,
    }));
    // Per-archetype cached GLB scenes + clips, populated by preloadArchetypes.
    this._assets = new Map();
    // Monotonic instance counter; NOT reset by clearEnemies so ids stay unique
    // across horde restarts (avoids collisions with lingering cut props whose
    // labels embed the enemy id).
    this._spawnCounter = 0;
    // Idempotent defeat signal: set by markDefeated, cleared by clearEnemies.
    this._defeatedIds = new Set();
    // Nullable subscriber for defeat events (set by HordeSystem in M3). Stays
    // null for non-horde levels — markDefeated still stamps the flag.
    this.onEnemyDefeated = null;
    // Horde playground modifiers (debug pane). Live-read each frame.
    this.behaviorMods = hordeDebugState;
    /**
     * Max simultaneous full-actor attackers (M4 attack tokens). Infinity outside
     * Horde; GameRuntime sets HORDE_ATTACK_TOKEN_LIMIT in horde mode.
     */
    this.attackTokenLimit = Infinity;
    this._separationGrid = new UniformSpatialGrid(2);
    this._separationStats = {
      candidatePairs: 0,
      separatedPairs: 0,
      bruteForcePairsAvoided: 0,
    };
  }

  /** Effective chase activation distance (debug-scaled). */
  getChaseRange() {
    const s = Number(this.behaviorMods?.chaseRangeScale);
    return ENEMY_CHASE_RANGE * (Number.isFinite(s) ? Math.max(0.1, s) : 1);
  }

  getAttackRange() {
    const s = Number(this.behaviorMods?.attackRangeScale);
    return ENEMY_ATTACK_RANGE * (Number.isFinite(s) ? Math.max(0.15, s) : 1);
  }

  getHoldRange() {
    return this.getAttackRange() + 0.55;
  }

  getAttackCooldown() {
    const s = Number(this.behaviorMods?.attackCooldownScale);
    return ENEMY_ATTACK_COOLDOWN_SECONDS * (Number.isFinite(s) ? Math.max(0.15, s) : 1);
  }

  getBiteDamage() {
    const s = Number(this.behaviorMods?.damageScale);
    return ENEMY_BITE_DAMAGE * (Number.isFinite(s) ? Math.max(0, s) : 1);
  }

  getSpeedScale() {
    if (this.behaviorMods?.frozen) return 0;
    const s = Number(this.behaviorMods?.speedScale);
    return Number.isFinite(s) ? Math.max(0, s) : 1;
  }

  isPassive() {
    return Boolean(this.behaviorMods?.passive || this.behaviorMods?.frozen);
  }

  isInvulnerable() {
    return Boolean(this.behaviorMods?.invulnerable);
  }

  async load(scene, { playerPosition = new THREE.Vector3(), level } = {}) {
    this.status = 'loading';
    this.error = null;
    if (scene && this.group.parent !== scene) scene.add(this.group);

    if (ENEMY_COUNT <= 0) {
      this.status = 'ready';
      return;
    }

    try {
      await this.preloadArchetypes(scene, { archetypes: [...new Set(ENEMY_SPAWN_PLAN)] });

      for (let index = 0; index < ENEMY_COUNT; index += 1) {
        const archetype = ENEMY_SPAWN_PLAN[index % ENEMY_SPAWN_PLAN.length];
        const config = getArchetype(archetype);
        const spawnPosition = resolveEnemySpawnPosition({
          index,
          playerPosition,
          level,
          groundOffset: config.groundOffset,
        });
        const yaw = Math.atan2(-SPAWN_OFFSETS[index].x, -SPAWN_OFFSETS[index].z);
        this.spawnEnemy(archetype, spawnPosition, {
          yaw,
          attackCooldown: index * 0.2,
          patrolIndex: index % PATROL_OFFSETS.length,
          id: `enemy-${index + 1}`,
        });
      }

      this.status = 'ready';
      await nextFrame();
    } catch (error) {
      this.status = 'error';
      this.error = error;
      console.warn('Enemy model failed to load.', error);
    }
  }

  // Asset preload only: load each requested archetype's GLB once into the
  // per-archetype cache. Idempotent per archetype. Does not create instances.
  // Horde callers pass the archetype list explicitly; the legacy load() path
  // derives it from ENEMY_SPAWN_PLAN.
  async preloadArchetypes(scene, { archetypes } = {}) {
    if (scene && this.group.parent !== scene) scene.add(this.group);
    const keys = archetypes ?? [...new Set(ENEMY_SPAWN_PLAN)];
    if (!this._loader) this._loader = createGltfLoader();
    let primaryAsset = this._assets.values().next().value ?? null;
    for (const key of keys) {
      if (this._assets.has(key)) {
        continue;
      }
      const config = getArchetype(key);
      const gltf = await this._loader.loadAsync(config.url);
      const asset = {
        scene: gltf.scene,
        clips: prepareAnimationClips(gltf.animations),
      };
      this._assets.set(key, asset);
      if (!primaryAsset) primaryAsset = asset;
    }
    if (primaryAsset) {
      this.sharedAssetRoot = primaryAsset.scene ?? this.sharedAssetRoot;
      this.clipNames = (primaryAsset.clips ?? []).map((clip) => clip.name).filter(Boolean);
    }
    return this._assets;
  }

  getArchetypeAsset(archetype) {
    return this._assets.get(archetype) ?? null;
  }

  // Create one enemy instance from a preloaded archetype at an explicit
  // position/yaw. Does NOT register physics — the caller (HordeSystem) calls
  // physicsSystem.addEnemyCollider so spawn timing stays decoupled from the
  // physics step and spawnEnemy stays testable without physics. Returns the
  // enemy record or null if the archetype wasn't preloaded.
  spawnEnemy(archetype, position, {
    yaw = 0,
    attackCooldown = 0,
    patrolIndex = 0,
    id = null,
    platformBody = null,
    platformBodyHandle = null,
  } = {}) {
    const config = getArchetype(archetype);
    const asset = this._assets.get(archetype);
    if (!asset) {
      console.warn(`[EnemySystem] spawnEnemy('${archetype}'): archetype not preloaded; call preloadArchetypes first.`);
      return null;
    }

    const instanceId = id ?? `enemy-${++this._spawnCounter}`;
    const inner = cloneSkeleton(asset.scene);
    inner.name = `${instanceId} Model`;

    // Ensure matrices are ready right after clone (GLB skinned models need this
    // before any bounding-box or bind-pose work).
    inner.updateMatrixWorld(true);
    inner.traverse((child) => {
      if (child.isSkinnedMesh && child.skeleton) child.skeleton.update();
    });

    const renderObjects = prepareAsset(inner, { fixMaterials: config.fixMaterials });
    // De-interleave + de-quantize attributes before normalize/bounding-box
    // work so the WebGPU backend never sees the invalid `unorm32x4` format
    // these Tripo GLBs otherwise produce. Idempotent across shared clones.
    flattenObjectForWebGPU(inner);

    // soldier.glb is a Tripo/Mixamo FBX->GLB conversion whose armature carries
    // a residual +90deg X rotation (renders lying down) + cm->m scale; counter-
    // rotate it upright BEFORE normalizing height, else the height probe measures
    // body depth and scales it enormous. The robot rig needs no such fix
    // (orientationFixX === 0). Facing yaw goes on the outer `model` group so it
    // never composes with this orientation fix (mirrors Mara's loader).
    if (config.orientationFixX) {
      inner.rotation.x = config.orientationFixX;
    }
    normalizeToHeight(inner, config.targetHeight);

    const model = new THREE.Group();
    model.name = instanceId;
    model.add(inner);

    const mixer = new THREE.AnimationMixer(inner);
    const splitMaps = config.rigProfile === 'mixamo'
      ? createSoldierSplitActionMaps(mixer, asset.clips)
      : { actions: createActions(mixer, asset.clips), lowerActions: null, upperActions: null };
    const enemy = {
      id: instanceId,
      archetype,
      boneScheme: config.boneScheme,
      rigProfile: config.rigProfile,
      cutProfile: config.cutProfile,
      limbLossProfile: config.limbLossProfile ?? null,
      model,
      mixer,
      actions: splitMaps.actions,
      lowerActions: splitMaps.lowerActions,
      upperActions: splitMaps.upperActions,
      action: null,
      lowerSplitAction: null,
      upperSplitAction: null,
      splitAnimationActive: false,
      currentActionName: null,
      home: position.clone(),
      patrolIndex,
      state: 'idle',
      attackCooldown,
      behaviorTree: createEnemyBehaviorTree(),
      playerSlotIndex: null,
      collisionHeight: config.collisionHeight,
      baseCollisionHeight: config.collisionHeight,
      collisionRadius: config.collisionRadius,
      groundOffset: config.groundOffset,
      baseOrientationFixX: config.orientationFixX ?? 0,
      targetInnerRotationX: config.orientationFixX ?? 0,
      postureOffsetY: 0,
      targetPostureOffsetY: 0,
      appliedPostureOffsetY: 0,
      health: config.maxHealth,
      maxHealth: config.maxHealth,
      staggerTimer: 0,
      renderObjects,
      animationAccumulator: 0,
      renderBudget: {
        shadowCasting: true,
        animationStep: 0,
        animationHz: 0,
        playerDistance: null,
      },
      limbLoss: config.limbLossProfile === 'mixamo-humanoid' ? createSoldierLimbState() : null,
      cutCount: 0,
      locomotionMode: 'normal',
      headMissingClip: null,
      defeated: false,
      defeatCause: null,
      // Wall-clock ms when this full actor was spawned/promoted. Used by Horde
      // demotion hysteresis so brand-new promotions are not immediately flipped back.
      hordePromotedAt: performance.now(),
      // M5: optional moving-platform support (trailer / test deck body handle).
      platformBodyHandle: Number.isFinite(platformBodyHandle)
        ? platformBodyHandle
        : (Number.isFinite(platformBody?.handle) ? platformBody.handle : null),
      platformBody: platformBody ?? null,
      platformSupport: null,
      platformVelocity: { x: 0, y: 0, z: 0 },
    };

    model.position.copy(position);
    model.rotation.y = yaw;
    this.group.add(model);
    this.playAnimation(enemy, 'Idle', { fadeSeconds: 0 });
    mixer.update(0);
    this.enemies.push(enemy);
    this.ensurePlayerSlotCapacity();
    return enemy;
  }

  /**
   * Horde-only (M2): restrict claimable attack slots to a cone facing the mob's
   * approach bearing (radians, atan2(dz, dx) convention). Pass `enabled:false`
   * (or omit) to restore the full 360° ring for soldier / normal modes. Call
   * once per frame from GameRuntime while in horde mode.
   */
  setHordeFrontArc({ enabled = false, bearing = 0, halfAngle = HORDE_FRONT_ARC_HALF_ANGLE } = {}) {
    this._hordeFrontArc.enabled = Boolean(enabled) && Number.isFinite(bearing);
    this._hordeFrontArc.bearing = Number.isFinite(bearing) ? bearing : 0;
    this._hordeFrontArc.halfAngle = Number.isFinite(halfAngle) ? halfAngle : HORDE_FRONT_ARC_HALF_ANGLE;
  }

  /**
   * Horde has many nearby full actors, but every skinned shadow caster repeats
   * its full geometry across the shadow passes. Keep the budget explicit and
   * select attackers/slot holders before nearest idle actors.
   */
  setHordeShadowCasterLimit(limit = Infinity) {
    this._hordeShadowCasterLimit = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : Infinity;
  }

  /**
   * Whether a full Horde actor may be demoted back to an instanced proxy.
   * Attackers, staggered, cut, ragdoll/corpse, and recent promotions stay full.
   */
  isSafeToDemoteHordeActor(enemy, {
    now = performance.now(),
    minResidenceMs = 750,
    playerPosition = null,
    demotionRadius = null,
  } = {}) {
    if (!enemy || enemy.defeated || enemy.pendingCorpse) return false;
    if ((enemy.staggerTimer ?? 0) > 0) return false;
    if (enemy.knockbackVelocity) return false;
    if (enemy.state === 'attack') return false;
    if ((enemy.cutCount ?? 0) > 0) return false;
    if (enemy.splitAnimationActive) return false;
    if (countLostLimbs(enemy.limbLoss) > 0) return false;
    if (enemy.playerSlotIndex != null) return false;
    const promotedAt = enemy.hordePromotedAt ?? 0;
    if (now - promotedAt < minResidenceMs) return false;
    if (playerPosition && Number.isFinite(demotionRadius)) {
      const dx = enemy.model.position.x - playerPosition.x;
      const dz = enemy.model.position.z - playerPosition.z;
      if (dx * dx + dz * dz < demotionRadius * demotionRadius) return false;
    }
    return true;
  }

  /**
   * Extract a proxy descriptor from a full actor and despawn the clone/collider.
   * Returns null if the actor is not safe to demote or despawn fails.
   */
  demoteHordeActorToDescriptor(enemy, {
    physicsSystem = null,
    now = performance.now(),
    minResidenceMs = 750,
    playerPosition = null,
    demotionRadius = null,
  } = {}) {
    if (!this.isSafeToDemoteHordeActor(enemy, {
      now,
      minResidenceMs,
      playerPosition,
      demotionRadius,
    })) {
      return null;
    }
    const baseMax = enemy.baseMaxHealth ?? enemy.maxHealth ?? 100;
    const healthScale = baseMax > 0 ? (enemy.maxHealth ?? baseMax) / baseMax : 1;
    const descriptor = {
      id: enemy.id,
      archetype: enemy.archetype,
      position: enemy.model.position.clone(),
      yaw: enemy.model.rotation.y,
      health: enemy.health,
      maxHealth: enemy.maxHealth,
      healthScale,
      fromDemotion: true,
    };
    const removed = this.despawnEnemy(enemy, { physicsSystem });
    return removed ? descriptor : null;
  }

  /**
   * Furthest safe-to-demote full actor from the player, or null.
   * Linear scan is fine while Tier A is capped at ~24.
   */
  findFurthestDemotableHordeActor(playerPosition, options = {}) {
    if (!playerPosition || this.enemies.length === 0) return null;
    let best = null;
    let bestDistanceSq = -1;
    for (const enemy of this.enemies) {
      if (!this.isSafeToDemoteHordeActor(enemy, { ...options, playerPosition })) continue;
      const dx = enemy.model.position.x - playerPosition.x;
      const dz = enemy.model.position.z - playerPosition.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = enemy;
      }
    }
    return best;
  }

  /**
   * Rearmost safe-to-demote full actor by FLOW distance-to-goal (M2 front
   * election) — the tail of the mob, respecting the same demote guards. The
   * caller threads a `getFlowDistanceAt(position)` sampler (the proxy system's
   * shared field) so EnemySystem never reaches into the flow-field internals.
   * Full actors with unreachable/Infinity flow, or when no sampler is given,
   * fall back to euclidean distance so the tail is always well-defined.
   */
  findRearmostDemotableHordeActor(playerPosition, options = {}) {
    if (!playerPosition || this.enemies.length === 0) return null;
    const getFlowDistanceAt = typeof options.getFlowDistanceAt === 'function'
      ? options.getFlowDistanceAt
      : null;
    if (!getFlowDistanceAt) {
      return this.findFurthestDemotableHordeActor(playerPosition, options);
    }
    let best = null;
    let bestRank = -Infinity;
    for (const enemy of this.enemies) {
      if (!this.isSafeToDemoteHordeActor(enemy, { ...options, playerPosition })) continue;
      const flow = getFlowDistanceAt(enemy.model.position);
      let rank = flow;
      if (!Number.isFinite(rank)) {
        // Unreachable cell — rank by euclidean so it still orders behind
        // reachable actors of smaller path distance but stays comparable.
        const dx = enemy.model.position.x - playerPosition.x;
        const dz = enemy.model.position.z - playerPosition.z;
        rank = Math.hypot(dx, dz);
      }
      if (rank > bestRank) {
        bestRank = rank;
        best = enemy;
      }
    }
    return best;
  }

  // Non-lethal single-enemy removal (wave reset / mode teardown). Does NOT
  // call markDefeated. Optional physicsSystem removes the collider alongside.
  despawnEnemy(enemy, { physicsSystem } = {}) {
    if (!enemy) return false;
    physicsSystem?.removeEnemyCollider?.(enemy);
    return this.removeEnemy(enemy);
  }

  // Bulk non-lethal removal: despawn every enemy, release all player slots,
  // purge deferred firearm ragdolls, and clear defeat tracking. Used by
  // HordeSystem restart/teardown. Does not reset _spawnCounter (ids stay
  // unique vs lingering cut props).
  clearEnemies({ physicsSystem, weaponSystem } = {}) {
    let removed = 0;
    for (const enemy of [...this.enemies]) {
      physicsSystem?.removeEnemyCollider?.(enemy);
      this.releasePlayerSlot(enemy);
      enemy.mixer?.stopAllAction();
      this.group.remove(enemy.model);
      disposeEnemyClone(enemy.model);
      removed += 1;
    }
    this.enemies = [];
    this.releaseAllPlayerSlots();
    this._defeatedIds.clear();
    weaponSystem?.clearPendingRagdolls?.();
    return removed;
  }

  // Idempotent defeat signal. Stamps the enemy defeated, records the cause, and
  // fires onEnemyDefeated exactly once — BEFORE the lethal path's own visual /
  // collider cleanup so the listener reads valid state. Signal only: each lethal
  // path keeps its own teardown (ragdoll spawn, corpse timer, collider removal).
  // Partial (survivable) cuts must NOT call this.
  markDefeated(enemy, cause) {
    if (!enemy || enemy.defeated) return false;
    enemy.defeated = true;
    enemy.defeatCause = cause;
    this._defeatedIds.add(enemy.id);
    try {
      this.onEnemyDefeated?.(enemy, cause);
    } catch (err) {
      console.warn('[EnemySystem] onEnemyDefeated listener threw', err);
    }
    return true;
  }

  // Grow the player-slot pool so a freshly spawned enemy can claim one. The
  // array is sized from ENEMY_COUNT (0 for horde), so dynamic spawns need this
  // or checkoutPlayerSlot finds no open slot and enemies never funnel into
  // attack positions.
  ensurePlayerSlotCapacity() {
    while (this.playerSlots.length < this.enemies.length + 1) {
      const index = this.playerSlots.length;
      this.playerSlots.push({
        index,
        holderId: null,
        position: new THREE.Vector3(),
        angle: null,
        radius: null,
      });
    }
  }

  update({ delta, player, level, platforms = null }) {
    if (this.status !== 'ready') {
      return;
    }

    // Available to moveToward / separation helpers this frame (M5 platforms).
    this.platformsThisFrame = platforms;
    _snapPlatformsFrame = platforms;

    this.updatePlayerSlots(player);
    const playerPosition = player?.group?.position ?? null;
    this._updateHordeShadowCasterBudget(playerPosition);
    // Reset per-frame cap counter for close full-rate animations.
    this._closeFullAnimThisFrame = 0;

    for (const enemy of this.enemies) {
      enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);

      if (enemy.pendingCorpse) {
        enemy.corpseRemovalTimer = Math.max(0, (enemy.corpseRemovalTimer ?? 0) - delta);
        this.updateEnemyRenderBudget({ enemy, playerPosition });
        enemy.mixer?.update(delta);
        if (enemy.corpseRemovalTimer <= 0) {
          this.removeEnemy(enemy);
        }
        continue;
      }

      // M5: ride moving platforms (trailer / highway test deck).
      if (platforms && enemy.platformBodyHandle != null) {
        this.syncEnemyPlatformSupport(enemy, platforms);
        platforms.applyPendingCarry?.(enemy);
      }

      // Apply + decay unarmed knockback on live enemies (survives the stagger skip).
      this.applyEnemyKnockbackStep(enemy, delta, level, platforms);

      if (enemy.rigProfile === 'mixamo') {
        this.updateSoldierPostureBlend(enemy, delta, level);
      }

      // While staggered (from a sword hit) the enemy skips its behavior tree and
      // movement — it is briefly stunned — but still animates and casts shadows.
      if (enemy.staggerTimer > 0) {
        enemy.staggerTimer = Math.max(0, enemy.staggerTimer - delta);
        this.updateEnemyRenderBudget({ enemy, playerPosition });
        this.updateEnemyAnimation({ enemy, playerPosition, delta });
        snapEnemyToGround({ enemy, level, platforms });
        continue;
      }

      // Debug: frozen / passive skips pursuit AI (still animate + shadows).
      if (this.isPassive()) {
        enemy.state = 'idle';
        this.updateEnemyRenderBudget({ enemy, playerPosition });
        this.updateEnemyAnimation({ enemy, playerPosition, delta });
        if (this.behaviorMods?.frozen) {
          // no movement / BT
        } else {
          // Passive: soft idle facing without chase.
          playSoldierBehaviorAnimation(this, enemy, { fallback: 'Idle' });
        }
        snapEnemyToGround({ enemy, level, platforms });
        continue;
      }

      this.updateEnemyRenderBudget({ enemy, playerPosition });
      this.updateEnemySlotClaim({ enemy, player });
      this.updateEnemySlotReservation({ enemy, player });
      enemy.behaviorTree.tick({
        system: this,
        enemy,
        player,
        level,
        delta,
        platforms,
      });
      this.updateEnemyAnimation({ enemy, playerPosition, delta });
      snapEnemyToGround({ enemy, level, platforms });
    }

    this.resolveEnemyOverlaps({ level, platforms });
  }

  /**
   * Keep platformSupport + cached platformVelocity in sync for M5 combat.
   */
  syncEnemyPlatformSupport(enemy, platforms) {
    if (!enemy || !platforms || !Number.isFinite(enemy.platformBodyHandle)) return;
    // O4: assigned enemies use handle-directed lookup (not full registry scan).
    const hit = platforms.getPlatformByHandle?.(
      enemy.platformBodyHandle,
      enemy.model.position,
      enemy.model.position.y,
      { verticalTolerance: 1.2 },
    ) ?? platforms.getPlatformAt?.(
      enemy.model.position,
      enemy.model.position.y,
      { verticalTolerance: 1.2 },
    );
    if (hit && hit.bodyHandle === enemy.platformBodyHandle) {
      platforms.attachSupport?.(enemy, hit);
      enemy.platformVelocity = {
        x: hit.pointVelocity.x,
        y: hit.pointVelocity.y,
        z: hit.pointVelocity.z,
      };
      return;
    }
    // Off the deck but still assigned — refresh velocity from body, keep handle.
    if (platforms.getPointVelocity) {
      const pv = platforms.getPointVelocity(
        enemy.platformBodyHandle,
        enemy.model.position,
      );
      enemy.platformVelocity = { x: pv.x, y: pv.y, z: pv.z };
    }
    if (!enemy.platformSupport) {
      enemy.platformSupport = {
        bodyHandle: enemy.platformBodyHandle,
        localContact: { x: 0, y: 0, z: 0 },
        lastPointVelocity: { ...enemy.platformVelocity },
      };
    }
  }

  // Unarmed knockback: a horizontal shove that staggers the enemy (so its behavior
  // tree skips) and releases its player slot (so it doesn't snap back after). The
  // velocity is applied/decayed each frame by applyEnemyKnockbackStep.
  applyKnockback(enemy, { direction, power = 5 } = {}) {
    if (!enemy) {
      return;
    }
    const dir = direction ?? { x: 0, z: 1 };
    const len = Math.hypot(dir.x, dir.z);
    const nx = len > 1e-6 ? dir.x / len : 0;
    const nz = len > 1e-6 ? dir.z / len : 1;
    enemy.knockbackVelocity = { x: nx * power, z: nz * power };
    enemy.staggerTimer = Math.max(enemy.staggerTimer ?? 0, 0.6);
    this.releasePlayerSlot(enemy);
  }

  applyEnemyKnockbackStep(enemy, delta, level, platforms = null) {
    const kb = enemy.knockbackVelocity;
    if (!kb) {
      return;
    }
    enemy.model.position.x += kb.x * delta;
    enemy.model.position.z += kb.z * delta;
    const decay = Math.exp(-5 * delta);
    kb.x *= decay;
    kb.z *= decay;
    if (Math.hypot(kb.x, kb.z) < 0.05) {
      enemy.knockbackVelocity = null;
    } else if (level || platforms) {
      snapEnemyToGround({ enemy, level, platforms });
    }
  }

  playAnimation(enemy, name, { fadeSeconds = ENEMY_ANIMATION_FADE_SECONDS, timeScale = 1 } = {}) {
    this.stopSoldierSplitAnimation(enemy, fadeSeconds);

    const action = findAction(enemy.actions, name);

    if (!action) {
      return false;
    }

    if (action === enemy.action) {
      action.setEffectiveTimeScale(timeScale);
      return true;
    }

    const previousClipName = enemy.currentActionName;

    action.reset();
    action.enabled = true;
    action.setEffectiveTimeScale(timeScale);
    action.setEffectiveWeight(1);
    action.play();

    if (enemy.action) {
      enemy.action.crossFadeTo(action, fadeSeconds, false);
    } else if (fadeSeconds > 0) {
      action.fadeIn(fadeSeconds);
    }

    enemy.action = action;
    enemy.currentActionName = action.getClip()?.name ?? name;

    if (enemy.rigProfile === 'mixamo') {
      enemy._previousActionNameForPosture = previousClipName;
      enemy._pendingPostureBlendSeconds = fadeSeconds;
      this.updateSoldierPostureForClip(enemy, enemy.currentActionName);
      enemy._previousActionNameForPosture = undefined;
      enemy._pendingPostureBlendSeconds = undefined;
    }

    return true;
  }

  stopSoldierSplitAnimation(enemy, fadeSeconds = ENEMY_ANIMATION_FADE_SECONDS) {
    if (!enemy?.splitAnimationActive) {
      return;
    }

    const fade = fadeSeconds;
    if (enemy.lowerSplitAction) {
      enemy.lowerSplitAction.fadeOut(fade);
    }
    if (enemy.upperSplitAction) {
      enemy.upperSplitAction.fadeOut(fade);
    }

    enemy.splitAnimationActive = false;
    enemy.lowerSplitAction = null;
    enemy.upperSplitAction = null;
    enemy.action = null;
  }

  playSoldierSplitAnimation(
    enemy,
    lowerName,
    upperName,
    { fadeSeconds = ENEMY_ANIMATION_FADE_SECONDS, timeScale = 1 } = {},
  ) {
    if (!enemy?.lowerActions || !enemy?.upperActions) {
      return this.playAnimation(enemy, upperName ?? lowerName, { fadeSeconds, timeScale });
    }

    const lowerAction = findAction(enemy.lowerActions, lowerName);
    const upperAction = findAction(enemy.upperActions, upperName);
    if (!lowerAction || !upperAction) {
      return this.playAnimation(enemy, upperName ?? lowerName, { fadeSeconds, timeScale });
    }

    const splitLabel = soldierSplitAnimationLabel(lowerName, upperName);
    const previousClipName = enemy.currentActionName;
    const unchanged = enemy.splitAnimationActive
      && enemy.lowerSplitAction === lowerAction
      && enemy.upperSplitAction === upperAction;

    if (unchanged) {
      lowerAction.setEffectiveTimeScale(timeScale);
      upperAction.setEffectiveTimeScale(timeScale);
      return true;
    }

    if (enemy.action && !enemy.splitAnimationActive) {
      enemy.action.fadeOut(fadeSeconds);
    }

    // Only (re)set the half that actually changed. reset()+fadeIn() on the
    // UNCHANGED half would snap its effective weight to 0 and restart its clip
    // time, so a gait change (lower-half swap) made the unchanged upper half —
    // e.g. the missing-arm pose — vanish and fade back in over `fadeSeconds`,
    // which read as the missing-limb animation intermittently "taking a while to
    // kick in" (it only triggered when the enemy changed gait/state after the cut).
    const lowerChanged = !enemy.lowerSplitAction || enemy.lowerSplitAction !== lowerAction;
    const upperChanged = !enemy.upperSplitAction || enemy.upperSplitAction !== upperAction;

    if (lowerChanged) {
      lowerAction.reset();
      lowerAction.enabled = true;
      lowerAction.setEffectiveTimeScale(timeScale);
      lowerAction.setEffectiveWeight(1);
      lowerAction.play();
      if (enemy.lowerSplitAction) {
        enemy.lowerSplitAction.crossFadeTo(lowerAction, fadeSeconds, false);
      } else if (fadeSeconds > 0) {
        lowerAction.fadeIn(fadeSeconds);
      }
    } else {
      lowerAction.setEffectiveTimeScale(timeScale);
    }

    if (upperChanged) {
      upperAction.reset();
      upperAction.enabled = true;
      upperAction.setEffectiveTimeScale(timeScale);
      upperAction.setEffectiveWeight(1);
      upperAction.play();
      if (enemy.upperSplitAction) {
        enemy.upperSplitAction.crossFadeTo(upperAction, fadeSeconds, false);
      } else if (fadeSeconds > 0) {
        upperAction.fadeIn(fadeSeconds);
      }
    } else {
      upperAction.setEffectiveTimeScale(timeScale);
    }

    enemy.splitAnimationActive = true;
    enemy.lowerSplitAction = lowerAction;
    enemy.upperSplitAction = upperAction;
    enemy.action = null;
    enemy.currentActionName = splitLabel;

    enemy._previousActionNameForPosture = previousClipName;
    enemy._pendingPostureBlendSeconds = fadeSeconds;
    this.updateSoldierPostureForClip(enemy, upperName);
    enemy._previousActionNameForPosture = undefined;
    enemy._pendingPostureBlendSeconds = undefined;

    return true;
  }

  beginSoldierPostureBlend(enemy, duration) {
    const inner = enemy.model?.children?.[0];
    enemy.postureBlendDuration = Math.max(duration, 0.001);
    enemy.postureBlendElapsed = 0;
    enemy.postureBlendStartRotationX = inner?.rotation.x ?? enemy.baseOrientationFixX ?? 0;
    enemy.postureBlendStartOffsetY = enemy.postureOffsetY ?? 0;
  }

  updateSoldierPostureForClip(enemy, clipName) {
    if (enemy?.rigProfile !== 'mixamo') {
      return;
    }

    const previousTargetRotationX = enemy.targetInnerRotationX;
    const previousTargetOffsetY = enemy.targetPostureOffsetY;
    const targetRotationX = resolveSoldierInnerRotationX(enemy, clipName);
    enemy.targetInnerRotationX = targetRotationX;

    if (!isSoldierDisabilityClip(clipName)) {
      enemy.targetPostureOffsetY = 0;
      enemy.collisionHeight = enemy.baseCollisionHeight ?? enemy.collisionHeight;
      this.maybeBeginSoldierPostureBlend(enemy, {
        clipName,
        previousTargetRotationX,
        previousTargetOffsetY,
      });
      return;
    }

    if (!enemy._postureOffsetByClip) {
      enemy._postureOffsetByClip = {};
    }

    const postureCacheKey = soldierPostureOffsetCacheKey(clipName, targetRotationX);
    if (enemy._postureOffsetByClip[postureCacheKey] == null) {
      const groundY = enemy.model.position.y
        - (enemy.groundOffset ?? ENEMY_GROUND_OFFSET)
        - (enemy.appliedPostureOffsetY ?? 0);
      const measuredHipsY = sampleActionHipsWorldYAtRotation(enemy, clipName, targetRotationX);
      if (Number.isFinite(measuredHipsY)) {
        const targetHipsY = groundY + resolveSoldierTargetHipsHeight(enemy, clipName);
        enemy._postureOffsetByClip[postureCacheKey] = targetHipsY - measuredHipsY;
      } else {
        enemy._postureOffsetByClip[postureCacheKey] = resolveSoldierPostureOffsetFallback(enemy, clipName);
      }
    }

    enemy.targetPostureOffsetY = enemy._postureOffsetByClip[postureCacheKey];
    enemy.collisionHeight = resolveSoldierCollisionHeight(enemy, clipName);
    this.maybeBeginSoldierPostureBlend(enemy, {
      clipName,
      previousTargetRotationX,
      previousTargetOffsetY,
    });
  }

  maybeBeginSoldierPostureBlend(enemy, {
    clipName,
    previousTargetRotationX,
    previousTargetOffsetY,
  }) {
    const baseRotationX = enemy.baseOrientationFixX ?? 0;
    const targetRotationX = enemy.targetInnerRotationX ?? baseRotationX;
    const targetOffsetY = enemy.targetPostureOffsetY ?? 0;
    const fromRotationX = previousTargetRotationX ?? enemy.postureBlendStartRotationX ?? baseRotationX;
    const fromOffsetY = previousTargetOffsetY ?? enemy.postureBlendStartOffsetY ?? 0;
    const rotationDelta = Math.abs(shortestAngleDelta(targetRotationX, fromRotationX));
    const offsetDelta = Math.abs(targetOffsetY - fromOffsetY);

    if (rotationDelta < 0.02 && offsetDelta < 0.02) {
      return;
    }

    const enteringDisability = isSoldierDisabilityClip(clipName)
      || isSoldierSplitAnimationLabel(clipName);
    const enteringFromNormal = enteringDisability
      && !isSoldierDisabilityClip(enemy._previousActionNameForPosture)
      && !isSoldierSplitAnimationLabel(enemy._previousActionNameForPosture);
    const blendSeconds = enemy._pendingPostureBlendSeconds ?? (
      enteringFromNormal
        ? SOLDIER_DISABILITY_CUT_FADE_SECONDS
        : (isSoldierDisabilityClip(clipName) || isSoldierSplitAnimationLabel(clipName))
          ? SOLDIER_DISABILITY_LOCOMOTION_FADE_SECONDS
          : ENEMY_ANIMATION_FADE_SECONDS
    );

    this.beginSoldierPostureBlend(enemy, blendSeconds);
  }

  updateSoldierPostureBlend(enemy, delta, level) {
    const inner = enemy.model?.children?.[0];
    if (!inner) {
      return;
    }

    const targetRotationX = enemy.targetInnerRotationX ?? enemy.baseOrientationFixX ?? 0;
    const targetOffsetY = enemy.targetPostureOffsetY ?? 0;
    const blendDuration = enemy.postureBlendDuration ?? 0;

    if (blendDuration > 0) {
      enemy.postureBlendElapsed = (enemy.postureBlendElapsed ?? 0) + delta;
      const linearT = Math.min(1, enemy.postureBlendElapsed / blendDuration);
      const easedT = linearT * linearT * (3 - 2 * linearT);
      inner.rotation.x = lerpAngle(
        enemy.postureBlendStartRotationX ?? inner.rotation.x,
        targetRotationX,
        easedT,
      );
      enemy.postureOffsetY = THREE.MathUtils.lerp(
        enemy.postureBlendStartOffsetY ?? 0,
        targetOffsetY,
        easedT,
      );
      inner.updateMatrixWorld(true);
      applyPostureOffsetToEnemy(enemy);

      if (linearT >= 1) {
        enemy.postureBlendDuration = 0;
        enemy.postureBlendElapsed = 0;
      }
    } else {
      const alpha = 1 - Math.exp(-SOLDIER_POSTURE_BLEND_SPEED * delta);

      if (Math.abs(inner.rotation.x - targetRotationX) > 0.0001) {
        inner.rotation.x = lerpAngle(inner.rotation.x, targetRotationX, alpha);
        inner.updateMatrixWorld(true);
      } else {
        inner.rotation.x = targetRotationX;
      }

      if (Math.abs((enemy.postureOffsetY ?? 0) - targetOffsetY) > 0.0001) {
        enemy.postureOffsetY = THREE.MathUtils.lerp(enemy.postureOffsetY ?? 0, targetOffsetY, alpha);
        applyPostureOffsetToEnemy(enemy);
      } else {
        enemy.postureOffsetY = targetOffsetY;
        if ((enemy.appliedPostureOffsetY ?? 0) !== targetOffsetY) {
          applyPostureOffsetToEnemy(enemy);
        }
      }
    }

    // Movement and overlap resolution already ground-snap after changing X/Z.
    // Posture offsets are applied relative to the last grounded Y, so querying
    // every collider again here only repeats work for stationary soldiers.
  }

  applySoldierPartialCut(enemy, outcome, { fadeSeconds } = {}) {
    if (!enemy || enemy.limbLossProfile !== 'mixamo-humanoid' || !outcome) {
      return;
    }

    enemy.limbLoss = outcome.nextLoss;
    enemy.cutCount = (enemy.cutCount ?? 0) + 1;
    enemy.locomotionMode = outcome.locomotion ?? 'limb';

    if (!enemy.limbLoss.head) {
      pickHeadMissingClip(enemy);
    }

    const clip = resolveSoldierLocomotionClip(enemy) ?? 'Idle';
    // Survivable partial cuts (arm / one-leg / crawl) snap to the disability clip
    // fast; head cuts keep a slightly longer fade for the death animation.
    const fade = fadeSeconds ?? (
      outcome.locomotion === 'head'
        ? 0.38
        : SOLDIER_DISABILITY_CUT_REACT_FADE_SECONDS
    );

    if (outcome.locomotion === 'head') {
      const headAction = findAction(enemy.actions, clip);
      if (headAction) {
        headAction.setLoop(THREE.LoopOnce, 1);
        headAction.clampWhenFinished = true;
      }
      this.playAnimation(enemy, clip, { fadeSeconds: fade });
      return;
    }

    // Delegate to the same state-aware selection the behavior tree uses each tick
    // (arm-missing split, one-legged prone, crawl) so the initial cut reaction
    // matches what plays a frame later.
    playSoldierBehaviorAnimation(this, enemy, { fadeSeconds: fade, fallback: clip });
  }

  applySoldierHeadPartialDeath(enemy, outcome, physicsSystem) {
    const fadeSeconds = 0.38;
    this.applySoldierPartialCut(enemy, outcome, { fadeSeconds });

    const duration = enemy.action?.getClip()?.duration;
    enemy.corpseRemovalTimer = Number.isFinite(duration) && duration > 0
      ? fadeSeconds + duration + 0.12
      : fadeSeconds + 2.4;

    enemy.health = 0;
    enemy.pendingCorpse = true;
    this.markDefeated(enemy, 'sword-head-sever');
    physicsSystem?.removeEnemyCollider?.(enemy);
    this.releasePlayerSlot(enemy);
  }

  snapshot() {
    const detailedEnemies = this.enemies.slice(0, ENEMY_SNAPSHOT_DETAIL_LIMIT);
    const detailedSlots = this.playerSlots.slice(0, ENEMY_SNAPSHOT_DETAIL_LIMIT);
    return {
      status: this.status,
      count: this.enemies.length,
      clips: this.clipNames,
      detailLimit: ENEMY_SNAPSHOT_DETAIL_LIMIT,
      truncatedEnemies: Math.max(0, this.enemies.length - detailedEnemies.length),
      truncatedPlayerSlots: Math.max(0, this.playerSlots.length - detailedSlots.length),
      spatial: this.spatialSnapshot(),
      enemies: detailedEnemies.map((enemy) => ({
        id: enemy.id,
        archetype: enemy.archetype,
        state: enemy.state,
        animation: enemy.currentActionName,
        playerSlot: enemy.playerSlotIndex,
        playerSlotAngle: enemy.playerSlotIndex == null
          ? null
          : Number((this.playerSlots[enemy.playerSlotIndex]?.angle ?? 0).toFixed(3)),
        attackCooldown: Number(enemy.attackCooldown.toFixed(2)),
        health: enemy.health,
        staggered: enemy.staggerTimer > 0,
        collision: {
          height: enemy.collisionHeight,
          radius: enemy.collisionRadius,
        },
        render: {
          shadowCasting: enemy.renderBudget?.shadowCasting === true,
          animationHz: enemy.renderBudget?.animationHz ?? 0,
          distance: enemy.renderBudget?.playerDistance == null
            ? null
            : Number(enemy.renderBudget.playerDistance.toFixed(2)),
        },
        position: vectorSnapshot(enemy.model.position),
      })),
      playerSlots: detailedSlots.map((slot) => ({
        index: slot.index,
        holderId: slot.holderId,
        angle: slot.angle == null ? null : Number(slot.angle.toFixed(3)),
        radius: slot.radius == null ? null : Number(slot.radius.toFixed(3)),
        position: vectorSnapshot(slot.position),
      })),
    };
  }

  spatialSnapshot() {
    return {
      ...this._separationGrid.snapshot(),
      ...this._separationStats,
    };
  }

  dispose() {
    for (const enemy of this.enemies) {
      enemy.mixer?.stopAllAction();
      disposeEnemyClone(enemy.model);
    }

    // Dispose shared (un-cloned) GLTF scenes loaded by preloadArchetypes.
    // sharedAssetRoot is one of these, so it is covered by the loop.
    for (const asset of this._assets.values()) {
      if (asset?.scene) disposeObject3D(asset.scene);
    }
    this._assets.clear();
    // If nothing was preloaded (e.g. ENEMY_COUNT=0), the group still owns
    // whatever was added to it.
    if (!this.sharedAssetRoot) {
      disposeObject3D(this.group);
    }
    this.group.removeFromParent();
    this.enemies = [];
    this.releaseAllPlayerSlots();
    this._defeatedIds.clear();
    this.sharedAssetRoot = null;
    this.status = 'disposed';
  }

  removeEnemy(enemy) {
    const index = this.enemies.indexOf(enemy);

    if (index === -1) {
      return false;
    }

    this.releasePlayerSlot(enemy);
    enemy.mixer?.stopAllAction();
    this.group.remove(enemy.model);
    disposeEnemyClone(enemy.model);
    this.enemies.splice(index, 1);
    return true;
  }

  updatePlayerSlots(player) {
    const playerPosition = player?.group?.position;

    if (!playerPosition) {
      return;
    }

    // Reuse one vector across frames instead of allocating per frame. Consumers
    // that need to keep it call .clone() on read (resolvePlayerSlotCenter).
    if (this.lastPlayerPosition) {
      this.lastPlayerPosition.copy(playerPosition);
    } else {
      this.lastPlayerPosition = playerPosition.clone();
    }

    for (const slot of this.playerSlots) {
      if (slot.holderId == null || !Number.isFinite(slot.angle)) {
        continue;
      }

      setSlotPositionFromAngle({ slot, playerPosition });
    }
  }

  updateEnemySlotClaim({ enemy, player }) {
    const playerDistance = distanceToPlayer(enemy, player);

    const releaseRange = this.getChaseRange() + 2.5;
    if (enemy.playerSlotIndex != null && playerDistance > releaseRange) {
      this.releasePlayerSlot(enemy);
      return;
    }

    if (playerDistance <= this.getChaseRange() && enemy.playerSlotIndex == null) {
      this.checkoutPlayerSlot(enemy);
    }
  }

  updateEnemySlotReservation({ enemy, player }) {
    const slot = this.getPlayerSlot(enemy);
    const playerPosition = player?.group?.position;

    if (!slot || !playerPosition) {
      return;
    }

    const angle = angleFromCenter({ point: enemy.model.position, center: playerPosition });
    const radius = preferredSlotRadius({ enemy, playerPosition });
    setPositionFromPolar({
      target: playerSlotCandidatePosition,
      center: playerPosition,
      angle,
      radius,
    });

    if (!slotCandidateIsFree({
      candidate: playerSlotCandidatePosition,
      slots: this.playerSlots,
      ignoreHolderId: enemy.id,
    })) {
      return;
    }

    slot.angle = angle;
    slot.radius = radius;
    slot.position.copy(playerSlotCandidatePosition);
  }

  checkoutPlayerSlot(enemy) {
    const openSlot = this.findBestOpenPlayerSlot(enemy);

    if (!openSlot) {
      return null;
    }

    openSlot.holderId = enemy.id;
    enemy.playerSlotIndex = openSlot.index;
    return openSlot;
  }

  releasePlayerSlot(enemy) {
    if (enemy.playerSlotIndex == null) {
      return;
    }

    const slot = this.playerSlots[enemy.playerSlotIndex];
    if (slot?.holderId === enemy.id) {
      slot.holderId = null;
      slot.angle = null;
      slot.radius = null;
    }

    enemy.playerSlotIndex = null;
  }

  releaseAllPlayerSlots() {
    for (const slot of this.playerSlots) {
      slot.holderId = null;
      slot.angle = null;
      slot.radius = null;
    }

    for (const enemy of this.enemies) {
      enemy.playerSlotIndex = null;
    }
  }

  findBestOpenPlayerSlot(enemy) {
    const playerPosition = this.resolvePlayerSlotCenter();

    if (!playerPosition) {
      return null;
    }

    const bestSlot = this.playerSlots.find((slot) => slot.holderId == null) ?? null;

    if (!bestSlot) {
      return null;
    }

    const candidate = findBestSlotCandidate({
      enemy,
      slots: this.playerSlots,
      playerPosition,
      frontArc: this._hordeFrontArc,
    });

    if (!candidate) {
      return null;
    }

    bestSlot.angle = candidate.angle;
    bestSlot.radius = candidate.radius;
    setSlotPositionFromAngle({ slot: bestSlot, playerPosition });
    return bestSlot;
  }

  resolvePlayerSlotCenter() {
    return this.lastPlayerPosition?.clone?.() ?? null;
  }

  getPlayerSlot(enemy) {
    if (enemy.playerSlotIndex == null) {
      return null;
    }

    const slot = this.playerSlots[enemy.playerSlotIndex];
    return slot?.holderId === enemy.id ? slot : null;
  }

  resolveEnemyOverlaps({ level, platforms = null }) {
    const count = this.enemies.length;
    if (count < 2) {
      this._separationStats.candidatePairs = 0;
      this._separationStats.separatedPairs = 0;
      this._separationStats.bruteForcePairsAvoided = 0;
      return;
    }

    let maxRadius = 0.5;
    for (const enemy of this.enemies) {
      maxRadius = Math.max(maxRadius, enemy.collisionRadius ?? 0.5);
    }
    const cellSize = maxRadius * 2 + ENEMY_SEPARATION_PADDING;
    this._separationGrid.rebuild(
      this.enemies,
      (enemy) => enemy.model?.position,
      cellSize,
    );

    let separatedPairs = 0;
    const candidatePairs = this._separationGrid.forEachCandidatePair((first, second) => {
      if (separateEnemies({ first, second, level, platforms })) {
        separatedPairs += 1;
      }
    });
    const bruteForcePairs = count * (count - 1) * 0.5;
    this._separationStats.candidatePairs = candidatePairs;
    this._separationStats.separatedPairs = separatedPairs;
    this._separationStats.bruteForcePairsAvoided = Math.max(0, bruteForcePairs - candidatePairs);
  }

  updateEnemyRenderBudget({ enemy, playerPosition }) {
    const distance = playerPosition
      ? horizontalDistance(enemy.model.position, playerPosition)
      : 0;
    const inHordeShadowBudget = !this._hordeShadowCasterIds
      || this._hordeShadowCasterIds.has(enemy.id);
    const shadowCasting = inHordeShadowBudget && (!playerPosition
      || distance <= ENEMY_SHADOW_DISTANCE
      || enemy.state === 'attack'
      || enemy.state === 'hold');

    enemy.renderBudget.playerDistance = Number.isFinite(distance) ? distance : null;
    setEnemyShadowCasting(enemy, shadowCasting);
  }

  _updateHordeShadowCasterBudget(playerPosition) {
    if (!Number.isFinite(this._hordeShadowCasterLimit)) {
      this._hordeShadowCasterIds = null;
      return;
    }
    if (!playerPosition || this._hordeShadowCasterLimit <= 0) {
      this._hordeShadowCasterIds = new Set();
      return;
    }

    const ranked = this.enemies
      .filter((enemy) => !enemy.pendingCorpse && !enemy.defeated && enemy.model)
      .sort((left, right) => {
        const priority = (enemy) => (
          (enemy.state === 'attack' ? 1000 : 0)
          + (enemy.state === 'hold' ? 800 : 0)
          + (enemy.staggerTimer > 0 ? 600 : 0)
          + (enemy.playerSlotIndex != null ? 400 : 0)
        );
        const priorityDelta = priority(right) - priority(left);
        if (priorityDelta !== 0) return priorityDelta;
        return horizontalDistance(left.model.position, playerPosition)
          - horizontalDistance(right.model.position, playerPosition);
      });
    this._hordeShadowCasterIds = new Set(
      ranked.slice(0, this._hordeShadowCasterLimit).map((enemy) => enemy.id),
    );
  }

  updateEnemyAnimation({ enemy, playerPosition, delta }) {
    let step = enemyAnimationStep({ enemy, playerPosition });

    // Cap concurrent full-rate close mixers (non-attack/hold) to keep frame
    // budget when many enemies are near + transitioning (split layers + fades).
    if (step <= 0) {
      const isPriority = enemy.state === 'attack' || enemy.state === 'hold';
      if (!isPriority) {
        const count = (this._closeFullAnimThisFrame ?? 0) + 1;
        this._closeFullAnimThisFrame = count;
        if (count > MAX_SIMULTANEOUS_CLOSE_FULL_ANIM) {
          step = ENEMY_MID_ANIMATION_STEP;
        }
      }
    }

    enemy.renderBudget.animationStep = step;
    enemy.renderBudget.animationHz = step <= 0 ? 0 : Math.round(1 / step);

    if (step <= 0) {
      enemy.animationAccumulator = 0;
      enemy.mixer.update(delta);
      return;
    }

    enemy.animationAccumulator = Math.min(
      (enemy.animationAccumulator ?? 0) + delta,
      ENEMY_MAX_ANIMATION_ACCUMULATOR,
    );

    if (enemy.animationAccumulator < step) {
      return;
    }

    enemy.mixer.update(enemy.animationAccumulator);
    enemy.animationAccumulator = 0;
  }
}

function createEnemyBehaviorTree() {
  return selector([
    sequence([
      condition(({ system, enemy }) => enemyIsInClaimedPlayerSlot({ system, enemy })),
      action((context) => attackPlayer(context)),
    ]),
    sequence([
      condition(({ system, enemy, player }) => closeEnoughToHold({ system, enemy, player })),
      action((context) => holdAttackPosition(context)),
    ]),
    sequence([
      condition(({ system, enemy, player }) => distanceToPlayer(enemy, player) <= system.getChaseRange() && system.getPlayerSlot(enemy) != null),
      action((context) => chasePlayer(context)),
    ]),
    action((context) => patrol(context)),
  ]);
}

function selector(children) {
  return {
    tick(context) {
      for (const child of children) {
        if (child.tick(context) === true) {
          return true;
        }
      }

      return false;
    },
  };
}

function sequence(children) {
  return {
    tick(context) {
      for (const child of children) {
        if (child.tick(context) !== true) {
          return false;
        }
      }

      return true;
    },
  };
}

function condition(predicate) {
  return {
    tick: (context) => predicate(context) === true,
  };
}

function action(callback) {
  return {
    tick(context) {
      callback(context);
      return true;
    },
  };
}

function playSoldierBehaviorAnimation(system, enemy, options = {}) {
  if (options.fullBodyClip) {
    playEnemyLocomotionAnimation(system, enemy, options.fullBodyClip, options);
    return;
  }

  // Arm-injured: split (legs=gait, upper=arm-missing walk) while moving. When
  // stationary the arm-missing walk torso would keep "walking" on idle legs, so
  // drop the split and play a full idle — the missing arm is conveyed by the
  // absent geometry, no specialized clip is needed at rest.
  if (isSoldierArmSplitLocomotion(enemy)) {
    if (isSoldierStationaryState(enemy)) {
      playEnemyLocomotionAnimation(system, enemy, 'Idle Alert', options);
      return;
    }

    const upper = resolveSoldierArmMissingUpperClip(enemy);
    const lower = resolveSoldierSplitLowerClip(enemy);
    if (upper) {
      const fadeSeconds = options.fadeSeconds ?? SOLDIER_DISABILITY_LOCOMOTION_FADE_SECONDS;
      system.playSoldierSplitAnimation(enemy, lower, upper, {
        fadeSeconds,
        timeScale: options.timeScale ?? 1,
      });
      return;
    }
  }

  // One-legged is now prone/lying (see soldierPartialCut). When stationary we
  // still use the split to idle the remaining leg while the leg-missing upper plays.
  // Moving falls through to resolveSoldierLocomotionClip (which gives leg clip).
  if (isSoldierSingleLegSplitLocomotion(enemy) && isSoldierStationaryState(enemy)) {
    const upper = resolveSoldierLegMissingUpperClip(enemy);
    if (upper) {
      const fadeSeconds = options.fadeSeconds ?? SOLDIER_DISABILITY_LOCOMOTION_FADE_SECONDS;
      system.playSoldierSplitAnimation(enemy, resolveSoldierSplitLowerClip(enemy), upper, {
        fadeSeconds,
        timeScale: options.timeScale ?? 1,
      });
      // Ensure rotation puts the one-legged prone soldier on his back.
      enemy.targetInnerRotationX = resolveSoldierInnerRotationX(enemy, '');
      return;
    }
  }

  const disabilityClip = resolveSoldierLocomotionClip(enemy, {
    movingBackward: options.movingBackward,
  });
  // Ensure animation blends for crawl (both legs) and other disability; use fast
  // fade for crawl transitions (fall-like) if provided by caller (e.g. cut), else
  // the fast default for crawl to make the switch smooth.
  let fadeToUse = options.fadeSeconds;
  const isCrawlClip = disabilityClip && isSoldierCrawlLocomotionClip(disabilityClip);
  if (isCrawlClip) {
    fadeToUse = options.fadeSeconds ?? SOLDIER_DISABILITY_CUT_REACT_FADE_SECONDS;
  } else if (!fadeToUse && disabilityClip && isSoldierDisabilityClip(disabilityClip)) {
    fadeToUse = SOLDIER_DISABILITY_LOCOMOTION_FADE_SECONDS;
  } else if (!fadeToUse) {
    fadeToUse = ENEMY_ANIMATION_FADE_SECONDS;
  }
  playEnemyLocomotionAnimation(system, enemy, disabilityClip ?? options.fallback, {
    ...options,
    fadeSeconds: fadeToUse,
  });
}

function playEnemyLocomotionAnimation(system, enemy, clipName, options = {}) {
  const fadeSeconds = options.fadeSeconds ?? (
    isSoldierDisabilityClip(clipName)
      ? SOLDIER_DISABILITY_LOCOMOTION_FADE_SECONDS
      : ENEMY_ANIMATION_FADE_SECONDS
  );
  system.playAnimation(enemy, clipName, {
    fadeSeconds,
    timeScale: options.timeScale ?? 1,
  });
}

function attackPlayer({ system, enemy, player, delta }) {
  // M4 attack tokens: only N full actors may be in attack state at once.
  // Others hold at the ring edge so the crowd stays readable and melee damage
  // does not spike with the full Tier A set.
  const tokenLimit = system.attackTokenLimit;
  if (Number.isFinite(tokenLimit) && tokenLimit >= 0 && enemy.state !== 'attack') {
    let attackers = 0;
    for (const other of system.enemies) {
      if (other !== enemy && other.state === 'attack' && !other.defeated && !other.pendingCorpse) {
        attackers += 1;
        if (attackers >= tokenLimit) break;
      }
    }
    if (attackers >= tokenLimit) {
      holdAttackPosition({ system, enemy, player, delta });
      return;
    }
  }

  enemy.state = 'attack';
  const newSwing = enemy.attackCooldown <= 0;
  const attackCd = system.getAttackCooldown?.() ?? ENEMY_ATTACK_COOLDOWN_SECONDS;
  enemy.attackCooldown = newSwing
    ? attackCd
    : enemy.attackCooldown;
  if (newSwing) {
    enemy.hasDamagedPlayerThisSwing = false;
  }
  faceTarget({ enemy, target: player?.group?.position, delta });
  // Lower-limb loss (crawl or one-legged prone) soldiers keep their disability
  // clip when attacking. The upright 'Bite' would snap rotation/offset up; instead
  // they stay down. (Arm-missing is the only upright disability here.)
  // With no fullBodyClip, playSoldierBehaviorAnimation falls through to resolve...

  const biting = !isSoldierLowerLimbLossPosture(enemy)
    && enemy.attackCooldown > attackCd - 0.2;
  // Deal player damage once per swing, during the bite window. The funnel applies
  // i-frames, knockback, and picks the hit-reaction (AnimationStateSystem reads it).
  // Re-check 3D melee reach at the bite frame so a roof/ledge hop mid-swing
  // cannot still land a hit (horizontal-only range used to ignore height).
  if (
    biting
    && !enemy.hasDamagedPlayerThisSwing
    && isInMeleeRange(
      enemy.model.position,
      player?.group?.position,
      system.getAttackRange?.() ?? ENEMY_ATTACK_RANGE,
    )
  ) {
    enemy.hasDamagedPlayerThisSwing = true;
    system.playerDamageSystem?.dealPlayerDamage?.(player, {
      amount: system.getBiteDamage?.() ?? ENEMY_BITE_DAMAGE,
      kind: 'light',
      sourcePosition: enemy.model.position,
    });
  }
  playSoldierBehaviorAnimation(system, enemy, {
    fullBodyClip: biting ? 'Bite' : null,
    fallback: 'Idle Alert',
  });
}

function holdAttackPosition({ system, enemy, player, delta }) {
  enemy.state = 'hold';
  faceTarget({ enemy, target: player?.group?.position, delta });
  playSoldierBehaviorAnimation(system, enemy, { fallback: 'Idle Alert' });
}

function chasePlayer({ system, enemy, player, level, delta }) {
  enemy.state = 'chase';
  const playerPosition = player?.group?.position ?? null;
  faceTarget({ enemy, target: playerPosition, delta });

  if (enemyIsCloseEnoughToStopChasing(enemy, player, system)) {
    playSoldierBehaviorAnimation(system, enemy, { fallback: 'Idle Alert' });
    return;
  }

  const target = nearestAttackPosition({ enemy, player });
  const movingBackward = isEnemyMovingBackward(enemy, target);
  playSoldierBehaviorAnimation(system, enemy, {
    movingBackward,
    fallback: 'Run',
  });
  const speedScale = system.getSpeedScale?.() ?? 1;
  moveToward({
    enemy,
    target,
    speed: resolveSoldierLocomotionSpeed(enemy, ENEMY_RUN_SPEED) * speedScale,
    level,
    delta,
  });
}

function enemyIsInClaimedPlayerSlot({ system, enemy }) {
  const slot = system.getPlayerSlot(enemy);

  if (!system.lastPlayerPosition) {
    return false;
  }

  const attackRange = system.getAttackRange?.() ?? ENEMY_ATTACK_RANGE;
  if (!isInMeleeRange(enemy.model.position, system.lastPlayerPosition, attackRange)) {
    return false;
  }

  if (isSoldierArmSplitLocomotion(enemy)) {
    return true;
  }

  if (!slot) {
    return false;
  }

  return enemyHasReservedSpace({
    enemy,
    slot,
    slots: system.playerSlots,
    playerPosition: system.lastPlayerPosition,
  });
}

function closeEnoughToHold({ system, enemy, player }) {
  const holdRange = system.getHoldRange?.() ?? ENEMY_HOLD_RANGE;
  const playerPos = player?.group?.position;
  if (!playerPos) return false;
  // Hold uses the same height gate as attack so bots don't idle-bite under a roof.
  if (!isInMeleeRange(enemy.model.position, playerPos, holdRange)) {
    return false;
  }

  if (system.getPlayerSlot(enemy) != null) {
    return true;
  }

  return isSoldierArmSplitLocomotion(enemy);
}

function enemyIsCloseEnoughToStopChasing(enemy, player, system = null) {
  const holdRange = system?.getHoldRange?.() ?? ENEMY_HOLD_RANGE;
  return distanceToPlayer(enemy, player) <= holdRange;
}

function findBestSlotCandidate({ enemy, slots, playerPosition, frontArc = null }) {
  let bestCandidate = null;
  let bestScore = Infinity;

  playerSlotApproachDirection.subVectors(enemy.model.position, playerPosition);
  playerSlotApproachDirection.y = 0;
  const ownBearing = playerSlotApproachDirection.lengthSq() > 0.000001
    ? Math.atan2(playerSlotApproachDirection.z, playerSlotApproachDirection.x)
    : enemy.model.rotation.y;

  // Horde front-arc (M2): center the candidate ring on the MOB approach bearing
  // and clamp claimable angles to the cone, so the tip attacks from the mob
  // side. Non-horde modes leave frontArc disabled → full 360° around the
  // enemy's own bearing, exactly as before.
  const arcEnabled = Boolean(frontArc?.enabled) && Number.isFinite(frontArc?.bearing);
  const centerAngle = arcEnabled ? frontArc.bearing : ownBearing;
  const arcHalfAngle = arcEnabled ? frontArc.halfAngle : Infinity;
  const candidateRadius = preferredSlotRadius({ enemy, playerPosition });

  for (let index = 0; index < PLAYER_SLOT_CANDIDATES; index += 1) {
    const angle = centerAngle + (index === 0 ? 0 : alternatingRingOffset(index) * (Math.PI * 2 / PLAYER_SLOT_CANDIDATES));
    // Reject candidates outside the front cone (horde only).
    if (arcEnabled && Math.abs(shortestAngleDelta(angle, centerAngle)) > arcHalfAngle) {
      continue;
    }
    setPositionFromPolar({
      target: playerSlotCandidatePosition,
      center: playerPosition,
      angle,
      radius: candidateRadius,
    });

    if (!slotCandidateIsFree({ candidate: playerSlotCandidatePosition, slots })) {
      continue;
    }

    const distance = horizontalDistance(enemy.model.position, playerSlotCandidatePosition);
    const angularCost = Math.abs(shortestAngleDelta(angle, centerAngle)) * 0.18;
    const score = distance + angularCost;

    if (score < bestScore) {
      bestScore = score;
      bestCandidate = {
        angle,
        radius: candidateRadius,
        score,
      };
    }
  }

  return bestCandidate;
}

function slotCandidateIsFree({ candidate, slots, ignoreHolderId = null }) {
  for (const slot of slots) {
    if (slot.holderId == null || slot.holderId === ignoreHolderId) {
      continue;
    }

    if (horizontalDistance(candidate, slot.position) < PLAYER_SLOT_SPACING) {
      return false;
    }
  }

  return true;
}

function enemyHasReservedSpace({ enemy, slot, slots, playerPosition }) {
  if (!playerPosition || slot.holderId !== enemy.id) {
    return false;
  }

  for (const otherSlot of slots) {
    if (otherSlot.holderId == null || otherSlot.holderId === enemy.id) {
      continue;
    }

    if (horizontalDistance(enemy.model.position, otherSlot.position) < PLAYER_SLOT_SPACING) {
      return false;
    }
  }

  return true;
}

function setSlotPositionFromAngle({ slot, playerPosition }) {
  setPositionFromPolar({
    target: slot.position,
    center: playerPosition,
    angle: slot.angle,
    radius: slot.radius ?? PLAYER_SLOT_RADIUS,
  });
}

function preferredSlotRadius({ enemy, playerPosition }) {
  const currentDistance = horizontalDistance(enemy.model.position, playerPosition);
  return THREE.MathUtils.clamp(currentDistance, PLAYER_SLOT_MIN_RADIUS, PLAYER_SLOT_RADIUS);
}

function nearestAttackPosition({ enemy, player }) {
  if (!player?.group?.position) {
    return null;
  }

  playerSlotApproachDirection.subVectors(enemy.model.position, player.group.position);
  playerSlotApproachDirection.y = 0;
  const distanceToPlayer = playerSlotApproachDirection.length();

  if (distanceToPlayer <= PLAYER_SLOT_MIN_RADIUS) {
    return enemyTargetPosition.copy(enemy.model.position);
  }

  playerSlotApproachDirection.multiplyScalar(1 / distanceToPlayer);

  return enemyTargetPosition
    .copy(player.group.position)
    .addScaledVector(playerSlotApproachDirection, PLAYER_SLOT_MIN_RADIUS);
}

function angleFromCenter({ point, center }) {
  return Math.atan2(point.z - center.z, point.x - center.x);
}

function setPositionFromPolar({ target, center, angle, radius }) {
  target.set(
    center.x + Math.cos(angle) * radius,
    center.y,
    center.z + Math.sin(angle) * radius,
  );
}

function alternatingRingOffset(index) {
  const step = Math.ceil(index / 2);
  return index % 2 === 0 ? step : -step;
}

// shortestAngleDelta lives in ../utils/angleUtils.js (imported above).

function patrol({ system, enemy, level, delta }) {
  enemy.state = 'patrol';
  const patrolOffset = PATROL_OFFSETS[enemy.patrolIndex % PATROL_OFFSETS.length];
  enemyTargetPosition.copy(enemy.home).add(patrolOffset);

  if (enemy.model.position.distanceTo(enemyTargetPosition) <= PATROL_POINT_REACHED_DISTANCE) {
    enemy.patrolIndex = (enemy.patrolIndex + 1) % PATROL_OFFSETS.length;
  }

  const disabilityClip = resolveSoldierLocomotionClip(enemy);
  const clip = disabilityClip ?? 'Walk';
  playSoldierBehaviorAnimation(system, enemy, {
    fallback: clip,
    timeScale: clip === 'Walk' ? 0.9 : 1,
  });
  const speedScale = system?.getSpeedScale?.() ?? 1;
  moveToward({
    enemy,
    target: enemyTargetPosition,
    speed: resolveSoldierLocomotionSpeed(enemy, ENEMY_WALK_SPEED) * speedScale,
    level,
    delta,
  });
}

function moveToward({ enemy, target, speed, level, delta }) {
  if (!target) {
    return;
  }

  enemyMoveDirection.subVectors(target, enemy.model.position);
  enemyMoveDirection.y = 0;

  const distance = enemyMoveDirection.length();
  if (distance <= 0.001) {
    return;
  }

  enemyMoveDirection.multiplyScalar(1 / distance);
  faceDirection({ enemy, direction: enemyMoveDirection, delta });
  enemy.model.position.addScaledVector(enemyMoveDirection, Math.min(distance, speed * delta));
  snapEnemyToGround({ enemy, level, platforms: _snapPlatformsFrame });
}

function faceTarget({ enemy, target, delta }) {
  if (!target) {
    return;
  }

  enemyMoveDirection.subVectors(target, enemy.model.position);
  enemyMoveDirection.y = 0;
  if (enemyMoveDirection.lengthSq() <= 0.000001) {
    return;
  }

  faceDirection({ enemy, direction: enemyMoveDirection.normalize(), delta });
}

function faceDirection({ enemy, direction, delta }) {
  const targetYaw = Math.atan2(direction.x, direction.z);
  const turnAlpha = 1 - Math.exp(-ENEMY_TURN_SPEED * delta);
  enemy.model.rotation.y = lerpAngle(enemy.model.rotation.y, targetYaw, turnAlpha);
}

function snapEnemyToGround({ enemy, level, platforms = null }) {
  // Prefer assigned moving platform surface (M5 trailer / highway deck).
  if (platforms && Number.isFinite(enemy.platformBodyHandle)) {
    const hit = platforms.getPlatformAt?.(
      enemy.model.position,
      enemy.model.position.y,
      { verticalTolerance: 1.4 },
    );
    if (hit && hit.bodyHandle === enemy.platformBodyHandle) {
      enemy.model.position.y = hit.worldSurfacePoint.y
        + (enemy.groundOffset ?? ENEMY_GROUND_OFFSET)
        + (enemy.postureOffsetY ?? 0);
      enemy.appliedPostureOffsetY = enemy.postureOffsetY ?? 0;
      enemy.platformVelocity = {
        x: hit.pointVelocity.x,
        y: hit.pointVelocity.y,
        z: hit.pointVelocity.z,
      };
      return;
    }
  }

  const ground = level?.getGroundHeightAt?.(enemy.model.position, 0.5);

  if (Number.isFinite(ground)) {
    enemy.model.position.y = ground
      + (enemy.groundOffset ?? ENEMY_GROUND_OFFSET)
      + (enemy.postureOffsetY ?? 0);
    enemy.appliedPostureOffsetY = enemy.postureOffsetY ?? 0;
  }
}

function applyPostureOffsetToEnemy(enemy) {
  const groundY = enemy.model.position.y
    - (enemy.groundOffset ?? ENEMY_GROUND_OFFSET)
    - (enemy.appliedPostureOffsetY ?? 0);
  enemy.model.position.y = groundY
    + (enemy.groundOffset ?? ENEMY_GROUND_OFFSET)
    + (enemy.postureOffsetY ?? 0);
  enemy.appliedPostureOffsetY = enemy.postureOffsetY ?? 0;
}

function distanceToPlayer(enemy, player) {
  if (!player?.group?.position) {
    return Infinity;
  }

  return enemy.model.position.distanceTo(player.group.position);
}

function horizontalDistance(first, second) {
  return Math.hypot(first.x - second.x, first.z - second.z);
}

/**
 * Melee reach in plan view + height. Horizontal alone let ground enemies hit a
 * player standing on train cars / ledges several metres above them.
 */
function isInMeleeRange(enemyPos, playerPos, range, heightRange = ENEMY_ATTACK_HEIGHT_RANGE) {
  if (!enemyPos || !playerPos) return false;
  if (horizontalDistance(enemyPos, playerPos) > range) return false;
  const dy = Math.abs((enemyPos.y ?? 0) - (playerPos.y ?? 0));
  return dy <= heightRange;
}

function separateEnemies({ first, second, level, platforms = null }) {
  enemySeparationDelta.subVectors(second.model.position, first.model.position);
  enemySeparationDelta.y = 0;
  const distance = enemySeparationDelta.length();
  const minimumDistance =
    (first.collisionRadius ?? 0.5) +
    (second.collisionRadius ?? 0.5) +
    ENEMY_SEPARATION_PADDING;

  if (distance >= minimumDistance) {
    return false;
  }

  if (distance <= 0.0001) {
    enemySeparationDelta.set(1, 0, 0);
  } else {
    enemySeparationDelta.multiplyScalar(1 / distance);
  }

  const push = (minimumDistance - Math.max(distance, 0.0001)) * 0.5;
  first.model.position.addScaledVector(enemySeparationDelta, -push);
  second.model.position.addScaledVector(enemySeparationDelta, push);
  const plats = platforms ?? _snapPlatformsFrame;
  snapEnemyToGround({ enemy: first, level, platforms: plats });
  snapEnemyToGround({ enemy: second, level, platforms: plats });
  return true;
}

function resolveEnemySpawnPosition({ index, playerPosition, level, groundOffset = ENEMY_GROUND_OFFSET }) {
  const offset = SPAWN_OFFSETS[index % SPAWN_OFFSETS.length];
  const position = new THREE.Vector3(
    (playerPosition?.x ?? 0) + offset.x,
    playerPosition?.y ?? 0,
    (playerPosition?.z ?? 0) + offset.z,
  );
  const ground = level?.getGroundHeightAt?.(position, 0.5);

  if (Number.isFinite(ground)) {
    position.y = ground + groundOffset;
  }

  return position;
}

function createActions(mixer, clips) {
  const actions = new Map();

  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    actions.set(clip.name, action);
    actions.set(clip.name.toLowerCase(), action);
  }

  return actions;
}

function prepareAnimationClips(clips) {
  return clips.map((clip) => (
    isSoldierDisabilityClip(clip.name)
      ? lockRootHorizontalTranslation(clip)
      : lockRootTranslation(clip)
  ));
}

function findAction(actions, name) {
  return actions.get(name) ?? actions.get(String(name).toLowerCase()) ?? null;
}

function lockRootTranslation(clip) {
  const filteredTracks = clip.tracks.filter((track) => !isRootTranslationTrack(track.name));

  if (filteredTracks.length === clip.tracks.length) {
    return clip;
  }

  const lockedClip = new THREE.AnimationClip(clip.name, clip.duration, filteredTracks);
  lockedClip.blendMode = clip.blendMode;
  lockedClip.userData = { ...(clip.userData ?? {}), rootTranslationLocked: true };
  return lockedClip;
}

function isRootTranslationTrack(trackName) {
  const name = trackName.toLowerCase();
  return (
    name === 'root.position' ||
    name === 'hips.position' ||
    name === 'mixamorig:hips.position' ||
    name === 'mixamorighips.position' ||
    name.endsWith('/root.position') ||
    name.endsWith('/hips.position')
  );
}

function lockRootHorizontalTranslation(clip) {
  const tracks = clip.tracks.map((track) => {
    if (!isRootTranslationTrack(track.name) || !(track instanceof THREE.VectorKeyframeTrack)) {
      return track;
    }

    const values = track.values.slice();
    for (let index = 0; index < values.length; index += 3) {
      values[index] = 0;
      values[index + 2] = 0;
    }

    return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
  });

  const lockedClip = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  lockedClip.blendMode = clip.blendMode;
  lockedClip.userData = { ...(clip.userData ?? {}), rootHorizontalLocked: true };
  return lockedClip;
}

function findMixamoHips(root) {
  let hips = null;
  root.traverse((object) => {
    if (!object.isBone || hips) {
      return;
    }

    const name = String(object.name).replace(/^mixamorig:?/i, '').toLowerCase();
    if (name === 'hips') {
      hips = object;
    }
  });
  return hips;
}

function sampleActionHipsWorldYAtRotation(enemy, clipName, rotationX) {
  const inner = enemy.model?.children?.[0];
  if (!inner) {
    return null;
  }

  const priorRotationX = inner.rotation.x;
  inner.rotation.x = rotationX;
  inner.updateMatrixWorld(true);
  const hipsY = sampleActionHipsWorldY(enemy, clipName);
  inner.rotation.x = priorRotationX;
  inner.updateMatrixWorld(true);
  return hipsY;
}

function sampleActionHipsWorldY(enemy, clipName) {
  const inner = enemy.model?.children?.[0];
  const hips = inner ? findMixamoHips(inner) : null;
  const action = findAction(enemy.actions, clipName);

  if (!inner || !hips || !action) {
    return null;
  }

  const priorAction = enemy.action;
  const priorTime = priorAction?.time ?? 0;

  const clip = action.getClip();
  const sampleTimes = isSoldierProneLocomotionClip(clipName)
    ? [0, clip.duration * 0.25, clip.duration * 0.5, clip.duration * 0.75]
    : [0];

  action.reset();
  action.enabled = true;
  action.setEffectiveWeight(1);
  action.play();

  let hipsY = Infinity;
  for (const time of sampleTimes) {
    action.time = time;
    enemy.mixer.update(0);
    inner.updateMatrixWorld(true);
    hips.getWorldPosition(sampleHipsWorld);
    hipsY = Math.min(hipsY, sampleHipsWorld.y);
  }

  if (priorAction && priorAction !== action) {
    action.stop();
    priorAction.reset();
    priorAction.enabled = true;
    priorAction.setEffectiveWeight(1);
    priorAction.play();
    priorAction.time = priorTime;
    enemy.action = priorAction;
    enemy.mixer.update(0);
  }

  return hipsY;
}

function prepareAsset(root, { fixMaterials = true } = {}) {
  const renderObjects = [];

  root.traverse((child) => {
    if (child.isMesh || child.isSkinnedMesh) {
      renderObjects.push(child);
      child.castShadow = true;
      child.receiveShadow = true;
      // frustumCulled left at default (true) so far/offscreen enemies do not burn draw calls.
      // Main camera far + fog + enemy distance logic already limit work.
      if (fixMaterials) {
        prepareEnemyMaterials(child);
      }
    }
  });

  return renderObjects;
}

// Tripo-exported GLBs ship with alphaMode BLEND + metallic=1 even on a fully
// opaque character, which (with no scene.environment/IBL) renders the mesh
// see-through and near-black. Force a sane dielectric, opaque material so the
// soldier renders solid and lit. Mirrors Mara's prepareRenderable.
function prepareEnemyMaterials(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  for (const material of materials) {
    if (!material) {
      continue;
    }

    material.metalness = 0;
    if (material.metalnessMap) {
      material.metalnessMap = null;
    }

    material.roughness = Math.max(material.roughness ?? 0.6, 0.68);

    if (material.map) {
      material.map.colorSpace = THREE.SRGBColorSpace;
    }

    if ((material.opacity ?? 1) >= 1) {
      material.transparent = false;
      material.depthWrite = true;
    }

    material.needsUpdate = true;
  }
}

function enemyAnimationStep({ enemy, playerPosition }) {
  if (!playerPosition) {
    return 0;
  }

  if (enemy.state === 'attack' || enemy.state === 'hold') {
    return 0;
  }

  const distance = horizontalDistance(enemy.model.position, playerPosition);

  if (distance <= ENEMY_FULL_ANIMATION_DISTANCE) {
    return 0;
  }

  return distance <= ENEMY_REDUCED_ANIMATION_DISTANCE
    ? ENEMY_MID_ANIMATION_STEP
    : ENEMY_FAR_ANIMATION_STEP;
}

function setEnemyShadowCasting(enemy, enabled) {
  const budget = enemy.renderBudget;

  if (budget?.shadowCasting === enabled) {
    return;
  }

  for (const object of enemy.renderObjects ?? []) {
    object.castShadow = enabled;
  }

  if (budget) {
    budget.shadowCasting = enabled;
  }
}

function disposeEnemyClone(root) {
  root?.traverse?.((child) => {
    // Partial sever paths replace shared GLB geometry with an instance-owned
    // subset. Release those buffers when the live enemy is removed; untouched
    // clone geometry remains shared with the archetype asset and must not be
    // disposed here.
    if (child.userData?.geometryOwned) {
      child.geometry?.dispose?.();
      child.userData.geometryOwned = false;
    }
    child.skeleton?.dispose?.();
  });
}

function normalizeToHeight(root, targetHeight) {
  // Box3.setFromObject(root, true) computes the true SKINNED (bind-pose) bounds:
  // for SkinnedMesh it applies the bone transforms, so the armature's intrinsic
  // unit scale is accounted for. The raw geometry bounding box is authored in a
  // normalized [-1,1] bind space and the bones carry the real scale, so measuring
  // geometry.boundingBox * matrixWorld instead reports ~2x the rendered height and
  // shrinks every enemy. flattenObjectForWebGPU has already de-quantized positions,
  // so the precise (per-vertex, bone-aware) path is safe here.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, true);
  const size = box.getSize(new THREE.Vector3());

  if (!Number.isFinite(size.y) || size.y <= 0) {
    return;
  }

  const scale = targetHeight / size.y;
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  const normalizedBox = new THREE.Box3().setFromObject(root, true);
  root.position.y -= normalizedBox.min.y;
}

function lerpAngle(from, to, alpha) {
  let delta = (to - from + Math.PI) % (Math.PI * 2) - Math.PI;
  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }

  return from + delta * alpha;
}

function vectorSnapshot(vector) {
  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3)),
  };
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
