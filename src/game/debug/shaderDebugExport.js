/**
 * Clipboard formatters for promoting shader-debug values into source presets.
 *
 * Targets shapes used by cloudConfig.js (CLOUD_TYPE_PRESETS / DEFAULT_CLOUD_PARAMS),
 * atmosphere/sun blocks, and ad-hoc override maps.
 *
 * See docs/tsl-shader-debug-tweaking-plan.md Appendix D.
 */

import {
  getShaderDebugSnapshot,
  setShaderDebugExportImpl,
} from './shaderDebugRegistry.js';

function val(snap, id, fallback = undefined) {
  const entry = snap.params?.[id];
  if (!entry || entry.value === undefined || entry.value === null) return fallback;
  return entry.value;
}

function roundNum(n, digits = 4) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function roundDeep(v, digits = 4) {
  if (typeof v === 'number') return roundNum(v, digits);
  if (Array.isArray(v)) return v.map((x) => roundDeep(x, digits));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = roundDeep(x, digits);
    return out;
  }
  return v;
}

function fmt(obj, name = 'AUTHORED') {
  return `// dreamfall shader-debug export — paste into cloudConfig / presets\nexport const ${name} = ${JSON.stringify(roundDeep(obj), null, 2)};\n`;
}

/**
 * Map live registry ids → DEFAULT_CLOUD_PARAMS.shape field names.
 * erosionScale is stored absolute; export also derives erosionScaleBaseMultiplier
 * when baseScale is available.
 */
export function buildCloudShapeExport(snap = getShaderDebugSnapshot()) {
  const baseScale = val(snap, 'clouds.baseScale');
  const erosionScale = val(snap, 'clouds.erosionScale');
  const shape = {
    altitude: val(snap, 'clouds.altitude'),
    thickness: val(snap, 'clouds.thickness'),
    coverage: val(snap, 'clouds.coverage'),
    density: val(snap, 'clouds.density'),
    weatherScale: val(snap, 'clouds.weatherScale'),
    baseScale,
    baseStrength: val(snap, 'clouds.baseStrength'),
    erosionStrengthBase: val(snap, 'clouds.erosionStrengthBase'),
    erosionStrengthPeak: val(snap, 'clouds.erosionStrengthPeak'),
    erosionShape: val(snap, 'clouds.erosionShape'),
    edgeSoftness: val(snap, 'clouds.edgeSoftness'),
    edgeSoftnessFalloff: val(snap, 'clouds.edgeSoftnessFalloff'),
  };
  if (
    typeof baseScale === 'number'
    && baseScale > 0
    && typeof erosionScale === 'number'
  ) {
    shape.erosionScaleBaseMultiplier = roundNum(erosionScale / baseScale, 4);
  }
  // Drop undefined keys
  for (const k of Object.keys(shape)) {
    if (shape[k] === undefined) delete shape[k];
  }
  return shape;
}

export function buildCloudLightingExport(snap = getShaderDebugSnapshot()) {
  const lighting = {
    scatteringAlbedo: val(snap, 'clouds.scatteringAlbedo'),
    powderStrength: val(snap, 'clouds.powderStrength'),
    ambientIntensity: val(snap, 'clouds.ambientIntensity'),
  };
  for (const k of Object.keys(lighting)) {
    if (lighting[k] === undefined) delete lighting[k];
  }
  return lighting;
}

export function buildCloudWindExport(snap = getShaderDebugSnapshot()) {
  const wind = {
    speed: val(snap, 'clouds.windSpeed'),
    evolutionSpeed: val(snap, 'clouds.evolutionSpeed'),
    skew: val(snap, 'clouds.windSkew'),
  };
  const dir = val(snap, 'clouds.windDirection');
  if (Array.isArray(dir) && dir.length >= 2) {
    // Reconstruct heading degrees from XZ (same convention as headingToVector)
    const x = dir[0] ?? 0;
    const z = dir[2] ?? dir[1] ?? 0;
    wind.heading = roundNum((Math.atan2(x, z) * 180) / Math.PI, 2);
  }
  for (const k of Object.keys(wind)) {
    if (wind[k] === undefined) delete wind[k];
  }
  return wind;
}

/**
 * Full cloud type preset partial (shape + lighting + wind) for CLOUD_TYPE_PRESETS.
 */
export function buildCloudTypePresetExport(snap = getShaderDebugSnapshot(), typeName = 'authored') {
  return {
    label: typeName,
    shape: buildCloudShapeExport(snap),
    lighting: buildCloudLightingExport(snap),
    wind: buildCloudWindExport(snap),
  };
}

export function buildAtmosphereExport(snap = getShaderDebugSnapshot()) {
  const atmo = {
    rayleigh: val(snap, 'atmosphere.rayleigh'),
    turbidity: val(snap, 'atmosphere.turbidity'),
    mieDirectionalG: val(snap, 'atmosphere.mieG'),
    mieScatteringStrength: val(snap, 'atmosphere.mieStrength'),
    multipleScattering: val(snap, 'atmosphere.multiScatter'),
    skyMultipleScattering: val(snap, 'atmosphere.skyMultiScatter'),
  };
  for (const k of Object.keys(atmo)) {
    if (atmo[k] === undefined) delete atmo[k];
  }
  return atmo;
}

export function buildSunExport(snap = getShaderDebugSnapshot()) {
  const sun = {
    intensity: val(snap, 'sky.peakSunIntensity'),
    discSize: val(snap, 'sky.sunDiscSize'),
    color: val(snap, 'sky.sunColor'),
  };
  for (const k of Object.keys(sun)) {
    if (sun[k] === undefined) delete sun[k];
  }
  return sun;
}

