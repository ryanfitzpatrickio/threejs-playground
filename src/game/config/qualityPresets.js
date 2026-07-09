// Quality presets for Dreamfall. Each system reads from the active preset at
// init time. Changing quality requires a page reload (the fog shader's loop
// count is baked at pipeline compilation).
//
// Camera far / scene fog / height-fog maxDistance are derived from the
// loadRadius values so the draw distance always reaches loaded chunks.

const PRESETS = {
  high: {
    // RendererSystem
    maxPixelRatio: 2,
    antialias: true,
    fogEnabled: false,
    fogMarchSteps: 16,
    ssr: {
      enabled: true,
      resolutionScale: 0.5,
      quality: 0.35,
      maxDistance: 32,
      thickness: 0.18,
      intensity: 0.55,
      screenEdgeFade: 0.16,
    },
    ssao: {
      enabled: true,
      // AO is a low-frequency effect; it renders below full res to save fill.
      // 0.5 + depth-aware blur keeps large outdoor planes free of sample grid.
      // Half-float normal pre-pass (see RendererSystem) avoids U8 contour bands.
      resolutionScale: 0.5,
      samples: 12,
      radius: 1.25,
      // Keep contact AO readable without washing open ground with residual noise.
      intensity: 1.9,
      // Suppress heightfield / near-flat self-occlusion that reads as mesh grid.
      bias: 0.055,
      blur: true,
      // Lower than SSAONode default (2) so the bilateral blur bleeds more on
      // continuous ground and hides remaining half-res sample structure.
      blurSharpness: 0.9,
      // The normal/depth pre-pass is a full CPU-side scene traversal. Reuse AO
      // for one frame on High as well as Ultra; the low-frequency result is
      // visually stable while halving the dominant office-interior pre-pass cost.
      updateInterval: 2,
    },
    // Office-interior overrides (applied live on building entry via RendererSystem).
    // The SSAO normal/depth pre-pass is a second full scene traversal; dense
    // instanced furniture makes it the dominant interior cost (~7 ms in traces).
    interior: {
      maxPixelRatio: 1.5,
      ssao: { enabled: false },
      parallaxOcclusion: { enabled: false },
    },
    // Parallax occlusion mapping (per-fragment height-field raymarch) for rally
    // road surfaces. Off on low/high — it is ultra-only fragment work, gated like
    // SSAO. See docs/silhouette-pom-plan.md.
    parallaxOcclusion: { enabled: false },
    // Rally wet roads (docs/advanced-wet-roads-plan.md). Persistent puddles + sky
    // PMREM reflections inside standing water. Off on low.
    wetRoads: {
      enabled: true,
      wetness: 0.6,
      reflections: { envIntensity: 1.0, fresnel: true },
      puddles: { coverage: 0.34, edge: 0.06, lowSpotBias: 0.25 },
      // Geometric tread + puddles pooling in grooves (default on).
      // sinkScale multiplies MUD_VISUAL_SINK (~0.18 m) → ~10 cm wet groove.
      tread: { enabled: true, sinkScale: 0.55 },
    },
    terrainHextile: {
      enabled: true,
      falloffContrast: 0.6,
      exponent: 7,
      roadRotStrength: 0.35,
      roadExponent: 2,
    },
    environment: {
      toneMapping: 'ACESFilmic',
      exposure: 1.0,
      timeOfDay: 0.72,
      turbidity: 3.2,
      rayleigh: 1.7,
      mieCoefficient: 0.006,
      mieDirectionalG: 0.82,
      sunIntensity: 4.2,
      sunDiscIntensity: 0.06,
      // Hemisphere = ground-bounce fill only; sky diffuse comes from the env map.
      // Stacking both at full strength washed shadows toward a milky 1:2 ambient:direct
      // ratio; V-Rally-style exteriors read closer to 1:5.
      hemisphereIntensity: 0.5,
      environmentMapSize: 128,
      environmentIntensity: 0.45,
      weather: 'clear',
      aerialPerspective: true,
      aerialStart: 550,
      aerialEnd: 1700,
      aerialMaxOpacity: 0.24,
      // Neutral cool-grey path haze (not zenith blue) so distant ground greys out.
      aerialHazeColor: [0.58, 0.60, 0.62],
      terrainAerial: {
        // Late fade (start/end fractions live in syncTerrainViewDistance).
        desat: 0.55,
        contrast: 0.35,
        strength: 0.85,
      },
      // Default sky is the simple SkyMesh dome-cloud layer on low/high. Ultra
      // uses volumetric LUT sky + raymarched clouds unless overridden in Settings
      // (localStorage `dreamfall:clouds`). The volumetricClouds block below
      // drives march quality when volumetric is active.
      clouds: 'dome',
      cloudCoverage: 0.5,
      cloudDensity: 0.88,
      volumetricClouds: {
        renderScale: 0.5,
        marchSteps: 96,
        maxMarchDist: 18000,
        reachScale: 2.1,
        fadeStart: 0.52,
        fadeEnd: 0.94,
        lightTaps: 5,
        shadowResolution: 512,
        godRays: false,
        baseShapeDims: 32,
        weatherMapResolution: 512,
        shadowSteps: 12,
        shadowExtent: 3200,
        coverage: 0.5,
        density: 0.02,
      },
      bloom: true,
      bloomStrength: 0.035,
      bloomRadius: 0.14,
      bloomThreshold: 2.4,
      bloomResolutionScale: 0.25,
      saturation: 1.02,
      vibrance: 0.035,
      dynamicDay: false,
      dayLengthSeconds: 900,
    },

    exteriorDistanceFog: true,
    terrainHorizon: true,
    terrainHorizonLayers: 1,
    // Infinite-terrain faux forest: layered tree-break silhouettes + streaming
    // low-poly blobs that fill the ground↔sky grey band and hold up when driving out.
    // Infinite terrain: SeedThree prairie shelterbelts (linear field-edge breaks).
    distantForest: true,
    distantForestNearCount: 48,
    distantForestNearRadius: 110,
    distantForestFarRadius: 420,
    distantForestHeroCount: 10,
    distantForestHeroRadius: 45,
    distantForestPoolSize: 300,
    // Fraction of field edges that get a tree break (higher = more belts).
    distantForestDensity: 0.75,
    distantForestFieldSpacing: 150,
    distantForestTreeSpacing: 7.5,
    distantForestSpecies: 'pine',

    // SceneSystem
    shadows: false,
    shadowMapSize: 512,
    shadowFrustumHalf: 14,
    shadowFar: 42,
    // Cached clipmap directional shadows (long range for the open world).
    shadowClipmap: {
      // Disabled until the custom shadow pass can reject UV-dependent
      // materials safely; the standard camera-following sun shadow is stable.
      enabled: false,
      mapSize: 1024,
      firstRadius: 12,
      scaleFactor: 3.0,
      maxDistance: 1500,
      levels: 5,
      dynamicLevels: 1,
      updateBudget: 1,
    },

    forestRealTrees: true,
    forestLodMode: 'blend',
    forestTreeBudget: 8000,
    forestNearCount: 200,
    forestNearRadius: 145,
    forestFarRadius: 480,
    forestHeroCount: 6,
    forestHeroRadius: 30,
    forestFoliageShadows: false,

    // InfiniteCityLevel streaming
    initialLoadRadius: 1,
    loadRadius: 1,
    unloadRadius: 2,
    workerCount: 4,
    citySkylineRadius: 5,
    cityFurnitureRadius: 1,
    cityTraversalRadius: 1,
    cityFurniture: {
      streetlight: true, trafficlight: true, trashcan: true, hydrant: true,
      bench: true, tree: true, car: true, person: false,
      streetlightDensity: 0.75, trafficlightDensity: 1, trashcanDensity: 0.75,
      hydrantDensity: 0.75, benchDensity: 0.6, treeDensity: 0.7,
      carDensity: 0.65, personDensity: 0,
    },

    // Streaming terrain: dense near field plus cheaper outer LOD rings.
    terrainLoadRadius: 7,
    terrainUnloadRadius: 8,
    terrainLodRings: [2, 4],
    terrainLodResolutions: [33, 17, 9],
    terrainMacroDetail: { enabled: true, colorStrength: 0.08, frequency: 0.0045 },

    // WeatherSystem — max rain drop instances (a single InstancedMesh draw
    // call regardless of count; setIntensity can scale down live).
    rainMaxDrops: 12000,

    // EnemyCutSystem
    maxCutProps: 56,
    destructiblePropMaxCutProps: 40,
    staticCutPropLifetime: 9,
    rigRagdollPropLifetime: 24,
    destructiblePropCutLifetime: 45,
    cutColliderMode: 'hull',
  },

  low: {
    // RendererSystem
    maxPixelRatio: 1,
    antialias: false,
    fogEnabled: false,
    fogMarchSteps: 6,
    ssr: { enabled: false },
    ssao: { enabled: false },
    parallaxOcclusion: { enabled: false },
    wetRoads: { enabled: false },
    terrainHextile: { enabled: false },
    environment: {
      toneMapping: 'ACESFilmic',
      exposure: 1.0,
      timeOfDay: 0.72,
      turbidity: 3.2,
      rayleigh: 1.7,
      mieCoefficient: 0.006,
      mieDirectionalG: 0.82,
      sunIntensity: 4.2,
      sunDiscIntensity: 0.06,
      hemisphereIntensity: 0.5,
      environmentMapSize: 64,
      environmentIntensity: 0.45,
      weather: 'clear',
      aerialPerspective: true,
      aerialStart: 420,
      aerialEnd: 820,
      aerialMaxOpacity: 0.2,
      aerialHazeColor: [0.56, 0.58, 0.60],
      terrainAerial: {
        desat: 0.58,
        contrast: 0.36,
      },
      clouds: 'dome',
      cloudCoverage: 0.46,
      cloudDensity: 0.82,
      bloom: false,
      saturation: 1.0,
      vibrance: 0.02,
      dynamicDay: false,
      dayLengthSeconds: 900,
    },

    exteriorDistanceFog: true,
    terrainHorizon: false,
    terrainHorizonLayers: 0,
    terrainMacroDetail: { enabled: false },
    distantForest: false,

    // SceneSystem
    shadows: false,
    shadowMapSize: 256,
    shadowFrustumHalf: 10,
    shadowFar: 30,
    // Clipmap shadows are the dominant GPU cost in city mode (extra full-scene
    // shadow-map passes every frame). Low disables them entirely; distant
    // buildings read fine with hemisphere + aerial perspective only.
    shadowClipmap: {
      enabled: false,
    },

    // Wilds scene — fewer trees so LQ loads faster.
    wildsForestCount: 120000,

    // Forest zones — real trees with a tight near→impostor blend.
    forestRealTrees: true,
    forestLodMode: 'blend',
    forestTreeBudget: 2500,
    forestNearCount: 45,
    forestNearRadius: 48,
    forestFarRadius: 220,
    forestHeroCount: 12,
    forestHeroRadius: 42,
    forestFoliageShadows: false,

    // InfiniteCityLevel streaming
    loadRadius: 1,
    unloadRadius: 2,
    workerCount: 2,
    citySkylineRadius: 2,
    cityFurnitureRadius: 1,
    cityTraversalRadius: 1,
    cityFurniture: {
      streetlight: true, trafficlight: true, trashcan: true, hydrant: true,
      bench: true, tree: true, car: false, person: false,
      streetlightDensity: 0.5, trafficlightDensity: 1, trashcanDensity: 0.5,
      hydrantDensity: 0.5, benchDensity: 0.35, treeDensity: 0.4,
      carDensity: 0, personDensity: 0,
    },

    terrainLoadRadius: 5,
    terrainUnloadRadius: 6,
    terrainLodRings: [1, 3],
    terrainLodResolutions: [17, 9, 5],

    // WeatherSystem
    rainMaxDrops: 4000,

    // EnemyCutSystem
    maxCutProps: 28,
    destructiblePropMaxCutProps: 20,
    staticCutPropLifetime: 5,
    rigRagdollPropLifetime: 12,
    destructiblePropCutLifetime: 30,
    cutColliderMode: 'compound',
  },
};

