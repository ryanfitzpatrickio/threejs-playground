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
  vec2,
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
  fract,
  abs,
  mx_srgb_texture_to_lin_rec709,
} from 'three/tsl';
import { rainWind } from '../systems/weatherUniforms.js';
import { dropletMask, puddleRippleNormal } from './wetSurfaceNodes.js';
import { disablePbrEnvironment } from './disablePbrEnvironment.js';

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
  'orange-car': Object.freeze({
    chassis: new Set(['model_part14']),
    glass: new Set(['model_part12']),
    headlightLens: new Set(['model_part2', 'model_part9', 'model_part10']),
    tailLight: new Set(['model_part1', 'model_part3']),
    wheel: new Set(['model_part5', 'model_part6', 'model_part7', 'model_part8']),
    debris: new Set(['model_part0', 'model_part4', 'model_part11', 'model_part13']),
    chassisPaint: Object.freeze({ color: 0xe85c0a, metalness: 0.12, roughness: 0.38 }),
  }),
  'quad-bike': Object.freeze({
    chassis: new Set([
      'chasis seat',
      'tripo_part_0',
      'tripo_part_2',
      'tripo_part_9',
      'tripo_part_34',
      'tripo_part_35',
      'tripo_part_52',
      'tripo_part_55',
      'tripo_part_57',
      'tripo_part_61',
      'tripo_part_85',
    ]),
    metal: new Set([
      'engine',
      'engine2',
      'engine3',
      'handle bars',
      'inner shocks2',
      'innershocks',
      'innershocks3',
      'innershocks4',
      'shocks1',
      'shocks2',
      'shocks3',
      'shocks4',
    ]),
    glass: new Set(['tripo_part_32', 'tripo_part_33']),
    headlightLens: new Set(['tripo_part_10', 'tripo_part_11']),
    tailLight: new Set(['tripo_part_14', 'tripo_part_15']),
    wheel: new Set(['lf tire', 'rf tire', 'lr tire', 'rr tire']),
    hidden: new Set([
      'tripo_part_4',
      'tripo_part_21',
      'tripo_part_22',
      'tripo_part_24',
      'tripo_part_25',
      'tripo_part_27',
      'tripo_part_30',
      'tripo_part_37',
      'tripo_part_42',
      'tripo_part_45',
      'tripo_part_46',
      'tripo_part_47',
      'tripo_part_49',
      'tripo_part_51',
      'tripo_part_53',
      'tripo_part_54',
      'tripo_part_56',
      'tripo_part_58',
      'tripo_part_59',
      'tripo_part_60',
      'tripo_part_62',
      'tripo_part_63',
      'tripo_part_64',
      'tripo_part_65',
      'tripo_part_66',
      'tripo_part_67',
      'tripo_part_68',
      'tripo_part_69',
      'tripo_part_71',
      'tripo_part_72',
      'tripo_part_73',
      'tripo_part_74',
      'tripo_part_75',
      'tripo_part_76',
      'tripo_part_77',
      'tripo_part_78',
      'tripo_part_79',
      'tripo_part_80',
      'tripo_part_81',
      'tripo_part_82',
      'tripo_part_83',
      'tripo_part_84',
      'tripo_part_86',
      'tripo_part_87',
      'tripo_part_88',
      'tripo_part_89',
      'tripo_part_90',
      'tripo_part_91',
    ]),
    hideUnclassified: true,
  }),
});

export const VEHICLE_OVERLAY_PART = Object.freeze({
  CHASSIS: 'chassis',
  TAIL_LIGHT: 'tailLight',
  HEADLIGHT_LENS: 'headlightLens',
  GLASS: 'glass',
  METAL: 'metal',
  DETAIL: 'detail',
  WHEEL: 'wheel',
  DEBRIS: 'debris',
});

