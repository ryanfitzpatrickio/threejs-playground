/**
 * Horde Mode arena — abandoned mall flowing into an industrial train yard.
 *
 * The player starts in a square four-way mall concourse, with a complete ring
 * of retail storefronts around the perimeter. A back-of-house shipping hall
 * opens into the original gravel yard, parallel tracks, freight-car cover,
 * and corrugated spawn perimeter.
 *
 * Layout stays open enough for direct-steering AI (docs/horde-mode-plan.md).
 */

import * as THREE from 'three';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  attribute,
  color,
  cos,
  float,
  max,
  min,
  mix,
  normalMap,
  normalView,
  positionLocal,
  positionViewDirection,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSkyscraperMaterial } from '../../three-addons/generators/city/SkyscraperGenerator.js';
import {
  createHexTileGrid,
  hexBlendWeights,
  hexRotationAngle,
  hexTileUv,
} from '../materials/hexTilingNodes.js';
import { getQualityLevel, getQualityPreset } from '../config/qualityPresets.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { createMaterialWarmupGroup } from './createMaterialWarmupGroup.js';
import { getGroundHeightAt, getBlockingColliderAt } from './createBaseLevel.js';
import { addHordeCityFurniture } from './hordeCityFurniture.js';
import { createPropaneTank } from '../items/createPropaneTank.js';
const FLOOR_Y = 0;
/** Half-extent of the square combat yard (full width = 2 * HALF). */
const HALF = 36;
const WALL_H = 4.2;
const WALL_T = 0.45;
const GATE_W = 3.6;
const GATE_H = 3.0;
const PLAYER_SAFE_RADIUS = 10;
const MIN_GATE_SPACING = 4.5;

/** Mall sits directly west of the existing yard and shares its ground plane. */
const MALL_CENTER_X = -82;
const MALL_HALF = 34;
const MALL_WALL_H = 7.2;
const MALL_WALL_T = 0.5;
const MALL_STORE_DEPTH = 7.2;
const MALL_STOREFRONT_HALF = MALL_HALF - MALL_STORE_DEPTH;
const MALL_SHOP_H = 4.6;
const MALL_CROSS_W = 11;
const MALL_RING_W = 8;
const MALL_ATRIUM_HALF = 12;
const AQUARIUM_OFFSET = MALL_CROSS_W * 0.72;
const AQUARIUM_SIZE = 3.8;
// Sized to fit inside a single east storefront bay (bay pitch ≈ 5.96). The
// storefront skip margin is SHIPPING_HALF_W + 0.8, so staying under ~3.0 keeps
// the two bays flanking the exit built instead of leaving dead facade gaps.
const SHIPPING_HALF_W = 2.9;
// The public-facing shipping portal aligns with the final east storefront.
// A second portal at the exterior shell creates a deep, padded vestibule.
const SHIPPING_X0 = MALL_CENTER_X + MALL_STOREFRONT_HALF;
const SHIPPING_MALL_SHELL_X = MALL_CENTER_X + MALL_HALF;
const SHIPPING_X1 = -HALF;

/**
 * West retail leg — a winding single-loaded gallery that bends twice on the
 * way to a food-court last-stand room. Axis-aligned legs keep colliders /
 * navmesh simple while the offsets read as a curvy corridor from inside.
 * Path length storefront-line → court mouth ≈ 140 m (~2× the mall width).
 */
const LEG_HALF_W = 4.5;
const LEG_STORE_DEPTH = 6;
const LEG_WALL_H = 5.6;
const LEG_CEIL_Y = 5.32;
const LEG_BAY = 5.9;
/** West end of leg A (east face of the first bend pocket). */
const LEG_A_X1 = -154;
/** West face of the north–south bend corridor (leg B x ∈ [LEG_B_X, LEG_A_X1]). */
const LEG_B_X = -163;
/** Leg C centreline; leg B climbs to it and leg C runs west on it. */
const LEG_C_Z = 30.5;
/** West end of leg C — food court east wall. */
const LEG_C_X1 = -218;
/** Food court: half the mall footprint (48×48 ≈ 68²/2), last-stand room. */
const FOOD_HALF = 24;
const FOOD_WALL_H = 7.2;
const FOOD_CEIL_Y = 6.9;
const FOOD_CX = LEG_C_X1 - FOOD_HALF;
const FOOD_CZ = LEG_C_Z;

/** Rolling-stock scale (approx US freight, readable as cover). */
const BOXCAR_L = 15.4;
const BOXCAR_W = 3.2;
/** Body height above deck — taller cars read as better cover and roof hang targets. */
const BOXCAR_H = 4.35;
const TANK_L = 14.6;
const TANK_W = 3.0;
const TANK_R = 1.35;
/**
 * Visual coupler gap (still reads as a continuous rake). Colliders are shorter
 * than the body so the player can jump through the connection pocket.
 */
const COUPLER_GAP = 0.85;
/** How much each car collider is inset from the visual ends (metres per end). */
const COLLIDER_END_INSET = 0.55;
/**
 * Deck floor height. Must sit in LedgeHangSystem's grab window
 * (LEDGE_GRAB_MIN/MAX_ROOT_DROP ≈ 1.05–1.75 m above root) so door-sill and
 * low hang edges are actually attachable from the gravel.
 */
const DECK_Y = 1.28;
const DOOR_BAY = 2.95;
const DOOR_PANEL_W = 2.75;
const DOOR_SLIDE = 2.65;
const DOOR_INTERACT_RADIUS = 3.2;

const RANGE_TEXTURE_ROOT = '/assets/textures/range';
const WALL_TILE_M = 2.8;
const METAL_TILE_M = 1.85;
const WOOD_TILE_M = 1.4;
const GRAVEL_TILE_M = 3.2;

// ── Warehouse / range PBR ───────────────────────────────────────────────────

function loadRangeTexture(path, {
  repeatX = 1,
  repeatY = 1,
  srgb = false,
} = {}) {
  if (typeof document === 'undefined') return null;
  const texture = new THREE.TextureLoader().load(`${RANGE_TEXTURE_ROOT}/${path}`);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  return texture;
}

function loadRangePbrSet(folder, { repeatX = 1, repeatY = 1 } = {}) {
  const shared = { repeatX, repeatY };
  return {
    map: loadRangeTexture(`${folder}/albedo.png`, { ...shared, srgb: true }),
    normalMap: loadRangeTexture(`${folder}/normal.png`, shared),
    roughnessMap: loadRangeTexture(`${folder}/roughness.png`, shared),
    aoMap: loadRangeTexture(`${folder}/height.png`, shared),
  };
}

function makePbrMaterial(pbr, {
  roughness = 0.88,
  metalness = 0.03,
  envMapIntensity = 0.5,
  normalScale = 1,
  aoMapIntensity = 0.7,
  color = 0xffffff,
} = {}) {
  return new THREE.MeshStandardMaterial({
    map: pbr.map,
    normalMap: pbr.normalMap,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughnessMap: pbr.roughnessMap,
    roughness,
    metalness,
    aoMap: pbr.aoMap,
    aoMapIntensity,
    color,
    envMapIntensity,
  });
}

// Practical hex tiling (same quality gate as terrain / rally / shooting range).
// Node scripts have no DOM (textures load as null) and no GPU — fall back to
// the plain sampled materials there so verify harnesses keep working.
const HEXTILE = typeof document !== 'undefined'
  ? (getQualityPreset(getQualityLevel()).terrainHextile ?? null)
  : null;
const HEX_ENABLED = HEXTILE?.enabled === true;

/**
 * Hex-tiled variant of makePbrMaterial for the big repeating surfaces (floors,
 * walls, ceilings). Samples the same PBR set three times on a rotated/jittered
 * simplex lattice so 40–70 m slabs stop reading as a wallpaper repeat. Drives
 * the grid from the mesh `uv` attribute — prepareBoxGeometry already stamps
 * world-metre UVs per box face, so one material works for horizontal AND
 * vertical surfaces (positionWorld.xz would smear down walls).
 *
 * `rotStrength` 0 keeps coursed textures (brick) unrotated: tiles still get
 * translational jitter but mortar lines stay horizontal across blend seams.
 */
function makeHexPbrMaterial(pbr, {
  roughness = 0.88,
  metalness = 0.03,
  envMapIntensity = 0.5,
  normalScale = 1,
  aoMapIntensity = 0.7,
  color: tint = 0xffffff,
  rotStrength = 0.35,
} = {}) {
  if (!HEX_ENABLED || !pbr?.map) {
    return makePbrMaterial(pbr, {
      roughness, metalness, envMapIntensity, normalScale, aoMapIntensity, color: tint,
    });
  }
  const material = new MeshStandardNodeMaterial();
  material.metalness = metalness;
  material.envMapIntensity = envMapIntensity;
  // colorNode below overrides map for shading, but prepareBoxGeometry keys its
  // world-metre UV stamping off material.map — keep it assigned.
  material.map = pbr.map;

  // UVs are already in tile units (metres / tileMeters), so rate = 1.
  const st = uv();
  const grid = createHexTileGrid(st, vec2(0), 1);
  const rot = float(rotStrength);
  const uv1 = hexTileUv(st, grid.vertex1, rot);
  const uv2 = hexTileUv(st, grid.vertex2, rot);
  const uv3 = hexTileUv(st, grid.vertex3, rot);

  const c1 = texture(pbr.map, uv1).rgb;
  const c2 = texture(pbr.map, uv2).rgb;
  const c3 = texture(pbr.map, uv3).rgb;
  // Luminance-weighted blend (terrain recipe) hides the soft triple-blend zone.
  const lumVec = vec3(0.299, 0.587, 0.114);
  const weights = hexBlendWeights(
    grid.weights,
    vec3(c1.dot(lumVec), c2.dot(lumVec), c3.dot(lumVec)),
    HEXTILE.falloffContrast ?? 0.6,
    HEXTILE.exponent ?? 7,
  );
  const blendColor = c1.mul(weights.x).add(c2.mul(weights.y)).add(c3.mul(weights.z));
  const blendScalar = (map) => texture(map, uv1).r.mul(weights.x)
    .add(texture(map, uv2).r.mul(weights.y))
    .add(texture(map, uv3).r.mul(weights.z));

  material.colorNode = blendColor.mul(color(tint));
  if (pbr.roughnessMap) {
    material.roughnessNode = blendScalar(pbr.roughnessMap).mul(roughness).clamp(0, 1);
  } else {
    material.roughness = roughness;
  }
  if (pbr.normalMap) {
    // Counter-rotate each tangent-space sample by its tile rotation so bump
    // direction stays consistent after the coordinate rotation.
    const rotateNormal = (sample, vertex) => {
      const decoded = sample.mul(2).sub(1);
      const angle = hexRotationAngle(vertex, rot);
      const cs = angle.cos();
      const sn = angle.sin();
      return vec3(
        decoded.x.mul(cs).sub(decoded.y.mul(sn)),
        decoded.x.mul(sn).add(decoded.y.mul(cs)),
        decoded.z,
      ).mul(0.5).add(0.5);
    };
    const n1 = rotateNormal(texture(pbr.normalMap, uv1).rgb, grid.vertex1);
    const n2 = rotateNormal(texture(pbr.normalMap, uv2).rgb, grid.vertex2);
    const n3 = rotateNormal(texture(pbr.normalMap, uv3).rgb, grid.vertex3);
    const blendNormal = n1.mul(weights.x).add(n2.mul(weights.y)).add(n3.mul(weights.z));
    material.normalNode = normalMap(blendNormal, vec2(normalScale, normalScale));
  }
  if (pbr.aoMap) {
    material.aoNode = mix(float(1), blendScalar(pbr.aoMap), float(aoMapIntensity));
  }
  return material;
}

const concretePbr = loadRangePbrSet('concrete');
const metalRoofPbr = loadRangePbrSet('metalroof');
const woodPbr = loadRangePbrSet('woodwall');
const brickPbr = loadRangePbrSet('brickwall');
const rustPbr = loadRangePbrSet('pillarmiddle');
const rustEndPbr = loadRangePbrSet('pillarend');

/** Yard gravel — warehouse concrete PBR, warm grit tint + heavy normal. */
const gravelMat = makeHexPbrMaterial(concretePbr, {
  roughness: 0.96,
  metalness: 0.02,
  normalScale: 1.4,
  aoMapIntensity: 0.85,
  color: 0x7a7468,
  rotStrength: 0.6,
});

const wallMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.72,
  metalness: 0.55,
  normalScale: 1.15,
  color: 0xc8c2b4,
});
const railMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.42,
  metalness: 0.82,
  normalScale: 0.9,
  color: 0x9a9ea4,
});
const tieMat = makePbrMaterial(woodPbr, {
  roughness: 0.92,
  metalness: 0.02,
  color: 0x6a5640,
});
const boxcarBodyMat = makePbrMaterial(rustPbr, {
  roughness: 0.78,
  metalness: 0.35,
  color: 0xb07048,
});
const boxcarRoofMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.65,
  metalness: 0.6,
  color: 0x8a9096,
});
const boxcarDoorMat = makePbrMaterial(rustEndPbr, {
  roughness: 0.7,
  metalness: 0.4,
  color: 0x8a5a38,
});
const tankShellMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.48,
  metalness: 0.72,
  color: 0x6a7880,
});
const tankChassisMat = makePbrMaterial(rustPbr, {
  roughness: 0.82,
  metalness: 0.3,
  color: 0x5a4a3a,
});
const tankBandMat = makePbrMaterial(rustEndPbr, {
  roughness: 0.55,
  metalness: 0.55,
  color: 0x3a3e42,
});
const shedMat = makeHexPbrMaterial(brickPbr, {
  roughness: 0.9,
  metalness: 0.04,
  color: 0xc4b8a8,
  rotStrength: 0,
});
const gateFrameMat = makePbrMaterial(rustEndPbr, {
  roughness: 0.7,
  metalness: 0.45,
  color: 0x8a6a48,
});
const shutterMat = makePbrMaterial(metalRoofPbr, {
  roughness: 0.68,
  metalness: 0.5,
  color: 0x4a5056,
});
const accentMat = makePbrMaterial(rustPbr, {
  roughness: 0.62,
  metalness: 0.4,
  color: 0xa04028,
});
const ballastMat = makeHexPbrMaterial(concretePbr, {
  roughness: 0.97,
  metalness: 0.02,
  normalScale: 1.5,
  color: 0x6e685c,
  rotStrength: 0.6,
});
const mallFloorMat = makeHexPbrMaterial(concretePbr, {
  roughness: 0.58,
  metalness: 0.04,
  normalScale: 0.35,
  aoMapIntensity: 0.45,
  color: 0xb7b0a4,
  rotStrength: 0.3,
});
const mallWallMat = makeHexPbrMaterial(brickPbr, {
  roughness: 0.86,
  metalness: 0.03,
  normalScale: 0.55,
  color: 0x9b9283,
  rotStrength: 0,
});
const mallCeilingMat = makeHexPbrMaterial(concretePbr, {
  roughness: 0.92,
  metalness: 0.01,
  normalScale: 0.25,
  color: 0x6f716d,
  rotStrength: 0.4,
});
const mallTrimMat = new THREE.MeshStandardMaterial({
  color: 0x292b2c,
  roughness: 0.62,
  metalness: 0.28,
});
const mallPlanterMat = new THREE.MeshStandardMaterial({
  color: 0x51483d,
  roughness: 0.93,
  metalness: 0.02,
});
const mallAccentMat = new THREE.MeshStandardMaterial({
  color: 0x24545a,
  roughness: 0.7,
  metalness: 0.12,
});
const mallLightMat = new THREE.MeshStandardMaterial({
  color: 0xdce8e8,
  emissive: 0xb9d7d8,
  emissiveIntensity: 2.4,
  roughness: 0.35,
  metalness: 0.02,
});
// ── Food court furnishing palette ──────────────────────────────────────────
const foodTableTopMat = new THREE.MeshStandardMaterial({
  color: 0xd9cfc0,
  roughness: 0.34,
  metalness: 0.05,
  envMapIntensity: 0.7,
});
// Frames / kicks share mallTrimMat (defined above) — every distinct material
// is one more static merge batch, so the palette stays lean on purpose.
const foodChairFrameMat = mallTrimMat;
const foodCounterKickMat = mallTrimMat;
const foodSeatMats = [0xc4552e, 0x2e7a72].map((c) => new THREE.MeshStandardMaterial({
  color: c,
  roughness: 0.58,
  metalness: 0.04,
}));
const foodCounterMat = new THREE.MeshStandardMaterial({
  color: 0x7c4a2a,
  roughness: 0.55,
  metalness: 0.06,
  envMapIntensity: 0.55,
});
const foodSignMats = [0xd2452e, 0x2f8a5b, 0xe0a832].map((c) => new THREE.MeshStandardMaterial({
  color: c,
  roughness: 0.5,
  metalness: 0.08,
  emissive: c,
  emissiveIntensity: 0.22,
}));
const foodGuardGlassMat = new THREE.MeshStandardMaterial({
  color: 0xdfeef0,
  transparent: true,
  opacity: 0.26,
  roughness: 0.08,
  metalness: 0,
  depthWrite: false,
  envMapIntensity: 1.1,
});
const foodFoliageMat = new THREE.MeshStandardMaterial({
  color: 0x2f5d33,
  roughness: 0.95,
  metalness: 0,
});

const mallAquariumGlassMat = createMallAquariumGlassMaterial();
const mallAquariumWaterMat = createMallAquariumWaterMaterial();
const mallAquariumFishMat = createMallAquariumFishMaterial();
// Reuse the city generator's ground-floor TSL material verbatim. SHOPGLASS
// panes below carry the same partId + roomCenter + roomSize attributes, so
// each mall window raymarches shelves, displays, counters, and lit interiors.
const mallStorefrontMat = createSkyscraperMaterial(color(0x9f9280));

const MATERIALS = [
  gravelMat, wallMat, railMat, tieMat, boxcarBodyMat, boxcarRoofMat, boxcarDoorMat,
  tankShellMat, tankChassisMat, tankBandMat, shedMat, gateFrameMat, shutterMat,
  accentMat, ballastMat, mallFloorMat, mallWallMat, mallCeilingMat, mallTrimMat,
  mallPlanterMat, mallAccentMat, mallLightMat, mallStorefrontMat,
  mallAquariumGlassMat, mallAquariumWaterMat, mallAquariumFishMat,
  foodTableTopMat, ...foodSeatMats, foodCounterMat,
  ...foodSignMats, foodGuardGlassMat, foodFoliageMat,
];

function createMallAquariumGlassMaterial() {
  const fresnel = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(3);
  const material = new MeshPhysicalNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.12,
    metalness: 0,
    ior: 1.42,
    transmission: 0.18,
    thickness: 0.18,
  });
  material.colorNode = mix(color(0x6eb5ba), color(0xe8fbff), fresnel.mul(0.8));
  material.opacity = 1;
  material.opacityNode = mix(float(0.07), float(0.26), fresnel);
  material.userData.mallAquariumGlass = true;
  return material;
}

function createMallAquariumWaterMaterial() {
  // In-tank volume stays blue aquarium water; jets / floor pools are separate
  // pale translucent materials (createWaterJetRenderer / createMallWaterHeightfield).
  const t = time;
  const rippleX = sin(positionWorld.x.mul(2.2).add(t.mul(1.35)))
    .add(sin(positionWorld.y.mul(1.4).sub(t.mul(0.7))));
  const rippleZ = cos(positionWorld.z.mul(2.0).sub(t.mul(1.1)))
    .add(sin(positionWorld.y.mul(1.8).add(t.mul(0.8))));
  const material = new MeshStandardNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  const shimmer = rippleX.add(rippleZ).mul(0.18).add(0.5).clamp(0.12, 0.88);
  material.colorNode = mix(color(0x063a4d), color(0x2a9a9b), shimmer);
  material.normalNode = vec3(rippleX.mul(0.035), float(1), rippleZ.mul(0.035)).normalize();
  material.roughnessNode = float(0.16);
  material.metalnessNode = float(0);
  material.opacity = 1;
  material.opacityNode = float(0.34);
  material.emissiveNode = mix(color(0x00151f), color(0x07565c), shimmer).mul(0.22);
  material.userData.mallAquariumWater = true;
  return material;
}

function createMallAquariumFishMaterial() {
  const seed = attribute('fishSeed', 'float');
  const phase = attribute('fishPhase', 'float');
  const tankIndex = attribute('tankIndex', 'float');
  const fishRestY = attribute('fishRestY', 'float');
  // Per-tank waterline heights (world Y). Updated by AquariumBreachSystem.
  const tankWaterLevels = uniform(new THREE.Vector4(6.86, 6.86, 6.86, 6.86));
  const substrateY = uniform(0.94);

  // Select water level for this fish's tank (indices 0..3).
  const wl = mix(
    mix(tankWaterLevels.x, tankWaterLevels.y, step(0.5, tankIndex)),
    mix(tankWaterLevels.z, tankWaterLevels.w, step(2.5, tankIndex)),
    step(1.5, tankIndex),
  );
  // 0 swimming free → 1 beached on substrate as the tank drains.
  const beach = smoothstep(substrateY.add(0.55), substrateY.add(0.08), wl);
  const swimScale = float(1).sub(beach.mul(0.94));
  const swim = time.mul(float(0.72).add(seed.mul(0.34))).add(phase);

  const shapeY = positionLocal.y.sub(fishRestY);
  // Sink with the waterline; keep a small body clearance under the surface.
  const restClamped = min(fishRestY, max(substrateY.add(0.06), wl.sub(0.12)));
  const material = new MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  material.positionNode = vec3(
    positionLocal.x.add(sin(swim).mul(0.38).mul(swimScale)),
    restClamped.add(shapeY).add(sin(swim.mul(1.7).add(seed.mul(11))).mul(0.2).mul(swimScale)),
    positionLocal.z.add(cos(swim.mul(0.83).add(seed.mul(7))).mul(0.32).mul(swimScale)),
  );
  const palette = sin(seed.mul(31.7)).mul(0.5).add(0.5);
  const aliveColor = mix(color(0xffb443), color(0x49d5cf), palette)
    .mul(float(0.86).add(sin(swim.mul(2.2)).mul(0.14)));
  const beachColor = color(0x6a6e72).mul(float(0.55).add(palette.mul(0.2)));
  material.colorNode = mix(aliveColor, beachColor, beach);
  material.emissiveNode = mix(
    mix(color(0xff7a18), color(0x1adbd2), palette).mul(0.72),
    color(0x000000),
    beach,
  );
  material.roughnessNode = mix(float(0.42), float(0.88), beach);
  material.metalnessNode = float(0.04);
  material.opacityNode = float(1);
  material.userData.mallAquariumFish = true;
  material.userData.tankWaterLevels = tankWaterLevels;
  material.userData.substrateY = substrateY;
  return material;
}

// ── Gate / track layout ────────────────────────────────────────────────────

const GATE_SPECS = [
  { id: 'gate-n', side: 'north' },
  { id: 'gate-ne', side: 'north' },
  { id: 'gate-e', side: 'east' },
  { id: 'gate-se', side: 'east' },
  { id: 'gate-s', side: 'south' },
  { id: 'gate-sw', side: 'south' },
  { id: 'gate-w', side: 'west' },
  { id: 'gate-nw', side: 'west' },
];

/**
 * Parallel tracks along +X. Spacing leaves ~6–7 m aisles for combat between rakes.
 * Each entry is a continuous parked train (east–west, yaw 0).
 */
const TRACK_Z = [-22, -11, 0, 11, 22];
const TRACK_LENGTH = HALF * 2 - 4;

/**
 * Continuous rakes: cars placed end-to-end with COUPLER_GAP.
 * Middle track is a short cut so the player spawn aisle stays open.
 * `startX` is the west end of the first car body.
 */
