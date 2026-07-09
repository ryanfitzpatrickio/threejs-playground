/**
 * createTerrainBiomeMaterial.js
 *
 * A height + slope blended PBR terrain material (TSL node material, WebGPU) built
 * from the sphere5.5 texture set in /public/textures/pbr. Layers, painted in
 * order: sand (shore) → grass (lowland) → cliff rock (steep / mid elevation) →
 * snow (flat peaks). Albedo, roughness, and (tangent-space) normal are all
 * blended. Textures are sampled by WORLD xz so tiling is continuous across the
 * streamed chunk grid (no per-chunk seams).
 *
 * Textures are cached at module scope (expensive); a fresh material is built per
 * level so level disposal never frees the shared textures.
 */

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  texture,
  attribute,
  positionWorld,
  normalWorldGeometry,
  normalMap,
  smoothstep,
  clamp,
  min,
  max,
  mix,
  float,
  vec3,
  vec2,
  vec4,
  cameraPosition,
  cameraViewMatrix,
  normalize,
  Fn,
  If,
} from 'three/tsl';
import { rainWetness, rainWind } from '../systems/weatherUniforms.js';
import {
  terrainAerialEnabled,
  terrainAerialStart,
  terrainAerialEnd,
  terrainFadeRadius,
  terrainLoadedReach,
  terrainAerialStrength,
  terrainAerialDesat,
  terrainAerialContrast,
  terrainHazeColor,
  terrainNightFactor,
} from '../systems/terrainAerialUniforms.js';
import { uCloudAmbientColor, uSkyDarkness } from '../render/cloud/cloudUniforms.js';
import { applyTerrainCloudShadow } from './terrainCloudShadowNodes.js';
import { puddleMaskAt, puddleRippleNormal } from './wetSurfaceNodes.js';
import { applyForestLitterTint } from '../world/forest/forestLitter.js';
import { createHexTileGrid, hexHash2, hexBlendWeights } from './hexTilingNodes.js';
import { disablePbrEnvironment } from './disablePbrEnvironment.js';
import { parallaxOcclusionUV } from '../../three-addons/tsl/utils/ParallaxOcclusion.js';
import { applyTerrainMacroTint } from './terrainMacroNodes.js';

// Ground puddle parameters, ported from the reference repo's `puddleUniforms`
// (src/main.js) — same constants, just with coverage driven by the live
// `rainWetness` uniform instead of a static GUI slider.
const PUDDLE_SCALE = 0.18;
const PUDDLE_SEED = new THREE.Vector2(13.7, 4.2);
const PUDDLE_COVERAGE = 0.52; // scaled by rainWetness below
const PUDDLE_EDGE = 0.06;
const PUDDLE_ROUGHNESS = 0.04;
const WATER_DARKNESS = 0.55;
const RAIN_RIPPLE = 0.04;
const RIPPLE_SCALE = 2.2;
const RIPPLE_SPEED = 1.3;
const RIPPLE_DENSITY = 0.2;
const RIPPLE_FALLOFF = 0.45;

const TEX_BASE = '/textures/pbr';
const TILES_PER_METRE = 0.12; // texture repeats roughly every ~8 m

const loader = new THREE.TextureLoader();
const texCache = new Map();

// Like loadTex but takes a full URL (the blueprint overlay texture can live
// outside TEX_BASE and ship as .png), cached by URL.
function loadTexUrl(url, srgb) {
  if (texCache.has(url)) return texCache.get(url);
  const tex = loader.load(url);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  texCache.set(url, tex);
  return tex;
}

// The four biome layers are packed into two 4-layer DataArrayTextures (albedo
// sRGB + normals linear), sampled with `.depth(layer)` — 2 fragment samplers
// instead of 8. This is a WebGPU budget requirement, not a nicety: on ultra the
// terrain fragment stage also binds 5 clipmap shadow levels + envmap + SSAO's
// AO texture (+ the optional blueprint overlay), and with 8 discrete layer
// samplers the pipeline hits Dawn's 16-samplers-per-stage limit and the terrain
// silently fails to render.
const LAYER_FILES = ['sand1', 'grass1', 'cliffrock', 'snow'];
const LAYERS = { sand: 0, grass: 1, rock: 2, snow: 3 };