/** Garage UI roles — persisted per chassis in garage builds. */
export const GARAGE_MESH_PART_ROLES = Object.freeze([
  Object.freeze({ id: 'auto', name: 'Auto', description: 'Use name-based detection' }),
  Object.freeze({ id: 'chassis', name: 'Chassis', description: 'Body paint — metallic, texture, mix, or tape' }),
  Object.freeze({ id: 'frontLight', name: 'Front light', description: 'Glass lens + headlight aim target' }),
  Object.freeze({ id: 'windshield', name: 'Windshield / glass', description: 'Transparent glass material' }),
  Object.freeze({ id: 'tailLight', name: 'Tail light', description: 'Red glow when braking' }),
  Object.freeze({ id: 'tire', name: 'Tire', description: 'Hide mesh — use frame tires instead' }),
  Object.freeze({ id: 'metal', name: 'Metal', description: 'Shiny machined metal — engine, shocks, trim' }),
  Object.freeze({ id: 'hide', name: 'Hide', description: 'Remove this mesh from the shell' }),
]);

const GARAGE_MESH_PART_ROLE_IDS = new Set(GARAGE_MESH_PART_ROLES.map((entry) => entry.id));

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

export function createVehicleDebrisMaterial({
  color = 0x2a2e34,
  metalness = 0,
  roughness = 0.42,
  envMapIntensity = 0.45,
  name = 'Vehicle debris',
} = {}) {
  const material = new MeshStandardNodeMaterial();
  material.name = name;
  material.metalness = metalness;
  material.envMapIntensity = envMapIntensity;
  configureOpaqueSurface(material);
  applyWetSurface(material, { baseColorNode: colorTSL(color), baseRoughness: roughness });
  return material;
}

