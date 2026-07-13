import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs,
  add,
  attribute,
  clamp,
  float,
  fract,
  mul,
  positionLocal,
  time,
  uniform,
} from 'three/tsl';
import { prepareBakedCrowdPoseCatalog } from '../geometry/prepareBakedCrowdPoses.js';
import { bakeHordeProxyVatGeometry } from '../geometry/bakeHordeProxyVat.js';
import { getArchetype } from '../config/enemyArchetypes.js';
import {
  HORDE_COMBAT_GRID_CELL,
  HORDE_DEFAULT_ARENA_HALF,
  HORDE_GPU_WALK_CPS,
  HORDE_MAX_ENEMY_COUNT,
  HORDE_PROXY_CORPSE_LIFETIME,
  HORDE_PROXY_DEMOTION_RADIUS,
  HORDE_PROXY_PROMOTION_RADIUS,
  HORDE_PROXY_PROMOTIONS_PER_TICK,
  HORDE_PROXY_TICK_STEP,
  HORDE_PROXY_VERTEX_LIMIT,
  HORDE_SECTOR_GRID,
  hordeSectorCapacity,
} from '../config/hordePerformanceConfig.js';
import { createGltfLoader } from '../utils/createGltfLoader.js';
import { HordeFlowField } from './HordeFlowField.js';
import { HordeSuppressionField } from './HordeSuppressionField.js';
import { UniformSpatialGrid } from './UniformSpatialGrid.js';
import { stepFlockSteering, DEFAULT_FLOCK_WEIGHTS } from './hordeFlockSteering.js';
import {
  buildHordeSectors,
  findSectorWithRoom,
  sectorIndexAt,
  sectorMeshKey,
} from './hordeProxySectors.js';

/**
 * M5: sector-culled InstancedMesh batches + GPU walk blend (VAT-lite).
 *
 * Multi-pose InstancedMesh hopping strobed on WebGPU, so animation is a single
 * mesh per (archetype, sector) with pose1 vertex attribute + instance phase.
 * Sectors frustum-cull independently so off-screen crowds skip draws.
 */
const DISPLAY_POSE = Object.freeze({
  key: 'advance_1',
  anim: 'advance',
  clipName: 'Walk',
  sampleTime: 0.33,
});

const ARCHETYPES = Object.freeze(['faceless', 'tessy', 'cyclop']);
/** Reused GPU pose-weight results to keep _animWeightsFor allocation-free. */
const ZERO_ANIM_WEIGHTS = Object.freeze({ walk: 0, attack: 0 });
const ATTACK_ANIM_WEIGHTS = Object.freeze({ walk: 0, attack: 1 });
const PROXY_RING_SPACING = 0.72;
const PROXY_SNAPSHOT_LIMIT = 24;
const collapsedInstanceMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
/** Shared walk rate uniform — one GPU clock for all proxy materials. */
const _gpuWalkCps = uniform(HORDE_GPU_WALK_CPS);
/** Strike cadence — punches are snappier than a walk stride. */
const _gpuAttackCps = uniform(HORDE_GPU_WALK_CPS * 2.4);

/** Flow-field grid resolution (m) and recompute cadence (Hz). */
const FLOW_CELL_SIZE = 0.75;
const FLOW_BOUNDS_PAD = 4;
const FLOW_UPDATE_INTERVAL = 1 / 5; // ~5 Hz, off the render + steering cadence
/** Recompute the field early if the player has moved this far since last bake. */
const FLOW_PLAYER_MOVE_EPS = FLOW_CELL_SIZE * 0.5;

/**
 * Cheap visual/simulation tier for Horde overflow.
 *
 * Sector-partitioned InstancedMeshes (M5) with stable per-sector slots.
 * Agents flock at 12 Hz and promote into EnemySystem. GPU walk blend advances
 * from a time uniform so animation does not re-upload pose geometry.
 */
export class HordeProxySystem {
  constructor({
    capacity = HORDE_MAX_ENEMY_COUNT,
    sectorGrid = HORDE_SECTOR_GRID,
    gpuWalk = true,
  } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'Horde Proxy Group';
    this.capacity = capacity;
    this.sectorGrid = Math.max(1, Math.floor(sectorGrid));
    this.gpuWalk = Boolean(gpuWalk);
    this.sectorCapacity = hordeSectorCapacity(capacity, this.sectorGrid);
    this.status = 'idle';
    this.error = null;
    this.agents = [];
    /** @type {Map<string, THREE.InstancedMesh>} key = archetype@sectorIndex */
    this.meshes = new Map();
    /** @type {Array<object>} */
    this.sectors = [];
    this.geometrySource = 'none';
    this._baked = [];
    this._sharedGeometry = new Map(); // archetype → BufferGeometry
    this._sharedMaterial = new Map(); // archetype → material
    this._nextId = 1;
    this._accumulator = 0;
    this._dirty = false;
    this._dirtySectors = new Set();
    this._matrixObject = new THREE.Object3D();
    // Flow-mob steering (M1). Field + broadphase are built at load() once the
    // level colliders/bounds are threaded in via setLevelContext().
    this.flowField = null;
    // Suppression field (M3) — same bounds/cellSize as flowField so gradients
    // align cell-for-cell with the flow direction.
    this.suppressionField = null;
    this.flockGrid = new UniformSpatialGrid(DEFAULT_FLOCK_WEIGHTS.neighborRadius);
    /** Broader grid for combat queries (hitscan candidates, explosions). */
    this.combatGrid = new UniformSpatialGrid(HORDE_COMBAT_GRID_CELL);
    this.flockWeights = DEFAULT_FLOCK_WEIGHTS;
    this._levelColliders = null;
    this._levelBounds = null;
    this._getGroundHeightAt = null;
    this._flowGoal = { x: 0, z: 0 };
    this._flowUpdateTimer = 0;
    this._flowLastGoalX = Infinity;
    this._flowLastGoalZ = Infinity;
    /** archetype → sectorIndex → live count */
    this._sectorCounts = new Map();
    this._hitTargets = [];
    this._nearHitTargets = [];
    this._combatGridDirty = true;
    /** M6: distance beyond which walk blend is attenuated (readability + GPU). */
    this.farWalkDistance = 28;
    this.farWalkWeight = 0.35;
    this._playerPositionForLod = null;
    this._stats = {
      ticks: 0,
      promoted: 0,
      demoted: 0,
      emergencyPromoted: 0,
      lightweightHits: 0,
      lightweightKills: 0,
      areaHits: 0,
      areaKills: 0,
      matrixUploads: 0,
      sectorMigrations: 0,
      peakCount: 0,
      gpuWalk: this.gpuWalk,
    };
  }

  /**
   * M6 spectacle tuning: flock readability weights + far-field walk LOD.
   */
  applySpectacleTuning({
    flock = null,
    farWalkWeight = null,
    farWalkDistance = null,
  } = {}) {
    if (flock && typeof flock === 'object') {
      this.flockWeights = {
        ...this.flockWeights,
        ...flock,
      };
      // Neighbor radius drives flock grid cell size.
      if (Number.isFinite(flock.neighborRadius) && flock.neighborRadius > 0) {
        this.flockGrid.cellSize = flock.neighborRadius;
      }
    }
    if (Number.isFinite(farWalkWeight)) {
      this.farWalkWeight = Math.max(0, Math.min(1, farWalkWeight));
    }
    if (Number.isFinite(farWalkDistance) && farWalkDistance > 0) {
      this.farWalkDistance = farWalkDistance;
    }
    return {
      flock: { ...this.flockWeights },
      farWalkWeight: this.farWalkWeight,
      farWalkDistance: this.farWalkDistance,
    };
  }

