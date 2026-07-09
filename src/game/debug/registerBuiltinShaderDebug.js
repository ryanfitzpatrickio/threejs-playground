/**
 * Wire known TSL uniforms into ShaderDebugRegistry.
 *
 * PR2: Session + sky/sun + atmosphere + clouds shape/lighting/wind + reach.
 * PR3: Rain + wetness + aerial + cloud shadows (dual-source extent).
 * PR4: Water + height fog (density + colors) + post SSAO/bloom (getter rebind).
 * Loaded only through virtual:dreamfall-shader-debug in DEV.
 */

import {
  registerShaderDebugFolder,
  registerShaderDebugParam,
  registerUniformFloat,
  registerUniformColor,
  registerUniformVec3,
  resetShaderDebugAll,
  getShaderDebugSnapshot,
  exportShaderDebugAsJs,
  listShaderDebugParams,
  emitShaderDebugEvent,
  markUserOverride,
  markLutDirty,
  clearLutDirty,
  isLutDirty,
  loadOverridesFromLocalStorage,
  saveOverridesToLocalStorage,
  clearOverridesLocalStorage,
  clearAllUserOverrides,
} from './shaderDebugRegistry.js';
import { formatShaderDebugExport } from './shaderDebugExport.js';
import { registerRuntimeDebug } from './registerRuntimeDebug.js';
import {
  uSunDirection,
  uSunIntensity,
  uSunColor,
  uSunDiscSize,
  uAtmosphereRayleigh,
  uAtmosphereTurbidity,
  uAtmosphereMieG,
  uAtmosphereMieStrength,
  uAtmosphereMultiScatter,
  uAtmosphereSkyMultiScatter,
  uSkyDarkness,
  uSunTint,
  uCloudAmbientColor,
  uCloudAltitude,
  uCloudThickness,
  uCloudCoverage,
  uCloudDensity,
  uCloudScatteringAlbedo,
  uCloudWeatherScale,
  uCloudBaseScale,
  uCloudErosionScale,
  uCloudBaseStrength,
  uCloudErosionStrengthBase,
  uCloudErosionStrengthPeak,
  uCloudErosionShape,
  uCloudEdgeSoftness,
  uCloudEdgeSoftnessFalloff,
  uCloudPowderStrength,
  uCloudAmbientIntensity,
  uWindDirection,
  uWindSkew,
} from '../render/cloud/cloudUniforms.js';
import {
  uCloudMaxMarchDist,
  uCloudFadeStart,
  uCloudFadeEnd,
  uCloudFogMaxDistance,
} from '../render/cloud/cloudReachUniforms.js';
import {
  uRainVolume,
  uRainFallSpeed,
  uRainLengthBase,
  uRainStreakWidth,
  uRainWindVec,
  uRainIntensity,
} from '../render/rainUniforms.js';
import { rainWetness, lightningFlash } from '../systems/weatherUniforms.js';
import {
  terrainAerialEnabled,
  terrainAerialStart,
  terrainAerialEnd,
  terrainAerialStrength,
  terrainAerialDesat,
  terrainAerialContrast,
  terrainHazeColor,
  terrainNightFactor,
} from '../systems/terrainAerialUniforms.js';
import {
  terrainCloudShadowIntensity,
  terrainCloudShadowExtent,
  terrainCloudShadowCenter,
  terrainCloudShadowEnabled,
} from '../systems/terrainCloudShadowUniforms.js';
import {
  uWaterRippleAmp,
  uWaterShallow,
  uWaterDeep,
  uWaterRoughness,
  uWaterOpacity,
} from '../materials/waterUniforms.js';
import {
  uHeightFogDensityScale,
  uHeightFogAlphaMax,
  uHeightFogStreetColor,
  uHeightFogHighColor,
} from '../render/heightFogUniforms.js';
import {
  uMudLightColor,
  uMudAmbient,
  uMudWetCol,
  uMudDryCol,
  uMudDecalDark,
  uMudDecalLight,
} from '../render/mudParticleUniforms.js';
import { uGodRayStrength } from '../render/cloud/godRaysNode.js';

let registered = false;

/**
 * @param {object} [runtime] GameRuntime
 */