export function adaptSegmentPaintMaterial(material, {
  color = null,
  metalness = 0.08,
  roughness = 0.42,
  envMapIntensity = 0.42,
} = {}) {
  const source = Array.isArray(material) ? material[0] : material;
  let paintColor = color;
  if (paintColor == null && source?.color) {
    paintColor = source.color.getHex();
  } else if (paintColor == null) {
    const factor = source?.pbrMetallicRoughness?.baseColorFactor
      ?? source?.userData?.gltfExtensions?.baseColorFactor;
    if (Array.isArray(factor)) {
      paintColor = new THREE.Color(factor[0], factor[1], factor[2]).getHex();
    }
  }
  return createVehicleDebrisMaterial({
    color: paintColor ?? 0x2a2e34,
    metalness,
    roughness,
    envMapIntensity,
    name: 'Vehicle segment paint',
  });
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

export function createVehicleMachinedMetalMaterial({
  color = 0x8d9298,
  metalness = 0.92,
  roughness = 0.24,
  envMapIntensity = 1.05,
  name = 'Vehicle machined metal',
} = {}) {
  const material = new MeshStandardNodeMaterial();
  material.name = name;
  material.metalness = metalness;
  material.envMapIntensity = envMapIntensity;
  configureOpaqueSurface(material);
  applyWetSurface(material, { baseColorNode: colorTSL(color), baseRoughness: roughness });
  return material;
}

export function getVehiclePartProfile(profileId) {
  return VEHICLE_PART_PROFILES[profileId] ?? null;
}

export function resolveMeshPartKey(mesh) {
  const names = collectMeshAncestryNames(mesh);
  const semantic = names.find((name) => !/^(?:mesh|object)_\d+$/i.test(name));
  return semantic ?? names[0] ?? mesh.name ?? 'mesh';
}

export function resolvePartOverride(mesh, partOverrides = null) {
  if (!partOverrides || typeof partOverrides !== 'object') return null;
  const names = collectMeshAncestryNames(mesh);
  for (const name of names) {
    const role = partOverrides[name];
    if (GARAGE_MESH_PART_ROLE_IDS.has(role) && role !== 'auto') return role;
  }
  return null;
}

export function garagePartRoleToOverlayPart(role) {
  switch (role) {
    case 'chassis':
      return VEHICLE_OVERLAY_PART.CHASSIS;
    case 'frontLight':
      return VEHICLE_OVERLAY_PART.HEADLIGHT_LENS;
    case 'windshield':
      return VEHICLE_OVERLAY_PART.GLASS;
    case 'tailLight':
      return VEHICLE_OVERLAY_PART.TAIL_LIGHT;
    case 'tire':
      return VEHICLE_OVERLAY_PART.WHEEL;
    case 'metal':
      return VEHICLE_OVERLAY_PART.METAL;
    default:
      return null;
  }
}

export function overlayPartToGarageRole(partKind) {
  switch (partKind) {
    case VEHICLE_OVERLAY_PART.CHASSIS:
      return 'chassis';
    case VEHICLE_OVERLAY_PART.HEADLIGHT_LENS:
      return 'frontLight';
    case VEHICLE_OVERLAY_PART.GLASS:
      return 'windshield';
    case VEHICLE_OVERLAY_PART.TAIL_LIGHT:
      return 'tailLight';
    case VEHICLE_OVERLAY_PART.WHEEL:
      return 'tire';
    case VEHICLE_OVERLAY_PART.METAL:
      return 'metal';
    default:
      return 'auto';
  }
}

function isProfileHiddenMesh(mesh, profileId) {
  const hidden = VEHICLE_PART_PROFILES[profileId]?.hidden;
  if (!hidden) return false;
  return collectMeshAncestryNames(mesh).some((name) => hidden.has(name));
}

export function isHiddenVehicleOverlayMesh(mesh, profileId, partOverrides = null) {
  const override = resolvePartOverride(mesh, partOverrides);
  if (override === 'hide' || override === 'tire') return true;
  return isProfileHiddenMesh(mesh, profileId);
}

export function autoDetectGarageMeshPartRole(mesh, profileId = null, {
  disableGlassDetection = false,
} = {}) {
  if (isProfileHiddenMesh(mesh, profileId)) return 'hide';
  const partKind = classifyVehicleOverlayMesh(mesh, profileId, {
    disableGlassDetection,
    partOverrides: null,
  });
  return overlayPartToGarageRole(partKind);
}

export function classifyVehicleOverlayMesh(mesh, profileId = null, {
  disableGlassDetection = false,
  partOverrides = null,
} = {}) {
  const override = resolvePartOverride(mesh, partOverrides);
  if (override === 'hide') return VEHICLE_OVERLAY_PART.DETAIL;
  const overridePart = garagePartRoleToOverlayPart(override);
  if (overridePart) {
    if (overridePart === VEHICLE_OVERLAY_PART.GLASS && disableGlassDetection) {
      return VEHICLE_OVERLAY_PART.CHASSIS;
    }
    return overridePart;
  }

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
    if (names.some((name) => profile.wheel?.has(name))) return VEHICLE_OVERLAY_PART.WHEEL;
    if (names.some((name) => profile.metal?.has(name))) return VEHICLE_OVERLAY_PART.METAL;
    if (names.some((name) => profile.chassis?.has(name))) return VEHICLE_OVERLAY_PART.CHASSIS;
    if (names.some((name) => profile.debris?.has(name))) return VEHICLE_OVERLAY_PART.DEBRIS;
    if (names.some((name) => profile.detail?.has(name))) return VEHICLE_OVERLAY_PART.DETAIL;
    if (profile.hideUnclassified) return VEHICLE_OVERLAY_PART.DETAIL;
    return VEHICLE_OVERLAY_PART.DEBRIS;
  }

  // Prefer semantic names when an authored model provides them. Tripo exports
  // often mix useful labels ("chasis", "glass front") with generic
  // tripo_part_* nodes, as the Subaru rally shell does.
  if (/\b(?:glass|window|windshield|windscreen)\b/.test(label)) {
    return disableGlassDetection ? VEHICLE_OVERLAY_PART.CHASSIS : VEHICLE_OVERLAY_PART.GLASS;
  }
  if (names.some((name) => /^(?:chassis|chasis|body shell)$/i.test(name.replaceAll('_', ' ')))) {
    return VEHICLE_OVERLAY_PART.CHASSIS;
  }
  if (names.some((name) => MUSCLE_2_GLASS_PART_NAMES.has(name))) {
    return disableGlassDetection ? VEHICLE_OVERLAY_PART.CHASSIS : VEHICLE_OVERLAY_PART.GLASS;
  }
  if (names.includes('tripo_part_0')) return VEHICLE_OVERLAY_PART.CHASSIS;
  return VEHICLE_OVERLAY_PART.DETAIL;
}

export function sanitizeChassisPartOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [chassisId, overrides] of Object.entries(value)) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) continue;
    const chassisRoles = {};
    for (const [meshKey, role] of Object.entries(overrides)) {
      const key = String(meshKey).slice(0, 96);
      if (!key || !GARAGE_MESH_PART_ROLE_IDS.has(role) || role === 'auto') continue;
      chassisRoles[key] = role;
    }
    if (Object.keys(chassisRoles).length > 0) clean[String(chassisId).slice(0, 48)] = chassisRoles;
  }
  return clean;
}