// Ultra deliberately raises spatial resolution and world density while keeping
// the five clipmap textures used by High. A sixth level would push terrain plus
// clipmap sampling beyond Metal's practical fragment-stage sampler budget.
PRESETS.ultra = {
  ...PRESETS.high,
  // Above 2x, every full-screen target grows quadratically while the visual
  // improvement is marginal on normal-density displays. More importantly for
  // WebGPU, those larger passes amplify GPU-process command/transfer pressure.
  maxPixelRatio: 2,
  antialias: true,
  fogMarchSteps: 12,
  ssr: {
    ...PRESETS.high.ssr,
    resolutionScale: 0.5,
    quality: 0.35,
    maxDistance: 48,
    binaryRefine: true,
  },
  ssao: {
    ...PRESETS.high.ssao,
    resolutionScale: 0.5,
    samples: 12,
    intensity: 2.2,
    blur: true,
    blurSharpness: 1.0,
    // Every other frame when the view is static; camera motion forces a refresh
    // (see RendererSystem AO gate) so screen-space AO does not ghost while moving.
    updateInterval: 2,
  },
  // Ultra-only: raymarched relief on rally dirt/mud roads. maxLayers is baked
  // into the shader's loop bound at compile time (it cannot be faded at runtime),
  // so the material distance-fades the relief `scale` toward 0 instead. `scale`
  // is relief depth in UV units (rally UV ≈ 1/3.2 per metre, so 0.02 ≈ 6 cm).
  parallaxOcclusion: {
    enabled: true,
    terrain: true,
    scale: 0.05,
    terrainScale: 0.028,
    minLayers: 8,
    maxLayers: 24,
  },
  terrainMacroDetail: { enabled: true, colorStrength: 0.14, frequency: 0.0045 },
  terrainHorizonLayers: 2,
  distantForest: true,
  distantForestNearCount: 64,
  distantForestNearRadius: 130,
  distantForestFarRadius: 520,
  distantForestHeroCount: 14,
  distantForestHeroRadius: 55,
  distantForestPoolSize: 400,
  distantForestDensity: 0.82,
  distantForestFieldSpacing: 140,
  distantForestTreeSpacing: 7,
  distantForestSpecies: 'pine',
  terrainCloudShadow: true,
  environment: {
    ...PRESETS.high.environment,
    // Bloom is multiple full-screen passes. Keep Ultra's scene/detail quality,
    // but remove this command-heavy post branch from the gameplay hot path.
    bloom: false,
    environmentMapSize: 256,
    aerialEnd: 1900,
    aerialMaxOpacity: 0.26,
    aerialHazeColor: [0.56, 0.58, 0.62],
    cloudAtmosphere: {
      rayleigh: 1.9,
      turbidity: 1.45,
      mieDirectionalG: 0.76,
      mieScatteringStrength: 0.24,
      skyMultipleScattering: 0.28,
      multipleScattering: 0.22,
    },
    cloudSun: {
      discSize: 0.0016,
      intensity: 8.0,
    },
    cloudType: 'fair',
    terrainAerial: {
      desat: 0.58,
      contrast: 0.38,
      strength: 0.85,
    },
    cloudCoverage: 0.5,
    cloudDensity: 0.88,
    clouds: 'volumetric',
      volumetricClouds: {
      ...PRESETS.high.environment.volumetricClouds,
      marchSteps: 96,
      maxMarchDist: 18000,
      reachScale: 2.1,
        fadeStart: 0.52,
        fadeEnd: 0.94,
      lightTaps: 5,
      shadowResolution: 1024,
      godRays: true,
      godRaySteps: 24,
      baseShapeDims: 64,
        weatherMapResolution: 1024,
        shadowSteps: 16,
        shadowExtent: 4200,
        coverage: 0.34,
        density: 0.024,
    },
  },
  shadows: true,
  shadowMapSize: 2048,
  shadowFrustumHalf: 20,
  shadowFar: 72,
  shadowClipmap: {
    ...PRESETS.high.shadowClipmap,
    // The custom multi-level pass currently emits invalid UV-dependent shadow
    // pipelines for mixed rally/forest geometry and visible clipmap seams.
    // Fall back to the stable camera-following directional shadow map.
    enabled: false,
    mapSize: 2048,
    firstRadius: 14,
    scaleFactor: 3.2,
    maxDistance: 2400,
    levels: 5,
    dynamicLevels: 1,
    // Fractional: one cached-level re-render every other frame. At speed the
    // texel-snap thresholds trip continuously, so budget 1 meant a full cached
    // level (hundreds of draws) re-rendered EVERY frame (~5.6 ms/frame CPU in
    // the 2026-07 trace). The dynamic near level still updates every frame.
    updateBudget: 0.5,
  },
  loadRadius: 2,
  initialLoadRadius: 1,
  unloadRadius: 3,
  workerCount: 6,
  citySkylineRadius: 7,
  cityFurnitureRadius: 1,
  cityTraversalRadius: 1,
  cityFurniture: {
    ...PRESETS.high.cityFurniture,
    streetlightDensity: 1,
    trashcanDensity: 1,
    hydrantDensity: 1,
    benchDensity: 1,
    treeDensity: 1,
    carDensity: 1,
  },
  wildsForestCount: 650000,
  forestRealTrees: true,
  forestLodMode: 'blend',
  forestTreeBudget: 24000,
  forestNearCount: 64,
  forestNearRadius: 140,
  forestFarRadius: 560,
  forestHeroCount: 24,
  forestHeroRadius: 70,
  forestFoliageShadows: false,
  rainMaxDrops: 20000,
  terrainLoadRadius: 10,
  terrainUnloadRadius: 11,
  terrainLodRings: [2, 4, 6],
  terrainLodResolutions: [33, 17, 9, 5],
  maxCutProps: 80,
  destructiblePropMaxCutProps: 64,
  staticCutPropLifetime: 12,
  rigRagdollPropLifetime: 32,
  destructiblePropCutLifetime: 60,
  cutColliderMode: 'hull',
};