export function registerBuiltinShaderDebug(runtime = null) {
  if (registered) {
    // Allow re-binding provider-backed CPU knobs when runtime restarts.
    if (runtime && typeof globalThis !== 'undefined') {
      globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__ = runtime;
    }
    emitShaderDebugEvent('registry-ready', { runtime: Boolean(runtime), repeat: true });
    return;
  }
  registered = true;

  if (runtime && typeof globalThis !== 'undefined') {
    globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__ = runtime;
  }

  registerSessionFolder(runtime);
  // Discrete controls from the former Solid DebugPanel (lighting, weather, TOD…).
  registerRuntimeDebug(runtime);
  registerSkySun(runtime);
  registerAtmosphere();
  registerCloudsShape();
  registerCloudsLighting();
  registerCloudsWind(runtime);
  registerCloudsReach();
  registerRain();
  registerWetness();
  registerAerial();
  registerCloudShadows(runtime);
  registerWater();
  registerHeightFog();
  registerPost(runtime);
  registerMud();
  registerGodRays();

  const applied = loadOverridesFromLocalStorage();
  if (applied > 0) {
    console.info(`[shader-debug] restored ${applied} override(s) from localStorage`);
  }

  emitShaderDebugEvent('registry-ready', { runtime: Boolean(runtime) });
}

function resolveProvider(runtime) {
  return runtime?.sceneSystem?.skySystem?.provider
    ?? globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__?.sceneSystem?.skySystem?.provider
    ?? null;
}

function registerSessionFolder(runtime) {
  registerShaderDebugFolder('Session', { expanded: true });

  registerShaderDebugParam({
    id: 'session.paramCount',
    label: 'Registered params',
    folder: 'Session',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'event',
    get: () => listShaderDebugParams().length,
  });

  registerShaderDebugParam({
    id: 'session.lutDirty',
    label: 'LUT dirty',
    folder: 'Session',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'event',
    help: 'Atmosphere params need Rebake LUT to update transmittance tables.',
    get: () => (isLutDirty() ? 'YES — Rebake LUT' : 'clean'),
  });

  registerShaderDebugParam({
    id: 'session.rebakeLut',
    label: 'Rebake atmosphere LUT',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Rebake transmittance/multi-scatter LUTs only (no PMREM rebuild).',
    get: () => null,
    action: () => {
      const bridge = globalThis.__DREAMFALL_DEBUG__;
      const result = bridge?.rebakeAtmosphereLut?.();
      if (result?.ok) clearLutDirty();
      else console.warn('[shader-debug] rebake failed', result);
    },
  });

  registerShaderDebugParam({
    id: 'session.pinSunLighting',
    label: 'Pin current sun lighting',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Freeze sky.sunIntensity + clouds.sunTint against TOD/weather stamps.',
    get: () => null,
    action: () => {
      markUserOverride('sky.sunIntensity');
      markUserOverride('clouds.sunTint');
    },
  });

  registerShaderDebugParam({
    id: 'session.resetAll',
    label: 'Reset all overrides',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      resetShaderDebugAll();
      // Re-apply active weather/cloud profile after clearing pins.
      const rt = runtime ?? globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__;
      const weather = rt?.sceneSystem?.skySystem?.weather ?? rt?.weatherSystem?.weather;
      if (weather) rt?.weatherSystem?.setWeather?.(weather);
      else rt?.sceneSystem?.skySystem?.setWeather?.('clear');
    },
  });

  registerShaderDebugParam({
    id: 'session.copyJson',
    label: 'Copy JSON snapshot',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => copyText(JSON.stringify(getShaderDebugSnapshot(), null, 2)),
  });

  registerShaderDebugParam({
    id: 'session.copyJs',
    label: 'Copy as JS (full bundle)',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Cloud type + atmosphere + sun + water + fog + overrides map.',
    get: () => null,
    action: () => copyText(exportShaderDebugAsJs(null)),
  });

  registerShaderDebugParam({
    id: 'session.copyCloudType',
    label: 'Copy cloud type preset JS',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Paste into CLOUD_TYPE_PRESETS in cloudConfig.js',
    get: () => null,
    action: () => copyText(formatShaderDebugExport('cloudType')),
  });

  registerShaderDebugParam({
    id: 'session.copyCloudShape',
    label: 'Copy cloud shape JS',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => copyText(formatShaderDebugExport('cloudShape')),
  });

  registerShaderDebugParam({
    id: 'session.copyAtmosphere',
    label: 'Copy atmosphere JS',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => copyText(formatShaderDebugExport('atmosphere')),
  });

  registerShaderDebugParam({
    id: 'session.copyOverrides',
    label: 'Copy overrides only JS',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    help: 'Pinned values only — for applyShaderParams / localStorage.',
    get: () => null,
    action: () => copyText(formatShaderDebugExport('overrides')),
  });

  registerShaderDebugParam({
    id: 'session.saveOverrides',
    label: 'Save overrides (localStorage)',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      if (saveOverridesToLocalStorage()) {
        console.info('[shader-debug] overrides saved');
      }
    },
  });

  registerShaderDebugParam({
    id: 'session.loadOverrides',
    label: 'Load overrides (localStorage)',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const n = loadOverridesFromLocalStorage();
      console.info(`[shader-debug] loaded ${n} override(s)`);
    },
  });

  registerShaderDebugParam({
    id: 'session.clearStorage',
    label: 'Clear saved overrides',
    folder: 'Session',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      clearOverridesLocalStorage();
      clearAllUserOverrides();
    },
  });
}