  /**
   * Thread the arena's static collision + ground data so the proxy system can
   * build its own flow field. Bounds are derived from the collider AABB union
   * (padded) rather than a magic half-extent constant.
   */
  setLevelContext({ colliders = null, getGroundHeightAt = null, bounds = null } = {}) {
    this._levelColliders = Array.isArray(colliders) ? colliders : null;
    this._getGroundHeightAt = typeof getGroundHeightAt === 'function' ? getGroundHeightAt : null;
    this._levelBounds = bounds ?? (this._levelColliders
      ? deriveBoundsFromColliders(this._levelColliders, FLOW_BOUNDS_PAD)
      : defaultArenaBounds());
    this._buildFlowField();
    // Rebuild sector rects if meshes already exist (hot-reload / arena swap).
    if (this.ready) this._ensureSectors();
  }

  _buildFlowField() {
    if (!this._levelColliders || !this._levelBounds) {
      this.flowField = null;
      this.suppressionField = null;
      return;
    }
    this.flowField = new HordeFlowField({
      colliders: this._levelColliders,
      bounds: this._levelBounds,
      cellSize: FLOW_CELL_SIZE,
      agentRadius: 0.35,
      agentHeight: 1.8,
      floorY: 0,
    });
    // Same bounds + cellSize → suppression cells align with flow cells.
    this.suppressionField = new HordeSuppressionField({
      bounds: this._levelBounds,
      cellSize: FLOW_CELL_SIZE,
    });
    // Prime the field so the first tick has a usable integration field.
    this.flowField.update(this._flowGoal.x, this._flowGoal.z);
    this._flowUpdateTimer = 0;
    this._flowLastGoalX = this._flowGoal.x;
    this._flowLastGoalZ = this._flowGoal.z;
  }

  async load(scene, { enemySystem, colliders = null, getGroundHeightAt = null, bounds = null } = {}) {
    if (!scene || !enemySystem) return false;
    this.status = 'loading';
    this.error = null;
    if (this.group.parent !== scene) scene.add(this.group);
    this.setLevelContext({
      colliders: colliders ?? this._levelColliders,
      getGroundHeightAt: getGroundHeightAt ?? this._getGroundHeightAt,
      bounds: bounds ?? this._levelBounds,
    });

    try {
      const loader = createGltfLoader();
      for (const archetype of ARCHETYPES) {
        const config = getArchetype(archetype);
        const bakeSource = await loadProxyBakeSource({
          loader,
          config,
          fullAsset: enemySystem.getArchetypeAsset?.(archetype),
          archetype,
        });
        const baked = bakeProxyGeometryWithVat({
          sceneRoot: bakeSource.scene,
          clips: bakeSource.clips,
          config,
          archetype,
          gpuWalk: this.gpuWalk,
        });
        if (!baked?.geometry || !baked?.material) {
          throw new Error(`${archetype}: supplied proxy mesh could not be baked`);
        }
        this._sharedGeometry.set(archetype, baked.geometry);
        this._sharedMaterial.set(archetype, baked.material);
        this._baked.push(...(baked.poses ?? [baked.pose].filter(Boolean)));
        if (bakeSource.kind === 'proxy' && bakeSource.scene) disposeObjectTree(bakeSource.scene);
        this.geometrySource = mergeGeometrySource(
          this.geometrySource,
          baked.vat ? 'vat' : 'baked',
        );
        this._sectorCounts.set(archetype, new Map());
      }

      this._ensureSectors();
      this._buildSectorMeshes();
      this.status = 'ready';
      return true;
    } catch (error) {
      this.status = 'error';
      this.error = error;
      console.warn('[HordeProxySystem] failed to build proxy meshes', error);
      return false;
    }
  }

  _ensureSectors() {
    const bounds = this._levelBounds ?? defaultArenaBounds();
    this.sectors = buildHordeSectors(bounds, this.sectorGrid);
    if (!this.sectors.length) {
      this.sectors = buildHordeSectors(defaultArenaBounds(), this.sectorGrid);
    }
  }

  _buildSectorMeshes() {
    // Tear down previous sector meshes. Materials/shared geom stay; per-sector
    // geometry clones are disposed with the mesh.
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      if (mesh.userData.ownsGeometry) mesh.geometry?.dispose?.();
      mesh.dispose?.();
    }
    this.meshes.clear();

