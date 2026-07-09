import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Lighting,
  NoToneMapping,
  PCFShadowMap,
  PMREMGenerator,
  RenderPipeline,
  SRGBColorSpace,
  RGBAFormat,
  UnsignedByteType,
  WebGPURenderer,
  Vector3,
  Quaternion,
} from 'three/webgpu';
import { ClusteredLighting } from 'three/examples/jsm/lighting/ClusteredLighting.js';
import { ssr } from 'three/examples/jsm/tsl/display/SSRNode.js';
import { ssao } from '../../three-addons/tsl/display/SSAONode.js';
import { dualKawaseBloom } from '../../three-addons/tsl/display/DualKawaseBloomNode.js';
import { getPostEffectMode, getRecommendedFogMaxDistance, getToneMappingMode, mergeQualityPresetForScene } from '../config/qualityPresets.js';
import { normalizeAerialHazeColor } from '../config/photorealismPresets.js';
import { syncTerrainAerialUniforms, syncTerrainViewDistance } from './terrainAerialUniforms.js';
import { buildPostPipelinePlan } from '../render/postPipelinePlan.js';
import { DrawCallProfiler } from '../render/drawCallProfiler.js';
import { CITY_FURNITURE_LAYER } from '../render/renderLayers.js';
import {
  Fn,
  Loop,
  builtinAOContext,
  clamp,
  distance,
  exp,
  float,
  getViewPosition,
  min,
  mix,
  materialMetalness,
  materialRoughness,
  mrt,
  mx_noise_float,
  normalize,
  normalView,
  output,
  packNormalToRGB,
  pass,
  sample,
  screenUV,
  saturation,
  smoothstep,
  time,
  uniform,
  unpackRGBToNormal,
  vibrance,
  vec3,
  vec4,
} from 'three/tsl';

const DEFAULT_LIGHTING_MODE = 'hemisphere';
const DEFAULT_EXPOSURE = 1.0;
const WEATHER_EXPOSURE_SCALE = Object.freeze({
  clear: 1,
  fog: 0.76,
  overcast: 0.74,
  rain: 0.72,
});
const WEATHER_ENVIRONMENT_SCALE = Object.freeze({
  clear: 1,
  fog: 0.68,
  overcast: 0.62,
  rain: 0.62,
});
// Shared with SkySystem.setWeather/WeatherSystem — the full set of weather
// states this game recognizes. Kept as a single source of truth here since
// RendererSystem is the first thing to normalize an incoming weather string.
export const WEATHER_STATES = new Set(['clear', 'fog', 'overcast', 'rain']);

export class RendererSystem {
  constructor({ canvas, qualityPreset = {} }) {
    this.canvas = canvas;
    this.qualityPreset = qualityPreset;
    this.backend = 'uninitialized';
    this.viewport = {
      width: 1,
      height: 1,
      aspect: 1,
    };
    this.lightingMode = DEFAULT_LIGHTING_MODE;
    this.clusteredLighting = null;
    this.defaultLighting = null;
    this.fogEnabled = false;
    this.weather = 'clear';
    this.aerialPerspectiveEnabled = true;
    this.aerialHazeColor = [0.32, 0.42, 0.48];
    this.viewDistance = null;
    this.fogMarchSteps = 16;
    this.fogMaxDistance = 165; // overwritten in initialize() via getRecommendedFogMaxDistance
    this.environmentRenderTarget = null;
    this.exposure = DEFAULT_EXPOSURE;
    this.baseExposure = DEFAULT_EXPOSURE;
    this.requestedPostEffectMode = 'ssao';
    this.postPipelinePlan = null;
    // Volumetric sky/cloud provider (set by GameRuntime when SkySystem is in
    // 'volumetric' mode). When present, the cloud composite subsumes the
    // aerial-perspective output node in ensureRenderPipeline.
    this.cloudSkyProvider = null;
    // Pass/effect nodes owned by the current pipeline. RenderPipeline.dispose()
    // does not free the output-node chain's render targets, so we track them
    // here and dispose them on invalidate.
    this._pipelineNodes = [];
    // Notified after invalidatePipeline(). WebGPU captures mesh.count into an
    // InstancedMesh's instance binding at pipeline-build time, so a rebuild
    // (weather/env change, resize) strands crowds that vary count per frame —
    // listeners re-prime those bindings so animated instances don't flicker out.
    this.onPipelineInvalidated = null;
    this.lastFrameDrawCalls = 0;
    this.lastFrameTriangles = 0;
    this.drawCallProfiler = new DrawCallProfiler();
    this.drawProfileCounter = 0;
    this.sceneContext = 'exterior';
    this._aoCameraPos = new Vector3();
    this._aoCameraQuat = new Quaternion();
    this._aoCameraValid = false;
    this._renderCamera = null;
  }

