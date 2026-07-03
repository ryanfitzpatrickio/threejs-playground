/**
 * createComposedWorldLevel.js
 *
 * Composes the two existing streaming systems into one playable World level
 * driven by a world map:
 *   - terrain everywhere (createStreamingTerrainLevel), flattened to y=0 under
 *     `city` zones, and
 *   - the city generator (createInfiniteCityLevel) gated to chunks that intersect
 *     a `city` zone, streamed in as you approach.
 *
 * It returns one level descriptor of the shape LevelSystem / GameRuntime /
 * PhysicsSystem already consume, merging the two sub-levels' groups, streaming
 * changes, colliders, ground queries, and geometry indices.
 */

import * as THREE from 'three';
import { createStreamingTerrainLevel } from './createStreamingTerrainLevel.js';
import { createInfiniteCityLevel } from './createInfiniteCityLevel.js';
import { getCityStride } from './createGeneratorCityLevel.js';
import { getGroundHeightAt as colliderGroundHeightAt, getBlockingColliderAt as colliderBlockingAt } from './createBaseLevel.js';
import { zoneIntersectsRect } from '../../world/worldMap/zoneGeometry.js';
import { zoneContains } from '../../world/worldMap/zoneGeometry.js';
import { CITY_STYLES } from '../../world/worldMap/worldMapSchema.js';

const cityPhysicsOwnerKey = (chunkKey) => `city:${chunkKey}`;