const TRAIN_RAKES = [
  {
    z: -22,
    startX: -30,
    cars: ['box', 'box', 'box', 'tank', 'box', 'box'],
  },
  {
    z: -11,
    startX: -29,
    cars: ['tank', 'tank', 'tank', 'tank', 'tank'],
  },
  {
    // Short cut only on the west side — open combat lane through the yard center.
    z: 0,
    startX: -30,
    cars: ['box', 'box'],
  },
  {
    z: 11,
    startX: -30,
    cars: ['box', 'box', 'tank', 'box', 'box', 'box'],
  },
  {
    z: 22,
    startX: -28,
    cars: ['box', 'tank', 'box', 'tank', 'box'],
  },
];

/** Body length including nominal coupler overhang for spacing. */
function carBodyLength(type) {
  return type === 'tank' ? TANK_L : BOXCAR_L;
}

function expandTrainPlacements() {
  const boxcars = [];
  const tanks = [];
  for (const rake of TRAIN_RAKES) {
    let x = rake.startX;
    for (const type of rake.cars) {
      const L = carBodyLength(type);
      const cx = x + L * 0.5;
      const entry = { x: cx, z: rake.z, yaw: 0 };
      if (type === 'tank') tanks.push(entry);
      else boxcars.push(entry);
      x += L + COUPLER_GAP;
    }
  }
  return { boxcars, tanks };
}

/**
 * Yard environment. Fog is opt-in via spectacle presets (applyHordeSpectaclePreset)
 * — leaving it on by default added full-screen haze cost to an empty combat pad.
 */
export const HORDE_ENVIRONMENT = {
  timeOfDay: 0.4,
  weather: 'clear',
  fogEnabled: false,
  fogDensity: 0.0065,
  fogColor: 0xb8c0c8,
  ambientBoost: 0.08,
};

/**
 * @param {object} [_qualityPreset]
 */
export function createHordeModeLevel(_qualityPreset = {}) {
  const group = new THREE.Group();
  group.name = 'Horde Arena';
  const colliders = [];
  const ledges = [];
  /** Ladder climb planes + roof hang ledges + long-side wall runs. */
  const climbSurfaces = [];
  const wallRunSurfaces = [];
  const materials = [...MATERIALS];

  // Indoor start hub: square retail ring, four-way center concourse, and a
  // back-of-house shipping connection into the original west yard wall.
  const mallStats = buildMallComplex({ group, colliders });

  // Gravel yard floor.
  addBox({
    group,
    colliders,
    name: 'Horde Floor',
    cx: 0,
    cy: FLOOR_Y - 0.18,
    cz: 0,
    sx: HALF * 2 + 4,
    sy: 0.36,
    sz: HALF * 2 + 4,
    material: gravelMat,
    collider: true,
    surfaceClass: 'dirt',
    tileMeters: GRAVEL_TILE_M,
  });

  // Track beds + rails + ties.
  for (let ti = 0; ti < TRACK_Z.length; ti += 1) {
    buildTrack({
      group,
      colliders,
      z: TRACK_Z[ti],
      length: TRACK_LENGTH,
      index: ti,
    });
  }

  // Continuous parked rakes (box + tank) on each track.
  const { boxcars: boxcarPlacements, tanks: tankPlacements } = expandTrainPlacements();
  const boxcarDoors = [];
  let carIndex = 0;
  for (const place of boxcarPlacements) {
    addBoxcar({
      group,
      colliders,
      climbSurfaces,
      ledges,
      wallRunSurfaces,
      boxcarDoors,
      name: `Cover Boxcar ${carIndex}`,
      ...place,
    });
    carIndex += 1;
  }
  for (const place of tankPlacements) {
    addTankCar({
      group,
      colliders,
      climbSurfaces,
      ledges,
      wallRunSurfaces,
      name: `Cover TankCar ${carIndex}`,
      ...place,
    });
    carIndex += 1;
  }

  // Yard props — drums, pallets, switch stands, sheds (crude light poles
  // replaced by city TSL streetlights below).
  addYardDetails({ group, colliders, ledges, wallRunSurfaces });

  // Propane tank pickups (carry with E). Keep out of static merge.
  const propaneTanks = placePropaneTanks({ group });

  // City-generator street furniture (TSL benches/trashcans/lights/hydrants/trees)
  // for mall concourse + yard edges. Instanced draws stay outside static merge.
  const cityFurniture = addHordeCityFurniture({
    group,
    colliders,
    floorY: FLOOR_Y,
    mallCenterX: MALL_CENTER_X,
    mallHalf: MALL_HALF,
    mallStorefrontHalf: MALL_STOREFRONT_HALF,
    shippingHalfW: SHIPPING_HALF_W,
    legHalfW: LEG_HALF_W,
    leg: {
      aX1: LEG_A_X1,
      bX: LEG_B_X,
      cZ: LEG_C_Z,
      cX1: LEG_C_X1,
      foodCx: FOOD_CX,
      foodCz: FOOD_CZ,
      foodHalf: FOOD_HALF,
    },
    yardHalf: HALF,
    trackZs: TRACK_Z,
    materials,
  });

  // Corrugated perimeter with spawn gates + wall-run / top hang routes.
  buildPerimeter({ group, colliders, ledges, wallRunSurfaces });

  // No extra lights — SceneSystem already owns hemisphere + sun. Duplicate
  // lights doubled shadow/lighting work for no yard readability gain.

  // Collapse thousands of detail meshes (ties, ribs, ladders, wheels…) into one
  // draw per material. Doors keep userData.noStaticMerge so they stay interactive.
  const staticGeometry = mergeStaticHordeGeometry(group);
  // The train yard is heavily merged but still very high-poly. Casting it into
  // every directional shadow cascade dominated the Horde frame (tens of
  // millions of triangles) while adding little to the fast combat read. Keep
  // it as a receiver; dynamic player / prioritized enemy shadows remain.
  disableStaticHordeShadows(group);
  pruneEmptyGroups(group);

  const hordeSpawnPoints = buildSpawnPoints();
  const geometryIndex = createLevelGeometryIndex(group);
  // Re-arm door leaves after geometry-index traversal (static freeze path).
  for (const door of boxcarDoors) {
    door.mesh.matrixAutoUpdate = true;
    door.mesh.matrixWorldAutoUpdate = true;
    door.mesh.static = false;
    door.mesh.userData.noStaticMerge = true;
    door.mesh.userData.skipLevelRaycast = true;
  }
  // Re-arm propane pickups (must stay movable for carry).
  for (const tank of propaneTanks) {
    tank.group.matrixAutoUpdate = true;
    tank.group.matrixWorldAutoUpdate = true;
    tank.group.static = false;
    tank.group.userData.noStaticMerge = true;
    tank.group.traverse((obj) => {
      obj.matrixAutoUpdate = true;
      obj.matrixWorldAutoUpdate = true;
      if (obj.isMesh) {
        obj.static = false;
        obj.userData.noStaticMerge = true;
        obj.userData.skipLevelRaycast = true;
      }
    });
  }
  // Re-arm per-tank water meshes so breach drain can scale.y each frame.
  for (const tank of mallStats.aquarium?.tanks ?? []) {
    const mesh = tank.waterMesh;
    if (mesh) {
      mesh.matrixAutoUpdate = true;
      mesh.matrixWorldAutoUpdate = true;
      mesh.static = false;
      mesh.userData.noStaticMerge = true;
      mesh.userData.skipLevelRaycast = true;
    }
    // Glass panes must stay free to hide when a face shatters.
    for (const face of Object.keys(tank.faceMeshes ?? {})) {
      const pane = tank.faceMeshes[face];
      if (!pane) continue;
      pane.matrixAutoUpdate = true;
      pane.matrixWorldAutoUpdate = true;
      pane.static = false;
      pane.userData.noStaticMerge = true;
    }
  }
  // Fish stay animated via TSL; keep matrix free (not required for uniforms but
  // avoids geometry-index freeze marking them static).
  {
    const fish = mallStats.aquarium?.fishMesh;
    if (fish) {
      fish.matrixAutoUpdate = true;
      fish.matrixWorldAutoUpdate = true;
      fish.static = false;
      fish.userData.noStaticMerge = true;
      fish.userData.skipLevelRaycast = true;
    }
  }
  // Start in the four-way center of the mall, facing the shipping/yard exit.
  const spawnPoint = new THREE.Vector3(MALL_CENTER_X, FLOOR_Y, 0);
  const spawnYaw = -Math.PI / 2;

  // Mall irradiance volume bounds for LightProbeGrid (docs/horde-gi-plan.md).
  // Inset ~1 m from outer walls so probes sit in open air, not inside brick shells.
  // Extends slightly east into the shipping corridor to avoid a hard GI cliff.
  const hordeGi = {
    mall: {
      center: [MALL_CENTER_X + 2, 3.6, 0],
      size: [70, 8, 70],
    },
  };

  return {
    name: 'Horde Arena',
    group,
    colliders,
    ledges,
    climbSurfaces,
    wallRunSurfaces,
    ropes: [],
    boxcarDoors,
    propaneTanks,
    aquarium: mallStats.aquarium ?? null,
    geometryIndex,
    spawnPoint,
    spawnYaw,
    hordeSpawnPoints,
    hordeEnvironment: { ...HORDE_ENVIRONMENT },
    hordeGi,
    isNearFieldReady: () => true,
    createPipelineWarmupGroup: () => createMaterialWarmupGroup(materials, 'Horde Pipeline Warmup'),
    getGroundHeightAt: (position, radius = 0.28, options = {}) => getGroundHeightAt({
      position,
      radius,
      maxStepUp: options.maxStepUp,
      maxSnapDown: options.maxSnapDown,
      requiredInset: options.requiredInset,
      colliders,
      baseHeight: FLOOR_Y,
    }),
    getBlockingColliderAt: ({ position, radius, feetY, height, stepHeight }) => getBlockingColliderAt({
      position,
      radius,
      feetY,
      height,
      stepHeight,
      colliders,
    }),
    getRoadSurfaceAt: () => null,
    findNearestRoadPoint: () => null,
    updateStreaming: () => null,
    /** Slide boxcar doors on E / mount when nearby. Returns { doorsChanged }. */
    update: ({ delta = 0, character = null, input = null } = {}) => {
      const doorResult = updateBoxcarDoors({
        doors: boxcarDoors,
        delta,
        playerPosition: character?.group?.position ?? null,
        mountPressed: Boolean(input?.mountPressed),
      });
      return {
        doorsChanged: Boolean(doorResult?.changed),
      };
    },
    snapshot: () => ({
      mode: 'horde',
      theme: 'mall-train-yard',
      startArea: 'mall-center',
      colliders: colliders.length,
      gates: hordeSpawnPoints.length,
      tracks: TRACK_Z.length,
      boxcars: boxcarPlacements.length,
      tankCars: tankPlacements.length,
      propaneTanks: propaneTanks.length,
      rakes: TRAIN_RAKES.length,
      halfExtent: HALF,
      bounds: {
        // Covers the west leg + food court (stall rear wall sits at x ≈ -271).
        minX: FOOD_CX - FOOD_HALF - 7,
        maxX: HALF + 2,
        minZ: -HALF - 2,
        maxZ: FOOD_CZ + FOOD_HALF + 2.5,
      },
      mallStores: mallStats.stores,
      mallStorefrontPanes: mallStats.panes,
      mallCrossWidth: MALL_CROSS_W,
      mallRingWidth: MALL_RING_W,
      mallAquariumPillars: mallStats.aquariumPillars,
      mallAquariumFish: mallStats.fish,
      mallCanopyPanels: mallStats.canopyPanels,
      mallStoreRoofs: mallStats.storeRoofs,
      mallStoreClosures: mallStats.storeClosures,
      mallServiceDisplays: mallStats.serviceDisplays,
      mallLegStores: mallStats.legStores,
      mallLegPanes: mallStats.legPanes,
      foodCourtStalls: mallStats.foodCourtStalls,
      foodCourtTables: mallStats.foodCourtTables,
      foodCourtKiosks: mallStats.foodCourtKiosks,
      westLeg: {
        halfWidth: LEG_HALF_W,
        mouthX: MALL_CENTER_X - MALL_STOREFRONT_HALF,
        bendX: LEG_A_X1,
        bendWestX: LEG_B_X,
        legCZ: LEG_C_Z,
        courtMouthX: LEG_C_X1,
        courtCenter: [FOOD_CX, FOOD_CZ],
        courtHalf: FOOD_HALF,
      },
      shippingExit: {
        x0: SHIPPING_X0,
        shellX: SHIPPING_MALL_SHELL_X,
        x1: SHIPPING_X1,
        halfWidth: SHIPPING_HALF_W,
        vestibuleDepth: SHIPPING_MALL_SHELL_X - SHIPPING_X0,
      },
      gi: {
        mall: hordeGi.mall,
      },
      cityFurniture: {
        benches: cityFurniture.benches,
        trashcans: cityFurniture.trashcans,
        streetlights: cityFurniture.streetlights,
        hydrants: cityFurniture.hydrants,
        trees: cityFurniture.trees,
        cars: cityFurniture.cars,
        drawCalls: cityFurniture.drawCalls,
      },
      staticDrawCalls: staticGeometry.batches,
      drawCalls: staticGeometry.batches + cityFurniture.drawCalls,
      sourceMeshes: staticGeometry.sourceMeshes,
      climbSurfaces: climbSurfaces.length,
      ledges: ledges.length,
      wallRunSurfaces: wallRunSurfaces.length,
      boxcarDoors: boxcarDoors.length,
      doorsOpen: boxcarDoors.filter((d) => d.open).length,
    }),
    dispose: () => {
      disposeObject3D(group);
    },
  };
}

// ── Mall start hub ────────────────────────────────────────────────────────

function buildMallComplex({ group, colliders }) {
  const mallMinX = MALL_CENTER_X - MALL_HALF;
  const mallMaxX = MALL_CENTER_X + MALL_HALF;
  const storeFace = MALL_STOREFRONT_HALF;

  addBox({
    group,
    colliders,
    name: 'Mall Floor',
    cx: MALL_CENTER_X,
    cy: FLOOR_Y - 0.12,
    cz: 0,
    sx: MALL_HALF * 2,
    sy: 0.24,
    sz: MALL_HALF * 2,
    material: mallFloorMat,
    collider: true,
    surfaceClass: 'concrete',
    tileMeters: 2.4,
  });

  // Four concrete roof wings leave a square opening over the center cross.
  // A framed glass lantern closes that opening, so the aquarium pillars read
  // as a single atrium feature extending all the way into the roof.
  const atriumStats = buildMallAtriumRoof({ group });

  // Exterior shell. The east/rear wall is split around the shipping exit and
  // the west wall around the winding-leg gallery mouth.
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? LEG_HALF_W : -MALL_HALF;
    const z1 = side > 0 ? MALL_HALF : -LEG_HALF_W;
    addBox({
      group, colliders, name: `Mall West Wall ${side > 0 ? 'North' : 'South'} Wing`,
      cx: mallMinX, cy: MALL_WALL_H * 0.5, cz: (z0 + z1) * 0.5,
      sx: MALL_WALL_T, sy: MALL_WALL_H, sz: Math.abs(z1 - z0),
      material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
    });
  }
  for (const side of [-1, 1]) {
    addBox({
      group, colliders, name: `Mall ${side > 0 ? 'North' : 'South'} Wall`,
      cx: MALL_CENTER_X, cy: MALL_WALL_H * 0.5, cz: side * MALL_HALF,
      sx: MALL_HALF * 2, sy: MALL_WALL_H, sz: MALL_WALL_T,
      material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
    });
    const z0 = side > 0 ? SHIPPING_HALF_W : -MALL_HALF;
    const z1 = side > 0 ? MALL_HALF : -SHIPPING_HALF_W;
    addBox({
      group, colliders, name: `Mall East Wall ${side > 0 ? 'North' : 'South'} Wing`,
      cx: mallMaxX, cy: MALL_WALL_H * 0.5, cz: (z0 + z1) * 0.5,
      sx: MALL_WALL_T, sy: MALL_WALL_H, sz: Math.abs(z1 - z0),
      material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
    });
  }

  // Store masses are collider-only: the city TSL glass supplies convincing
  // depth without constructing dozens of real interiors. The open band in
  // front of them is the complete perimeter shopping avenue.
  pushMallCollider(colliders, {
    name: 'Mall Stores North',
    cx: MALL_CENTER_X, cz: storeFace + MALL_STORE_DEPTH * 0.5,
    sx: storeFace * 2, sz: MALL_STORE_DEPTH,
  });
  pushMallCollider(colliders, {
    name: 'Mall Stores South',
    cx: MALL_CENTER_X, cz: -storeFace - MALL_STORE_DEPTH * 0.5,
    sx: storeFace * 2, sz: MALL_STORE_DEPTH,
  });
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? LEG_HALF_W : -storeFace;
    const z1 = side > 0 ? storeFace : -LEG_HALF_W;
    pushMallCollider(colliders, {
      name: `Mall Stores West ${side > 0 ? 'North' : 'South'}`,
      cx: MALL_CENTER_X - storeFace - MALL_STORE_DEPTH * 0.5,
      cz: (z0 + z1) * 0.5,
      sx: MALL_STORE_DEPTH,
      sz: Math.abs(z1 - z0),
    });
  }
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? SHIPPING_HALF_W : -storeFace;
    const z1 = side > 0 ? storeFace : -SHIPPING_HALF_W;
    pushMallCollider(colliders, {
      name: `Mall Stores East ${side > 0 ? 'North' : 'South'}`,
      cx: MALL_CENTER_X + storeFace + MALL_STORE_DEPTH * 0.5,
      cz: (z0 + z1) * 0.5,
      sx: MALL_STORE_DEPTH,
      sz: Math.abs(z1 - z0),
    });
  }

  // The shop volumes above are intentionally broad colliders. Give those
  // invisible masses a visible lid and finished returns so views across the
  // atrium never reveal the empty exterior shell behind the TSL shopfronts.
  const storeShellStats = addMallStoreShells({ group });

  const storefront = buildMallStorefrontMesh();
  storefront.name = 'Mall TSL Storefront Avenue';
  storefront.userData.noStaticMerge = true;
  storefront.userData.mallStorefront = true;
  storefront.castShadow = false;
  storefront.receiveShadow = true;
  group.add(storefront);

  addMallAccentWalls({ group });
  const centerpieceStats = buildMallAquariumCenterpiece({ group, colliders });

  // Sparse structural columns mark the retail ring without closing it off.
  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      addBox({
        group,
        colliders,
        name: `Mall Avenue Column ${xSide}_${zSide}`,
        cx: MALL_CENTER_X + xSide * (storeFace - MALL_RING_W * 0.55),
        cy: MALL_WALL_H * 0.5,
        cz: zSide * (storeFace - MALL_RING_W * 0.55),
        sx: 0.72,
        sy: MALL_WALL_H,
        sz: 0.72,
        material: mallTrimMat,
        collider: true,
        noGroundSnap: true,
        surfaceClass: 'metal',
      });
    }
  }

  addMallCeilingLights({ group });
  buildMallShippingExit({ group, colliders });
  const legStats = buildMallWestLeg({ group, colliders });

  return {
    stores: storefront.userData.storeCount,
    panes: storefront.userData.paneCount,
    aquariumPillars: centerpieceStats.pillars,
    fish: centerpieceStats.fish,
    aquarium: centerpieceStats.aquarium,
    canopyPanels: atriumStats.canopyPanels,
    storeRoofs: storeShellStats.roofs,
    storeClosures: storeShellStats.closures,
    serviceDisplays: storeShellStats.serviceDisplays,
    legStores: legStats.stores,
    legPanes: legStats.panes,
    foodCourtStalls: legStats.foodStalls,
    foodCourtTables: legStats.tables,
    foodCourtKiosks: legStats.kiosks,
  };
}

function buildMallAtriumRoof({ group }) {
  const wingDepth = MALL_HALF - MALL_ATRIUM_HALF;
  const wingCenter = MALL_ATRIUM_HALF + wingDepth * 0.5;
  for (const side of [-1, 1]) {
    addBox({
      group, colliders: null, name: `Mall Roof ${side > 0 ? 'North' : 'South'} Wing`,
      cx: MALL_CENTER_X, cy: MALL_WALL_H + 0.12, cz: side * wingCenter,
      sx: MALL_HALF * 2 + MALL_WALL_T, sy: 0.24, sz: wingDepth,
      material: mallCeilingMat, collider: false, tileMeters: 3.2,
    });
    addBox({
      group, colliders: null, name: `Mall Roof ${side > 0 ? 'East' : 'West'} Wing`,
      cx: MALL_CENTER_X + side * wingCenter, cy: MALL_WALL_H + 0.12, cz: 0,
      sx: wingDepth, sy: 0.24, sz: MALL_ATRIUM_HALF * 2,
      material: mallCeilingMat, collider: false, tileMeters: 3.2,
    });
  }

  const skylight = new THREE.Mesh(
    new THREE.BoxGeometry(MALL_ATRIUM_HALF * 2, 0.1, MALL_ATRIUM_HALF * 2),
    mallAquariumGlassMat,
  );
  skylight.name = 'Mall Atrium Glass Roof';
  skylight.position.set(MALL_CENTER_X, MALL_WALL_H + 0.12, 0);
  skylight.userData.noStaticMerge = true;
  skylight.renderOrder = 3;
  group.add(skylight);

  // Perimeter and cross muntins make the broad pane read as an architectural
  // lantern rather than an unframed transparent hole.
  const beamY = MALL_WALL_H + 0.2;
  for (const side of [-1, 1]) {
    addBox({
      group, colliders: null, name: `Mall Atrium Roof X Frame ${side}`,
      cx: MALL_CENTER_X, cy: beamY, cz: side * MALL_ATRIUM_HALF,
      sx: MALL_ATRIUM_HALF * 2 + 0.4, sy: 0.18, sz: 0.24,
      material: mallTrimMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Mall Atrium Roof Z Frame ${side}`,
      cx: MALL_CENTER_X + side * MALL_ATRIUM_HALF, cy: beamY, cz: 0,
      sx: 0.24, sy: 0.18, sz: MALL_ATRIUM_HALF * 2 + 0.4,
      material: mallTrimMat, collider: false,
    });
  }
  for (const offset of [-MALL_ATRIUM_HALF / 3, 0, MALL_ATRIUM_HALF / 3]) {
    addBox({
      group, colliders: null, name: `Mall Atrium Roof Inner X ${offset}`,
      cx: MALL_CENTER_X, cy: beamY, cz: offset,
      sx: MALL_ATRIUM_HALF * 2, sy: 0.12, sz: 0.13,
      material: mallTrimMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Mall Atrium Roof Inner Z ${offset}`,
      cx: MALL_CENTER_X + offset, cy: beamY, cz: 0,
      sx: 0.13, sy: 0.12, sz: MALL_ATRIUM_HALF * 2,
      material: mallTrimMat, collider: false,
    });
  }

  // A lower, pitched lantern connects the four aquarium columns. The broad
  // ring lands directly over their centers, while four glass roof planes rise
  // to a luminous oculus beneath the larger weatherproof skylight.
  const canopyY = MALL_WALL_H - 0.68;
  const canopyHalf = AQUARIUM_OFFSET;
  for (const side of [-1, 1]) {
    addBox({
      group, colliders: null, name: `Mall Atrium Canopy X Ring ${side}`,
      cx: MALL_CENTER_X, cy: canopyY, cz: side * canopyHalf,
      sx: canopyHalf * 2 + 0.42, sy: 0.3, sz: 0.3,
      material: gateFrameMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Mall Atrium Canopy Z Ring ${side}`,
      cx: MALL_CENTER_X + side * canopyHalf, cy: canopyY, cz: 0,
      sx: 0.3, sy: 0.3, sz: canopyHalf * 2 + 0.42,
      material: gateFrameMat, collider: false,
    });
  }

  const oculusY = MALL_WALL_H + 0.02;
  const oculusRadius = 2.55;
  const canopy = new THREE.Mesh(
    buildMallCanopyGeometry({ outerHalf: canopyHalf, outerY: canopyY, innerHalf: oculusRadius, innerY: oculusY }),
    mallAquariumGlassMat,
  );
  canopy.name = 'Mall Atrium Pitched Glass Canopy';
  canopy.userData.noStaticMerge = true;
  canopy.userData.panelCount = 4;
  canopy.renderOrder = 3;
  group.add(canopy);

  const oculus = new THREE.Mesh(
    new THREE.TorusGeometry(oculusRadius, 0.18, 8, 48),
    mallLightMat,
  );
  oculus.name = 'Mall Atrium Luminous Oculus';
  oculus.position.set(MALL_CENTER_X, oculusY + 0.03, 0);
  oculus.rotation.x = Math.PI * 0.5;
  oculus.userData.noStaticMerge = true;
  group.add(oculus);

  const innerHalf = oculusRadius * 0.72;
  for (const side of [-1, 1]) {
    addBox({
      group, colliders: null, name: `Mall Atrium Crown Inner X ${side}`,
      cx: MALL_CENTER_X, cy: oculusY, cz: side * innerHalf,
      sx: innerHalf * 2 + 0.18, sy: 0.16, sz: 0.16,
      material: gateFrameMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Mall Atrium Crown Inner Z ${side}`,
      cx: MALL_CENTER_X + side * innerHalf, cy: oculusY, cz: 0,
      sx: 0.16, sy: 0.16, sz: innerHalf * 2 + 0.18,
      material: gateFrameMat, collider: false,
    });
    addMallBeamBetween({
      group,
      name: `Mall Atrium Crown X Spine ${side}`,
      start: new THREE.Vector3(MALL_CENTER_X + side * canopyHalf, canopyY + 0.08, 0),
      end: new THREE.Vector3(MALL_CENTER_X + side * innerHalf, oculusY, 0),
      thickness: 0.14,
      material: gateFrameMat,
    });
    addMallBeamBetween({
      group,
      name: `Mall Atrium Crown Z Spine ${side}`,
      start: new THREE.Vector3(MALL_CENTER_X, canopyY + 0.08, side * canopyHalf),
      end: new THREE.Vector3(MALL_CENTER_X, oculusY, side * innerHalf),
      thickness: 0.14,
      material: gateFrameMat,
    });
  }
  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      addMallBeamBetween({
        group,
        name: `Mall Atrium Crown Rib ${xSide}_${zSide}`,
        start: new THREE.Vector3(MALL_CENTER_X + xSide * canopyHalf, canopyY + 0.08, zSide * canopyHalf),
        end: new THREE.Vector3(MALL_CENTER_X + xSide * innerHalf, oculusY, zSide * innerHalf),
        thickness: 0.16,
        material: gateFrameMat,
      });
    }
  }

  return { canopyPanels: 4 };
}