    for (const sector of this.sectors) {
      for (const archetype of ARCHETYPES) {
        const sharedGeometry = this._sharedGeometry.get(archetype);
        const material = this._sharedMaterial.get(archetype);
        if (!sharedGeometry || !material) continue;
        // Clone geometry so each sector mesh owns its InstancedBufferAttributes
        // (instanceAnim) while vertex buffers are still duplicated — acceptable
        // at ~10k verts × sector count for the stretch gate.
        const geometry = sharedGeometry.clone();
        const key = sectorMeshKey(archetype, sector.index);
        const mesh = new THREE.InstancedMesh(geometry, material, this.sectorCapacity);
        mesh.name = `Horde ${archetype} S${sector.index}`;
        mesh.userData.hordeArchetype = archetype;
        mesh.userData.hordeSectorIndex = sector.index;
        mesh.userData.hordeGeometrySource = this.geometrySource;
        mesh.userData.ownsGeometry = true;
        initializeProxyInstanceStream(mesh, this.sectorCapacity);
        // Sector-local sphere so off-screen cells frustum-cull cleanly.
        mesh.frustumCulled = true;
        mesh.boundingSphere = new THREE.Sphere(
          new THREE.Vector3(sector.cx, 1.1, sector.cz),
          sector.radius,
        );
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        // Live instance count only — drawing sectorCapacity zero-scale instances
        // (thousands) every frame crushed empty-yard FPS on WebGPU.
        mesh.count = 0;
        mesh.visible = false;
        this.meshes.set(key, mesh);
        this.group.add(mesh);
        this._sectorCounts.get(archetype)?.set(sector.index, 0);
      }
    }
  }

  /**
   * Dense packing uses slots 0..n-1, so draw exactly n instances (0 when empty).
   * Avoids submitting thousands of collapsed instances per sector mesh.
   */
  _syncSectorMeshCount(mesh) {
    if (!mesh) return;
    const archetype = mesh.userData.hordeArchetype;
    const sectorIndex = mesh.userData.hordeSectorIndex;
    const n = this._sectorCounts.get(archetype)?.get(sectorIndex) ?? 0;
    mesh.count = n;
    mesh.visible = n > 0;
  }

  _meshFor(agent) {
    if (!agent || agent.sectorIndex == null) return null;
    return this.meshes.get(sectorMeshKey(agent.archetype, agent.sectorIndex)) ?? null;
  }

  _sectorHasRoom(archetype, sectorIndex) {
    const count = this._sectorCounts.get(archetype)?.get(sectorIndex) ?? 0;
    return count < this.sectorCapacity;
  }

  _allocSlot(archetype, preferredSector) {
    const sectorIndex = findSectorWithRoom(
      preferredSector,
      this.sectorGrid,
      (index) => this._sectorHasRoom(archetype, index),
    );
    if (sectorIndex < 0) return null;
    const counts = this._sectorCounts.get(archetype);
    const slot = counts?.get(sectorIndex) ?? 0;
    counts?.set(sectorIndex, slot + 1);
    const mesh = this.meshes.get(sectorMeshKey(archetype, sectorIndex));
    this._syncSectorMeshCount(mesh);
    return { sectorIndex, slot };
  }

  _releaseSlot(agent) {
    if (!agent || agent.slot == null || agent.sectorIndex == null) return;
    const mesh = this._meshFor(agent);
    const counts = this._sectorCounts.get(agent.archetype);
    const activeCount = counts?.get(agent.sectorIndex) ?? 0;
    const lastSlot = activeCount - 1;
    if (mesh && lastSlot >= 0) {
      if (agent.slot !== lastSlot) {
        const tailAgent = this.agents.find((candidate) => (
          candidate !== agent
          && candidate.archetype === agent.archetype
          && candidate.sectorIndex === agent.sectorIndex
          && candidate.slot === lastSlot
        ));
        if (tailAgent) {
          tailAgent.slot = agent.slot;
          tailAgent.matrixDirty = true;
          this._writeAgentMatrix(tailAgent);
          this._writeAnimAttr(tailAgent);
        }
      }
      mesh.setMatrixAt(lastSlot, collapsedInstanceMatrix);
      this._setAnimAttr(mesh, lastSlot, 0, 0);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.userData.instanceAnim?.needsUpdate !== undefined) {
        mesh.userData.instanceAnim.needsUpdate = true;
      }
      this._dirtySectors.add(agent.sectorIndex);
    }
    counts?.set(agent.sectorIndex, Math.max(0, lastSlot));
    this._syncSectorMeshCount(mesh);
    agent.slot = null;
    agent.sectorIndex = null;
  }

  _migrateAgentSector(agent) {
    if (!agent || agent.health <= 0 || agent.anim === 'fallen') return;
    const bounds = this._levelBounds ?? defaultArenaBounds();
    const preferred = sectorIndexAt(agent.position.x, agent.position.z, bounds, this.sectorGrid);
    if (preferred === agent.sectorIndex) return;
    if (!this._sectorHasRoom(agent.archetype, preferred)
      && findSectorWithRoom(preferred, this.sectorGrid, (i) => this._sectorHasRoom(agent.archetype, i)) < 0) {
      return; // stay put if destination full
    }
    const oldMesh = this._meshFor(agent);
    const oldSector = agent.sectorIndex;
    const oldSlot = agent.slot;
    // Free old slot without losing agent record.
    this._releaseSlot(agent);
    const alloc = this._allocSlot(agent.archetype, preferred);
    if (!alloc) {
      // Restore previous sector if re-alloc failed.
      const restore = this._allocSlot(agent.archetype, oldSector ?? preferred);
      if (restore) {
        agent.sectorIndex = restore.sectorIndex;
        agent.slot = restore.slot;
        agent.matrixDirty = true;
        this._writeAgentMatrix(agent);
        this._writeAnimAttr(agent);
      }
      return;
    }
    agent.sectorIndex = alloc.sectorIndex;
    agent.slot = alloc.slot;
    agent.matrixDirty = true;
    this._writeAgentMatrix(agent);
    this._writeAnimAttr(agent);
    this._stats.sectorMigrations += 1;
    if (oldMesh && oldSlot != null) this._dirtySectors.add(oldSector);
    this._dirtySectors.add(alloc.sectorIndex);
    void oldSlot;
  }

  get ready() {
    return this.status === 'ready' && this.meshes.size > 0;
  }

  addProxy(descriptor) {
    if (!this.ready || this.agents.length >= this.capacity || !descriptor) return null;
    const config = getArchetype(descriptor.archetype);
    if (!config) return null;

    const ordinal = this._nextId++;
    const healthScale = Number.isFinite(descriptor.healthScale) ? descriptor.healthScale : 1;
    const maxHealth = Number.isFinite(descriptor.maxHealth)
      ? descriptor.maxHealth
      : (config.maxHealth ?? 100) * healthScale;
    const health = Number.isFinite(descriptor.health)
      ? Math.min(maxHealth, Math.max(0, descriptor.health))
      : maxHealth;
    const positionSource = descriptor.proxyPosition ?? descriptor.position;
    if (!positionSource?.clone && !(Number.isFinite(positionSource?.x) && Number.isFinite(positionSource?.z))) {
      return null;
    }
    const position = positionSource.clone
      ? positionSource.clone()
      : new THREE.Vector3(positionSource.x, positionSource.y ?? 0, positionSource.z);

    const bounds = this._levelBounds ?? defaultArenaBounds();
    const preferred = sectorIndexAt(position.x, position.z, bounds, this.sectorGrid);
    const alloc = this._allocSlot(descriptor.archetype, preferred);
    if (!alloc) return null;

    const phaseOffset = Number.isFinite(descriptor.phase) ? descriptor.phase : hash01(ordinal * 17 + 3);
    const agent = {
      id: descriptor.id ?? `horde-proxy-${ordinal}`,
      archetype: descriptor.archetype,
      sectorIndex: alloc.sectorIndex,
      slot: alloc.slot,
      position,
      yaw: descriptor.proxyYaw ?? descriptor.yaw ?? 0,
      heading: descriptor.proxyYaw ?? descriptor.yaw ?? 0,
      distToGoal: Infinity,
      healthScale,
      health,
      maxHealth,
      speed: 1.7 * (config.moveSpeedScale ?? 1),
      phaseOffset,
      animTime: 0,
      anim: health <= 0 ? 'fallen' : 'advance',
      hitTimer: 0,
      corpseTimer: health <= 0 ? HORDE_PROXY_CORPSE_LIFETIME : 0,
      ringAngle: Number.isFinite(descriptor.ringAngle)
        ? descriptor.ringAngle
        : hash01(ordinal * 31 + 11) * Math.PI * 2,
      ringOffset: Number.isFinite(descriptor.ringOffset)
        ? descriptor.ringOffset
        : (ordinal % 7) * PROXY_RING_SPACING,
      matrixDirty: true,
      animAttrDirty: true,
    };
    this.agents.push(agent);
    this._writeAgentMatrix(agent);
    this._writeAnimAttr(agent);
    this._dirty = true;
    this._dirtySectors.add(alloc.sectorIndex);
    this._combatGridDirty = true;
    this._stats.peakCount = Math.max(this._stats.peakCount, this.agents.length);
    if (descriptor.fromDemotion) this._stats.demoted += 1;
    return agent;
  }

  /** Living proxies (excludes fallen corpses waiting for cull). */
  countLiving() {
    let count = 0;
    for (const agent of this.agents) {
      if (agent.health > 0 && agent.anim !== 'fallen') count += 1;
    }
    return count;
  }

  countCorpses() {
    let count = 0;
    for (const agent of this.agents) {
      if (agent.health <= 0 || agent.anim === 'fallen' || agent.corpseTimer > 0) count += 1;
    }
    return count;
  }

  _rebuildCombatGridIfNeeded() {
    if (!this._combatGridDirty) return;
    this.combatGrid.rebuild(
      this.agents,
      (agent) => agent.position,
      HORDE_COMBAT_GRID_CELL,
    );
    this._combatGridDirty = false;
  }

  nearestAgentDistanceSq(playerPosition) {
    if (!playerPosition || this.agents.length === 0) return Number.POSITIVE_INFINITY;
    let best = Number.POSITIVE_INFINITY;
    for (const agent of this.agents) {
      if (agent.health <= 0 || agent.anim === 'fallen') continue;
      const dx = agent.position.x - playerPosition.x;
      const dz = agent.position.z - playerPosition.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq < best) best = distanceSq;
    }
    return best;
  }

  /**
   * Lowest flow distance-to-goal among promotable proxies inside the promote
   * band (the front of the mob). Infinity when none qualify / no field. Used by
   * demotion hysteresis: a full actor only demotes when its flow distance is
   * meaningfully greater than this (the mob has surged past it).
   */
  frontmostPromotableFlowDistance(playerPosition, radius = HORDE_PROXY_PROMOTION_RADIUS) {
    if (!playerPosition || this.agents.length === 0) return Infinity;
    const maxDistanceSq = radius * radius;
    let best = Infinity;
    for (const agent of this.agents) {
      if (agent.health <= 0 || agent.anim === 'fallen') continue;
      const dx = agent.position.x - playerPosition.x;
      const dz = agent.position.z - playerPosition.z;
      if (dx * dx + dz * dz > maxDistanceSq) continue;
      const flow = Number.isFinite(agent.distToGoal) ? agent.distToGoal : Infinity;
      if (flow < best) best = flow;
    }
    return best;
  }

  /**
   * XZ centroid of the live proxy mob (M2 front-arc bearing). Writes into `out`
   * ({x,z}) and returns the number of agents averaged, or 0 if none.
   */
  mobCentroid(out = { x: 0, z: 0 }) {
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    for (const agent of this.agents) {
      if (agent.health <= 0 || agent.anim === 'fallen') continue;
      sumX += agent.position.x;
      sumZ += agent.position.z;
      count += 1;
    }
    if (count > 0) {
      out.x = sumX / count;
      out.z = sumZ / count;
    }
    return count;
  }

  hasPromotableNear(playerPosition, radius = HORDE_PROXY_PROMOTION_RADIUS) {
    if (!playerPosition || this.agents.length === 0) return false;
    const maxDistanceSq = radius * radius;
    for (const agent of this.agents) {
      if (agent.health <= 0 || agent.anim === 'fallen') continue;
      const dx = agent.position.x - playerPosition.x;
      const dz = agent.position.z - playerPosition.z;
      if (dx * dx + dz * dz <= maxDistanceSq) return true;
    }
    return false;
  }

  getHitTargets() {
    let write = 0;
    for (const agent of this.agents) {
      if (agent.health <= 0 || agent.anim === 'fallen') continue;
      this._writeHitTarget(write, agent);
      write += 1;
    }
    this._hitTargets.length = write;
    return this._hitTargets;
  }

  /**
   * Living proxies near a world XZ point (spatial grid). Preferred for hitscan /
   * sword when the full 250-list is wasteful; falls back to getHitTargets when
   * radius is non-finite.
   */
  getHitTargetsNear(x, z, radius = 24) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius)) {
      return this.getHitTargets();
    }
    this._rebuildCombatGridIfNeeded();
    let write = 0;
    this.combatGrid.forEachInRadius(x, z, radius, (agent) => agent.position, (agent) => {
      if (agent.health <= 0 || agent.anim === 'fallen') return;
      this._writeHitTarget(write, agent, this._nearHitTargets);
      write += 1;
    });
    this._nearHitTargets.length = write;
    return this._nearHitTargets;
  }

  _writeHitTarget(write, agent, pool = this._hitTargets) {
    const config = getArchetype(agent.archetype);
    let target = pool[write];
    if (!target) {
      target = {
        isHordeProxy: true,
        proxyAgent: null,
        id: null,
        health: 0,
        model: { position: null, visible: true },
        collisionHeight: 1.8,
        collisionRadius: 0.45,
        pendingCorpse: false,
        defeated: false,
      };
      pool[write] = target;
    }
    target.isHordeProxy = true;
    target.proxyAgent = agent;
    target.id = agent.id;
    target.health = agent.health;
    target.model.position = agent.position;
    target.model.visible = true;
    target.collisionHeight = config.collisionHeight ?? 1.8;
    target.collisionRadius = config.collisionRadius ?? 0.45;
    target.pendingCorpse = false;
    target.defeated = false;
    return target;
  }

  findAgentById(id) {
    if (id == null) return null;
    return this.agents.find((agent) => agent.id === id) ?? null;
  }

  takeAgentById(id) {
    const index = this.agents.findIndex((agent) => agent.id === id);
    if (index < 0) return null;
    const agent = this.agents[index];
    this._removeAt(index);
    return agent;
  }

  noteEmergencyPromote() {
    this._stats.emergencyPromoted += 1;
    this._stats.promoted += 1;
  }

  applyLightweightDamage(agentOrId, damage) {
    const agent = typeof agentOrId === 'string' || typeof agentOrId === 'number'
      ? this.findAgentById(agentOrId)
      : agentOrId?.proxyAgent ?? agentOrId;
    if (!agent || agent.health <= 0) return { killed: false, remaining: 0 };
    const amount = Math.max(0, Number(damage) || 0);
    agent.health = Math.max(0, agent.health - amount);
    agent.anim = 'hit';
    agent.hitTimer = 0.4;
    agent.animTime = 0;
    this._stats.lightweightHits += 1;
    agent.matrixDirty = true;
    agent.animAttrDirty = true;
    this._dirty = true;
    if (agent.health > 0) {
      return { killed: false, remaining: agent.health, agent };
    }
    agent.anim = 'fallen';
    agent.animTime = 0;
    agent.corpseTimer = HORDE_PROXY_CORPSE_LIFETIME;
    agent.matrixDirty = true;
    agent.animAttrDirty = true;
    this._stats.lightweightKills += 1;
    return { killed: true, remaining: 0, agent };
  }

  /**
   * M4 mass-kill / explosion: damage every living proxy in a radius via the
   * combat spatial grid. Does not promote anyone — callers may promote the
   * nearest N separately for detailed deaths.
   *
   * @returns {{ hit: number, killed: number, damaged: Array<{ agent, distanceSq, killed }> }}
   */
  applyAreaDamage({ x, z, radius, damage } = {}) {
    const result = { hit: 0, killed: 0, damaged: [] };
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius <= 0) {
      return result;
    }
    const amount = Math.max(0, Number(damage) || 0);
    if (amount <= 0) return result;

    this._rebuildCombatGridIfNeeded();
    const victims = [];
    this.combatGrid.forEachInRadius(x, z, radius, (agent) => agent.position, (agent, distanceSq) => {
      if (agent.health <= 0 || agent.anim === 'fallen') return;
      victims.push({ agent, distanceSq });
    });
    // Nearest-first so detailed-death selection by the caller is stable.
    victims.sort((a, b) => a.distanceSq - b.distanceSq);

    for (const entry of victims) {
      const outcome = this.applyLightweightDamage(entry.agent, amount);
      result.hit += 1;
      this._stats.areaHits += 1;
      if (outcome.killed) {
        result.killed += 1;
        this._stats.areaKills += 1;
      }
      result.damaged.push({
        agent: entry.agent,
        distanceSq: entry.distanceSq,
        killed: outcome.killed,
        remaining: outcome.remaining,
      });
    }
    return result;
  }

  /**
   * Spawn (or re-seat) a fallen corpse proxy for a full-actor death that could
   * not afford a detailed ragdoll. Uses the agent id so wave tracking stays
   * consistent until the corpse timer expires.
   */
  addCorpseProxy(descriptor) {
    if (!descriptor) return null;
    return this.addProxy({
      ...descriptor,
      health: 0,
      maxHealth: descriptor.maxHealth ?? 1,
      healthScale: descriptor.healthScale ?? 1,
    });
  }

  update({ delta = 0, playerPosition, availableFullSlots = 0, promote } = {}) {
    if (!this.ready) return 0;
    if (playerPosition) this._playerPositionForLod = playerPosition;
    // Bank real time, capped so a frame hitch catches up by at most two fixed
    // ticks (bounds worst-case work per frame). Drain in FIXED
    // HORDE_PROXY_TICK_STEP increments so suppression diffusion + boids advance
    // deterministically regardless of framerate — a long frame runs two 1/12 s
    // steps, never one double-length step (which the diffusion/decay math and
    // separation are not tuned for).
    this._accumulator = Math.min(
      this._accumulator + Math.max(0, delta),
      HORDE_PROXY_TICK_STEP * 2,
    );
    if (this._accumulator < HORDE_PROXY_TICK_STEP) {
      if (this._dirty) this._flushDirtyMatrices();
      return 0;
    }

    let promoted = 0;
    while (this._accumulator >= HORDE_PROXY_TICK_STEP) {
      this._accumulator -= HORDE_PROXY_TICK_STEP;
      promoted += this._stepFixed(HORDE_PROXY_TICK_STEP, {
        playerPosition,
        // Never promote past the free-slot budget across catch-up sub-steps.
        availableFullSlots: Math.max(0, availableFullSlots) - promoted,
        promote,
      });
    }

    if (this._dirty) this._flushDirtyMatrices();
    return promoted;
  }

  /**
   * One fixed simulation sub-step of `step` seconds (== HORDE_PROXY_TICK_STEP).
   * Corpse cull + hit decay, suppression field update, flock steering, then
   * front-election promotion. Returns the number of agents promoted this
   * sub-step. Matrix/anim flushing is deferred to the caller.
   */
  _stepFixed(step, { playerPosition, availableFullSlots = 0, promote } = {}) {
    this._stats.ticks += 1;

    // Corpse cull + hit-timer decay. Steering (below) handles the live set.
    for (let i = this.agents.length - 1; i >= 0; i -= 1) {
      const agent = this.agents[i];
      if (agent.corpseTimer > 0) {
        agent.corpseTimer = Math.max(0, agent.corpseTimer - step);
        if (agent.corpseTimer <= 0) {
          this._removeAt(i);
          this._combatGridDirty = true;
          continue;
        }
      }
      if (agent.hitTimer > 0) {
        agent.hitTimer = Math.max(0, agent.hitTimer - step);
      }
    }
    // Steering moves agents — mark combat grid dirty once per tick when live.
    if (this.agents.length > 0) this._combatGridDirty = true;

    // Suppression decays + diffuses every fixed tick, even without a live mob,
    // so a lull always lets the wall fade (surge-back).
    this.suppressionField?.update(step);

    if (playerPosition && this.agents.length > 0) {
      this._updateFlowField(playerPosition, step);
      if (this.flowField) {
        stepFlockSteering({
          agents: this.agents,
          field: this.flowField,
          grid: this.flockGrid,
          playerPos: playerPosition,
          delta: step,
          suppression: this.suppressionField,
          weights: this.flockWeights,
        });
        // Conform to ground, migrate sectors, mark instance matrices dirty.
        for (const agent of this.agents) {
          if (agent.health <= 0 || agent.anim === 'fallen') continue;
          this._conformAgentToGround(agent);
          this._migrateAgentSector(agent);
          agent.matrixDirty = true;
          // Walk weight follows anim family; dirty so GPU mix stays correct.
          agent.animAttrDirty = true;
        }
        this._dirty = true;
      }
    }

    let promoted = 0;
    const promotionBudget = Math.min(
      Math.max(0, availableFullSlots),
      HORDE_PROXY_PROMOTIONS_PER_TICK,
    );
    for (let slot = 0; slot < promotionBudget; slot += 1) {
      const index = this._frontmostPromotableIndex(playerPosition);
      if (index < 0) break;
      const agent = this.agents[index];
      const accepted = promote?.({
        id: agent.id,
        archetype: agent.archetype,
        position: agent.position,
        yaw: agent.yaw,
        healthScale: agent.healthScale,
        health: agent.health,
        maxHealth: agent.maxHealth,
      });
      if (!accepted) break;
      this._removeAt(index);
      promoted += 1;
      this._stats.promoted += 1;
    }

    return promoted;
  }

  /**
   * Recompute the integration field toward the player, throttled to ~5 Hz and
   * only when the player has moved at least half a cell (keeps the O(cells)
   * Dijkstra off the steering cadence).
   */
  _updateFlowField(playerPosition, step) {
    if (!this.flowField) return;
    this._flowGoal.x = playerPosition.x;
    this._flowGoal.z = playerPosition.z;
    this._flowUpdateTimer -= step;
    const movedFar = Math.abs(playerPosition.x - this._flowLastGoalX) > FLOW_PLAYER_MOVE_EPS
      || Math.abs(playerPosition.z - this._flowLastGoalZ) > FLOW_PLAYER_MOVE_EPS;
    if (this._flowUpdateTimer > 0 && !movedFar) return;
    this.flowField.update(playerPosition.x, playerPosition.z);
    this._flowUpdateTimer = FLOW_UPDATE_INTERVAL;
    this._flowLastGoalX = playerPosition.x;
    this._flowLastGoalZ = playerPosition.z;
  }

  /** Sample analytic ground under the agent's XZ so it hugs pads/ballast. */
  _conformAgentToGround(agent) {
    if (!this._getGroundHeightAt) {
      agent.position.y = 0;
      return;
    }
    const groundY = this._getGroundHeightAt(agent.position, 0.35, {
      maxStepUp: 0.6,
      maxSnapDown: 1.2,
    });
    if (Number.isFinite(groundY)) agent.position.y = groundY;
  }

  /**
   * Flow distance-to-goal at a world position (M2 front-election sampler).
   * Returns Infinity when no field is built or the cell is unreachable.
   */
  sampleFlowDistance(x, z) {
    if (!this.flowField) return Infinity;
    const d = this.flowField.sampleDistance(x, z);
    return Number.isFinite(d) ? d : Infinity;
  }

  /**
   * Normalized flow direction at a world position (toward the player, around
   * walls). M3 knockback shoves a tip actor along the REVERSE of this. Returns
   * {x, z} = {0, 0} when unavailable so callers can fall back.
   */
  sampleFlowDir(x, z) {
    if (!this.flowField) return { x: 0, z: 0 };
    return this.flowField.sampleDir(x, z);
  }

  /**
   * Deposit combat suppression at a world impact point (M3). Amount ∝ damage.
   * Horde-gated by the caller (GameRuntime.depositSuppression).
   */
  depositSuppression(x, z, amount) {
    this.suppressionField?.deposit(x, z, amount);
  }

  /**
   * Frontmost promotable proxy = lowest flow distance-to-goal (the spear tip),
   * restricted to the promote band. `agent.distToGoal` is cached each steering
   * tick (M1). Falls back to euclidean nearest when the field is unavailable or
   * every candidate is unreachable (Infinity), so promotion never stalls.
   */
  _frontmostPromotableIndex(playerPosition) {
    if (!playerPosition || this.agents.length === 0) return -1;
    const maxDistanceSq = HORDE_PROXY_PROMOTION_RADIUS * HORDE_PROXY_PROMOTION_RADIUS;
    let bestIndex = -1;
    let bestFlow = Infinity;
    let euclideanIndex = -1;
    let euclideanBestSq = maxDistanceSq;
    for (let i = 0; i < this.agents.length; i += 1) {
      const agent = this.agents[i];
      if (agent.health <= 0 || agent.anim === 'fallen') continue;
      const position = agent.position;
      const dx = position.x - playerPosition.x;
      const dz = position.z - playerPosition.z;
      const distanceSq = dx * dx + dz * dz;
      // Promote band is euclidean (same gate as before) — the FRONT ordering
      // inside the band is by flow distance.
      if (distanceSq > maxDistanceSq) continue;
      if (distanceSq < euclideanBestSq) {
        euclideanBestSq = distanceSq;
        euclideanIndex = i;
      }
      const flow = Number.isFinite(agent.distToGoal) ? agent.distToGoal : Infinity;
      if (flow < bestFlow) {
        bestFlow = flow;
        bestIndex = i;
      }
    }
    // If no reachable (finite-flow) candidate was found, fall back to euclidean.
    return bestIndex >= 0 && Number.isFinite(bestFlow) ? bestIndex : euclideanIndex;
  }

  _removeAt(index) {
    const last = this.agents.length - 1;
    if (index < 0 || index > last) return false;
    const agent = this.agents[index];
    this._releaseSlot(agent);
    if (index !== last) this.agents[index] = this.agents[last];
    this.agents.pop();
    this._dirty = true;
    this._combatGridDirty = true;
    return true;
  }

  _writeAgentMatrix(agent) {
    const mesh = this._meshFor(agent);
    if (!mesh || agent.slot == null) return;
    const pitch = agent.anim === 'fallen' ? -Math.PI * 0.5 : 0;
    const y = agent.position.y + (agent.anim === 'fallen' ? 0.2 : 0);
    this._matrixObject.position.set(agent.position.x, y, agent.position.z);
    this._matrixObject.rotation.set(pitch, agent.yaw, 0);
    this._matrixObject.scale.set(1, 1, 1);
    this._matrixObject.updateMatrix();
    mesh.setMatrixAt(agent.slot, this._matrixObject.matrix);
    agent.matrixDirty = false;
    this._dirtySectors.add(agent.sectorIndex);
  }

  /**
   * GPU pose weights for an agent: `{ walk, attack }`, both 0..1 and mutually
   * exclusive (an agent advances OR strikes). Attacking agents play the strike
   * delta instead of freezing mid-stride; advancing agents cycle the walk delta.
   */
  _animWeightsFor(agent) {
    if (!this.gpuWalk || !agent || agent.health <= 0
        || agent.anim === 'fallen' || agent.anim === 'hit') {
      return ZERO_ANIM_WEIGHTS;
    }
    // Reached the player — full strike cycle, no walk blend.
    if (agent.anim === 'attack') return ATTACK_ANIM_WEIGHTS;
    // Advancing/idle → walk blend. Idle is a subtle sway.
    let walk = agent.anim === 'idle' ? 0.08 : 0.85;
    // M6: far-body agents drop walk blend so the tip stays legible and GPU work
    // concentrates on the combat front. farWalkWeight is the floor at distance
    // ≥ 2× farWalkDistance (0 = fully static far body).
    const player = this._playerPositionForLod;
    if (player && this.farWalkDistance > 0) {
      const dx = agent.position.x - player.x;
      const dz = agent.position.z - player.z;
      const dist = Math.hypot(dx, dz);
      if (dist > this.farWalkDistance) {
        const t = Math.min(1, (dist - this.farWalkDistance) / Math.max(1, this.farWalkDistance));
        // t=0 at threshold → full weight; t=1 at 2× distance → farWalkWeight floor.
        const farScale = 1 - t * (1 - this.farWalkWeight);
        walk *= farScale;
      }
    }
    return { walk, attack: 0 };
  }

  _writeAnimAttr(agent) {
    const mesh = this._meshFor(agent);
    if (!mesh || agent.slot == null) return;
    const { walk, attack } = this._animWeightsFor(agent);
    this._setAnimAttr(mesh, agent.slot, agent.phaseOffset ?? 0, walk, attack);
    agent.animAttrDirty = false;
  }

  _setAnimAttr(mesh, slot, phaseOffset, walkWeight, attackWeight = 0) {
    const attr = mesh.userData.instanceAnim;
    if (!attr) return;
    attr.setXYZW(slot, phaseOffset, walkWeight, attackWeight, 0);
    attr.needsUpdate = true;
  }

  _flushDirtyMatrices() {
    if (!this._dirty && this._dirtySectors.size === 0) return;
    for (const agent of this.agents) {
      if (agent.matrixDirty) this._writeAgentMatrix(agent);
      if (agent.animAttrDirty) this._writeAnimAttr(agent);
    }
    // Mark only touched sector meshes for GPU upload.
    const touched = this._dirtySectors.size
      ? this._dirtySectors
      : null;
    for (const mesh of this.meshes.values()) {
      const sectorIndex = mesh.userData.hordeSectorIndex;
      if (touched && !touched.has(sectorIndex)) continue;
      this._syncSectorMeshCount(mesh);
      if (mesh.count <= 0) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.userData.instanceAnim) mesh.userData.instanceAnim.needsUpdate = true;
      this._stats.matrixUploads += 1;
    }
    this._dirtySectors.clear();
    this._dirty = false;
  }

  clear() {
    for (const agent of this.agents) {
      const mesh = this._meshFor(agent);
      if (mesh && agent.slot != null) {
        mesh.setMatrixAt(agent.slot, collapsedInstanceMatrix);
        this._setAnimAttr(mesh, agent.slot, 0, 0);
      }
    }
    this.agents.length = 0;
    this._hitTargets.length = 0;
    this._nearHitTargets.length = 0;
    this._accumulator = 0;
    this._dirty = false;
    this._dirtySectors.clear();
    this._combatGridDirty = true;
    this._flowUpdateTimer = 0;
    this._flowLastGoalX = Infinity;
    this._flowLastGoalZ = Infinity;
    this.suppressionField?.clear();
    for (const archetype of ARCHETYPES) {
      const counts = this._sectorCounts.get(archetype);
      if (counts) {
        for (const sector of this.sectors) counts.set(sector.index, 0);
      }
    }
    for (const mesh of this.meshes.values()) {
      initializeProxyInstanceStream(mesh, this.sectorCapacity);
      mesh.count = 0;
      mesh.visible = false;
    }
  }

  markPipelinesDirty() {
    for (const mesh of this.meshes.values()) {
      initializeProxyInstanceStream(mesh, this.sectorCapacity);
      mesh.count = 0;
      mesh.visible = false;
    }
    // Re-seat every agent into dense per-sector slots after pipeline rebuild.
    for (const archetype of ARCHETYPES) {
      const counts = this._sectorCounts.get(archetype);
      if (counts) {
        for (const sector of this.sectors) counts.set(sector.index, 0);
      }
    }
    for (const agent of this.agents) {
      agent.sectorIndex = null;
      agent.slot = null;
    }
    for (const agent of this.agents) {
      const bounds = this._levelBounds ?? defaultArenaBounds();
      const preferred = sectorIndexAt(agent.position.x, agent.position.z, bounds, this.sectorGrid);
      const alloc = this._allocSlot(agent.archetype, preferred);
      if (!alloc) continue;
      agent.sectorIndex = alloc.sectorIndex;
      agent.slot = alloc.slot;
      agent.matrixDirty = true;
      agent.animAttrDirty = true;
    }
    this._dirty = true;
    this._flushDirtyMatrices();
  }

  snapshot() {
    const archetypeTotals = Object.fromEntries(
      ARCHETYPES.map((key) => {
        let total = 0;
        const counts = this._sectorCounts.get(key);
        if (counts) {
          for (const n of counts.values()) total += n;
        }
        return [key, total];
      }),
    );
    const occupiedSectors = new Set();
    for (const agent of this.agents) {
      if (agent.sectorIndex != null) occupiedSectors.add(agent.sectorIndex);
    }
    return {
      status: this.status,
      count: this.agents.length,
      capacity: this.capacity,
      sectorGrid: this.sectorGrid,
      sectorCount: this.sectors.length,
      sectorCapacity: this.sectorCapacity,
      occupiedSectors: occupiedSectors.size,
      gpuWalk: this.gpuWalk,
      geometrySource: this.geometrySource,
      poseCatalogSize: this.gpuWalk ? 2 : 1,
      displayPose: DISPLAY_POSE.key,
      stableSlots: true,
      packedSlots: true,
      sectorCulled: true,
      farWalkDistance: this.farWalkDistance,
      farWalkWeight: this.farWalkWeight,
      flock: {
        separationDistance: this.flockWeights.separationDistance,
        attackRadius: this.flockWeights.attackRadius,
        congestionFull: this.flockWeights.congestionFull,
        separate: this.flockWeights.separate,
      },
      drawCalls: [...this.meshes.values()].filter((mesh) => mesh.count > 0).length,
      meshes: archetypeTotals,
      poseBuckets: Object.fromEntries(
        ARCHETYPES.map((key) => [`${key}:${DISPLAY_POSE.key}`, archetypeTotals[key] ?? 0]),
      ),
      verticesPerArchetype: Object.fromEntries(
        ARCHETYPES.map((archetype) => {
          const geometry = this._sharedGeometry.get(archetype);
          return [archetype, geometry?.getAttribute('position')?.count ?? 0];
        }),
      ),
      ticks: this._stats.ticks,
      promoted: this._stats.promoted,
      demoted: this._stats.demoted,
      emergencyPromoted: this._stats.emergencyPromoted,
      lightweightHits: this._stats.lightweightHits,
      lightweightKills: this._stats.lightweightKills,
      areaHits: this._stats.areaHits,
      areaKills: this._stats.areaKills,
      living: this.countLiving(),
      corpses: this.countCorpses(),
      promotionRadius: HORDE_PROXY_PROMOTION_RADIUS,
      demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
      matrixUploads: this._stats.matrixUploads,
      sectorMigrations: this._stats.sectorMigrations,
      peakCount: this._stats.peakCount,
      combatGrid: this.combatGrid.snapshot(),
      flowField: this.flowField ? this.flowField.snapshot() : null,
      suppression: this.suppressionField ? this.suppressionField.snapshot() : null,
      sample: this.agents.slice(0, PROXY_SNAPSHOT_LIMIT).map((agent) => ({
        id: agent.id,
        archetype: agent.archetype,
        sector: agent.sectorIndex,
        slot: agent.slot,
        anim: agent.anim,
        distToGoal: Number.isFinite(agent.distToGoal) ? Number(agent.distToGoal.toFixed(2)) : null,
        position: vectorSnapshot(agent.position),
      })),
      truncated: Math.max(0, this.agents.length - PROXY_SNAPSHOT_LIMIT),
      error: this.error ? String(this.error.message ?? this.error) : null,
    };
  }

  dispose() {
    this.clear();
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.dispose?.();
    }
    this.meshes.clear();
    const disposedGeometries = new Set();
    const disposedMaterials = new Set();
    for (const geometry of this._sharedGeometry.values()) {
      if (geometry && !disposedGeometries.has(geometry)) {
        geometry.dispose?.();
        disposedGeometries.add(geometry);
      }
    }
    this._sharedGeometry.clear();
    for (const material of this._sharedMaterial.values()) {
      if (material && !disposedMaterials.has(material)) {
        material.dispose?.();
        disposedMaterials.add(material);
      }
    }
    this._sharedMaterial.clear();
    this._baked.length = 0;
    this.group.removeFromParent();
    this.status = 'disposed';
  }
}

