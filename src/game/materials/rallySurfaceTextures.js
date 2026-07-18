import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  texture,
  positionWorld,
  positionLocal,
  // Raw vertex attribute — NOT positionLocal. NodeMaterial reassigns the shared
  // positionLocal node to positionNode's result when positionNode is set, so
  // reading positionLocal inside (or after) positionNode sees the override, not
  // the geometry. That silently zeroed the mud vertex sink. See createRainEffect.js
  // header and three Position.js ("use positionGeometry for pre-transformed local").
  positionGeometry,
  float,
  vec3,
  vec4,
  vec2,
  normalMap,
  normalWorld,
  color,
  mix,
  clamp,
  min,
  max,
  sub,
  smoothstep,
  fract,
  mx_srgb_texture_to_lin_rec709,
  cameraPosition,
  cameraViewMatrix,
  normalize,
  Fn,
  If,
  attribute,
  uniform,
  pow,
} from 'three/tsl';
import { puddleMaskAt, puddleRippleNormal } from './wetSurfaceNodes.js';
import { parallaxOcclusionUV } from '../../three-addons/tsl/utils/ParallaxOcclusion.js';
import { RALLY_MUD_TRACK_SRGB } from './rallyMudPalette.js';
import { disablePbrEnvironment } from './disablePbrEnvironment.js';
import { uSunDirection } from '../render/cloud/cloudUniforms.js';
import {
  createHexTileGrid,
  hexBlendWeights,
  hexRotationAngle,
  hexTileUv,
} from './hexTilingNodes.js';

const ROOT = '/assets/textures/rally/surfaces';
const cache = new Map();
const atlasCache = new Map();
const RALLY_PUDDLE_COVERAGE = 0.32;
const RUT_TEXTURE_WIDTH = 1.4;
const RUT_TEXTURE_LENGTH = 3.2;
// World xz sampling — same approach as terrain biome material (~3.2 m per repeat).
export const RALLY_SURFACE_TILES_PER_METRE = 1 / 3.2;

// Default persistent wetness floor for the wet-road variant (Clear sky still
// shows puddles; rain adds on top via max(rain, wetness)).
export const DEFAULT_WET_ROAD_WETNESS = 0.6;

/**
 * Build the rain/wet surface graph. `wetness` is a persistent surface floor
 * (0 for dirt/mud/asphalt — rain-only). Effective wetness = max(rain, wetness).
 * When `envReflections` is set, standing water re-enables sky PMREM IBL
 * (docs/advanced-wet-roads-plan.md M2) instead of reflecting black.
 */