function buildMallCanopyGeometry({ outerHalf, outerY, innerHalf, innerY }) {
  const positions = [];
  const addQuad = (a, b, c, d) => {
    for (const point of [a, b, c, a, c, d]) positions.push(point.x, point.y, point.z);
  };
  const point = (x, y, z) => new THREE.Vector3(MALL_CENTER_X + x, y, z);
  addQuad(
    point(-outerHalf, outerY, outerHalf), point(outerHalf, outerY, outerHalf),
    point(innerHalf, innerY, innerHalf), point(-innerHalf, innerY, innerHalf),
  );
  addQuad(
    point(outerHalf, outerY, -outerHalf), point(-outerHalf, outerY, -outerHalf),
    point(-innerHalf, innerY, -innerHalf), point(innerHalf, innerY, -innerHalf),
  );
  addQuad(
    point(outerHalf, outerY, outerHalf), point(outerHalf, outerY, -outerHalf),
    point(innerHalf, innerY, -innerHalf), point(innerHalf, innerY, innerHalf),
  );
  addQuad(
    point(-outerHalf, outerY, -outerHalf), point(-outerHalf, outerY, outerHalf),
    point(-innerHalf, innerY, innerHalf), point(-innerHalf, innerY, -innerHalf),
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function addMallBeamBetween({ group, name, start, end, thickness, material }) {
  const direction = end.clone().sub(start);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(thickness, direction.length(), thickness),
    material,
  );
  mesh.name = name;
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  group.add(mesh);
  return mesh;
}

/**
 * Seal store volumes so atrium views never punch through to exterior sky.
 *
 * Geometry is locked to the exterior shell planes so store rears / roofs /
 * corner fills stay flush with the outside walls (no inset step or void
 * between shop mass and mall perimeter).
 *
 * Exterior wall boxes are centered on ±MALL_HALF with thickness MALL_WALL_T;
 * storefront glass sits at ±MALL_STOREFRONT_HALF.
 */
function addMallStoreShells({ group }) {
  const storeFace = MALL_STOREFRONT_HALF;
  // Outer / inner faces of the perimeter walls (authoritative flush planes).
  const outerN = MALL_HALF + MALL_WALL_T * 0.5;
  const outerS = -MALL_HALF - MALL_WALL_T * 0.5;
  const outerW = MALL_CENTER_X - MALL_HALF - MALL_WALL_T * 0.5;
  const outerE = MALL_CENTER_X + MALL_HALF + MALL_WALL_T * 0.5;
  const wallT = MALL_WALL_T;
  const roofY = MALL_SHOP_H + 0.14;
  const roofT = 0.28;
  // Slightly taller than shop glass so fascia/accent seam can't leak sky.
  const shellH = MALL_SHOP_H + 0.35;
  // Side returns / near bulkheads.
  const returnT = 0.55;
  let roofs = 0;
  let closures = 0;
  let serviceDisplays = 0;

  /** Axis-aligned box from min/max faces (keeps flush math readable). */
  const addSlab = ({
    name,
    x0,
    x1,
    z0,
    z1,
    y0 = FLOOR_Y,
    y1 = shellH,
    material = mallWallMat,
  }) => {
    const sx = Math.abs(x1 - x0);
    const sy = Math.abs(y1 - y0);
    const sz = Math.abs(z1 - z0);
    if (sx < 1e-4 || sy < 1e-4 || sz < 1e-4) return;
    addBox({
      group,
      colliders: null,
      name,
      cx: (x0 + x1) * 0.5,
      cy: (y0 + y1) * 0.5,
      cz: (z0 + z1) * 0.5,
      sx,
      sy,
      sz,
      material,
      collider: false,
      tileMeters: material === mallCeilingMat ? 2.4 : 2.2,
    });
    if (material === mallCeilingMat) roofs += 1;
    else closures += 1;
  };

  // ── Roofs: glass plane → exterior outer face, including corners ─────────
  addSlab({
    name: 'Mall Store Roof North',
    x0: outerW, x1: outerE,
    z0: storeFace, z1: outerN,
    y0: roofY - roofT * 0.5, y1: roofY + roofT * 0.5,
    material: mallCeilingMat,
  });
  addSlab({
    name: 'Mall Store Roof South',
    x0: outerW, x1: outerE,
    z0: outerS, z1: -storeFace,
    y0: roofY - roofT * 0.5, y1: roofY + roofT * 0.5,
    material: mallCeilingMat,
  });
  // West wings (skip the winding-leg gallery mouth).
  for (const side of [-1, 1]) {
    addSlab({
      name: `Mall Store Roof West ${side > 0 ? 'North' : 'South'}`,
      x0: outerW, x1: MALL_CENTER_X - storeFace,
      z0: side > 0 ? LEG_HALF_W : -storeFace,
      z1: side > 0 ? storeFace : -LEG_HALF_W,
      y0: roofY - roofT * 0.5, y1: roofY + roofT * 0.5,
      material: mallCeilingMat,
    });
  }
  // East wings (skip shipping portal gap) — flush to exterior outer face.
  for (const side of [-1, 1]) {
    addSlab({
      name: `Mall Store Roof East ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X + storeFace, x1: outerE,
      z0: side > 0 ? SHIPPING_HALF_W : outerS,
      z1: side > 0 ? outerN : -SHIPPING_HALF_W,
      y0: roofY - roofT * 0.5, y1: roofY + roofT * 0.5,
      material: mallCeilingMat,
    });
  }

  // ── Rear bulkheads: coplanar with exterior walls (flush outside) ────────
  // Same centerline + thickness as the mall perimeter so the outside reads
  // continuous (store shell is not inset from the shell wall).
  addSlab({
    name: 'Mall Store Rear North',
    x0: outerW, x1: outerE,
    z0: MALL_HALF - wallT * 0.5, z1: MALL_HALF + wallT * 0.5,
  });
  addSlab({
    name: 'Mall Store Rear South',
    x0: outerW, x1: outerE,
    z0: -MALL_HALF - wallT * 0.5, z1: -MALL_HALF + wallT * 0.5,
  });
  for (const side of [-1, 1]) {
    addSlab({
      name: `Mall Store Rear West ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X - MALL_HALF - wallT * 0.5,
      x1: MALL_CENTER_X - MALL_HALF + wallT * 0.5,
      z0: side > 0 ? LEG_HALF_W : outerS,
      z1: side > 0 ? outerN : -LEG_HALF_W,
    });
  }
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? SHIPPING_HALF_W : outerS;
    const z1 = side > 0 ? outerN : -SHIPPING_HALF_W;
    addSlab({
      name: `Mall Store Rear East ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X + MALL_HALF - wallT * 0.5,
      x1: MALL_CENTER_X + MALL_HALF + wallT * 0.5,
      z0, z1,
    });
  }

  // ── Solid store mass: glass → outer face (fills the void flush to outside)
  // Keeps near-glass depth for TSL by using a recessed front face slightly
  // behind the glass plane, but the rear is hard-flush with outerN/S/W/E.
  const glassInset = 0.08;
  const nearBulk = 2.35;

  // North mass (two slabs: near bulk + deep fill to outer)
  addSlab({
    name: 'Mall Store Mass North Near',
    x0: MALL_CENTER_X - storeFace + 0.1,
    x1: MALL_CENTER_X + storeFace - 0.1,
    z0: storeFace + nearBulk,
    z1: storeFace + nearBulk + returnT,
  });
  addSlab({
    name: 'Mall Store Mass North Deep',
    x0: outerW,
    x1: outerE,
    z0: storeFace + nearBulk + returnT * 0.5,
    z1: outerN,
  });
  // South
  addSlab({
    name: 'Mall Store Mass South Near',
    x0: MALL_CENTER_X - storeFace + 0.1,
    x1: MALL_CENTER_X + storeFace - 0.1,
    z0: -storeFace - nearBulk - returnT,
    z1: -storeFace - nearBulk,
  });
  addSlab({
    name: 'Mall Store Mass South Deep',
    x0: outerW,
    x1: outerE,
    z0: outerS,
    z1: -storeFace - nearBulk - returnT * 0.5,
  });
  // West wings (skip the winding-leg gallery mouth)
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? LEG_HALF_W + 0.15 : -storeFace + 0.1;
    const z1 = side > 0 ? storeFace - 0.1 : -LEG_HALF_W - 0.15;
    addSlab({
      name: `Mall Store Mass West Near ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X - storeFace - nearBulk - returnT,
      x1: MALL_CENTER_X - storeFace - nearBulk,
      z0,
      z1,
    });
    addSlab({
      name: `Mall Store Mass West Deep ${side > 0 ? 'North' : 'South'}`,
      x0: outerW,
      x1: MALL_CENTER_X - storeFace - nearBulk - returnT * 0.5,
      z0: side > 0 ? LEG_HALF_W + 0.15 : outerS,
      z1: side > 0 ? outerN : -LEG_HALF_W - 0.15,
    });
  }
  // East wings
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? SHIPPING_HALF_W + 0.15 : outerS;
    const z1 = side > 0 ? outerN : -SHIPPING_HALF_W - 0.15;
    addSlab({
      name: `Mall Store Mass East Near ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X + storeFace + nearBulk,
      x1: MALL_CENTER_X + storeFace + nearBulk + returnT,
      z0: side > 0 ? Math.max(z0, storeFace + 0.1) : z0,
      z1: side > 0 ? z1 : Math.min(z1, -storeFace - 0.1),
    });
    addSlab({
      name: `Mall Store Mass East Deep ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X + storeFace + nearBulk + returnT * 0.5,
      x1: outerE,
      z0, z1,
    });
  }

  // ── Side returns at avenue corners (glass-plane ends) ───────────────────
  for (const xSide of [-1, 1]) {
    addSlab({
      name: `Mall Store North End ${xSide}`,
      x0: MALL_CENTER_X + xSide * storeFace - returnT * 0.5,
      x1: MALL_CENTER_X + xSide * storeFace + returnT * 0.5,
      z0: storeFace + glassInset,
      z1: outerN,
    });
    addSlab({
      name: `Mall Store South End ${xSide}`,
      x0: MALL_CENTER_X + xSide * storeFace - returnT * 0.5,
      x1: MALL_CENTER_X + xSide * storeFace + returnT * 0.5,
      z0: outerS,
      z1: -storeFace - glassInset,
    });
  }
  for (const zSide of [-1, 1]) {
    addSlab({
      name: `Mall Store West End ${zSide}`,
      x0: outerW,
      x1: MALL_CENTER_X - storeFace - glassInset,
      z0: zSide * storeFace - returnT * 0.5,
      z1: zSide * storeFace + returnT * 0.5,
    });
    addSlab({
      name: `Mall Shipping Store Return ${zSide}`,
      x0: MALL_CENTER_X + storeFace + glassInset,
      x1: outerE,
      z0: zSide * SHIPPING_HALF_W - returnT * 0.5,
      z1: zSide * SHIPPING_HALF_W + returnT * 0.5,
    });
    // Same treatment where the winding leg leaves the west storefront line.
    addSlab({
      name: `Mall Leg Store Return ${zSide}`,
      x0: outerW,
      x1: MALL_CENTER_X - storeFace - glassInset,
      z0: zSide * LEG_HALF_W - returnT * 0.5,
      z1: zSide * LEG_HALF_W + returnT * 0.5,
    });
  }

  // Treat the long shipping returns as feature walls rather than exposed
  // store mass. Both faces receive shallow, illuminated directory/display
  // bays, so they look finished from the retail avenue and service corridor.
  const returnX0 = MALL_CENTER_X + storeFace + glassInset;
  const returnX1 = outerE;
  const returnSpan = returnX1 - returnX0;
  const displayBay = returnSpan * 0.5;
  for (const zSide of [-1, 1]) {
    for (const faceSide of [-1, 1]) {
      const faceZ = zSide * SHIPPING_HALF_W + faceSide * (returnT * 0.5 + 0.065);
      addBox({
        group, colliders: null, name: `Mall Service Wall Plinth ${zSide}_${faceSide}`,
        cx: (returnX0 + returnX1) * 0.5, cy: 0.3, cz: faceZ,
        sx: returnSpan, sy: 0.6, sz: 0.12,
        material: mallPlanterMat, collider: false,
      });
      addBox({
        group, colliders: null, name: `Mall Service Wall Header ${zSide}_${faceSide}`,
        cx: (returnX0 + returnX1) * 0.5, cy: 4.28, cz: faceZ,
        sx: returnSpan, sy: 0.16, sz: 0.14,
        material: gateFrameMat, collider: false,
      });
      for (let bay = 0; bay < 2; bay += 1) {
        const cx = returnX0 + displayBay * (bay + 0.5);
        const label = `${zSide}_${faceSide}_${bay}`;
        addBox({
          group, colliders: null, name: `Mall Service Display Frame ${label}`,
          cx, cy: 2.38, cz: faceZ + faceSide * 0.015,
          sx: displayBay - 0.42, sy: 3.2, sz: 0.15,
          material: mallTrimMat, collider: false,
        });
        addBox({
          group, colliders: null, name: `Mall Service Display Panel ${label}`,
          cx, cy: 2.38, cz: faceZ + faceSide * 0.1,
          sx: displayBay - 0.72, sy: 2.86, sz: 0.08,
          material: (bay + (zSide > 0 ? 1 : 0)) % 2 === 0 ? mallAccentMat : accentMat,
          collider: false,
        });
        addBox({
          group, colliders: null, name: `Mall Service Display Light ${label}`,
          cx, cy: 3.61, cz: faceZ + faceSide * 0.16,
          sx: displayBay - 1.05, sy: 0.08, sz: 0.06,
          material: mallLightMat, collider: false,
        });
        serviceDisplays += 1;
      }
    }
  }

  // ── Corner pods flush to both exterior outer faces ──────────────────────
  // NW/NE/SW/SE L-gaps between perpendicular store runs, hard-flush outside.
  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      const x0 = xSide < 0 ? outerW : MALL_CENTER_X + storeFace;
      const x1 = xSide < 0 ? MALL_CENTER_X - storeFace : outerE;
      const z0 = zSide < 0 ? outerS : storeFace;
      const z1 = zSide < 0 ? -storeFace : outerN;

      addSlab({
        name: `Mall Store Corner Fill ${xSide}_${zSide}`,
        x0, x1, z0, z1,
      });
      addSlab({
        name: `Mall Store Corner Riser ${xSide}_${zSide}`,
        x0, x1, z0, z1,
        y0: shellH,
        y1: MALL_WALL_H,
      });
    }
  }

  // ── Ceiling apron above glass (flush span glass → outer) ────────────────
  const apronH = Math.max(0.4, MALL_WALL_H - MALL_SHOP_H - 0.1);
  const apronY0 = MALL_SHOP_H;
  const apronY1 = MALL_SHOP_H + apronH;
  const apronT = 0.45;
  addSlab({
    name: 'Mall Store Apron North',
    x0: outerW, x1: outerE,
    z0: storeFace, z1: storeFace + apronT,
    y0: apronY0, y1: apronY1,
  });
  addSlab({
    name: 'Mall Store Apron South',
    x0: outerW, x1: outerE,
    z0: -storeFace - apronT, z1: -storeFace,
    y0: apronY0, y1: apronY1,
  });
  for (const side of [-1, 1]) {
    addSlab({
      name: `Mall Store Apron West ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X - storeFace - apronT, x1: MALL_CENTER_X - storeFace,
      z0: side > 0 ? LEG_HALF_W : outerS,
      z1: side > 0 ? outerN : -LEG_HALF_W,
      y0: apronY0, y1: apronY1,
    });
  }
  for (const side of [-1, 1]) {
    const z0 = side > 0 ? SHIPPING_HALF_W : outerS;
    const z1 = side > 0 ? outerN : -SHIPPING_HALF_W;
    addSlab({
      name: `Mall Store Apron East ${side > 0 ? 'North' : 'South'}`,
      x0: MALL_CENTER_X + storeFace, x1: MALL_CENTER_X + storeFace + apronT,
      z0, z1,
      y0: apronY0, y1: apronY1,
    });
  }

  return { roofs, closures, serviceDisplays };
}

function addMallAccentWalls({ group }) {
  const bandBottom = MALL_SHOP_H + 0.08;
  const bandTop = MALL_WALL_H - 0.28;
  const bandH = bandTop - bandBottom;
  const bayCount = 6;
  const bayW = (MALL_STOREFRONT_HALF * 2) / bayCount;
  let panelIndex = 0;
  const addPanel = ({ cx, cz, sx, sz, skip = false }) => {
    if (skip) return;
    addBox({
      group,
      colliders: null,
      name: `Mall Accent Wall ${panelIndex}`,
      cx,
      cy: bandBottom + bandH * 0.5,
      cz,
      sx,
      sy: bandH,
      sz,
      material: panelIndex % 3 === 1 ? accentMat : mallAccentMat,
      collider: false,
    });
    panelIndex += 1;
  };
  for (let i = 0; i < bayCount; i += 1) {
    const along = -MALL_STOREFRONT_HALF + bayW * (i + 0.5);
    addPanel({ cx: MALL_CENTER_X + along, cz: MALL_STOREFRONT_HALF + 0.16, sx: bayW - 0.12, sz: 0.3 });
    addPanel({ cx: MALL_CENTER_X + along, cz: -MALL_STOREFRONT_HALF - 0.16, sx: bayW - 0.12, sz: 0.3 });
    addPanel({ cx: MALL_CENTER_X - MALL_STOREFRONT_HALF - 0.16, cz: along, sx: 0.3, sz: bayW - 0.12 });
    addPanel({
      cx: MALL_CENTER_X + MALL_STOREFRONT_HALF + 0.16,
      cz: along,
      sx: 0.3,
      sz: bayW - 0.12,
      skip: Math.abs(along) < SHIPPING_HALF_W + 0.8,
    });
  }

  // Warm metal datum around the whole avenue ties the alternating teal and
  // terracotta panels back to the storefront frames.
  for (const side of [-1, 1]) {
    addBox({
      group, colliders: null, name: `Mall Accent Rail X ${side}`,
      cx: MALL_CENTER_X, cy: bandBottom + 0.1, cz: side * (MALL_STOREFRONT_HALF - 0.03),
      sx: MALL_STOREFRONT_HALF * 2, sy: 0.16, sz: 0.16,
      material: gateFrameMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Mall Accent Rail Z ${side}`,
      cx: MALL_CENTER_X + side * (MALL_STOREFRONT_HALF - 0.03), cy: bandBottom + 0.1, cz: 0,
      sx: 0.16, sy: 0.16, sz: MALL_STOREFRONT_HALF * 2,
      material: gateFrameMat, collider: false,
    });
  }
}