async function loadProxyBakeSource({ loader, config, fullAsset, archetype }) {
  const proxyUrl = config.proxyUrl ?? null;
  if (proxyUrl) {
    try {
      const gltf = await loader.loadAsync(proxyUrl);
      if (!gltf.scene) throw new Error('empty scene');
      return { kind: 'proxy', scene: gltf.scene, clips: gltf.animations ?? [], url: proxyUrl };
    } catch (error) {
      console.warn(
        `[HordeProxySystem] ${archetype}: failed to load proxyUrl ${proxyUrl}; `
        + `falling back to full mesh. ${error?.message ?? error}`,
      );
    }
  }
  if (fullAsset?.scene) {
    return {
      kind: 'full',
      scene: fullAsset.scene,
      clips: fullAsset.clips ?? [],
      url: config.url ?? null,
    };
  }
  throw new Error(`missing bake source for ${archetype}`);
}

function bakeProxyGeometryWithVat({ sceneRoot, clips, config, archetype, gpuWalk = true }) {
  if (gpuWalk) {
    const vat = bakeHordeProxyVatGeometry({
      sceneRoot,
      clips,
      targetHeight: config.targetHeight,
      orientationFixX: config.orientationFixX ?? 0,
      vertexLimit: HORDE_PROXY_VERTEX_LIMIT,
    });
    if (vat?.geometry) {
      return {
        geometry: vat.geometry,
        material: createProxyVatMaterial(sceneRoot, archetype),
        poses: vat.poses,
        vat: true,
      };
    }
  }

  // Fallback: single static mid-stride pose (pre-M5 path).
  const catalog = prepareBakedCrowdPoseCatalog(sceneRoot, clips, {
    entries: [DISPLAY_POSE],
    targetHeight: config.targetHeight,
    orientationFixX: config.orientationFixX ?? 0,
  });
  const pose = catalog[0];
  const verts = pose?.geometry?.getAttribute('position')?.count ?? 0;
  if (!pose?.geometry || verts <= 0 || verts > HORDE_PROXY_VERTEX_LIMIT) {
    for (const entry of catalog) entry.geometry?.dispose?.();
    return null;
  }
  return {
    geometry: pose.geometry,
    material: createProxyMaterial(sceneRoot, archetype),
    pose,
    poses: [pose],
    vat: false,
  };
}

