// CloudSkyProvider — facade owning the sky reference source volumetric sky + cloud pipeline.
//
// M2 scope: M1's atmosphere LUT + LUT sky mesh, PLUS the volumetric cloud march
// (CloudMarchNode) and composite. Noise textures (3D Worley base shape + 2D
// weather map) are generated once at init; cloud-shape params are pushed into
// the shared `cloudUniforms`. The march node is created per-render-pipeline (it
// needs the live camera) via `createMarchNode`, and `composeOutputNode` builds
// the blend-over-scene Fn the renderer inserts into its post chain.
//
// Sky mesh: a tiny BackSide sphere recentered on the camera each frame so
// `positionWorld - cameraPosition` reduces to a pure direction. Sun direction
// is computed by SkySystem and passed in via `applySunDirection`.

import * as THREE from 'three';
import { texture, texture3D } from 'three/tsl';
import { AtmosphereLUTNode } from './atmosphereLUT.js';
import { createSkyMaterial } from './cloudSkyMaterial.js';
import { CloudMarchNode } from './cloudMarchNode.js';
import { CloudTemporalNode } from './cloudTemporalNode.js';
import { CloudShadowNode } from './cloudShadowNode.js';
import { GodRaysNode } from './godRaysNode.js';
import { createCloudCompositeOutputNode } from './cloudCompositeNode.js';
import { createGodRaysCompositeNode } from './godRaysCompositeNode.js';
import { generateBaseShape3D, generateWeatherMap } from './cloudNoise.js';
import {
  resolveCloudConfig,
  resolveCloudTypePreset,
  CLOUD_TYPE_PRESETS,
  DEFAULT_CLOUD_TYPE,
} from './cloudConfig.js';
import { terrainHazeColor } from '../../systems/terrainAerialUniforms.js';
import { uCloudMaxMarchDist } from './cloudReachUniforms.js';
import {
  uSunDirection,
  uSunIntensity,
  uSunColor,
  uSunDiscSize,
  uAtmosphereRayleigh,
  uAtmosphereTurbidity,
  uAtmosphereMieG,
  uAtmosphereMieStrength,
  uAtmosphereSkyMultiScatter,
  uSkyDarkness,
  uCameraPos,
  uWindOffset,
  uWindDirection,
  uWindSkew,
  uEvolution,
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
} from './cloudUniforms.js';

const DEFAULT_TIME_OF_DAY = 0.72;
const DEFAULT_SUN_DISTANCE = 1000;
const TWILIGHT_DEG = 6;
const WEATHER_LIGHT_SCALE = Object.freeze({ clear: 1, fog: 0.66, overcast: 0.64, rain: 0.5 });

const _windDir = /*@__PURE__*/ new THREE.Vector3();
const _lastCameraPosition = /*@__PURE__*/ new THREE.Vector3();
const _lastCameraQuaternion = /*@__PURE__*/ new THREE.Quaternion();
// Per-frame rotation above this clears temporal history (fast look/spin otherwise
// reprojects stale cloud samples into the sky band and reads as black flicker).
const CAMERA_ROTATION_HISTORY_RESET_RAD = 0.28;
// World translation (m) before history reset — avoid clearing on every small step.
const CAMERA_POSITION_HISTORY_RESET_M = 55;