function applyRainWetSurface(material, {
  baseColorNode,
  baseRoughnessNode,
  baseNormalNode,
  rainWetness,
  rainWind,
  // Persistent surface wetness (TSL uniform or float node). Null → rain only.
  wetness = null,
  // Rally mud (M3): extra puddle coverage where the deform field is wet/deep, so
  // pooled water concentrates in ruts instead of pure noise placement. Null → 0.
  puddleBias = null,
  // Tyre ruts near the camera: keep churned mud matte so rain puddles/SSR don't
  // read as snowy white bands in the tread. Fades out with distance so distant
  // road can still pick up horizon wetness.
  rutGlossSuppress = null,
  // Reflective puddles (wet road M2): leave scene PMREM env on and gate the
  // near-mirror to standing water only. When false (default), black out env.
  envReflections = null,
  // Puddle coverage scale (fraction of RALLY_PUDDLE_COVERAGE). Quality preset.
  puddleCoverageScale = 1,
}) {
  // max(rain, surface) so a wet road keeps puddles in Clear weather and rain
  // only adds. Dirt/mud pass wetness=0 → byte-for-byte rain-only behaviour.
  const surfaceWet = wetness != null ? wetness : float(0);
  const effWet = max(rainWetness, surfaceWet);

  const dampColor = mix(baseColorNode, baseColorNode.mul(0.6), effWet);

  // Grazing-angle reflectivity. Real wet asphalt is matte and DARK viewed head-on
  // and only mirrors the sky at shallow (grazing) angles — the classic wet-road
  // look. Instead of one uniform gloss value everywhere, drive roughness from a
  // Fresnel facing term: facing≈1 straight-on → matte (~0.72), facing≈0 grazing →
  // glossy (~0.35). facing² sharpens the falloff so only shallow angles light up.
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(normalWorld.dot(viewDir), float(0), float(1));
  const grazeRoughness = mix(float(0.35), float(0.72), facing.mul(facing));
  const dampRoughness = mix(baseRoughnessNode, grazeRoughness, effWet);

  const puddleDetail = smoothstep(90, 20, positionWorld.distance(cameraPosition));
  const coverageBase = effWet.mul(RALLY_PUDDLE_COVERAGE * puddleCoverageScale);
  const coverage = puddleBias != null
    ? coverageBase.add(puddleBias)
    : coverageBase;
  const puddleResult = Fn(() => {
    const mask = float(0).toVar();
    const rippleN = vec3(0, 1, 0).toVar();

    If(puddleDetail.greaterThan(0), () => {
      const m = puddleMaskAt(
        positionWorld.xz,
        float(0.18),
        vec2(13.7, 4.2),
        coverage,
        float(0.06),
      // The softened FBM threshold can leak a small mask even at coverage=0
      // wherever noise reaches its upper tail. Gate by live wetness so Clear
      // weather reaches an exact zero instead of leaving glossy white bands.
      ).mul(puddleDetail).mul(effWet);
      mask.assign(m);

      const rippleFade = clamp(float(0.18), float(0.02), float(0.8));
      const deepWater = smoothstep(float(0.45), min(float(0.45).add(rippleFade), float(1)), m);
      rippleN.assign(mix(
        vec3(0, 1, 0),
        puddleRippleNormal(positionWorld.xz, rainWind, float(2.2), float(0.04), float(1.3), float(0.2)),
        deepWater,
      ));
    });

    return vec4(mask, rippleN.x, rippleN.y, rippleN.z);
  })();

  let puddleMask = puddleResult.x;
  const rippleWorldNormal = puddleResult.yzw;
  const rippleViewNormal = normalize(cameraViewMatrix.mul(vec4(rippleWorldNormal, 0)).xyz);

  if (rutGlossSuppress != null) {
    puddleMask = puddleMask.mul(float(1).sub(rutGlossSuppress));
  }

  // Puddle depth tiers so pooled water reads as shallow water, not grey paint:
  //   damp road → saturated wet band → darker standing-water core, plus a muddy
  //   sediment rim around the perimeter. The mask value doubles as depth.
  const saturated = smoothstep(float(0.12), float(0.5), puddleMask);
  const standing = smoothstep(float(0.5), float(0.9), puddleMask);
  const rim = saturated.mul(float(1).sub(standing)); // perimeter sediment band

  let puddleColor = mix(dampColor, dampColor.mul(0.5), saturated); // saturated wet
  puddleColor = mix(puddleColor, dampColor.mul(0.32), standing);   // deep water darkest
  // Sediment rim: slightly warmer/muddier so the pool reads as water over mud,
  // not a hole punched to the sky (composes under the env reflection).
  puddleColor = mix(puddleColor, dampColor.mul(vec3(0.62, 0.55, 0.42)), rim.mul(0.55));
  material.colorNode = puddleColor;

  // Standing water is a near-mirror (roughness ~0.05) so it POPS against the matte
  // road; saturated asphalt is glossy-but-broken (~0.28). Coverage of true
  // standing water is small, so head-on sky reflection there is intended, not the
  // old blown-out white patches (those came from making the WHOLE puddle a mirror).
  let wetRoughness = mix(dampRoughness, float(0.28), saturated);
  wetRoughness = mix(wetRoughness, float(0.05), standing);
  if (rutGlossSuppress != null) {
    // Churned tread stays matte up close even under rain + SSR.
    wetRoughness = mix(wetRoughness, float(0.84), rutGlossSuppress);
  }
  material.roughnessNode = wetRoughness;
  if (baseNormalNode) {
    material.normalNode = normalize(mix(baseNormalNode, rippleViewNormal, puddleMask));
  } else {
    material.normalNode = rippleViewNormal;
  }

  // M2 reflective puddles: r185 has no environmentIntensityNode, so the wet
  // variant skips disablePbrEnvironment and uses the scene PMREM. Standing-water
  // roughness (0.05) carries the sky/peak mirror; the damp floor stays high-
  // roughness so it does not go polished-marble. Fresnel weight is already in
  // the graze roughness term above. SSR stays reflectNonMetals:false (Q2).
  if (envReflections?.enabled) {
    // Schlick fresnel boosts the near-mirror core so pools flash harder at
    // grazing angles without raising env on the whole road (roughness does that).
    const F0 = float(0.04);
    const oneMinusFacing = float(1).sub(facing);
    const fresnel = F0.add(float(1).sub(F0).mul(pow(oneMinusFacing, float(5))));
    // Slight cool tint on the standing core so the reflected sky reads as water.
    const coolTint = mix(vec3(1, 1, 1), vec3(0.88, 0.93, 1.0), standing.mul(0.35));
    material.colorNode = mix(
      material.colorNode,
      material.colorNode.mul(coolTint),
      standing.mul(fresnel).mul(float(envReflections.envIntensity ?? 1)),
    );
    // Expose for probes / snapshots (CPU).
    material.userData.wetEnvReflections = {
      standingGate: true,
      envIntensity: envReflections.envIntensity ?? 1,
      fresnel: envReflections.fresnel !== false,
    };
  }

  material.userData.wetSurface = {
    hasWetnessUniform: wetness != null && wetness.isUniformNode,
    envReflections: Boolean(envReflections?.enabled),
  };
}

