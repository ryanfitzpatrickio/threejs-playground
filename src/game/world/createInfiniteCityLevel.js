import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { color, floor, fract, mix, positionWorld, sin, step } from 'three/tsl';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { ColliderSpatialIndex } from './ColliderSpatialIndex.js';
import { createCityFurnitureBatcher } from './CityFurnitureBatcher.js';
import {
  CITY_SEED,
  createCityMaterialWarmupGroup,
  createGeneratorCityChunkFromPayload,
  createGeneratorCityLevel,
  getCityStride,
} from './createGeneratorCityLevel.js';

let LOAD_RADIUS = 2;
let INITIAL_LOAD_RADIUS = 2;
let UNLOAD_RADIUS = 3;
// Full chunk attachments per updateStreaming — keep at 1 to avoid per-frame geometry spike.
const MAX_CHUNK_ATTACHMENTS_PER_UPDATE = 1;
// Skeleton registrations per updateStreaming — each creates Rapier bodies + colliders,
// so a high value reintroduces the burst the onmessage deferral was meant to prevent.
const MAX_SKELETON_ATTACHMENTS_PER_UPDATE = 3;
// New chunk requests issued per updateStreaming — post all at once so workers start immediately.
const MAX_REQUESTS_PER_UPDATE = 25;
const MAX_MESH_REVEALS_PER_UPDATE = 4;
const MAX_MESH_REVEALS_POST_LOAD = 20;
let WORKER_COUNT = 4;
// Far silhouettes only need a few broad masses per chunk. Keeping this small is
// important because the complete skyline is one instanced vertex buffer.
const SKYLINE_BUILDINGS_PER_CHUNK = 4;
const SKYLINE_REBUILD_INTERVAL_MS = 750;

// Reused steady-state result: updateStreaming returns this frozen object every
// frame nothing streamed, so the hot path allocates zero arrays/objects.
const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_STREAMING_RESULT = Object.freeze({
  addedChunks: EMPTY_ARRAY,
  removedChunks: EMPTY_ARRAY,
  addedColliders: EMPTY_ARRAY,
  removedChunkKeys: EMPTY_ARRAY,
});

// Shared low-fi materials for skeleton placeholder meshes.
let skeletonBuildingMaterial = null;
let skeletonRoadMaterial = null;
let skeletonBuildingGeometry = null;
let skeletonRoadGeometry = null;
const skeletonInstanceMatrix = new THREE.Matrix4();

function getSkeletonBuildingMaterial() {
  if (!skeletonBuildingMaterial) {
    const wx = positionWorld.x;
    const wy = positionWorld.y;
    const wz = positionWorld.z;

    // Window grid (~1.4 m wide, ~1.8 m tall)
    const cellX = fract(wx.mul(0.7));
    const cellY = fract(wy.mul(0.55));
    const border = 0.18;
    const windowMask = step(border, cellX)
      .mul(step(border, cellY))
      .mul(step(cellX, 1.0 - border))
      .mul(step(cellY, 1.0 - border));

    // Per-window lit/unlit hash using floor-cell id + z slab
    const idX = floor(wx.mul(0.7));
    const idY = floor(wy.mul(0.55));
    const idZ = floor(wz.mul(0.5));
    const h = fract(sin(idX.mul(127.1).add(idY.mul(311.7)).add(idZ.mul(74.7))).mul(43758.5453));
    const lit = step(0.35, h);

    const masonry   = color(0x1c1b19);
    const windowOff = color(0x0f1217);
    const windowOn  = color(0x604a23);
    const col = mix(masonry, mix(windowOff, windowOn, lit), windowMask);

    skeletonBuildingMaterial = new MeshBasicNodeMaterial();
    skeletonBuildingMaterial.colorNode = col;
  }
  return skeletonBuildingMaterial;
}

function getSkeletonRoadMaterial() {
  if (!skeletonRoadMaterial) {
    skeletonRoadMaterial = new MeshBasicNodeMaterial();
    skeletonRoadMaterial.colorNode = color(0x111111);
  }
  return skeletonRoadMaterial;
}

function getSkeletonBuildingGeometry() {
  if (!skeletonBuildingGeometry) {
    skeletonBuildingGeometry = new THREE.BoxGeometry(1, 1, 1);
    skeletonBuildingGeometry.userData.sharedSkeletonGeometry = true;
  }
  return skeletonBuildingGeometry;
}

function getSkeletonRoadGeometry() {
  if (!skeletonRoadGeometry) {
    skeletonRoadGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    skeletonRoadGeometry.userData.sharedSkeletonGeometry = true;
  }
  return skeletonRoadGeometry;
}