export function buildWaterExport(snap = getShaderDebugSnapshot()) {
  const water = {
    rippleAmp: val(snap, 'water.rippleAmp'),
    shallow: val(snap, 'water.shallow'),
    deep: val(snap, 'water.deep'),
    roughness: val(snap, 'water.roughness'),
    opacity: val(snap, 'water.opacity'),
  };
  for (const k of Object.keys(water)) {
    if (water[k] === undefined) delete water[k];
  }
  return water;
}

export function buildHeightFogExport(snap = getShaderDebugSnapshot()) {
  const fog = {
    densityScale: val(snap, 'fog.densityScale'),
    alphaMax: val(snap, 'fog.alphaMax'),
    streetColor: val(snap, 'fog.streetColor'),
    highColor: val(snap, 'fog.highColor'),
  };
  for (const k of Object.keys(fog)) {
    if (fog[k] === undefined) delete fog[k];
  }
  return fog;
}

/**
 * Flat id→value map of current overrides only (for localStorage / applyShaderParams).
 */
export function buildOverrideMapExport(snap = getShaderDebugSnapshot()) {
  const map = {};
  for (const [id, entry] of Object.entries(snap.params ?? {})) {
    if (entry.override) map[id] = entry.value;
  }
  return map;
}

/**
 * @param {'cloudType'|'cloudShape'|'cloudLighting'|'cloudWind'|'atmosphere'|'sun'|'water'|'fog'|'overrides'|'all'} kind
 * @param {object} [opts]
 */
export function formatShaderDebugExport(kind = 'all', opts = {}) {
  const snap = getShaderDebugSnapshot();
  const typeName = opts.typeName ?? 'authored';

  switch (kind) {
    case 'cloudShape':
      return fmt(buildCloudShapeExport(snap), 'AUTHORED_CLOUD_SHAPE');
    case 'cloudLighting':
      return fmt(buildCloudLightingExport(snap), 'AUTHORED_CLOUD_LIGHTING');
    case 'cloudWind':
      return fmt(buildCloudWindExport(snap), 'AUTHORED_CLOUD_WIND');
    case 'cloudType': {
      const preset = buildCloudTypePresetExport(snap, typeName);
      return [
        '// Paste into CLOUD_TYPE_PRESETS in src/game/render/cloud/cloudConfig.js',
        `//   ${typeName}: ${JSON.stringify(roundDeep(preset), null, 2).split('\n').join('\n//   ').replace(/^\/\/   \{/, '{')}`,
        fmt({ [typeName]: preset }, 'AUTHORED_CLOUD_TYPE_PRESET'),
      ].join('\n');
    }
    case 'atmosphere':
      return fmt(buildAtmosphereExport(snap), 'AUTHORED_ATMOSPHERE_PARAMS');
    case 'sun':
      return fmt(buildSunExport(snap), 'AUTHORED_SUN_PARAMS');
    case 'water':
      return fmt(buildWaterExport(snap), 'AUTHORED_WATER_PARAMS');
    case 'fog':
      return fmt(buildHeightFogExport(snap), 'AUTHORED_HEIGHT_FOG_PARAMS');
    case 'overrides':
      return fmt(buildOverrideMapExport(snap), 'shaderDebugOverrides');
    case 'all':
    default: {
      const bundle = {
        cloudType: buildCloudTypePresetExport(snap, typeName),
        atmosphere: buildAtmosphereExport(snap),
        sun: buildSunExport(snap),
        water: buildWaterExport(snap),
        heightFog: buildHeightFogExport(snap),
        overrides: buildOverrideMapExport(snap),
      };
      return [
        '// dreamfall shader-debug full export',
        '// - cloudType → CLOUD_TYPE_PRESETS entry',
        '// - atmosphere / sun → DEFAULT_ATMOSPHERE_PARAMS / DEFAULT_SUN_PARAMS',
        '// - overrides → __DREAMFALL_DEBUG__.applyShaderParams({ params: … })',
        fmt(bundle, 'AUTHORED_SHADER_DEBUG_BUNDLE'),
      ].join('\n');
    }
  }
}

/**
 * Legacy helper used by Session "Copy as JS" — prefers structured cloud+atmo bundle.
 */
export function exportShaderDebugAsJs(folderOrAll = null) {
  if (folderOrAll === 'Clouds Shape') return formatShaderDebugExport('cloudShape');
  if (folderOrAll === 'Clouds Lighting') return formatShaderDebugExport('cloudLighting');
  if (folderOrAll === 'Clouds Wind') return formatShaderDebugExport('cloudWind');
  if (folderOrAll === 'Atmosphere') return formatShaderDebugExport('atmosphere');
  if (folderOrAll === 'Sky / Sun') return formatShaderDebugExport('sun');
  if (folderOrAll === 'Water') return formatShaderDebugExport('water');
  if (folderOrAll === 'Height Fog') return formatShaderDebugExport('fog');
  if (folderOrAll == null || folderOrAll === 'all') return formatShaderDebugExport('all');
  // Fallback: flat id map for the folder
  const snap = getShaderDebugSnapshot();
  const filtered = {};
  for (const [id, entry] of Object.entries(snap.params ?? {})) {
    if (entry.folder !== folderOrAll) continue;
    filtered[id] = entry.value;
  }
  return fmt(filtered, 'shaderDebugFolderExport');
}

// Wire structured export into the registry Session API.
setShaderDebugExportImpl(exportShaderDebugAsJs);
