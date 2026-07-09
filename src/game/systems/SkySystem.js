import * as THREE from 'three';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { CloudSkyProvider } from '../render/cloud/cloudSkyProvider.js';
import { DEFAULT_CLOUD_TYPE, resolveCloudMode } from '../render/cloud/cloudConfig.js';
import { hasAnyUserOverrideInFolder } from '../debug/shaderDebugRegistry.js';

const DEFAULT_TIME_OF_DAY = 0.72;
const DEFAULT_SKY_SCALE = 450000;
const DEFAULT_SUN_DISTANCE = 1000;
const DAYLIGHT_START = 0.25; // 06:00
const DAYLIGHT_END = 0.75; // 18:00
const WEATHER_LIGHT_SCALE = Object.freeze({
  clear: 1,
  fog: 0.66,
  overcast: 0.64,
  rain: 0.58,
});
const BASE_SKY_DEFAULTS = Object.freeze({
  turbidity: 3.2,
  rayleigh: 1.7,
  mieCoefficient: 0.006,
  mieDirectionalG: 0.82,
  cloudCoverage: 0.42,
  cloudDensity: 0.52,
  cloudScale: 0.00016,
  cloudSpeed: 0.000035,
  cloudElevation: 0.34,
  sunDiscIntensity: 0.16,
});
// Dome-sky (SkyMesh) atmosphere tweaks for non-clear weather. Higher turbidity
// and lower Rayleigh scatter wash out the midday blue so rain/overcast read grey.
const WEATHER_SKY_PROFILE = Object.freeze({
  fog: {
    turbidity: 6.8,
    rayleigh: 0.95,
    mieCoefficient: 0.009,
    cloudCoverage: 0.72,
    cloudDensity: 0.86,
    cloudElevation: 0.58,
    cloudScale: 0.00011,
    // SkyMesh's disc is an extremely bright HDR source, so fog needs a much
    // smaller multiplier than its apparent opacity would suggest.
    sunDiscScale: 0.08,
    mieDirectionalG: 0.62,
  },
  overcast: {
    turbidity: 8.2,
    rayleigh: 0.72,
    mieCoefficient: 0.01,
    cloudCoverage: 0.9,
    cloudDensity: 0.92,
    cloudElevation: 0.7,
    cloudScale: 0.0001,
    sunDiscScale: 0,
    mieDirectionalG: 0.48,
  },
  rain: {
    // Grey overcast without the first pass's near-opaque blanket. Low Rayleigh
    // kills the midday blue; clouds mask the rest while staying bright enough.
    turbidity: 8.8,
    rayleigh: 0.62,
    mieCoefficient: 0.0115,
    cloudCoverage: 0.94,
    cloudDensity: 0.9,
    cloudElevation: 0.68,
    cloudScale: 0.0001,
    sunDiscScale: 0,
    mieDirectionalG: 0.42,
  },
});
const HEMISPHERE_SKY_COLOR = Object.freeze({
  fog: 0xb8c2c9,
  overcast: 0xadb8c0,
  rain: 0xa8b4bc,
});
const SUN_COLOR = Object.freeze({
  fog: 0xe8ecef,
  overcast: 0xdde2e6,
  rain: 0xdce2e8,
});

function resolveSunColor(weather, config = {}) {
  if (weather === 'clear' && config.sunColor != null) {
    return config.sunColor;
  }
  return SUN_COLOR[weather] ?? config.sunColor ?? 0xffe4b5;
}

function resolveHemisphereSkyColor(weather, config = {}) {
  if (weather === 'clear' && config.hemisphereSkyColor != null) {
    return config.hemisphereSkyColor;
  }
  return HEMISPHERE_SKY_COLOR[weather] ?? config.hemisphereSkyColor ?? 0xb9d8ff;
}

// Fallback WebGPU clear when the LUT sky sphere misses a pixel (pipeline rebuild,
// fast camera motion). Matches a midday zenith blue — not black.
export const VOLUMETRIC_SKY_CLEAR = 0x5a8ec8;

