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
      // 0.4 (inherited by medium + ultra) trades a little AO sharpness for GPU
      // headroom. Lower further (0.33/0.25) if more perf is needed; below ~0.33
      // with blur:false + 8 samples starts to read as dithered noise.
      resolutionScale: 0.4,
      samples: 8,
      radius: 1.5,
      intensity: 4,
      blur: false,
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
      hemisphereIntensity: 1.6,
      environmentMapSize: 128,
      environmentIntensity: 0.72,
      weather: 'clear',
      aerialPerspective: true,
      aerialStart: 180,
      aerialEnd: 1400,
      aerialMaxOpacity: 0.52,
      // Default sky is the simple SkyMesh dome-cloud layer. The experimental
      // volumetric pipeline (CloudSkyProvider) is opt-in via the debug panel
      // checkbox (localStorage `dreamfall:clouds` = 'volumetric'); the
      // volumetricClouds config below still drives it when enabled.
      clouds: 'dome',
      cloudCoverage: 0.5,
      cloudDensity: 0.88,
      volumetricClouds: {
        renderScale: 0.5,
        marchSteps: 96,
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

    // SceneSystem
    shadows: false,
    shadowMapSize: 512,
    shadowFrustumHalf: 14,
    shadowFar: 42,
    // Cached clipmap directional shadows (long range for the open world).
    shadowClipmap: {
      mapSize: 1024,
      firstRadius: 12,
      scaleFactor: 3.0,
      maxDistance: 1500,
      levels: 5,
      dynamicLevels: 1,
      updateBudget: 1,
    },

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
      hemisphereIntensity: 1.6,
      environmentMapSize: 64,
      environmentIntensity: 0.72,
      weather: 'clear',
      aerialPerspective: true,
      aerialStart: 150,
      aerialEnd: 900,
      aerialMaxOpacity: 0.48,
      clouds: 'dome',
      cloudCoverage: 0.46,
      cloudDensity: 0.82,
      bloom: false,
      saturation: 1.0,
      vibrance: 0.02,
      dynamicDay: false,
      dayLengthSeconds: 900,
    },

    // SceneSystem
    shadows: false,
    shadowMapSize: 256,
    shadowFrustumHalf: 10,
    shadowFar: 30,
    // Cheaper clipmap: smaller maps, fewer/coarser levels, one dynamic level.
    shadowClipmap: {
      mapSize: 512,
      firstRadius: 16,
      scaleFactor: 3.2,
      maxDistance: 800,
      levels: 4,
      dynamicLevels: 1,
      updateBudget: 1,
    },

    // Wilds scene — fewer trees so LQ loads faster.
    wildsForestCount: 120000,

    // InfiniteCityLevel streaming
    loadRadius: 1,
    unloadRadius: 2,
    workerCount: 2,
    citySkylineRadius: 4,
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
  maxPixelRatio: 3,
  antialias: true,
  fogMarchSteps: 24,
  ssr: {
    ...PRESETS.high.ssr,
    resolutionScale: 0.75,
    quality: 0.5,
    maxDistance: 48,
    binaryRefine: true,
  },
  ssao: {
    ...PRESETS.high.ssao,
    samples: 12,
    // AO every other frame: its normal/depth pre-pass is a full CPU-side scene
    // re-render (~7 ms/frame at ultra draw counts — the single biggest main
    // thread cost in the 2026-07 trace). AO is low-frequency ambient shading;
    // one frame of staleness is invisible and this halves the cost.
    updateInterval: 2,
  },
  environment: {
    ...PRESETS.high.environment,
    environmentMapSize: 256,
    aerialEnd: 1800,
    cloudCoverage: 0.5,
    cloudDensity: 0.88,
      volumetricClouds: {
      ...PRESETS.high.environment.volumetricClouds,
      marchSteps: 128,
      lightTaps: 6,
      shadowResolution: 1024,
      godRays: true,
      godRaySteps: 24,
      baseShapeDims: 64,
        weatherMapResolution: 1024,
        shadowSteps: 16,
        shadowExtent: 4200,
        coverage: 0.54,
        density: 0.021,
    },
  },
  shadows: true,
  shadowMapSize: 2048,
  shadowFrustumHalf: 20,
  shadowFar: 72,
  shadowClipmap: {
    ...PRESETS.high.shadowClipmap,
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
  rainMaxDrops: 20000,
  terrainLoadRadius: 10,
  terrainUnloadRadius: 11,
  terrainLodRings: [3, 6],
  terrainLodResolutions: [33, 25, 13],
  maxCutProps: 80,
  destructiblePropMaxCutProps: 64,
  staticCutPropLifetime: 12,
  rigRagdollPropLifetime: 32,
  destructiblePropCutLifetime: 60,
  cutColliderMode: 'hull',
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

/** Read the persisted quality level, defaulting to medium (`high` storage key). */
export function getQualityLevel() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'low' || stored === 'high' || stored === 'ultra') {
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

// Chunk sizes used for draw distance computation (must match the streaming levels).
const CITY_CHUNK_STRIDE_X = 284;
const CITY_CHUNK_STRIDE_Z = 224;
const TERRAIN_CHUNK_SIZE = 32;

/**
 * Compute a camera far plane that reaches the geometry available in the
 * currently loaded chunks for the given quality preset's load radii.
 */
export function getRecommendedCameraFar(qualityPreset = {}) {
  // Use unload radii when present (these define the actually-kept loaded chunks);
  // fall back to load radii.
  const cityR = qualityPreset.citySkylineRadius
    ?? qualityPreset.unloadRadius
    ?? qualityPreset.loadRadius
    ?? 2;
  const terrainR = qualityPreset.terrainUnloadRadius ?? qualityPreset.terrainLoadRadius ?? 3;

  const cityCenterDist = cityR * Math.max(CITY_CHUNK_STRIDE_X, CITY_CHUNK_STRIDE_Z);
  const terrainCenterDist = terrainR * TERRAIN_CHUNK_SIZE;

  const cityHalfDiag = Math.hypot(CITY_CHUNK_STRIDE_X, CITY_CHUNK_STRIDE_Z) * 0.5;
  const terrainHalfDiag = (TERRAIN_CHUNK_SIZE * 0.5) * Math.SQRT2;

  const maxLoadedReach = Math.max(
    cityCenterDist + cityHalfDiag,
    terrainCenterDist + terrainHalfDiag
  );

  // Add headroom for chase-camera offsets, vehicle speed lookahead, and
  // to avoid popping right at the load/unload edge.
  return Math.ceil(maxLoadedReach * 1.15);
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
  return Math.min(Math.floor(camFar * 0.28), 450);
}