// Max recovers the prior Ultra preset values. In city mode the cityPerformance
// overrides deliberately step Ultra down (to old Medium) while Max retains the
// old Ultra city density.
PRESETS.max = {
  ...PRESETS.ultra,
};

const STORAGE_KEY = 'dreamfall:quality';
const TONE_MAPPING_STORAGE_KEY = 'dreamfall:tone-mapping';
const POST_EFFECT_STORAGE_KEY = 'dreamfall:post-effect';

export const POST_EFFECT_MODES = ['ssao', 'ssr', 'off'];

/** Clamp an arbitrary stored/user value to a valid post-effect mode. */
export function normalizePostEffectMode(mode) {
  return POST_EFFECT_MODES.includes(mode) ? mode : 'ssao';
}

/** Read the persisted post-effect mode (`ssao` | `ssr` | `off`), defaulting to `ssao`. */
export function getPostEffectMode() {
  try {
    return normalizePostEffectMode(localStorage.getItem(POST_EFFECT_STORAGE_KEY));
  } catch (_) {
    return 'ssao';
  }
}

/** Persist the post-effect mode to localStorage. */
export function setPostEffectMode(mode) {
  const normalized = normalizePostEffectMode(mode);
  try {
    localStorage.setItem(POST_EFFECT_STORAGE_KEY, normalized);
  } catch (_) {
    // Ignore write failures.
  }
  return normalized;
}