function buildMallAquariumCenterpiece({ group, colliders }) {
  const fishSpecs = [];
  const pillarH = MALL_WALL_H - 0.58;
  const waterH = pillarH - 0.48;
  const waterBottomY = 0.72;
  const waterTopY = waterBottomY + waterH;
  const glassBottomY = 0.58;
  const glassTopY = 0.58 + pillarH;
  const glassCenterY = glassBottomY + pillarH * 0.5;
  const glassThickness = 0.06;
  const innerSize = AQUARIUM_SIZE - 0.32;
  const innerArea = innerSize * innerSize;
  const halfSize = AQUARIUM_SIZE * 0.5;
  /** @type {Array<object>} */
  const tanks = [];
  let pillarIndex = 0;

  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      const cx = MALL_CENTER_X + xSide * AQUARIUM_OFFSET;
      const cz = zSide * AQUARIUM_OFFSET;
      const label = `${xSide > 0 ? 'E' : 'W'}${zSide > 0 ? 'N' : 'S'}`;
      const tankId = `aquarium-${label}`;
      addBox({
        group,
        colliders,
        name: `Mall Aquarium Pillar ${label}`,
        cx,
        cy: 0.3,
        cz,
        sx: AQUARIUM_SIZE + 0.35,
        sy: 0.6,
        sz: AQUARIUM_SIZE + 0.35,
        material: mallPlanterMat,
        collider: true,
        surfaceClass: 'concrete',
      });
      // Glass volume: surfaceClass glass for bullet-hole atlas + impact FX.
      // topY snaps to the glass top (not MALL_SHOP_H) so hole heights match.
      pushMallCollider(colliders, {
        name: `Mall Aquarium Pillar Volume ${label}`,
        cx,
        cz,
        sx: AQUARIUM_SIZE,
        sz: AQUARIUM_SIZE,
        topY: glassTopY,
        surfaceClass: 'glass',
      });

      // Four independent glass panes so one side can shatter without the rest.
      /** @type {Record<string, THREE.Mesh>} */
      const faceMeshes = {};
      const paneSpecs = [
        { face: '+x', sx: glassThickness, sy: pillarH, sz: AQUARIUM_SIZE, px: cx + halfSize - glassThickness * 0.5, py: glassCenterY, pz: cz },
        { face: '-x', sx: glassThickness, sy: pillarH, sz: AQUARIUM_SIZE, px: cx - halfSize + glassThickness * 0.5, py: glassCenterY, pz: cz },
        { face: '+z', sx: AQUARIUM_SIZE, sy: pillarH, sz: glassThickness, px: cx, py: glassCenterY, pz: cz + halfSize - glassThickness * 0.5 },
        { face: '-z', sx: AQUARIUM_SIZE, sy: pillarH, sz: glassThickness, px: cx, py: glassCenterY, pz: cz - halfSize + glassThickness * 0.5 },
      ];
      for (const pane of paneSpecs) {
        const geom = new THREE.BoxGeometry(pane.sx, pane.sy, pane.sz);
        const mesh = new THREE.Mesh(geom, mallAquariumGlassMat);
        mesh.name = `Mall Aquarium Glass ${label} ${pane.face}`;
        mesh.position.set(pane.px, pane.py, pane.pz);
        mesh.userData.noStaticMerge = true;
        mesh.userData.mallAquariumGlass = true;
        mesh.userData.tankId = tankId;
        mesh.userData.face = pane.face;
        mesh.renderOrder = 3;
        mesh.matrixAutoUpdate = true;
        group.add(mesh);
        faceMeshes[pane.face] = mesh;
      }

      // Per-tank water: y-origin at water *bottom* so drain is scale.y only.
      // Geometry is a unit-height box scaled to waterH, bottom at local y=0.
      const waterGeom = new THREE.BoxGeometry(innerSize, 1, innerSize);
      waterGeom.translate(0, 0.5, 0);
      const waterMesh = new THREE.Mesh(waterGeom, mallAquariumWaterMat);
      waterMesh.name = `Mall Aquarium TSL Water ${label}`;
      waterMesh.position.set(cx, waterBottomY, cz);
      waterMesh.scale.set(1, waterH, 1);
      waterMesh.userData.noStaticMerge = true;
      waterMesh.userData.mallAquariumWater = true;
      waterMesh.userData.tankId = tankId;
      waterMesh.renderOrder = 2;
      waterMesh.matrixAutoUpdate = true;
      group.add(waterMesh);

      tanks.push({
        id: tankId,
        label,
        cx,
        cz,
        halfSize,
        waterBottomY,
        waterTopY,
        waterH,
        glassBottomY,
        glassTopY,
        innerArea,
        waterMesh,
        faceMeshes,
      });

      // Dark substrate, a pale display shelf, and vertical corner frames give
      // the shader volumes physical scale and a deliberately finished base.
      addBox({
        group, colliders: null, name: `Mall Aquarium Substrate ${label}`,
        cx, cy: 0.78, cz,
        sx: AQUARIUM_SIZE - 0.28, sy: 0.32, sz: AQUARIUM_SIZE - 0.28,
        material: mallPlanterMat, collider: false,
      });
      for (const fx of [-1, 1]) {
        for (const fz of [-1, 1]) {
          addBox({
            group, colliders: null, name: `Mall Aquarium Frame ${label}_${fx}_${fz}`,
            cx: cx + fx * (AQUARIUM_SIZE * 0.5 - 0.08),
            cy: 0.58 + pillarH * 0.5,
            cz: cz + fz * (AQUARIUM_SIZE * 0.5 - 0.08),
            sx: 0.13, sy: pillarH, sz: 0.13,
            material: mallTrimMat, collider: false,
          });
        }
      }
      for (let fish = 0; fish < 12; fish += 1) {
        const seed = (pillarIndex * 12 + fish + 1) / 49;
        fishSpecs.push({
          cx: cx + Math.sin(seed * 41.3) * 0.42,
          cy: 1.25 + ((fish * 0.417 + pillarIndex * 0.19) % 1) * (waterH - 1.4),
          cz: cz + Math.cos(seed * 35.7) * 0.4,
          yaw: seed * Math.PI * 5.7,
          scale: 0.94 + (fish % 4) * 0.11,
          seed,
          phase: seed * Math.PI * 13,
          tankIndex: pillarIndex,
        });
      }
      pillarIndex += 1;
    }
  }

  const fish = new THREE.Mesh(buildMallFishGeometry(fishSpecs), mallAquariumFishMat);
  fish.name = 'Mall Aquarium TSL Fish';
  fish.userData.noStaticMerge = true;
  fish.userData.fishCount = fishSpecs.length;
  fish.userData.skipLevelRaycast = true;
  fish.renderOrder = 1;
  fish.matrixAutoUpdate = true;
  group.add(fish);

  return {
    pillars: pillarIndex,
    fish: fishSpecs.length,
    aquarium: {
      floorY: FLOOR_Y,
      tanks,
      waterMeshes: tanks.map((t) => t.waterMesh),
      fishMesh: fish,
      tankWaterLevels: mallAquariumFishMat.userData.tankWaterLevels ?? null,
    },
  };
}

function translatedBoxGeometry(sx, sy, sz, cx, cy, cz) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  geometry.translate(cx, cy, cz);
  return geometry;
}

function buildMallFishGeometry(specs) {
  const positions = [];
  const seeds = [];
  const phases = [];
  const tankIndices = [];
  const restYs = [];
  const shape = [
    [[0.42, 0], [0, 0.2], [-0.3, 0]],
    [[0.42, 0], [-0.3, 0], [0, -0.2]],
    [[-0.28, 0], [-0.55, 0.22], [-0.55, -0.22]],
  ];
  const vertex = new THREE.Vector3();
  for (const spec of specs) {
    const tankIndex = Number.isFinite(spec.tankIndex) ? spec.tankIndex : 0;
    for (const triangle of shape) {
      for (const [x, y] of triangle) {
        vertex.set(x * spec.scale, y * spec.scale, 0)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), spec.yaw)
          .add(new THREE.Vector3(spec.cx, spec.cy, spec.cz));
        positions.push(vertex.x, vertex.y, vertex.z);
        seeds.push(spec.seed);
        phases.push(spec.phase);
        tankIndices.push(tankIndex);
        restYs.push(spec.cy);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('fishSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setAttribute('fishPhase', new THREE.Float32BufferAttribute(phases, 1));
  geometry.setAttribute('tankIndex', new THREE.Float32BufferAttribute(tankIndices, 1));
  geometry.setAttribute('fishRestY', new THREE.Float32BufferAttribute(restYs, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 1.2;
  return geometry;
}

function buildMallShippingExit({ group, colliders }) {
  const length = SHIPPING_X1 - SHIPPING_X0;
  const centerX = (SHIPPING_X0 + SHIPPING_X1) * 0.5;
  // This finish spans both the mall slab and the padded yard floor. Raising it
  // by 15mm prevents coplanar depth flicker at either threshold while staying
  // below the character controller's perceptible step height.
  const shippingFloorTop = FLOOR_Y + 0.015;
  const shippingFloorH = 0.2;
  addBox({
    group, colliders, name: 'Mall Shipping Floor',
    cx: centerX, cy: shippingFloorTop - shippingFloorH * 0.5, cz: 0,
    sx: length, sy: shippingFloorH, sz: SHIPPING_HALF_W * 2,
    material: mallFloorMat,
    collider: true, surfaceClass: 'concrete', tileMeters: 2.4,
  });
  for (const side of [-1, 1]) {
    addBox({
      group, colliders, name: `Mall Shipping ${side > 0 ? 'North' : 'South'} Wall`,
      cx: centerX, cy: 2.55, cz: side * SHIPPING_HALF_W,
      sx: length, sy: 5.1, sz: 0.38,
      material: wallMat, collider: true, noGroundSnap: true, surfaceClass: 'metal',
      tileMeters: METAL_TILE_M,
    });
  }
  addBox({
    group, colliders: null, name: 'Mall Shipping Roof',
    cx: centerX, cy: 5.25, cz: 0,
    sx: length, sy: 0.28, sz: SHIPPING_HALF_W * 2 + 0.4,
    material: wallMat, collider: false, tileMeters: METAL_TILE_M,
  });

  // Close the high wall above both open service portals. Without these
  // transoms the 5.25m shipping roof left a bright slot up to the 7.2m mall
  // ceiling, making the storefront avenue look like an unfinished facade.
  const transomBottom = 5.32;
  const transomH = MALL_WALL_H - transomBottom;
  for (const portalX of [SHIPPING_X0, SHIPPING_MALL_SHELL_X]) {
    addBox({
      group, colliders: null, name: `Mall Shipping High Transom ${portalX}`,
      cx: portalX, cy: transomBottom + transomH * 0.5, cz: 0,
      sx: 0.42, sy: transomH, sz: SHIPPING_HALF_W * 2 + 0.4,
      material: mallAccentMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Mall Shipping Transom Light ${portalX}`,
      cx: portalX - 0.24, cy: transomBottom + 0.22, cz: 0,
      sx: 0.12, sy: 0.16, sz: SHIPPING_HALF_W * 2 - 1.2,
      material: mallLightMat, collider: false,
    });
  }

  // Raised service shutter and two frames make the required back door legible
  // while keeping Horde navigation open from the first frame.
  // Storefront-line entry, recessed mall-shell frame, and train-yard exit.
  // The first two make the transition read as a deliberately deep vestibule.
  for (const portalX of [SHIPPING_X0, SHIPPING_MALL_SHELL_X, SHIPPING_X1]) {
    for (const side of [-1, 1]) {
      addBox({
        group, colliders, name: `Mall Shipping Portal Post ${portalX}_${side}`,
        cx: portalX, cy: 2.45, cz: side * (SHIPPING_HALF_W - 0.22),
        sx: 0.48, sy: 4.9, sz: 0.48,
        material: gateFrameMat, collider: true, noGroundSnap: true, surfaceClass: 'metal',
      });
    }
    addBox({
      group, colliders, name: `Mall Shipping Portal Header ${portalX}`,
      cx: portalX, cy: 4.75, cz: 0,
      sx: 0.48, sy: 0.62, sz: SHIPPING_HALF_W * 2,
      material: gateFrameMat, collider: true, noGroundSnap: true, surfaceClass: 'metal',
    });
    addBox({
      group, colliders: null, name: `Mall Shipping Raised Shutter ${portalX}`,
      cx: portalX - 0.04, cy: 4.35, cz: 0,
      sx: 0.18, sy: 0.35, sz: SHIPPING_HALF_W * 2 - 0.65,
      material: shutterMat, collider: false, tileMeters: METAL_TILE_M,
    });
  }

  // Loading clutter stays against the walls, leaving a broad mob lane.
  for (const [x, z] of [
    [SHIPPING_MALL_SHELL_X + 3.0, -1.85],
    [SHIPPING_X1 - 2.0, 1.85],
  ]) {
    addBox({
      group, colliders, name: `Mall Shipping Pallet ${x}_${z}`,
      cx: x, cy: 0.42, cz: z,
      sx: 2.1, sy: 0.84, sz: 1.5,
      material: tieMat, collider: true, surfaceClass: 'wood', tileMeters: WOOD_TILE_M,
    });
  }
}

// ── West winding leg + food court ─────────────────────────────────────────

/**
 * Corridor frontage: a run of TSL shop bays on the corridor edge backed by a
 * solid (collider) store mass, with the same shell treatment as the mall ring
 * — recessed near bulk, deep fill, roof lid, apron, and a warm accent band.
 * `axis: 'x'` fronts a z=plane run, `axis: 'z'` an x=plane run; `facing` is
 * the unit normal (+1/-1 along the plane axis) pointing into the hall.
 */
function addLegFrontage({
  group,
  colliders,
  parts,
  name,
  axis,
  plane,
  facing,
  glass: [g0, g1],
  piers = [],
  mass: [m0, m1],
  depth = LEG_STORE_DEPTH,
  bandTop = LEG_CEIL_Y,
  rearWall = null,
  ordinal,
}) {
  const normal = axis === 'x'
    ? new THREE.Vector3(0, 0, facing)
    : new THREE.Vector3(facing, 0, 0);
  const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  const tangent = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).normalize();
  const along = axis === 'x'
    ? (a) => new THREE.Vector3(a, 0, plane)
    : (a) => new THREE.Vector3(plane, 0, a);

  const count = Math.max(1, Math.round((g1 - g0) / LEG_BAY));
  const pitch = (g1 - g0) / count;
  for (let i = 0; i < count; i += 1) {
    addMallShopBayGeometry({
      parts,
      center: along(g0 + pitch * (i + 0.5)),
      normal,
      rotation,
      tangent,
      width: pitch - 0.16,
      ordinal: ordinal.value,
    });
    ordinal.value += 1;
  }

  // Boxes addressed along the run: [a0, a1] along-axis, [d0, d1] depth into
  // the mass (positive = behind the glass plane, negative = proud into hall).
  const boxAt = ({ suffix, a0, a1, d0, d1, y0, y1, material, collider = false }) => {
    const dc = plane - facing * (d0 + d1) * 0.5;
    addBox({
      group, colliders, name: `${name} ${suffix}`,
      cx: axis === 'x' ? (a0 + a1) * 0.5 : dc,
      cy: (y0 + y1) * 0.5,
      cz: axis === 'x' ? dc : (a0 + a1) * 0.5,
      sx: axis === 'x' ? a1 - a0 : d1 - d0,
      sy: y1 - y0,
      sz: axis === 'x' ? d1 - d0 : a1 - a0,
      material, collider, noGroundSnap: true, surfaceClass: 'concrete',
    });
  };

  // Solid end piers where the run has no glass (bend + mouth corners).
  for (let i = 0; i < piers.length; i += 1) {
    const [p0, p1] = piers[i];
    boxAt({
      suffix: `Pier ${i}`,
      a0: p0, a1: p1, d0: -0.08, d1: 0.55, y0: FLOOR_Y, y1: LEG_WALL_H,
      material: mallWallMat, collider: true,
    });
  }

  // Backing mass (collider-only body) + visible shell behind the glass.
  pushMallCollider(colliders, axis === 'x'
    ? { name: `${name} Mass`, cx: (m0 + m1) * 0.5, cz: plane - facing * depth * 0.5, sx: m1 - m0, sz: depth }
    : { name: `${name} Mass`, cx: plane - facing * depth * 0.5, cz: (m0 + m1) * 0.5, sx: depth, sz: m1 - m0 });
  boxAt({ suffix: 'Near Bulk', a0: m0, a1: m1, d0: 2.35, d1: 2.9, y0: FLOOR_Y, y1: MALL_SHOP_H + 0.35, material: mallWallMat });
  boxAt({ suffix: 'Deep Fill', a0: m0, a1: m1, d0: 2.62, d1: depth, y0: FLOOR_Y, y1: MALL_SHOP_H + 0.35, material: mallWallMat });
  boxAt({ suffix: 'Roof', a0: m0, a1: m1, d0: 0, d1: depth + 0.5, y0: MALL_SHOP_H, y1: MALL_SHOP_H + 0.28, material: mallCeilingMat });
  boxAt({ suffix: 'Apron', a0: m0, a1: m1, d0: 0, d1: 0.45, y0: MALL_SHOP_H, y1: bandTop, material: mallWallMat });
  boxAt({ suffix: 'Accent Band', a0: m0, a1: m1, d0: -0.46, d1: -0.16, y0: MALL_SHOP_H + 0.08, y1: bandTop, material: mallAccentMat });
  if (rearWall) {
    boxAt({
      suffix: 'Rear Wall',
      a0: rearWall[0], a1: rearWall[1], d0: depth, d1: depth + 0.45,
      y0: FLOOR_Y, y1: LEG_WALL_H, material: mallWallMat, collider: true,
    });
  }
  return count;
}

/**
 * The winding west leg: mall west storefront line → leg A (west) → bend north
 * (leg B) → leg C (west) → food court. Shop masses + solid corner fills keep
 * the silhouette sealed at both bends.
 */
function buildMallWestLeg({ group, colliders }) {
  const parts = [];
  const ordinal = { value: 0 };
  const A_X0 = MALL_CENTER_X - MALL_HALF - 0.3; // flush with the west shell face
  let stores = 0;

  // ── Floors (abutted, never coplanar) ─────────────────────────────────────
  // Vestibule slice overlaps the mall slab edge, so it rides +15 mm like the
  // shipping finish to avoid depth flicker at the threshold.
  addBox({
    group, colliders, name: 'Mall Leg Floor Vestibule',
    cx: (A_X0 + (MALL_CENTER_X - MALL_STOREFRONT_HALF)) * 0.5, cy: FLOOR_Y + 0.015 - 0.1, cz: 0,
    sx: (MALL_CENTER_X - MALL_STOREFRONT_HALF) - A_X0, sy: 0.2, sz: LEG_HALF_W * 2,
    material: mallFloorMat, collider: true, surfaceClass: 'concrete', tileMeters: 2.4,
  });
  addBox({
    group, colliders, name: 'Mall Leg Floor A',
    cx: (LEG_A_X1 + A_X0) * 0.5, cy: FLOOR_Y - 0.12, cz: 0,
    sx: A_X0 - LEG_A_X1, sy: 0.24, sz: LEG_HALF_W * 2 + 0.4,
    material: mallFloorMat, collider: true, surfaceClass: 'concrete', tileMeters: 2.4,
  });
  addBox({
    group, colliders, name: 'Mall Leg Floor B',
    cx: (LEG_B_X + LEG_A_X1) * 0.5 - 0.175, cy: FLOOR_Y - 0.12, cz: (LEG_C_Z + 0.35 - LEG_HALF_W - 0.2) * 0.5,
    sx: LEG_A_X1 - LEG_B_X + 0.35, sy: 0.24, sz: LEG_C_Z + LEG_HALF_W + 0.55,
    material: mallFloorMat, collider: true, surfaceClass: 'concrete', tileMeters: 2.4,
  });
  addBox({
    group, colliders, name: 'Mall Leg Floor C',
    cx: (LEG_C_X1 + LEG_B_X - 0.35) * 0.5, cy: FLOOR_Y - 0.12, cz: LEG_C_Z,
    sx: LEG_B_X - 0.35 - LEG_C_X1, sy: 0.24, sz: LEG_HALF_W * 2 + 0.7,
    material: mallFloorMat, collider: true, surfaceClass: 'concrete', tileMeters: 2.4,
  });
  addBox({
    group, colliders, name: 'Mall Leg Floor C Pocket',
    cx: (LEG_B_X + LEG_A_X1) * 0.5 - 0.175, cy: FLOOR_Y - 0.12, cz: (LEG_C_Z + 0.35 + LEG_C_Z + LEG_HALF_W + 0.35) * 0.5,
    sx: LEG_A_X1 - LEG_B_X + 0.35, sy: 0.24, sz: LEG_HALF_W,
    material: mallFloorMat, collider: true, surfaceClass: 'concrete', tileMeters: 2.4,
  });

  // ── Corridor ceilings (abutted at the two bend pockets) ──────────────────
  const legCeil = (name, cx, cz, sx, sz) => addBox({
    group, colliders: null, name,
    cx, cy: LEG_CEIL_Y + 0.14, cz, sx, sy: 0.28, sz,
    material: mallCeilingMat, collider: false, tileMeters: 2.4,
  });
  legCeil('Mall Leg Ceiling A', (LEG_A_X1 + MALL_CENTER_X - MALL_STOREFRONT_HALF) * 0.5 + 0.125, 0,
    (MALL_CENTER_X - MALL_STOREFRONT_HALF) + 0.25 - LEG_A_X1, LEG_HALF_W * 2 + 0.6);
  legCeil('Mall Leg Ceiling B', (LEG_B_X + LEG_A_X1) * 0.5 - 0.175, (LEG_C_Z + 0.35 - LEG_HALF_W) * 0.5 - 0.15,
    LEG_A_X1 - LEG_B_X + 0.35, LEG_C_Z + 0.35 + LEG_HALF_W + 0.3);
  legCeil('Mall Leg Ceiling C', (LEG_C_X1 + LEG_B_X - 0.35) * 0.5, LEG_C_Z,
    LEG_B_X - 0.35 - LEG_C_X1, LEG_HALF_W * 2 + 0.7);
  legCeil('Mall Leg Ceiling C Pocket', (LEG_B_X + LEG_A_X1) * 0.5 - 0.175, LEG_C_Z + LEG_HALF_W * 0.5 + 0.35,
    LEG_A_X1 - LEG_B_X + 0.35, LEG_HALF_W);

  // ── Ceiling light strips ─────────────────────────────────────────────────
  let legLight = 0;
  const legStrip = (cx, cz, alongX) => {
    addBox({
      group, colliders: null, name: `Mall Leg Light ${legLight++}`,
      cx, cy: LEG_CEIL_Y - 0.04, cz,
      sx: alongX ? 3.2 : 0.26, sy: 0.08, sz: alongX ? 0.26 : 3.2,
      material: mallLightMat, collider: false,
    });
  };
  legStrip(-112.5, 0, true);
  for (const x of [-124, -133, -142, -150.5]) legStrip(x, 0, true);
  for (const z of [2, 12, 22]) legStrip((LEG_B_X + LEG_A_X1) * 0.5, z, false);
  for (const x of [-170, -180, -190, -200, -210]) legStrip(x, LEG_C_Z, true);

  // ── Shop frontages (glass + masses + piers + rear walls) ─────────────────
  stores += addLegFrontage({
    group, colliders, parts, ordinal, name: 'Mall Leg A North',
    axis: 'x', plane: LEG_HALF_W, facing: -1,
    glass: [LEG_A_X1 + 1.5, A_X0 - 1.2],
    piers: [[LEG_A_X1, LEG_A_X1 + 1.5], [A_X0 - 1.2, A_X0]],
    mass: [LEG_A_X1, A_X0],
    rearWall: [LEG_A_X1, A_X0],
  });
  stores += addLegFrontage({
    group, colliders, parts, ordinal, name: 'Mall Leg A South',
    axis: 'x', plane: -LEG_HALF_W, facing: 1,
    glass: [LEG_A_X1 + 1.5, A_X0 - 1.2],
    piers: [[LEG_A_X1, LEG_A_X1 + 1.5], [A_X0 - 1.2, A_X0]],
    mass: [LEG_A_X1, A_X0],
    rearWall: [LEG_B_X - LEG_STORE_DEPTH - 0.45, A_X0],
  });
  stores += addLegFrontage({
    group, colliders, parts, ordinal, name: 'Mall Leg B West',
    axis: 'z', plane: LEG_B_X, facing: 1,
    glass: [9.5, LEG_C_Z - 5],
    piers: [[-LEG_HALF_W, 9.5], [LEG_C_Z - 5, LEG_C_Z - LEG_HALF_W]],
    mass: [-LEG_HALF_W, LEG_C_Z - LEG_HALF_W],
    rearWall: [-LEG_STORE_DEPTH - LEG_HALF_W - 0.05, LEG_C_Z - LEG_HALF_W],
  });
  stores += addLegFrontage({
    group, colliders, parts, ordinal, name: 'Mall Leg B East',
    axis: 'z', plane: LEG_A_X1, facing: -1,
    glass: [9.5, LEG_C_Z - 5],
    piers: [[LEG_HALF_W, 9.5], [LEG_C_Z - 5, LEG_C_Z - LEG_HALF_W]],
    mass: [LEG_HALF_W, LEG_C_Z - LEG_HALF_W],
    rearWall: [LEG_HALF_W, LEG_C_Z + LEG_HALF_W + 6],
  });
  stores += addLegFrontage({
    group, colliders, parts, ordinal, name: 'Mall Leg C North',
    axis: 'x', plane: LEG_C_Z + LEG_HALF_W, facing: -1,
    glass: [LEG_C_X1 + 8, LEG_B_X - 3],
    piers: [[LEG_C_X1, LEG_C_X1 + 8], [LEG_B_X - 3, LEG_A_X1 + LEG_STORE_DEPTH]],
    mass: [LEG_C_X1, LEG_A_X1 + LEG_STORE_DEPTH],
    rearWall: [LEG_C_X1, LEG_A_X1 + LEG_STORE_DEPTH],
  });
  stores += addLegFrontage({
    group, colliders, parts, ordinal, name: 'Mall Leg C South',
    axis: 'x', plane: LEG_C_Z - LEG_HALF_W, facing: 1,
    glass: [LEG_C_X1 + 8, LEG_B_X - 4],
    piers: [[LEG_C_X1, LEG_C_X1 + 8], [LEG_B_X - 4, LEG_B_X]],
    mass: [LEG_C_X1, LEG_B_X],
    rearWall: [LEG_C_X1, LEG_B_X],
  });

  // ── Solid corner fills seal the bend voids ───────────────────────────────
  addBox({
    group, colliders, name: 'Mall Leg Bend Fill South',
    cx: (LEG_B_X - LEG_STORE_DEPTH + LEG_A_X1) * 0.5, cy: LEG_WALL_H * 0.5, cz: -LEG_HALF_W - (LEG_STORE_DEPTH + 0.05) * 0.5,
    sx: LEG_A_X1 - LEG_B_X + LEG_STORE_DEPTH, sy: LEG_WALL_H, sz: LEG_STORE_DEPTH + 0.05,
    material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
  });
  addBox({
    group, colliders, name: 'Mall Leg Bend Fill North',
    cx: LEG_A_X1 + LEG_STORE_DEPTH * 0.5, cy: LEG_WALL_H * 0.5, cz: LEG_C_Z,
    sx: LEG_STORE_DEPTH, sy: LEG_WALL_H, sz: LEG_HALF_W * 2,
    material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
  });

  // ── Vestibule portal frames (storefront line + shell), transoms, lights ──
  for (const portalX of [MALL_CENTER_X - MALL_STOREFRONT_HALF, MALL_CENTER_X - MALL_HALF - 0.25]) {
    for (const side of [-1, 1]) {
      addBox({
        group, colliders, name: `Mall Leg Portal Post ${portalX}_${side}`,
        cx: portalX, cy: 2.45, cz: side * (LEG_HALF_W - 0.22),
        sx: 0.48, sy: 4.9, sz: 0.48,
        material: gateFrameMat, collider: true, noGroundSnap: true, surfaceClass: 'metal',
      });
    }
    addBox({
      group, colliders, name: `Mall Leg Portal Header ${portalX}`,
      cx: portalX, cy: 4.75, cz: 0,
      sx: 0.48, sy: 0.62, sz: LEG_HALF_W * 2,
      material: gateFrameMat, collider: true, noGroundSnap: true, surfaceClass: 'metal',
    });
    addBox({
      group, colliders: null, name: `Mall Leg Raised Shutter ${portalX}`,
      cx: portalX + 0.04, cy: 4.35, cz: 0,
      sx: 0.18, sy: 0.35, sz: LEG_HALF_W * 2 - 0.65,
      material: shutterMat, collider: false, tileMeters: METAL_TILE_M,
    });
    addBox({
      group, colliders: null, name: `Mall Leg High Transom ${portalX}`,
      cx: portalX, cy: (LEG_CEIL_Y + MALL_WALL_H) * 0.5, cz: 0,
      sx: 0.42, sy: MALL_WALL_H - LEG_CEIL_Y, sz: LEG_HALF_W * 2 + 0.4,
      material: mallAccentMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Mall Leg Transom Light ${portalX}`,
      cx: portalX + 0.24, cy: LEG_CEIL_Y + 0.22, cz: 0,
      sx: 0.12, sy: 0.16, sz: LEG_HALF_W * 2 - 1.2,
      material: mallLightMat, collider: false,
    });
  }

  const foodStats = buildMallFoodCourt({ group, colliders, parts, ordinal });
  stores += foodStats.stalls;

  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose?.();
  const mesh = new THREE.Mesh(geometry, mallStorefrontMat);
  mesh.name = 'Mall West Leg Storefronts';
  mesh.userData.noStaticMerge = true;
  mesh.userData.mallStorefront = true;
  mesh.userData.storeCount = stores;
  mesh.userData.paneCount = stores;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  group.add(mesh);

  return {
    stores,
    panes: stores,
    foodStalls: foodStats.stalls,
    tables: foodStats.tables,
    kiosks: foodStats.kiosks,
  };
}

/**
 * Food court — half the mall footprint at the end of the winding leg. Stall
 * glass across the west wall, counter kiosks along north/south, loose table
 * groups and planters; the east mouth connects leg C. Last-stand room.
 */
function buildMallFoodCourt({ group, colliders, parts, ordinal }) {
  const X0 = FOOD_CX - FOOD_HALF; // -266 (west boundary)
  const X1 = FOOD_CX + FOOD_HALF; // -218 (east boundary / mouth wall)
  const Z0 = FOOD_CZ - FOOD_HALF; // 6.5
  const Z1 = FOOD_CZ + FOOD_HALF; // 54.5
  const STALL_D = 4.55;

  addBox({
    group, colliders, name: 'Food Court Floor',
    cx: FOOD_CX, cy: FLOOR_Y - 0.12, cz: FOOD_CZ,
    sx: FOOD_HALF * 2, sy: 0.24, sz: FOOD_HALF * 2 + 1,
    material: mallFloorMat, collider: true, surfaceClass: 'concrete', tileMeters: 2.4,
  });

  // Perimeter walls; east wall splits around the leg C mouth.
  for (const side of [-1, 1]) {
    addBox({
      group, colliders, name: `Food Court ${side > 0 ? 'North' : 'South'} Wall`,
      cx: FOOD_CX, cy: FOOD_WALL_H * 0.5, cz: side > 0 ? Z1 : Z0,
      sx: FOOD_HALF * 2 + 1, sy: FOOD_WALL_H, sz: 0.5,
      material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
    });
  }
  for (const wing of [[Z0, LEG_C_Z - LEG_HALF_W], [LEG_C_Z + LEG_HALF_W, Z1]]) {
    addBox({
      group, colliders, name: `Food Court East Wall ${wing[0]}`,
      cx: X1 - 0.25, cy: FOOD_WALL_H * 0.5, cz: (wing[0] + wing[1]) * 0.5,
      sx: 0.5, sy: FOOD_WALL_H, sz: wing[1] - wing[0],
      material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
    });
  }
  // West wall wings flank the stall run; stall rear/caps close the rest.
  for (const wing of [[Z0, Z0 + 3.5], [Z1 - 2.5, Z1]]) {
    addBox({
      group, colliders, name: `Food Court West Wall ${wing[0]}`,
      cx: X0, cy: FOOD_WALL_H * 0.5, cz: (wing[0] + wing[1]) * 0.5,
      sx: 0.5, sy: FOOD_WALL_H, sz: wing[1] - wing[0],
      material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
    });
  }
  addBox({
    group, colliders, name: 'Food Court Stall Rear Wall',
    cx: X0 - STALL_D - 0.225, cy: FOOD_WALL_H * 0.5, cz: FOOD_CZ + 0.5,
    sx: 0.45, sy: FOOD_WALL_H, sz: Z1 - Z0 - 5,
    material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
  });
  for (const capZ of [Z0 + 3.25, Z1 - 2.75]) {
    addBox({
      group, colliders, name: `Food Court Stall Cap ${capZ}`,
      cx: X0 - STALL_D * 0.5 - 0.025, cy: FOOD_WALL_H * 0.5, cz: capZ,
      sx: STALL_D + 0.55, sy: FOOD_WALL_H, sz: 0.5,
      material: mallWallMat, collider: true, noGroundSnap: true, surfaceClass: 'concrete',
    });
  }

  // Stall frontage across the west wall (rear wall authored above).
  const stalls = addLegFrontage({
    group, colliders, parts, ordinal, name: 'Food Court Stalls',
    axis: 'z', plane: X0, facing: 1,
    glass: [Z0 + 6, Z1 - 5],
    piers: [[Z0 + 3.5, Z0 + 6], [Z1 - 5, Z1 - 2.5]],
    mass: [Z0 + 3.5, Z1 - 2.5],
    depth: STALL_D,
    bandTop: FOOD_CEIL_Y,
    rearWall: null,
  });

  // Stall exterior cap + court ceiling + skylight strips.
  addBox({
    group, colliders: null, name: 'Food Court Stall Cap Roof',
    cx: X0 - STALL_D * 0.5 - 0.025, cy: FOOD_WALL_H - 0.1, cz: FOOD_CZ + 0.5,
    sx: STALL_D + 0.55, sy: 0.2, sz: Z1 - Z0 - 5,
    material: mallCeilingMat, collider: false, tileMeters: 2.4,
  });
  addBox({
    group, colliders: null, name: 'Food Court Ceiling',
    cx: FOOD_CX, cy: FOOD_CEIL_Y + 0.14, cz: FOOD_CZ,
    sx: FOOD_HALF * 2, sy: 0.28, sz: FOOD_HALF * 2,
    material: mallCeilingMat, collider: false, tileMeters: 2.4,
  });
  for (const lx of [FOOD_CX - 12, FOOD_CX, FOOD_CX + 12]) {
    addBox({
      group, colliders: null, name: `Food Court Skylight ${lx}`,
      cx: lx, cy: FOOD_CEIL_Y - 0.04, cz: FOOD_CZ,
      sx: 0.9, sy: 0.08, sz: FOOD_HALF * 1.5,
      material: mallLightMat, collider: false,
    });
  }

  // Mouth transom closes above the corridor ceiling line.
  addBox({
    group, colliders: null, name: 'Food Court Mouth Transom',
    cx: X1 - 0.25, cy: (LEG_CEIL_Y + FOOD_WALL_H) * 0.5, cz: LEG_C_Z,
    sx: 0.42, sy: FOOD_WALL_H - LEG_CEIL_Y, sz: LEG_HALF_W * 2 + 0.4,
    material: mallAccentMat, collider: false,
  });
  addBox({
    group, colliders: null, name: 'Food Court Mouth Transom Light',
    cx: X1 + 0.01, cy: LEG_CEIL_Y + 0.22, cz: LEG_C_Z,
    sx: 0.12, sy: 0.16, sz: LEG_HALF_W * 2 - 1.2,
    material: mallLightMat, collider: false,
  });

  // Serving counters, guards, menu boards, and stools fronting the stall glass.
  addFoodStallCounters({ group, colliders, x0: X0, g0: Z0 + 6, g1: Z1 - 5 });

  // Counter kiosks along the north + south walls.
  let kiosks = 0;
  for (const [zWall, dir] of [[Z1 - 0.25, -1], [Z0 + 0.25, 1]]) {
    for (const kx of [FOOD_CX - 14, FOOD_CX, FOOD_CX + 14]) {
      const label = `${kx}_${zWall}`;
      addBox({
        group, colliders, name: `Food Court Kiosk Back ${label}`,
        cx: kx, cy: 1.4, cz: zWall + dir * 0.16,
        sx: 3.4, sy: 2.8, sz: 0.22,
        material: mallTrimMat, collider: true, noGroundSnap: true, surfaceClass: 'metal',
      });
      addBox({
        group, colliders, name: `Food Court Kiosk Counter ${label}`,
        cx: kx, cy: 0.475, cz: zWall + dir * 1.35,
        sx: 3.0, sy: 0.95, sz: 0.7,
        material: foodCounterMat, collider: true, surfaceClass: 'wood',
      });
      addBox({
        group, colliders: null, name: `Food Court Kiosk Counter Top ${label}`,
        cx: kx, cy: 0.98, cz: zWall + dir * 1.35,
        sx: 3.2, sy: 0.06, sz: 0.86,
        material: foodTableTopMat, collider: false,
      });
      addBox({
        group, colliders: null, name: `Food Court Kiosk Guard ${label}`,
        cx: kx, cy: 1.32, cz: zWall + dir * 1.62,
        sx: 2.7, sy: 0.5, sz: 0.03,
        material: foodGuardGlassMat, collider: false,
      });
      addBox({
        group, colliders: null, name: `Food Court Kiosk Shelf ${label}`,
        cx: kx, cy: 1.85, cz: zWall + dir * 0.55,
        sx: 2.6, sy: 0.1, sz: 0.35,
        material: tieMat, collider: false, tileMeters: WOOD_TILE_M,
      });
      addBox({
        group, colliders: null, name: `Food Court Kiosk Sign ${label}`,
        cx: kx, cy: 3.05, cz: zWall + dir * 0.3,
        sx: 3.6, sy: 0.55, sz: 0.14,
        material: foodSignMats[kiosks % foodSignMats.length], collider: false,
      });
      addBox({
        group, colliders: null, name: `Food Court Kiosk Sign Light ${label}`,
        cx: kx, cy: 2.72, cz: zWall + dir * 0.34,
        sx: 3.2, sy: 0.06, sz: 0.1,
        material: mallLightMat, collider: false,
      });
      kiosks += 1;
    }
  }

  // Pedestal cafe tables — light cover that keeps the mob lanes open.
  let tables = 0;
  for (const tz of [FOOD_CZ - 8, FOOD_CZ + 8]) {
    for (const tx of [FOOD_CX - 15, FOOD_CX - 8, FOOD_CX + 8, FOOD_CX + 15]) {
      addFoodCourtTable({
        group,
        colliders,
        x: tx,
        z: tz,
        seatMat: foodSeatMats[tables % foodSeatMats.length],
        // Golden-angle spin so no two table groups read identically.
        angle: tables * 2.399,
      });
      tables += 1;
    }
  }

  // Corner planters frame the last-stand open floor.
  for (const [px, pz] of [
    [X0 + 6, Z0 + 3.5],
    [X1 - 6, Z0 + 3.5],
    [X0 + 6, Z1 - 3.5],
    [X1 - 6, Z1 - 3.5],
  ]) {
    addBox({
      group, colliders, name: `Food Court Planter ${px}_${pz}`,
      cx: px, cy: 0.28, cz: pz,
      sx: 2.4, sy: 0.56, sz: 1.2,
      material: mallPlanterMat, collider: true, surfaceClass: 'concrete',
    });
    addBox({
      group, colliders: null, name: `Food Court Planter Hedge ${px}_${pz}`,
      cx: px, cy: 0.82, cz: pz,
      sx: 2.15, sy: 0.52, sz: 0.95,
      material: foodFoliageMat, collider: false,
    });
  }

  return { stalls, tables, kiosks };
}

/**
 * Serving-counter lineup fronting the food-stall TSL glass: per-bay counter
 * with laminate top + kick, sneeze-guard glass, hanging menu board with an
 * under-board light strip, and a pair of stools. Counters are the only new
 * colliders — guards / boards / stools stay visual so mob lanes match the
 * old layout.
 */
function addFoodStallCounters({ group, colliders, x0, g0, g1 }) {
  const count = Math.max(1, Math.round((g1 - g0) / LEG_BAY));
  const pitch = (g1 - g0) / count;
  const counterX = x0 + 1.7;
  for (let i = 0; i < count; i += 1) {
    const zc = g0 + pitch * (i + 0.5);
    const label = `Bay ${i}`;
    addBox({
      group, colliders, name: `Food Stall Counter ${label}`,
      cx: counterX, cy: 0.475, cz: zc,
      sx: 1.05, sy: 0.95, sz: pitch - 1.5,
      material: foodCounterMat, collider: true, surfaceClass: 'wood',
    });
    addBox({
      group, colliders: null, name: `Food Stall Counter Kick ${label}`,
      cx: counterX + 0.5, cy: 0.08, cz: zc,
      sx: 0.12, sy: 0.16, sz: pitch - 1.7,
      material: foodCounterKickMat, collider: false,
    });
    addBox({
      group, colliders: null, name: `Food Stall Counter Top ${label}`,
      cx: counterX, cy: 0.98, cz: zc,
      sx: 1.28, sy: 0.06, sz: pitch - 1.3,
      material: foodTableTopMat, collider: false,
    });
    // Sneeze guard on slim posts above the front edge.
    addBox({
      group, colliders: null, name: `Food Stall Guard ${label}`,
      cx: counterX + 0.42, cy: 1.34, cz: zc,
      sx: 0.03, sy: 0.52, sz: pitch - 1.9,
      material: foodGuardGlassMat, collider: false,
    });
    for (const side of [-1, 1]) {
      addBox({
        group, colliders: null, name: `Food Stall Guard Post ${label}_${side}`,
        cx: counterX + 0.42, cy: 1.3, cz: zc + side * (pitch - 1.9) * 0.5,
        sx: 0.045, sy: 0.64, sz: 0.045,
        material: foodChairFrameMat, collider: false,
      });
    }
    // Hanging menu board + hanger rods + light strip washing the counter.
    const sign = foodSignMats[i % foodSignMats.length];
    addBox({
      group, colliders: null, name: `Food Stall Menu Board ${label}`,
      cx: x0 + 1.2, cy: 3.3, cz: zc,
      sx: 0.14, sy: 0.75, sz: pitch - 1.8,
      material: sign, collider: false,
    });
    for (const side of [-1, 1]) {
      addBox({
        group, colliders: null, name: `Food Stall Menu Rod ${label}_${side}`,
        cx: x0 + 1.2, cy: 4.15, cz: zc + side * (pitch - 2.2) * 0.5,
        sx: 0.04, sy: 0.95, sz: 0.04,
        material: foodChairFrameMat, collider: false,
      });
    }
    addBox({
      group, colliders: null, name: `Food Stall Menu Light ${label}`,
      cx: x0 + 1.3, cy: 2.86, cz: zc,
      sx: 0.1, sy: 0.06, sz: pitch - 2.0,
      material: mallLightMat, collider: false,
    });
    // Two stools at the counter front (visual only — no collider clutter).
    for (const side of [-1, 1]) {
      const sz2 = zc + side * pitch * 0.18;
      const stool = new THREE.Group();
      stool.name = `Food Stall Stool ${label}_${side}`;
      stool.position.set(counterX + 1.05, FLOOR_Y, sz2);
      group.add(stool);
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 14), foodSeatMats[(i + (side > 0 ? 1 : 0)) % foodSeatMats.length]);
      seat.position.y = 0.68;
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.62, 10), foodChairFrameMat);
      column.position.y = 0.34;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.04, 14), foodChairFrameMat);
      base.position.y = 0.02;
      for (const mesh of [seat, column, base]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        stool.add(mesh);
      }
    }
  }
}