function registerSkySun(runtime) {
  registerShaderDebugFolder('Sky / Sun', { expanded: false });

  // Artistic peak — CPU on provider
  registerShaderDebugParam({
    id: 'sky.peakSunIntensity',
    label: 'Peak sun intensity',
    folder: 'Sky / Sun',
    type: 'float',
    min: 0,
    max: 20,
    step: 0.1,
    default: 6.6,
    writeCadence: 'event',
    pinPolicy: 'allow',
    cost: 'live',
    get: () => resolveProvider(runtime)?._peakSunIntensity ?? uSunIntensity.value,
    set: (v) => {
      markUserOverride('sky.peakSunIntensity');
      const p = resolveProvider(runtime);
      if (p) p._peakSunIntensity = Number(v);
      // Refresh derived intensity for current TOD if not pinned separately.
      const sky = runtime?.sceneSystem?.skySystem
        ?? globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__?.sceneSystem?.skySystem;
      if (sky?.provider && sky.sunDirection) {
        sky.provider.applySunDirection(sky.sunDirection, sky.timeOfDay);
      }
    },
  });

  registerShaderDebugParam({
    id: 'sky.sunIntensity',
    label: 'Sun intensity (derived)',
    folder: 'Sky / Sun',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'event',
    help: 'Derived peak × day × weather. Pin via Session action.',
    get: () => uSunIntensity.value,
  });

  registerUniformColor('sky.sunColor', 'Sky / Sun', 'Sun color', uSunColor, {
    writeCadence: 'event',
    pinPolicy: 'allow',
  });
  registerUniformFloat('sky.sunDiscSize', 'Sky / Sun', 'Sun disc size', uSunDiscSize, {
    min: 0.0001,
    max: 0.01,
    step: 0.0001,
    writeCadence: 'event',
    pinPolicy: 'allow',
  });
  registerShaderDebugParam({
    id: 'sky.sunDirection',
    label: 'Sun direction',
    folder: 'Sky / Sun',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'event',
    get: () => {
      const v = uSunDirection.value;
      return [v.x, v.y, v.z].map((n) => Number(n.toFixed(3)));
    },
  });
  registerShaderDebugParam({
    id: 'sky.darkness',
    label: 'Sky darkness',
    folder: 'Sky / Sun',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'event',
    get: () => uSkyDarkness.value,
  });
}

