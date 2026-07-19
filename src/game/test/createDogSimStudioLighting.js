/**
 * Realtime studio lighting for DogSim: SSGI + AO, SSR, denoisers, and
 * LightProbeGrid probes — with live sun/sky/floor/object color controls.
 *
 * Built for the isolated WebGPU studio (not the main RendererSystem).
 */

import * as THREE from 'three';
import {
  HalfFloatType,
  LinearToneMapping,
  RenderPipeline,
  RGBAFormat,
} from 'three/webgpu';
import {
  float,
  materialMetalness,
  materialRoughness,
  max,
  mix,
  mrt,
  normalView,
  output,
  pass,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { ssgi } from 'three/examples/jsm/tsl/display/SSGINode.js';
import { ssr } from 'three/examples/jsm/tsl/display/SSRNode.js';
import { denoise } from 'three/examples/jsm/tsl/display/DenoiseNode.js';
import { LightProbeGrid } from '../../three-addons/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from '../../three-addons/helpers/LightProbeGridHelper.js';

const DEFAULT_SETTINGS = Object.freeze({
  ssgi: true,
  ssr: true,
  denoise: true,
  probes: true,
  probeHelper: false,
  ssgiSliceCount: 2,
  ssgiStepCount: 10,
  // Studio is ~2–3 m tall — world radius of 12 samples the whole floor and
  // paints a black contact blob under the subject. Keep influence local.
  ssgiRadius: 1.8,
  ssgiThickness: 0.35,
  ssgiAoIntensity: 0.85,
  ssgiGiIntensity: 4.5,
  // How hard AO multiplies into beauty (1 = full darkening of direct light too).
  // Keep partial so sun contact shadows don't double-up with SSGI AO.
  aoBlend: 0.42,
  // Floor never goes fully black from AO alone.
  aoMin: 0.55,
  ssrIntensity: 0.35,
  ssrMaxDistance: 8,
  denoiseRadius: 5,
  denoiseLumaPhi: 4,
  denoiseDepthPhi: 6,
  denoiseNormalPhi: 6,
  skyColor: 0xc5cdc6,
  groundColor: 0xb0b8b2,
  hemiSky: 0xf2f4f0,
  hemiGround: 0x8a9088,
  hemiIntensity: 0.85,
  sunColor: 0xfff4e8,
  sunIntensity: 1.55,
  sunAzimuth: 42, // deg, 0 = +Z
  sunElevation: 52, // deg
  fillColor: 0xd4e0f0,
  fillIntensity: 0.5,
  rimColor: 0xffe8d0,
  rimIntensity: 0.32,
  fogNear: 6,
  fogFar: 18,
  fogEnabled: true,
  floorRoughness: 0.55,
  floorMetalness: 0.08,
  exposure: 1,
});

/**
 * @param {{
 *   scene: THREE.Scene,
 *   camera: THREE.PerspectiveCamera,
 *   renderer: import('three/webgpu').WebGPURenderer,
 *   settings?: Partial<typeof DEFAULT_SETTINGS>,
 * }} opts
 */
export function createDogSimStudioLighting(opts) {
  const { scene, camera, renderer } = opts;
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };

  // --- Lights (live-tunable) ---
  const hemi = new THREE.HemisphereLight(settings.hemiSky, settings.hemiGround, settings.hemiIntensity);
  hemi.name = 'StudioHemi';
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(settings.sunColor, settings.sunIntensity);
  sun.name = 'StudioSun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.4;
  sun.shadow.camera.far = 24;
  sun.shadow.camera.left = -4;
  sun.shadow.camera.right = 4;
  sun.shadow.camera.top = 4;
  sun.shadow.camera.bottom = -4;
  sun.shadow.bias = -0.0003;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 0.4, 0);

  const fill = new THREE.DirectionalLight(settings.fillColor, settings.fillIntensity);
  fill.name = 'StudioFill';
  fill.position.set(-3.0, 2.4, -1.2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(settings.rimColor, settings.rimIntensity);
  rim.name = 'StudioRim';
  rim.position.set(-1.5, 3.5, -3.0);
  scene.add(rim);

  // --- Floor / sky (object + colors) ---
  const floorMat = new THREE.MeshStandardMaterial({
    color: settings.groundColor,
    roughness: settings.floorRoughness,
    metalness: settings.floorMetalness,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(7, 64), floorMat);
  floor.name = 'StudioFloor';
  floor.rotation.x = -Math.PI * 0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(7, 14, 0x7a8880, 0xa8b4ac);
  grid.name = 'StudioGrid';
  grid.position.y = 0.002;
  grid.material.transparent = true;
  grid.material.opacity = 0.16;
  scene.add(grid);

  applySkyAndFog();
  applySunDirection();

  // --- Probe grid (baked irradiance) ---
  /** @type {LightProbeGrid | null} */
  let probes = null;
  /** @type {LightProbeGridHelper | null} */
  let probeHelper = null;
  let probeStatus = 'idle';
  let probeError = null;
  let bakeMs = 0;

  // --- Post pipeline ---
  /** @type {RenderPipeline | null} */
  let pipeline = null;
  /** @type {object[]} */
  let pipelineNodes = [];
  let pipelineKey = '';
  let pipelineError = null;
  /** Live node refs for intensity sliders */
  let ssgiNode = null;
  let ssrNode = null;
  let denoiseAoNode = null;
  let denoiseGiNode = null;
  /** Live AO composite knobs (uniforms so sliders don't rebuild the pipeline). */
  const uAoBlend = uniform(settings.aoBlend);
  const uAoMin = uniform(settings.aoMin);

  function applySkyAndFog() {
    const sky = new THREE.Color(settings.skyColor);
    scene.background = sky;
    if (settings.fogEnabled) {
      scene.fog = new THREE.Fog(sky.getHex(), settings.fogNear, settings.fogFar);
    } else {
      scene.fog = null;
    }
  }

  function applySunDirection() {
    const az = THREE.MathUtils.degToRad(settings.sunAzimuth);
    const el = THREE.MathUtils.degToRad(settings.sunElevation);
    const r = 6.5;
    const y = Math.sin(el) * r;
    const horiz = Math.cos(el) * r;
    sun.position.set(Math.sin(az) * horiz, Math.max(0.4, y), Math.cos(az) * horiz);
    sun.target.position.set(0, 0.4, 0);
    sun.target.updateMatrixWorld();
  }

  function applyLightColors() {
    hemi.color.setHex(settings.hemiSky);
    hemi.groundColor.setHex(settings.hemiGround);
    hemi.intensity = settings.hemiIntensity;
    sun.color.setHex(settings.sunColor);
    sun.intensity = settings.sunIntensity;
    fill.color.setHex(settings.fillColor);
    fill.intensity = settings.fillIntensity;
    rim.color.setHex(settings.rimColor);
    rim.intensity = settings.rimIntensity;
    floorMat.color.setHex(settings.groundColor);
    floorMat.roughness = settings.floorRoughness;
    floorMat.metalness = settings.floorMetalness;
    floorMat.needsUpdate = true;
    renderer.toneMappingExposure = settings.exposure;
  }

  function disposeProbeHelper() {
    if (!probeHelper) return;
    probeHelper.removeFromParent();
    probeHelper.geometry?.dispose?.();
    probeHelper.material?.dispose?.();
    probeHelper = null;
  }

  function disposeProbes() {
    disposeProbeHelper();
    if (probes) {
      probes.removeFromParent();
      probes.dispose?.();
      probes = null;
    }
  }

  async function bakeProbes() {
    if (!settings.probes) {
      disposeProbes();
      probeStatus = 'disabled';
      return;
    }
    if (!renderer?.isWebGPURenderer) {
      probeStatus = 'failed';
      probeError = 'WebGPU required';
      return;
    }
    probeStatus = 'baking';
    probeError = null;
    const t0 = performance.now();
    try {
      disposeProbes();
      // Studio volume around the subject.
      probes = new LightProbeGrid(8, 4, 8, 5, 3, 5);
      probes.name = 'DogSim Studio Probes';
      probes.position.set(0, 1.2, 0);
      probes.intensity = 0.85;
      scene.add(probes);
      // Hide helper objects during bake so they don't tint the SH capture.
      const wasGrid = grid.visible;
      grid.visible = false;
      await probes.update(renderer, scene);
      grid.visible = wasGrid;
      bakeMs = performance.now() - t0;
      probeStatus = 'ready';
      if (settings.probeHelper) {
        probeHelper = new LightProbeGridHelper(probes, 0.12);
        probeHelper.name = 'DogSim Probe Helper';
        scene.add(probeHelper);
      }
    } catch (err) {
      probeStatus = 'failed';
      probeError = err?.message ?? String(err);
      console.warn('[DogSimStudio] probe bake failed', err);
      disposeProbes();
    }
  }

  function invalidatePipeline() {
    pipeline?.dispose?.();
    pipeline = null;
    for (const node of pipelineNodes) node.dispose?.();
    pipelineNodes = [];
    ssgiNode = null;
    ssrNode = null;
    denoiseAoNode = null;
    denoiseGiNode = null;
    pipelineKey = '';
  }

  function ensurePipeline() {
    const key = [
      settings.ssgi ? 1 : 0,
      settings.ssr ? 1 : 0,
      settings.denoise ? 1 : 0,
      settings.ssgiSliceCount,
      settings.ssgiStepCount,
    ].join(':');
    if (pipeline && pipelineKey === key) return pipeline;
    invalidatePipeline();
    pipelineKey = key;
    pipelineError = null;

    try {
      const scenePass = pass(scene, camera);
      pipelineNodes.push(scenePass);

      // MRT: beauty + view normals + metal/rough for SSR.
      scenePass.setMRT(mrt({
        output,
        normal: normalView,
        metalness: materialMetalness,
        roughness: materialRoughness,
      }));
      // Keep normal buffer high precision for SSGI/SSR.
      try {
        const nTex = scenePass.getTexture('normal');
        if (nTex) {
          nTex.type = HalfFloatType;
          nTex.format = RGBAFormat;
        }
      } catch {
        // older three may not expose getTexture
      }

      const beauty = scenePass.getTextureNode('output');
      const depth = scenePass.getTextureNode('depth');
      const normal = scenePass.getTextureNode('normal');

      let color = beauty.rgb;

      if (settings.ssgi) {
        const giPass = ssgi(beauty, depth, normal, camera);
        giPass.sliceCount.value = Math.max(1, Math.min(4, settings.ssgiSliceCount | 0));
        giPass.stepCount.value = Math.max(4, Math.min(32, settings.ssgiStepCount | 0));
        giPass.aoIntensity.value = settings.ssgiAoIntensity;
        giPass.giIntensity.value = settings.ssgiGiIntensity;
        // Critical for portrait scale — default radius 12 covers the whole studio.
        if (giPass.radius) giPass.radius.value = settings.ssgiRadius;
        if (giPass.thickness) giPass.thickness.value = settings.ssgiThickness;
        if (giPass.useScreenSpaceSampling) giPass.useScreenSpaceSampling.value = true;
        pipelineNodes.push(giPass);
        ssgiNode = giPass;

        let aoTex = giPass.getAONode();
        let giTex = giPass.getGINode();

        if (settings.denoise) {
          const dAo = denoise(aoTex, depth, normal, camera);
          dAo.radius.value = settings.denoiseRadius;
          dAo.lumaPhi.value = settings.denoiseLumaPhi;
          dAo.depthPhi.value = settings.denoiseDepthPhi;
          dAo.normalPhi.value = settings.denoiseNormalPhi;
          pipelineNodes.push(dAo);
          denoiseAoNode = dAo;
          aoTex = dAo;

          const dGi = denoise(giTex, depth, normal, camera);
          dGi.radius.value = settings.denoiseRadius;
          dGi.lumaPhi.value = settings.denoiseLumaPhi;
          dGi.depthPhi.value = settings.denoiseDepthPhi;
          dGi.normalPhi.value = settings.denoiseNormalPhi;
          pipelineNodes.push(dGi);
          denoiseGiNode = dGi;
          giTex = dGi;
        }

        // Soft AO: clamp min so the floor never goes to pure black under the
        // subject, and only partially multiply beauty (beauty already has sun
        // shadows — full AO multiply double-darkens contact regions).
        const aoSoft = max(aoTex.r, uAoMin);
        const aoFactor = mix(float(1), aoSoft, uAoBlend);
        color = beauty.rgb.mul(aoFactor).add(giTex.rgb);
      }

      if (settings.ssr) {
        const reflection = ssr(beauty, depth, normal, {
          camera,
          metalnessNode: scenePass.getTextureNode('metalness').r,
          roughnessNode: scenePass.getTextureNode('roughness').r,
          reflectNonMetals: true,
          binaryRefine: true,
        });
        reflection.resolutionScale = 0.5;
        reflection.quality.value = 0.4;
        reflection.maxDistance.value = settings.ssrMaxDistance;
        reflection.thickness.value = 0.2;
        reflection.intensity.value = settings.ssrIntensity;
        reflection.screenEdgeFade.value = 0.14;
        pipelineNodes.push(reflection);
        ssrNode = reflection;
        color = color.add(reflection.rgb);
      }

      const outputNode = vec4(color, float(1));
      pipeline = new RenderPipeline(renderer, outputNode);
      renderer.toneMapping = LinearToneMapping;
      renderer.toneMappingExposure = settings.exposure;
    } catch (err) {
      pipelineError = err?.message ?? String(err);
      console.warn('[DogSimStudio] post pipeline failed; falling back to direct render', err);
      invalidatePipeline();
    }
    return pipeline;
  }

  function syncLiveUniforms() {
    if (ssgiNode) {
      ssgiNode.aoIntensity.value = settings.ssgiAoIntensity;
      ssgiNode.giIntensity.value = settings.ssgiGiIntensity;
      ssgiNode.sliceCount.value = Math.max(1, Math.min(4, settings.ssgiSliceCount | 0));
      ssgiNode.stepCount.value = Math.max(4, Math.min(32, settings.ssgiStepCount | 0));
      if (ssgiNode.radius) ssgiNode.radius.value = settings.ssgiRadius;
      if (ssgiNode.thickness) ssgiNode.thickness.value = settings.ssgiThickness;
    }
    if (ssrNode) {
      ssrNode.intensity.value = settings.ssrIntensity;
      ssrNode.maxDistance.value = settings.ssrMaxDistance;
    }
    for (const node of [denoiseAoNode, denoiseGiNode]) {
      if (!node) continue;
      node.radius.value = settings.denoiseRadius;
      node.lumaPhi.value = settings.denoiseLumaPhi;
      node.depthPhi.value = settings.denoiseDepthPhi;
      node.normalPhi.value = settings.denoiseNormalPhi;
    }
    uAoBlend.value = settings.aoBlend;
    uAoMin.value = settings.aoMin;
    renderer.toneMappingExposure = settings.exposure;
  }

  function render() {
    ensurePipeline();
    syncLiveUniforms();
    if (pipeline) {
      pipeline.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  /**
   * Patch settings and optionally rebuild heavy pipeline bits.
   * @param {Partial<typeof DEFAULT_SETTINGS>} patch
   * @param {{ rebakeProbes?: boolean, rebuildPipeline?: boolean }} [opts]
   */
  function setSettings(patch = {}, opts = {}) {
    const prev = { ...settings };
    Object.assign(settings, patch);

    // Sky / lights / floor always apply live.
    if (
      patch.skyColor != null
      || patch.fogNear != null
      || patch.fogFar != null
      || patch.fogEnabled != null
    ) {
      applySkyAndFog();
    }
    if (
      patch.sunAzimuth != null
      || patch.sunElevation != null
    ) {
      applySunDirection();
    }
    applyLightColors();

    // Structural post toggles need a rebuild.
    const needsRebuild = opts.rebuildPipeline
      || (patch.ssgi != null && patch.ssgi !== prev.ssgi)
      || (patch.ssr != null && patch.ssr !== prev.ssr)
      || (patch.denoise != null && patch.denoise !== prev.denoise)
      || (patch.ssgiSliceCount != null && patch.ssgiSliceCount !== prev.ssgiSliceCount)
      || (patch.ssgiStepCount != null && patch.ssgiStepCount !== prev.ssgiStepCount);

    if (needsRebuild) invalidatePipeline();

    if (patch.probeHelper != null && probes) {
      disposeProbeHelper();
      if (settings.probeHelper) {
        probeHelper = new LightProbeGridHelper(probes, 0.12);
        scene.add(probeHelper);
      }
    }

    if (opts.rebakeProbes || (patch.probes != null && patch.probes !== prev.probes)) {
      void bakeProbes();
    }
  }

  function getSettings() {
    return { ...settings };
  }

  function snapshot() {
    return {
      settings: getSettings(),
      pipeline: pipeline ? 'active' : (pipelineError ? 'fallback' : 'idle'),
      pipelineError,
      probes: {
        status: probeStatus,
        error: probeError,
        bakeMs: Number(bakeMs.toFixed(1)),
        helper: Boolean(probeHelper?.visible),
      },
      effects: {
        ssgi: Boolean(ssgiNode),
        ssr: Boolean(ssrNode),
        denoise: Boolean(denoiseAoNode || denoiseGiNode),
      },
    };
  }

  function dispose() {
    invalidatePipeline();
    disposeProbes();
    scene.remove(hemi, sun, fill, rim, floor, grid);
    sun.target.removeFromParent();
    floor.geometry.dispose();
    floorMat.dispose();
    grid.geometry?.dispose?.();
    grid.material?.dispose?.();
  }

  // Kick async probe bake after first frames.
  if (settings.probes) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { void bakeProbes(); });
    });
  }

  return {
    lights: { hemi, sun, fill, rim },
    floor,
    grid,
    render,
    setSettings,
    getSettings,
    bakeProbes,
    snapshot,
    dispose,
    DEFAULT_SETTINGS,
  };
}