export function createComposedWorldLevel(qualityPreset = {}, { worldMap = null } = {}) {
  const cityZones = (worldMap?.zones ?? []).filter((zone) => zone.type === 'city');

  const stride = getCityStride();
  // A city chunk (cx,cz) spans world [cx*stride.x ± stride.x/2] × [cz*stride.z ± stride.z/2].
  // Stream it only if that footprint overlaps a `city` zone (rect or polygon).
  const chunkResolver = (cx, cz) => {
    return resolveCityChunkDistrict(cityZones, cx, cz, stride);
  };

  // City zones flatten the terrain beneath them (whatever their shape).
  const terrain = createStreamingTerrainLevel(qualityPreset, { worldMap, flattenZones: cityZones });
  const city = createInfiniteCityLevel(qualityPreset, { chunkResolver });

  const group = new THREE.Group();
  group.name = 'Composed World';
  group.add(terrain.group);
  group.add(city.group);

  // Composite geometry index: fan raycast / warmup out to both sub-indices so
  // traversal, hook, and avoidance queries see terrain and city together.
  const geometryIndex = {
    get entries() {
      return [...(terrain.geometryIndex?.entries ?? []), ...(city.geometryIndex?.entries ?? [])];
    },
    raycast: (query) => {
      const hits = [
        ...(terrain.geometryIndex?.raycast(query) ?? []),
        ...(city.geometryIndex?.raycast(query) ?? []),
      ];
      hits.sort((a, b) => a.distance - b.distance);
      return hits;
    },
    warmupBoundsTrees: (opts) =>
      (terrain.geometryIndex?.warmupBoundsTrees?.(opts) ?? 0) +
      (city.geometryIndex?.warmupBoundsTrees?.(opts) ?? 0),
    dispose: () => {},
  };

  return {
    name: worldMap ? `World: ${worldMap.name ?? 'Untitled'}` : 'Composed World',
    group,
    // City owns the traversal arrays; terrain contributes road bridge-deck colliders.
    get colliders() { return [...terrain.colliders, ...city.colliders]; },
    get ledges() { return city.ledges; },
    get climbSurfaces() { return city.climbSurfaces; },
    get wallRunSurfaces() { return city.wallRunSurfaces; },
    get ropes() { return city.ropes; },
    geometryIndex,
    spawnPoint: terrain.spawnPoint,
    terrainChunks: terrain.terrainChunks,
    cityChunks: city.cityChunks,
    cityChunkStride: city.cityChunkStride,
    createPipelineWarmupGroup: city.createPipelineWarmupGroup,

    updateStreaming: (position, options = {}) => {
      const t = terrain.updateStreaming(position) ?? {};
      const c = city.updateStreaming(position, options) ?? {};
      return {
        // City chunks are heavy → keep them on the hide-until-compiled path.
        addedChunks: c.addedChunks ?? [],
        // City and terrain both use coordinate keys such as "0:0" internally.
        // Give city bodies a separate Rapier owner namespace so unloading a terrain
        // chunk or replacing a city skeleton cannot delete the other system's bodies.
        addedColliders: (c.addedColliders ?? []).map((collider) => ({
          ...collider,
          physicsOwnerKey: cityPhysicsOwnerKey(collider.chunkKey),
        })),
        addedTerrainChunks: t.addedTerrainChunks ?? [],
        removedChunkKeys: [
          ...(c.removedChunkKeys ?? []).map(cityPhysicsOwnerKey),
          ...(t.removedChunkKeys ?? []),
        ],
      };
    },

    // Ground = the higher of the (flattened) terrain surface and any city collider
    // top under the point. baseHeight -Infinity so "no city collider here" loses to
    // terrain instead of clamping it up to 0.
    getGroundHeightAt: (position, radius = 0.28, options = {}) => {
      const terrainY = terrain.getGroundHeightAt(position, radius, options);
      const cityY = colliderGroundHeightAt({
        position,
        radius,
        maxStepUp: options.maxStepUp,
        maxSnapDown: options.maxSnapDown,
        requiredInset: options.requiredInset,
        colliders: city.colliders,
        baseHeight: -Infinity,
      });
      return Math.max(terrainY, cityY);
    },

    // Ground vehicles need a real heightfield under them even if the chunk only
    // streamed in visually (the character rides analytic ground). Delegate to the
    // terrain sub-level, which owns the chunk data + heightfield payloads.
    ensureGroundCollider: (position, physics, options) =>
      terrain.ensureGroundCollider?.(position, physics, options) ?? false,

    getBlockingColliderAt: ({ position, radius, feetY, height, stepHeight }) =>
      colliderBlockingAt({ position, radius, feetY, height, stepHeight, colliders: city.colliders }) ?? null,

    // River water-surface query for the character swim detector (MovementSystem).
    // Delegates to the terrain sub-level (city has no water). Without this explicit
    // forwarding, level.getWaterHeightAt would be undefined and swim never fires.
    getWaterHeightAt: (position) =>
      terrain.getWaterHeightAt?.(position) ?? { waterY: 0, weight: 0 },

    snapshot: () => ({
      terrain: terrain.snapshot?.() ?? null,
      city: city.snapshot?.() ?? null,
      cityZones: cityZones.length,
    }),

    dispose: () => {
      terrain.dispose?.();
      city.dispose?.();
      group.removeFromParent();
    },
  };
}

export function resolveCityChunkDistrict(cityZones, cx, cz, stride = getCityStride()) {
  const rect = {
    minX: cx * stride.x - stride.x * 0.5, maxX: cx * stride.x + stride.x * 0.5,
    minZ: cz * stride.z - stride.z * 0.5, maxZ: cz * stride.z + stride.z * 0.5,
  };
  let edgeMatch = null;
  for (let i = (cityZones?.length ?? 0) - 1; i >= 0; i -= 1) {
    const zone = cityZones[i];
    const district = { style: CITY_STYLES[zone.props?.cityStyle] ? zone.props.cityStyle : 'downtown',
      zoneSeed: Number.isFinite(Number(zone.props?.seed)) ? Number(zone.props.seed) : 1,
      zone: zone.shape === 'polygon'
        ? { shape: 'polygon', points: zone.points.map((point) => ({ x: point.x, z: point.z })) }
        : { shape: 'rect', rect: { ...zone.rect } } };
    if (zoneContains(zone, cx * stride.x, cz * stride.z)) return district;
    if (!edgeMatch && zoneIntersectsRect(zone, rect)) edgeMatch = district;
  }
  return edgeMatch;
}
