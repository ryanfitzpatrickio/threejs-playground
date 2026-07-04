import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  uniform,
  color as colorTSL,
  mix,
  max,
  min,
  clamp,
  float,
  vec3,
  vec4,
  uv,
  texture,
  normalMap,
  positionWorld,
  normalWorld,
  normalView,
  cameraViewMatrix,
  normalize,
  smoothstep,
} from 'three/tsl';
import { rainWind } from '../systems/weatherUniforms.js';
import { dropletMask, puddleRippleNormal } from './wetSurfaceNodes.js';

// Direct TSL port of the reference repo's `makeWet()` wet-surface shader
// (github.com/achrefelouafi/RainSystemThreeJS, src/model.js WET_HEADER),
// applied to the car's own paint instead of a dropped GLB — same formulas,
// same constants, just driven by a per-vehicle `wetness` uniform (0..1)
// instead of the reference's static uWetness/uTopPuddle sliders. Not
// ported: the reference's separate GPU "deflection droplet" particle system
// (droplets bouncing off a model's flat top, found via a CPU raycast scan of
// the mesh) — that's a distinct subsystem on top of this shader, not part
// of the wet-surface technique itself.
const REFERENCE = {
  wetnessPeak: 0.85, // uWetness
  topPuddle: 0.7, // uTopPuddle
  flatThreshold: 0.65, // uFlatThreshold
  dropletAmount: 0.6, // uDropletAmount
  dropletScale: 14.0, // uDropletScale
  waterDarkness: 0.45, // uWaterDarkness
  puddleRoughness: 0.05, // uPuddleRoughness
  rainRipple: 0.04,
  rippleScale: 6.0,
  rippleSpeed: 1.3,
  rippleDensity: 0.2,
};

function applyWetSurface(material, {
  baseColorNode,
  baseRoughness,
  baseRoughnessNode,
  baseNormalNode,
  variant = 'opaque',
} = {}) {
  const wetness = uniform(0);
  material.wetnessUniform = wetness;
  const isGlass = variant === 'glass';

  const upN = normalWorld.y;
  const wetBase = isGlass
    ? wetness.mul(REFERENCE.wetnessPeak).mul(float(0.92))
    : wetness.mul(REFERENCE.wetnessPeak).mul(smoothstep(-0.3, 0.6, upN));
  // The reference's uTopPuddle is a fixed GUI slider (0.7), not gated by
  // uWetness at all — fine in their demo since the model is only ever shown
  // already sitting in active rain. Here the car exists whether it's raining
  // or not, so topMask ALSO needs the live `wetness` factor, or flat
  // surfaces (hood/roof) show puddle pooling and beading permanently
  // regardless of weather (confirmed: this was exactly the bug — droplets
  // visible on the car with rain off).
  const topMask = isGlass
    ? float(0)
    : smoothstep(
      float(REFERENCE.flatThreshold),
      min(float(REFERENCE.flatThreshold + 0.15), float(1)),
      upN,
    ).mul(REFERENCE.topPuddle).mul(wetness);
  const beadStrength = isGlass ? REFERENCE.dropletAmount * 1.15 : REFERENCE.dropletAmount;
  const beads = dropletMask(positionWorld, normalWorld, float(REFERENCE.dropletScale))
    .mul(beadStrength)
    .mul(wetBase);
  const wetAll = clamp(max(wetBase, topMask), 0, 1);
  const waterDarkness = isGlass ? 0.18 : REFERENCE.waterDarkness;

  material.colorNode = mix(baseColorNode, baseColorNode.mul(float(1).sub(waterDarkness)), wetAll);

  const gloss = clamp(max(wetBase.mul(0.7), topMask).add(beads), 0, 1);
  const wetRoughness = isGlass ? 0.02 : REFERENCE.puddleRoughness;
  const dryRoughness = baseRoughnessNode ?? float(baseRoughness ?? 0.5);
  material.roughnessNode = mix(dryRoughness, float(wetRoughness), gloss);

  const rippleWorldNormal = mix(
    vec3(0, 1, 0),
    puddleRippleNormal(
      positionWorld.xz,
      rainWind,
      float(REFERENCE.rippleScale),
      float(REFERENCE.rainRipple),
      float(REFERENCE.rippleSpeed),
      float(REFERENCE.rippleDensity),
    ),
    topMask,
  );
  const rippleView = normalize(cameraViewMatrix.mul(vec4(rippleWorldNormal, 0)).xyz);
  const dryNormal = baseNormalNode ?? normalView;
  material.normalNode = isGlass
    ? normalView
    : normalize(mix(dryNormal, rippleView, topMask));

  return wetness;
}

