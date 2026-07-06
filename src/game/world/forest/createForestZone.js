/**
 * createForestZone.js
 *
 * Polygon-masked procedural forest for `forest` world-map zones.
 * M3+: LOD2 near buckets + impostor far buckets with camera rebinning.
 * M7: closest trees swap to LOD1 geometry. Low uses a tighter real→impostor blend.
 * Stretch: off-road collider pool, needle-litter mask, forest ambience.
 */
import * as THREE from 'three';
import { createZoneForest } from '../createZoneForest.js';
import { buildForestArchetypes } from './forestArchetypes.js';
import { scatterForestPlacements } from './forestPlacement.js';
import { isForestZoneCorridorExcluded } from './forestCorridor.js';
import { FOREST_CORRIDOR_MARGIN } from './forestPlacement.js';
import { buildStaticForestBuckets, disposeForestBuckets } from './forestInstancing.js';
import {
  createForestLodState,
  disposeForestLodState,
  installForestLodImpostor,
  rebinForestLod,
} from './forestLod.js';
import { syncForestEnvironment } from './forestEnvironment.js';
import { buildForestTrunkColliders } from './forestColliders.js';
import { parseForestSpeciesMix } from './forestSpecies.js';
import { createForestOffRoadPool } from './forestOffRoadPool.js';
import { buildForestLitterMask } from './forestLitter.js';
import { createForestAmbience } from './forestAmbience.js';

const ARCHETYPE_COUNT = 5;

export { isForestZoneCorridorExcluded, FOREST_CORRIDOR_MARGIN };

/**
 * @returns {Promise<{ group, count, placements, colliders, setCameraPosition(), updateEnvironment(), dispose(), snapshot() }>}
 */