export class CloudSkyProvider {
  initialize(scene, { sun = null, hemisphere = null, qualityPreset = {} } = {}) {
    this.scene = scene;
    this.sun = sun;
    this.hemisphere = hemisphere;
    this.config = resolveCloudConfig(qualityPreset, { force: true });
    this.weather = 'clear';
    this.timeOfDay = qualityPreset.environment?.timeOfDay ?? DEFAULT_TIME_OF_DAY;

    // --- Atmosphere + sun uniforms (M1) ---
    const atmo = this.config.atmosphere ?? {};
    if (atmo.rayleigh != null) uAtmosphereRayleigh.value = atmo.rayleigh;
    if (atmo.turbidity != null) uAtmosphereTurbidity.value = atmo.turbidity;
    if (atmo.mieDirectionalG != null) uAtmosphereMieG.value = atmo.mieDirectionalG;
    if (atmo.mieScatteringStrength != null) uAtmosphereMieStrength.value = atmo.mieScatteringStrength;
    if (atmo.skyMultipleScattering != null) uAtmosphereSkyMultiScatter.value = atmo.skyMultipleScattering;
    const sunCfg = this.config.sun ?? {};
    if (sunCfg.color) uSunColor.value.setRGB(sunCfg.color[0], sunCfg.color[1], sunCfg.color[2]);
    if (sunCfg.discSize != null) uSunDiscSize.value = sunCfg.discSize;
    this._peakSunIntensity = sunCfg.intensity ?? uSunIntensity.value;

    this.atmosphereLUT = new AtmosphereLUTNode();
    this.skyMaterial = createSkyMaterial(
      this.atmosphereLUT.getTextureNode(),
      this.atmosphereLUT.getMultiScatterNode(),
    );
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.skyMaterial);
    this.skyMesh.name = 'CloudSky.Sky';
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -1000;
    scene.add(this.skyMesh);

    // --- Cloud shape uniforms + noise textures (M2) ---
    const vc = qualityPreset.environment?.volumetricClouds ?? {};
    const shape = this.config.cloud?.shape ?? {};
    const lighting = this.config.cloud?.lighting ?? {};
    uCloudAltitude.value = shape.altitude ?? 1200;
    uCloudThickness.value = shape.thickness ?? 1800;
    uCloudCoverage.value = shape.coverage ?? 0.5;
    uCloudDensity.value = shape.density ?? 0.02;
    uCloudWeatherScale.value = shape.weatherScale ?? 6000;
    uCloudBaseScale.value = shape.baseScale ?? 1800;
    const baseScale = uCloudBaseScale.value;
    uCloudErosionScale.value = baseScale * (shape.erosionScaleBaseMultiplier ?? 0.28);
    uCloudBaseStrength.value = shape.baseStrength ?? 0.69;
    uCloudErosionStrengthBase.value = shape.erosionStrengthBase ?? 0.24;
    uCloudErosionStrengthPeak.value = shape.erosionStrengthPeak ?? 2.15;
    uCloudErosionShape.value = shape.erosionShape ?? 1;
    uCloudEdgeSoftness.value = shape.edgeSoftness ?? 0.095;
    uCloudEdgeSoftnessFalloff.value = shape.edgeSoftnessFalloff ?? 1;
    uCloudScatteringAlbedo.value = lighting.scatteringAlbedo ?? 1;
    uCloudPowderStrength.value = lighting.powderStrength ?? 0.7;
    uCloudAmbientIntensity.value = lighting.ambientIntensity ?? 0.48;

    this._marchSteps = vc.marchSteps ?? 48;
    this._lightTaps = vc.lightTaps ?? 3;
    this._renderScale = vc.renderScale ?? 0.5;
    this._baseShapeDims = vc.baseShapeDims ?? 32;
    this._shadowResolution = vc.shadowResolution ?? 512;
    this._shadowExtent = vc.shadowExtent ?? 3200;
    this._shadowSteps = vc.shadowSteps ?? 12;
    this._godRaysEnabled = vc.godRays === true;
    this._godRaySteps = vc.godRaySteps ?? 24;
    this._lightStepSize = 12;
    // Capped each frame via syncCloudReach(viewDistance) from GameRuntime.
    this._maxMarchDist = vc.maxMarchDist ?? 16000;
    uCloudMaxMarchDist.value = this._maxMarchDist;

    this.baseShapeTexture = generateBaseShape3D(this._baseShapeDims);
    this.weatherTexture = generateWeatherMap(vc.weatherMapResolution ?? 512, 0);
    this.weatherNode = texture(this.weatherTexture);
    this.baseShapeNode = texture3D(this.baseShapeTexture);

    // Wind direction from heading (degrees).
    const wind = this.config.cloud?.wind ?? {};
    this._windHeading = wind.heading ?? 0;
    this._windSpeed = wind.speed ?? 0;
    this._evolutionSpeed = wind.evolutionSpeed ?? 0;
    headingToVector(this._windHeading, _windDir);
    uWindDirection.value.copy(_windDir);
    uWindSkew.value = wind.skew ?? 350;
    this._hasCameraPosition = false;
    this._hasCameraRotation = false;
    this._camera = null;

