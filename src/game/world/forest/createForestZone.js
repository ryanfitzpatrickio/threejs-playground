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
import { createForestLodState, rebinForestLod, disposeForestLodState } from './forestLod.js';
import { syncForestEnvironment } from './forestEnvironment.js';
import { buildForestTrunkColliders } from './forestColliders.js';
import { parseForestSpeciesMix } from './forestSpecies.js';
import { createForestOffRoadPool } from './forestOffRoadPool.js';
import { buildForestLitterMask } from './forestLitter.js';
import { createForestAmbience } from './forestAmbience.js';

const ARCHETYPE_COUNT = 5;
const HERO_TREE_COUNT = 30;

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
}) {
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
  const castShadow = qualityPreset.shadows === true;
  const useImpostors = lodMode === 'blend';

  const speciesMix = zones.map((z) => z.props?.species).find(Boolean) ?? 'pine';
  const speciesSeed = Number.isFinite(Number(zones[0]?.props?.seed))
    ? Number(zones[0].props.seed)
    : 1;

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
        ...ambience.snapshot(),
      }),
      dispose() {
        blob.dispose?.();
        ambience.dispose();
      },
    };
  }

  const archetypePack = await buildForestArchetypes({
    species: speciesMix,
    count: ARCHETYPE_COUNT,
    speciesSeed,
    renderer,
    castShadow,
    bakeImpostors: !!renderer && useImpostors,
  });

  const placements = scatterForestPlacements({
    zones,
    sampleHeight,
    roadCorridor,
    riverCorridor,
    archetypeCount: archetypePack.archetypes.length,
    cap: placementCap,
    corridorExcluded: isForestZoneCorridorExcluded,
  });

  const { colliders, staticPlacementIndices } = buildForestTrunkColliders(placements, {
    findNearestRoadPoint,
  });
  const offRoadPool = createForestOffRoadPool(placements, { staticPlacementIndices });
  const litterMask = buildForestLitterMask(zones, placements);
  const ambience = createForestAmbience({ zones });

  let lodState = null;
  let treesGroup = null;
  let staticMode = false;

  if (renderer) {
    lodState = createForestLodState(archetypePack.archetypes, placements, {
      nearCount,
      nearRadius,
      heroCount: HERO_TREE_COUNT,
      farRadius,
      castShadow,
      lodMode,
    });
    treesGroup = lodState.group;
    rebinForestLod(lodState, new THREE.Vector3(0, 0, 0), { force: true });
  } else {
    staticMode = true;
    treesGroup = buildStaticForestBuckets(archetypePack.archetypes, placements);
  }

  const group = new THREE.Group();
  group.name = 'Forest Zone Group';
  group.userData.noCollision = true;
  group.add(treesGroup);

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
      forestSpecies: parseForestSpeciesMix(speciesMix).map((e) => e.key).join('+'),
      forestFallback: null,
      forestLodMode: lodMode,
      forestNear: stats.near + stats.hero,
      forestImpostors: stats.far,
      forestRebinMs: lodState?.rebinMs ?? 0,
      forestNearRadius: nearRadius,
      forestFarRadius: farRadius,
      forestTrunkColliders: colliders.length,
      ...offRoadPool.snapshot(),
      ...ambience.snapshot(),
    }),
    dispose() {
      offRoadPool.dispose(physicsRef);
      if (staticMode) disposeForestBuckets(treesGroup);
      else disposeForestLodState(lodState);
      archetypePack.dispose();
      ambience.dispose();
      litterMask?.texture?.dispose?.();
    },
  };
}