/**
 * Pedestal cafe table (round laminate top on a steel column) with four metal
 * cafe chairs facing it. Colliders mirror the old blocky set — one AABB per
 * table + one per chair — so the flow-mob lanes are unchanged.
 */
function addFoodCourtTable({ group, colliders, x, z, seatMat, angle }) {
  const set = new THREE.Group();
  set.name = `Food Court Table Set ${x}_${z}`;
  set.position.set(x, FLOOR_Y, z);
  set.rotation.y = angle;
  group.add(set);

  const add = (geometry, material, px, py, pz) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(px, py, pz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    set.add(mesh);
    return mesh;
  };

  add(new THREE.CylinderGeometry(0.34, 0.42, 0.05, 18), foodChairFrameMat, 0, 0.025, 0);
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.68, 10), foodChairFrameMat, 0, 0.39, 0);
  add(new THREE.CylinderGeometry(0.63, 0.63, 0.025, 24), foodChairFrameMat, 0, 0.725, 0);
  add(new THREE.CylinderGeometry(0.62, 0.62, 0.05, 24), foodTableTopMat, 0, 0.762, 0);

  colliders.push({
    name: `Food Court Table ${x}_${z}`,
    minX: x - 0.5, maxX: x + 0.5,
    minZ: z - 0.5, maxZ: z + 0.5,
    bottomY: FLOOR_Y, topY: 0.79,
    surfaceClass: 'metal',
  });

  for (let i = 0; i < 4; i += 1) {
    const a = i * Math.PI * 0.5 + Math.PI * 0.25;
    const cxLocal = Math.cos(a) * 1.0;
    const czLocal = Math.sin(a) * 1.0;
    const chair = new THREE.Group();
    chair.position.set(cxLocal, 0, czLocal);
    // Local +z faces the table centre so the backrest sits on the outside.
    chair.rotation.y = Math.atan2(-cxLocal, -czLocal);
    set.add(chair);

    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.4), seatMat);
    seat.position.set(0, 0.46, 0);
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.48, 0.045), seatMat);
    backrest.position.set(0, 0.74, -0.2);
    backrest.rotation.x = 0.1;
    chair.add(seat, backrest);
    for (const [lx, lz] of [[0.17, 0.15], [-0.17, 0.15], [0.17, -0.15], [-0.17, -0.15]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.44, 0.035), foodChairFrameMat);
      leg.position.set(lx, 0.22, lz);
      chair.add(leg);
    }
    for (const mesh of chair.children) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }

    // Axis-aligned chair collider at the chair's world XZ.
    const wx = x + cxLocal * Math.cos(angle) + czLocal * Math.sin(angle);
    const wz = z - cxLocal * Math.sin(angle) + czLocal * Math.cos(angle);
    colliders.push({
      name: `Food Court Chair ${x}_${z}_${i}`,
      minX: wx - 0.24, maxX: wx + 0.24,
      minZ: wz - 0.24, maxZ: wz + 0.24,
      bottomY: FLOOR_Y, topY: 0.92,
      surfaceClass: 'plastic',
    });
  }
}

function addMallCeilingLights({ group }) {
  const addStrip = (cx, cz, sx, sz, index) => addBox({
    group,
    colliders: null,
    name: `Mall Ceiling Light ${index}`,
    cx,
    cy: MALL_WALL_H - 0.18,
    cz,
    sx,
    sy: 0.08,
    sz,
    material: mallLightMat,
    collider: false,
  });
  let index = 0;
  for (const offset of [-17, 0, 17]) {
    addStrip(MALL_CENTER_X + offset, 0, 8.5, 0.26, index++);
    addStrip(MALL_CENTER_X, offset, 0.26, 8.5, index++);
  }
  const ring = MALL_STOREFRONT_HALF - MALL_RING_W * 0.5;
  for (const offset of [-18, -6, 6, 18]) {
    addStrip(MALL_CENTER_X + offset, ring, 7.5, 0.22, index++);
    addStrip(MALL_CENTER_X + offset, -ring, 7.5, 0.22, index++);
    addStrip(MALL_CENTER_X + ring, offset, 0.22, 7.5, index++);
    addStrip(MALL_CENTER_X - ring, offset, 0.22, 7.5, index++);
  }
}

/**
 * One custom-attribute mesh for the entire retail ring. Part ids match
 * SkyscraperGenerator's TSL material contract:
 * FRAME=2, SHOPGLASS=6, STORE=7, AWNING=8.
 */
function buildMallStorefrontMesh() {
  const parts = [];
  let storeCount = 0;
  let paneCount = 0;
  const faces = [
    { center: new THREE.Vector3(MALL_CENTER_X, 0, MALL_STOREFRONT_HALF), normal: new THREE.Vector3(0, 0, -1) },
    { center: new THREE.Vector3(MALL_CENTER_X, 0, -MALL_STOREFRONT_HALF), normal: new THREE.Vector3(0, 0, 1) },
    { center: new THREE.Vector3(MALL_CENTER_X - MALL_STOREFRONT_HALF, 0, 0), normal: new THREE.Vector3(1, 0, 0), legGap: true },
    { center: new THREE.Vector3(MALL_CENTER_X + MALL_STOREFRONT_HALF, 0, 0), normal: new THREE.Vector3(-1, 0, 0), shippingGap: true },
  ];

  for (const face of faces) {
    const rotation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      face.normal,
    );
    const tangent = new THREE.Vector3(1, 0, 0).applyQuaternion(rotation).normalize();
    const count = 9;
    const bay = (MALL_STOREFRONT_HALF * 2) / count;
    for (let i = 0; i < count; i += 1) {
      const along = -MALL_STOREFRONT_HALF + bay * (i + 0.5);
      const center = face.center.clone().addScaledVector(tangent, along);
      if (face.shippingGap && Math.abs(center.z) < SHIPPING_HALF_W + 0.8) continue;
      if (face.legGap && Math.abs(center.z) < LEG_HALF_W + 0.8) continue;
      addMallShopBayGeometry({ parts, center, normal: face.normal, rotation, tangent, width: bay - 0.16, ordinal: storeCount });
      storeCount += 1;
      paneCount += 1;
    }
  }

  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose?.();
  const mesh = new THREE.Mesh(geometry, mallStorefrontMat);
  mesh.userData.storeCount = storeCount;
  mesh.userData.paneCount = paneCount;
  return mesh;
}