    // Cloud morphology preset. Always apply the resolved type at init (the
    // uniforms written above are just the raw DEFAULT_CLOUD_PARAMS fallback) so
    // the initial look matches the tuned 'default' preset, and a quality preset
    // can pin any named type via environment.cloudType.
    const requested = qualityPreset.environment?.cloudType;
    this.setCloudPreset(CLOUD_TYPE_PRESETS[requested] ? requested : DEFAULT_CLOUD_TYPE);

    return this;
  }

  // Glue the sky sphere to the live camera so `positionWorld - cameraPosition`
  // stays a pure direction at render time. A scene-root mesh that only copies
  // camera.position during update() lags by a frame (camera moves after update),
  // and on a radius-1 BackSide sphere the camera quickly sits outside the mesh
  // → holes of cleared background (black) when moving or spinning fast.
  attachToCamera(camera) {
    if (!camera || !this.skyMesh) return;
    if (this._camera === camera && this.skyMesh.parent === camera) return;
    this._camera = camera;
    this.skyMesh.removeFromParent();
    camera.add(this.skyMesh);
    this.skyMesh.position.set(0, 0, 0);
    this.clearHistory();
    this._hasCameraPosition = false;
    this._hasCameraRotation = false;
  }

  applySunDirection(sunDirection, timeOfDay) {
    this.timeOfDay = timeOfDay;
    uSunDirection.value.copy(sunDirection);

    const elevation = Math.asin(THREE.MathUtils.clamp(sunDirection.y, -1, 1));
    const elevDeg = THREE.MathUtils.radToDeg(elevation);
    const day = smoothstep(-TWILIGHT_DEG, TWILIGHT_DEG, elevDeg);
    const weatherScale = WEATHER_LIGHT_SCALE[this.weather] ?? 1;
    uSunIntensity.value = this._peakSunIntensity * day * weatherScale;
    uSkyDarkness.value = 1 - day;

    // Cloud lighting helpers: sun tint + ambient sky color, scaled by daylight.
    // M6 refines these from the real transmittance LUT; M2 uses a constant sky
    // blue and the sun color attenuated by the day factor.
    uSunTint.value.copy(uSunColor.value).multiplyScalar(day * weatherScale);
    // Zenith/horizon sky blue for cloud ambient fill (not grey haze).
    uCloudAmbientColor.value.setRGB(0.34, 0.56, 0.96)
      .multiplyScalar((0.22 + 0.78 * day) * weatherScale);
    terrainHazeColor.value.copy(uCloudAmbientColor.value);

    if (this.sun) {
      this.sun.position.copy(sunDirection).multiplyScalar(DEFAULT_SUN_DISTANCE);
      this.sun.target.position.set(0, 0, 0);
      this.sun.color.copy(uSunColor.value);
      this.sun.intensity = 4.2 * day * weatherScale;
    }
    if (this.hemisphere) {
      this.hemisphere.intensity = 1.6 * (0.08 + 0.92 * day) * weatherScale;
    }
  }

  update(delta, camera) {
    if (!camera) return false;
    this.attachToCamera(camera);
    const position = camera.position;
    if (this._hasCameraPosition && _lastCameraPosition.distanceToSquared(position) > CAMERA_POSITION_HISTORY_RESET_M * CAMERA_POSITION_HISTORY_RESET_M) {
      this.clearHistory();
    }
    if (this._hasCameraRotation) {
      const rotationDelta = _lastCameraQuaternion.angleTo(camera.quaternion);
      if (rotationDelta > CAMERA_ROTATION_HISTORY_RESET_RAD) {
        this.clearHistory();
      }
    }
    _lastCameraPosition.copy(position);
    _lastCameraQuaternion.copy(camera.quaternion);
    this._hasCameraPosition = true;
    this._hasCameraRotation = true;
    uCameraPos.value.copy(position);
    this._shadowNode?.setCenter(position);

    if (Number.isFinite(delta) && delta > 0) {
      uWindOffset.value.addScaledVector(_windDir, this._windSpeed * delta);
      uEvolution.value += this._evolutionSpeed * delta;
    }
    return false;
  }

  setWeather(weather = 'clear') {
    this.weather = weather;
    const profiles = {
      clear: { coverage: this.config.cloud.shape.coverage, density: this.config.cloud.shape.density },
      overcast: { coverage: 0.8, density: 0.024 },
      fog: { coverage: 0.66, density: 0.021 },
      rain: { coverage: 0.85, density: 0.024 },
    };
    const profile = profiles[weather] ?? profiles.clear;
    uCloudCoverage.value = profile.coverage;
    uCloudDensity.value = profile.density;
    this.clearHistory();
    return weather;
  }

  // Switch cloud morphology (cumulus / stratus / cirrus / storm / …) live. This
  // rewrites the uniform-backed shape/lighting/wind params and re-layers the
  // currently-selected weather (which only modulates coverage/density) on top,
  // so cloud type and weather stay orthogonal. Instant — no LUT re-bake or
  // pipeline rebuild.
  setCloudPreset(name = DEFAULT_CLOUD_TYPE) {
    const resolved = resolveCloudTypePreset(name);
    this._cloudType = CLOUD_TYPE_PRESETS[name] ? name : DEFAULT_CLOUD_TYPE;
    // Keep the resolved shape/lighting/wind as the config baseline so setWeather's
    // 'clear' profile (which reads config.cloud.shape) follows the chosen type.
    this.config.cloud.shape = resolved.shape;
    this.config.cloud.lighting = resolved.lighting;
    this.config.cloud.wind = resolved.wind;
    this._applyCloudShapeUniforms(resolved);
    this.setWeather(this.weather);
    return this._cloudType;
  }

  get cloudType() {
    return this._cloudType ?? DEFAULT_CLOUD_TYPE;
  }

  _applyCloudShapeUniforms({ shape, lighting, wind }) {
    uCloudAltitude.value = shape.altitude;
    uCloudThickness.value = shape.thickness;
    uCloudCoverage.value = shape.coverage;
    uCloudDensity.value = shape.density;
    uCloudWeatherScale.value = shape.weatherScale;
    uCloudBaseScale.value = shape.baseScale;
    uCloudErosionScale.value = shape.baseScale * (shape.erosionScaleBaseMultiplier ?? 0.28);
    uCloudBaseStrength.value = shape.baseStrength;
    uCloudErosionStrengthBase.value = shape.erosionStrengthBase;
    uCloudErosionStrengthPeak.value = shape.erosionStrengthPeak;
    uCloudErosionShape.value = shape.erosionShape;
    uCloudEdgeSoftness.value = shape.edgeSoftness;
    uCloudEdgeSoftnessFalloff.value = shape.edgeSoftnessFalloff;
    uCloudScatteringAlbedo.value = lighting.scatteringAlbedo;
    uCloudPowderStrength.value = lighting.powderStrength;
    uCloudAmbientIntensity.value = lighting.ambientIntensity;
    // Wind: heading→direction vector + skew uniform; speeds are provider-owned
    // and consumed per frame in update().
    this._windHeading = wind.heading;
    this._windSpeed = wind.speed;
    this._evolutionSpeed = wind.evolutionSpeed;
    headingToVector(this._windHeading, _windDir);
    uWindDirection.value.copy(_windDir);
    uWindSkew.value = wind.skew;
  }

  setVisible(visible) {
    if (this.skyMesh) this.skyMesh.visible = Boolean(visible);
  }

  prepareEnvironment(renderer) {
    this.atmosphereLUT?.bake(renderer);
  }

  // Build the per-pipeline cloud pass (march + temporal accumulation) and
  // return the composite that blends it over the scene. `track` registers each
  // node for disposal + so their updateBefore fires; the renderer passes its
  // `trackedNodes.push`-equivalent.
  buildCloudPass({ sceneColor, sceneDepth, camera, track, sceneColorIsTexture = true }) {
    const shadowNode = new CloudShadowNode({
      weatherNode: this.weatherNode,
      baseShapeNode: this.baseShapeNode,
      resolution: this._shadowResolution,
      extent: this._shadowExtent,
      steps: this._shadowSteps,
      updateInterval: this._godRaysEnabled ? 1 : 2,
    });
    shadowNode.setCenter(camera.position);
    const marchNode = new CloudMarchNode({
      camera,
      weatherNode: this.weatherNode,
      baseShapeNode: this.baseShapeNode,
      steps: this._marchSteps,
      lightTaps: this._lightTaps,
      lightStepSize: this._lightStepSize,
      maxMarchDist: this._maxMarchDist,
      renderScale: this._renderScale,
    });
    const temporalNode = new CloudTemporalNode({
      camera,
      marchNode,
      renderScale: this._renderScale,
      blend: 0.24,
    });
    this._shadowNode = shadowNode;
    this._marchNode = marchNode;
    this._temporalNode = temporalNode;
    track(shadowNode);
    track(marchNode);
    track(temporalNode);
    let outputNode = createCloudCompositeOutputNode({
      sceneColor,
      sceneDepth,
      camera,
      cloudTexture: temporalNode.getTextureNode(),
      sceneColorIsTexture,
    });
    if (this._godRaysEnabled) {
      const godRaysNode = new GodRaysNode({
        camera,
        shadowNode,
        sceneDepth,
        steps: this._godRaySteps,
      });
      this._godRaysNode = godRaysNode;
      track(godRaysNode);
      outputNode = createGodRaysCompositeNode({
        baseColor: outputNode,
        sceneDepth,
        cloudTexture: temporalNode.getTextureNode(),
        raysTexture: godRaysNode.getTextureNode(),
        camera,
      });
    }
    return outputNode;
  }

  clearHistory() {
    this._temporalNode?.clearHistory();
  }

  uninstallPostNodes() {
    this._marchNode = null;
    this._temporalNode = null;
    this._shadowNode = null;
    this._godRaysNode = null;
  }

  get cloudShadow() {
    return this._shadowNode
      ? {
        texture: this._shadowNode.getShadowTexture(),
        projection: this._shadowNode.projection,
      }
      : null;
  }

  createEnvironmentScene() {
    const envScene = new THREE.Scene();
    const material = createSkyMaterial(
      this.atmosphereLUT.getTextureNode(),
      this.atmosphereLUT.getMultiScatterNode(),
      { sunDisc: false },
    );
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
    sky.name = 'CloudSky.EnvSource';
    sky.scale.setScalar(50);
    sky.frustumCulled = false;
    envScene.add(sky);
    return envScene;
  }

  snapshot() {
    return {
      model: 'volumetric',
      timeOfDay: round3(this.timeOfDay),
      visible: this.skyMesh?.visible ?? false,
      sunDirection: uSunDirection.value.toArray().map(round3),
      rayleigh: uAtmosphereRayleigh.value,
      turbidity: uAtmosphereTurbidity.value,
      mieG: uAtmosphereMieG.value,
      sunIntensity: round3(uSunIntensity.value),
      skyDarkness: round3(uSkyDarkness.value),
      clouds: 'volumetric',
      cloudType: this.cloudType,
      cloudCoverage: round3(uCloudCoverage.value),
      cloudAltitude: uCloudAltitude.value,
      marchSteps: this._marchSteps,
      renderScale: this._renderScale,
      temporal: Boolean(this._temporalNode),
      shadowResolution: this._shadowResolution,
      godRays: this._godRaysEnabled,
      dynamicDay: false,
    };
  }

  dispose() {
    this.uninstallPostNodes();
    this.skyMesh?.removeFromParent();
    this.skyMesh?.geometry?.dispose();
    this.skyMaterial?.dispose();
    this.atmosphereLUT?.dispose();
    this.baseShapeTexture?.dispose();
    this.weatherTexture?.dispose();
    this.skyMesh = null;
    this.skyMaterial = null;
    this.atmosphereLUT = null;
    this.baseShapeTexture = null;
    this.weatherTexture = null;
  }
}

function headingToVector(headingDeg, target) {
  const h = THREE.MathUtils.degToRad(headingDeg);
  return target.set(Math.sin(h), 0, Math.cos(h));
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
