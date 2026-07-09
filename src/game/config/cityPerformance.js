/**
 * City-mode performance overrides. Open-world modes (world / wilds / rally) keep
 * the raw quality preset; pure city mode applies tier-scaled cuts.
 *
 * Tier mapping for city (to keep Ultra runnable):
 *   low   → 0 : new lower-spec baseline
 *   high  → 1 : what "Low" used to deliver in city (Medium label now ≈ old Low)
 *   ultra → 2 : what "Medium"/High used to deliver (Ultra label now ≈ old Medium)
 *   max   → 3 : what "Ultra" used to be (recovers former Ultra city load)
 *
 * Trace baseline (2026-07): ~45 ms p95 hitches were GPU shadow-map passes while
 * three.webgpu update() stayed ~3.4 ms. These overrides target that gap.
 *
 * Node-material GC (2026-07-03): downtown CPU time was >50% in V8 major GC from
 * Three's per-draw node refresh at city mesh counts. Mitigations live in
 * createLevelGeometryIndex (object.static), CityFurnitureBatcher (instanced
 * furniture pools), and the city generators (no tree positionNode/time; view-space road
 * LOD without cameraPosition).
 */

const CITY_TIER = { low: 0, high: 1, ultra: 2, max: 3 };

function cityTier(qualityLevel) {
  if (qualityLevel === 'max') return 3;
  if (qualityLevel === 'ultra') return 2;
  if (qualityLevel === 'high') return 1;
  if (qualityLevel === 'low') return 0;
  return 1;
}

/** Per-tier value for city: low → med(now high) → ultra(now med) → max(old ultra). */
function tierPick(qualityLevel, vLow, vMed, vUltra, vMax) {
  const i = cityTier(qualityLevel);
  if (i === 0) return vLow;
  if (i === 1) return vMed;
  if (i === 2) return vUltra;
  return vMax;
}

export function isCityLevelMode(levelMode) {
  return levelMode === 'city';
}

function scaleCityFurniture(furniture, scale) {
  if (!furniture || scale >= 1) return furniture;
  const densityKeys = [
    'streetlightDensity', 'trafficlightDensity', 'trashcanDensity',
    'hydrantDensity', 'benchDensity', 'treeDensity', 'carDensity', 'personDensity',
  ];
  const scaled = { ...furniture };
  for (const key of densityKeys) {
    if (typeof scaled[key] === 'number') {
      scaled[key] = scaled[key] * scale;
    }
  }
  return scaled;
}

function resolveCityShadowClipmap(qualityPreset, qualityLevel) {
  // Clipmap (heavy extra shadow passes) only for Max in city.
  // Ultra (new) behaves like former Medium: no clipmap.
  const disabled = { enabled: false };
  const maxCity = {
    enabled: true,
    // ~1/2 levels, 1/4 texels/level, 1/5 reach vs open-world Ultra → comparable
    // relative savings to disabling clipmap entirely on lower tiers.
    levels: 2,
    mapSize: 1024,
    firstRadius: 18,
    scaleFactor: 3.2,
    maxDistance: 500,
    dynamicLevels: 1,
    updateBudget: 0.25,
    minLevelMapSize: 256,
  };
  return tierPick(qualityLevel, disabled, disabled, disabled, maxCity);
}

/**
 * Return a preset with city-mode overrides applied. Does not mutate the input.
 */
export function applyCityLevelOverrides(qualityPreset, qualityLevel, levelMode) {
  if (!isCityLevelMode(levelMode)) {
    return qualityPreset;
  }

  const env = qualityPreset.environment ?? {};
  const aerialEndBase = env.aerialEnd ?? 1400;
  const aerialOpacityBase = env.aerialMaxOpacity ?? 0.22;
  const shadowClipmap = resolveCityShadowClipmap(qualityPreset, qualityLevel);

  // City streaming + density controls are forced here per label to enact the
  // stepped-down tiers. Base preset radii are ignored for city so that "Ultra"
  // in the UI now delivers old-Medium city density (runnable) while Max
  // recovers the old Ultra load.
  const cityLoadRadius = tierPick(qualityLevel, 1, 1, 1, 2);
  const cityUnloadRadius = tierPick(qualityLevel, 2, 2, 2, 3);
  const cityInitialLoadRadius = 1;
  const cityWorkerCount = tierPick(qualityLevel, 1, 2, 4, 6);
  const cityFurnitureRadius = 1;
  const cityTraversalRadius = 1;
  const citySkylineRadius = tierPick(qualityLevel, 1, 2, 3, 4);
  const cityCastShadows = false;
  const furnitureScale = tierPick(qualityLevel, 0.40, 0.55, 0.72, 0.88);

  const ssao = qualityPreset.ssao?.enabled === true
    ? {
      ...qualityPreset.ssao,
      updateInterval: Math.max(
        qualityPreset.ssao.updateInterval ?? 1,
        tierPick(qualityLevel, 1, 1, 2, 4),
      ),
    }
    : qualityPreset.ssao;

  return {
    ...qualityPreset,
    cityMode: true,
    cityTightCameraFar: true,
    cityCastShadows,
    loadRadius: cityLoadRadius,
    unloadRadius: cityUnloadRadius,
    initialLoadRadius: cityInitialLoadRadius,
    workerCount: cityWorkerCount,
    citySkylineRadius,
    cityFurnitureRadius,
    cityTraversalRadius,
    cityFurniture: scaleCityFurniture(qualityPreset.cityFurniture, furnitureScale),
    // City never uses the sun follow-frustum — clipmap only on Max city.
    shadows: false,
    shadowClipmap,
    environment: {
      ...env,
      aerialPerspective: env.aerialPerspective !== false,
      aerialEnd: Math.round(aerialEndBase * tierPick(qualityLevel, 0.35, 0.42, 0.55, 0.68)),
      aerialMaxOpacity: aerialOpacityBase * tierPick(qualityLevel, 0.75, 0.82, 0.9, 0.96),
    },
    ssao,
  };
}