/**
 * Resolve the mode the pipeline actually runs for a preset. The stored
 * preference is kept as-is; presets that disable an effect (Low disables both
 * SSAO and SSR) run `off` instead. SSAO and SSR are never active together.
 */
export function resolveEffectivePostEffectMode(mode, qualityPreset = {}) {
  const requested = normalizePostEffectMode(mode);
  if (requested === 'ssao' && qualityPreset.ssao?.enabled !== true) return 'off';
  if (requested === 'ssr' && qualityPreset.ssr?.enabled !== true) return 'off';
  return requested;
}

/** Read the persisted quality level, defaulting to medium (`high` storage key). Supports low/high/ultra/max. */
export function getQualityLevel() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'low' || stored === 'high' || stored === 'ultra' || stored === 'max') {
      return stored;
    }
  } catch (_) {
    // localStorage unavailable (e.g. iframe sandbox).
  }
  return 'high';
}

/** Persist the quality level to localStorage. */
export function setQualityLevel(level) {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch (_) {
    // Ignore write failures.
  }
}

export function getToneMappingMode() {
  try {
    return localStorage.getItem(TONE_MAPPING_STORAGE_KEY) === 'AgX' ? 'AgX' : 'ACESFilmic';
  } catch (_) {
    return 'ACESFilmic';
  }
}