function addMallShopBayGeometry({ parts, center, normal, rotation, tangent, width, ordinal }) {
  const bulkheadH = 0.55;
  const fasciaH = 0.86;
  const glassH = MALL_SHOP_H - bulkheadH - fasciaH;
  const glassY = bulkheadH + glassH * 0.5;
  const front = center.clone().addScaledVector(normal, 0.04);
  const glassCenter = new THREE.Vector3(front.x, glassY, front.z);

  parts.push(makeMallRetailPart({
    geometry: new THREE.PlaneGeometry(width - 0.34, glassH),
    position: glassCenter,
    rotation,
    partId: 6,
    roomCenter: glassCenter,
    roomSize: [width - 0.34, glassH],
  }));
  parts.push(makeMallRetailBox({
    sx: width, sy: bulkheadH, sz: 0.42,
    position: center.clone().setY(bulkheadH * 0.5), rotation, partId: 7,
  }));
  parts.push(makeMallRetailBox({
    sx: width, sy: fasciaH, sz: 0.58,
    position: center.clone().setY(MALL_SHOP_H - fasciaH * 0.5), rotation, partId: 7,
  }));
  for (const side of [-1, 1]) {
    parts.push(makeMallRetailBox({
      sx: 0.18, sy: MALL_SHOP_H, sz: 0.34,
      position: center.clone().addScaledVector(tangent, side * width * 0.5).setY(MALL_SHOP_H * 0.5),
      rotation,
      partId: 2,
    }));
  }
  for (const fraction of [-1 / 6, 1 / 6]) {
    parts.push(makeMallRetailBox({
      sx: 0.075, sy: glassH, sz: 0.2,
      position: center.clone().addScaledVector(tangent, fraction * width).setY(glassY),
      rotation,
      partId: 2,
    }));
  }
  if (ordinal % 3 === 1) {
    parts.push(makeMallRetailBox({
      sx: width - 0.45, sy: 0.12, sz: 0.9,
      position: center.clone().addScaledVector(normal, 0.42).setY(MALL_SHOP_H - fasciaH - 0.12),
      rotation,
      partId: 8,
    }));
  }
}

function makeMallRetailBox({ sx, sy, sz, position, rotation, partId }) {
  return makeMallRetailPart({
    geometry: new THREE.BoxGeometry(sx, sy, sz),
    position,
    rotation,
    partId,
  });
}

function makeMallRetailPart({
  geometry,
  position,
  rotation,
  partId,
  roomCenter = null,
  roomSize = null,
}) {
  const matrix = new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
  geometry.applyMatrix4(matrix);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(count).fill(partId), 1));
  const center = roomCenter ?? new THREE.Vector3();
  const centers = new Float32Array(count * 3);
  const sizes = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    centers[i * 3] = center.x;
    centers[i * 3 + 1] = center.y;
    centers[i * 3 + 2] = center.z;
    sizes[i * 2] = roomSize?.[0] ?? 0;
    sizes[i * 2 + 1] = roomSize?.[1] ?? 0;
  }
  geometry.setAttribute('roomCenter', new THREE.BufferAttribute(centers, 3));
  geometry.setAttribute('roomSize', new THREE.BufferAttribute(sizes, 2));
  return geometry;
}

function pushMallCollider(colliders, {
  name, cx, cz, sx, sz,
  topY = MALL_SHOP_H,
  surfaceClass = 'concrete',
}) {
  colliders.push({
    name,
    minX: cx - sx * 0.5,
    maxX: cx + sx * 0.5,
    minZ: cz - sz * 0.5,
    maxZ: cz + sz * 0.5,
    bottomY: FLOOR_Y,
    topY,
    surfaceClass,
    noGroundSnap: true,
  });
}

// ── Tracks ─────────────────────────────────────────────────────────────────

function buildTrack({ group, colliders, z, length, index }) {
  const halfLen = length * 0.5;
  // Ballast bed (wider shoulders)
  addBox({
    group,
    colliders: null,
    name: `Ballast ${index}`,
    cx: 0,
    cy: FLOOR_Y + 0.07,
    cz: z,
    sx: length + 2.0,
    sy: 0.18,
    sz: 3.9,
    material: ballastMat,
    collider: false,
    tileMeters: GRAVEL_TILE_M,
  });

  // Wood ties
  const tieSpacing = 0.58;
  const tieCount = Math.floor(length / tieSpacing);
  for (let i = 0; i < tieCount; i += 1) {
    const x = -halfLen + 0.35 + i * tieSpacing;
    addBox({
      group,
      colliders: null,
      name: `Tie ${index}_${i}`,
      cx: x,
      cy: FLOOR_Y + 0.15,
      cz: z,
      sx: 0.24,
      sy: 0.14,
      sz: 2.7,
      material: tieMat,
      collider: false,
      tileMeters: WOOD_TILE_M,
    });
  }

  // Twin rails — head + web suggestion via stacked boxes
  const gauge = 1.435;
  for (const side of [-1, 1]) {
    const railZ = z + side * (gauge * 0.5);
    addBox({
      group,
      colliders: null,
      name: `Rail Web ${index}_${side}`,
      cx: 0,
      cy: FLOOR_Y + 0.2,
      cz: railZ,
      sx: length,
      sy: 0.1,
      sz: 0.08,
      material: railMat,
      collider: false,
      tileMeters: METAL_TILE_M,
    });
    addBox({
      group,
      colliders: null,
      name: `Rail Head ${index}_${side}`,
      cx: 0,
      cy: FLOOR_Y + 0.28,
      cz: railZ,
      sx: length,
      sy: 0.07,
      sz: 0.13,
      material: railMat,
      collider: false,
      tileMeters: METAL_TILE_M,
    });
  }

  // Thin walkable pad (AI can cross; slight height).
  addBox({
    group,
    colliders,
    name: `Track Pad ${index}`,
    cx: 0,
    cy: FLOOR_Y + 0.04,
    cz: z,
    sx: length,
    sy: 0.08,
    sz: 3.0,
    material: ballastMat,
    collider: true,
    surfaceClass: 'dirt',
    tileMeters: GRAVEL_TILE_M,
  });
}

// ── Rolling stock ──────────────────────────────────────────────────────────

function addBoxcar({
  group,
  colliders,
  climbSurfaces = null,
  ledges = null,
  wallRunSurfaces = null,
  boxcarDoors = null,
  name,
  x,
  z,
  yaw = 0,
}) {
  const L = BOXCAR_L;
  const W = BOXCAR_W;
  const H = BOXCAR_H;
  const deck = DECK_Y;
  const wallT = 0.14;
  const root = new THREE.Group();
  root.name = name;
  root.position.set(x, FLOOR_Y, z);
  root.rotation.y = yaw;
  group.add(root);

  // Shell pieces (not one solid block) so the door bay is walkable when open.
  // Floor deck
  const floor = new THREE.Mesh(
    prepareBoxGeometry(L * 0.98, 0.16, W * 0.96, boxcarBodyMat, METAL_TILE_M),
    boxcarBodyMat,
  );
  floor.position.y = deck;
  floor.castShadow = true;
  floor.receiveShadow = true;
  root.add(floor);

  // Roof + roofwalk
  const roof = new THREE.Mesh(
    prepareBoxGeometry(L + 0.2, 0.18, W + 0.18, boxcarRoofMat, METAL_TILE_M),
    boxcarRoofMat,
  );
  roof.position.y = deck + H + 0.08;
  roof.castShadow = true;
  root.add(roof);
  const walk = new THREE.Mesh(
    prepareBoxGeometry(L * 0.9, 0.05, 0.38, tieMat, WOOD_TILE_M),
    tieMat,
  );
  walk.position.y = deck + H + 0.2;
  root.add(walk);

  // End walls (full height)
  for (const end of [-1, 1]) {
    const endWall = new THREE.Mesh(
      prepareBoxGeometry(wallT, H, W * 0.98, boxcarBodyMat, METAL_TILE_M),
      boxcarBodyMat,
    );
    endWall.position.set(end * (L * 0.5 - wallT * 0.5), deck + H * 0.5, 0);
    endWall.castShadow = true;
    root.add(endWall);
  }

  // Long side walls with door bay cutout (two segments per side).
  const bayHalf = DOOR_BAY * 0.5;
  const sideSegSpecs = [
    { x0: -L * 0.5, x1: -bayHalf },
    { x0: bayHalf, x1: L * 0.5 },
  ];
  for (const side of [-1, 1]) {
    for (const seg of sideSegSpecs) {
      const segL = seg.x1 - seg.x0;
      if (segL < 0.2) continue;
      const wall = new THREE.Mesh(
        prepareBoxGeometry(segL, H, wallT, boxcarBodyMat, METAL_TILE_M),
        boxcarBodyMat,
      );
      wall.position.set((seg.x0 + seg.x1) * 0.5, deck + H * 0.5, side * (W * 0.5 - wallT * 0.5));
      wall.castShadow = true;
      root.add(wall);
    }
  }

  // Side posts / ribs (skip door bay)
  const ribCount = 10;
  for (let i = 0; i < ribCount; i += 1) {
    const t = (i + 0.5) / ribCount;
    const rx = -L * 0.5 + t * L;
    if (Math.abs(rx) < bayHalf + 0.15) continue;
    for (const side of [-1, 1]) {
      const rib = new THREE.Mesh(
        prepareBoxGeometry(0.1, H * 0.92, 0.06, boxcarDoorMat, METAL_TILE_M),
        boxcarDoorMat,
      );
      rib.position.set(rx, deck + H * 0.5, side * (W * 0.5 + 0.03));
      rib.castShadow = true;
      root.add(rib);
    }
  }

  // Door tracks (static) — TOP only. A bottom rail sat ~0.23 m above the deck
  // and blocked jump-in through the open bay; keep the upper guide for look.
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      prepareBoxGeometry(DOOR_BAY + 2.8, 0.06, 0.05, railMat, METAL_TILE_M),
      railMat,
    );
    rail.position.set(0.4, deck + H * 0.5 + H * 0.42, side * (W * 0.5 + 0.12));
    root.add(rail);
  }

  // Interactive sliding doors (excluded from static merge).
  for (const side of [-1, 1]) {
    // Door hangs from the top track: leave clear air from the deck up so a jump
    // into the open bay is not blocked by a low rail / thick door bottom lip.
    const doorH = H * 0.82;
    const doorY = deck + 0.12 + doorH * 0.5;
    const door = new THREE.Mesh(
      prepareBoxGeometry(DOOR_PANEL_W, doorH, 0.1, boxcarDoorMat, METAL_TILE_M),
      boxcarDoorMat,
    );
    door.name = `${name} Door ${side > 0 ? 'N' : 'S'}`;
    // Keep out of static merge + geometry-index freeze so local position slides.
    door.userData.noStaticMerge = true;
    door.userData.skipLevelRaycast = true;
    door.matrixAutoUpdate = true;
    door.position.set(0.35, doorY, side * (W * 0.5 + 0.06));
    door.castShadow = true;
    root.add(door);

    const doorCollider = {
      name: door.name,
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      // Match raised door bottom so open/closed collider leaves deck clearance.
      bottomY: deck + 0.12,
      topY: deck + 0.12 + doorH,
      surfaceClass: 'metal',
      noGroundSnap: true,
      disabled: false,
    };
    colliders.push(doorCollider);
    syncDoorCollider(doorCollider, {
      carX: x,
      carZ: z,
      yaw,
      localX: 0.35,
      localZ: side * (W * 0.5 + 0.06),
      sx: DOOR_PANEL_W,
      sz: 0.18,
    });

    boxcarDoors?.push({
      id: door.name,
      mesh: door,
      side,
      carX: x,
      carZ: z,
      yaw,
      closedLocalX: 0.35,
      openLocalX: 0.35 + DOOR_SLIDE,
      localZ: side * (W * 0.5 + 0.06),
      open: false,
      openAmount: 0,
      collider: doorCollider,
      panelW: DOOR_PANEL_W,
    });
  }

  // End ladders + brake wheel
  for (const end of [-1, 1]) {
    for (let r = 0; r < 7; r += 1) {
      const rung = new THREE.Mesh(
        prepareBoxGeometry(0.06, 0.05, 0.55, railMat, METAL_TILE_M),
        railMat,
      );
      rung.position.set(end * (L * 0.5 + 0.08), deck + 0.45 + r * 0.48, W * 0.5 - 0.2);
      root.add(rung);
    }
    for (const lz of [W * 0.5 - 0.45, W * 0.5 + 0.05]) {
      const stile = new THREE.Mesh(
        prepareBoxGeometry(0.05, H * 0.9, 0.05, railMat, METAL_TILE_M),
        railMat,
      );
      stile.position.set(end * (L * 0.5 + 0.08), deck + H * 0.48, lz);
      root.add(stile);
    }
  }

  const brake = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 6, 12), railMat);
  brake.position.set(L * 0.5 + 0.12, deck + H * 0.72, -W * 0.28);
  brake.rotation.y = Math.PI * 0.5;
  root.add(brake);

  for (const end of [-1, 1]) {
    const coupler = new THREE.Mesh(
      prepareBoxGeometry(0.45, 0.28, 0.28, tankChassisMat, METAL_TILE_M),
      tankChassisMat,
    );
    coupler.position.set(end * (L * 0.5 + 0.22), deck * 0.55, 0);
    root.add(coupler);
  }

  const frame = new THREE.Mesh(
    prepareBoxGeometry(L * 0.98, 0.26, W * 0.78, tankChassisMat, METAL_TILE_M),
    tankChassisMat,
  );
  frame.position.y = deck * 0.55;
  root.add(frame);
  for (const cx of [-L * 0.22, 0, L * 0.22]) {
    const cross = new THREE.Mesh(
      prepareBoxGeometry(0.14, 0.18, W * 0.82, tankChassisMat, METAL_TILE_M),
      tankChassisMat,
    );
    cross.position.set(cx, deck * 0.5, 0);
    root.add(cross);
  }

  addBogiePair(root, L, W, deck);

  // Hollow shell colliders (floor / roof / ends / side segments). Ends inset so
  // coupler pockets stay jumpable between cars.
  pushBoxcarShellColliders({
    colliders,
    name,
    x,
    z,
    yaw,
    L,
    W,
    H,
    deck,
    wallT,
    bayHalf,
  });

  if (climbSurfaces || ledges || wallRunSurfaces) {
    registerCarTraversal({
      climbSurfaces,
      ledges,
      wallRunSurfaces,
      name,
      x,
      z,
      yaw,
      L,
      W,
      H,
      deck,
      kind: 'boxcar',
    });
  }
}

function addTankCar({
  group,
  colliders,
  climbSurfaces = null,
  ledges = null,
  wallRunSurfaces = null,
  name,
  x,
  z,
  yaw = 0,
}) {
  const L = TANK_L;
  const W = TANK_W;
  const tankR = TANK_R;
  const deck = DECK_Y;
  const root = new THREE.Group();
  root.name = name;
  root.position.set(x, FLOOR_Y, z);
  root.rotation.y = yaw;
  group.add(root);

  // Chassis / sill
  const chassis = new THREE.Mesh(
    prepareBoxGeometry(L * 0.94, 0.3, W * 0.7, tankChassisMat, METAL_TILE_M),
    tankChassisMat,
  );
  chassis.position.y = deck * 0.55;
  chassis.castShadow = true;
  root.add(chassis);

  // Tank saddles
  for (const sx of [-L * 0.22, L * 0.22]) {
    const saddle = new THREE.Mesh(
      prepareBoxGeometry(1.1, 0.55, W * 0.75, tankChassisMat, METAL_TILE_M),
      tankChassisMat,
    );
    saddle.position.set(sx, deck * 0.7, 0);
    root.add(saddle);
  }

  const tankY = deck + tankR + 0.08;
  const tank = new THREE.Mesh(
    new THREE.CylinderGeometry(tankR, tankR, L * 0.78, 20, 1, false),
    tankShellMat,
  );
  tank.rotation.z = Math.PI * 0.5;
  tank.position.y = tankY;
  tank.castShadow = true;
  tank.receiveShadow = true;
  stampCylinderUv2(tank.geometry);
  root.add(tank);

  // End domes
  for (const side of [-1, 1]) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(tankR * 0.99, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
      tankShellMat,
    );
    dome.rotation.z = side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
    dome.position.set(side * (L * 0.39), tankY, 0);
    dome.castShadow = true;
    root.add(dome);
  }

  // Hoop bands
  for (const t of [-0.35, -0.12, 0.12, 0.35]) {
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(tankR + 0.04, 0.055, 6, 18),
      tankBandMat,
    );
    band.rotation.y = Math.PI * 0.5;
    band.position.set(t * L * 0.5, tankY, 0);
    root.add(band);
  }

  // Top catwalk + handrail posts
  const catwalk = new THREE.Mesh(
    prepareBoxGeometry(L * 0.55, 0.06, 0.55, tankBandMat, METAL_TILE_M),
    tankBandMat,
  );
  catwalk.position.set(0, tankY + tankR + 0.05, 0);
  root.add(catwalk);
  for (const hx of [-L * 0.2, 0, L * 0.2]) {
    for (const hz of [-0.22, 0.22]) {
      const post = new THREE.Mesh(
        prepareBoxGeometry(0.04, 0.55, 0.04, railMat, METAL_TILE_M),
        railMat,
      );
      post.position.set(hx, tankY + tankR + 0.32, hz);
      root.add(post);
    }
  }
  // Handrail rails
  for (const hz of [-0.22, 0.22]) {
    const rail = new THREE.Mesh(
      prepareBoxGeometry(L * 0.5, 0.04, 0.04, railMat, METAL_TILE_M),
      railMat,
    );
    rail.position.set(0, tankY + tankR + 0.55, hz);
    root.add(rail);
  }

  // Manway
  const manway = new THREE.Mesh(
    new THREE.CylinderGeometry(0.38, 0.38, 0.4, 12),
    tankBandMat,
  );
  manway.position.set(0.6, tankY + tankR + 0.15, 0);
  root.add(manway);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.08, 12), railMat);
  lid.position.set(0.6, tankY + tankR + 0.38, 0);
  root.add(lid);

  // Side ladder on the +Z face — rungs run along car length (X), stiles up Y.
  const ladderH = tankY + tankR - deck;
  for (const stileX of [L * 0.12 - 0.22, L * 0.12 + 0.22]) {
    const stile = new THREE.Mesh(
      prepareBoxGeometry(0.05, ladderH * 0.9, 0.05, railMat, METAL_TILE_M),
      railMat,
    );
    stile.position.set(stileX, deck + ladderH * 0.45, W * 0.5 + 0.06);
    root.add(stile);
  }
  for (let r = 0; r < 6; r += 1) {
    const rung = new THREE.Mesh(
      prepareBoxGeometry(0.5, 0.05, 0.06, railMat, METAL_TILE_M),
      railMat,
    );
    rung.position.set(L * 0.12, deck + 0.35 + r * 0.42, W * 0.5 + 0.06);
    root.add(rung);
  }

  // End platforms
  for (const end of [-1, 1]) {
    const platform = new THREE.Mesh(
      prepareBoxGeometry(0.55, 0.08, W * 0.85, tankChassisMat, METAL_TILE_M),
      tankChassisMat,
    );
    platform.position.set(end * (L * 0.48), deck + 0.05, 0);
    root.add(platform);
  }

  // Couplers
  for (const end of [-1, 1]) {
    const coupler = new THREE.Mesh(
      prepareBoxGeometry(0.45, 0.26, 0.26, tankChassisMat, METAL_TILE_M),
      tankChassisMat,
    );
    coupler.position.set(end * (L * 0.5 + 0.2), deck * 0.55, 0);
    root.add(coupler);
  }

  // Outlet valve under center
  const valve = new THREE.Mesh(
    prepareBoxGeometry(0.35, 0.35, 0.35, railMat, METAL_TILE_M),
    railMat,
  );
  valve.position.set(0, deck * 0.35, 0);
  root.add(valve);

  addBogiePair(root, L, W, deck);

  // Shorter than visual length so coupler gaps stay passable.
  pushOrientedCollider(colliders, {
    name,
    x,
    z,
    yaw,
    sx: L - COLLIDER_END_INSET * 2,
    sy: tankY + tankR + 0.3,
    sz: tankR * 2.15,
    bottomY: FLOOR_Y,
    surfaceClass: 'metal',
  });

  if (climbSurfaces || ledges || wallRunSurfaces) {
    registerCarTraversal({
      climbSurfaces,
      ledges,
      wallRunSurfaces,
      name,
      x,
      z,
      yaw,
      L,
      W: tankR * 2.1,
      H: tankY + tankR - deck,
      deck,
      kind: 'tank',
    });
  }
}

/**
 * Twin-axle freight trucks. Car runs along local +X; axles along local +Z.
 * CylinderGeometry defaults to +Y — rotate X 90° so disks face along the track.
 */
function addBogiePair(root, L, W, deck) {
  for (const bogieX of [-L * 0.32, L * 0.32]) {
    const sideframe = new THREE.Mesh(
      prepareBoxGeometry(1.7, 0.28, W * 0.72, tankChassisMat, METAL_TILE_M),
      tankChassisMat,
    );
    sideframe.position.set(bogieX, 0.42, 0);
    root.add(sideframe);
    for (const axleX of [-0.48, 0.48]) {
      for (const wheelZ of [-W * 0.3, W * 0.3]) {
        const wheel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.4, 0.4, 0.24, 12),
          railMat,
        );
        // Axis along car width (Z) so the tread rolls on rails under X-travel.
        wheel.rotation.x = Math.PI * 0.5;
        wheel.position.set(bogieX + axleX, 0.4, wheelZ);
        wheel.castShadow = true;
        root.add(wheel);
      }
      const axle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.06, 0.06, W * 0.62, 6),
        railMat,
      );
      axle.rotation.x = Math.PI * 0.5;
      axle.position.set(bogieX + axleX, 0.4, 0);
      root.add(axle);
    }
  }
  void deck;
}

/**
 * Floor / roof / ends / side walls with door bay open.
 *
 * CRITICAL: deck floor is a **thin plate at deck height**, not a solid block from
 * gravel to deck. A full-height floor AABB was a ~1.3 m wall across the open door
 * bay and blocked jump-in / mantle onto the car.
 */