export function createVehicleOverlayMaterial(partKind, sourceMaterial = null) {
  switch (partKind) {
    case VEHICLE_OVERLAY_PART.TAIL_LIGHT:
      return createVehicleTailLightMaterial();
    case VEHICLE_OVERLAY_PART.HEADLIGHT_LENS:
      return createVehicleHeadlightLensMaterial();
    case VEHICLE_OVERLAY_PART.GLASS:
      return createVehicleGlassMaterial();
    case VEHICLE_OVERLAY_PART.CHASSIS:
      return createVehicleChassisMaterial();
    case VEHICLE_OVERLAY_PART.METAL:
      return createVehicleMachinedMetalMaterial();
    case VEHICLE_OVERLAY_PART.DEBRIS:
      return adaptSegmentPaintMaterial(sourceMaterial);
    default:
      return createVehicleDetailMaterial();
  }
}

export const CHASSIS_SURFACE_MODES = Object.freeze(['metallic', 'texture', 'mix', 'camo']);

export function chassisModeUsesAuthoredTexture(mode) {
  return mode === 'texture' || mode === 'mix';
}

export function isVehicleCamoCoveredPart(partKind) {
  return partKind !== VEHICLE_OVERLAY_PART.GLASS
    && partKind !== VEHICLE_OVERLAY_PART.HEADLIGHT_LENS
    && partKind !== VEHICLE_OVERLAY_PART.TAIL_LIGHT
    && partKind !== VEHICLE_OVERLAY_PART.WHEEL;
}

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

function stripAuthoredVehiclePaintMaps(material) {
  material.metalness = 0;
  material.metalnessMap = null;
  material.roughnessMap = null;
  material.roughness = THREE.MathUtils.clamp(material.roughness ?? 0.5, 0.42, 0.58);
  material.envMapIntensity = Math.min(material.envMapIntensity ?? 0.45, 0.42);
  material.emissive?.setHex?.(0x000000);
  material.emissiveIntensity = 0;
  material.emissiveMap = null;
}

/** Keep the GLB's albedo maps but drop the metallic paint response. */
export function adaptAuthoredChassisMaterial(material) {
  const source = Array.isArray(material) ? material[0] : material;
  if (!source?.clone) return createVehicleChassisMaterial();
  const adapted = source.clone();
  adapted.name = 'Vehicle chassis (authored texture)';
  stripAuthoredVehiclePaintMaps(adapted);
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
  nodeMaterial.envMapIntensity = 0.4;
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

  // Tripo metallicRoughness maps often bake glossy clearcoat patches that read as
  // grey mirror flecks once metalness is zeroed — use uniform dielectric paint.
  const roughnessScale = THREE.MathUtils.clamp(source.roughness ?? 0.48, 0.4, 0.55);
  const baseRoughnessNode = float(roughnessScale);

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

const OBFUSCATION_TAPE_ALBEDO_URL = '/assets/textures/vehicles/obfuscation-tape-albedo.png';
let obfuscationTapeAlbedo = null;

function createObfuscationTapePlaceholderImage() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, 2, 4);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(2, 0, 2, 4);
  return canvas;
}