function defaultArenaBounds() {
  const h = HORDE_DEFAULT_ARENA_HALF;
  return { minX: -h, maxX: h, minZ: -h, maxZ: h };
}

function mergeGeometrySource(current, next) {
  if (!next) return current;
  if (current === 'none' || !current) return next;
  if (current === next) return current;
  return 'mixed';
}

function disposeObjectTree(root) {
  root.traverse?.((child) => {
    child.geometry?.dispose?.();
  });
}

function deriveBoundsFromColliders(colliders, pad = 0) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of colliders) {
    if (!c || c.disabled) continue;
    if (Number.isFinite(c.minX)) minX = Math.min(minX, c.minX);
    if (Number.isFinite(c.maxX)) maxX = Math.max(maxX, c.maxX);
    if (Number.isFinite(c.minZ)) minZ = Math.min(minZ, c.minZ);
    if (Number.isFinite(c.maxZ)) maxZ = Math.max(maxZ, c.maxZ);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)
    || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    return null;
  }
  return {
    minX: minX - pad,
    maxX: maxX + pad,
    minZ: minZ - pad,
    maxZ: maxZ + pad,
  };
}

function createProxyMaterial(root, archetype) {
  let source = null;
  root.traverse((child) => {
    if (source || (!child.isMesh && !child.isSkinnedMesh) || !child.material) return;
    source = Array.isArray(child.material) ? child.material.find(Boolean) : child.material;
  });
  const material = source?.clone?.() ?? new THREE.MeshStandardMaterial({
    color: archetype === 'cyclop' ? 0x9a3a32 : archetype === 'tessy' ? 0x547598 : 0x777c86,
    roughness: 0.72,
    metalness: 0.08,
  });
  material.skinning = false;
  material.side = THREE.DoubleSide;
  material.depthWrite = true;
  material.depthTest = true;
  if ('roughness' in material) material.roughness = Math.max(material.roughness ?? 0.6, 0.62);
  if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
  material.needsUpdate = true;
  return material;
}

