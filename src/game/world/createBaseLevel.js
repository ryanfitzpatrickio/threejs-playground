import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createInfiniteCityLevel } from './createInfiniteCityLevel.js';
import { getCityStride } from './createGeneratorCityLevel.js';

const COLLIDER_GRID_CELL_SIZE = 32;
const COLLIDER_GRID_MAX_CELLS = 64;
const colliderGridCache = new WeakMap();

export function createBaseLevel(qualityPreset = {}) {
  const group = new THREE.Group();
  group.name = 'Base Level';

  const generatedCity = createInfiniteCityLevel(qualityPreset);
  group.add(generatedCity.group);

  const geometryIndex = generatedCity.geometryIndex;

  const allColliders = generatedCity.colliders ?? [];
  const colliderIndex = generatedCity.colliderIndex ?? null;

  return {
    name: 'Generator City',
    group,
    colliders: allColliders,
    colliderIndex,
    ledges: generatedCity.ledges ?? [],
    climbSurfaces: generatedCity.climbSurfaces ?? [],
    wallRunSurfaces: generatedCity.wallRunSurfaces ?? [],
    ropes: generatedCity.ropes ?? [],
    geometryIndex,
    terrainChunks: null,
    spawnPoint: generatedCity.spawnPoint ?? null,
    updateStreaming: generatedCity.updateStreaming,
    cityChunks: generatedCity.cityChunks,
    cityChunkStride: generatedCity.cityChunkStride,
    snapshot: generatedCity.snapshot,
    createPipelineWarmupGroup: generatedCity.createPipelineWarmupGroup,
    // Prefer false when the method is missing so city is not falsely ready.
    isNearFieldReady: () => generatedCity.isNearFieldReady?.() ?? false,

    getGroundHeightAt: (position, radius = 0.28, options = {}) => {
      return getGroundHeightAt({
        position,
        radius,
        maxStepUp: options.maxStepUp,
        maxSnapDown: options.maxSnapDown,
        requiredInset: options.requiredInset,
        colliders: allColliders,
        index: colliderIndex,
      });
    },

    findNearestRoadPoint: (x, z, options) => findNearestCityRoadPoint(x, z, options),

    getRoadSurfaceAt: (x, z) => getColliderRoadSurfaceAt({
      x,
      z,
      colliders: allColliders,
      index: colliderIndex,
    }),

    getBlockingColliderAt: ({ position, radius, feetY, height, stepHeight }) => {
      const fromObjects = getBlockingColliderAt({
        position,
        radius,
        feetY,
        height,
        stepHeight,
        colliders: allColliders,
        index: colliderIndex,
      });
      if (fromObjects) return fromObjects;
      return null;
    },

    dispose: () => {
      generatedCity.dispose?.();
      disposeObject3D(group);
    },
  };
}

export function getGroundHeightAt({ position, radius, maxStepUp, maxSnapDown, requiredInset, colliders, index, baseHeight = 0 }) {
  let groundHeight = baseHeight;

  const consider = (collider) => {
    const surfaceY = typeof collider.surfaceHeightAt === 'function'
      ? collider.surfaceHeightAt(position.x, position.z)
      : collider.topY;
    const hasVerticalSnapWindow = Number.isFinite(maxStepUp) || Number.isFinite(maxSnapDown);
    if (collider.noGroundSnap === true && !hasVerticalSnapWindow) {
      return;
    }

    const inset = Number.isFinite(requiredInset) ? requiredInset : -radius;
    const insideLooseX = position.x + radius >= collider.minX && position.x - radius <= collider.maxX;
    const insideLooseZ = position.z + radius >= collider.minZ && position.z - radius <= collider.maxZ;
    const insideInsetX = position.x >= collider.minX + inset && position.x <= collider.maxX - inset;
    const insideInsetZ = position.z >= collider.minZ + inset && position.z <= collider.maxZ - inset;
    const needsInset = Number.isFinite(requiredInset) && surfaceY > position.y;
    const insideX = needsInset ? insideInsetX : insideLooseX;
    const insideZ = needsInset ? insideInsetZ : insideLooseZ;

    if (
      Number.isFinite(maxStepUp) &&
      surfaceY > position.y + maxStepUp
    ) {
      return;
    }

    if (
      Number.isFinite(maxSnapDown) &&
      surfaceY < position.y - maxSnapDown
    ) {
      return;
    }

    if (insideX && insideZ && surfaceY > groundHeight) {
      groundHeight = surfaceY;
    }
  };

  // Prefer the spatial index (city): visit only cells overlapping the disc
  // instead of scanning every collider (and rebuild-on-stream churn). Fall back
  // to the WeakMap cell grid for flat-array callers (streaming/composed world).
  if (index) {
    index.forEachInPointRadius(position.x, position.z, radius, consider);
  } else {
    for (const collider of queryNearbyColliders(colliders, position, radius)) {
      consider(collider);
    }
  }

  return groundHeight;
}

/**
 * Surface under a world XZ point from tagged city colliders (e.g. asphalt roads).
 * Uses the highest overlapping collider so sidewalks/buildings mask the road below.
 */