  setViewDistance(distance) {
    if (!Number.isFinite(distance) || distance <= 0) return;
    if (this.viewDistance === distance) return;
    this.viewDistance = distance;
    this.invalidatePipeline();
  }

  getActiveQualityPreset() {
    return mergeQualityPresetForScene(this.qualityPreset, this.sceneContext);
  }

  setSceneContext(context = 'exterior') {
    const normalized = context === 'interior' ? 'interior' : 'exterior';
    if (this.sceneContext === normalized) return this.snapshot();
    this.sceneContext = normalized;
    const activePreset = this.getActiveQualityPreset();
    this.postPipelinePlan = buildPostPipelinePlan({
      requestedMode: this.requestedPostEffectMode,
      qualityPreset: activePreset,
      backend: this.backend,
      sceneContext: normalized,
    });
    this.invalidatePipeline();
    this.resizeIfNeeded();
    return this.snapshot();
  }

  async initialize() {
    const preset = this.getActiveQualityPreset();
    const environmentPreset = preset.environment ?? {};
    this.weather = environmentPreset.weather ?? 'clear';
    this.fogEnabled = this.weather === 'fog';
    this.aerialPerspectiveEnabled = environmentPreset.aerialPerspective !== false;
    this.aerialHazeColor = normalizeAerialHazeColor(environmentPreset.aerialHazeColor);
    syncTerrainAerialUniforms(environmentPreset);
    this.fogMarchSteps = preset.fogMarchSteps ?? 16;
    this.fogMaxDistance = preset.fogMaxDistance ?? getRecommendedFogMaxDistance(preset);
    const maxPixelRatio = preset.maxPixelRatio ?? 2;

    // The terrain biome material binds 12 textures; combined with the clipmap
    // shadow levels (one texture each) the fragment stage exceeds the WebGPU
    // baseline limit of 16 sampled textures. Most desktop GPUs allow far more, so
    // request a higher limit — but only up to what THIS adapter actually supports,
    // since requestDevice rejects an over-spec request (which would kill rendering).
    let requiredLimits;
    try {
      const adapter = await globalThis.navigator?.gpu?.requestAdapter?.({ powerPreference: 'high-performance' });
      const lim = adapter?.limits ?? {};
      const req = {};
      // Only request UP TO what the adapter supports — over-requesting fails device
      // creation. On Apple/Metal the sampler max is usually 16 (hard), so this often
      // no-ops there; the terrain material is sized to fit 16 samplers regardless.
      if ((lim.maxSampledTexturesPerShaderStage ?? 16) > 16) {
        req.maxSampledTexturesPerShaderStage = Math.min(lim.maxSampledTexturesPerShaderStage, 48);
      }
      if ((lim.maxSamplersPerShaderStage ?? 16) > 16) {
        req.maxSamplersPerShaderStage = Math.min(lim.maxSamplersPerShaderStage, 32);
      }
      if (Object.keys(req).length > 0) requiredLimits = req;
    } catch {
      // Fall back to defaults if adapter probing isn't available.
    }

    this.renderer = new WebGPURenderer({
      canvas: this.canvas,
      antialias: preset.antialias !== false,
      alpha: false,
      powerPreference: 'high-performance',
      requiredLimits,
    });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, maxPixelRatio));
    this.renderer.shadowMap.enabled = preset.shadows === true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;
    const toneMappingMode = environmentPreset.toneMapping ?? getToneMappingMode();
    this.renderer.toneMapping = toneMappingMode === 'AgX'
      ? AgXToneMapping
      : toneMappingMode === 'None'
        ? NoToneMapping
        : ACESFilmicToneMapping;
    this.baseExposure = environmentPreset.exposure ?? DEFAULT_EXPOSURE;
    this._applyWeatherExposure();
    this.resizeIfNeeded();
    await this.renderer.init();
    // Clustered light-culling globally, so scenes (especially office interiors)
    // can use many physical lights without the forward-renderer light cap. This
    // is the culling BACKEND and is independent of the hemisphere/clustered *look*
    // mode (streetlights/sky), which lives in SceneSystem.
    this.defaultLighting = this.renderer.lighting ?? new Lighting();
    this.clusteredLighting ??= new ClusteredLighting(128, 32, 16, 32);
    this.renderer.lighting = this.clusteredLighting;
    this.backend = resolveRendererBackend(this.renderer);
    this.requestedPostEffectMode = getPostEffectMode();
    this.postPipelinePlan = buildPostPipelinePlan({
      requestedMode: this.requestedPostEffectMode,
      qualityPreset: preset,
      backend: this.backend,
      sceneContext: this.sceneContext,
    });
  }

  installEnvironment(scene, skySystem = null) {
    if (!scene || !this.renderer) return null;

    this.environmentRenderTarget?.dispose();
    // Volumetric-sky path: bake the atmosphere LUT first so the env sky samples
    // a populated transmittance table (no-op for the SkyMesh path).
    skySystem?.prepareEnvironment?.(this.renderer);
    const environmentScene = skySystem?.createEnvironmentScene?.();
    if (!environmentScene) return null;
    const generator = new PMREMGenerator(this.renderer);
    try {
      this.environmentRenderTarget = generator.fromScene(
        environmentScene,
        0.02,
        0.1,
        100,
        { size: this.qualityPreset.environment?.environmentMapSize ?? 128 },
      );
      scene.environment = this.environmentRenderTarget.texture;
      const baseIntensity = this.qualityPreset.environment?.environmentIntensity ?? 0.45;
      scene.environmentIntensity = baseIntensity * (WEATHER_ENVIRONMENT_SCALE[this.weather] ?? 1);
      scene.environmentRotation.y = 0;
      return scene.environment;
    } finally {
      generator.dispose();
      disposeEnvironmentScene(environmentScene);
    }
  }

  setLightingMode(mode = 'hemisphere') {
    const normalizedMode = mode === 'clustered' ? 'clustered' : 'hemisphere';
    if (this.lightingMode === normalizedMode) {
      return this.snapshot();
    }

    // The clustered culling backend stays on globally in both look modes; only the
    // snapshot label changes here (the streetlight/sky look lives in SceneSystem).
    this.clusteredLighting ??= new ClusteredLighting(128, 32, 16, 32);
    this.renderer.lighting = this.clusteredLighting;
    this.lightingMode = normalizedMode;
    return this.snapshot();
  }

  toggleLightingMode() {
    return this.setLightingMode(this.lightingMode === 'clustered' ? 'hemisphere' : 'clustered');
  }

  resizeIfNeeded(onResize) {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const pixelRatio = Math.min(globalThis.devicePixelRatio ?? 1, this.getActiveQualityPreset().maxPixelRatio ?? 2);
    const targetWidth = Math.floor(width * pixelRatio);
    const targetHeight = Math.floor(height * pixelRatio);

    if (this.canvas.width === targetWidth && this.canvas.height === targetHeight) {
      return;
    }

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.viewport = {
      width,
      height,
      aspect: width / height,
    };
    onResize?.(this.viewport);
  }

  getViewport() {
    return this.viewport;
  }

  snapshot({ includeDrawStats = true } = {}) {
    const info = this.renderer?.info;
    return {
      api: 'webgpu',
      backend: this.backend,
      initialized: Boolean(this.renderer),
      lightingMode: this.lightingMode,
      fogEnabled: this.fogEnabled,
      weather: this.weather,
      aerialPerspective: this.aerialPerspectiveEnabled,
      bloom: this.qualityPreset.environment?.bloom === true,
      bloomImplementation: this.postPipelinePlan?.bloom?.implementation ?? null,
      bloomResolutionScale: this.postPipelinePlan?.bloom?.resolutionScale ?? null,
      ssr: this.postPipelinePlan?.effectiveMode === 'ssr',
      postEffectModeRequested: this.requestedPostEffectMode,
      postEffectMode: this.postPipelinePlan?.effectiveMode ?? 'off',
      ssao: this.postPipelinePlan?.ssao ?? null,
      sceneContext: this.sceneContext,
      normalPrePassAllocated: this.postPipelinePlan?.normalPrePass === true,
      ssrMrtAllocated: this.postPipelinePlan?.ssrMrt === true,
      fogMarchSteps: this.fogMarchSteps,
      fogMaxDistance: this.fogMaxDistance,
      toneMapping: this.renderer?.toneMapping === AgXToneMapping
        ? 'AgX'
        : this.renderer?.toneMapping === ACESFilmicToneMapping ? 'ACESFilmic' : 'None',
      exposure: this.exposure,
      baseExposure: this.baseExposure,
      shadows: this.renderer?.shadowMap?.enabled ?? false,
      webgpuAvailable: Boolean(globalThis.navigator?.gpu),
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      // Per-frame GPU draw calls / triangle count from the last render() call.
      // `info.render.calls` is lifetime cumulative; `drawCalls` resets each frame.
      renderCalls: this.lastFrameDrawCalls,
      drawCalls: this.lastFrameDrawCalls,
      triangles: this.lastFrameTriangles,
      drawStats: includeDrawStats
        ? this.drawCallProfiler.snapshot({
          totalDrawCalls: this.lastFrameDrawCalls,
          totalTriangles: this.lastFrameTriangles,
        })
        : null,
      environmentLighting: Boolean(this.environmentRenderTarget),
    };
  }

  render({ scene, camera, deferExpensivePasses = false }) {
    this.ensureRenderPipeline(scene, camera);
    this._renderCamera = camera;
    // Drives the SSAO updateInterval gate (and any other every-Nth-frame node
    // throttles installed by ensureRenderPipeline).
    this.pipelineFrameIndex = (this.pipelineFrameIndex ?? 0) + 1;
    // Keep the SSAO pre-pass camera in lockstep with the live camera (see
    // ensureRenderPipeline for why the pre-pass owns a separate camera).
    if (this._prepassCamera) {
      this._prepassCamera.copy(camera, false);
      this._prepassCamera.layers.disable(CITY_FURNITURE_LAYER);
    }
    this.deferExpensivePasses = deferExpensivePasses === true;
    try {
      this.renderPipeline.render();
    } finally {
      this.deferExpensivePasses = false;
    }
    const renderInfo = this.renderer?.info?.render;
    if (renderInfo) {
      this.lastFrameDrawCalls = renderInfo.drawCalls ?? 0;
      this.lastFrameTriangles = renderInfo.triangles ?? 0;
    }
    this.drawCallProfiler.recordFrame(this.lastFrameDrawCalls);
    // profileScene traverses the full scene. Draw totals are sampled every frame;
    // the expensive attribution breakdown only needs to refresh twice a second.
    this.drawProfileCounter = (this.drawProfileCounter + 1) % 30;
    if (this.drawProfileCounter === 0) {
      this.drawCallProfiler.profileScene({
        scene,
        camera,
        totalDrawCalls: this.lastFrameDrawCalls,
        totalTriangles: this.lastFrameTriangles,
      });
    }
  }

  async setAnimationLoop(callback) {
    await this.renderer?.setAnimationLoop(callback);
  }

  dispose() {
    this.renderer?.setAnimationLoop(null);
    this.invalidatePipeline();
    this.environmentRenderTarget?.dispose();
    this.environmentRenderTarget = null;
    this.renderer?.dispose();
  }

  ensureRenderPipeline(scene, camera) {
    if (this.renderPipeline && this.pipelineScene === scene && this.pipelineCamera === camera) {
      return;
    }

    this.invalidatePipeline();

    const plan = this.postPipelinePlan ?? buildPostPipelinePlan({
      requestedMode: this.requestedPostEffectMode,
      qualityPreset: this.getActiveQualityPreset(),
      backend: this.backend,
      sceneContext: this.sceneContext,
    });
    const trackedNodes = [];
    this._prepassCamera = null;

    const scenePass = pass(scene, camera);
    trackedNodes.push(scenePass);
    const ssrPreset = this.qualityPreset.ssr ?? {};
    if (plan.ssrMrt) {
      scenePass.setMRT(mrt({
        output,
        normal: normalView,
        metalness: materialMetalness,
        roughness: materialRoughness,
      }));
    }

    if (plan.normalPrePass) {
      // Opaque-only normal/depth pre-pass: view normals packed into an
      // unsigned-byte target (bandwidth), decoded through a sampled node. The
      // resulting AO darkens only the ambient/IBL term via builtinAOContext —
      // direct sun and local lights are unaffected.
      // The pre-pass renders through its OWN camera, kept in lockstep with the
      // live camera by render(), for two reasons:
      // 1. Furniture is too small to contribute useful AO at city scale — it
      //    lives on a dedicated layer this camera excludes.
      // 2. The pre-pass/AO nodes are not part of the post quad's node graph
      //    (only the scene pass is), so their updateBefore fires LAZILY from
      //    the first scene-pass material that samples the AO context — i.e.
      //    from inside renderer.render(scene, camera). Render lists are keyed
      //    by (scene, camera): with the SAME camera, that nested render
      //    recycles the list the scene pass is mid-iterating, and because the
      //    furniture mask makes the nested list shorter, the outer loop reads
      //    past the end ("Cannot destructure property 'object' of
      //    'renderList[i]'"). A dedicated camera keys the pre-pass to its own
      //    render list, making the lazy nested fire harmless.
      this._prepassCamera = camera.clone(false);
      this._prepassCamera.layers.disable(CITY_FURNITURE_LAYER);
      const prePass = pass(scene, this._prepassCamera);
      prePass.name = 'SSAO.PrePass';
      prePass.transparent = false;
      prePass.setMRT(mrt({ output: vec4(packNormalToRGB(normalView), float(1)) }));
      const normalTarget = prePass.getTexture('output');
      normalTarget.type = UnsignedByteType;
      // WebGPU WriteTexture requires 4-byte RGBA rows; vec3 normals alone fault with
      // "layout (4) exceeds linear data size (3)".
      normalTarget.format = RGBAFormat;
      trackedNodes.push(prePass);

      const prePassNormal = sample((uvNode) => unpackRGBToNormal(prePass.getTextureNode().sample(uvNode)));
      const aoNode = ssao(prePass.getTextureNode('depth'), prePassNormal, camera);
      aoNode.resolutionScale = plan.ssao.resolutionScale;
      aoNode.samples.value = plan.ssao.samples;
      aoNode.radius.value = plan.ssao.radius;
      aoNode.intensity.value = plan.ssao.intensity;
      aoNode.blurEnabled = plan.ssao.blur;
      trackedNodes.push(aoNode);

      // Every-Nth-frame AO: the pre-pass is a full CPU-side scene re-render
      // (~7 ms/frame at ultra draw counts, measured), and the AO term is
      // low-frequency ambient shading — a frame or two of staleness is
      // invisible next to halving that cost. Gate BOTH nodes' updateBefore on
      // the same frame index; on skipped frames the scene pass keeps sampling
      // the previous AO texture.
      const aoInterval = plan.ssao.updateInterval ?? 1;
      for (const node of [prePass, aoNode]) {
        const originalUpdateBefore = node.updateBefore.bind(node);
        let hasRendered = false;
        node.updateBefore = (frame) => {
          // Never skip the first update — the AO/pre-pass targets are empty
          // until then and the scene pass would sample garbage.
          if (!hasRendered) {
            hasRendered = true;
            originalUpdateBefore(frame);
            this._snapshotAoCamera(this._renderCamera);
            return;
          }
          const motionStale = this._aoCameraMotionExceedsThreshold(this._renderCamera);
          // During streaming/compile deferral, reuse AO only while the view is
          // static — otherwise stale screen-space AO ghosts across the terrain.
          if (this.deferExpensivePasses && !motionStale) return;
          if (motionStale || (this.pipelineFrameIndex ?? 0) % aoInterval === 0) {
            originalUpdateBefore(frame);
            this._snapshotAoCamera(this._renderCamera);
          }
        };
      }

      scenePass.contextNode = builtinAOContext(aoNode.getTextureNode().sample(screenUV).r);
    }

    const sceneColor = scenePass.getTextureNode('output');
    const sceneDepth = scenePass.getTextureNode('depth');

    let reflectionNode = null;
    if (plan.ssrMrt) {
      reflectionNode = ssr(
        sceneColor,
        sceneDepth,
        scenePass.getTextureNode('normal'),
        {
          camera,
          metalnessNode: scenePass.getTextureNode('metalness').r,
          roughnessNode: scenePass.getTextureNode('roughness').r,
          reflectNonMetals: false,
          binaryRefine: ssrPreset.binaryRefine === true,
        },
      );
      reflectionNode.resolutionScale = ssrPreset.resolutionScale ?? 0.5;
      reflectionNode.quality.value = ssrPreset.quality ?? 0.35;
      reflectionNode.maxDistance.value = ssrPreset.maxDistance ?? 32;
      reflectionNode.thickness.value = ssrPreset.thickness ?? 0.18;
      reflectionNode.intensity.value = ssrPreset.intensity ?? 0.55;
      reflectionNode.screenEdgeFade.value = ssrPreset.screenEdgeFade ?? 0.16;
      trackedNodes.push(reflectionNode);
    }

    let outputNode;
    if (this.cloudSkyProvider) {
      // Volumetric clouds composite over the scene (subsumes aerial perspective).
      // The march + temporal nodes are created per-pipeline (they need the live
      // camera) and disposed with the rest of `_pipelineNodes` on invalidate.
      const cloudSceneColor = this.fogEnabled
        ? createHeightFogOutputNode({
            sceneColor,
            sceneDepth,
            camera,
            fogMarchSteps: this.fogMarchSteps,
            fogMaxDistance: this.fogMaxDistance,
            hazeColor: this.aerialHazeColor,
          })
        : sceneColor;
      outputNode = this.cloudSkyProvider.buildCloudPass({
        sceneColor: cloudSceneColor,
        sceneDepth,
        camera,
        sceneColorIsTexture: !this.fogEnabled,
        track: (node) => trackedNodes.push(node),
      });
    } else {
      outputNode = this.fogEnabled
        ? createHeightFogOutputNode({
            sceneColor,
            sceneDepth,
            camera,
            fogMarchSteps: this.fogMarchSteps,
            fogMaxDistance: this.fogMaxDistance,
            hazeColor: this.aerialHazeColor,
          })
        : this.aerialPerspectiveEnabled
          ? createAerialPerspectiveOutputNode({
              sceneColor,
              sceneDepth,
              camera,
              startDistance: Math.floor((this.viewDistance ?? camera.far ?? 300) * 0.28),
              endDistance: Math.floor((this.viewDistance ?? camera.far ?? 300) * 0.92),
              maxOpacity: Math.min(0.42, (this.qualityPreset.environment?.aerialMaxOpacity ?? 0.22) * 1.35),
              hazeColor: this.aerialHazeColor,
            })
          : sceneColor;
    }

    // Fog helpers sample their input as a texture, so compose the SSR pass only
    // after those helpers have finished reconstructing scene depth/position.
    if (reflectionNode) {
      outputNode = vec4(outputNode.rgb.add(reflectionNode.rgb), outputNode.a);
    }

    const environmentPreset = this.qualityPreset.environment ?? {};
    if (plan.bloom) {
      const bloomNode = dualKawaseBloom(
        outputNode,
        plan.bloom.strength,
        plan.bloom.radius,
        plan.bloom.threshold,
      ).setResolutionScale(plan.bloom.resolutionScale);
      trackedNodes.push(bloomNode);
      outputNode = outputNode.add(bloomNode);
    }
    const gradedRgb = vibrance(
      saturation(outputNode.rgb, environmentPreset.saturation ?? 1.0),
      environmentPreset.vibrance ?? 0.0,
    );
    outputNode = vec4(gradedRgb, outputNode.a);

    this.renderPipeline = new RenderPipeline(this.renderer, outputNode);
    this._pipelineNodes = trackedNodes;
    this.pipelineScene = scene;
    this.pipelineCamera = camera;
  }

  invalidatePipeline() {
    this.renderPipeline?.dispose();
    this.renderPipeline = null;
    for (const node of this._pipelineNodes) node.dispose?.();
    this._pipelineNodes = [];
    this.cloudSkyProvider?.uninstallPostNodes?.();
    this._prepassCamera = null;
    this.pipelineScene = null;
    this.pipelineCamera = null;
    this._aoCameraValid = false;
    this.onPipelineInvalidated?.();
  }

  _aoCameraMotionExceedsThreshold(camera) {
    if (!camera || !this._aoCameraValid) return true;
    if (this._aoCameraPos.distanceToSquared(camera.position) > 0.16) return true;
    if (this._aoCameraQuat.angleTo(camera.quaternion) > 0.02) return true;
    return false;
  }

  _snapshotAoCamera(camera) {
    if (!camera) return;
    this._aoCameraPos.copy(camera.position);
    this._aoCameraQuat.copy(camera.quaternion);
    this._aoCameraValid = true;
  }

  setExposure(exposure = DEFAULT_EXPOSURE) {
    const nextExposure = Number(exposure);
    if (!Number.isFinite(nextExposure) || nextExposure < 0) return this.exposure;

    this.baseExposure = nextExposure;
    this._applyWeatherExposure();
    return this.exposure;
  }

  _applyWeatherExposure() {
    const scale = WEATHER_EXPOSURE_SCALE[this.weather] ?? 1;
    this.exposure = this.baseExposure * scale;
    if (this.renderer) this.renderer.toneMappingExposure = this.exposure;
  }

  setWeather(weather = 'clear') {
    this.weather = WEATHER_STATES.has(weather) ? weather : 'clear';
    this._applyWeatherExposure();
    // Volumetric height fog is for the dedicated fog weather only. Rain uses
    // scene distance fog (SceneSystem.setSceneFogEnabled) for mist, not this pass.
    this.fogEnabled = this.weather === 'fog';
    this.invalidatePipeline();
    return this.weather;
  }

  applyEnvironmentPreset(environmentPreset = {}) {
    this.qualityPreset = { ...this.qualityPreset, environment: environmentPreset };
    this.aerialPerspectiveEnabled = environmentPreset.aerialPerspective !== false;
    this.aerialHazeColor = normalizeAerialHazeColor(environmentPreset.aerialHazeColor);
    syncTerrainAerialUniforms(environmentPreset);

    if (this.renderer) {
      const toneMappingMode = environmentPreset.toneMapping ?? getToneMappingMode();
      this.renderer.toneMapping = toneMappingMode === 'AgX'
        ? AgXToneMapping
        : toneMappingMode === 'None'
          ? NoToneMapping
          : ACESFilmicToneMapping;
    }

    this.baseExposure = environmentPreset.exposure ?? DEFAULT_EXPOSURE;
    this._applyWeatherExposure();

    this.postPipelinePlan = buildPostPipelinePlan({
      requestedMode: this.requestedPostEffectMode,
      qualityPreset: this.getActiveQualityPreset(),
      backend: this.backend,
      sceneContext: this.sceneContext,
    });
    this.invalidatePipeline();

    const scene = this.pipelineScene;
    if (scene) {
      const baseIntensity = environmentPreset.environmentIntensity ?? 0.45;
      scene.environmentIntensity = baseIntensity * (WEATHER_ENVIRONMENT_SCALE[this.weather] ?? 1);
    }

    return environmentPreset;
  }
}