/** Tripo windshield, side, and rear glass shards (node names from muscle-chasis-2). */
const MUSCLE_2_GLASS_PART_NAMES = new Set([
  'tripo_part_10',
  'tripo_part_12',
  'tripo_part_26',
  'tripo_part_27',
  'tripo_part_29',
  'tripo_part_30',
  'tripo_part_34',
  'tripo_part_38',
  'tripo_part_58',
  'tripo_part_64',
  'tripo_part_67',
  'tripo_part_74',
  'tripo_part_77',
  'tripo_part_79',
  'tripo_part_80',
  'tripo_part_81',
  'tripo_part_82',
  'tripo_part_83',
  'tripo_part_84',
  'tripo_part_95',
  'tripo_part_96',
  'tripo_part_97',
  'tripo_part_98',
  'tripo_part_99',
  'tripo_part_100',
  'tripo_part_101',
  'tripo_part_102',
  'tripo_part_103',
  'tripo_part_104',
  'tripo_part_107',
  'tripo_part_112',
  'tripo_part_113',
  'tripo_part_114',
  'tripo_part_115',
  'tripo_part_116',
  'tripo_part_117',
  'tripo_part_118',
]);

const VEHICLE_PART_PROFILES = Object.freeze({
  'muscle-2': Object.freeze({ glass: MUSCLE_2_GLASS_PART_NAMES }),
  'subaru-rally': Object.freeze({
    chassis: new Set(['chasis']),
    glass: new Set(['glass front', 'rear glass', 'tripo_part_2', 'tripo_part_4', 'tripo_part_9', 'tripo_part_23']),
    headlightLens: new Set(['tripo_part_11', 'tripo_part_12']),
    tailLight: new Set(['tripo_part_14', 'tripo_part_15']),
  }),
});

export const VEHICLE_OVERLAY_PART = Object.freeze({
  CHASSIS: 'chassis',
  TAIL_LIGHT: 'tailLight',
  HEADLIGHT_LENS: 'headlightLens',
  GLASS: 'glass',
  DETAIL: 'detail',
});

function configureOpaqueSurface(material) {
  material.flatShading = false;
  material.normalMap = null;
  material.bumpMap = null;
}

function configureTransparentGlass(material, {
  opacity,
  depthWrite = false,
  doubleSide = true,
} = {}) {
  configureOpaqueSurface(material);
  material.transparent = true;
  material.opacity = opacity;
  material.depthWrite = depthWrite;
  if (doubleSide) {
    material.side = THREE.DoubleSide;
    material.shadowSide = THREE.DoubleSide;
  }
}

/**
 * Rain response: darkens + drops roughness with a per-vehicle `wetness`
 * uniform (0..1, own instance per material — each vehicle gets a fresh
 * material at spawn, so unlike the shared terrain/road wetness there's no
 * reason to share this one), plus procedural droplet beading (small normal
 * bumps + locally-sharpened roughness inside droplet blobs) once wet. The
 * material stays MeshStandardNodeMaterial (no clearcoat/MeshPhysicalNodeMaterial
 * upgrade) — the same color/roughness/normal wet-look technique already reads
 * convincingly wet on roads/terrain, so this reuses that idiom rather than
 * adding a new shading model just for vehicles.
 *
 * `material.wetnessUniform` is exposed for BaseVehicle to ramp per-frame
 * based on the current weather.
 */
export function createVehicleChassisMaterial({
  color = 0x1a1e28,
  metalness = 0.92,
  roughness = 0.16,
  envMapIntensity = 1.15,
  name = 'Vehicle chassis paint',
} = {}) {
  const material = new MeshStandardNodeMaterial();
  material.name = name;
  material.metalness = metalness;
  material.envMapIntensity = envMapIntensity;
  configureOpaqueSurface(material);

  applyWetSurface(material, { baseColorNode: colorTSL(color), baseRoughness: roughness });

  return material;
}

export function collectMeshAncestryNames(mesh) {
  const names = [];
  let node = mesh;
  while (node) {
    if (node.name) names.push(node.name);
    const userDataName = node.userData?.name;
    if (userDataName && userDataName !== node.name) names.push(userDataName);
    node = node.parent;
  }
  return names;
}

/** GLTFLoader sanitizes spaces to underscores — normalize before name tests. */
function normalizedPartLabel(names) {
  return names.join(' ').toLowerCase().replaceAll('_', ' ');
}

export function isVehicleTailLightMesh(mesh) {
  return collectMeshAncestryNames(mesh).some((name) => /tail[_\s]*light/i.test(name));
}

export function isVehicleHeadlightLensMesh(mesh) {
  const label = normalizedPartLabel(collectMeshAncestryNames(mesh));
  return /front(?:\s+head)?\s+light/.test(label);
}