const imageLoader = new THREE.ImageLoader();
const arrayTexCache = new Map();

function loadLayerArrayTex(kind, srgb) {
  if (arrayTexCache.has(kind)) return arrayTexCache.get(kind);
  const layers = LAYER_FILES.length;
  // 1x1 placeholder until the images arrive: mid-grey albedo / neutral normal.
  const fill = srgb ? [128, 128, 128, 255] : [128, 128, 255, 255];
  const placeholder = new Uint8Array(layers * 4);
  for (let i = 0; i < layers; i += 1) placeholder.set(fill, i * 4);
  const tex = new THREE.DataArrayTexture(placeholder, 1, 1, layers);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  arrayTexCache.set(kind, tex);

  Promise.all(
    LAYER_FILES.map((file) => imageLoader.loadAsync(`${TEX_BASE}/${file}-${kind}.webp`)),
  ).then((images) => {
    const width = images[0].width;
    const height = images[0].height;
    const data = new Uint8Array(width * height * 4 * layers);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    images.forEach((image, i) => {
      // Draw V-flipped so UV orientation matches what the old flipY:true
      // TextureLoader path produced (a silent flip would invert the normal
      // maps' green channel relative to the lighting).
      ctx.save();
      ctx.translate(0, height);
      ctx.scale(1, -1);
      ctx.drawImage(image, 0, 0, width, height);
      ctx.restore();
      data.set(ctx.getImageData(0, 0, width, height).data, i * width * height * 4);
    });
    // The GPU texture was allocated at the 1x1 placeholder size; dispose so the
    // backend re-creates it at full resolution on next use.
    tex.dispose();
    tex.image = { data, width, height, depth: layers };
    tex.needsUpdate = true;
  }).catch((error) => {
    console.error(`Terrain biome ${kind} layer array failed to load`, error);
  });
  return tex;
}

// Ultra terrain POM marches a single 2D height proxy (grass albedo luminance).
// DataArray `.depth()` cannot feed the vendored marcher directly; one 2D map
// keeps the sampler budget unchanged versus a third array texture.
let grassHeightProxyTex = null;

function loadGrassHeightProxyTex() {
  if (grassHeightProxyTex) return grassHeightProxyTex;
  const tex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  grassHeightProxyTex = tex;

  imageLoader.loadAsync(`${TEX_BASE}/grass1-albedo.webp`).then((image) => {
    const width = image.width;
    const height = image.height;
    const data = new Uint8Array(width * height * 4);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.save();
    ctx.translate(0, height);
    ctx.scale(1, -1);
    ctx.drawImage(image, 0, 0, width, height);
    ctx.restore();
    const pixels = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < width * height; i += 1) {
      const o = i * 4;
      const lum = Math.round(pixels[o] * 0.299 + pixels[o + 1] * 0.587 + pixels[o + 2] * 0.114);
      data[o] = lum;
      data[o + 1] = lum;
      data[o + 2] = lum;
      data[o + 3] = 255;
    }
    tex.dispose();
    tex.image = { data, width, height };
    tex.needsUpdate = true;
  }).catch((error) => {
    console.error('Terrain grass height proxy failed to load', error);
  });
  return tex;
}

/**
 * @param {object} [opts]
 * @param {{url:string, tiling:number, blend:number}|null} [opts.overlay]
 * @param {{enabled?:boolean, falloffContrast?:number, exponent?:number}} [opts.hextile]
 * @param {{enabled?:boolean, terrain?:boolean, scale?:number, minLayers?:number, maxLayers?:number}|null} [opts.parallaxOcclusion]
 * @param {{enabled?:boolean, frequency?:number, colorStrength?:number}|null} [opts.macroDetail]
 *   Optional single blueprint terrain texture painted over the biome inside
 *   placed-blueprint footprints. Blended per-vertex by the `bpTexMask` geometry
 *   attribute (0 outside footprints → 1 inside), so chunks must carry that
 *   attribute when an overlay is supplied (createStreamingTerrainLevel does this).
 */