function disposeEnvironmentScene(scene) {
  scene.traverse((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose?.();
  });
}

function resolveRendererBackend(renderer) {
  const backendName = renderer?.backend?.constructor?.name ?? '';

  if (backendName.includes('WebGPU')) {
    return 'webgpu';
  }

  if (backendName.includes('WebGL')) {
    return 'webgl2-fallback';
  }

  return backendName || 'unknown';
}

function createHeightFogOutputNode({
  sceneColor,
  sceneDepth,
  camera,
  fogMarchSteps,
  fogMaxDistance,
  hazeColor = [0.54, 0.62, 0.59],
}) {
  const cameraMatrixWorld = uniform(camera.matrixWorld);
  const cameraProjectionMatrixInverse = uniform(camera.projectionMatrixInverse);
  const cameraPosition = uniform(camera.position);
  const streetFogColor = vec3(hazeColor[0] * 0.92, hazeColor[1] * 0.94, hazeColor[2] * 0.96);
  const highFogColor = vec3(
    hazeColor[0] * 1.08 + 0.12,
    hazeColor[1] * 1.1 + 0.14,
    hazeColor[2] * 1.12 + 0.14,
  );
  const fogMax = float(fogMaxDistance);
  const fogSteps = float(fogMarchSteps);

  return Fn(() => {
    const uvNode = screenUV;
    const sceneTexel = sceneColor.sample(uvNode).toVar();
    const depth = sceneDepth.sample(uvNode).r.toVar();
    const viewPosition = getViewPosition(uvNode, depth, cameraProjectionMatrixInverse).toVar();
    const worldPosition = cameraMatrixWorld.mul(vec4(viewPosition, 1.0)).xyz.toVar();
    const ray = worldPosition.sub(cameraPosition).toVar();
    const fullDistance = distance(cameraPosition, worldPosition).toVar();
    const marchDistance = min(fullDistance, fogMax).toVar();
    const rayDirection = normalize(ray).toVar();
    const fogIntegral = float(0).toVar();
    const jitter = mx_noise_float(vec3(uvNode.mul(420.0), time.mul(0.23))).mul(0.55).add(0.25).toVar();

    Loop(fogMarchSteps, ({ i }) => {
      const stepT = float(i).add(jitter).div(fogSteps);
      const sampleDistance = marchDistance.mul(stepT);
      const sampleWorld = cameraPosition.add(rayDirection.mul(sampleDistance)).toVar();
      const groundHug = float(1).sub(smoothstep(0.5, 22.0, sampleWorld.y));
      const streetLayer = float(1).sub(smoothstep(1.0, 18.0, sampleWorld.y)).mul(groundHug.mul(0.55).add(0.45));
      const upperLayer = float(1).sub(smoothstep(16.0, 54.0, sampleWorld.y)).mul(0.34);
      const distanceDensity = smoothstep(6.0, 116.0, sampleDistance);
      const lowView = float(1).sub(smoothstep(0.08, 0.42, rayDirection.y.abs()));
      const noisePosition = sampleWorld.mul(0.035).add(vec3(time.mul(0.012), 0.0, time.mul(0.017)));
      const broadNoise = mx_noise_float(noisePosition).mul(0.5).add(0.5);
      const fineNoise = mx_noise_float(noisePosition.mul(2.8).add(vec3(17.0, 3.0, 29.0))).mul(0.5).add(0.5);
      const cloudShape = clamp(broadNoise.mul(0.76).add(fineNoise.mul(0.24)), 0.15, 1.0);
      const density = streetLayer.mul(1.28).add(upperLayer)
        .mul(distanceDensity)
        .mul(lowView.mul(0.38).add(0.62))
        .mul(cloudShape.mul(0.52).add(0.62))
        .mul(0.117);

      fogIntegral.assign(fogIntegral.add(density.mul(marchDistance.div(fogSteps))));
    });

    const rooftopBoost = smoothstep(18.0, 68.0, cameraPosition.y).mul(0.38).add(1.0);
    const lowSkyBlend = smoothstep(0.99, 1.0, depth).mul(smoothstep(64.0, 150.0, marchDistance)).mul(0.075);
    const fogAlpha = clamp(float(1).sub(exp(fogIntegral.mul(rooftopBoost).negate())).add(lowSkyBlend), 0.0, 0.68);
    const fogColor = mix(streetFogColor, highFogColor, smoothstep(52.0, 150.0, marchDistance));

    return vec4(mix(sceneTexel.rgb, fogColor, fogAlpha), sceneTexel.a);
  })();
}