function pushBoxcarShellColliders({
  colliders,
  name,
  x,
  z,
  yaw,
  L,
  W,
  H,
  deck,
  wallT,
  bayHalf,
}) {
  const bodyLen = L - COLLIDER_END_INSET * 2;
  // Thin standable deck (top ≈ deck + 0.1). Ground→deck approach is clear at bays.
  pushOrientedCollider(colliders, {
    name: `${name} Floor`,
    x,
    z,
    yaw,
    sx: bodyLen,
    sy: 0.18,
    sz: W * 0.96,
    bottomY: deck - 0.08,
    surfaceClass: 'metal',
    allowGroundSnap: true,
  });
  // Narrow undercarriage so you cannot walk fully under the car, but the door
  // bay approach (outer half-width) stays open for jump-in.
  pushOrientedCollider(colliders, {
    name: `${name} Undercarriage`,
    x,
    z,
    yaw,
    sx: bodyLen * 0.92,
    sy: Math.max(0.35, deck - 0.35),
    sz: W * 0.42,
    bottomY: FLOOR_Y + 0.12,
    surfaceClass: 'metal',
  });
  // Roof
  pushOrientedCollider(colliders, {
    name: `${name} Roof`,
    x,
    z,
    yaw,
    sx: bodyLen,
    sy: 0.28,
    sz: W + 0.1,
    bottomY: deck + H,
    surfaceClass: 'metal',
    allowGroundSnap: true,
  });
  // Ends (from deck up — not through gravel; undercarriage covers lower center)
  for (const end of [-1, 1]) {
    const endLocalX = end * (L * 0.5 - wallT * 0.5 - COLLIDER_END_INSET * 0.25);
    const wx = x + Math.cos(yaw) * endLocalX;
    const wz = z + Math.sin(yaw) * endLocalX;
    pushOrientedCollider(colliders, {
      name: `${name} End ${end > 0 ? 'E' : 'W'}`,
      x: wx,
      z: wz,
      yaw,
      sx: wallT + 0.08,
      sy: H,
      sz: W * 0.98,
      bottomY: deck,
      surfaceClass: 'metal',
    });
  }
  // Side wall segments (door bay open) — from deck up only
  const segs = [
    { x0: -L * 0.5 + COLLIDER_END_INSET, x1: -bayHalf },
    { x0: bayHalf, x1: L * 0.5 - COLLIDER_END_INSET },
  ];
  for (const side of [-1, 1]) {
    for (const seg of segs) {
      const segL = seg.x1 - seg.x0;
      if (segL < 0.25) continue;
      const midLocalX = (seg.x0 + seg.x1) * 0.5;
      const localZ = side * (W * 0.5 - wallT * 0.5);
      const wx = x + Math.cos(yaw) * midLocalX - Math.sin(yaw) * localZ;
      const wz = z + Math.sin(yaw) * midLocalX + Math.cos(yaw) * localZ;
      pushOrientedCollider(colliders, {
        name: `${name} Side ${side > 0 ? 'N' : 'S'}`,
        x: wx,
        z: wz,
        yaw,
        sx: segL,
        sy: H,
        sz: wallT + 0.06,
        bottomY: deck,
        surfaceClass: 'metal',
      });
    }
  }
}

function syncDoorCollider(collider, { carX, carZ, yaw, localX, localZ, sx, sz }) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const wx = carX + c * localX - s * localZ;
  const wz = carZ + s * localX + c * localZ;
  const halfX = (Math.abs(c) * sx + Math.abs(s) * sz) * 0.5;
  const halfZ = (Math.abs(s) * sx + Math.abs(c) * sz) * 0.5;
  collider.minX = wx - halfX;
  collider.maxX = wx + halfX;
  collider.minZ = wz - halfZ;
  collider.maxZ = wz + halfZ;
}

function doorWorldXZ(door, localX = door.closedLocalX) {
  const c = Math.cos(door.yaw);
  const s = Math.sin(door.yaw);
  return {
    x: door.carX + c * localX - s * door.localZ,
    z: door.carZ + s * localX + c * door.localZ,
  };
}

/**
 * @returns {{ changed:boolean }} whether any door crossed the open/closed threshold
 *   (for nav dynamic-obstacle + flow restamp).
 */
function updateBoxcarDoors({ doors, delta, playerPosition, mountPressed }) {
  if (!doors?.length) return { changed: false };

  if (mountPressed && playerPosition) {
    let best = null;
    let bestDist = DOOR_INTERACT_RADIUS;
    for (const door of doors) {
      // Use authored car transform — not mesh.matrixWorld (may be frozen/stale).
      const world = doorWorldXZ(door, THREE.MathUtils.lerp(
        door.closedLocalX,
        door.openLocalX,
        door.openAmount,
      ));
      const d = Math.hypot(world.x - playerPosition.x, world.z - playerPosition.z);
      if (d < bestDist) {
        bestDist = d;
        best = door;
      }
    }
    if (best) best.open = !best.open;
  }

  const speed = 2.8;
  let changed = false;
  for (const door of doors) {
    // Ensure geometry-index freeze never sticks on interactive doors.
    if (door.mesh.matrixAutoUpdate === false) door.mesh.matrixAutoUpdate = true;
    if (door.mesh.matrixWorldAutoUpdate === false) door.mesh.matrixWorldAutoUpdate = true;
    if (door.mesh.static) door.mesh.static = false;

    const wasBlocking = !(door.openAmount > 0.85);
    const target = door.open ? 1 : 0;
    if (Math.abs(door.openAmount - target) < 0.001) {
      door.openAmount = target;
    } else {
      door.openAmount += Math.sign(target - door.openAmount) * Math.min(
        Math.abs(target - door.openAmount),
        speed * Math.max(0, delta),
      );
    }
    const localX = THREE.MathUtils.lerp(door.closedLocalX, door.openLocalX, door.openAmount);
    door.mesh.position.x = localX;
    door.mesh.updateMatrix();
    door.mesh.updateMatrixWorld(true);
    syncDoorCollider(door.collider, {
      carX: door.carX,
      carZ: door.carZ,
      yaw: door.yaw,
      localX,
      localZ: door.localZ,
      sx: door.panelW,
      sz: 0.18,
    });
    // Fully open → disable block so you can pass through the bay.
    door.collider.disabled = door.openAmount > 0.85;
    const isBlocking = !(door.openAmount > 0.85);
    if (isBlocking !== wasBlocking) changed = true;
  }
  return { changed };
}

/**
 * Place a few propane tank pickups near the mall spawn and one by the shipping
 * corridor so the player can grab one without hunting the yard.
 * @returns {ReturnType<typeof createPropaneTank>[]}
 */
function placePropaneTanks({ group }) {
  const spots = [
    // A few steps east of mall-center spawn, easy first grab.
    { x: MALL_CENTER_X + 3.2, z: 2.4, yaw: 0.35, seed: 1 },
    { x: MALL_CENTER_X - 4.5, z: -3.1, yaw: -0.6, seed: 2 },
    // Shipping vestibule — mid route toward the yard.
    { x: (SHIPPING_X0 + SHIPPING_X1) * 0.5, z: 1.8, yaw: 0.2, seed: 3 },
  ];
  const tanks = [];
  for (const spot of spots) {
    const tank = createPropaneTank({ seed: spot.seed });
    tank.group.position.set(spot.x, FLOOR_Y, spot.z);
    tank.group.rotation.y = spot.yaw;
    tank.group.userData.noStaticMerge = true;
    group.add(tank.group);
    tanks.push(tank);
  }
  return tanks;
}

/** Yard dressing: sheds, poles, drums, pallets, switch stands. */
function addYardDetails({ group, colliders, ledges = null, wallRunSurfaces = null }) {
  // Brick utility sheds
  for (const [cx, cz] of [[-HALF + 5.5, -HALF + 5.5], [HALF - 5.5, HALF - 5.5]]) {
    const shedName = `Cover Shed ${cx}`;
    const sx = 6.2;
    const sy = 3.4;
    const sz = 4.6;
    const roofY = FLOOR_Y + 3.55 + 0.14;
    addBox({
      group,
      colliders,
      name: shedName,
      cx,
      cy: FLOOR_Y + 1.7,
      cz,
      sx,
      sy,
      sz,
      material: shedMat,
      collider: true,
      surfaceClass: 'concrete',
      tileMeters: WALL_TILE_M,
    });
    addBox({
      group,
      colliders,
      name: `Cover Shed Roof ${cx}`,
      cx,
      cy: FLOOR_Y + 3.55,
      cz,
      sx: 6.6,
      sy: 0.28,
      sz: 5.0,
      material: boxcarRoofMat,
      collider: true,
      noGroundSnap: true,
      surfaceClass: 'metal',
      tileMeters: METAL_TILE_M,
    });
    registerAxisAlignedBuildingTraversal({
      ledges,
      wallRunSurfaces,
      name: shedName,
      cx,
      cz,
      halfX: sx * 0.5,
      halfZ: sz * 0.5,
      bottomY: FLOOR_Y,
      topY: roofY,
      wallRunMaxV: 2.6,
    });
  }

  // Oil drums clusters
  const drumSpots = [
    [-26, -16], [-26, 4], [26, -8], [26, 14], [8, -16.5], [-10, 16.5],
  ];
  let di = 0;
  for (const [dx, dz] of drumSpots) {
    for (let i = 0; i < 3; i += 1) {
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 0.9, 10),
        i % 2 === 0 ? accentMat : tankBandMat,
      );
      drum.position.set(dx + (i % 2) * 0.7, FLOOR_Y + 0.45, dz + Math.floor(i / 2) * 0.7);
      drum.castShadow = true;
      drum.name = `Drum ${di++}`;
      group.add(drum);
    }
  }

  // Pallet stacks (cover)
  for (const [px, pz] of [[-18, 5.5], [14, -5.5], [4, 16.5], [-6, -16.5]]) {
    addBox({
      group,
      colliders,
      name: `Cover Pallets ${px}`,
      cx: px,
      cy: FLOOR_Y + 0.7,
      cz: pz,
      sx: 1.4,
      sy: 1.4,
      sz: 1.2,
      material: tieMat,
      collider: true,
      surfaceClass: 'wood',
      tileMeters: WOOD_TILE_M,
    });
  }

  // Switch stands at track ends
  for (const z of TRACK_Z) {
    for (const x of [-HALF + 3.5, HALF - 3.5]) {
      addBox({
        group,
        colliders: null,
        name: `Switch Stand ${x}_${z}`,
        cx: x,
        cy: FLOOR_Y + 0.55,
        cz: z + 1.8,
        sx: 0.25,
        sy: 1.1,
        sz: 0.25,
        material: accentMat,
        collider: false,
        tileMeters: METAL_TILE_M,
      });
      addBox({
        group,
        colliders: null,
        name: `Switch Target ${x}_${z}`,
        cx: x,
        cy: FLOOR_Y + 1.35,
        cz: z + 1.8,
        sx: 0.35,
        sy: 0.45,
        sz: 0.08,
        material: accentMat,
        collider: false,
        tileMeters: METAL_TILE_M,
      });
    }
  }

  // Corner signal masts
  for (const [cx, cz] of [
    [-HALF + 1.5, -HALF + 1.5],
    [HALF - 1.5, -HALF + 1.5],
    [-HALF + 1.5, HALF - 1.5],
    [HALF - 1.5, HALF - 1.5],
  ]) {
    addBox({
      group,
      colliders,
      name: 'Signal Post',
      cx,
      cy: FLOOR_Y + 3.2,
      cz,
      sx: 0.32,
      sy: 6.4,
      sz: 0.32,
      material: accentMat,
      collider: true,
      noGroundSnap: true,
      surfaceClass: 'metal',
      tileMeters: METAL_TILE_M,
    });
    // Signal heads
    for (const hy of [5.2, 5.9, 6.6]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), accentMat);
      lamp.position.set(cx, FLOOR_Y + hy, cz + 0.25);
      group.add(lamp);
    }
  }

  // Cable reels
  for (const [rx, rz] of [[-24, 16.5], [22, -16.5]]) {
    const reel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.85, 0.7, 14),
      tieMat,
    );
    reel.rotation.z = Math.PI * 0.5;
    reel.position.set(rx, FLOOR_Y + 0.85, rz);
    reel.castShadow = true;
    group.add(reel);
  }
}

const _yUp = new THREE.Vector3(0, 1, 0);
const _tmpLocal = new THREE.Vector3();
const _tmpWorld = new THREE.Vector3();

/**
 * Hang ledges, wall-run strips, and ladder climb planes on rolling stock.
 * Climb surfaces use the city wall-climb contract so WallClimbSystem hands off
 * to the matching roof ledge for a fast mantle.
 */
function registerCarTraversal({
  climbSurfaces = null,
  ledges = null,
  wallRunSurfaces = null,
  name,
  x,
  z,
  yaw,
  L,
  W,
  H,
  deck,
  kind = 'boxcar',
}) {
  const roofY = deck + H + (kind === 'tank' ? 0.05 : 0.12);
  const shelfDepth = Math.max(0.85, W * 0.48);

  // Roof hang points on all four edges.
  if (ledges) {
    // Ends (east / west)
    for (const end of [-1, 1]) {
      const face = end > 0 ? 'east' : 'west';
      const normal = new THREE.Vector3(end, 0, 0).applyAxisAngle(_yUp, yaw).normalize();
      const tangent = new THREE.Vector3(0, 0, 1).applyAxisAngle(_yUp, yaw).normalize();
      pushRoofEdgeLedge({
        ledges,
        name: `${name} ${face} Roof Ledge`,
        blockName: name,
        face,
        carX: x,
        carZ: z,
        yaw,
        localEdgeX: end * (L * 0.5 + 0.04),
        localAlongMin: -W * 0.42,
        localAlongMax: W * 0.42,
        localAlongAxis: 'z',
        roofY,
        normal,
        tangent,
        shelfDepth,
      });
    }
    // Long sides (north / south) — roof
    for (const side of [-1, 1]) {
      const face = side > 0 ? 'north' : 'south';
      const normal = new THREE.Vector3(0, 0, side).applyAxisAngle(_yUp, yaw).normalize();
      const tangent = new THREE.Vector3(1, 0, 0).applyAxisAngle(_yUp, yaw).normalize();
      pushRoofEdgeLedge({
        ledges,
        name: `${name} ${face} Roof Ledge`,
        blockName: name,
        face,
        carX: x,
        carZ: z,
        yaw,
        localEdgeZ: side * (W * 0.5 + 0.04),
        localAlongMin: -L * 0.46,
        localAlongMax: L * 0.46,
        localAlongAxis: 'x',
        roofY,
        normal,
        tangent,
        shelfDepth,
      });
    }

    // Door-bay deck sills: hang/mantle edges at deck height (DECK_Y is sized for
    // the grab window). Lets the player climb through an open door instead of
    // snagging on the floor AABB lip.
    if (kind === 'boxcar') {
      const bayHalf = DOOR_BAY * 0.5;
      // Lip slightly above deck collider top so the hang plane is clean.
      const deckLipY = deck + 0.06;
      for (const side of [-1, 1]) {
        const face = side > 0 ? 'north' : 'south';
        const normal = new THREE.Vector3(0, 0, side).applyAxisAngle(_yUp, yaw).normalize();
        const tangent = new THREE.Vector3(1, 0, 0).applyAxisAngle(_yUp, yaw).normalize();
        pushRoofEdgeLedge({
          ledges,
          name: `${name} ${face} Door Sill Ledge`,
          blockName: name,
          face,
          carX: x,
          carZ: z,
          yaw,
          // Outside the side wall so hang probes hit before the floor AABB lip.
          localEdgeZ: side * (W * 0.5 + 0.08),
          localAlongMin: -bayHalf + 0.2,
          localAlongMax: bayHalf - 0.2,
          localAlongAxis: 'x',
          roofY: deckLipY,
          normal,
          tangent,
          // Deep enough to plant feet on the deck after top-out.
          shelfDepth: Math.max(1.2, W * 0.6),
        });
      }
    }
  }

  // Ladder climb planes → matching roof ledge handoff.
  if (climbSurfaces) {
    const bottomY = 0.32;
    const climbHeight = roofY - bottomY;

    if (kind === 'boxcar') {
      // Visual end ladders sit on the +Z corner of each end.
      const ladderZMin = W * 0.5 - 0.55;
      const ladderZMax = W * 0.5 + 0.12;
      const ladderWidth = ladderZMax - ladderZMin;

      for (const end of [-1, 1]) {
        const face = end > 0 ? 'east' : 'west';
        const ledgeName = `${name} ${face} Roof Ledge`;
        const normal = new THREE.Vector3(end, 0, 0).applyAxisAngle(_yUp, yaw).normalize();
        const tangent = new THREE.Vector3(0, 0, 1).applyAxisAngle(_yUp, yaw).normalize();

        _tmpLocal.set(end * (L * 0.5 + 0.1), bottomY, ladderZMin);
        _tmpLocal.applyAxisAngle(_yUp, yaw);
        climbSurfaces.push({
          name: `${name} ${face} Ladder`,
          blockName: name,
          face,
          origin: { x: x + _tmpLocal.x, y: bottomY, z: z + _tmpLocal.z },
          normal: { x: normal.x, y: 0, z: normal.z },
          tangent: { x: tangent.x, y: 0, z: tangent.z },
          up: { x: 0, y: 1, z: 0 },
          minU: 0,
          maxU: ladderWidth,
          minV: 0,
          maxV: climbHeight,
          rootOffset: 0.4,
          // Freight ladders are short routes — 3× default wall-climb so summiting feels snappy.
          climbSpeedScale: 3,
          targetLedgeName: ledgeName,
        });
      }
    } else if (kind === 'tank') {
      // Visual side ladder on the +Z (north) face, centered near L * 0.12.
      const face = 'north';
      const ledgeName = `${name} ${face} Roof Ledge`;
      const ladderXMin = L * 0.12 - 0.28;
      const ladderXMax = L * 0.12 + 0.28;
      const ladderWidth = ladderXMax - ladderXMin;
      const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(_yUp, yaw).normalize();
      const tangent = new THREE.Vector3(1, 0, 0).applyAxisAngle(_yUp, yaw).normalize();

      _tmpLocal.set(ladderXMin, bottomY, W * 0.5 + 0.08);
      _tmpLocal.applyAxisAngle(_yUp, yaw);
      climbSurfaces.push({
        name: `${name} ${face} Ladder`,
        blockName: name,
        face,
        origin: { x: x + _tmpLocal.x, y: bottomY, z: z + _tmpLocal.z },
        normal: { x: normal.x, y: 0, z: normal.z },
        tangent: { x: tangent.x, y: 0, z: tangent.z },
        up: { x: 0, y: 1, z: 0 },
        minU: 0,
        maxU: ladderWidth,
        minV: 0,
        maxV: climbHeight,
        rootOffset: 0.4,
        climbSpeedScale: 3,
        targetLedgeName: ledgeName,
      });
    }
  }

  // Wall-run strips along the long sides. For boxcars, split around the door bay
  // so an airborne jump into an open door is NOT stolen by wall-run attach (bounce).
  if (wallRunSurfaces) {
    const bayHalf = kind === 'boxcar' ? DOOR_BAY * 0.5 + 0.35 : 0;
    // Local-X segments along the face (origin at local X = -L*0.46 → u=0).
    const faceHalf = L * 0.46;
    const segments = kind === 'boxcar'
      ? [
        // Left of bay
        { u0: 0.1, u1: Math.max(0.2, faceHalf - bayHalf - 0.15) },
        // Right of bay
        { u0: faceHalf + bayHalf + 0.15, u1: L * 0.92 },
      ].filter((seg) => seg.u1 - seg.u0 > 0.8)
      : [{ u0: 0.15, u1: L * 0.92 }];

    for (const side of [-1, 1]) {
      const face = side > 0 ? 'north' : 'south';
      const normal = new THREE.Vector3(0, 0, side).applyAxisAngle(_yUp, yaw).normalize();
      const tangent = new THREE.Vector3(1, 0, 0).applyAxisAngle(_yUp, yaw).normalize();
      // Origin: bottom-left of the run band looking at the face (local X = -L*0.46).
      _tmpLocal.set(-L * 0.46, 0.75, side * (W * 0.5 + 0.05));
      _tmpLocal.applyAxisAngle(_yUp, yaw);
      const origin = { x: x + _tmpLocal.x, y: 0.75, z: z + _tmpLocal.z };
      let segIndex = 0;
      for (const seg of segments) {
        wallRunSurfaces.push({
          name: `${name} ${face} Wall Run${segments.length > 1 ? ` ${segIndex}` : ''}`,
          blockName: name,
          face,
          origin,
          normal: { x: normal.x, y: 0, z: normal.z },
          tangent: { x: tangent.x, y: 0, z: tangent.z },
          up: { x: 0, y: 1, z: 0 },
          minU: seg.u0,
          maxU: seg.u1,
          minV: 0,
          maxV: Math.min(2.85, Math.max(1.6, H * 0.72)),
          rootOffset: 0.38,
          handYOffset: 1.15,
          handForwardOffset: -0.22,
          handNormalOffset: 0.02,
        });
        segIndex += 1;
      }
    }
  }

  void _tmpWorld;
}

/**
 * World-space roof edge hang ledge from local car coordinates.
 * localAlongAxis 'x' means the edge runs along local X (long side);
 * 'z' means the edge runs along local Z (end).
 */
function pushRoofEdgeLedge({
  ledges,
  name,
  blockName,
  face,
  carX,
  carZ,
  yaw,
  localEdgeX = 0,
  localEdgeZ = 0,
  localAlongMin,
  localAlongMax,
  localAlongAxis,
  roofY,
  normal,
  tangent,
  shelfDepth,
}) {
  const samples = [localAlongMin, localAlongMax];
  const worldAlong = [];
  for (const a of samples) {
    if (localAlongAxis === 'x') {
      _tmpLocal.set(a, roofY, localEdgeZ);
    } else {
      _tmpLocal.set(localEdgeX, roofY, a);
    }
    _tmpLocal.applyAxisAngle(_yUp, yaw);
    worldAlong.push({
      x: carX + _tmpLocal.x,
      z: carZ + _tmpLocal.z,
    });
  }

  // Midpoint of edge for fixed coordinate.
  if (localAlongAxis === 'x') {
    _tmpLocal.set(0, roofY, localEdgeZ);
  } else {
    _tmpLocal.set(localEdgeX, roofY, 0);
  }
  _tmpLocal.applyAxisAngle(_yUp, yaw);
  const edgeX = carX + _tmpLocal.x;
  const edgeZ = carZ + _tmpLocal.z;

  const alongAxis = Math.abs(tangent.x) > Math.abs(tangent.z) ? 'x' : 'z';
  const a0 = alongAxis === 'x' ? worldAlong[0].x : worldAlong[0].z;
  const a1 = alongAxis === 'x' ? worldAlong[1].x : worldAlong[1].z;
  const min = Math.min(a0, a1);
  const max = Math.max(a0, a1);
  // Door sills are short (~2.5 m); roof edges need a longer span.
  const minSpan = /Door Sill/i.test(name) ? 0.85 : 1.2;
  if (max - min < minSpan) return;

  ledges.push({
    name,
    blockName,
    face,
    hangMode: 'braced',
    axis: alongAxis,
    min,
    max,
    y: roofY,
    x: alongAxis === 'z' ? edgeX : 0,
    z: alongAxis === 'x' ? edgeZ : 0,
    normal: { x: normal.x, y: 0, z: normal.z },
    tangent: { x: tangent.x, y: 0, z: tangent.z },
    shelfDepth,
    snapPoints: createSimpleSnapPoints({
      axis: alongAxis,
      min,
      max,
      y: roofY,
      x: edgeX,
      z: edgeZ,
      normal,
      tangent,
    }),
  });
}

function createSimpleSnapPoints({ axis, min, max, y, x, z, normal, tangent }) {
  const span = max - min;
  const count = Math.max(2, Math.floor(span / 0.85) + 1);
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const alpha = count === 1 ? 0.5 : i / (count - 1);
    const along = THREE.MathUtils.lerp(min + 0.12, max - 0.12, alpha);
    points.push({
      along,
      x: axis === 'x' ? along : x,
      y,
      z: axis === 'z' ? along : z,
      normal: { x: normal.x, y: 0, z: normal.z },
      tangent: { x: tangent.x, y: 0, z: tangent.z },
    });
  }
  return points;
}

/**
 * Axis-aligned collider for a yawed prop (uses max extent AABB — fine for AI cover).
 */
function pushOrientedCollider(colliders, {
  name, x, z, yaw, sx, sy, sz, bottomY, surfaceClass,
  allowGroundSnap = false,
}) {
  if (!colliders) return;
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  const halfX = (sx * c + sz * s) * 0.5;
  const halfZ = (sx * s + sz * c) * 0.5;
  colliders.push({
    name,
    minX: x - halfX,
    maxX: x + halfX,
    minZ: z - halfZ,
    maxZ: z + halfZ,
    bottomY,
    topY: bottomY + sy,
    surfaceClass: surfaceClass ?? 'metal',
    // Decks/roofs need ground snap so you can stand after jump/mantle.
    noGroundSnap: !allowGroundSnap,
  });
}