export function createInfiniteCityLevel(qualityPreset = {}, { chunkFilter = null, chunkResolver = null } = {}) {
  LOAD_RADIUS = qualityPreset.loadRadius ?? 2;
  INITIAL_LOAD_RADIUS = Math.min(LOAD_RADIUS, qualityPreset.initialLoadRadius ?? LOAD_RADIUS);
  UNLOAD_RADIUS = qualityPreset.unloadRadius ?? 3;
  WORKER_COUNT = qualityPreset.workerCount ?? 4;
  const cityFurniture = qualityPreset.cityFurniture ?? {};
  const cityCastShadows = qualityPreset.cityCastShadows !== false;
  const furnitureRadius = Math.max(0, qualityPreset.cityFurnitureRadius ?? 1);
  const traversalRadius = Math.max(0, qualityPreset.cityTraversalRadius ?? 1);
  const skylineRadius = Math.max(UNLOAD_RADIUS + 1, qualityPreset.citySkylineRadius ?? UNLOAD_RADIUS + 3);
  // Optional spatial gate: only stream chunks the predicate allows (used by the
  // composed world level to confine the city to `city` zones). Null = infinite city.
  const resolveChunk = typeof chunkResolver === 'function'
    ? chunkResolver
    : (cx, cz) => (typeof chunkFilter !== 'function' || chunkFilter(cx, cz) ? { style: 'downtown', zoneSeed: CITY_SEED } : null);
  const allowChunk = (cx, cz) => Boolean(resolveChunk(cx, cz));

  const group = new THREE.Group();
  group.name = 'Infinite Generator City';

  const furnitureBatcher = createCityFurnitureBatcher(group);

  const chunks = new Map();
  const pendingChunks = new Map();
  const completedChunks = [];
  // Spatial index owns the flat `colliders` array (source of truth for legacy
  // readers) and a cell grid maintained incrementally on chunk add/remove, so
  // hook raycasts / ground-height / blocking queries skip the O(all) scan.
  const colliderIndex = new ColliderSpatialIndex();
  const colliders = colliderIndex.colliders;
  const ledges = [];
  const climbSurfaces = [];
  const wallRunSurfaces = [];
  const ropes = [];
  const traversalByChunk = {
    ledges: new Map(),
    climbSurfaces: new Map(),
    wallRunSurfaces: new Map(),
    ropes: new Map(),
  };
  // Skeleton placeholder groups keyed by chunkKey — removed when full chunk attaches.
  const skeletonGroups = new Map();
  // Worker skeleton messages queued here; drained N-per-frame in updateStreaming
  // so geometry + collider creation is spread across frames rather than spiking.
  const pendingSkeletons = [];
  // Chunk keys whose skeleton Rapier bodies must be torn down before the full
  // chunk's colliders are registered. Populated by attachCompletedChunks, consumed
  // by the updateStreaming return value.
  const skeletonSwapKeys = [];
  const pendingMeshReveals = [];
  const pendingTraversal = new Map();

  // Get stride from a cheap CityGenerator constructor call — no geometry build needed.
  // This avoids the large main-thread spike of building the center chunk synchronously.
  const stride = getCityStride();
  const chunkStrideX = stride.x;
  const chunkStrideZ = stride.z;

  // One visual-only far-field draw. Real chunks and their loading skeletons own
  // the inner ring; these coarse boxes provide the distant city silhouette.
  const skyline = createSkylineMesh({
    radius: skylineRadius,
    chunkStrideX,
    chunkStrideZ,
  });
  group.add(skyline.mesh);
  let skylineCenterX = Infinity;
  let skylineCenterZ = Infinity;
  let skylineDirty = true;
  let lastSkylineRebuildAt = -Infinity;

  let geometryIndex = createLevelGeometryIndex(group);
  let workers = [];
  let nextWorkerIndex = 0;
  let nextRequestId = 1;
  // Even when initial and steady radii match (medium), the bootstrap phase is
  // distinct: workers build geometry/colliders first and backfill traversal
  // only after the inner area is attached.
  let initialLoadComplete = false;
  let lastVisibilityChunkKey = null;
  let lastAttachMs = 0;
  let worstAttachMs = 0;
  let totalAttachMs = 0;
  let attachCount = 0;

  // Scratch storage reused across updateStreaming frames to keep the steady-state
  // path allocation-free. streamingResult aliases these arrays; it is returned
  // only when at least one is non-empty, otherwise EMPTY_STREAMING_RESULT is.
  const currentChunk = { x: 0, z: 0 };
  const addedChunksScratch = [];
  const addedCollidersScratch = [];
  const removedChunkKeysScratch = [];
  const toRequestScratch = [];
  const unloadScratch = [];
  const justAddedSet = new Set();
  const streamingResult = {
    addedChunks: addedChunksScratch,
    removedChunks: EMPTY_ARRAY,
    addedColliders: addedCollidersScratch,
    removedChunkKeys: removedChunkKeysScratch,
  };

  return {
    name: 'Infinite Generator City',
    group,
    colliders,
    colliderIndex,
    ledges,
    climbSurfaces,
    wallRunSurfaces,
    ropes,
    geometryIndex,
    terrainChunks: null,
    // Center chunk spawns at world origin.
    spawnPoint: new THREE.Vector3(0, 0, 0),
    cityChunks: chunks,
    cityChunkStride: { x: chunkStrideX, z: chunkStrideZ },
    createPipelineWarmupGroup: () => {
      const warmup = createCityMaterialWarmupGroup();
      const geometry = new THREE.BoxGeometry(0.01, 0.01, 0.01);
      const materials = [getSkeletonBuildingMaterial(), getSkeletonRoadMaterial(), skyline.mesh.material];
      for (let index = 0; index < materials.length; index += 1) {
        const mesh = new THREE.Mesh(geometry, materials[index]);
        const instanced = new THREE.InstancedMesh(geometry, materials[index], 1);
        mesh.frustumCulled = instanced.frustumCulled = false;
        mesh.castShadow = instanced.castShadow = true;
        mesh.receiveShadow = instanced.receiveShadow = true;
        mesh.position.set(0, -10100 - index, 0);
        instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, -10100 - index, 0));
        warmup.add(mesh, instanced);
      }
      const disposeMaterialsWarmup = warmup.userData.disposeWarmup;
      warmup.userData.disposeWarmup = () => {
        disposeMaterialsWarmup?.();
        geometry.dispose();
      };
      return warmup;
    },

    updateStreaming: (position, { debugVisible = false } = {}) => {
      const current = worldToChunk(position, currentChunk);

      // Reset reused scratch storage (no per-frame array/object allocations).
      addedChunksScratch.length = 0;
      addedCollidersScratch.length = 0;
      removedChunkKeysScratch.length = 0;
      justAddedSet.clear();

      const revealBudget = initialLoadComplete
        ? Math.min(MAX_MESH_REVEALS_POST_LOAD, Math.max(MAX_MESH_REVEALS_PER_UPDATE, Math.ceil(pendingMeshReveals.length / 15)))
        : MAX_MESH_REVEALS_PER_UPDATE;
      revealChunkMeshes(current, revealBudget);

      // Drain full-chunk attach queue (1 per frame to avoid geometry spike).
      attachCompletedChunks({ addedChunks: addedChunksScratch, debugVisible, current, maxCount: MAX_CHUNK_ATTACHMENTS_PER_UPDATE });

      // Drain skeleton queue — process all that arrived this frame. Skeleton
      // colliders go straight into addedCollidersScratch (forwarded to Rapier).
      drainPendingSkeletons(current, addedCollidersScratch);

      // Medium/ultra start with a smaller inner square. Do not issue requests
      // for the steady-state driving radius until every allowed inner chunk is
      // attached; this keeps startup CPU, worker, and transfer pressure bounded.
      if (!initialLoadComplete && isRadiusAttached(current, INITIAL_LOAD_RADIUS)) {
        initialLoadComplete = true;
        backfillFurnitureAdoption();
      }
      const activeLoadRadius = initialLoadComplete ? LOAD_RADIUS : INITIAL_LOAD_RADIUS;

      // Collect new chunks needed this update, sorted closest-first so workers
      // prioritise near geometry — prevents far corners finishing before the
      // center chunk even gets a skeleton. Reused array; only allocates entries
      // when a chunk is actually missing.
      toRequestScratch.length = 0;
      for (let x = current.x - activeLoadRadius; x <= current.x + activeLoadRadius; x += 1) {
        for (let z = current.z - activeLoadRadius; z <= current.z + activeLoadRadius; z += 1) {
          const key = chunkKey(x, z);
          if (chunks.has(key) || pendingChunks.has(key)) continue;
          if (!allowChunk(x, z)) continue;
          const dx = x - current.x;
          const dz = z - current.z;
          toRequestScratch.push({ x, z, dist2: dx * dx + dz * dz });
        }
      }
      toRequestScratch.sort((a, b) => a.dist2 - b.dist2);
      for (let i = 0; i < Math.min(toRequestScratch.length, MAX_REQUESTS_PER_UPDATE); i += 1) {
        const candidate = toRequestScratch[i];
        const extractTraversal = initialLoadComplete
          && Math.max(Math.abs(candidate.x - current.x), Math.abs(candidate.z - current.z)) <= traversalRadius;
        requestChunk(candidate.x, candidate.z, extractTraversal);
      }

      for (const chunk of addedChunksScratch) justAddedSet.add(chunk.chunkKey);
      scheduleTraversalBackfill(current, justAddedSet);

      const visibilityKey = chunkKey(current.x, current.z);
      if (visibilityKey !== lastVisibilityChunkKey) {
        lastVisibilityChunkKey = visibilityKey;
        updateFurnitureVisibility(current);
      }

      // Unload full chunks outside UNLOAD_RADIUS. Collect first into a reused
      // array, then remove — removeChunk mutates the `chunks` Map, so iterating
      // it directly while deleting would skip entries.
      unloadScratch.length = 0;
      for (const chunk of chunks.values()) {
        if (
          Math.abs(chunk.chunkX - current.x) <= UNLOAD_RADIUS &&
          Math.abs(chunk.chunkZ - current.z) <= UNLOAD_RADIUS
        ) {
          continue;
        }
        unloadScratch.push(chunk);
      }
      for (let i = 0; i < unloadScratch.length; i += 1) {
        const chunk = unloadScratch[i];
        removedChunkKeysScratch.push(chunk.chunkKey);
        removeChunk(chunk);
      }

      // Evict skeleton placeholders the player has moved away from before their
      // full geometry finished loading.
      for (const [key] of skeletonGroups) {
        const [cx, cz] = key.split(':').map(Number);
        if (Math.abs(cx - current.x) > UNLOAD_RADIUS || Math.abs(cz - current.z) > UNLOAD_RADIUS) {
          cleanupSkeleton(key);
        }
      }

      // Keep each coarse proxy until that exact chunk has visible replacement
      // geometry. Rebuild only after a chunk-boundary move or a handoff.
      const skylineCenterChanged = current.x !== skylineCenterX || current.z !== skylineCenterZ;
      const skylineNow = performance.now();
      if (skylineCenterChanged || (skylineDirty && skylineNow - lastSkylineRebuildAt >= SKYLINE_REBUILD_INTERVAL_MS)) {
        skylineCenterX = current.x;
        skylineCenterZ = current.z;
        skyline.update(current.x, current.z, (cx, cz) => {
          const key = chunkKey(cx, cz);
          return !chunks.has(key) && !skeletonGroups.has(key) ? resolveChunk(cx, cz) : null;
        });
        skylineDirty = false;
        lastSkylineRebuildAt = skylineNow;
      }

      // Forward added chunks' colliders into the result. (Skeleton colliders
      // were drained into addedCollidersScratch above; order matches the old
      // [...skeletonColliders, ...chunk colliders] layout — skeletons first.)
      for (const chunk of addedChunksScratch) {
        const chunkColliders = chunk.colliders;
        if (chunkColliders) {
          for (let i = 0; i < chunkColliders.length; i += 1) addedCollidersScratch.push(chunkColliders[i]);
        }
      }
      // skeleton→full swaps: skeleton Rapier bodies must be torn down first
      // (removedChunkKeys), then the real trimesh colliders go in (addedColliders).
      for (let i = 0; i < skeletonSwapKeys.length; i += 1) removedChunkKeysScratch.push(skeletonSwapKeys[i]);
      skeletonSwapKeys.length = 0;

      // Steady state: nothing streamed this frame → return the frozen empty
      // result so the hot path allocates nothing.
      if (
        addedChunksScratch.length === 0 &&
        addedCollidersScratch.length === 0 &&
        removedChunkKeysScratch.length === 0
      ) {
        return EMPTY_STREAMING_RESULT;
      }

      return streamingResult;
    },

    snapshot: () => ({
      chunks: chunks.size,
      pendingChunks: pendingChunks.size,
      completedChunks: completedChunks.length,
      pendingSkeletons: pendingSkeletons.length,
      pendingTraversal: pendingTraversal.size,
      pendingMeshReveals: pendingMeshReveals.length,
      initialLoadComplete,
      activeLoadRadius: initialLoadComplete ? LOAD_RADIUS : INITIAL_LOAD_RADIUS,
      lastAttachMs: Number(lastAttachMs.toFixed(2)),
      worstAttachMs: Number(worstAttachMs.toFixed(2)),
      meanAttachMs: attachCount ? Number((totalAttachMs / attachCount).toFixed(2)) : 0,
      skylineInstances: skyline.mesh.count,
      furniture: furnitureBatcher.snapshot(),
      strideX: Number(chunkStrideX.toFixed(3)),
      strideZ: Number(chunkStrideZ.toFixed(3)),
      keys: [...chunks.keys()].sort(),
    }),

    dispose: () => {
      for (const cityWorker of workers) {
        cityWorker.terminate();
      }
      workers = [];
      geometryIndex?.dispose();
      furnitureBatcher.dispose();
      for (const chunk of chunks.values()) {
        chunk.dispose?.();
      }
      chunks.clear();
      for (const key of [...skeletonGroups.keys()]) {
        cleanupSkeleton(key);
      }
      disposeObject3D(group);
    },
  };

  function requestChunk(chunkX, chunkZ, extractTraversal = false) {
    const key = chunkKey(chunkX, chunkZ);
    const id = nextRequestId;
    nextRequestId += 1;
    const district = resolveChunk(chunkX, chunkZ) ?? { style: 'downtown', zoneSeed: CITY_SEED };
    pendingChunks.set(key, { id, chunkX, chunkZ, district, extractTraversal });
    nextWorker().postMessage({
      id,
      options: {
        seed: seedForChunk(chunkX, chunkZ, district.zoneSeed),
        cityStyle: district.style,
        cityZone: district.zone ?? null,
        chunkKey: key,
        chunkX,
        chunkZ,
        originX: chunkX * chunkStrideX,
        originZ: chunkZ * chunkStrideZ,
        furniture: cityFurniture,
        castShadows: cityCastShadows,
        extractTraversal,
      },
    });
  }

  function isRadiusAttached(current, radius) {
    for (let x = current.x - radius; x <= current.x + radius; x += 1) {
      for (let z = current.z - radius; z <= current.z + radius; z += 1) {
        if (!allowChunk(x, z)) continue;
        if (!chunks.has(chunkKey(x, z))) return false;
      }
    }
    return true;
  }

  function nextWorker() {
    if (workers.length === 0) {
      for (let index = 0; index < WORKER_COUNT; index += 1) {
        workers.push(createChunkWorker());
      }
    }

    const cityWorker = workers[nextWorkerIndex % workers.length];
    nextWorkerIndex += 1;
    return cityWorker;
  }

  function createChunkWorker() {
    const cityWorker = new Worker(new URL('./cityChunkWorker.js', import.meta.url), { type: 'module' });
    cityWorker.onmessage = (event) => {
      const { id, type, payload, error } = event.data ?? {};
      const traversalRequest = pendingTraversal.get(id);
      if (traversalRequest) {
        pendingTraversal.delete(id);
        if (!error && type === 'traversal') {
          installTraversal(event.data.chunkKey, event.data.traversal);
        }
        return;
      }
      const request = [...pendingChunks.values()].find((entry) => entry.id === id);

      if (!request) {
        return;
      }

      if (type === 'skeleton') {
        // Queue skeleton for throttled processing in updateStreaming rather than
        // handling synchronously — avoids an onmessage burst creating 24 BoxGeometry
        // sets and pushing hundreds of colliders between a single pair of frames.
        pendingSkeletons.push({ request, data: event.data });
        return;
      }

      // Complete (or error) phase.
      const key = chunkKey(request.chunkX, request.chunkZ);
      pendingChunks.delete(key);

      if (error) {
        console.warn('City chunk worker failed, falling back to main thread.', key, error.message);
        const fallback = createGeneratorCityLevel({
          seed: seedForChunk(request.chunkX, request.chunkZ, request.district?.zoneSeed),
          cityStyle: request.district?.style ?? 'downtown',
          cityZone: request.district?.zone ?? null,
          chunkKey: key,
          chunkX: request.chunkX,
          chunkZ: request.chunkZ,
          originX: request.chunkX * chunkStrideX,
          originZ: request.chunkZ * chunkStrideZ,
          includeDebugOverlay: false,
          furniture: cityFurniture,
          castShadows: cityCastShadows,
          extractTraversal: request.extractTraversal,
        });
        completedChunks.push(fallback);
        return;
      }

      // NOTE: deserialization (createGeneratorCityChunkFromPayload) of the
      // transferred buffers + mesh reconstruction happens LATER in
      // attachCompletedChunks (throttled to MAX=1 per frame). Not in this
      // onmessage handler, avoiding burst.
      completedChunks.push(payload);
    };
    cityWorker.onerror = (event) => {
      console.warn('City chunk worker error.', event.message);
    };
    return cityWorker;
  }

  // Drain up to MAX_SKELETON_ATTACHMENTS_PER_UPDATE skeletons from the queue.
  // Pushes the skeleton colliders directly into `out` so they flow through
  // addedColliders → Rapier without a per-frame intermediate array allocation.
  function drainPendingSkeletons(current, out) {
    let count = 0;

    while (pendingSkeletons.length > 0 && count < MAX_SKELETON_ATTACHMENTS_PER_UPDATE) {
      const { request, data } = pendingSkeletons.shift();
      const { colliders: rawColliders, layout, floorW, floorD, originX, originZ, cityZone } = data;
      const result = registerSkeleton(request, rawColliders, { layout, floorW, floorD, originX, originZ, cityZone }, current);
      if (result) {
        for (let i = 0; i < result.length; i += 1) out.push(result[i]);
      }
      count += 1;
    }
  }

  // Register skeleton box colliders and show a wireframe placeholder group.
  // Returns the tagged colliders so the caller can forward them to Rapier via addedColliders,
  // or null if the chunk is already loaded / outside unload radius.
  function registerSkeleton(request, rawColliders, { layout, floorW, floorD, originX, originZ, cityZone }, current) {
    const key = chunkKey(request.chunkX, request.chunkZ);

    if (chunks.has(key)) return null;

    // Skip if the player has already moved away.
    if (
      Math.abs(request.chunkX - current.x) > UNLOAD_RADIUS ||
      Math.abs(request.chunkZ - current.z) > UNLOAD_RADIUS
    ) {
      return null;
    }

    const tagged = rawColliders.map((c) => ({ ...c, chunkKey: key }));
    colliderIndex.addChunk(key, tagged);

    const placeholderGroup = createSkeletonPlaceholderGroup(tagged, { originX, originZ, floorW, floorD, cityZone });
    placeholderGroup.name = `Skeleton Placeholder ${key}`;
    group.add(placeholderGroup);
    skeletonGroups.set(key, placeholderGroup);
    skylineDirty = true;

    return tagged;
  }

  // Build a cheap placeholder group: road plane + one instanced box draw for buildings.
  function createSkeletonPlaceholderGroup(skeletonColliders, { originX, originZ, floorW, floorD, cityZone }) {
    const placeholderGroup = new THREE.Group();

    const road = new THREE.Mesh(
      getSkeletonRoadGeometry(),
      getSkeletonRoadMaterial(),
    );
    road.position.set(originX, 0.01, originZ);
    road.scale.set(floorW, 1, floorD);
    // A full rectangular loading plane visibly leaks beyond polygon/rect zones.
    // The terrain remains visible for the short skeleton phase instead.
    if (!cityZone) placeholderGroup.add(road);

    const buildingColliders = skeletonColliders.filter((c) => c.role === 'building');
    if (buildingColliders.length === 0) {
      return placeholderGroup;
    }

    const buildings = new THREE.InstancedMesh(
      getSkeletonBuildingGeometry(),
      getSkeletonBuildingMaterial(),
      buildingColliders.length,
    );
    buildings.name = 'Skeleton Placeholder Buildings';
    buildings.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    buildings.castShadow = false;
    buildings.receiveShadow = false;

    let instance = 0;
    for (const c of buildingColliders) {
      const w = c.maxX - c.minX;
      const h = c.topY - c.bottomY;
      const d = c.maxZ - c.minZ;
      skeletonInstanceMatrix.makeScale(w, h, d);
      skeletonInstanceMatrix.setPosition(
        (c.minX + c.maxX) * 0.5,
        c.bottomY + h * 0.5,
        (c.minZ + c.maxZ) * 0.5,
      );
      buildings.setMatrixAt(instance, skeletonInstanceMatrix);
      instance += 1;
    }
    buildings.instanceMatrix.needsUpdate = true;
    buildings.computeBoundingSphere();
    placeholderGroup.add(buildings);

    return placeholderGroup;
  }

  // Remove skeleton colliders from the JS array and dispose the placeholder group.
  // Does NOT remove Rapier bodies — that is handled via skeletonSwapKeys / removedChunkKeys.
  function cleanupSkeleton(key) {
    colliderIndex.removeChunk(key);
    const skeletonGroup = skeletonGroups.get(key);
    if (skeletonGroup) {
      skeletonGroup.removeFromParent();
      skeletonGroup.traverse((child) => {
        if (!child.geometry?.userData?.sharedSkeletonGeometry) {
          child.geometry?.dispose();
        }
      });
      skeletonGroups.delete(key);
      skylineDirty = true;
    }
  }

  function attachCompletedChunks({ addedChunks, debugVisible, current, maxCount }) {
    let attached = 0;

    while (completedChunks.length > 0 && attached < maxCount) {
      const payload = completedChunks.shift();
      const markId = `city-attach-${payload.chunkKey ?? attachCount}`;
      performance.mark(`${markId}-start`);
      const attachStartedAt = performance.now();
      const finishAttachMeasure = () => {
        lastAttachMs = performance.now() - attachStartedAt;
        worstAttachMs = Math.max(worstAttachMs, lastAttachMs);
        totalAttachMs += lastAttachMs;
        attachCount += 1;
        performance.mark(`${markId}-end`);
        performance.measure('city-chunk-attach', `${markId}-start`, `${markId}-end`);
        performance.clearMarks(`${markId}-start`);
        performance.clearMarks(`${markId}-end`);
      };
      const prepared = payload.group ? payload : createGeneratorCityChunkFromPayload(payload);

      if (!isChunkWithinUnloadRadius(prepared, current)) {
        prepared.dispose?.();
        cleanupSkeleton(prepared.chunkKey);
        finishAttachMeasure();
        continue;
      }

      const chunk = addPreparedChunk(prepared);
      if (!chunk) {
        finishAttachMeasure();
        continue;
      }

      setChunkTraversalDebugVisible(chunk, debugVisible);
      geometryIndex?.addRoot?.(chunk.group);
      addedChunks.push(chunk);
      attached += 1;
      finishAttachMeasure();
    }
  }

  function addPreparedChunk(chunk) {
    if (chunks.has(chunk.chunkKey)) {
      chunk.dispose?.();
      return null;
    }

    // If a skeleton was registered for this key, its Rapier bodies need to be
    // torn down before the real trimesh colliders go in. Signal this via
    // skeletonSwapKeys so the caller can include it in removedChunkKeys.
    if (skeletonGroups.has(chunk.chunkKey)) {
      skeletonSwapKeys.push(chunk.chunkKey);
    }

    // Remove JS-side skeleton entries and placeholder mesh.
    cleanupSkeleton(chunk.chunkKey);

    chunks.set(chunk.chunkKey, chunk);
    skylineDirty = true;
    group.add(chunk.group);
    furnitureBatcher.adoptChunkFurniture(chunk.group, chunk.chunkKey);
    purgeFurnitureReveals(chunk.chunkKey);
    // Opt chunk meshes into static-world-matrix freezing (see createLevelGeometryIndex
    // addRoot): the chunk group + its parent (the city root) + the scene never move
    // post-attach, so every baked mesh matrixWorld is final and can skip the per-pass
    // multiplyMatrices under the scene's force cascade.
    chunk.group.userData.freezeStaticWorldMatrices = true;
    colliderIndex.addChunk(chunk.chunkKey, chunk.colliders);
    if (chunk.traversalReady) installTraversal(chunk.chunkKey, chunk);
    stageChunkMeshes(chunk);
    return chunk;
  }

  function isChunkWithinUnloadRadius(chunk, current) {
    return (
      Math.abs(chunk.chunkX - current.x) <= UNLOAD_RADIUS &&
      Math.abs(chunk.chunkZ - current.z) <= UNLOAD_RADIUS
    );
  }

  function removeChunk(chunk) {
    chunks.delete(chunk.chunkKey);
    skylineDirty = true;
    furnitureBatcher.releaseChunk(chunk.chunkKey);
    geometryIndex?.removeRoot?.(chunk.group);
    colliderIndex.removeChunk(chunk.chunkKey);
    removeTraversal(chunk.chunkKey);
    for (const [id, request] of pendingTraversal) {
      if (request.chunkKey === chunk.chunkKey) pendingTraversal.delete(id);
    }
    chunk.group.removeFromParent();
    chunk.dispose?.();
  }

  function worldToChunk(position, target) {
    if (target) {
      target.x = Math.round((position?.x ?? 0) / chunkStrideX);
      target.z = Math.round((position?.z ?? 0) / chunkStrideZ);
      return target;
    }
    return {
      x: Math.round((position?.x ?? 0) / chunkStrideX),
      z: Math.round((position?.z ?? 0) / chunkStrideZ),
    };
  }

  function backfillFurnitureAdoption() {
    for (const chunk of chunks.values()) {
      furnitureBatcher.adoptChunkFurniture(chunk.group, chunk.chunkKey);
      purgeFurnitureReveals(chunk.chunkKey);
    }
  }

  function purgeFurnitureReveals(chunkKey = null) {
    for (let index = pendingMeshReveals.length - 1; index >= 0; index -= 1) {
      const entry = pendingMeshReveals[index];
      if (!isFurnitureMesh(entry.mesh)) continue;
      if (chunkKey && entry.chunkKey !== chunkKey) continue;
      pendingMeshReveals.splice(index, 1);
    }
  }

  function stageChunkMeshes(chunk) {
    const meshes = [];
    chunk.group.traverse((object) => {
      if (!object.isMesh || object.userData?.debugOverlay === 'traversal') return;
      if (isFurnitureMesh(object)) return;
      object.visible = false;
      object.userData.cityRevealPending = true;
      meshes.push(object);
    });
    meshes.sort((a, b) => Number(isFurnitureMesh(a)) - Number(isFurnitureMesh(b)));
    for (const mesh of meshes) pendingMeshReveals.push({ chunkKey: chunk.chunkKey, mesh });
  }

  function revealChunkMeshes(current, budget) {
    let revealed = 0;
    let scanned = 0;
    const scanLimit = pendingMeshReveals.length;
    while (pendingMeshReveals.length && revealed < budget && scanned < scanLimit) {
      const entry = pendingMeshReveals.shift();
      scanned += 1;
      const chunk = chunks.get(entry.chunkKey);
      if (!chunk || !entry.mesh) continue;
      if (isFurnitureMesh(entry.mesh) && !isChunkInRadius(chunk, current, furnitureRadius)) {
        pendingMeshReveals.push(entry);
        continue;
      }
      entry.mesh.visible = true;
      entry.mesh.userData.cityRevealPending = false;
      revealed += 1;
    }
  }

  function updateFurnitureVisibility(current) {
    for (const chunk of chunks.values()) {
      const visible = isChunkInRadius(chunk, current, furnitureRadius);
      chunk.group.traverse((mesh) => {
        if (!isFurnitureMesh(mesh)) return;
        if (!visible) {
          mesh.visible = false;
          return;
        }
        if (!mesh.visible && !mesh.userData.cityRevealPending) {
          mesh.userData.cityRevealPending = true;
          pendingMeshReveals.push({ chunkKey: chunk.chunkKey, mesh });
        }
      });
    }
  }

  function scheduleTraversalBackfill(current, justAdded) {
    if (!initialLoadComplete) return;
    for (const chunk of chunks.values()) {
      if (chunk.traversalReady || justAdded.has(chunk.chunkKey)) continue;
      if (!isChunkInRadius(chunk, current, traversalRadius)) continue;
      if (!chunk.traversalBuildings?.length) continue;
      // Skip if an extraction request for this chunk is already in flight.
      // Iterate the Map directly instead of materialising its values.
      let alreadyPending = false;
      for (const request of pendingTraversal.values()) {
        if (request.chunkKey === chunk.chunkKey) { alreadyPending = true; break; }
      }
      if (alreadyPending) continue;

      const id = nextRequestId++;
      const buildings = chunk.traversalBuildings;
      const transferables = collectTraversalTransferables(buildings);
      pendingTraversal.set(id, { chunkKey: chunk.chunkKey });
      nextWorker().postMessage({ id, type: 'extractTraversal', chunkKey: chunk.chunkKey, buildings }, transferables);
      // A chunk is extracted at most once; releasing this graph also drops the
      // now-transferred mesh arrays from the main-thread collider objects.
      chunk.traversalBuildings = null;
    }
  }

  function installTraversal(key, traversal) {
    const chunk = chunks.get(key);
    if (!chunk) return;
    chunk.traversalReady = true;
    chunk.ledges = traversal.ledges ?? [];
    chunk.climbSurfaces = traversal.climbSurfaces ?? [];
    chunk.wallRunSurfaces = traversal.wallRunSurfaces ?? [];
    chunk.ropes = traversal.ropes ?? [];
    traversalByChunk.ledges.set(key, chunk.ledges);
    traversalByChunk.climbSurfaces.set(key, chunk.climbSurfaces);
    traversalByChunk.wallRunSurfaces.set(key, chunk.wallRunSurfaces);
    traversalByChunk.ropes.set(key, chunk.ropes);
    rebuildTraversalViews();
  }

  function removeTraversal(key) {
    traversalByChunk.ledges.delete(key);
    traversalByChunk.climbSurfaces.delete(key);
    traversalByChunk.wallRunSurfaces.delete(key);
    traversalByChunk.ropes.delete(key);
    rebuildTraversalViews();
  }

  function rebuildTraversalViews() {
    replaceFlatView(ledges, traversalByChunk.ledges);
    replaceFlatView(climbSurfaces, traversalByChunk.climbSurfaces);
    replaceFlatView(wallRunSurfaces, traversalByChunk.wallRunSurfaces);
    replaceFlatView(ropes, traversalByChunk.ropes);
  }

  function isChunkInRadius(chunk, current, radius) {
    return Math.max(Math.abs(chunk.chunkX - current.x), Math.abs(chunk.chunkZ - current.z)) <= radius;
  }
}