function createAerialPerspectiveOutputNode({
  sceneColor,
  sceneDepth,
  camera,
  startDistance,
  endDistance,
  maxOpacity,
  hazeColor = [0.32, 0.42, 0.48],
}) {
  const cameraProjectionMatrixInverse = uniform(camera.projectionMatrixInverse);
  const horizonColor = vec3(hazeColor[0], hazeColor[1], hazeColor[2]);

  return Fn(() => {
    const uvNode = screenUV;
    const sceneTexel = sceneColor.sample(uvNode).toVar();
    const depth = sceneDepth.sample(uvNode).r.toVar();
    const viewPosition = getViewPosition(uvNode, depth, cameraProjectionMatrixInverse).toVar();
    const viewDistance = distance(vec3(0), viewPosition).toVar();
    const geometryMask = float(1).sub(smoothstep(0.9998, 1.0, depth));
    const distanceHaze = smoothstep(startDistance, endDistance, viewDistance);
    const horizonWeight = float(1).sub(smoothstep(0.05, 0.72, normalize(viewPosition).y.abs()));
    const hazeAlpha = distanceHaze
      .mul(horizonWeight.mul(0.5).add(0.32))
      .mul(maxOpacity)
      .mul(geometryMask);
    return vec4(mix(sceneTexel.rgb, horizonColor, hazeAlpha), sceneTexel.a);
  })();
}