export class SkySystem {
  initialize(scene, { sun, hemisphere, qualityPreset = {} } = {}) {
    this.scene = scene;
    this.sun = sun;
    this.hemisphere = hemisphere;
    this.config = qualityPreset.environment ?? {};
    this.weather = 'clear';
    this.timeOfDay = this.config.timeOfDay ?? DEFAULT_TIME_OF_DAY;
    this.dynamicDay = this.config.dynamicDay === true;
    this.dayLengthSeconds = Math.max(60, this.config.dayLengthSeconds ?? 900);
    this._lastEnvironmentBucket = null;
    this.sunDirection = new THREE.Vector3();
    // localStorage `dreamfall:clouds` overrides the quality preset when set.
    this.cloudMode = resolveCloudMode(qualityPreset);

    if (this.cloudMode === 'volumetric') {
      this.provider = new CloudSkyProvider().initialize(scene, { sun, hemisphere, qualityPreset });
      // Fallback clear colour when the LUT sky pass misses a pixel (e.g. during
      // pipeline rebuild). null reads as black in WebGPU.
      scene.background = new THREE.Color(VOLUMETRIC_SKY_CLEAR);
    } else {
      this.sky = createConfiguredSky(this.config, true);
      this.sky.name = 'Physical Atmosphere Sky';
      this.sky.scale.setScalar(DEFAULT_SKY_SCALE);
      this.sky.frustumCulled = false;
      this.sky.renderOrder = -1000;
      scene.background = null;
      scene.add(this.sky);
    }
    this.setTimeOfDay(this.timeOfDay);
    return this;
  }

  setTimeOfDay(timeOfDay = DEFAULT_TIME_OF_DAY) {
    this.timeOfDay = wrap01(timeOfDay);
    computeSunDirection(this.timeOfDay, this.sunDirection);

    if (this.provider) {
      this.provider.applySunDirection(this.sunDirection, this.timeOfDay);
    } else {
      this.sky?.sunPosition.value.copy(this.sunDirection).multiplyScalar(DEFAULT_SKY_SCALE * 0.9);
      const daylight = getSkyDaylightFactor(this.timeOfDay);
      const weatherScale = WEATHER_LIGHT_SCALE[this.weather] ?? 1;

      if (this.sun) {
        this.sun.position.copy(this.sunDirection).multiplyScalar(DEFAULT_SUN_DISTANCE);
        this.sun.target.position.set(0, 0, 0);
        this.sun.color.set(resolveSunColor(this.weather, this.config));
        this.sun.intensity = (this.config.sunIntensity ?? 4.2) * daylight * weatherScale;
      }
      if (this.hemisphere) {
        this.hemisphere.color.set(resolveHemisphereSkyColor(this.weather, this.config));
        this.hemisphere.groundColor.set(this.config.hemisphereGroundColor ?? 0x776653);
        this.hemisphere.intensity = (this.config.hemisphereIntensity ?? 0.5)
          * (0.08 + daylight * 0.92)
          * weatherScale;
      }
    }
    this.onTimeOfDayChanged?.(this.timeOfDay);
    return this.sunDirection;
  }

  updateEnvironmentConfig(config = {}) {
    this.config = { ...this.config, ...config };
    if (config.timeOfDay != null) {
      this.setTimeOfDay(config.timeOfDay);
    } else {
      this.setTimeOfDay(this.timeOfDay);
    }
    return this;
  }

  // `camera` is required by the volumetric path: the sky sphere is parented to the
  // live camera (see CloudSkyProvider.attachToCamera) and must be updated after
  // CameraSystem.update each frame. The SkyMesh path ignores it.
  attachToCamera(camera) {
    this.provider?.attachToCamera?.(camera);
    return this;
  }

  update(delta, camera = null) {
    if (this.provider) {
      // Dynamic day still advances time-of-day here so the env-map refresh signal
      // returned to GameRuntime keeps working once clouds own the sky.
      if (this.dynamicDay && Number.isFinite(delta) && delta > 0) {
        this.setTimeOfDay(this.timeOfDay + delta / this.dayLengthSeconds);
      }
      return this.provider.update(delta, camera);
    }

    if (!this.dynamicDay || !Number.isFinite(delta) || delta <= 0) return false;
    this.setTimeOfDay(this.timeOfDay + delta / this.dayLengthSeconds);
    const bucket = Math.floor(this.timeOfDay * 36);
    if (bucket === this._lastEnvironmentBucket) return false;
    this._lastEnvironmentBucket = bucket;
    return true;
  }