// ── Perimeter (gates) ──────────────────────────────────────────────────────

function buildPerimeter({ group, colliders, ledges = null, wallRunSurfaces = null }) {
  const sides = [
    { side: 'north', axis: 'x', fixed: HALF, inward: -1 },
    { side: 'south', axis: 'x', fixed: -HALF, inward: 1 },
    { side: 'east', axis: 'z', fixed: HALF, inward: -1 },
    { side: 'west', axis: 'z', fixed: -HALF, inward: 1 },
  ];

  for (const side of sides) {
    const gates = GATE_SPECS.filter((g) => g.side === side.side);
    const gateCentres = buildSideGateCentres(side.side, gates.length);
    const openings = gateCentres
      .map((c) => ({ centre: c, half: GATE_W * 0.5, kind: 'spawn-gate' }));
    // The mall shipping hall meets the middle of the west wall. This opening
    // is wider than a spawn gate so the mob can compress through it without
    // snagging, and its raised shutter/frame is authored with the mall.
    if (side.side === 'west') {
      openings.push({ centre: 0, half: SHIPPING_HALF_W, kind: 'shipping' });
    }
    openings.sort((a, b) => a.centre - b.centre);

    let cursor = -HALF;
    const end = HALF;
    const solidSpans = [];
    for (const open of openings) {
      const openMin = open.centre - open.half;
      const openMax = open.centre + open.half;
      if (openMin > cursor + 0.05) {
        solidSpans.push({ from: cursor, to: openMin });
        addWallSegment({ group, colliders, side, from: cursor, to: openMin });
      }
      if (open.kind === 'spawn-gate') {
        addGate({ group, colliders, side, centre: open.centre });
      }
      cursor = openMax;
    }
    if (end > cursor + 0.05) {
      solidSpans.push({ from: cursor, to: end });
      addWallSegment({ group, colliders, side, from: cursor, to: end });
    }

    // Inner-face wall-run bands + top hang ledges on each solid span.
    for (const span of solidSpans) {
      registerPerimeterSpanTraversal({
        ledges,
        wallRunSurfaces,
        side,
        from: span.from,
        to: span.to,
      });
    }
  }
}

/**
 * Hang on wall tops + wall-run the interior face of a perimeter span.
 * `side.inward` points into the yard (+1 or -1 along the fixed axis).
 */
function registerPerimeterSpanTraversal({
  ledges,
  wallRunSurfaces,
  side,
  from,
  to,
}) {
  const span = to - from;
  if (span < 4) return;
  const mid = (from + to) * 0.5;
  const wallTopY = FLOOR_Y + WALL_H;
  // Inner face sits just inside the wall thickness.
  const faceOffset = WALL_T * 0.55;

  if (side.axis === 'x') {
    // Wall along X at fixed Z. Inner normal points along -inward * Z... wait:
    // north: fixed=+HALF, inward=-1 means into yard is -Z direction from wall.
    // Normal for wall-run should face the player in the yard = toward center = -sign(fixed) for z.
    const faceZ = side.fixed + side.inward * faceOffset;
    const normalZ = side.inward; // points into yard
    if (wallRunSurfaces) {
      wallRunSurfaces.push({
        name: `Perimeter ${side.side} Wall Run ${from.toFixed(0)}`,
        blockName: `perimeter-${side.side}`,
        face: side.side,
        origin: { x: from + 0.4, y: FLOOR_Y + 0.85, z: faceZ },
        normal: { x: 0, y: 0, z: normalZ },
        tangent: { x: 1, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        minU: 0.2,
        maxU: span - 0.4,
        minV: 0,
        maxV: Math.min(3.1, WALL_H - 1.1),
        rootOffset: 0.4,
        handYOffset: 1.18,
        handForwardOffset: -0.24,
        handNormalOffset: 0.02,
      });
    }
    if (ledges) {
      ledges.push({
        name: `Perimeter ${side.side} Top Ledge ${from.toFixed(0)}`,
        blockName: `perimeter-${side.side}`,
        face: side.side,
        hangMode: 'braced',
        axis: 'x',
        min: from + 0.35,
        max: to - 0.35,
        y: wallTopY,
        x: 0,
        z: faceZ,
        normal: { x: 0, y: 0, z: normalZ },
        tangent: { x: 1, y: 0, z: 0 },
        shelfDepth: WALL_T + 0.35,
        snapPoints: createSimpleSnapPoints({
          axis: 'x',
          min: from + 0.35,
          max: to - 0.35,
          y: wallTopY,
          x: mid,
          z: faceZ,
          normal: { x: 0, y: 0, z: normalZ },
          tangent: { x: 1, y: 0, z: 0 },
        }),
      });
    }
  } else {
    const faceX = side.fixed + side.inward * faceOffset;
    const normalX = side.inward;
    if (wallRunSurfaces) {
      wallRunSurfaces.push({
        name: `Perimeter ${side.side} Wall Run ${from.toFixed(0)}`,
        blockName: `perimeter-${side.side}`,
        face: side.side,
        origin: { x: faceX, y: FLOOR_Y + 0.85, z: from + 0.4 },
        normal: { x: normalX, y: 0, z: 0 },
        tangent: { x: 0, y: 0, z: 1 },
        up: { x: 0, y: 1, z: 0 },
        minU: 0.2,
        maxU: span - 0.4,
        minV: 0,
        maxV: Math.min(3.1, WALL_H - 1.1),
        rootOffset: 0.4,
        handYOffset: 1.18,
        handForwardOffset: -0.24,
        handNormalOffset: 0.02,
      });
    }
    if (ledges) {
      ledges.push({
        name: `Perimeter ${side.side} Top Ledge ${from.toFixed(0)}`,
        blockName: `perimeter-${side.side}`,
        face: side.side,
        hangMode: 'braced',
        axis: 'z',
        min: from + 0.35,
        max: to - 0.35,
        y: wallTopY,
        x: faceX,
        z: 0,
        normal: { x: normalX, y: 0, z: 0 },
        tangent: { x: 0, y: 0, z: 1 },
        shelfDepth: WALL_T + 0.35,
        snapPoints: createSimpleSnapPoints({
          axis: 'z',
          min: from + 0.35,
          max: to - 0.35,
          y: wallTopY,
          x: faceX,
          z: mid,
          normal: { x: normalX, y: 0, z: 0 },
          tangent: { x: 0, y: 0, z: 1 },
        }),
      });
    }
  }
}

/** Axis-aligned prop (shed) ledges + wall runs on four faces. */
function registerAxisAlignedBuildingTraversal({
  ledges,
  wallRunSurfaces,
  name,
  cx,
  cz,
  halfX,
  halfZ,
  bottomY,
  topY,
  wallRunMaxV = 2.5,
}) {
  const faces = [
    { face: 'east', normal: { x: 1, y: 0, z: 0 }, tangent: { x: 0, y: 0, z: 1 }, edgeX: cx + halfX, edgeZ: cz, axis: 'z', min: cz - halfZ + 0.25, max: cz + halfZ - 0.25 },
    { face: 'west', normal: { x: -1, y: 0, z: 0 }, tangent: { x: 0, y: 0, z: 1 }, edgeX: cx - halfX, edgeZ: cz, axis: 'z', min: cz - halfZ + 0.25, max: cz + halfZ - 0.25 },
    { face: 'north', normal: { x: 0, y: 0, z: 1 }, tangent: { x: 1, y: 0, z: 0 }, edgeX: cx, edgeZ: cz + halfZ, axis: 'x', min: cx - halfX + 0.25, max: cx + halfX - 0.25 },
    { face: 'south', normal: { x: 0, y: 0, z: -1 }, tangent: { x: 1, y: 0, z: 0 }, edgeX: cx, edgeZ: cz - halfZ, axis: 'x', min: cx - halfX + 0.25, max: cx + halfX - 0.25 },
  ];

  for (const f of faces) {
    if (f.max - f.min < 1.4) continue;
    if (ledges) {
      ledges.push({
        name: `${name} ${f.face} Roof Ledge`,
        blockName: name,
        face: f.face,
        hangMode: 'braced',
        axis: f.axis,
        min: f.min,
        max: f.max,
        y: topY,
        x: f.axis === 'z' ? f.edgeX : 0,
        z: f.axis === 'x' ? f.edgeZ : 0,
        normal: f.normal,
        tangent: f.tangent,
        shelfDepth: Math.min(halfX, halfZ) * 0.9,
        snapPoints: createSimpleSnapPoints({
          axis: f.axis,
          min: f.min,
          max: f.max,
          y: topY,
          x: f.edgeX,
          z: f.edgeZ,
          normal: f.normal,
          tangent: f.tangent,
        }),
      });
    }
    if (wallRunSurfaces) {
      const origin = f.axis === 'z'
        ? { x: f.edgeX + f.normal.x * 0.04, y: bottomY + 0.7, z: f.min + 0.15 }
        : { x: f.min + 0.15, y: bottomY + 0.7, z: f.edgeZ + f.normal.z * 0.04 };
      wallRunSurfaces.push({
        name: `${name} ${f.face} Wall Run`,
        blockName: name,
        face: f.face,
        origin,
        normal: f.normal,
        tangent: f.tangent,
        up: { x: 0, y: 1, z: 0 },
        minU: 0.1,
        maxU: f.max - f.min - 0.2,
        minV: 0,
        maxV: wallRunMaxV,
        rootOffset: 0.38,
        handYOffset: 1.1,
        handForwardOffset: -0.2,
        handNormalOffset: 0.02,
      });
    }
  }
}

function addWallSegment({ group, colliders, side, from, to }) {
  const length = to - from;
  if (length < 0.1) return;
  const mid = (from + to) * 0.5;
  if (side.axis === 'x') {
    addBox({
      group,
      colliders,
      name: `Wall ${side.side}`,
      cx: mid,
      cy: FLOOR_Y + WALL_H * 0.5,
      cz: side.fixed,
      sx: length,
      sy: WALL_H,
      sz: WALL_T,
      material: wallMat,
      collider: true,
      noGroundSnap: true,
      surfaceClass: 'metal',
      tileMeters: METAL_TILE_M,
    });
  } else {
    addBox({
      group,
      colliders,
      name: `Wall ${side.side}`,
      cx: side.fixed,
      cy: FLOOR_Y + WALL_H * 0.5,
      cz: mid,
      sx: WALL_T,
      sy: WALL_H,
      sz: length,
      material: wallMat,
      collider: true,
      noGroundSnap: true,
      surfaceClass: 'metal',
      tileMeters: METAL_TILE_M,
    });
  }
}

function addGate({ group, colliders, side, centre }) {
  const frameT = 0.3;
  const lintelH = 0.38;
  if (side.axis === 'x') {
    const z = side.fixed;
    for (const dx of [-GATE_W * 0.5, GATE_W * 0.5]) {
      addBox({
        group,
        colliders,
        name: `Gate Post ${side.side}`,
        cx: centre + dx,
        cy: FLOOR_Y + GATE_H * 0.5,
        cz: z,
        sx: frameT,
        sy: GATE_H,
        sz: WALL_T * 1.2,
        material: gateFrameMat,
        collider: true,
        noGroundSnap: true,
        surfaceClass: 'metal',
        tileMeters: METAL_TILE_M,
      });
    }
    addBox({
      group,
      colliders,
      name: `Gate Lintel ${side.side}`,
      cx: centre,
      cy: FLOOR_Y + GATE_H + lintelH * 0.5,
      cz: z,
      sx: GATE_W + frameT,
      sy: lintelH,
      sz: WALL_T * 1.15,
      material: gateFrameMat,
      collider: true,
      noGroundSnap: true,
      surfaceClass: 'metal',
      tileMeters: METAL_TILE_M,
    });
    const fillH = WALL_H - (GATE_H + lintelH);
    if (fillH > 0.1) {
      addBox({
        group,
        colliders,
        name: `Gate Header ${side.side}`,
        cx: centre,
        cy: FLOOR_Y + GATE_H + lintelH + fillH * 0.5,
        cz: z,
        sx: GATE_W + frameT,
        sy: fillH,
        sz: WALL_T,
        material: wallMat,
        collider: true,
        noGroundSnap: true,
        surfaceClass: 'metal',
        tileMeters: METAL_TILE_M,
      });
    }
    const shutter = new THREE.Mesh(
      prepareBoxGeometry(GATE_W - 0.15, GATE_H - 0.2, 0.08, shutterMat, METAL_TILE_M),
      shutterMat,
    );
    shutter.name = `Gate Shutter ${side.side}`;
    shutter.position.set(centre, FLOOR_Y + GATE_H * 0.5, z - side.inward * (WALL_T * 0.5 + 0.06));
    shutter.castShadow = true;
    group.add(shutter);
  } else {
    const x = side.fixed;
    for (const dz of [-GATE_W * 0.5, GATE_W * 0.5]) {
      addBox({
        group,
        colliders,
        name: `Gate Post ${side.side}`,
        cx: x,
        cy: FLOOR_Y + GATE_H * 0.5,
        cz: centre + dz,
        sx: WALL_T * 1.2,
        sy: GATE_H,
        sz: frameT,
        material: gateFrameMat,
        collider: true,
        noGroundSnap: true,
        surfaceClass: 'metal',
        tileMeters: METAL_TILE_M,
      });
    }
    addBox({
      group,
      colliders,
      name: `Gate Lintel ${side.side}`,
      cx: x,
      cy: FLOOR_Y + GATE_H + lintelH * 0.5,
      cz: centre,
      sx: WALL_T * 1.15,
      sy: lintelH,
      sz: GATE_W + frameT,
      material: gateFrameMat,
      collider: true,
      noGroundSnap: true,
      surfaceClass: 'metal',
      tileMeters: METAL_TILE_M,
    });
    const fillH = WALL_H - (GATE_H + lintelH);
    if (fillH > 0.1) {
      addBox({
        group,
        colliders,
        name: `Gate Header ${side.side}`,
        cx: x,
        cy: FLOOR_Y + GATE_H + lintelH + fillH * 0.5,
        cz: centre,
        sx: WALL_T,
        sy: fillH,
        sz: GATE_W + frameT,
        material: wallMat,
        collider: true,
        noGroundSnap: true,
        surfaceClass: 'metal',
        tileMeters: METAL_TILE_M,
      });
    }
    const shutter = new THREE.Mesh(
      prepareBoxGeometry(0.08, GATE_H - 0.2, GATE_W - 0.15, shutterMat, METAL_TILE_M),
      shutterMat,
    );
    shutter.name = `Gate Shutter ${side.side}`;
    shutter.position.set(x - side.inward * (WALL_T * 0.5 + 0.06), FLOOR_Y + GATE_H * 0.5, centre);
    shutter.castShadow = true;
    group.add(shutter);
  }
}

function buildSpawnPoints() {
  const points = [];
  const inset = 2.6;
  const sides = [
    { side: 'north', axis: 'x', fixed: HALF - inset, yaw: Math.PI },
    { side: 'south', axis: 'x', fixed: -HALF + inset, yaw: 0 },
    { side: 'east', axis: 'z', fixed: HALF - inset, yaw: -Math.PI / 2 },
    { side: 'west', axis: 'z', fixed: -HALF + inset, yaw: Math.PI / 2 },
  ];

  for (const side of sides) {
    const gates = GATE_SPECS.filter((g) => g.side === side.side);
    const centres = buildSideGateCentres(side.side, gates.length);
    for (let i = 0; i < gates.length; i += 1) {
      const along = centres[i];
      const x = side.axis === 'x' ? along : side.fixed;
      const z = side.axis === 'z' ? along : side.fixed;
      const pos = new THREE.Vector3(x, FLOOR_Y, z);
      points.push({
        id: gates[i].id,
        position: pos,
        yaw: side.yaw,
        gateId: gates[i].id,
        minWave: 1,
        weight: 1,
        distFromOrigin: Math.hypot(x, z),
      });
    }
  }
  return points;
}

function buildSideGateCentres(side, count) {
  // East/west gates at ±12 landed directly on the z=±11 freight rakes,
  // allowing initial ground queries to place bots on boxcar roofs. The wider
  // ±17 aisles preserve the eight-gate layout and feed the shipping route.
  if ((side === 'east' || side === 'west') && count === 2) return [-17, 17];
  return Array.from({ length: count }, (_, i) => {
    const u = (i + 1) / (count + 1);
    return -HALF + u * (HALF * 2);
  });
}

// ── Mesh helpers ───────────────────────────────────────────────────────────

function ensureUv2(geometry) {
  if (!geometry?.attributes?.uv || geometry.attributes.uv2) return geometry;
  geometry.setAttribute('uv2', geometry.attributes.uv.clone());
  return geometry;
}

/**
 * World-scale UVs on box faces so PBR maps tile by meters instead of stretching.
 */
function prepareBoxGeometry(sx, sy, sz, material, tileMeters = WALL_TILE_M) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  if (!material?.map || !tileMeters || tileMeters <= 0) {
    return ensureUv2(geometry);
  }
  const uv = geometry.attributes.uv;
  const pos = geometry.attributes.position;
  // BoxGeometry groups: +X -X +Y -Y +Z -Z — rebuild UVs from face size.
  const faces = [
    { w: sz, h: sy }, // +X
    { w: sz, h: sy }, // -X
    { w: sx, h: sz }, // +Y
    { w: sx, h: sz }, // -Y
    { w: sx, h: sy }, // +Z
    { w: sx, h: sy }, // -Z
  ];
  let vi = 0;
  for (const face of faces) {
    const uScale = face.w / tileMeters;
    const vScale = face.h / tileMeters;
    // 4 verts per face (non-indexed after three r152 still uses groups of 6 idx / 4 unique in buffer)
    // BoxGeometry is indexed: 4 vertices per face * 6 faces = 24 verts.
    for (let k = 0; k < 4; k += 1) {
      const u = uv.getX(vi);
      const v = uv.getY(vi);
      uv.setXY(vi, u * uScale, v * vScale);
      vi += 1;
    }
  }
  uv.needsUpdate = true;
  void pos;
  return ensureUv2(geometry);
}

function stampCylinderUv2(geometry) {
  ensureUv2(geometry);
}

function addBox({
  group,
  colliders,
  name,
  cx,
  cy,
  cz,
  sx,
  sy,
  sz,
  material,
  collider,
  noGroundSnap = false,
  surfaceClass = null,
  tileMeters = WALL_TILE_M,
}) {
  const mesh = new THREE.Mesh(prepareBoxGeometry(sx, sy, sz, material, tileMeters), material);
  mesh.name = name;
  mesh.position.set(cx, cy, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  if (collider && colliders) {
    colliders.push({
      name,
      minX: cx - sx * 0.5,
      maxX: cx + sx * 0.5,
      minZ: cz - sz * 0.5,
      maxZ: cz + sz * 0.5,
      bottomY: cy - sy * 0.5,
      topY: cy + sy * 0.5,
      surfaceClass: surfaceClass ?? 'concrete',
      ...(noGroundSnap ? { noGroundSnap: true } : {}),
    });
  }
  return mesh;
}

/**
 * Merge all static opaque meshes by material into a handful of draws.
 * Mirrors createShootingRangeLevel.mergeStaticRangeGeometry — colliders are
 * independent AABB data and stay valid after the visual mesh tree is collapsed.
 */
function mergeStaticHordeGeometry(root) {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  /** @type {Map<string, { material: THREE.Material, castShadow: boolean, receiveShadow: boolean, geometries: THREE.BufferGeometry[], sources: THREE.Mesh[] }>} */
  const batches = new Map();

  root.traverse((object) => {
    if (!object.isMesh || object.isSkinnedMesh || object.isInstancedMesh) return;
    if (!object.geometry?.isBufferGeometry) return;
    if (Array.isArray(object.material) || !object.material) return;
    // Skip anything explicitly dynamic (none today, kept for safety).
    if (object.userData?.noStaticMerge) return;

    // One batch per material. Force consistent shadow flags so ribs / lamps /
    // wheels do not split the same material into 2–4 draw calls.
    const key = object.material.uuid;

    let batch = batches.get(key);
    if (!batch) {
      batch = {
        material: object.material,
        castShadow: false,
        receiveShadow: true,
        geometries: [],
        sources: [],
      };
      batches.set(key, batch);
    }

    relative.multiplyMatrices(rootInverse, object.matrixWorld);
    const geometry = object.geometry.clone();
    // Drop morphs / skin if any; normalize for merge.
    if (geometry.morphAttributes) geometry.morphAttributes = {};
    geometry.applyMatrix4(relative);
    // Only keep merge-friendly attrs (position/normal/uv/uv2).
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'uv2') {
        geometry.deleteAttribute(name);
      }
    }
    if (!geometry.getAttribute('normal') && geometry.getAttribute('position')) {
      geometry.computeVertexNormals();
    }
    batch.geometries.push(geometry);
    batch.sources.push(object);
  });

  // Intersect attribute sets within each batch so mergeGeometries does not fail.
  for (const batch of batches.values()) {
    if (batch.geometries.length < 2) continue;
    const common = new Set(Object.keys(batch.geometries[0].attributes));
    for (let i = 1; i < batch.geometries.length; i += 1) {
      const names = new Set(Object.keys(batch.geometries[i].attributes));
      for (const name of [...common]) {
        if (!names.has(name)) common.delete(name);
      }
    }
    // Always keep position; if normal is missing on any, recompute all after strip.
    if (!common.has('position')) common.add('position');
    for (const geometry of batch.geometries) {
      for (const name of Object.keys(geometry.attributes)) {
        if (!common.has(name)) geometry.deleteAttribute(name);
      }
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    }
  }

  const mergedMeshes = [];
  const consumed = new Set();
  let sourceMeshes = 0;

  for (const batch of batches.values()) {
    sourceMeshes += batch.sources.length;
    let geometry = null;
    try {
      geometry = batch.geometries.length === 1
        ? batch.geometries[0]
        : mergeGeometries(batch.geometries, false);
    } catch (err) {
      console.warn('[HordeTrainYard] merge failed for material batch, keeping individuals', err);
      for (const g of batch.geometries) g.dispose?.();
      continue;
    }
    if (!geometry) {
      for (const g of batch.geometries) g.dispose?.();
      continue;
    }
    if (batch.geometries.length > 1) {
      for (const g of batch.geometries) g.dispose?.();
    }

    const mesh = new THREE.Mesh(geometry, batch.material);
    mesh.name = `Horde Static Batch ${mergedMeshes.length + 1}`;
    mesh.castShadow = batch.castShadow;
    mesh.receiveShadow = batch.receiveShadow;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.static = true;
    mesh.frustumCulled = true;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    mergedMeshes.push(mesh);

    for (const source of batch.sources) consumed.add(source);
  }

  // Remove & dispose originals that were successfully batched.
  const disposedGeo = new Set();
  for (const mesh of consumed) {
    mesh.removeFromParent();
    if (mesh.geometry && !disposedGeo.has(mesh.geometry)) {
      disposedGeo.add(mesh.geometry);
      mesh.geometry.dispose?.();
    }
  }
  for (const mesh of mergedMeshes) root.add(mesh);

  return {
    sourceMeshes,
    batches: mergedMeshes.length,
    consumed: consumed.size,
  };
}

function disableStaticHordeShadows(root) {
  root.traverse((object) => {
    if (object.isMesh) object.castShadow = false;
  });
}

/** Drop empty Groups left after mesh merge so the scene graph stays thin. */
function pruneEmptyGroups(root) {
  const groups = [];
  root.traverse((object) => {
    if (object.isGroup && object !== root) groups.push(object);
  });
  // Deepest first.
  groups.sort((a, b) => b.id - a.id);
  for (const g of groups) {
    if (g.children.length === 0) g.removeFromParent();
  }
}