export function createTerrainBiomeMaterial({
  overlay = null,
  hextile = null,
  parallaxOcclusion = null,
  macroDetail = null,
  cloudShadow = false,
} = {}) {
  const uv = positionWorld.xz.mul(TILES_PER_METRE);
  const hexEnabled = hextile?.enabled === true;
  const pomEnabled = parallaxOcclusion?.enabled === true
    && parallaxOcclusion?.terrain !== false;
  const pomDist = positionWorld.xz.sub(cameraPosition.xz).length();
  const pomScale = pomEnabled
    ? float(parallaxOcclusion.terrainScale ?? parallaxOcclusion.scale ?? 0.028)
      .mul(smoothstep(float(95), float(22), pomDist))
    : null;
  const makePom = () => parallaxOcclusionUV(loadGrassHeightProxyTex(), {
    uvNode: uv,
    scale: pomScale,
    minLayers: parallaxOcclusion.minLayers ?? 8,
    maxLayers: parallaxOcclusion.maxLayers ?? 24,
    silhouette: false,
  });
  const pomColor = pomEnabled ? makePom() : null;
  const pomNormal = pomEnabled ? makePom() : null;
  const colorUv = pomColor ? pomColor.uv : uv;
  const normalUv = pomNormal ? pomNormal.uv : uv;

  // Per-layer samples out of the two packed array textures (one sampler each —
  // see LAYER_FILES above). Roughness textures are intentionally dropped (a flat
  // value is used instead).
  const albedoTexture = loadLayerArrayTex('albedo', true);
  const normalTexture = loadLayerArrayTex('normal', false);
  let albedo;
  let normalRaw;

  if (hexEnabled) {
    // positionWorld is not camera-relative yet, so the RWS offset is zero. The
    // explicit split in createHexTileGrid is ready for floating-origin support;
    // at today's world scale this retains the existing world-space precision.
    const grid = createHexTileGrid(positionWorld.xz, vec2(0), TILES_PER_METRE);
    const uv1 = uv.add(hexHash2(grid.vertex1));
    const uv2 = uv.add(hexHash2(grid.vertex2));
    const uv3 = uv.add(hexHash2(grid.vertex3));
    const falloff = hextile.falloffContrast ?? 0.6;
    const exponent = hextile.exponent ?? 7;

    albedo = (layer) => {
      const c1 = texture(albedoTexture, uv1).depth(layer).rgb;
      const c2 = texture(albedoTexture, uv2).depth(layer).rgb;
      const c3 = texture(albedoTexture, uv3).depth(layer).rgb;
      const luminance = vec3(
        c1.dot(vec3(0.299, 0.587, 0.114)),
        c2.dot(vec3(0.299, 0.587, 0.114)),
        c3.dot(vec3(0.299, 0.587, 0.114)),
      );
      const weights = hexBlendWeights(grid.weights, luminance, falloff, exponent);
      return c1.mul(weights.x).add(c2.mul(weights.y)).add(c3.mul(weights.z));
    };

    normalRaw = (layer) => {
      const n1 = texture(normalTexture, uv1).depth(layer).rgb;
      const n2 = texture(normalTexture, uv2).depth(layer).rgb;
      const n3 = texture(normalTexture, uv3).depth(layer).rgb;
      // With rotation disabled, blending encoded tangent normals is stable. Use
      // horizontal magnitude as the reference paper's slope-sine detail metric.
      const slopeMetric = vec3(
        n1.xy.mul(2).sub(1).length(),
        n2.xy.mul(2).sub(1).length(),
        n3.xy.mul(2).sub(1).length(),
      );
      const weights = hexBlendWeights(grid.weights, slopeMetric, falloff, exponent);
      return n1.mul(weights.x).add(n2.mul(weights.y)).add(n3.mul(weights.z));
    };
  } else {
    const albedoArray = texture(albedoTexture, colorUv);
    const normalArray = texture(normalTexture, normalUv);
    albedo = (layer) => albedoArray.depth(layer).rgb;
    normalRaw = (layer) => normalArray.depth(layer).rgb; // raw [0,1]; normalMap unpacks
  }

  const y = positionWorld.y;
  const slope = float(1).sub(normalWorldGeometry.y); // 0 flat → 1 vertical

  // Transition weights (0..1), tuned for the gentle default terrain; snow only
  // shows on tall biomes (added later) — harmless at low elevation.
  const aboveSand = smoothstep(float(-0.1), float(0.8), y); // shore → land
  const rockByHeight = smoothstep(float(4.0), float(9.0), y);
  const rockBySlope = smoothstep(float(0.34), float(0.6), slope);
  const rockW = clamp(rockByHeight.add(rockBySlope), float(0), float(1));
  const snowW = smoothstep(float(12.0), float(18.0), y).mul(normalWorldGeometry.y);

  // Paint order: sand → grass → rock → snow. Works for vec3 (albedo/normal) and
  // float (roughness) alike.
  const blend = (s, g, r, sn) => {
    let v = mix(s, g, aboveSand);
    v = mix(v, r, rockW);
    v = mix(v, sn, snowW);
    return v;
  };

  const material = new MeshStandardNodeMaterial();
  let biomeColor = applyForestLitterTint(
    blend(albedo(LAYERS.sand), albedo(LAYERS.grass), albedo(LAYERS.rock), albedo(LAYERS.snow)),
  );
  biomeColor = applyTerrainMacroTint(biomeColor, positionWorld.xz, pomDist, macroDetail ?? {});

  // Blueprint terrain texture: blend a single overlay albedo over the biome
  // wherever the per-vertex footprint mask is non-zero (so a placed "all salt"
  // blueprint keeps its look on the merged world terrain). Normals stay biome.
  if (overlay?.url) {
    const ovUv = positionWorld.xz.mul(overlay.tiling > 0 ? overlay.tiling : TILES_PER_METRE);
    const ovAlbedo = texture(loadTexUrl(overlay.url, true), ovUv).rgb;
    const mask = attribute('bpTexMask', 'float').mul(float(overlay.blend ?? 1));
    biomeColor = mix(biomeColor, ovAlbedo, clamp(mask, float(0), float(1)));
  }

  const biomeNormal = normalMap(
    blend(normalRaw(LAYERS.sand), normalRaw(LAYERS.grass), normalRaw(LAYERS.rock), normalRaw(LAYERS.snow)),
  );

  // Ground puddles: direct TSL port of the reference repo's PUDDLE_HEADER
  // shader (github.com/achrefelouafi/RainSystemThreeJS, src/main.js) — see
  // wetSurfaceNodes.js for the ported puddleMaskAt/puddleRippleNormal
  // functions. Coverage is driven by the live rainWetness uniform (0 when
  // dry, collapsing this whole block back to the original look) instead of
  // the reference's static GUI slider. One necessary adaptation for our
  // non-flat terrain (the reference's ground is a flat plane): gate the mask
  // by slope so puddles only pool on flat ground, reusing the slope value
  // already computed above for rock blending.
  //
  // Distance-gated behind its OWN, fairly tight fade — puddleMaskAt (5-octave
  // fbm) and puddleRippleNormal (three 3x3-neighbourhood hash loops per call)
  // are real per-fragment cost. An initial pass reused CityGenerator's own
  // ~240m grit-noise fade, but that still measured a real frame-rate hit
  // while actually moving (avg frame time nearly doubled versus dry weather)
  // because most of a normal view is still within 240m. Puddle ripples are
  // fine detail on the normal, not visible at range, so a tighter ~90m
  // cutoff loses nothing noticeable while cutting the area this expensive
  // math runs over substantially — this was the real fix for a reported "car
  // feels weak/hard to drive in the rain" symptom (driving sweeps across far
  // more terrain/road than a stationary camera ever does).
  const puddleDetail = smoothstep(90, 20, positionWorld.distance(cameraPosition));
  const puddleResult = Fn(() => {
    const mask = float(0).toVar();
    const rippleN = vec3(0, 1, 0).toVar();

    If(puddleDetail.greaterThan(0), () => {
      const flatness = normalWorldGeometry.y; // 1 flat, 0 vertical
      const m = puddleMaskAt(
        positionWorld.xz,
        float(PUDDLE_SCALE),
        PUDDLE_SEED,
        rainWetness.mul(PUDDLE_COVERAGE),
        float(PUDDLE_EDGE),
      ).mul(smoothstep(0.85, 0.98, flatness)).mul(puddleDetail).mul(rainWetness);
      mask.assign(m);

      // rippleFade/deepWater — same nested-mix structure as the reference's
      // fragment injection (shallow puddle edges get a gentler, less-rippled
      // normal; only deep/core puddle area gets the full ripple).
      const rippleFade = clamp(float(PUDDLE_EDGE * 3), float(0.02), float(0.8));
      const deepWater = smoothstep(float(RIPPLE_FALLOFF), min(float(RIPPLE_FALLOFF).add(rippleFade), float(1)), m);
      rippleN.assign(mix(
        vec3(0, 1, 0),
        puddleRippleNormal(positionWorld.xz, rainWind, float(RIPPLE_SCALE), float(RAIN_RIPPLE), float(RIPPLE_SPEED), float(RIPPLE_DENSITY)),
        deepWater,
      ));
    });

    return vec4(mask, rippleN.x, rippleN.y, rippleN.z);
  })();

  const puddleMask = puddleResult.x;
  const rippleWorldNormal = puddleResult.yzw;

  // Distance aerial perspective: fade keyed to the live view distance (not the
  // post-pass kilometre-scale aerial* defaults). Horizontal XZ distance so hills
  // don't skew the fade. Mid-field keeps full albedo; only the outer load edge
  // melts into horizon haze so the geometric cutoff disappears.
  const aerialColor = Fn(() => {
    const color = biomeColor.toVar();
    const delta = positionWorld.xz.sub(cameraPosition.xz);
    const dist = delta.length();
    const fadeEnd = min(terrainAerialEnd, terrainFadeRadius.mul(0.98));
    // Ease-in power keeps the first half of the fade band nearly invisible.
    const aerialLinear = smoothstep(terrainAerialStart, fadeEnd, dist);
    const aerialT = aerialLinear.mul(aerialLinear)
      .mul(terrainAerialStrength)
      .mul(terrainAerialEnabled);
    // Full horizon melt only on the outermost ring (not 82% of load radius).
    const edgePush = smoothstep(terrainLoadedReach.mul(0.92), terrainLoadedReach.mul(0.995), dist);
    // Cap mid-fade haze so only edgePush can go fully white/grey.
    const aerialMix = min(float(1), aerialT.mul(0.55).add(edgePush));
    // Ground aerial is grey path-haze, not zenith sky blue. A tiny cool cast is
    // enough to sit under a blue sky without painting the landscape cyan.
    const haze = mix(terrainHazeColor, uCloudAmbientColor, float(0.1));
    const nightHaze = mix(haze, vec3(0.42, 0.45, 0.52), max(terrainNightFactor, uSkyDarkness).mul(0.65));
    const luminance = color.dot(vec3(0.299, 0.587, 0.114));
    color.assign(mix(color, vec3(luminance), aerialMix.mul(terrainAerialDesat)));
    const softened = color.mul(float(1).sub(aerialMix.mul(terrainAerialContrast).mul(0.4))).add(
      aerialMix.mul(terrainAerialContrast).mul(0.12),
    );
    color.assign(mix(color, softened, aerialMix));
    color.assign(mix(color, nightHaze, aerialMix));
    if (cloudShadow) {
      color.assign(applyTerrainCloudShadow(color, positionWorld.xz));
    }
    return color;
  })();

  material.colorNode = mix(aerialColor, aerialColor.mul(float(1).sub(WATER_DARKNESS)), puddleMask);
  material.roughnessNode = mix(float(0.95), float(PUDDLE_ROUGHNESS), puddleMask);
  const rippleViewNormal = normalize(cameraViewMatrix.mul(vec4(rippleWorldNormal, 0)).xyz);
  material.normalNode = normalize(mix(biomeNormal, rippleViewNormal, puddleMask));
  material.metalness = 0;
  material.fog = true;
  disablePbrEnvironment(material);
  material.shadowSide = THREE.DoubleSide;
  material.name = 'Terrain Biome';

  return material;
}
