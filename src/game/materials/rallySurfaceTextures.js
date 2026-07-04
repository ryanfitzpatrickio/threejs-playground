import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  texture,
  positionWorld,
  positionLocal,
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
  sub,
  smoothstep,
  fract,
  mx_srgb_texture_to_lin_rec709,
  cameraPosition,
  cameraViewMatrix,
  normalize,
  Fn,
  If,
} from 'three/tsl';
import { puddleMaskAt, puddleRippleNormal } from './wetSurfaceNodes.js';
import { parallaxOcclusionUV } from '../../three-addons/tsl/utils/ParallaxOcclusion.js';

const ROOT = '/assets/textures/rally/surfaces';
const cache = new Map();
const atlasCache = new Map();
const RALLY_PUDDLE_COVERAGE = 0.32;
const RUT_TEXTURE_WIDTH = 1.4;
const RUT_TEXTURE_LENGTH = 3.2;
// World xz sampling — same approach as terrain biome material (~3.2 m per repeat).
export const RALLY_SURFACE_TILES_PER_METRE = 1 / 3.2;

function applyRainWetSurface(material, {
  baseColorNode,
  baseRoughnessNode,
  baseNormalNode,
  rainWetness,
  rainWind,
  // Rally mud (M3): extra puddle coverage where the deform field is wet/deep, so
  // pooled water concentrates in ruts instead of pure noise placement. Null → 0.
  puddleBias = null,
  // Tyre ruts near the camera: keep churned mud matte so rain puddles/SSR don't
  // read as snowy white bands in the tread. Fades out with distance so distant
  // road can still pick up horizon wetness.
  rutGlossSuppress = null,
}) {
  const dampColor = mix(baseColorNode, baseColorNode.mul(0.6), rainWetness);

  // Grazing-angle reflectivity. Real wet asphalt is matte and DARK viewed head-on
  // and only mirrors the sky at shallow (grazing) angles — the classic wet-road
  // look. Instead of one uniform gloss value everywhere, drive roughness from a
  // Fresnel facing term: facing≈1 straight-on → matte (~0.72), facing≈0 grazing →
  // glossy (~0.35). facing² sharpens the falloff so only shallow angles light up.
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(normalWorld.dot(viewDir), float(0), float(1));
  const grazeRoughness = mix(float(0.35), float(0.72), facing.mul(facing));
  const dampRoughness = mix(baseRoughnessNode, grazeRoughness, rainWetness);

  const puddleDetail = smoothstep(90, 20, positionWorld.distance(cameraPosition));
  const coverage = puddleBias != null
    ? rainWetness.mul(RALLY_PUDDLE_COVERAGE).add(puddleBias)
    : rainWetness.mul(RALLY_PUDDLE_COVERAGE);
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
      ).mul(puddleDetail).mul(rainWetness);
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
  puddleColor = mix(puddleColor, dampColor.mul(0.6), rim.mul(0.5)); // muddy sediment ring
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
} = {}) {
  const uv = positionWorld.xz.mul(float(tilesPerMetre));
  const material = new MeshStandardNodeMaterial();

  // POM marches in the geometry's tangent frame (built from the road ribbon's
  // `uv` attribute, which is road-aligned) but every map here samples in world
  // XZ, so the parallax offset direction is rotated by the road's heading. For
  // the fine, near-isotropic dirt/gravel relief this reads as a subtle lean, not
  // a directional error — acceptable for the ultra-only visual pass. `silhouette`
  // stays off: the surface tiles forever, there is no outline to clip.
  const pomEnabled = parallaxOcclusion?.enabled === true && maps?.heightMap != null;
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

  let baseColorNode = maps?.map
    ? (pomColor ? pomColor.sample(maps.map).rgb : texture(maps.map, uv).rgb)
    : color(0x8a7355);
  let baseRoughnessNode = maps?.roughnessMap
    ? (pomColor ? pomColor.sample(maps.roughnessMap).r : texture(maps.roughnessMap, uv).r)
    : float(1);
  let baseNormalNode = maps?.normalMap
    ? normalMap((pomEnabled ? makePom().sample(maps.normalMap) : texture(maps.normalMap, uv)).rgb)
    : null;

  // Base mud treatment: wet-mud brown over the dirt albedo. Kept lighter than the
  // first pass — a heavy mix + 0.82 multiply read too dark in shade and washed
  // to sand only in direct sun.
  if (mudSurface) {
    baseColorNode = mix(baseColorNode, color(0x725636), 0.62).mul(0.94);
    baseRoughnessNode = baseRoughnessNode.mul(0.62);
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
  if (deformTexture != null && deformTilesPerMetre != null) {
    const dUv = positionWorld.xz.mul(float(deformTilesPerMetre));
    const deform = texture(deformTexture, dUv);
    const rut = deform.r; // 0..1 normalized sink depth
    const wet = deform.g; // 0..1 mud wetness
    const tread = deform.b; // 0..1 tread groove strength
    const orientation = orientationTexture != null ? texture(orientationTexture, dUv) : null;
    const vehicleStamp = orientation
      ? smoothstep(float(0.75), float(0.95), orientation.a)
      : float(1);
    const footStamp = orientation
      ? smoothstep(float(0.3), float(0.46), orientation.a)
        .mul(sub(1, smoothstep(float(0.6), float(0.76), orientation.a)))
      : float(0);
    // Fade the whole deform to zero beyond the footprint around the car so the
    // wrapping texture doesn't ghost ruts onto distant road. `present` (0 where
    // no mud was stamped) carries the fade, so everything downstream inherits it.
    let present = deform.a;
    if (deformCenter != null && deformFadeFar > 0) {
      const fade = sub(1, smoothstep(float(deformFadeNear), float(deformFadeFar), positionWorld.xz.distance(deformCenter)));
      present = present.mul(fade);
    }
    // Ruts read as dark CHURNED mud, not water: darken hard and keep them MATTE
    // (raise roughness) so they're clearly distinct from the glossy rain puddles.
    // Tread grooves add darker lines. Gated by `present` so un-stamped road just
    // shows the base mud look.
    const darken = mix(float(1), float(0.42), rut.mul(present))
      .mul(mix(float(1), float(0.78), tread.mul(present)));
    baseColorNode = baseColorNode.mul(darken);
    // Churned mud is rougher than the surrounding wet skin (matte, not slick).
    baseRoughnessNode = mix(baseRoughnessNode, float(0.85), rut.mul(present));

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
      // Narrow, hard-walled channel: only the deep core of the sink shows tread.
      // A single tight smoothstep (was two wide, overlapping ramps on the same
      // depth value) drops the feathered shallow rim (narrower rut) and gives
      // steep walls + a flatter floor instead of a soft round dish (less round).
      const depressionMask = smoothstep(float(0.16), float(0.32), rut)
        .mul(present)
        .mul(vehicleStamp);
      const heavyBlend = smoothstep(float(0.48), float(0.86), rut);
      // Reuse one TextureNode per atlas. Four quadrant samples still consume one
      // sampled-texture binding, avoiding WebGPU's pipeline-layout limit.
      const lightAtlas = texture(rutAtlas);
      const heavyAtlas = heavyRutAtlas != null ? texture(heavyRutAtlas) : lightAtlas;
      const lightHeight = lightAtlas.sample(atlasTileUv(rutUv, 1, 1)).r;
      const heavyHeight = heavyAtlas.sample(atlasTileUv(rutUv, 1, 1)).r;
      const rutHeight = mix(lightHeight, heavyHeight, heavyBlend);
      const imprintMask = depressionMask.mul(mix(
        float(0.7),
        float(1),
        smoothstep(float(0.2), float(0.8), rutHeight),
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
    // Alternating player-foot stamps are encoded as type 0.5 in the orientation
    // texture. Their local wet/depth channels raise puddle coverage only inside
    // each footprint; the global rainWetness gate still removes them when dry.
    puddleBias = smoothstep(float(0.02), float(0.14), rut)
      .mul(wet)
      .mul(footStamp)
      .mul(present)
      .mul(0.95);
    // Keep nearby tyre tread matte under rain — puddle gloss + SSR on low-roughness
    // ruts read as snowy white when you're on top of them. Fade out by ~40 m so
    // distant road can still catch horizon wetness.
    const rutDepthMask = smoothstep(float(0.03), float(0.35), rut).mul(present);
    const rutClose = smoothstep(float(40), float(8), positionWorld.distance(cameraPosition));
    rutGlossSuppress = rutDepthMask.mul(rutClose).mul(vehicleStamp);

    // M2b: vertex sink — push the dense ribbon DOWN into the rut so it's real
    // geometry, not a painted-on shadow. Sampled at the vertex world XZ, gated by
    // presence×fade, scaled to metres by maxDepth.
    if (deformSinkScale > 0 && deformCenter != null && deformFadeFar > 0) {
      const vXZ = positionLocal.xz;
      const dv = texture(deformTexture, vXZ.mul(float(deformTilesPerMetre)));
      const vFade = sub(1, smoothstep(float(deformFadeNear), float(deformFadeFar), vXZ.distance(deformCenter)));
      // Shape the cross-section: remap raw depth through a tight smoothstep so the
      // groove has steep walls and a flatter floor (a defined channel) rather than
      // a soft round dish, and its rim sinks to nothing (narrower).
      const profile = smoothstep(float(0.1), float(0.45), dv.r);
      const sink = profile.mul(dv.a).mul(vFade).mul(float(deformSinkScale));
      material.positionNode = positionLocal.sub(vec3(0, sink, 0));
    }
  }

  if (rainWetness != null && rainWind != null) {
    applyRainWetSurface(material, {
      baseColorNode,
      baseRoughnessNode,
      baseNormalNode,
      rainWetness,
      rainWind,
      puddleBias,
      rutGlossSuppress,
    });
  } else {
    material.colorNode = baseColorNode;
    material.roughnessNode = baseRoughnessNode;
    if (baseNormalNode) material.normalNode = baseNormalNode;
  }

  material.metalnessNode = float(0);
  return material;
}