export function createVehicleTailLightMaterial() {
  const material = new THREE.MeshStandardMaterial({
    name: 'Vehicle tail light',
    color: 0x5a0a06,
    emissive: 0x000000,
    emissiveIntensity: 0,
    metalness: 0,
    roughness: 0.2,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  return material;
}

/** Brake glow for tail-light materials (brake01 is 0..1, smoothed each frame). */
export function updateVehicleTailLightEmissive(material, brake01) {
  if (!material) return;
  const glow = THREE.MathUtils.clamp(brake01, 0, 1);
  if (glow <= 0.001) {
    material.emissive.setHex(0x000000);
    material.emissiveIntensity = 0;
    material.color.setHex(0x5a0a06);
  } else {
    material.emissive.setHex(0xff0000);
    material.emissiveIntensity = 2 + glow * 10;
    material.color.setHex(0xff2200);
  }
  material.needsUpdate = true;
}

export function createVehicleHeadlightLensMaterial() {
  const material = new MeshStandardNodeMaterial();
  material.name = 'Vehicle headlight lens';
  material.color.set(0xf4f7ff);
  material.metalness = 0;
  material.roughness = 0.04;
  material.envMapIntensity = 0.95;
  configureTransparentGlass(material, { opacity: 0.28 });
  return material;
}

export function createVehicleGlassMaterial() {
  const material = new MeshStandardNodeMaterial();
  material.name = 'Vehicle glass';
  material.metalness = 0;
  material.envMapIntensity = 0.75;
  configureTransparentGlass(material, { opacity: 0.2 });

  applyWetSurface(material, {
    baseColorNode: colorTSL(0x9cb0c2),
    baseRoughness: 0.05,
    variant: 'glass',
  });

  return material;
}

export function createVehicleDetailMaterial() {
  const material = new MeshStandardNodeMaterial();
  material.name = 'Vehicle detail metal';
  material.metalness = 0;
  material.envMapIntensity = 0.55;
  configureOpaqueSurface(material);

  // Same wet-surface treatment as the chassis (see applyWetSurface) —
  // trim/bumpers get the same puddle/beading response for consistency.
  applyWetSurface(material, { baseColorNode: colorTSL(0x2a2e34), baseRoughness: 0.38 });

  return material;
}

export function classifyVehicleOverlayMesh(mesh, profileId = null, { disableGlassDetection = false } = {}) {
  if (isVehicleTailLightMesh(mesh)) return VEHICLE_OVERLAY_PART.TAIL_LIGHT;
  if (isVehicleHeadlightLensMesh(mesh)) return VEHICLE_OVERLAY_PART.HEADLIGHT_LENS;
  const names = collectMeshAncestryNames(mesh);
  const label = normalizedPartLabel(names);
  const profile = VEHICLE_PART_PROFILES[profileId];
  if (profile) {
    if (names.some((name) => profile.tailLight?.has(name))) return VEHICLE_OVERLAY_PART.TAIL_LIGHT;
    if (names.some((name) => profile.headlightLens?.has(name))) return VEHICLE_OVERLAY_PART.HEADLIGHT_LENS;
    if (names.some((name) => profile.glass?.has(name))) {
      return disableGlassDetection ? VEHICLE_OVERLAY_PART.CHASSIS : VEHICLE_OVERLAY_PART.GLASS;
    }
    if (names.some((name) => profile.chassis?.has(name))) return VEHICLE_OVERLAY_PART.CHASSIS;
  }

  // Prefer semantic names when an authored model provides them. Tripo exports
  // often mix useful labels ("chasis", "glass front") with generic
  // tripo_part_* nodes, as the Subaru rally shell does.
  if (/\b(?:glass|window|windshield|windscreen)\b/.test(label)) {
    return disableGlassDetection ? VEHICLE_OVERLAY_PART.CHASSIS : VEHICLE_OVERLAY_PART.GLASS;
  }
  if (/\b(?:chassis|chasis|body shell)\b/.test(label)) return VEHICLE_OVERLAY_PART.CHASSIS;
  if (names.some((name) => MUSCLE_2_GLASS_PART_NAMES.has(name))) {
    return disableGlassDetection ? VEHICLE_OVERLAY_PART.CHASSIS : VEHICLE_OVERLAY_PART.GLASS;
  }
  if (names.includes('tripo_part_0')) return VEHICLE_OVERLAY_PART.CHASSIS;
  return VEHICLE_OVERLAY_PART.DETAIL;
}

export function createVehicleOverlayMaterial(partKind) {
  switch (partKind) {
    case VEHICLE_OVERLAY_PART.TAIL_LIGHT:
      return createVehicleTailLightMaterial();
    case VEHICLE_OVERLAY_PART.HEADLIGHT_LENS:
      return createVehicleHeadlightLensMaterial();
    case VEHICLE_OVERLAY_PART.GLASS:
      return createVehicleGlassMaterial();
    case VEHICLE_OVERLAY_PART.CHASSIS:
      return createVehicleChassisMaterial();
    default:
      return createVehicleDetailMaterial();
  }
}

export const CHASSIS_SURFACE_MODES = Object.freeze(['metallic', 'texture', 'mix']);

export function resolveChassisSurfaceMode({
  chassisSurfaceMode,
  useAuthoredTexture = false,
} = {}) {
  if (CHASSIS_SURFACE_MODES.includes(chassisSurfaceMode)) return chassisSurfaceMode;
  return useAuthoredTexture ? 'texture' : 'metallic';
}

function configureAuthoredMapTexture(mapTexture, { colorSpace = THREE.NoColorSpace } = {}) {
  if (!mapTexture) return null;
  mapTexture.colorSpace = colorSpace;
  mapTexture.anisotropy = Math.max(mapTexture.anisotropy ?? 1, 4);
  mapTexture.needsUpdate = true;
  return mapTexture;
}

/** Keep the GLB's albedo maps but drop the metallic paint response. */
export function adaptAuthoredChassisMaterial(material) {
  const source = Array.isArray(material) ? material[0] : material;
  if (!source?.clone) return createVehicleChassisMaterial();
  const adapted = source.clone();
  adapted.name = 'Vehicle chassis (authored texture)';
  adapted.metalness = 0;
  adapted.roughness = Math.max(adapted.roughness ?? 0.75, 0.72);
  adapted.envMapIntensity = Math.min(adapted.envMapIntensity ?? 0.55, 0.65);
  if (adapted.metalnessMap) adapted.metalnessMap = null;
  if (adapted.map) configureAuthoredMapTexture(adapted.map, { colorSpace: THREE.SRGBColorSpace });
  adapted.transparent = false;
  adapted.opacity = 1;
  adapted.depthWrite = true;
  adapted.side = THREE.DoubleSide;
  return adapted;
}

/** Authored albedo + normal/roughness maps with dielectric paint and rain response. */
export function adaptMixedChassisMaterial(material) {
  const source = Array.isArray(material) ? material[0] : material;
  if (!source?.map && !source?.color) return createVehicleChassisMaterial();

  const nodeMaterial = new MeshStandardNodeMaterial();
  nodeMaterial.name = 'Vehicle chassis (authored PBR mix)';
  nodeMaterial.metalness = 0;
  nodeMaterial.metalnessNode = float(0);
  nodeMaterial.envMapIntensity = Math.min(source.envMapIntensity ?? 0.9, 1.05);
  configureOpaqueSurface(nodeMaterial);

  const uvNode = uv();
  let baseColorNode = colorTSL(source.color?.getHex?.() ?? 0x1a1e28);
  if (source.map) {
    baseColorNode = texture(
      configureAuthoredMapTexture(source.map, { colorSpace: THREE.SRGBColorSpace }),
      uvNode,
    ).rgb;
  }

  let baseNormalNode = null;
  if (source.normalMap) {
    baseNormalNode = normalMap(
      texture(configureAuthoredMapTexture(source.normalMap), uvNode).rgb,
    );
  }

  const roughnessScale = THREE.MathUtils.clamp(source.roughness ?? 0.42, 0.28, 0.58);
  let baseRoughnessNode = float(roughnessScale);
  if (source.roughnessMap) {
    baseRoughnessNode = texture(
      configureAuthoredMapTexture(source.roughnessMap),
      uvNode,
    ).g.mul(float(roughnessScale));
  }

  nodeMaterial.transparent = false;
  nodeMaterial.opacity = 1;
  nodeMaterial.depthWrite = true;
  nodeMaterial.side = THREE.DoubleSide;

  applyWetSurface(nodeMaterial, {
    baseColorNode,
    baseRoughnessNode,
    baseNormalNode,
    variant: 'opaque',
  });

  return nodeMaterial;
}

export function resolveVehicleOverlayMaterial(partKind, sourceMaterial, {
  chassisSurfaceMode = 'metallic',
  useAuthoredTexture = false,
} = {}) {
  const mode = resolveChassisSurfaceMode({ chassisSurfaceMode, useAuthoredTexture });
  if (partKind === VEHICLE_OVERLAY_PART.CHASSIS) {
    if (mode === 'texture') return adaptAuthoredChassisMaterial(sourceMaterial);
    if (mode === 'mix') return adaptMixedChassisMaterial(sourceMaterial);
  }
  return createVehicleOverlayMaterial(partKind);
}
