/**
 * City-mode performance overrides. Open-world modes (world / wilds / rally) keep
 * the raw quality preset; pure city mode applies tier-scaled cuts so Low / Med /
 * Ultra each recover a similar fraction of frame time in dense downtown.
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

const TIER_INDEX = { low: 0, high: 1, ultra: 2 };

function tierIndex(qualityLevel) {
  return TIER_INDEX[qualityLevel] ?? TIER_INDEX.high;
}

/** Per-tier value: low → high (medium) → ultra. */
function tierPick(qualityLevel, low, high, ultra) {
  const i = tierIndex(qualityLevel);
  return i === 0 ? low : i === 1 ? high : ultra;
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
  // Low + Med: clipmap off in city (same absolute win as the Low-only pass).
  const disabled = { enabled: false };
  const ultraCity = {
    enabled: true,
    // ~1/2 levels, 1/4 texels/level, 1/5 reach vs open-world Ultra → comparable
    // relative savings to disabling clipmap entirely on Low/Med.
    levels: 2,
    mapSize: 1024,
    firstRadius: 18,
    scaleFactor: 3.2,
    maxDistance: 500,
    dynamicLevels: 1,
    updateBudget: 0.25,
    minLevelMapSize: 256,
  };
  return tierPick(qualityLevel, disabled, disabled, ultraCity);
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
  const clipmapOn = shadowClipmap.enabled === true;

  const citySkylineRadius = tierPick(qualityLevel, 2, 3, 4);
  const cityCastShadows = false;
  const furnitureScale = tierPick(qualityLevel, 0.55, 0.72, 0.88);

  const ssao = qualityPreset.ssao?.enabled === true
    ? {
      ...qualityPreset.ssao,
      updateInterval: Math.max(
        qualityPreset.ssao.updateInterval ?? 1,
        tierPick(qualityLevel, 1, 2, 3),
      ),
    }
    : qualityPreset.ssao;

  return {
    ...qualityPreset,
    cityMode: true,
    cityTightCameraFar: true,
    cityCastShadows,
    citySkylineRadius,
    cityFurniture: scaleCityFurniture(qualityPreset.cityFurniture, furnitureScale),
    // City never uses the sun follow-frustum — clipmap only on Ultra city, and
    // that path is already a full-scene shadow pass per active level.
    shadows: false,
    shadowClipmap,
    environment: {
      ...env,
      aerialPerspective: env.aerialPerspective !== false,
      aerialEnd: Math.round(aerialEndBase * tierPick(qualityLevel, 0.42, 0.55, 0.68)),
      aerialMaxOpacity: aerialOpacityBase * tierPick(qualityLevel, 0.82, 0.9, 0.96),
    },
    ssao,
  };
}
