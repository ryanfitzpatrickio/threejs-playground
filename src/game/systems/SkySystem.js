import * as THREE from 'three';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { CloudSkyProvider } from '../render/cloud/cloudSkyProvider.js';
import { normalizeCloudMode } from '../render/cloud/cloudConfig.js';

const DEFAULT_TIME_OF_DAY = 0.72;
const DEFAULT_SKY_SCALE = 450000;
const DEFAULT_SUN_DISTANCE = 1000;

// Accepted cloud modes. `volumetric` selects the new sky reference source pipeline
// (CloudSkyProvider); `dome`/`off` keep the existing SkyMesh path.
function readCloudsOverride() {
  try {
    const v = localStorage.getItem('dreamfall:clouds');
    return v === 'volumetric' || v === 'dome' || v === 'off' ? v : null;
  } catch (_) {
    return null;
  }
}

export class SkySystem {
  initialize(scene, { sun, hemisphere, qualityPreset = {} } = {}) {
    this.scene = scene;
    this.sun = sun;
    this.hemisphere = hemisphere;
    this.config = qualityPreset.environment ?? {};
    this.timeOfDay = this.config.timeOfDay ?? DEFAULT_TIME_OF_DAY;
    this.dynamicDay = this.config.dynamicDay === true;
    this.dayLengthSeconds = Math.max(60, this.config.dayLengthSeconds ?? 900);
    this._lastEnvironmentBucket = null;
    this.sunDirection = new THREE.Vector3();
    // Default sky is the simple SkyMesh dome clouds (preset `clouds: 'dome'`).
    // The experimental volumetric pipeline is opt-in: the debug-panel checkbox
    // sets the `dreamfall:clouds` localStorage override to 'volumetric' (and
    // reloads), which wins over the preset here.
    this.cloudMode = normalizeCloudMode(readCloudsOverride() ?? this.config.clouds);

    if (this.cloudMode === 'volumetric') {
      this.provider = new CloudSkyProvider().initialize(scene, { sun, hemisphere, qualityPreset });
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
      return this.sunDirection;
    }

    this.sky?.sunPosition.value.copy(this.sunDirection).multiplyScalar(DEFAULT_SKY_SCALE * 0.9);

    if (this.sun) {
      this.sun.position.copy(this.sunDirection).multiplyScalar(DEFAULT_SUN_DISTANCE);
      this.sun.target.position.set(0, 0, 0);
      this.sun.color.set(this.config.sunColor ?? 0xffe4b5);
      this.sun.intensity = this.config.sunIntensity ?? 4.2;
    }
    if (this.hemisphere) {
      this.hemisphere.color.set(this.config.hemisphereSkyColor ?? 0xb9d8ff);
      this.hemisphere.groundColor.set(this.config.hemisphereGroundColor ?? 0x776653);
      this.hemisphere.intensity = this.config.hemisphereIntensity ?? 1.6;
    }
    return this.sunDirection;
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

    if (this.provider) {
      this.provider.setWeather(normalized);
      return normalized;
    }

    if (!this.sky) return normalized;
    const cloudsEnabled = this.config.clouds !== 'off';
    // Rain reads as a fuller overcast than plain 'overcast' — heavier coverage,
    // same density.
    this.sky.cloudCoverage.value = !cloudsEnabled
      ? 0
      : normalized === 'rain' ? 0.9
        : normalized === 'overcast' ? 0.82
          : normalized === 'fog' ? 0.68
            : this.config.cloudCoverage ?? 0.42;
    this.sky.cloudDensity.value = (normalized === 'overcast' || normalized === 'rain') ? 0.82 : this.config.cloudDensity ?? 0.52;
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

function createConfiguredSky(config, includeClouds = false) {
  const sky = new SkyMesh();
  sky.turbidity.value = config.turbidity ?? 3.2;
  sky.rayleigh.value = config.rayleigh ?? 1.7;
  sky.mieCoefficient.value = config.mieCoefficient ?? 0.006;
  sky.mieDirectionalG.value = config.mieDirectionalG ?? 0.82;
  sky.cloudCoverage.value = includeClouds && config.clouds !== 'off' ? config.cloudCoverage ?? 0.42 : 0;
  sky.cloudDensity.value = config.cloudDensity ?? 0.52;
  sky.cloudScale.value = config.cloudScale ?? 0.00016;
  sky.cloudSpeed.value = config.cloudSpeed ?? 0.000035;
  sky.cloudElevation.value = config.cloudElevation ?? 0.34;
  // SkyMesh's physical disc is intentionally extremely bright. Keep enough HDR
  // energy for a defined sun and bloom without washing out the horizon.
  sky.showSunDisc.value = config.sunDiscIntensity ?? 0.16;
  return sky;
}

function computeSunDirection(timeOfDay, target) {
  // Daylight spans 06:00–18:00. The azimuth advances with time while elevation
  // follows a smooth solar arc. Values outside daylight remain just below horizon.
  const daylight = THREE.MathUtils.clamp((timeOfDay - 0.25) / 0.5, 0, 1);
  const elevation = Math.sin(daylight * Math.PI) * THREE.MathUtils.degToRad(58)
    - THREE.MathUtils.degToRad(4);
  const azimuth = THREE.MathUtils.degToRad(70 + daylight * 190);
  const horizontal = Math.cos(elevation);
  return target.set(
    Math.sin(azimuth) * horizontal,
    Math.sin(elevation),
    Math.cos(azimuth) * horizontal,
  ).normalize();
}

function wrap01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TIME_OF_DAY;
  return ((number % 1) + 1) % 1;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
