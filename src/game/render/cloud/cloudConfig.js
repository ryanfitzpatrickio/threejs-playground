// Configuration for the volumetric cloud + LUT atmosphere system (from sky reference source).
//
// See `volumetric-sky-cloud-analysis.md` for the full algorithm reverse-engineering.
// This file is pure data — no TSL — so it can be read by both CPU setup code and
// the provider facade. The atmosphere math runs in **kilometres** (matching the
// sky reference source constants) regardless of dreamfall's metre-scale gameplay world: the
// sky is a visual backdrop, and the cloud layer is a flat slab sized in metres.

// Physical atmosphere constants (km). Ported verbatim from the sky reference source —
// these are the standard Bruneton-style Earth atmosphere numbers.
export const ATMOSPHERE = {
  EARTH_R_KM: 6371,
  ATMO_R_KM: 6471,
  THICKNESS_KM: 100,
  RAYLEIGH_SCALE_HEIGHT_KM: 8,
  MIE_SCALE_HEIGHT_KM: 1.2,
  RAYLEIGH_BETA_RGB_KM: [0.005802, 0.013558, 0.0331],
  MIE_BETA_BASE_KM: 0.021,
  MIE_EXTINCTION_FACTOR: 1.1,
  TRANSMITTANCE_SAMPLES: 40,
  SKY_MARCH_SAMPLES: 12,
};

// Render-target sizes for the precomputed tables. Transmittance is sampled per
// sky pixel and per cloud-march step, so it gets the higher resolution.
export const LUT_SIZES = {
  transmittance: [256, 64],
  multiscatter: [32, 32],
};

// Default live parameters. The provider copies a subset of these into the
// `cloudUniforms` shared nodes; time-of-day / weather calls mutate them.
export const DEFAULT_ATMOSPHERE_PARAMS = {
  // Slightly lower rayleigh + higher multi-scatter reads as a lighter midday blue
  // (the prior 2.6/0.18 combo leaned deep cobalt at zenith).
  rayleigh: 1.95,
  turbidity: 1.5,
  mieDirectionalG: 0.76,
  mieScatteringStrength: 0.26,
  multipleScattering: 0.22,
  skyMultipleScattering: 0.28,
  groundAlbedo: [0.18, 0.17, 0.15],
};

export const DEFAULT_SUN_PARAMS = {
  // Sky reference source radiance-space intensity (separate from Three's DirectionalLight
  // intensity, which drives the scene lighting). ~6–8 reads as midday.
  intensity: 8.2,
  // Angular soft-disc size (mu falloff). 3e-4 was a pinprick; ~1.6e-3 reads as a
  // wider cinematic disc without washing the whole horizon.
  discSize: 0.0016,
  color: [1, 0.95, 0.85],
};

// Cloud layer + march defaults, scaled for dreamfall's flat, metre-scale world
// and ~320–2400 m draw distance (sky reference source's 4000 m altitude / 29000 m weather
// scale would sit permanently beyond the horizon). Tuned by eye in M2.
// Shape knobs bias toward soft, eroded cumulus rather than hard weather-map blocks.
export const DEFAULT_CLOUD_PARAMS = {
  shape: {
    altitude: 1200,
    thickness: 1800,
    density: 0.02,
    coverage: 0.5,
    edgeSoftness: 0.16,
    edgeSoftnessFalloff: 0.82,
    weatherScale: 4600,
    baseScale: 1300,
    erosionScaleBaseMultiplier: 0.28,
    baseStrength: 0.6,
    erosionStrengthBase: 0.42,
    erosionStrengthPeak: 2.95,
    erosionShape: 1,
    baseWeatherStrength: 0.54,
    baseWeatherHeightStart: 0,
    baseWeatherHeightEnd: 0.13,
  },
  lighting: {
    scatteringAlbedo: 1,
    powderStrength: 0.65,
    ambientIntensity: 0.52,
    baseShadowStrength: 0.88,
    baseShadowHeight: 0.13,
  },
  wind: {
    heading: 181,
    speed: 18,
    evolutionSpeed: 6,
    skew: 420,
  },
};

export const DEFAULT_MARCH_PARAMS = {
  baseStepSize: 18,
  stepConeFactor: 1.5,
  maxSteps: 96,
  maxOpticalDepthPerStep: 0.5,
  earlyExitTransmittance: 0.025,
  lightMarchTaps: 5,
  lightStepSize: 8,
  lightConeSpread: 0.25,
  renderScale: 0.5,
};