export async function createForestZone({
  zones = [],
  sampleHeight,
  roadCorridor = null,
  riverCorridor = null,
  findNearestRoadPoint = null,
  qualityPreset = {},
  renderer = null,
  initialCameraPosition = null,
}) {
  const timings = {
    forestArchetypeBuildMs: 0,
    forestPlacementMs: 0,
    forestColliderBuildMs: 0,
    forestOffRoadPoolBuildMs: 0,
    forestLitterBuildMs: 0,
  };
  const empty = {
    group: null,
    count: 0,
    placements: [],
    colliders: [],
    litterMask: null,
    setCameraPosition() {},
    updateEnvironment() {},
    updateDrivingColliders() {},
    updateAmbience() {},
    wakeAmbience() {},
    dispose() {},
    snapshot: () => ({
      forestTrees: 0,
      forestArchetypes: 0,
      forestNear: 0,
      forestImpostors: 0,
      forestRebinMs: 0,
      ...timings,
    }),
  };
  if (!zones.length) return empty;

  const lodMode = qualityPreset.forestLodMode
    ?? (qualityPreset.forestRealTrees === false ? 'blob' : 'blend');
  const useRealTrees = lodMode !== 'blob';
  const placementCap = qualityPreset.forestTreeBudget ?? 4000;
  const nearCount = qualityPreset.forestNearCount ?? 250;
  const nearRadius = qualityPreset.forestNearRadius ?? 120;
  const farRadius = qualityPreset.forestFarRadius ?? 450;
  const heroCount = qualityPreset.forestHeroCount ?? 16;
  const heroRadius = qualityPreset.forestHeroRadius ?? 50;
  const castShadow = qualityPreset.shadows === true;
  const foliageShadows = qualityPreset.forestFoliageShadows === true;
  const useImpostors = lodMode === 'blend';

  const speciesConfigs = new Map();
  for (const zone of zones) {
    const species = zone.props?.species ?? 'pine';
    const config = speciesConfigs.get(species) ?? { species, zones: [] };
    config.zones.push(zone);
    speciesConfigs.set(species, config);
  }

  if (!useRealTrees) {
    const blob = createZoneForest({
      zones,
      sampleHeight,
      forestCount: Math.min(placementCap, nearCount),
      roadCorridor,
      riverCorridor,
    });
    const ambience = createForestAmbience({ zones });
    return {
      ...blob,
      placements: [],
      colliders: [],
      litterMask: null,
      updateEnvironment() {},
      updateDrivingColliders() {},
      updateAmbience(position, delta) { ambience.update(position, delta); },
      wakeAmbience() { ambience.wake(); },
      snapshot: () => ({
        forestTrees: blob.count ?? 0,
        forestArchetypes: 0,
        forestFallback: 'blob',
        forestNear: 0,
        forestImpostors: 0,
        forestRebinMs: 0,
        ...timings,
        ...ambience.snapshot(),
      }),
      dispose() {
        blob.dispose?.();
        ambience.dispose();
      },
    };
  }

  // Build an archetype range for each authored species configuration. A single
  // species forest keeps five shape variants; multi-species showcase maps use
  // one variant per species so 19 plots do not balloon into 95 heavy trees.
  const packs = [];
  const archetypes = [];
  const archetypeRangeByZone = new Map();
  const archetypeBuildStartedAt = performance.now();
  for (const config of speciesConfigs.values()) {
    const firstZone = config.zones[0];
    const speciesSeed = Number.isFinite(Number(firstZone?.props?.seed))
      ? Number(firstZone.props.seed)
      : 1;
    const pack = await buildForestArchetypes({
      species: config.species,
      count: speciesConfigs.size === 1 ? ARCHETYPE_COUNT : 1,
      speciesSeed,
      renderer,
      castShadow,
      bakeImpostors: false,
    });
    const start = archetypes.length;
    for (const archetype of pack.archetypes) {
      archetype.index = archetypes.length;
      archetypes.push(archetype);
    }
    for (const zone of config.zones) {
      archetypeRangeByZone.set(zone.id, { start, count: pack.archetypes.length });
    }
    packs.push(pack);
  }
  timings.forestArchetypeBuildMs = performance.now() - archetypeBuildStartedAt;

  const archetypePack = {
    archetypes,
    dispose() {
      for (const pack of packs) pack.dispose();
    },
  };

  const placementStartedAt = performance.now();
  const placements = scatterForestPlacements({
    zones,
    sampleHeight,
    roadCorridor,
    riverCorridor,
    archetypeCount: archetypePack.archetypes.length,
    pickArchetypeIndex: (zone, rng) => {
      const range = archetypeRangeByZone.get(zone.id);
      if (!range?.count) return 0;
      return range.start + Math.floor(rng() * range.count);
    },
    cap: placementCap,
    corridorExcluded: isForestZoneCorridorExcluded,
  });
  timings.forestPlacementMs = performance.now() - placementStartedAt;

  const colliderStartedAt = performance.now();
  const { colliders, staticPlacementIndices } = buildForestTrunkColliders(placements, {
    findNearestRoadPoint,
  });
  timings.forestColliderBuildMs = performance.now() - colliderStartedAt;
  const offRoadPoolStartedAt = performance.now();
  const offRoadPool = createForestOffRoadPool(placements, { staticPlacementIndices });
  timings.forestOffRoadPoolBuildMs = performance.now() - offRoadPoolStartedAt;
  const litterStartedAt = performance.now();
  const litterMask = buildForestLitterMask(zones, placements);
  timings.forestLitterBuildMs = performance.now() - litterStartedAt;
  const ambience = createForestAmbience({ zones });

  let lodState = null;
  let treesGroup = null;
  let staticMode = false;
  let disposed = false;
  let impostorBakeStatus = useImpostors && renderer ? 'pending' : 'disabled';

  if (renderer) {
    lodState = createForestLodState(archetypePack.archetypes, placements, {
      nearCount,
      nearRadius,
      heroCount,
      heroRadius,
      farRadius,
      castShadow,
      foliageShadows,
      lodMode,
    });
    treesGroup = lodState.group;
    rebinForestLod(lodState, initialCameraPosition ?? new THREE.Vector3(0, 0, 0), { force: true });
  } else {
    staticMode = true;
    treesGroup = buildStaticForestBuckets(archetypePack.archetypes, placements);
  }

  const group = new THREE.Group();
  group.name = 'Forest Zone Group';
  group.userData.noCollision = true;
  group.add(treesGroup);

  if (renderer && useImpostors) {
    requestAnimationFrame(async () => {
      if (disposed) return;
      impostorBakeStatus = 'baking';
      try {
        for (const pack of packs) {
          if (disposed) break;
          await pack.ensureImpostors(renderer, {
            onArchetype: (archetype) => {
              if (!disposed) installForestLodImpostor(lodState, archetype);
            },
          });
        }
        if (!disposed) impostorBakeStatus = 'ready';
      } catch (error) {
        impostorBakeStatus = 'error';
        console.warn('[forest] lazy impostor bake failed; keeping real-tree fallback', error);
      }
    });
  }

  const _cam = new THREE.Vector3();
  let stats = { near: 0, hero: 0, far: 0, culled: 0 };
  let physicsRef = null;

  return {
    group,
    count: placements.length,
    placements,
    colliders,
    litterMask,
    setCameraPosition(pos) {
      if (!pos || !lodState) return;
      _cam.set(pos.x, pos.y, pos.z);
      stats = rebinForestLod(lodState, _cam) ?? stats;
    },
    updateEnvironment({ sunDirection, windVector } = {}) {
      syncForestEnvironment({ sunDirection, windVector });
    },
    updateDrivingColliders(position, physics) {
      physicsRef = physics ?? physicsRef;
      offRoadPool.update(position, physicsRef);
    },
    updateAmbience(position, delta) {
      ambience.update(position, delta);
    },
    wakeAmbience() {
      ambience.wake();
    },
    snapshot: () => ({
      forestTrees: placements.length,
      forestArchetypes: archetypePack.archetypes.length,
      forestSpecies: [...new Set(zones.flatMap((zone) =>
        parseForestSpeciesMix(zone.props?.species).map((entry) => entry.key)))]
        .join('+'),
      forestFallback: null,
      forestLodMode: lodMode,
      forestNear: stats.near + stats.hero,
      forestImpostors: stats.far,
      forestRebinMs: lodState?.rebinMs ?? 0,
      ...timings,
      forestArchetypeCacheHit: packs.length > 0 && packs.every((pack) => pack.cacheHit),
      forestImpostorBakeMs: packs.reduce(
        (total, pack) => total + (pack.snapshot?.().forestImpostorBakeMs ?? 0), 0,
      ),
      forestImpostorsReady: packs.reduce(
        (total, pack) => total + (pack.snapshot?.().forestImpostorsReady ?? 0), 0,
      ),
      forestImpostorBakeStatus: impostorBakeStatus,
      forestNearRadius: nearRadius,
      forestFarRadius: farRadius,
      forestTrunkColliders: colliders.length,
      ...offRoadPool.snapshot(),
      ...ambience.snapshot(),
    }),
    dispose() {
      disposed = true;
      offRoadPool.dispose(physicsRef);
      if (staticMode) disposeForestBuckets(treesGroup);
      else disposeForestLodState(lodState);
      archetypePack.dispose();
      ambience.dispose();
      litterMask?.texture?.dispose?.();
    },
  };
}