function createSkylineMesh({ radius, chunkStrideX, chunkStrideZ }) {
  const diameter = radius * 2 + 1;
  // Capacity covers the whole square because unavailable near chunks retain a
  // proxy until their replacement skeleton/full geometry is actually attached.
  const chunkCapacity = diameter * diameter;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0x17191f, fog: true });
  const capacity = chunkCapacity * SKYLINE_BUILDINGS_PER_CHUNK;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'Far City Skyline';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.count = 0;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  const update = (centerX, centerZ, resolveDistrict) => {
    let instance = 0;
    for (let cx = centerX - radius; cx <= centerX + radius; cx += 1) {
      for (let cz = centerZ - radius; cz <= centerZ + radius; cz += 1) {
        const district = resolveDistrict(cx, cz);
        if (!district) continue;

        for (let i = 0; i < SKYLINE_BUILDINGS_PER_CHUNK; i += 1) {
          // Never let an unexpected non-integral/custom radius write beyond the
          // GPU instance buffer. WebGPU invalidates the entire command encoder
          // after one out-of-range vertex-buffer draw.
          if (instance >= capacity) break;
          const rx = skylineHash(cx, cz, i * 4);
          const rz = skylineHash(cx, cz, i * 4 + 1);
          const rw = skylineHash(cx, cz, i * 4 + 2);
          const rh = skylineHash(cx, cz, i * 4 + 3);
          const lowRise = district.style === 'suburbs';
          const commercial = district.style === 'commercial';
          const width = lowRise ? 10 + rw * 8 : commercial ? 34 + rw * 32 : 18 + rw * 34;
          const depth = lowRise ? 9 + skylineHash(cx, cz, i * 4 + 9) * 7 : commercial ? 24 + skylineHash(cx, cz, i * 4 + 9) * 24 : 18 + skylineHash(cx, cz, i * 4 + 9) * 34;
          // Mostly mid-rise blocks, with a stable minority of skyline towers.
          const tower = rh > 0.78 ? 1.65 : 1;
          const height = lowRise ? 5 + rh * 5 : commercial ? 7 + rh * 7 : (28 + rh * 92) * tower;
          position.set(
            cx * chunkStrideX + (rx - 0.5) * chunkStrideX * 0.82,
            height * 0.5 - 0.2,
            cz * chunkStrideZ + (rz - 0.5) * chunkStrideZ * 0.82,
          );
          if (district.zone && !rectInsideDistrictZone(district.zone, position.x, position.z, width, depth)) continue;
          scale.set(width, height, depth);
          matrix.compose(position, quaternion, scale);
          mesh.setMatrixAt(instance, matrix);
          instance += 1;
        }
      }
    }
    mesh.count = instance;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
    mesh.computeBoundingSphere();
    mesh.userData.skylineCapacity = capacity;
    mesh.userData.skylineCount = instance;
  };

  return { mesh, update };
}