export function setToneMappingMode(mode) {
  const normalized = mode === 'AgX' ? 'AgX' : 'ACESFilmic';
  try {
    localStorage.setItem(TONE_MAPPING_STORAGE_KEY, normalized);
  } catch (_) {
    // Ignore write failures.
  }
  return normalized;
}

/** Return the full preset object for the given level. */
export function getQualityPreset(level) {
  return PRESETS[level] ?? PRESETS.high;
}

/**
 * Merge scene-context overrides (office interior) onto a base quality preset.
 * @param {object} qualityPreset
 * @param {'exterior' | 'interior'} sceneContext
 */
export function mergeQualityPresetForScene(qualityPreset = {}, sceneContext = 'exterior') {
  if (sceneContext !== 'interior') return qualityPreset;
  const interior = qualityPreset.interior ?? {};
  return {
    ...qualityPreset,
    maxPixelRatio: interior.maxPixelRatio ?? qualityPreset.maxPixelRatio,
    ssao: interior.ssao
      ? { ...qualityPreset.ssao, ...interior.ssao }
      : qualityPreset.ssao,
    parallaxOcclusion: interior.parallaxOcclusion
      ? { ...qualityPreset.parallaxOcclusion, ...interior.parallaxOcclusion }
      : qualityPreset.parallaxOcclusion,
  };
}