// Named cloud-type presets. Each is a *partial* override applied over
// DEFAULT_CLOUD_PARAMS by the provider's `setCloudPreset`, so an entry only
// lists the params that make its morphology distinct. These deliberately vary
// only the live, uniform-backed shape/lighting/wind params (see cloudUniforms.js)
// — never the atmosphere LUT inputs or node-structural knobs (march steps,
// shadow/godray resolution) — so switching cloud type is instant and never
// re-bakes the LUT or rebuilds the render pipeline.
//
// The four `setWeather` states (clear/overcast/fog/rain) are an ORTHOGONAL
// coverage/density modifier layered on top of whichever type is selected: pick
// the cloud *shape* here, pick the *amount* with weather.
export const CLOUD_TYPE_PRESETS = {
  // Balanced partly-cloudy sky — the default look on load. Coverage/density are
  // tuned via the visibility probe (scripts/probe-cloud-visibility.mjs), NOT the
  // raw DEFAULT_CLOUD_PARAMS, which pre-date the weather-map fix and read overcast.
  default: {
    label: 'Balanced (default)',
    shape: { coverage: 0.38, density: 0.024 },
    lighting: {},
    wind: {},
  },
  fair: {
    label: 'Fair-weather cumulus',
    shape: {
      altitude: 950, thickness: 1400, coverage: 0.34, density: 0.028,
      weatherScale: 3600, baseScale: 1200, baseStrength: 0.68,
      erosionStrengthBase: 0.48, erosionStrengthPeak: 3.1, edgeSoftness: 0.14,
      erosionScaleBaseMultiplier: 0.26,
    },
    wind: { heading: 181, speed: 16, evolutionSpeed: 5, skew: 380 },
  },
  cumulus: {
    label: 'Cumulus congestus',
    shape: {
      altitude: 800, thickness: 2600, coverage: 0.38, density: 0.04,
      weatherScale: 4000, baseScale: 1500, baseStrength: 0.72,
      erosionStrengthBase: 0.45, erosionStrengthPeak: 3.0, edgeSoftness: 0.13,
      erosionScaleBaseMultiplier: 0.26,
    },
    wind: { heading: 181, speed: 18, evolutionSpeed: 7, skew: 480 },
  },
  stratocumulus: {
    label: 'Stratocumulus',
    shape: {
      altitude: 700, thickness: 1000, coverage: 0.46, density: 0.038,
      weatherScale: 4400, baseScale: 1800, baseStrength: 0.62,
      erosionStrengthPeak: 2.2, edgeSoftness: 0.15,
    },
    wind: { heading: 181, speed: 14, evolutionSpeed: 4, skew: 340 },
  },
  altocumulus: {
    label: 'Altocumulus (mackerel)',
    shape: {
      altitude: 2600, thickness: 800, coverage: 0.44, density: 0.028,
      weatherScale: 2400, baseScale: 950, baseStrength: 0.55,
      erosionStrengthBase: 0.55, erosionStrengthPeak: 3.0, edgeSoftness: 0.12,
    },
    wind: { heading: 181, speed: 20, evolutionSpeed: 6, skew: 300 },
  },
  stratus: {
    label: 'Overcast stratus',
    shape: {
      altitude: 600, thickness: 700, coverage: 0.8, density: 0.05,
      weatherScale: 9000, baseScale: 2600, baseStrength: 0.35,
      erosionStrengthBase: 0.1, erosionStrengthPeak: 1.0, edgeSoftness: 0.2,
    },
    lighting: { ambientIntensity: 0.4, powderStrength: 0.55 },
    wind: { heading: 181, speed: 10, evolutionSpeed: 3, skew: 220 },
  },
  cirrus: {
    label: 'Cirrus wisps',
    shape: {
      altitude: 4200, thickness: 700, coverage: 0.44, density: 0.012,
      weatherScale: 5200, baseScale: 2400, baseStrength: 0.48,
      erosionStrengthBase: 1.2, erosionStrengthPeak: 3.5, edgeSoftness: 0.18,
    },
    lighting: { ambientIntensity: 0.62, powderStrength: 0.35 },
    // Fast, strongly height-skewed wind stretches the wisps into long streaks.
    wind: { heading: 181, speed: 30, evolutionSpeed: 5, skew: 900 },
  },
  storm: {
    label: 'Cumulonimbus (storm)',
    shape: {
      altitude: 500, thickness: 3800, coverage: 0.68, density: 0.055,
      weatherScale: 6200, baseScale: 1900, baseStrength: 0.78,
      erosionStrengthBase: 0.35, erosionStrengthPeak: 2.6, edgeSoftness: 0.12,
    },
    lighting: { ambientIntensity: 0.34, powderStrength: 0.85 },
    wind: { heading: 181, speed: 24, evolutionSpeed: 9, skew: 560 },
  },
};