function registerAtmosphere() {
  registerShaderDebugFolder('Atmosphere', { expanded: false });

  const rebakeFloat = (id, label, uNode, opts) => {
    registerUniformFloat(id, 'Atmosphere', label, uNode, {
      ...opts,
      cost: 'rebake',
      writeCadence: 'event',
      pinPolicy: 'allow',
    });
    const param = listShaderDebugParams().find((p) => p.id === id);
    if (param && typeof param.set === 'function') {
      const baseSet = param.set;
      param.set = (v) => {
        baseSet(v);
        markLutDirty();
      };
    }
  };

  rebakeFloat('atmosphere.rayleigh', 'Rayleigh', uAtmosphereRayleigh, {
    min: 0, max: 6, step: 0.05, default: uAtmosphereRayleigh.value,
  });
  rebakeFloat('atmosphere.turbidity', 'Turbidity', uAtmosphereTurbidity, {
    min: 0, max: 20, step: 0.1, default: uAtmosphereTurbidity.value,
  });
  rebakeFloat('atmosphere.mieG', 'Mie G', uAtmosphereMieG, {
    min: 0, max: 0.99, step: 0.01, default: uAtmosphereMieG.value,
  });
  rebakeFloat('atmosphere.mieStrength', 'Mie strength', uAtmosphereMieStrength, {
    min: 0, max: 2, step: 0.01, default: uAtmosphereMieStrength.value,
  });
  rebakeFloat('atmosphere.multiScatter', 'Multi-scatter', uAtmosphereMultiScatter, {
    min: 0, max: 2, step: 0.01, default: uAtmosphereMultiScatter.value,
  });
  rebakeFloat('atmosphere.skyMultiScatter', 'Sky multi-scatter', uAtmosphereSkyMultiScatter, {
    min: 0, max: 2, step: 0.01, default: uAtmosphereSkyMultiScatter.value,
  });
}