// Chunk sizes used for draw distance computation (must match the streaming levels).
const CITY_CHUNK_STRIDE_X = 284;
const CITY_CHUNK_STRIDE_Z = 224;
const TERRAIN_CHUNK_SIZE = 32;

/**
 * Compute a camera far plane that reaches the geometry available in the
 * currently loaded chunks for the given quality preset's load radii.
 */
export function getRecommendedCameraFar(qualityPreset = {}) {
  // Use unload/load radii (actual streamed geometry). Skyline impostors are a
  // separate far-field layer and must not inflate the camera far plane — doing
  // so was drawing/sorting out to ~1.5 km on Low while only 3×3 detail chunks
  // were loaded (~600 m reach).
  const detailR = qualityPreset.unloadRadius
    ?? qualityPreset.loadRadius
    ?? 2;
  const skylineR = qualityPreset.citySkylineRadius ?? detailR;
  // City mode keeps the far plane on loaded detail; skyline impostors use a
  // separate (already reduced) radius. Open world still extends for skyline.
  const cityR = qualityPreset.cityTightCameraFar === true
    ? detailR
    : Math.max(detailR, skylineR);
  const terrainR = qualityPreset.terrainUnloadRadius ?? qualityPreset.terrainLoadRadius ?? 3;

  const cityCenterDist = cityR * Math.max(CITY_CHUNK_STRIDE_X, CITY_CHUNK_STRIDE_Z);
  const terrainCenterDist = terrainR * TERRAIN_CHUNK_SIZE;

  const cityHalfDiag = Math.hypot(CITY_CHUNK_STRIDE_X, CITY_CHUNK_STRIDE_Z) * 0.5;
  const terrainHalfDiag = (TERRAIN_CHUNK_SIZE * 0.5) * Math.SQRT2;

  const maxLoadedReach = Math.max(
    cityCenterDist + cityHalfDiag,
    terrainCenterDist + terrainHalfDiag
  );

  // Add headroom for chase-camera offsets, vehicle speed lookahead, parallax
  // horizon fakes (P2), and to avoid popping right at the load/unload edge.
  return Math.ceil(maxLoadedReach * 1.18);
}

/**
 * Derive scene (distance) fog distances from the loaded chunk reach.
 */
export function getRecommendedSceneFog(qualityPreset = {}) {
  const camFar = getRecommendedCameraFar(qualityPreset);
  // Fog starts later (as fraction of reach) to preserve visibility out to loaded data.
  const near = Math.max(80, Math.floor(camFar * 0.18));
  const far = Math.floor(camFar * 0.78);
  return { near, far };
}

/**
 * Derive a reasonable max distance for the height/volumetric fog marcher.
 */
export function getRecommendedFogMaxDistance(qualityPreset = {}) {
  const camFar = getRecommendedCameraFar(qualityPreset);
  return Math.min(Math.floor(camFar * 0.3), 480);
}