function configureMap(texture, { colorSpace = THREE.NoColorSpace, repeat = 1 } = {}) {
  if (!texture) return texture;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export function loadRallySurfaceSet(name) {
  if (cache.has(name)) return cache.get(name);
  if (typeof document === 'undefined') {
    const empty = { map: null, normalMap: null, roughnessMap: null, heightMap: null };
    cache.set(name, empty);
    return empty;
  }

  const loader = new THREE.TextureLoader();
  const base = `${ROOT}/${name}`;
  const maps = {
    map: configureMap(loader.load(`${base}/albedo.png`), {
      colorSpace: THREE.SRGBColorSpace,
    }),
    normalMap: configureMap(loader.load(`${base}/normal.png`)),
    roughnessMap: configureMap(loader.load(`${base}/roughness.png`)),
    heightMap: configureMap(loader.load(`${base}/height.png`)),
  };
  cache.set(name, maps);
  return maps;
}

export function loadRallyRutAtlas(name) {
  if (atlasCache.has(name)) return atlasCache.get(name);
  if (typeof document === 'undefined') {
    atlasCache.set(name, null);
    return null;
  }
  const atlas = configureMap(
    new THREE.TextureLoader().load(`/assets/textures/rally/${name}-atlas.png`),
  );
  atlasCache.set(name, atlas);
  return atlas;
}

function atlasTileUv(baseUv, col, row) {
  return fract(baseUv).mul(0.5).add(vec2(col * 0.5, row * 0.5));
}

export function setRallySurfaceRepeat(maps, repeatU, repeatV = repeatU) {
  for (const key of ['map', 'normalMap', 'roughnessMap', 'heightMap']) {
    const texture = maps?.[key];
    if (texture) texture.repeat.set(repeatU, repeatV);
  }
}

/**
 * PBR rally surface material sampled in world xz so tiling stays even on narrow
 * road ribbons and streamed chunks (vertex UVs shear/stretch on long strips).
 */
export function createRallySurfaceMaterial(maps, {
  tilesPerMetre = RALLY_SURFACE_TILES_PER_METRE,
  rainWetness = null,
  rainWind = null,
  // Persistent surface wetness (0..1). Number → owned uniform; TSL uniform →
  // reused. Dirt/mud leave null (rain-only). Wet roads pass ~0.6 floor.
  wetness = null,
  // Reflective puddles (docs/advanced-wet-roads-plan.md M2). When enabled the
  // material does NOT call disablePbrEnvironment so standing water mirrors the
  // scene sky PMREM. `{ enabled, envIntensity, fresnel }`.
  envReflections = null,
  // Puddle coverage multiplier (quality preset). 1 = default RALLY_PUDDLE_COVERAGE.
  puddleCoverageScale = 1,
  // Extra puddleBias toward road edges / low spots (wet M3). 0..1 strength.
  lowSpotBias = 0,
  // Compacted wheel-line darkening + slight gloss (wet M3). false = off.
  tireTracks = false,
  // Rally mud deform texture (docs/rally-mud-tread-plan.md, M2). When present the
  // material darkens ruts, wets them, and reads a tread groove — sampled by the
  // SAME positionWorld.xz node, +1 sampler (3 → 4, well under the 16 budget).
  // R = depth/maxDepth, G = wetness, B = tread, A = presence mask.
  deformTexture = null,
  orientationTexture = null,
  deformTilesPerMetre = null,
  // Directional PBR tread atlas. `roadMark` supplies lateral metres + arc
  // length, so this texture follows bends and repeats continuously end-to-end.
  rutAtlas = null,
  heavyRutAtlas = null,
  // Mud roads reuse the dirt textures but read as MUD: a dark, wet, brown base
  // (distinct from dry gravel) even before any tyre has cut a rut.
  mudSurface = false,
  // Wet road base: slightly cooler/darker dirt, not full mud brown.
  wetSurface = false,
  // Real geometric ruts (M2b): displace the dense ribbon down by deform depth ×
  // this scale (metres = maxDepth). Faded to 0 beyond the footprint around
  // `deformCenter` (a vec2 uniform of the car XZ) since the texture wraps.
  deformSinkScale = 0,
  deformCenter = null,
  deformFadeNear = 0,
  deformFadeFar = 0,
  // Parallax occlusion mapping (docs/silhouette-pom-plan.md). Ultra-only quality
  // gate `{ enabled, scale, minLayers, maxLayers }`; when enabled and the surface
  // set carries a height map (already loaded but otherwise unused), the base
  // albedo/roughness/normal maps are sampled at the raymarched offset UV so the
  // dirt/gravel gets real self-occluding relief instead of a flat normal map.
  parallaxOcclusion = null,
  // Practical hex tiling. It takes precedence over POM because POM's samples
  // must all use one coherent height field and cannot share rotated tile UVs.
  hextile = null,
  // Optional sRGB albedo multiply (e.g. sand-tinted dirt, painted concrete).
  // Applied after map/hex sample and before mud/wet treatments.
  albedoTint = null,
  // Multiplier on sampled roughness (sand piles, dry dirt).
  roughnessScale = 1,
} = {}) {
  const uv = positionWorld.xz.mul(float(tilesPerMetre));
  const material = new MeshStandardNodeMaterial();

  // POM marches in the geometry's tangent frame (built from the road ribbon's
  // `uv` attribute, which is road-aligned) but every map here samples in world
  // XZ, so the parallax offset direction is rotated by the road's heading. For
  // the fine, near-isotropic dirt/gravel relief this reads as a subtle lean, not
  // a directional error — acceptable for the ultra-only visual pass. `silhouette`
  // stays off: the surface tiles forever, there is no outline to clip.
  const hexEnabled = hextile?.enabled === true;
  const pomEnabled = !hexEnabled && parallaxOcclusion?.enabled === true && maps?.heightMap != null;
  // maxLayers is a compile-time loop bound and cannot be faded at runtime; fade
  // the relief depth instead so distant road flattens (and avoids swim/shimmer)
  // while the raymarch still resolves fine near the camera. The fade reaches out
  // to ~130 m because POM only reads at grazing angles — i.e. the road receding
  // into the mid/far field — so an aggressive near fade cancels the whole effect.
  const pomScale = pomEnabled
    ? float(parallaxOcclusion.scale ?? 0.03)
      .mul(smoothstep(float(130), float(18), positionWorld.distance(cameraPosition)))
    : null;
  const makePom = () => parallaxOcclusionUV(maps.heightMap, {
    uvNode: uv,
    scale: pomScale,
    minLayers: parallaxOcclusion.minLayers ?? 8,
    maxLayers: parallaxOcclusion.maxLayers ?? 32,
    silhouette: false,
  });
  // colorNode + roughnessNode share one march; normalNode compiles in its own
  // sub-build and must not share a march result (addon constraint) → a 2nd call.
  const pomColor = pomEnabled ? makePom() : null;

  let hexColor = null;
  let hexScalar = null;
  let hexNormal = null;
  if (hexEnabled) {
    const grid = createHexTileGrid(positionWorld.xz, vec2(0), tilesPerMetre);
    const rotStrength = hextile.roadRotStrength ?? 0.35;
    const uv1 = hexTileUv(uv, grid.vertex1, rotStrength);
    const uv2 = hexTileUv(uv, grid.vertex2, rotStrength);
    const uv3 = hexTileUv(uv, grid.vertex3, rotStrength);
    // Roads expose blend discontinuities strongly under rain/SSR. Keep one
    // shared, soft set of weights for every PBR channel so albedo, roughness,
    // and normals cannot resolve into different visible hex regions.
    const weights = hexBlendWeights(
      grid.weights,
      vec3(1),
      0,
      hextile.roadExponent ?? 2,
    );

    hexColor = (map) => {
      const c1 = texture(map, uv1).rgb;
      const c2 = texture(map, uv2).rgb;
      const c3 = texture(map, uv3).rgb;
      return c1.mul(weights.x).add(c2.mul(weights.y)).add(c3.mul(weights.z));
    };
    hexScalar = (map) => {
      const s1 = texture(map, uv1).r;
      const s2 = texture(map, uv2).r;
      const s3 = texture(map, uv3).r;
      return s1.mul(weights.x).add(s2.mul(weights.y)).add(s3.mul(weights.z));
    };
    hexNormal = (map) => {
      const rotateNormal = (sample, vertex) => {
        const decoded = sample.mul(2).sub(1);
        const angle = hexRotationAngle(vertex, rotStrength);
        const cs = angle.cos();
        const sn = angle.sin();
        const rotated = vec3(
          decoded.x.mul(cs).sub(decoded.y.mul(sn)),
          decoded.x.mul(sn).add(decoded.y.mul(cs)),
          decoded.z,
        );
        return rotated.mul(0.5).add(0.5);
      };
      const n1 = rotateNormal(texture(map, uv1).rgb, grid.vertex1);
      const n2 = rotateNormal(texture(map, uv2).rgb, grid.vertex2);
      const n3 = rotateNormal(texture(map, uv3).rgb, grid.vertex3);
      return n1.mul(weights.x).add(n2.mul(weights.y)).add(n3.mul(weights.z));
    };
  }

  let baseColorNode = maps?.map
    ? (pomColor ? pomColor.sample(maps.map).rgb : (hexColor ? hexColor(maps.map) : texture(maps.map, uv).rgb))
    : color(0x8a7355);
  let baseRoughnessNode = maps?.roughnessMap
    ? (pomColor ? pomColor.sample(maps.roughnessMap).r : (hexScalar ? hexScalar(maps.roughnessMap) : texture(maps.roughnessMap, uv).r))
    : float(1);
  let baseNormalNode = maps?.normalMap
    ? normalMap(pomEnabled ? makePom().sample(maps.normalMap).rgb : (hexNormal ? hexNormal(maps.normalMap) : texture(maps.normalMap, uv).rgb))
    : null;

  if (albedoTint != null) {
    baseColorNode = baseColorNode.mul(color(albedoTint));
  }
  if (Number.isFinite(roughnessScale) && roughnessScale !== 1) {
    baseRoughnessNode = clamp(baseRoughnessNode.mul(float(roughnessScale)), float(0.05), float(1));
  }

  // Base mud treatment: wet-mud brown over the dirt albedo. Matte + sun-facing
  // compression keep clear-sky noon from blowing the ribbon out to pale sand.
  if (mudSurface) {
    baseColorNode = mix(baseColorNode, color(RALLY_MUD_TRACK_SRGB), 0.84);
    baseRoughnessNode = clamp(baseRoughnessNode.mul(0.82), float(0.45), float(1));
    const sunFacing = clamp(normalWorld.dot(normalize(uSunDirection)), float(0), float(1));
    const sunBleachFix = mix(float(1), float(0.70), sunFacing.mul(sunFacing));
    baseColorNode = baseColorNode.mul(sunBleachFix);
  } else if (wetSurface) {
    // Wet road: cooler, darker dirt — between dry gravel and full mud brown.
    baseColorNode = mix(baseColorNode, color(0x5a4a38), 0.42);
    baseRoughnessNode = clamp(baseRoughnessNode.mul(0.9), float(0.4), float(1));
    const sunFacing = clamp(normalWorld.dot(normalize(uSunDirection)), float(0), float(1));
    baseColorNode = baseColorNode.mul(mix(float(1), float(0.82), sunFacing.mul(sunFacing)));
  }

  // Break the uniform gloss with LARGE-scale roughness variation — shallow
  // depressions, repaired patches and longitudinal wheel grooves vary the shine
  // over metres, not per-texel, which is what the eye reads as a real wet road
  // (vs the fine "noisy highlight" look of a single-scale roughness map). Sample
  // the roughness texture again at a macro scale — same binding, +1 sample, +0
  // sampler bindings, well under the 16-per-stage WebGPU budget.
  if (maps?.roughnessMap) {
    const macro = texture(maps.roughnessMap, uv.mul(float(0.13))).r;
    baseRoughnessNode = clamp(
      baseRoughnessNode.mul(mix(float(0.8), float(1.2), macro)),
      float(0.05),
      float(1),
    );
  }

  // Fold the deform field into the base colour/roughness BEFORE the rain pass so
  // wet ruts read correctly and M3 can couple deform into the puddle mask.
  let puddleBias = null;
  let rutGlossSuppress = null;

  // Wet M3: low-spot / edge puddle bias + compacted wheel-line darkening.
  // Uses the ribbon `roadMark` attribute (lateral m, arc, half-width) — zero samplers.
  if (wetSurface && (lowSpotBias > 0 || tireTracks)) {
    const mark = attribute('roadMark', 'vec3');
    const lateral = mark.x; // signed metres from centreline
    const halfW = max(mark.z, float(0.5));
    const latNorm = clamp(lateral.abs().div(halfW), float(0), float(1)); // 0 centre → 1 edge

    if (lowSpotBias > 0) {
      // Water gathers at the edges (camber runoff) and in large-scale low spots
      // from the height map / noise — not pure FBM scatter.
      const edgePool = smoothstep(float(0.55), float(0.95), latNorm);
      let lowSpot = float(0);
      if (maps?.heightMap) {
        // Lower height texels → more pooling. Invert + soft threshold.
        const h = texture(maps.heightMap, uv.mul(float(0.45))).r;
        lowSpot = smoothstep(float(0.55), float(0.2), h);
      } else {
        // Fallback: large-scale world noise standing in for depressions.
        const n = fract(positionWorld.xz.mul(vec2(0.07, 0.09)).dot(vec2(12.9898, 78.233)).sin().mul(43758.5453));
        lowSpot = smoothstep(float(0.55), float(0.85), n);
      }
      const bias = edgePool.mul(0.55).add(lowSpot.mul(0.7)).mul(float(lowSpotBias));
      puddleBias = puddleBias != null ? puddleBias.add(bias) : bias;
    }

    if (tireTracks) {
      // Two wheel lines at ~±35% of half-width (typical rally track). Compacted
      // tracks hold water, dry slower — darken + slight roughness drop (glint).
      const trackOffset = halfW.mul(0.35);
      const trackWidth = float(0.22);
      const leftTrack = float(1).sub(smoothstep(float(0), trackWidth, lateral.sub(trackOffset).abs()));
      const rightTrack = float(1).sub(smoothstep(float(0), trackWidth, lateral.add(trackOffset).abs()));
      const tracks = clamp(leftTrack.add(rightTrack), float(0), float(1));
      baseColorNode = mix(baseColorNode, baseColorNode.mul(0.72), tracks.mul(0.85));
      baseRoughnessNode = mix(baseRoughnessNode, float(0.38), tracks.mul(0.35));
      // Slight extra puddle coverage on the tracks (they hold water).
      const trackBias = tracks.mul(0.12);
      puddleBias = puddleBias != null ? puddleBias.add(trackBias) : trackBias;
    }
  }
  if (deformTexture != null && deformTilesPerMetre != null) {
    // Sample deform by world XZ. Use positionWorld for fragment (after any
    // vertex sink, XZ is unchanged). Scale matches mudDeformField torus UV.
    const deformTiles = float(deformTilesPerMetre);
    const dUv = positionWorld.xz.mul(deformTiles);
    // One TextureNode base; .sample(uv) clones with that UV (live .value ref).
    const deformMap = texture(deformTexture);
    const orientMap = orientationTexture != null ? texture(orientationTexture) : null;
    const deform = deformMap.sample(dUv);
    const rut = deform.r; // 0..1 normalized sink depth
    const wet = deform.g; // 0..1 mud wetness
    const tread = deform.b; // 0..1 tread groove strength
    const orientation = orientMap != null ? orientMap.sample(dUv) : null;
    // orientation.a encodes stamp kind: foot ~0.5, preworn ~0.75, vehicle ~1.0
    // (mudDeformField KIND_*). Tyre tread atlas must cover BOTH live vehicle and
    // pre-worn demo laps — the old smoothstep(0.75,0.95) zeroed preworn at 0.75.
    const tyreStamp = orientation
      ? smoothstep(float(0.62), float(0.78), orientation.a)
      : float(1);
    const footStamp = orientation
      ? smoothstep(float(0.3), float(0.46), orientation.a)
        .mul(sub(1, smoothstep(float(0.55), float(0.68), orientation.a)))
      : float(0);
    // Soft footprint fade only at the outer edge so trails stay visible behind
    // the car. (Hard fade previously zeroed the whole stage when center lagged.)
    let present = deform.a;
    if (deformCenter != null && deformFadeFar > 0) {
      const fade = sub(1, smoothstep(float(deformFadeNear), float(deformFadeFar), positionWorld.xz.distance(deformCenter)));
      // Keep at least 35% strength even at the edge so ruts never fully vanish
      // due to center lag; torus ghosts stay mild.
      present = present.mul(mix(float(0.35), float(1), fade));
    }
    // Ruts read as dark CHURNED mud, not water: darken hard and keep them MATTE
    // (raise roughness) so they're clearly distinct from the glossy rain puddles.
    // Strong enough that tracks still read even if vertex sink fails to compile.
    // Gated by `present` so un-stamped road just shows the base mud look.
    const darken = mix(float(1), float(0.32), rut.mul(present))
      .mul(mix(float(1), float(0.55), tread.mul(present).mul(tyreStamp)))
      // Paw/human prints do not have a tread atlas. Give their oriented pad/
      // sole mask its own dark, wet compression so small stamps remain legible
      // beside a broad body splash instead of disappearing into base mud.
      .mul(mix(float(1), float(0.38), tread.mul(present).mul(footStamp)));
    baseColorNode = baseColorNode.mul(darken);
    // Churned mud is rougher than the surrounding wet skin (matte, not slick).
    baseRoughnessNode = mix(baseRoughnessNode, float(0.88), rut.mul(present).mul(tyreStamp));
    baseRoughnessNode = mix(
      baseRoughnessNode,
      float(0.76),
      rut.mul(present).mul(footStamp),
    );

    if (rutAtlas != null && orientationTexture != null) {
      // Decode the heading written by each wheel stamp. Projecting world XZ onto
      // this local frame rotates the atlas with a sliding/angled tyre instead of
      // forcing every tread to follow the authored road centreline.
      const rutDirection = normalize(orientation.rg.mul(2).sub(1));
      const rutLateral = vec2(rutDirection.y.negate(), rutDirection.x);
      const lateralCycle = positionWorld.xz.dot(rutLateral).div(RUT_TEXTURE_WIDTH);
      const rutUv = vec2(
        fract(lateralCycle.sub(orientation.b).add(0.5)),
        positionWorld.xz.dot(rutDirection).div(RUT_TEXTURE_LENGTH),
      );
      // Channel mask — open early so a single pass still imprints the atlas
      // (normalized rut often ~0.15–0.5 after brush falloff).
      const depressionMask = smoothstep(float(0.04), float(0.18), rut)
        .mul(present)
        .mul(tyreStamp);
      const heavyBlend = smoothstep(float(0.35), float(0.78), rut);
      // Reuse one TextureNode per atlas. Four quadrant samples still consume one
      // sampled-texture binding, avoiding WebGPU's pipeline-layout limit.
      const lightAtlas = texture(rutAtlas);
      const heavyAtlas = heavyRutAtlas != null ? texture(heavyRutAtlas) : lightAtlas;
      const lightHeight = lightAtlas.sample(atlasTileUv(rutUv, 1, 1)).r;
      const heavyHeight = heavyAtlas.sample(atlasTileUv(rutUv, 1, 1)).r;
      const rutHeight = mix(lightHeight, heavyHeight, heavyBlend);
      const imprintMask = depressionMask.mul(mix(
        float(0.75),
        float(1),
        smoothstep(float(0.15), float(0.75), rutHeight),
      ));
      const lightColor = mx_srgb_texture_to_lin_rec709(lightAtlas.sample(atlasTileUv(rutUv, 0, 0)).rgb);
      const heavyColor = mx_srgb_texture_to_lin_rec709(heavyAtlas.sample(atlasTileUv(rutUv, 0, 0)).rgb);
      const rutColor = mix(lightColor, heavyColor, heavyBlend);
      // Let the tread fully replace the base mud inside the channel — it was
      // capped at 94% (× a 0.55 floor), so the road mud always bled through and
      // washed the tread out. Now the rut reads as its own churned-tread surface.
      baseColorNode = mix(baseColorNode, rutColor.mul(0.9), imprintMask);

      const lightRoughness = lightAtlas.sample(atlasTileUv(rutUv, 0, 1)).r;
      const heavyRoughness = heavyAtlas.sample(atlasTileUv(rutUv, 0, 1)).r;
      const rutRoughness = clamp(mix(lightRoughness, heavyRoughness, heavyBlend), float(0.68), float(0.92));
      baseRoughnessNode = mix(baseRoughnessNode, rutRoughness, imprintMask);

      const lightNormal = lightAtlas.sample(atlasTileUv(rutUv, 1, 0)).rgb;
      const heavyNormal = heavyAtlas.sample(atlasTileUv(rutUv, 1, 0)).rgb;
      const tangentNormal = mix(lightNormal, heavyNormal, heavyBlend).mul(2).sub(1);
      const rutWorldNormal = normalize(vec3(
        rutLateral.x.mul(tangentNormal.x).add(rutDirection.x.mul(tangentNormal.y)),
        tangentNormal.z,
        rutLateral.y.mul(tangentNormal.x).add(rutDirection.y.mul(tangentNormal.y)),
      ));
      const rutNormal = normalize(cameraViewMatrix.mul(vec4(rutWorldNormal, 0)).xyz);
      baseNormalNode = baseNormalNode
        ? normalize(mix(baseNormalNode, rutNormal, imprintMask))
        : rutNormal;
    }
    // Puddles pool in tyre grooves (and foot stamps). ADD to any wet-road edge
    // bias instead of replacing it so wet+tread keeps both.
    const groovePuddle = smoothstep(float(0.04), float(0.22), rut)
      .mul(wet)
      .mul(present)
      .mul(tyreStamp.add(footStamp))
      .mul(0.95);
    puddleBias = puddleBias != null ? puddleBias.add(groovePuddle) : groovePuddle;
    // Keep nearby tyre tread matte under rain — puddle gloss + SSR on low-roughness
    // ruts read as snowy white when you're on top of them. Fade out by ~40 m so
    // distant road can still catch horizon wetness.
    const rutDepthMask = smoothstep(float(0.03), float(0.35), rut).mul(present);
    const rutClose = smoothstep(float(40), float(8), positionWorld.distance(cameraPosition));
    rutGlossSuppress = rutDepthMask.mul(rutClose).mul(tyreStamp);

    // M2b: vertex sink — push the dense ribbon DOWN into the rut so it's real
    // geometry. MUST use positionGeometry inside Fn (raw attribute). NodeMaterial
    // reassigns positionLocal to positionNode's result; reading positionLocal in
    // the sink graph compiles to a no-op / circular node and leaves the ribbon
    // flat (see createRainEffect.js). Road ribbons bake world XZ into the
    // position attribute with the mesh at the origin → geometry.xz == world.xz.
    if (deformSinkScale > 0) {
      const sinkScale = float(deformSinkScale);
      const tiles = float(deformTilesPerMetre);
      const hasFade = deformCenter != null && deformFadeFar > 0;
      const fadeNear = float(deformFadeNear || 0);
      const fadeFar = float(deformFadeFar || 1);
      material.positionNode = Fn(() => {
        const geoPos = positionGeometry.toVar();
        const vXZ = geoPos.xz;
        const dv = deformMap.sample(vXZ.mul(tiles));
        let vFade = float(1);
        if (hasFade) {
          vFade = mix(
            float(0.35),
            float(1),
            sub(1, smoothstep(fadeNear, fadeFar, vXZ.distance(deformCenter))),
          );
        }
        // Open early so a single tyre pass carves a clear trough.
        const profile = smoothstep(float(0.02), float(0.18), dv.r);
        const sink = profile.mul(dv.a).mul(vFade).mul(sinkScale);
        return geoPos.sub(vec3(0, sink, 0));
      })();
    }
  }

  // Own a TSL wetness uniform when a number floor is passed so callers can
  // read/write `.value` (CPU grip / probes) without rebuilding the node graph.
  let wetnessNode = null;
  let wetnessUniform = null;
  if (wetness != null) {
    if (typeof wetness === 'number') {
      wetnessUniform = uniform(wetness);
      wetnessNode = wetnessUniform;
    } else {
      wetnessNode = wetness;
      wetnessUniform = wetness.isUniformNode ? wetness : null;
    }
  }

  if (rainWetness != null && rainWind != null) {
    applyRainWetSurface(material, {
      baseColorNode,
      baseRoughnessNode,
      baseNormalNode,
      rainWetness,
      rainWind,
      wetness: wetnessNode,
      puddleBias,
      rutGlossSuppress,
      envReflections: envReflections?.enabled ? envReflections : null,
      puddleCoverageScale,
    });
  } else {
    material.colorNode = baseColorNode;
    material.roughnessNode = baseRoughnessNode;
    if (baseNormalNode) material.normalNode = baseNormalNode;
  }

  material.metalnessNode = float(0);
  if (wetnessUniform) {
    material.userData.wetnessUniform = wetnessUniform;
    // Convenience alias for CPU readers (grip worsen, probes).
    material.wetnessUniform = wetnessUniform;
  }
  // Reflective puddles need the scene sky PMREM (RendererSystem.installEnvironment).
  // r185 has no environmentIntensityNode — Q1 resolved: skip the black-out so
  // standing water (roughness 0.05) mirrors sky/peaks; damp floor stays high-
  // roughness so the road does not go polished marble. Dirt/mud still black out.
  if (!envReflections?.enabled) {
    disablePbrEnvironment(material);
  }
  return material;
}