function configureObfuscationTapeMap(texture) {
  if (!texture) return null;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // The node controls repeat explicitly. Keeping Texture.repeat neutral avoids
  // applying the repeat twice and makes the sampled UV path unambiguous.
  texture.repeat.set(1, 1);
  texture.anisotropy = Math.max(texture.anisotropy ?? 1, 4);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function loadObfuscationTapeAlbedoMap(uvRepeat = 2) {
  if (typeof document === 'undefined') return null;

  if (!obfuscationTapeAlbedo) {
    const placeholder = createObfuscationTapePlaceholderImage();
    obfuscationTapeAlbedo = configureObfuscationTapeMap(new THREE.Texture(placeholder));
    new THREE.TextureLoader().load(
      OBFUSCATION_TAPE_ALBEDO_URL,
      (loaded) => {
        obfuscationTapeAlbedo.image = loaded.image;
        obfuscationTapeAlbedo.needsUpdate = true;
      },
      undefined,
      (error) => {
        console.warn(`[obfuscationTape] albedo load failed: ${OBFUSCATION_TAPE_ALBEDO_URL}`, error);
      },
    );
  }

  return configureObfuscationTapeMap(obfuscationTapeAlbedo);
}

let obfuscationTapeAlbedoReady = null;

/** Ensure the tape albedo is decoded before overlay materials are built. */
export function preloadObfuscationTapeAlbedo() {
  if (typeof document === 'undefined') return Promise.resolve();
  if (!obfuscationTapeAlbedoReady) {
    obfuscationTapeAlbedoReady = new THREE.TextureLoader().loadAsync(OBFUSCATION_TAPE_ALBEDO_URL)
      .then((loaded) => {
        if (!obfuscationTapeAlbedo) {
          obfuscationTapeAlbedo = configureObfuscationTapeMap(loaded);
        } else {
          obfuscationTapeAlbedo.image = loaded.image;
          obfuscationTapeAlbedo.needsUpdate = true;
        }
      })
      .catch((error) => {
        console.warn(`[obfuscationTape] albedo preload failed: ${OBFUSCATION_TAPE_ALBEDO_URL}`, error);
        obfuscationTapeAlbedoReady = null;
      });
  }
  return obfuscationTapeAlbedoReady;
}

/** Matte dazzle tape — node map on planar UVs (Meshy shells ship without UVs). */
export function createVehicleObfuscationTapeMaterial(_sourceMaterial = null, {
  uvRepeat = 2,
  roughness = 0.9,
  envMapIntensity = 0.18,
  name = 'Vehicle obfuscation tape',
} = {}) {
  const map = loadObfuscationTapeAlbedoMap(uvRepeat);
  const nodeMaterial = new MeshStandardNodeMaterial();
  nodeMaterial.name = name;
  nodeMaterial.metalness = 0;
  nodeMaterial.metalnessNode = float(0);
  nodeMaterial.envMapIntensity = envMapIntensity;
  configureOpaqueSurface(nodeMaterial);

  const uvNode = uv().mul(float(uvRepeat));
  let baseColorNode = colorTSL(0xd0d0d0);
  if (map) {
    baseColorNode = texture(
      configureAuthoredMapTexture(map, { colorSpace: THREE.SRGBColorSpace }),
      uvNode,
    ).rgb;
  }

  nodeMaterial.transparent = false;
  nodeMaterial.opacity = 1;
  nodeMaterial.depthWrite = true;
  nodeMaterial.side = THREE.DoubleSide;

  applyWetSurface(nodeMaterial, {
    baseColorNode,
    baseRoughness: roughness,
    variant: 'opaque',
  });
  disablePbrEnvironment(nodeMaterial);
  return nodeMaterial;
}

export function resolveVehicleOverlayMaterial(partKind, sourceMaterial, {
  chassisSurfaceMode = 'metallic',
  useAuthoredTexture = false,
  profileId = null,
  chassisPaint = null,
} = {}) {
  const profile = VEHICLE_PART_PROFILES[profileId];
  const source = Array.isArray(sourceMaterial) ? sourceMaterial[0] : sourceMaterial;
  const hasAuthoredMaps = Boolean(source?.map || source?.normalMap || source?.roughnessMap);
  const mode = resolveChassisSurfaceMode({ chassisSurfaceMode, useAuthoredTexture });
  const paint = chassisPaint ?? profile?.chassisPaint;

  if (mode === 'camo' && isVehicleCamoCoveredPart(partKind)) {
    return createVehicleObfuscationTapeMaterial(sourceMaterial);
  }

  if (partKind === VEHICLE_OVERLAY_PART.CHASSIS) {
    if (paint && mode === 'metallic') {
      return createVehicleChassisMaterial({
        name: 'Vehicle chassis paint',
        ...paint,
      });
    }
    if (mode === 'texture' && hasAuthoredMaps) return adaptAuthoredChassisMaterial(sourceMaterial);
    if (mode === 'mix' && hasAuthoredMaps) return adaptMixedChassisMaterial(sourceMaterial);
    if (!hasAuthoredMaps && source?.color) {
      return adaptSegmentPaintMaterial(sourceMaterial, { metalness: 0.1, roughness: 0.36 });
    }
  }

  return createVehicleOverlayMaterial(partKind, sourceMaterial);
}