function registerCloudsShape() {
  registerShaderDebugFolder('Clouds Shape', { expanded: true });

  registerUniformFloat('clouds.altitude', 'Clouds Shape', 'Altitude (m)', uCloudAltitude, {
    min: 200, max: 8000, step: 50,
  });
  registerUniformFloat('clouds.thickness', 'Clouds Shape', 'Thickness (m)', uCloudThickness, {
    min: 100, max: 6000, step: 50,
  });
  registerUniformFloat('clouds.coverage', 'Clouds Shape', 'Coverage', uCloudCoverage, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformFloat('clouds.density', 'Clouds Shape', 'Density', uCloudDensity, {
    min: 0, max: 0.1, step: 0.001,
  });
  registerUniformFloat('clouds.weatherScale', 'Clouds Shape', 'Weather scale', uCloudWeatherScale, {
    min: 500, max: 20000, step: 50,
  });
  registerUniformFloat('clouds.baseScale', 'Clouds Shape', 'Base scale', uCloudBaseScale, {
    min: 200, max: 8000, step: 20,
  });
  registerUniformFloat('clouds.erosionScale', 'Clouds Shape', 'Erosion scale', uCloudErosionScale, {
    min: 50, max: 4000, step: 10,
  });
  registerUniformFloat('clouds.baseStrength', 'Clouds Shape', 'Base strength', uCloudBaseStrength, {
    min: 0, max: 2, step: 0.01,
  });
  registerUniformFloat('clouds.erosionStrengthBase', 'Clouds Shape', 'Erosion base', uCloudErosionStrengthBase, {
    min: 0, max: 3, step: 0.01,
  });
  registerUniformFloat('clouds.erosionStrengthPeak', 'Clouds Shape', 'Erosion peak', uCloudErosionStrengthPeak, {
    min: 0, max: 6, step: 0.05,
  });
  registerUniformFloat('clouds.erosionShape', 'Clouds Shape', 'Erosion shape', uCloudErosionShape, {
    min: 0, max: 3, step: 0.05,
  });
  registerUniformFloat('clouds.edgeSoftness', 'Clouds Shape', 'Edge softness', uCloudEdgeSoftness, {
    min: 0, max: 1, step: 0.005,
  });
  registerUniformFloat('clouds.edgeSoftnessFalloff', 'Clouds Shape', 'Edge falloff', uCloudEdgeSoftnessFalloff, {
    min: 0, max: 3, step: 0.05,
  });
}

function registerCloudsLighting() {
  registerShaderDebugFolder('Clouds Lighting', { expanded: false });

  registerUniformFloat('clouds.scatteringAlbedo', 'Clouds Lighting', 'Scattering albedo', uCloudScatteringAlbedo, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformFloat('clouds.powderStrength', 'Clouds Lighting', 'Powder strength', uCloudPowderStrength, {
    min: 0, max: 2, step: 0.01,
  });
  registerUniformFloat('clouds.ambientIntensity', 'Clouds Lighting', 'Ambient intensity', uCloudAmbientIntensity, {
    min: 0, max: 2, step: 0.01,
  });

  registerUniformColor('clouds.sunTint', 'Clouds Lighting', 'Sun tint (derived)', uSunTint, {
    pinPolicy: 'monitor',
    writeCadence: 'event',
    help: 'Derived from sun color × day. Pin via Session action.',
  });
  const sunTint = listShaderDebugParams().find((p) => p.id === 'clouds.sunTint');
  if (sunTint) {
    sunTint.set = (v) => {
      markUserOverride('clouds.sunTint');
      // registerUniformColor already used setRGB path — reimplement
      const arr = Array.isArray(v) ? v : [v?.r ?? 1, v?.g ?? 1, v?.b ?? 1];
      uSunTint.value.setRGB(arr[0] ?? 1, arr[1] ?? 1, arr[2] ?? 1);
    };
  }

  registerUniformColor('clouds.ambientColor', 'Clouds Lighting', 'Ambient color (derived)', uCloudAmbientColor, {
    pinPolicy: 'monitor',
    writeCadence: 'event',
  });
  const ambient = listShaderDebugParams().find((p) => p.id === 'clouds.ambientColor');
  if (ambient) {
    ambient.set = (v) => {
      markUserOverride('clouds.ambientColor');
      const arr = Array.isArray(v) ? v : [v?.r ?? 0.5, v?.g ?? 0.6, v?.b ?? 0.75];
      uCloudAmbientColor.value.setRGB(arr[0] ?? 0.5, arr[1] ?? 0.6, arr[2] ?? 0.75);
    };
  }
}

function registerCloudsWind(runtime) {
  registerShaderDebugFolder('Clouds Wind', { expanded: false });

  registerShaderDebugParam({
    id: 'clouds.windSpeed',
    label: 'Wind speed',
    folder: 'Clouds Wind',
    type: 'float',
    min: 0,
    max: 80,
    step: 0.5,
    default: 0,
    writeCadence: 'event',
    pinPolicy: 'allow',
    get: () => resolveProvider(runtime)?._windSpeed ?? 0,
    set: (v) => {
      markUserOverride('clouds.windSpeed');
      const p = resolveProvider(runtime);
      if (p) p._windSpeed = Number(v);
    },
  });

  registerShaderDebugParam({
    id: 'clouds.evolutionSpeed',
    label: 'Evolution speed',
    folder: 'Clouds Wind',
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    default: 0,
    writeCadence: 'event',
    pinPolicy: 'allow',
    get: () => resolveProvider(runtime)?._evolutionSpeed ?? 0,
    set: (v) => {
      markUserOverride('clouds.evolutionSpeed');
      const p = resolveProvider(runtime);
      if (p) p._evolutionSpeed = Number(v);
    },
  });

  registerUniformVec3('clouds.windDirection', 'Clouds Wind', 'Wind direction', uWindDirection, {
    writeCadence: 'event',
    pinPolicy: 'allow',
  });
  registerUniformFloat('clouds.windSkew', 'Clouds Wind', 'Wind skew', uWindSkew, {
    min: 0, max: 2000, step: 10,
  });
}

function registerCloudsReach() {
  registerShaderDebugFolder('Clouds Reach', { expanded: false });

  registerUniformFloat('clouds.reach.maxMarch', 'Clouds Reach', 'Max march (m)', uCloudMaxMarchDist, {
    min: 1000, max: 30000, step: 100, writeCadence: 'frame',
  });
  registerUniformFloat('clouds.reach.fadeStart', 'Clouds Reach', 'Fade start (m)', uCloudFadeStart, {
    min: 500, max: 25000, step: 100, writeCadence: 'frame',
  });
  registerUniformFloat('clouds.reach.fadeEnd', 'Clouds Reach', 'Fade end (m)', uCloudFadeEnd, {
    min: 500, max: 30000, step: 100, writeCadence: 'frame',
  });
  registerUniformFloat('clouds.reach.fogMax', 'Clouds Reach', 'Fog max (m)', uCloudFogMaxDistance, {
    min: 20, max: 1000, step: 5, writeCadence: 'frame',
  });
}

function registerRain() {
  registerShaderDebugFolder('Rain', { expanded: false });

  registerUniformVec3('rain.volume', 'Rain', 'Volume (m)', uRainVolume, {
    min: 10, max: 120, step: 1, writeCadence: 'event',
  });
  registerUniformFloat('rain.fallSpeed', 'Rain', 'Fall speed', uRainFallSpeed, {
    min: 5, max: 60, step: 0.5,
  });
  registerUniformFloat('rain.lengthBase', 'Rain', 'Streak length', uRainLengthBase, {
    min: 0.2, max: 4, step: 0.05,
  });
  registerUniformFloat('rain.streakWidth', 'Rain', 'Streak width', uRainStreakWidth, {
    min: 0.005, max: 0.1, step: 0.001,
  });
  registerUniformVec3('rain.windVec', 'Rain', 'Wind vec', uRainWindVec, {
    writeCadence: 'event',
  });
  registerUniformFloat('rain.intensity', 'Rain', 'Intensity', uRainIntensity, {
    min: 0, max: 1, step: 0.01, writeCadence: 'frame',
    help: 'Ramped by weather; pin to freeze opacity.',
  });
}

function registerWetness() {
  registerShaderDebugFolder('Wetness', { expanded: false });

  registerUniformFloat('weather.wetness', 'Wetness', 'Surface wetness', rainWetness, {
    min: 0, max: 1, step: 0.01, writeCadence: 'frame',
    help: 'Rises over ~15s in rain. Pin to freeze roads/terrain/paint wet look.',
  });
  registerShaderDebugParam({
    id: 'weather.lightningFlash',
    label: 'Lightning flash',
    folder: 'Wetness',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'frame',
    help: 'Sim flash — not pinnable.',
    get: () => lightningFlash.value,
  });
}

function registerAerial() {
  registerShaderDebugFolder('Aerial', { expanded: false });

  registerUniformFloat('aerial.enabled', 'Aerial', 'Enabled', terrainAerialEnabled, {
    min: 0, max: 1, step: 1, writeCadence: 'event',
  });
  registerUniformFloat('aerial.strength', 'Aerial', 'Strength', terrainAerialStrength, {
    min: 0, max: 2, step: 0.01,
  });
  registerUniformFloat('aerial.desat', 'Aerial', 'Desaturation', terrainAerialDesat, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformFloat('aerial.contrast', 'Aerial', 'Contrast', terrainAerialContrast, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformFloat('aerial.start', 'Aerial', 'Fade start (m)', terrainAerialStart, {
    min: 10, max: 2000, step: 5, writeCadence: 'frame',
  });
  registerUniformFloat('aerial.end', 'Aerial', 'Fade end (m)', terrainAerialEnd, {
    min: 20, max: 4000, step: 5, writeCadence: 'frame',
  });
  registerUniformColor('aerial.hazeColor', 'Aerial', 'Haze color', terrainHazeColor, {
    writeCadence: 'frame',
    help: 'Also stamped from cloud ambient when volumetric sky is active.',
  });
  registerShaderDebugParam({
    id: 'aerial.nightFactor',
    label: 'Night factor',
    folder: 'Aerial',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'frame',
    get: () => terrainNightFactor.value,
  });
}

/**
 * Cloud shadow dual-source:
 * - shadow.extent binds CloudShadowNode.projection.extent (lazy); always mirrored to terrain.
 * - shadow.intensity binds terrainCloudShadowIntensity with systemWrite in sync.
 */
function registerCloudShadows(runtime) {
  registerShaderDebugFolder('Cloud Shadows', { expanded: false });

  registerShaderDebugParam({
    id: 'shadow.extent',
    label: 'Extent (m)',
    folder: 'Cloud Shadows',
    type: 'float',
    min: 400,
    max: 12000,
    step: 50,
    default: 3200,
    writeCadence: 'frame',
    pinPolicy: 'allow',
    cost: 'live',
    help: 'Source: CloudShadowNode. Frame always copies → terrain UV scale.',
    get: () => {
      const extentU = resolveCloudShadow(runtime)?.projection?.extent;
      if (extentU) return extentU.value;
      return terrainCloudShadowExtent.value;
    },
    set: (v) => {
      markUserOverride('shadow.extent');
      const n = Number(v);
      const provider = resolveProvider(runtime);
      if (provider) provider._shadowExtent = n;
      const extentU = resolveCloudShadow(runtime)?.projection?.extent;
      if (extentU) extentU.value = n;
      // Immediate UV sync even before next frame sync.
      terrainCloudShadowExtent.value = n;
    },
  });

  registerUniformFloat('shadow.intensity', 'Cloud Shadows', 'Intensity', terrainCloudShadowIntensity, {
    min: 0, max: 1.5, step: 0.01, writeCadence: 'frame',
    help: 'Terrain darkening. Pin freezes against CloudShadowNode projection.',
  });

  registerShaderDebugParam({
    id: 'shadow.center',
    label: 'Center XZ',
    folder: 'Cloud Shadows',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'frame',
    help: 'Camera-follow sim — not editable.',
    get: () => {
      const c = terrainCloudShadowCenter.value;
      return [Number((c.x ?? 0).toFixed(1)), Number((c.y ?? 0).toFixed(1))];
    },
  });

  registerShaderDebugParam({
    id: 'shadow.enabled',
    label: 'Enabled',
    folder: 'Cloud Shadows',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'frame',
    get: () => terrainCloudShadowEnabled.value,
  });
}

function resolveCloudShadow(runtime) {
  const provider = resolveProvider(runtime);
  return provider?.cloudShadow ?? provider?._shadowNode ?? null;
}

function registerWater() {
  registerShaderDebugFolder('Water', { expanded: false });

  registerUniformFloat('water.rippleAmp', 'Water', 'Ripple amplitude', uWaterRippleAmp, {
    min: 0, max: 0.35, step: 0.005,
  });
  registerUniformColor('water.shallow', 'Water', 'Shallow color', uWaterShallow, {});
  registerUniformColor('water.deep', 'Water', 'Deep color', uWaterDeep, {});
  registerUniformFloat('water.roughness', 'Water', 'Roughness', uWaterRoughness, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformFloat('water.opacity', 'Water', 'Opacity', uWaterOpacity, {
    min: 0, max: 1, step: 0.01,
    help: 'Drives opacityNode on all river materials.',
  });
}

function registerHeightFog() {
  registerShaderDebugFolder('Height Fog', { expanded: false });

  registerUniformFloat('fog.densityScale', 'Height Fog', 'Density scale', uHeightFogDensityScale, {
    min: 0, max: 0.5, step: 0.001,
    help: 'Was hard-coded 0.117. Live without pipeline rebuild.',
  });
  registerUniformFloat('fog.alphaMax', 'Height Fog', 'Alpha max', uHeightFogAlphaMax, {
    min: 0, max: 1, step: 0.01,
    help: 'Was hard-coded 0.68.',
  });
  registerUniformColor('fog.streetColor', 'Height Fog', 'Street color', uHeightFogStreetColor, {
    writeCadence: 'event',
    help: 'Required live fog hue (not density-only).',
  });
  registerUniformColor('fog.highColor', 'Height Fog', 'High color', uHeightFogHighColor, {
    writeCadence: 'event',
  });
}

/**
 * Post SSAO/bloom — getter bindings into RendererSystem._debugPost so pipeline
 * rebuilds do not leave dead closed-over node refs. lastUserValue reapplied
 * after each ensureRenderPipeline via reapplyShaderDebugOverrides('post.').
 */
function registerPost(runtime) {
  registerShaderDebugFolder('Post (SSAO / Bloom)', { expanded: false });

  const post = () => {
    const rt = runtime ?? globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__;
    return rt?.rendererSystem?._debugPost ?? null;
  };

  registerShaderDebugParam({
    id: 'post.pipelineGeneration',
    label: 'Pipeline generation',
    folder: 'Post (SSAO / Bloom)',
    type: 'monitor',
    pinPolicy: 'monitor',
    writeCadence: 'event',
    get: () => post()?.generation ?? 0,
  });

  registerShaderDebugParam({
    id: 'post.ssao.radius',
    label: 'SSAO radius',
    folder: 'Post (SSAO / Bloom)',
    type: 'float',
    min: 0.05,
    max: 4,
    step: 0.01,
    writeCadence: 'event',
    pinPolicy: 'allow',
    cost: 'live',
    get: () => post()?.ssao?.radius?.value ?? 0,
    set: (v) => {
      const n = Number(v);
      markUserOverride('post.ssao.radius', n);
      const node = post()?.ssao?.radius;
      if (node) node.value = n;
    },
  });

  registerShaderDebugParam({
    id: 'post.ssao.intensity',
    label: 'SSAO intensity',
    folder: 'Post (SSAO / Bloom)',
    type: 'float',
    min: 0,
    max: 4,
    step: 0.01,
    writeCadence: 'event',
    pinPolicy: 'allow',
    cost: 'live',
    get: () => post()?.ssao?.intensity?.value ?? 0,
    set: (v) => {
      const n = Number(v);
      markUserOverride('post.ssao.intensity', n);
      const node = post()?.ssao?.intensity;
      if (node) node.value = n;
    },
  });

  registerShaderDebugParam({
    id: 'post.bloom.strength',
    label: 'Bloom strength',
    folder: 'Post (SSAO / Bloom)',
    type: 'float',
    min: 0,
    max: 3,
    step: 0.01,
    writeCadence: 'event',
    pinPolicy: 'allow',
    cost: 'live',
    get: () => post()?.bloom?.strength?.value ?? 0,
    set: (v) => {
      const n = Number(v);
      markUserOverride('post.bloom.strength', n);
      const node = post()?.bloom?.strength;
      if (node) node.value = n;
    },
  });

  registerShaderDebugParam({
    id: 'post.bloom.radius',
    label: 'Bloom radius',
    folder: 'Post (SSAO / Bloom)',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.01,
    writeCadence: 'event',
    pinPolicy: 'allow',
    cost: 'live',
    get: () => post()?.bloom?.radius?.value ?? 0,
    set: (v) => {
      const n = Number(v);
      markUserOverride('post.bloom.radius', n);
      const node = post()?.bloom?.radius;
      if (node) node.value = n;
    },
  });

  registerShaderDebugParam({
    id: 'post.bloom.threshold',
    label: 'Bloom threshold',
    folder: 'Post (SSAO / Bloom)',
    type: 'float',
    min: 0,
    max: 2,
    step: 0.01,
    writeCadence: 'event',
    pinPolicy: 'allow',
    cost: 'live',
    get: () => post()?.bloom?.threshold?.value ?? 0,
    set: (v) => {
      const n = Number(v);
      markUserOverride('post.bloom.threshold', n);
      const node = post()?.bloom?.threshold;
      if (node) node.value = n;
    },
  });
}

function registerMud() {
  registerShaderDebugFolder('Mud', { expanded: false });

  // Vector3 linear RGB — not THREE.Color (matches particle WGSL).
  registerUniformVec3('mud.lightColor', 'Mud', 'Light color (linear)', uMudLightColor, {
    min: 0, max: 2, step: 0.01,
  });
  registerUniformVec3('mud.ambient', 'Mud', 'Ambient (linear)', uMudAmbient, {
    min: 0, max: 2, step: 0.01,
  });
  registerUniformVec3('mud.wetCol', 'Mud', 'Wet body (linear)', uMudWetCol, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformVec3('mud.dryCol', 'Mud', 'Dry body (linear)', uMudDryCol, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformVec3('mud.decalDark', 'Mud', 'Decal dark (linear)', uMudDecalDark, {
    min: 0, max: 1, step: 0.01,
  });
  registerUniformVec3('mud.decalLight', 'Mud', 'Decal light (linear)', uMudDecalLight, {
    min: 0, max: 1, step: 0.01,
  });
}

function registerGodRays() {
  registerShaderDebugFolder('God Rays', { expanded: false });

  registerUniformFloat('godRays.strength', 'God Rays', 'Strength', uGodRayStrength, {
    min: 0, max: 1, step: 0.005,
    help: 'Live uniform (PR5). Only visible when quality enables volumetric god rays.',
  });
}

function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    console.info('[shader-debug]', text);
  } catch {
    /* ignore */
  }
}