  setWeather(weather = 'clear') {
    const normalized = weather === 'fog' ? 'fog'
      : weather === 'overcast' ? 'overcast'
        : weather === 'rain' ? 'rain'
          : 'clear';
    this.weather = normalized;

    if (this.provider) {
      // K4a: skip auto cloud-type remap when shape/lighting/wind are user-pinned.
      // Always setWeather + applySunDirection so fog (no remap) and nested preset
      // weather commit still apply coverage/density (respecting per-id pins).
      const shapePinned = hasAnyUserOverrideInFolder('Clouds Shape')
        || hasAnyUserOverrideInFolder('Clouds Lighting')
        || hasAnyUserOverrideInFolder('Clouds Wind');

      if (!shapePinned) {
        if (normalized === 'rain' || normalized === 'overcast') {
          this.provider.setCloudPreset('stratus');
        } else if (normalized === 'clear') {
          this.provider.setCloudPreset(DEFAULT_CLOUD_TYPE);
        }
      }

      this.provider.setWeather(normalized);
      this.provider.applySunDirection(this.sunDirection, this.timeOfDay);
      return normalized;
    }

    if (!this.sky) return normalized;
    applyDomeWeatherProfile(this.sky, normalized, this.config);
    this.setTimeOfDay(this.timeOfDay);
    return normalized;
  }

  // Select the volumetric cloud morphology (cumulus / stratus / cirrus / …).
  // Only the volumetric provider renders distinct cloud shapes; the dome/off
  // SkyMesh path has no equivalent, so this is a no-op there. Returns the
  // applied type (or null when unsupported).
  setCloudPreset(preset = 'default') {
    return this.provider ? this.provider.setCloudPreset(preset) : null;
  }

  setVisible(visible) {
    if (this.provider) this.provider.setVisible(visible);
    else if (this.sky) this.sky.visible = Boolean(visible);
  }

  prepareEnvironment(renderer) {
    // Eagerly bake the atmosphere LUT before PMREM captures the env map, so the
    // env sky samples a populated transmittance table on first load.
    this.provider?.prepareEnvironment(renderer);
  }

  createEnvironmentScene() {
    if (this.provider) return this.provider.createEnvironmentScene();

    const environmentScene = new THREE.Scene();
    const environmentSky = createConfiguredSky(this.config, true);
    environmentSky.name = 'Sky IBL Source';
    environmentSky.scale.setScalar(50);
    environmentSky.sunPosition.value.copy(this.sunDirection).multiplyScalar(45);
    applyDomeWeatherProfile(environmentSky, this.weather, this.config);
    environmentSky.showSunDisc.value = false;
    environmentSky.frustumCulled = false;
    environmentScene.add(environmentSky);
    return environmentScene;
  }

  snapshot() {
    if (this.provider) return this.provider.snapshot();

    return {
      model: 'preetham',
      timeOfDay: round3(this.timeOfDay),
      visible: this.sky?.visible ?? false,
      sunDirection: this.sunDirection.toArray().map(round3),
      turbidity: this.sky?.turbidity.value ?? null,
      rayleigh: this.sky?.rayleigh.value ?? null,
      mieCoefficient: this.sky?.mieCoefficient.value ?? null,
      mieDirectionalG: this.sky?.mieDirectionalG.value ?? null,
      sunDiscVisibility: this.sky?.showSunDisc.value ?? 0,
      clouds: this.config.clouds ?? 'dome',
      cloudCoverage: this.sky?.cloudCoverage.value ?? 0,
      dynamicDay: this.dynamicDay,
    };
  }

  dispose() {
    this.provider?.dispose();
    this.provider = null;
    this.sky?.removeFromParent();
    this.sky?.geometry?.dispose();
    this.sky?.material?.dispose();
    this.sky = null;
  }
}

function resolveSkyDefaults(config) {
  return {
    turbidity: config.turbidity ?? BASE_SKY_DEFAULTS.turbidity,
    rayleigh: config.rayleigh ?? BASE_SKY_DEFAULTS.rayleigh,
    mieCoefficient: config.mieCoefficient ?? BASE_SKY_DEFAULTS.mieCoefficient,
    mieDirectionalG: config.mieDirectionalG ?? BASE_SKY_DEFAULTS.mieDirectionalG,
    cloudCoverage: config.cloudCoverage ?? BASE_SKY_DEFAULTS.cloudCoverage,
    cloudDensity: config.cloudDensity ?? BASE_SKY_DEFAULTS.cloudDensity,
    cloudScale: config.cloudScale ?? BASE_SKY_DEFAULTS.cloudScale,
    cloudSpeed: config.cloudSpeed ?? BASE_SKY_DEFAULTS.cloudSpeed,
    cloudElevation: config.cloudElevation ?? BASE_SKY_DEFAULTS.cloudElevation,
    sunDiscIntensity: config.sunDiscIntensity ?? BASE_SKY_DEFAULTS.sunDiscIntensity,
  };
}