/**
 * MeshStandardNodeMaterial with GPU walk + attack blend:
 *   position = base
 *            + pose1Delta * walkBlend      // stride cycle while advancing
 *            + pose2Delta * attackBlend    // strike cycle while meleeing
 * where each blend = clamp(weight,0,1) * triangleWave(time·cps + phase). pose1
 * (walk) and pose2 (attack) are baked DELTA attributes (frame - base) so
 * residual root translation cannot fling instances. Walk and attack weights are
 * mutually exclusive per instance (an agent advances OR strikes), so the two
 * terms never fight. Instance attr `instanceAnim`: xyzw = (phase, walkWeight,
 * attackWeight, reserved).
 */
function createProxyVatMaterial(root, archetype) {
  const baseColor = archetype === 'cyclop' ? 0x9a3a32 : archetype === 'tessy' ? 0x547598 : 0x777c86;
  let map = null;
  let color = new THREE.Color(baseColor);
  root.traverse((child) => {
    if ((!child.isMesh && !child.isSkinnedMesh) || !child.material) return;
    const src = Array.isArray(child.material) ? child.material.find(Boolean) : child.material;
    if (!src) return;
    if (src.map && !map) map = src.map;
    if (src.color && color) color = src.color.clone?.() ?? color;
  });

  const material = new MeshStandardNodeMaterial();
  material.color = color;
  material.map = map;
  material.roughness = 0.68;
  material.metalness = 0.08;
  material.side = THREE.DoubleSide;
  material.depthWrite = true;
  material.depthTest = true;
  if (map) map.colorSpace = THREE.SRGBColorSpace;

  // instanceAnim = (phase, walkWeight, attackWeight, reserved), all 0..1.
  const instAnim = attribute('instanceAnim', 'vec4');
  const phaseOffset = instAnim.x;
  const walkWeight = clamp(instAnim.y, float(0), float(1));
  const attackWeight = clamp(instAnim.z, float(0), float(1));
  const pose1Delta = attribute('pose1', 'vec3');
  const pose2Delta = attribute('pose2', 'vec3');
  // Walk term: triangle wave 0→1→0 = 1 - abs(2*fract(t) - 1).
  const walkCycle = fract(add(mul(time, _gpuWalkCps), phaseOffset));
  const walkFold = add(float(1), mul(abs(add(mul(walkCycle, float(2)), float(-1))), float(-1)));
  const walkBlend = clamp(mul(walkWeight, walkFold), float(0), float(1));
  // Attack term: same shape, faster cadence, on the strike delta.
  const attackCycle = fract(add(mul(time, _gpuAttackCps), phaseOffset));
  const attackFold = add(float(1), mul(abs(add(mul(attackCycle, float(2)), float(-1))), float(-1)));
  const attackBlend = clamp(mul(attackWeight, attackFold), float(0), float(1));
  material.positionNode = add(
    positionLocal,
    add(mul(pose1Delta, walkBlend), mul(pose2Delta, attackBlend)),
  );
  material.needsUpdate = true;
  return material;
}