function skylineHash(x, z, salt) {
  let value = Math.imul(x ^ (salt * 374761393), 668265263)
    ^ Math.imul(z ^ (salt * 1274126177), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function rectInsideDistrictZone(zone, x, z, width, depth) {
  const points = [
    [x - width / 2, z - depth / 2], [x + width / 2, z - depth / 2],
    [x + width / 2, z + depth / 2], [x - width / 2, z + depth / 2],
  ];
  return points.every(([px, pz]) => {
    if (zone.shape === 'rect') return px >= zone.rect.minX && px <= zone.rect.maxX && pz >= zone.rect.minZ && pz <= zone.rect.maxZ;
    let inside = false;
    const polygon = zone.points ?? [];
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if (((a.z > pz) !== (b.z > pz)) && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  });
}

function chunkKey(chunkX, chunkZ) {
  return `${chunkX}:${chunkZ}`;
}

export function seedForChunk(chunkX, chunkZ, zoneSeed = CITY_SEED) {
  let seed = (Number(zoneSeed) | 0) ^ Math.imul(chunkX, 73856093) ^ Math.imul(chunkZ, 19349663);
  seed = (seed ^ (seed >>> 16)) >>> 0;
  return seed || CITY_SEED;
}

function replaceFlatView(target, entriesByChunk) {
  target.length = 0;
  for (const entries of entriesByChunk.values()) {
    for (let index = 0; index < entries.length; index += 1) {
      target.push(entries[index]);
    }
  }
}

function isFurnitureMesh(object) {
  return object?.isMesh === true && object.userData?.materialRole?.startsWith('furniture');
}

function collectTraversalTransferables(buildings) {
  const transferables = [];
  const seen = new Set();
  for (const building of buildings) {
    const mesh = building?.collider?.physicsMesh;
    for (const array of [mesh?.vertices, mesh?.indices, mesh?.traversalIndices]) {
      const buffer = array?.buffer;
      if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) continue;
      seen.add(buffer);
      transferables.push(buffer);
    }
  }
  return transferables;
}

function setChunkTraversalDebugVisible(chunk, visible) {
  chunk.group?.traverse?.((object) => {
    if (!object.isLineSegments && object.userData?.debugOverlay === 'traversal') {
      object.visible = visible;
    }
  });
}