function applyDomeWeatherProfile(sky, weather, config) {
  const profile = resolveDomeWeatherProfile(config, weather);
  sky.turbidity.value = profile.turbidity;
  sky.rayleigh.value = profile.rayleigh;
  sky.mieCoefficient.value = profile.mieCoefficient;
  sky.mieDirectionalG.value = profile.mieDirectionalG;
  sky.cloudCoverage.value = profile.cloudCoverage;
  sky.cloudDensity.value = profile.cloudDensity;
  sky.cloudScale.value = profile.cloudScale;
  sky.cloudSpeed.value = profile.cloudSpeed;
  sky.cloudElevation.value = profile.cloudElevation;
  sky.showSunDisc.value = profile.sunDiscVisibility;
}

// Pure profile resolution keeps the weather contract testable without creating
// a renderer. Solar-disc visibility is intentionally independent of the scene's
// DirectionalLight and HemisphereLight toggles.
export function resolveDomeWeatherProfile(config = {}, weather = 'clear') {
  const base = resolveSkyDefaults(config);
  const profile = WEATHER_SKY_PROFILE[weather] ?? null;
  const cloudsEnabled = config.clouds !== 'off';
  return {
    turbidity: profile?.turbidity ?? base.turbidity,
    rayleigh: profile?.rayleigh ?? base.rayleigh,
    mieCoefficient: profile?.mieCoefficient ?? base.mieCoefficient,
    mieDirectionalG: profile?.mieDirectionalG ?? base.mieDirectionalG,
    cloudCoverage: cloudsEnabled ? (profile?.cloudCoverage ?? base.cloudCoverage) : 0,
    cloudDensity: profile?.cloudDensity ?? base.cloudDensity,
    cloudScale: profile?.cloudScale ?? base.cloudScale,
    cloudSpeed: base.cloudSpeed,
    cloudElevation: profile?.cloudElevation ?? base.cloudElevation,
    sunDiscVisibility: base.sunDiscIntensity * (profile?.sunDiscScale ?? 1),
  };
}

function createConfiguredSky(config, includeClouds = false) {
  const sky = new SkyMesh();
  const base = resolveSkyDefaults(config);
  sky.turbidity.value = base.turbidity;
  sky.rayleigh.value = base.rayleigh;
  sky.mieCoefficient.value = base.mieCoefficient;
  sky.mieDirectionalG.value = base.mieDirectionalG;
  sky.cloudCoverage.value = includeClouds && config.clouds !== 'off' ? base.cloudCoverage : 0;
  sky.cloudDensity.value = base.cloudDensity;
  sky.cloudScale.value = base.cloudScale;
  sky.cloudSpeed.value = base.cloudSpeed;
  sky.cloudElevation.value = base.cloudElevation;
  // SkyMesh's physical disc is intentionally extremely bright. Keep enough HDR
  // energy for a defined sun and bloom without washing out the horizon.
  sky.showSunDisc.value = base.sunDiscIntensity;
  // The sky is the source behind atmospheric fog, not geometry to be fogged.
  // Fogging this camera-far mesh replaces the entire horizon with the scene fog
  // colour, which is especially obvious as a flat bright sheet at rainy night.
  sky.material.fog = false;
  return sky;
}

function computeSunDirection(timeOfDay, target) {
  // Full 24-hour solar arc: sunrise 06:00, zenith at noon, sunset 18:00,
  // nadir at midnight. The previous clamped arc held the sun at -4 degrees for
  // the whole night, leaving overcast skies in permanent bright twilight.
  const solarPhase = (wrap01(timeOfDay) - DAYLIGHT_START) * Math.PI * 2;
  const elevation = Math.sin(solarPhase) * THREE.MathUtils.degToRad(58);
  const azimuth = THREE.MathUtils.degToRad(70) + solarPhase;
  const horizontal = Math.cos(elevation);
  return target.set(
    Math.sin(azimuth) * horizontal,
    Math.sin(elevation),
    Math.cos(azimuth) * horizontal,
  ).normalize();
}

export function getSkyDaylightFactor(timeOfDay) {
  const solarPhase = (wrap01(timeOfDay) - DAYLIGHT_START) * Math.PI * 2;
  const elevationDegrees = Math.sin(solarPhase) * 58;
  return smoothstep(-6, 6, elevationDegrees);
}

function smoothstep(min, max, value) {
  const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

function wrap01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TIME_OF_DAY;
  return ((number % 1) + 1) % 1;
}

/** True between 06:00 and 18:00 on the normalized time-of-day clock. */
export function isDirectionalSunDaytime(timeOfDay) {
  const t = wrap01(timeOfDay);
  return t >= DAYLIGHT_START && t < DAYLIGHT_END;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