export function getColliderRoadSurfaceAt({ x, z, colliders, index, radius = 0.35 }) {
  const position = { x, y: 0, z };
  let bestY = -Infinity;
  let bestSurface = null;

  const consider = (collider) => {
    const surfaceY = typeof collider.surfaceHeightAt === 'function'
      ? collider.surfaceHeightAt(x, z)
      : collider.topY;
    if (!Number.isFinite(surfaceY)) return;

    const insideX = x + radius >= collider.minX && x - radius <= collider.maxX;
    const insideZ = z + radius >= collider.minZ && z - radius <= collider.maxZ;
    if (!insideX || !insideZ) return;

    if (surfaceY >= bestY) {
      bestY = surfaceY;
      bestSurface = collider.surface ?? null;
    }
  };

  if (index) {
    index.forEachInPointRadius(x, z, radius, consider);
  } else {
    for (const collider of queryNearbyColliders(colliders, position, radius)) {
      consider(collider);
    }
  }

  return bestSurface;
}

function queryNearbyColliders(colliders, position, radius) {
  if (!Array.isArray(colliders) || colliders.length === 0) return [];

  let index = colliderGridCache.get(colliders);
  if (
    !index
    || index.length !== colliders.length
    || index.first !== colliders[0]
    || index.last !== colliders[colliders.length - 1]
  ) {
    index = buildColliderGrid(colliders);
    colliderGridCache.set(colliders, index);
  }

  const minCellX = Math.floor((position.x - radius) / COLLIDER_GRID_CELL_SIZE);
  const maxCellX = Math.floor((position.x + radius) / COLLIDER_GRID_CELL_SIZE);
  const minCellZ = Math.floor((position.z - radius) / COLLIDER_GRID_CELL_SIZE);
  const maxCellZ = Math.floor((position.z + radius) / COLLIDER_GRID_CELL_SIZE);
  const result = [...index.global];
  const seen = new Set(index.global);

  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      const bucket = index.cells.get(`${cellX}:${cellZ}`);
      if (!bucket) continue;
      for (const collider of bucket) {
        if (!seen.has(collider)) {
          seen.add(collider);
          result.push(collider);
        }
      }
    }
  }

  return result;
}

function buildColliderGrid(colliders) {
  const cells = new Map();
  const global = [];

  for (const collider of colliders) {
    if (![collider?.minX, collider?.maxX, collider?.minZ, collider?.maxZ].every(Number.isFinite)) {
      global.push(collider);
      continue;
    }

    const minCellX = Math.floor(collider.minX / COLLIDER_GRID_CELL_SIZE);
    const maxCellX = Math.floor(collider.maxX / COLLIDER_GRID_CELL_SIZE);
    const minCellZ = Math.floor(collider.minZ / COLLIDER_GRID_CELL_SIZE);
    const maxCellZ = Math.floor(collider.maxZ / COLLIDER_GRID_CELL_SIZE);
    const cellCount = (maxCellX - minCellX + 1) * (maxCellZ - minCellZ + 1);
    if (cellCount > COLLIDER_GRID_MAX_CELLS) {
      global.push(collider);
      continue;
    }

    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const key = `${cellX}:${cellZ}`;
        let bucket = cells.get(key);
        if (!bucket) {
          bucket = [];
          cells.set(key, bucket);
        }
        bucket.push(collider);
      }
    }
  }

  return {
    cells,
    global,
    length: colliders.length,
    first: colliders[0],
    last: colliders[colliders.length - 1],
  };
}

export function getBlockingColliderAt({ position, radius, feetY, height, stepHeight, colliders, index }) {
  const bodyBottom = feetY + 0.05;
  const bodyTop = feetY + height;
  let found = null;

  const consider = (collider) => {
    if (found) return;
    if (collider?.disabled === true) return;
    const overlapsX = position.x + radius > collider.minX && position.x - radius < collider.maxX;
    const overlapsZ = position.z + radius > collider.minZ && position.z - radius < collider.maxZ;
    const hitsSideHeight = bodyTop > collider.bottomY + 0.05 && bodyBottom < collider.topY - stepHeight;

    if (overlapsX && overlapsZ && hitsSideHeight) {
      found = collider;
    }
  };

  if (index) {
    index.forEachInPointRadius(position.x, position.z, radius, consider);
  } else {
    for (const collider of colliders ?? []) {
      consider(collider);
    }
  }

  return found;
}

function createSaltPlane() {
  const geometry = new THREE.PlaneGeometry(
    GAME_CONFIG.world.planeSize,
    GAME_CONFIG.world.planeSize,
    GAME_CONFIG.world.planeSegments,
    GAME_CONFIG.world.planeSegments,
  );
  const position = geometry.attributes.position;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const ripple = Math.sin(x * 0.19) * Math.cos(y * 0.16) * 0.035;
    position.setZ(i, ripple);
  }

  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: 0xe9ede4,
    roughness: 0.88,
    metalness: 0.02,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Open Salt Plane';
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;

  return mesh;
}

function createDistanceGrid() {
  const grid = new THREE.GridHelper(GAME_CONFIG.world.planeSize, 36, 0x8a8172, 0xb8c4b9);
  grid.name = 'Plane Readability Grid';
  grid.material.opacity = 0.18;
  grid.material.transparent = true;
  grid.position.y = 0.018;

  return grid;
}

function findNearestCityRoadPoint(x, z, { maxDistance = 180 } = {}) {
  const stride = getCityStride();
  const rx = Math.round(x / stride.x) * stride.x;
  const rz = Math.round(z / stride.z) * stride.z;
  const distance = Math.hypot(x - rx, z - rz);
  if (distance > maxDistance) return null;
  const rotationY = Math.abs(x - rx) >= Math.abs(z - rz) ? Math.PI / 2 : 0;
  return { x: rx, z: rz, y: 0, rotationY, distance };
}