export const DEFAULT_CLOUD_TYPE = 'default';

/** `[{ id, label }]` for building a cloud-type selector UI. */
export function listCloudTypePresets() {
  return Object.entries(CLOUD_TYPE_PRESETS).map(([id, preset]) => ({ id, label: preset.label }));
}

/**
 * Resolve a cloud-type preset into a full shape/lighting/wind param set (each
 * preset's partial override merged over DEFAULT_CLOUD_PARAMS). Unknown names
 * fall back to DEFAULT_CLOUD_TYPE.
 */
export function resolveCloudTypePreset(name) {
  const preset = CLOUD_TYPE_PRESETS[name] ?? CLOUD_TYPE_PRESETS[DEFAULT_CLOUD_TYPE];
  return {
    shape: { ...DEFAULT_CLOUD_PARAMS.shape, ...preset.shape },
    lighting: { ...DEFAULT_CLOUD_PARAMS.lighting, ...preset.lighting },
    wind: { ...DEFAULT_CLOUD_PARAMS.wind, ...preset.wind },
  };
}

export const CLOUD_MODES = ['volumetric', 'dome', 'off'];

const CLOUD_MODE_STORAGE_KEY = 'dreamfall:clouds';

export function normalizeCloudMode(mode, fallback = 'dome') {
  return CLOUD_MODES.includes(mode) ? mode : fallback;
}

/** User override from localStorage, or null when unset / invalid. */
export function getCloudModeOverride() {
  try {
    const value = localStorage.getItem(CLOUD_MODE_STORAGE_KEY);
    return CLOUD_MODES.includes(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/** Persist sky/cloud mode (`volumetric` | `dome` | `off`). */
export function setCloudModeOverride(mode) {
  const normalized = normalizeCloudMode(mode);
  try {
    localStorage.setItem(CLOUD_MODE_STORAGE_KEY, normalized);
  } catch (_) {
    // Ignore write failures.
  }
  return normalized;
}

/**
 * Effective cloud mode: localStorage override wins, then quality preset, then dome.
 * @param {object} [qualityPreset]
 */
export function resolveCloudMode(qualityPreset = {}) {
  return normalizeCloudMode(
    getCloudModeOverride() ?? qualityPreset.environment?.clouds,
  );
}

/**
 * Resolve the cloud subsystem config for a quality preset. Returns `null` when
 * volumetric clouds are disabled (`clouds` !== `'volumetric'`). Quality scaling
 * of march steps / resolutions lands in M5; for now this returns the defaults
 * merged with any `volumetricClouds` block on the preset.
 */
export function resolveCloudConfig(qualityPreset, { force = false } = {}) {
  const env = qualityPreset?.environment ?? {};
  if (!force && normalizeCloudMode(env.clouds) !== 'volumetric') return null;
  const vc = env.volumetricClouds ?? {};
  const cloudOverride = env.cloudShape ?? {};
  return {
    atmosphere: {
      ...DEFAULT_ATMOSPHERE_PARAMS,
      ...env.cloudAtmosphere,
      ...(env.rayleigh != null ? { rayleigh: env.rayleigh } : {}),
      ...(env.turbidity != null ? { turbidity: env.turbidity } : {}),
      ...(env.mieDirectionalG != null ? { mieDirectionalG: env.mieDirectionalG } : {}),
    },
    sun: { ...DEFAULT_SUN_PARAMS, ...env.cloudSun },
    cloud: {
      shape: {
        ...DEFAULT_CLOUD_PARAMS.shape,
        ...(cloudOverride.shape ?? cloudOverride),
        ...(vc.coverage == null ? {} : { coverage: vc.coverage }),
        ...(vc.density == null ? {} : { density: vc.density }),
      },
      lighting: { ...DEFAULT_CLOUD_PARAMS.lighting, ...cloudOverride.lighting },
      wind: { ...DEFAULT_CLOUD_PARAMS.wind, ...cloudOverride.wind },
    },
    march: { ...DEFAULT_MARCH_PARAMS, ...vc },
    volumetric: vc,
  };
}
