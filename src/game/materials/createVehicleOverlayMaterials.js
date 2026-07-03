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

function applyWetSurface(material, { baseColorNode, baseRoughness }) {
  const wetness = uniform(0);
  material.wetnessUniform = wetness;

  const upN = normalWorld.y;
  const wetBase = wetness.mul(REFERENCE.wetnessPeak).mul(smoothstep(-0.3, 0.6, upN));
  // The reference's uTopPuddle is a fixed GUI slider (0.7), not gated by
  // uWetness at all — fine in their demo since the model is only ever shown
  // already sitting in active rain. Here the car exists whether it's raining
  // or not, so topMask ALSO needs the live `wetness` factor, or flat
  // surfaces (hood/roof) show puddle pooling and beading permanently
  // regardless of weather (confirmed: this was exactly the bug — droplets
  // visible on the car with rain off).
  const topMask = smoothstep(
    float(REFERENCE.flatThreshold),
    min(float(REFERENCE.flatThreshold + 0.15), float(1)),
    upN,
  ).mul(REFERENCE.topPuddle).mul(wetness);
  const beads = dropletMask(positionWorld, normalWorld, float(REFERENCE.dropletScale))
    .mul(REFERENCE.dropletAmount)
    .mul(wetBase);
  const wetAll = clamp(max(wetBase, topMask), 0, 1);

  material.colorNode = mix(baseColorNode, baseColorNode.mul(float(1).sub(REFERENCE.waterDarkness)), wetAll);

  const gloss = clamp(max(wetBase.mul(0.7), topMask).add(beads), 0, 1);
  material.roughnessNode = mix(float(baseRoughness), float(REFERENCE.puddleRoughness), gloss);

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
  // These materials have no normal map (configureOpaqueSurface clears
  // bumpMap/normalMap), so the "current normal" the reference mixes against
  // is just the plain view-space geometry normal, same as `normalView`.
  material.normalNode = normalize(mix(normalView, rippleView, topMask));

  return wetness;
}

/** Tripo windshield, side, and rear glass shards (node names from muscle-chasis-2). */
const GLASS_PART_NAMES = new Set([
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
  material.color.set(0x9cb0c2);
  material.metalness = 0;
  material.roughness = 0.05;
  material.envMapIntensity = 0.75;
  configureTransparentGlass(material, { opacity: 0.2 });
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

export function classifyVehicleOverlayMesh(mesh) {
  if (isVehicleTailLightMesh(mesh)) return VEHICLE_OVERLAY_PART.TAIL_LIGHT;
  if (isVehicleHeadlightLensMesh(mesh)) return VEHICLE_OVERLAY_PART.HEADLIGHT_LENS;
  const names = collectMeshAncestryNames(mesh);

  if (names.some((name) => GLASS_PART_NAMES.has(name))) return VEHICLE_OVERLAY_PART.GLASS;
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