function hash01(value) {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 0x100000000;
}

function vectorSnapshot(vector) {
  return {
    x: Number(vector.x.toFixed(2)),
    y: Number(vector.y.toFixed(2)),
    z: Number(vector.z.toFixed(2)),
  };
}

function initializeProxyInstanceStream(mesh, capacity) {
  for (let index = 0; index < capacity; index += 1) {
    mesh.setMatrixAt(index, collapsedInstanceMatrix);
  }
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  // Per-instance (phase, walkWeight, attackWeight, reserved) for the GPU VAT
  // blend. meshPerAttribute = 1 is required so WebGPU advances one sample per
  // instance (not per vertex). Missing this made some instances read garbage
  // weights and "hyperspeed" as pose deltas got multiplied by huge blends.
  const animArray = new Float32Array(capacity * 4);
  const animAttr = new THREE.InstancedBufferAttribute(animArray, 4, false, 1);
  animAttr.setUsage(THREE.DynamicDrawUsage);
  mesh.geometry.setAttribute('instanceAnim', animAttr);
  mesh.userData.instanceAnim = animAttr;
  mesh.count = capacity;
  mesh.visible = true;
  mesh.userData.hordeProxyCapacity = capacity;
  // WebGPU captures mesh.count into the instance binding when a render pipeline
  // is built. These sector meshes draw only their LIVE count (0 when empty, for
  // FPS), so a pipeline built at a small count makes later instances flicker
  // out as the sector fills — the "flashing distance proxies" that only clear
  // when a global recompile (e.g. toggling shadows) rebuilds the pipeline at a
  // full count. Prime once at capacity on the first render so the binding is
  // sized for the whole sector, then restore the real draw count. Mirrors
  // spectatorCrowd.initializeCrowdInstanceStream.
  mesh.userData.hordePipelinePrimed = false;
  mesh.onBeforeRender = function primeHordeInstancePipeline() {
    if (this.userData.hordePipelinePrimed) return;
    const drawCount = this.count;
    this.count = this.userData.hordeProxyCapacity ?? this.count;
    this.userData.hordePipelinePrimed = true;
    queueMicrotask(() => { this.count = drawCount; });
  };
}
