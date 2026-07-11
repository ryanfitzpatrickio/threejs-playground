/**
 * Covered timber warehouse breach course for the Shooting Range.
 * ~4× floor area (≈28×110 m), gabled roof, clerestory window band.
 * God rays come from the official three.js TSL GodraysNode post pass
 * (sun + shadows, tracks time of day) — not mesh shafts.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { createMaterialWarmupGroup } from './createMaterialWarmupGroup.js';
import { getGroundHeightAt, getBlockingColliderAt } from './createBaseLevel.js';
import { createRallySurfaceMaterial } from '../materials/rallySurfaceTextures.js';
import { getQualityLevel, getQualityPreset } from '../config/qualityPresets.js';

/** Course runs along +Z from the staging bay. */
const FLOOR_Y = 0;
/** Solid boarded wall height (below clerestory). */
const SOLID_WALL_H = 5.05;
/** Tall window band around the top of the walls. */
const CLERESTORY_H = 2.15;
/** Wall plate / eave line under the roof. */
const WALL_PLATE_Y = SOLID_WALL_H + CLERESTORY_H;
/** Gable ridge peak. */
const RIDGE_Y = 9.55;
/** @deprecated alias used by a few helpers — solid+clerestory total. */
const WALL_H = WALL_PLATE_Y;
const HALL_WIDTH = 28;
const WALL_T = 0.32;
const COURSE_MIN_Z = -8;
const COURSE_MAX_Z = 108;
const POST_SPACING = 8;
/** Scene sun bias (matches SceneSystem SUN_OFFSET feel: high + slightly SW). */
const SUN_DIR = new THREE.Vector3(-0.42, -0.78, 0.38).normalize();

const RANGE_TEXTURE_ROOT = '/assets/textures/range';

/**
 * Load a sliced range PBR map. Headless probes get null maps.
 * @param {string} path relative under RANGE_TEXTURE_ROOT (e.g. brickwall/albedo.png)
 * @param {{ repeatX?: number, repeatY?: number, colorSpace?: string, srgb?: boolean }} [opts]
 */
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

/**
 * Full PBR set from a cut 2×2 atlas folder (albedo / normal / roughness / height).
 * Source atlases: TL albedo, TR normal, BL roughness, BR height.
 */
function loadRangePbrSet(folder, { repeatX = 1, repeatY = 1 } = {}) {
  const shared = { repeatX, repeatY };
  return {
    map: loadRangeTexture(`${folder}/albedo.png`, { ...shared, srgb: true }),
    normalMap: loadRangeTexture(`${folder}/normal.png`, shared),
    roughnessMap: loadRangeTexture(`${folder}/roughness.png`, shared),
    aoMap: loadRangeTexture(`${folder}/height.png`, shared),
  };
}

function makeRangeWallMaterial(pbr, {
  roughness = 0.88,
  metalness = 0.03,
  envMapIntensity = 0.55,
  normalScale = 1,
  aoMapIntensity = 0.75,
} = {}) {
  return new THREE.MeshStandardMaterial({
    map: pbr.map,
    normalMap: pbr.normalMap,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughnessMap: pbr.roughnessMap,
    roughness,
    metalness,
    // Height atlas tile doubles as soft AO (no second UV set on boxes — Three
    // falls back to uv when aoMap is set without uv2 on many builds; we also
    // stamp uv2 in addBox for wall meshes).
    aoMap: pbr.aoMap,
    aoMapIntensity,
    color: 0xffffff,
    envMapIntensity,
  });
}

// Sliced PBR sets (from 2×2 atlas sheets brickwall/woodwall/woodwall2.png +
// metalroof/pillarmiddle/pillarend). Texture.repeat stays 1×1 — world-space box
// UVs in prepareBoxGeometry set tile density so long runs do not stretch.
/** Meters covered by one full albedo tile (keep brick/wood roughly square). */
const WALL_TEXTURE_TILE_M = 2.8;
/** Corrugated metal + rust pillar maps tile a bit tighter than brick. */
const METAL_TEXTURE_TILE_M = 1.85;
const brickPbr = loadRangePbrSet('brickwall', { repeatX: 1, repeatY: 1 });
const woodPbr = loadRangePbrSet('woodwall', { repeatX: 1, repeatY: 1 });
const wood2Pbr = loadRangePbrSet('woodwall2', { repeatX: 1, repeatY: 1 });
const concretePbr = loadRangePbrSet('concrete', { repeatX: 1, repeatY: 1 });
const metalRoofPbr = loadRangePbrSet('metalroof', { repeatX: 1, repeatY: 1 });
const pillarMiddlePbr = loadRangePbrSet('pillarmiddle', { repeatX: 1, repeatY: 1 });
const pillarEndPbr = loadRangePbrSet('pillarend', { repeatX: 1, repeatY: 1 });

// Use the same world-space hex tile blend as terrain and rally shoulders. It
// rotates and blends neighbouring concrete samples so the large indoor slab
// does not reveal a single repeated texture while retaining concrete PBR maps.
const floorMat = createRallySurfaceMaterial({
  map: concretePbr.map,
  normalMap: concretePbr.normalMap,
  roughnessMap: concretePbr.roughnessMap,
  heightMap: concretePbr.aoMap,
}, {
  tilesPerMetre: 1 / WALL_TEXTURE_TILE_M,
  hextile: getQualityPreset(getQualityLevel()).terrainHextile ?? null,
});
const concreteFixtureMat = floorMat;
const plankMat = new THREE.MeshStandardMaterial({
  color: 0x7a5c3c,
  roughness: 0.84,
  metalness: 0.05,
  envMapIntensity: 0.6,
});
/** Structural steel (posts, beams, rafters, trim, ballast) — pillarmiddle PBR. */
const pillarMat = makeRangeWallMaterial(pillarMiddlePbr, {
  roughness: 0.58,
  metalness: 0.62,
  envMapIntensity: 1.05,
  normalScale: 1.15,
  aoMapIntensity: 0.7,
});
/** @deprecated alias — structural timber call sites now share pillar steel. */
const darkTimberMat = pillarMat;
/** Beams / ridge / wall plate / door posts. */
const beamMat = pillarMat;
/** Warehouse shell (exterior + end walls + gables) — brick PBR. */
const brickWallMat = makeRangeWallMaterial(brickPbr, {
  roughness: 0.92,
  envMapIntensity: 0.55,
  normalScale: 1.05,
  aoMapIntensity: 0.8,
});
/** Interior partitions — woodwall PBR */
const woodWallMat = makeRangeWallMaterial(woodPbr, {
  roughness: 0.86,
  envMapIntensity: 0.5,
  normalScale: 0.95,
  aoMapIntensity: 0.7,
});
/** Interior partitions alt — woodwall2 PBR */
const woodWall2Mat = makeRangeWallMaterial(wood2Pbr, {
  roughness: 0.88,
  envMapIntensity: 0.48,
  normalScale: 1.0,
  aoMapIntensity: 0.72,
});
/** Alias for shell material (older call sites / cover accents). */
const wallBoardMat = brickWallMat;
const crateMat = new THREE.MeshStandardMaterial({
  color: 0x8f6b38,
  roughness: 0.8,
  metalness: 0.05,
  envMapIntensity: 0.55,
});
const palletMat = new THREE.MeshStandardMaterial({
  color: 0x9a7a4a,
  roughness: 0.9,
  metalness: 0.03,
  envMapIntensity: 0.4,
});
/** Fixture / prop metal (sound samples, lockers) — flat grey, not structure. */
const metalMat = new THREE.MeshStandardMaterial({
  color: 0x5a5c60,
  roughness: 0.42,
  metalness: 0.65,
  envMapIntensity: 1.25,
});
const marbleFixtureMat = new THREE.MeshStandardMaterial({
  color: 0xd8d3c8,
  roughness: 0.32,
  metalness: 0.04,
  envMapIntensity: 0.9,
});
const soilFixtureMat = new THREE.MeshStandardMaterial({
  color: 0x5c3922,
  roughness: 1,
  metalness: 0,
});
const fleshFixtureMat = new THREE.MeshStandardMaterial({
  color: 0x8f3434,
  roughness: 0.72,
  metalness: 0,
  emissive: 0x1c0505,
  emissiveIntensity: 0.16,
});
const dangerStripeMat = new THREE.MeshStandardMaterial({
  color: 0xc45a1a,
  roughness: 0.65,
  metalness: 0.12,
  emissive: 0x401800,
  emissiveIntensity: 0.22,
  envMapIntensity: 0.5,
});
const friendlyStripeMat = new THREE.MeshStandardMaterial({
  color: 0x2a6a9a,
  roughness: 0.65,
  metalness: 0.12,
  emissive: 0x0a2840,
  emissiveIntensity: 0.18,
  envMapIntensity: 0.5,
});
/** Outer corrugated roof deck — metalroof PBR. */
const roofMat = makeRangeWallMaterial(metalRoofPbr, {
  roughness: 0.48,
  metalness: 0.78,
  envMapIntensity: 1.15,
  normalScale: 1.25,
  aoMapIntensity: 0.55,
});
/** Inside metal roof (underside of deck) — same maps, back faces. */
const roofUndersideMat = makeRangeWallMaterial(metalRoofPbr, {
  roughness: 0.55,
  metalness: 0.72,
  envMapIntensity: 0.95,
  normalScale: 1.2,
  aoMapIntensity: 0.6,
});
roofUndersideMat.side = THREE.BackSide;
// Standard glass (reliable on WebGPU); bright emissive so sky IBL "pours" through.
const glassMat = new THREE.MeshStandardMaterial({
  color: 0xc5dcec,
  roughness: 0.12,
  metalness: 0.08,
  transparent: true,
  opacity: 0.38,
  depthWrite: false,
  side: THREE.DoubleSide,
  envMapIntensity: 1.55,
  emissive: 0xa8d0ee,
  emissiveIntensity: 0.38,
});
/** Clerestory mullions share structural rust steel. */
const mullionMat = pillarMat;
/**
 * Pillar base plate card (non-tiling atlas tile with baked alpha).
 * Alpha-tested so the grey atlas background disappears.
 */
const pillarEndMat = new THREE.MeshStandardMaterial({
  map: pillarEndPbr.map,
  normalMap: pillarEndPbr.normalMap,
  normalScale: new THREE.Vector2(1.05, 1.05),
  roughnessMap: pillarEndPbr.roughnessMap,
  roughness: 0.62,
  metalness: 0.55,
  aoMap: pillarEndPbr.aoMap,
  aoMapIntensity: 0.55,
  color: 0xffffff,
  transparent: true,
  alphaTest: 0.32,
  depthWrite: true,
  side: THREE.DoubleSide,
  envMapIntensity: 1.0,
});
// ── Breach-arrow floor decal (chevrons pointing toward doorways) ───────────
// SVG loaded once; a flipped clone (repeat.x = −1) reverses direction so both
// sides of a door converge inward.
const breachArrowTex = (() => {
  if (typeof document === 'undefined') return null;
  const tex = new THREE.TextureLoader().load(`${RANGE_TEXTURE_ROOT}/breach-arrow.svg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  return tex;
})();
const breachArrowFlippedTex = (() => {
  if (!breachArrowTex) return null;
  const tex = breachArrowTex.clone();
  tex.needsUpdate = true;
  tex.repeat.x = -1;
  return tex;
})();
const breachArrowMat = new THREE.MeshStandardMaterial({
  map: breachArrowTex,
  transparent: true,
  alphaTest: 0.15,
  depthWrite: false,
  roughness: 0.85,
  metalness: 0.08,
  color: 0xffffff,
  emissive: 0x401800,
  emissiveIntensity: 0.18,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
const breachArrowFlippedMat = new THREE.MeshStandardMaterial({
  map: breachArrowFlippedTex,
  transparent: true,
  alphaTest: 0.15,
  depthWrite: false,
  roughness: 0.85,
  metalness: 0.08,
  color: 0xffffff,
  emissive: 0x401800,
  emissiveIntensity: 0.18,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

const dustMoteMat = new THREE.MeshBasicMaterial({
  color: 0xfff0c8,
  transparent: true,
  opacity: 0.18,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  fog: false,
});

/**
 * Target placements (world space). `friendly: true` = do not shoot.
 *
 * Laid out room-by-room to match `buildInteriorLayout`'s CQB shoot-house so the
 * course reads as a real breach: every room stages a discrimination decision
 * (friendly next to a hostile, a cornered civilian, a hostage with a shooter at
 * a tight angle) rather than a flat gallery of pop-ups. `yaw = Math.PI` faces a
 * silhouette south toward the breaching player; ±Math.PI/2 face east / west.
 */
export const RANGE_TARGET_SPAWNS = [
  // ── Reception (z 12–32): breach D1, immediate discrimination ──────────────
  // Hostile behind the front desk, dead ahead; a civilian is hands-up to the
  // left in the same eyeline — punish a reflex spray.
  { id: 'rc-h1', x: -2.0, z: 29, yaw: Math.PI, friendly: false },
  { id: 'rc-f1', x: -11.5, z: 17, yaw: Math.PI * 0.5, friendly: true },
  { id: 'rc-h2', x: 9.5, z: 22, yaw: -Math.PI * 0.6, friendly: false },

  // ── Corridor (z 32–54): breach D2 into a hallway gunfight ─────────────────
  { id: 'co-h1', x: 0.0, z: 50, yaw: Math.PI, friendly: false },

  // ── West break room (x<-2.8, z 32–54) via side door ──────────────────────
  { id: 'wb-h1', x: -9.0, z: 39, yaw: Math.PI * 0.5, friendly: false },
  { id: 'wb-f1', x: -12.5, z: 51, yaw: Math.PI * 0.3, friendly: true },

  // ── East records room (x>2.8, z 32–54) via side door ─────────────────────
  { id: 'er-h1', x: 9.0, z: 39, yaw: -Math.PI * 0.5, friendly: false },
  { id: 'er-h2', x: 12.0, z: 51, yaw: -Math.PI * 0.4, friendly: false },

  // ── Warehouse floor (z 54–78): ranged, shelving cover, worker mixed in ────
  { id: 'wh-h1', x: -8.0, z: 64, yaw: Math.PI, friendly: false },
  { id: 'wh-h2', x: 7.0, z: 70, yaw: Math.PI * 0.9, friendly: false },
  { id: 'wh-h3', x: 11.5, z: 61, yaw: -Math.PI * 0.6, friendly: false },
  { id: 'wh-f1', x: -11.5, z: 73, yaw: Math.PI * 0.4, friendly: true },
  { id: 'wh-h4', x: -2.0, z: 75, yaw: Math.PI, friendly: false },

  // ── Hostage room (z 78–92): the key decision ─────────────────────────────
  // Hostage dead-center facing you; a shooter is tucked at his right shoulder
  // (tight, risky angle) while a flanker gives a clean, safe shot to the left.
  { id: 'ho-f1', x: 0.0, z: 88, yaw: Math.PI, friendly: true },
  { id: 'ho-h1', x: 2.2, z: 88.5, yaw: Math.PI, friendly: false },
  { id: 'ho-h2', x: -8.5, z: 83, yaw: Math.PI * 0.6, friendly: false },

  // ── Final office (z 92–108): last stand + a surrendering civilian ────────
  { id: 'fo-h1', x: -8.0, z: 100, yaw: Math.PI, friendly: false },
  { id: 'fo-h2', x: 6.0, z: 98, yaw: Math.PI * 0.95, friendly: false },
  { id: 'fo-h3', x: -2.0, z: 104, yaw: Math.PI, friendly: false },
  { id: 'fo-h4', x: 11.0, z: 103, yaw: -Math.PI * 0.55, friendly: false },
  { id: 'fo-f1', x: 9.5, z: 96.5, yaw: Math.PI * 0.4, friendly: true },
];

/**
 * Material fixtures on the staging-bay side walls: safe visual/audio decal
 * sample panels. `side: -1` = west wall (facing into the bay), `side: 1` = east.
 * Kept off the centerline so they do not block the approach into the course.
 */
export const RANGE_MATERIAL_FIXTURES = Object.freeze([
  // West wall
  { id: 'concrete', label: 'CONCRETE', side: -1, z: -4.2, surfaceClass: 'concrete', material: concreteFixtureMat },
  { id: 'marble', label: 'MARBLE', side: -1, z: -0.8, surfaceClass: 'marble', material: marbleFixtureMat },
  { id: 'wood', label: 'WOOD', side: -1, z: 2.6, surfaceClass: 'wood', material: woodWallMat },
  { id: 'metal', label: 'METAL', side: -1, z: 6.0, surfaceClass: 'metal', material: metalMat },
  // East wall
  { id: 'glass', label: 'GLASS', side: 1, z: -2.5, surfaceClass: 'glass', material: glassMat },
  { id: 'soil', label: 'SOIL', side: 1, z: 1.2, surfaceClass: 'soil', material: soilFixtureMat },
  { id: 'flesh', label: 'FLESH', side: 1, z: 4.9, surfaceClass: 'flesh', material: fleshFixtureMat },
]);

/**
 * Knockable breach doors (world space), consumed by ShootingRangeSystem which
 * builds the swinging meshes, gates the matching collider, and tips them over
 * on the interact key. `axis:'x'` = door spans X in a cross wall (tips along Z);
 * `axis:'z'` = door spans Z in a corridor side wall (tips along X). Kept in sync
 * with the doorway gaps punched by `buildInteriorLayout`.
 *
 * Narrow single-leaf openings (≈1.1–1.25 m) under a tall clear height
 * (`DOOR_CLEAR_H`); leaf height lives in ShootingRangeSystem (`DOOR_HEIGHT`).
 */
/** Clear height under interior door lintels (m). Must exceed DOOR_HEIGHT. */
const DOOR_CLEAR_H = 2.72;
/** Default interior doorway width (m) — tall single door, not double-width. */
const DOOR_W = 1.15;
const DOOR_W_SIDE = 1.1;
const DOOR_W_WAREHOUSE = 1.25;

export const RANGE_DOOR_SPECS = [
  { id: 'd-reception', x: 0, z: 12, width: DOOR_W, axis: 'x' },
  { id: 'd-corridor', x: 0, z: 32, width: DOOR_W, axis: 'x' },
  { id: 'd-breakroom', x: -2.8, z: 44, width: DOOR_W_SIDE, axis: 'z' },
  { id: 'd-records', x: 2.8, z: 44, width: DOOR_W_SIDE, axis: 'z' },
  { id: 'd-warehouse', x: 0, z: 54, width: DOOR_W_WAREHOUSE, axis: 'x' },
  { id: 'd-hostage', x: -4, z: 78, width: DOOR_W, axis: 'x' },
  { id: 'd-office', x: 4, z: 92, width: DOOR_W, axis: 'x' },
];

/**
 * Range lighting / IBL config (applied by GameRuntime).
 * Warehouse HDR for material IBL; outdoor sky stays as background so
 * clerestory glass + god rays read as sky light pouring in.
 */
export const RANGE_ENVIRONMENT = Object.freeze({
  /** Warehouse HDR IBL intensity on scene.environment */
  intensity: 1.05,
  /** Keep outdoor sky mesh as background (visible through clerestory) */
  asBackground: false,
  environmentRotationY: 0.35,
  /** 16:42 on the 0–1 clock (hours/24). Late-afternoon sun through clerestory. */
  timeOfDay: (16 + 42 / 60) / 24,
  weather: 'clear',
  fogEnabled: false,
});

export function createShootingRangeLevel() {
  const group = new THREE.Group();
  group.name = 'Shooting Range';
  // createLevelGeometryIndex freezes the final merged render meshes and marks
  // them static so WebGPU skips redundant per-pass matrix/material observers.
  group.userData.freezeStaticWorldMatrices = true;
  const colliders = [];
  const materials = [
    floorMat, plankMat, pillarMat, beamMat,
    brickWallMat, woodWallMat, woodWall2Mat,
    crateMat, palletMat, metalMat, dangerStripeMat, friendlyStripeMat,
    roofMat, roofUndersideMat, glassMat, mullionMat, pillarEndMat, dustMoteMat,
    breachArrowMat, breachArrowFlippedMat,
  ];

  const halfW = HALL_WIDTH * 0.5;
  const length = COURSE_MAX_Z - COURSE_MIN_Z;
  const centerZ = (COURSE_MIN_Z + COURSE_MAX_Z) * 0.5;

  // ── Ground slab + wooden deck planks ─────────────────────────────────────
  addBox({
    group,
    colliders,
    name: 'Range Floor Slab',
    cx: 0,
    cy: FLOOR_Y - 0.12,
    cz: centerZ,
    sx: HALL_WIDTH + 2.5,
    sy: 0.24,
    sz: length + 2.5,
    material: floorMat,
    collider: true,
    surfaceClass: 'concrete',
  });
  addMaterialFixtureRow({ group, colliders });

  // ── Exterior timber walls (solid board + clerestory glass band) ───────────
  addExteriorWalls({ group, colliders, halfW, centerZ, length });

  // ── Posts, fixed gable trusses, covered roof deck ────────────────────────
  addTimberFrame({ group, colliders, halfW });
  addCoveredRoof({ group, colliders, halfW, centerZ, length });

  // ── Clerestory glass + mullions around the top of every wall ─────────────
  addClerestoryWindows({ group, halfW, centerZ, length });

  // God rays: handled by the official three.js TSL GodraysNode post pass
  // (RendererSystem + sun shadow map). Mesh shafts were removed — they always
  // read as polygons and could not track time-of-day properly.
  // Soft floating dust motes remain as cheap particulate atmosphere.
  addRangeDustMotes({ group, halfW });

  // ── CQB shoot-house: reception, corridor + flanking rooms, warehouse,
  //    hostage room, final office. Doorway gaps match RANGE_DOOR_SPECS. ──────
  buildInteriorLayout({ group, colliders, halfW });

  // ── Cover: room furniture (counters, shelving, desks) + pallets ──────────
  placeCover({ group, colliders });

  // ── Floor markings ───────────────────────────────────────────────────────
  addBox({
    group,
    colliders,
    name: 'Entry Stripe',
    cx: 0,
    cy: 0.03,
    cz: 1.2,
    sx: 4.5,
    sy: 0.03,
    sz: 0.4,
    material: dangerStripeMat,
    collider: false,
  });
  addBox({
    group,
    colliders,
    name: 'Finish Stripe',
    cx: 0,
    cy: 0.03,
    cz: COURSE_MAX_Z - 3,
    sx: 3.5,
    sy: 0.03,
    sz: 0.35,
    material: friendlyStripeMat,
    collider: false,
  });

  // ── Breach arrow decals (chevrons converging on each doorway) ─────────
  addBreachArrowDecals({ group });

  // Everything authored above is static. The trace that motivated this pass
  // showed 939 tiny meshes (617 shadow casters and 320 transparent objects) for
  // only ~15k triangles. Bake transforms and merge by material/render state so
  // color, SSAO-normal, and shadow passes submit a few batches instead.
  const staticGeometry = mergeStaticRangeGeometry(group);

  // Soft ambient only — window fill PointLights removed (post godrays + scene sun).
  const amb = new THREE.AmbientLight(0xc8b8a0, 0.08);
  group.add(amb);
  const hemi = new THREE.HemisphereLight(0xdde8ff, 0x3a2c1e, 0.22);
  hemi.position.set(0, 12, centerZ);
  group.add(hemi);

  const geometryIndex = createLevelGeometryIndex(group);
  const spawnPoint = new THREE.Vector3(0, FLOOR_Y, -2);
  const spawnYaw = 0;

  return {
    name: 'Shooting Range',
    group,
    colliders,
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex,
    spawnPoint,
    spawnYaw,
    rangeTargets: RANGE_TARGET_SPAWNS,
    materialFixtures: RANGE_MATERIAL_FIXTURES,
    rangeDoors: RANGE_DOOR_SPECS,
    rangeEnvironment: RANGE_ENVIRONMENT,
    isNearFieldReady: () => true,
    createPipelineWarmupGroup: () => createMaterialWarmupGroup(materials, 'Range Pipeline Warmup'),
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
    snapshot: () => ({
      mode: 'range',
      targets: RANGE_TARGET_SPAWNS.length,
      colliders: colliders.length,
      openRoof: false,
      clerestory: true,
      godRays: 'post',
      staticSourceMeshes: staticGeometry.sourceMeshes,
      staticBatches: staticGeometry.batches,
      fillLights: staticGeometry.pointLights,
    }),
    dispose: () => {
      disposeObject3D(group);
    },
  };
}

// ── Layout builders ────────────────────────────────────────────────────────

function addMaterialFixtureRow({ group, colliders }) {
  const halfW = HALL_WIDTH * 0.5;
  // Thin axis points into the bay; wide axis runs along the exterior wall.
  const panelDepth = 0.24;
  const panelWidth = 2.7;
  const panelHeight = 2.45;
  // Flush against the interior face of the boarded exterior walls.
  const wallInset = halfW - WALL_T * 0.5 - panelDepth * 0.5;

  for (const fixture of RANGE_MATERIAL_FIXTURES) {
    const side = fixture.side ?? -1;
    const x = side * wallInset;
    const z = fixture.z;
    addBox({
      group,
      colliders,
      name: `Material Fixture ${fixture.label}`,
      cx: x,
      cy: 1.3,
      cz: z,
      sx: panelDepth,
      sy: panelHeight,
      sz: panelWidth,
      material: fixture.material,
      collider: true,
      surfaceClass: fixture.surfaceClass,
    });
    // Label slightly inward from the panel face so it reads from the bay.
    const labelX = x - side * (panelDepth * 0.5 + 0.08);
    addMaterialFixtureLabel(group, fixture.label, labelX, z);
  }
}

function addMaterialFixtureLabel(group, text, x, z) {
  if (typeof document === 'undefined') return;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = 'rgba(13, 12, 10, 0.9)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#d7b363';
  context.lineWidth = 4;
  context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  context.fillStyle = '#f3e6c6';
  context.font = '700 28px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width * 0.5, canvas.height * 0.52);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  }));
  sprite.name = `Material Fixture Label ${text}`;
  sprite.position.set(x, 2.82, z);
  sprite.scale.set(2.15, 0.54, 1);
  sprite.renderOrder = 8;
  group.add(sprite);
}

function addExteriorWalls({ group, colliders, halfW, centerZ, length }) {
  // Solid brick shell only up to SOLID_WALL_H — clerestory sits above.
  for (const side of [-1, 1]) {
    const x = side * halfW;
    addBox({
      group,
      colliders,
      name: side < 0 ? 'West Wall Base' : 'East Wall Base',
      cx: x,
      cy: SOLID_WALL_H * 0.5,
      cz: centerZ,
      sx: WALL_T,
      sy: SOLID_WALL_H,
      sz: length + WALL_T * 2,
      material: brickWallMat,
      collider: true,
    });
    // Course relief on solid face (same brick map, slight offset for depth)
    for (let row = 0; row < 4; row += 1) {
      addBox({
        group,
        colliders,
        name: `Wall Board ${side}_${row}`,
        cx: x + side * 0.02,
        cy: 0.55 + row * 1.05,
        cz: centerZ,
        sx: WALL_T * 0.55,
        sy: 0.85,
        sz: length + WALL_T,
        material: brickWallMat,
        collider: false,
      });
    }
    // Header beam under clerestory
    addBox({
      group,
      colliders,
      name: `Clerestory Sill ${side}`,
      cx: x,
      cy: SOLID_WALL_H + 0.1,
      cz: centerZ,
      sx: WALL_T * 1.15,
      sy: 0.22,
      sz: length + WALL_T,
      material: darkTimberMat,
      collider: true,
      noGroundSnap: true,
    });
    // Top plate above windows
    addBox({
      group,
      colliders,
      name: `Wall Plate Beam ${side}`,
      cx: x,
      cy: WALL_PLATE_Y + 0.1,
      cz: centerZ,
      sx: WALL_T * 1.2,
      sy: 0.28,
      sz: length + WALL_T,
      material: beamMat,
      collider: true,
      noGroundSnap: true,
    });
  }

  addEndWall({
    group,
    colliders,
    z: COURSE_MIN_Z,
    name: 'South',
    doorW: 5.2,
    doorX: 0,
  });
  addEndWall({
    group,
    colliders,
    z: COURSE_MAX_Z,
    name: 'North',
    doorW: 4.4,
    doorX: 0,
  });
}

function addEndWall({ group, colliders, z, name, doorW, doorX }) {
  const halfW = HALL_WIDTH * 0.5;
  const leftMax = doorX - doorW * 0.5;
  const rightMin = doorX + doorW * 0.5;
  const leftW = leftMax - (-halfW);
  const rightW = halfW - rightMin;

  // Solid portion only to SOLID_WALL_H; clerestory glass is added separately.
  if (leftW > 0.25) {
    addBox({
      group,
      colliders,
      name: `${name} End Left`,
      cx: -halfW + leftW * 0.5,
      cy: SOLID_WALL_H * 0.5,
      cz: z,
      sx: leftW,
      sy: SOLID_WALL_H,
      sz: WALL_T,
      material: brickWallMat,
      collider: true,
    });
  }
  if (rightW > 0.25) {
    addBox({
      group,
      colliders,
      name: `${name} End Right`,
      cx: rightMin + rightW * 0.5,
      cy: SOLID_WALL_H * 0.5,
      cz: z,
      sx: rightW,
      sy: SOLID_WALL_H,
      sz: WALL_T,
      material: brickWallMat,
      collider: true,
    });
  }
  // Door lintel + posts
  addBox({
    group,
    colliders,
    name: `${name} Door Lintel`,
    cx: doorX,
    cy: 2.95 + (SOLID_WALL_H - 2.95) * 0.5,
    cz: z,
    sx: doorW + 0.4,
    sy: SOLID_WALL_H - 2.95,
    sz: WALL_T * 0.95,
    material: darkTimberMat,
    collider: true,
    noGroundSnap: true,
  });
  for (const sx of [doorX - doorW * 0.5, doorX + doorW * 0.5]) {
    addBox({
      group,
      colliders,
      name: `${name} Door Post`,
      cx: sx,
      cy: 1.55,
      cz: z,
      sx: 0.28,
      sy: 3.1,
      sz: WALL_T * 1.15,
      material: beamMat,
      collider: true,
    });
  }
  // End wall sill + plate across full width
  addBox({
    group,
    colliders,
    name: `${name} Clerestory Sill`,
    cx: 0,
    cy: SOLID_WALL_H + 0.1,
    cz: z,
    sx: HALL_WIDTH,
    sy: 0.22,
    sz: WALL_T * 1.1,
    material: darkTimberMat,
    collider: true,
    noGroundSnap: true,
  });
  addBox({
    group,
    colliders,
    name: `${name} Top Plate`,
    cx: 0,
    cy: WALL_PLATE_Y + 0.1,
    cz: z,
    sx: HALL_WIDTH,
    sy: 0.28,
    sz: WALL_T * 1.15,
    material: beamMat,
    collider: true,
    noGroundSnap: true,
  });
}

function addTimberFrame({ group, colliders, halfW }) {
  // Match roof-deck pitch so rafters / purlins / metal read as one structure.
  const rise = RIDGE_Y - WALL_PLATE_Y;
  const run = halfW;
  const rafterLen = Math.hypot(run, rise);
  // Pitch so outer (eave) is low and ridge is high.
  // side=+1 (east): rotation.z = -pitch; side=-1 (west): rotation.z = +pitch
  const pitch = Math.atan2(rise, run);
  // Collar height as a fraction of rise (eave → ridge). Inner posts stop here
  // so the horizontal collar beams rest on real columns, not mid-air.
  const collarT = 0.38;
  const collarY = WALL_PLATE_Y + rise * collarT;
  const collarHalfX = run * (1 - collarT); // rafter X at collar height
  const innerPostX = 4.5;

  for (let z = COURSE_MIN_Z + 4; z <= COURSE_MAX_Z - 4; z += POST_SPACING) {
    // Eave posts — carry the wall plate / rafter feet.
    for (const x of [-halfW + 0.55, halfW - 0.55]) {
      addPost({ group, colliders, x, z, h: WALL_PLATE_Y + 0.15, name: `Post ${x}_${z}` });
    }
    // Inner posts — every other bay, up to the collar so they hold the
    // horizontal cross-beam that ties the rafters.
    if (Math.round(z / POST_SPACING) % 2 === 0) {
      addPost({ group, colliders, x: -innerPostX, z, h: collarY + 0.12, name: `Inner Post L ${z}` });
      addPost({ group, colliders, x: innerPostX, z, h: collarY + 0.12, name: `Inner Post R ${z}` });
    }

    // Ridge beam segment
    addBox({
      group,
      colliders: null,
      name: `Ridge ${z}`,
      cx: 0,
      cy: RIDGE_Y,
      cz: z,
      sx: 0.32,
      sy: 0.36,
      sz: POST_SPACING * 0.92,
      material: beamMat,
      collider: false,
    });

    // Collar beam — horizontal, parallel to ground, rafter-to-rafter. Sits on
    // the inner posts (when present) and meets both rafters so it actually
    // ties the roof instead of floating under the ridge.
    addBox({
      group,
      colliders: null,
      name: `Collar ${z}`,
      cx: 0,
      cy: collarY,
      cz: z,
      sx: collarHalfX * 2 + 0.35,
      sy: 0.22,
      sz: 0.28,
      material: beamMat,
      collider: false,
    });

    // Main rafters — eave low, ridge high (pitch sign fixed)
    for (const side of [-1, 1]) {
      const midX = side * (run * 0.5);
      const midY = WALL_PLATE_Y + rise * 0.5;
      const rafter = new THREE.Mesh(
        prepareBoxGeometry(rafterLen, 0.22, 0.28, beamMat),
        beamMat,
      );
      rafter.name = `Rafter ${side}_${z}`;
      rafter.position.set(midX, midY, z);
      // Box spans local X; rotate so +X points toward ridge from eave:
      // west (side=-1): rotate +pitch (CCW) so left end drops; east: -pitch
      rafter.rotation.z = -side * pitch;
      rafter.castShadow = true;
      rafter.receiveShadow = true;
      group.add(rafter);

      // Web strut: wall-plate area up into the collar / rafter intersection.
      const strutLen = rafterLen * 0.4;
      const strut = new THREE.Mesh(
        prepareBoxGeometry(strutLen, 0.14, 0.16, beamMat),
        beamMat,
      );
      strut.name = `Strut ${side}_${z}`;
      const strutMidX = side * (run * (1 - collarT * 0.55) * 0.55);
      const strutMidY = WALL_PLATE_Y + rise * collarT * 0.55;
      strut.position.set(strutMidX, strutMidY, z);
      strut.rotation.z = -side * (pitch + 0.18);
      strut.castShadow = true;
      strut.receiveShadow = true;
      group.add(strut);
    }

    // King post: ridge down onto the collar (supported load path).
    addBox({
      group,
      colliders: null,
      name: `King ${z}`,
      cx: 0,
      cy: (collarY + RIDGE_Y) * 0.5,
      cz: z,
      sx: 0.2,
      sy: Math.max(0.4, RIDGE_Y - collarY - 0.1),
      sz: 0.2,
      material: beamMat,
      collider: false,
    });

    // Metal connector plate at ridge joint
    addBox({
      group,
      colliders: null,
      name: `Plate ${z}`,
      cx: 0,
      cy: RIDGE_Y - 0.22,
      cz: z,
      sx: 0.55,
      sy: 0.08,
      sz: 0.4,
      material: pillarMat,
      collider: false,
    });
  }

  // Continuous ridge beam
  addBox({
    group,
    colliders: null,
    name: 'Ridge Continuous',
    cx: 0,
    cy: RIDGE_Y + 0.05,
    cz: (COURSE_MIN_Z + COURSE_MAX_Z) * 0.5,
    sx: 0.28,
    sy: 0.22,
    sz: COURSE_MAX_Z - COURSE_MIN_Z - 2,
    material: beamMat,
    collider: false,
  });

  // Continuous longitudinal beams on the inner-post lines at collar height —
  // the posts hold these up; collars and purlins land on them.
  const centerZ = (COURSE_MIN_Z + COURSE_MAX_Z) * 0.5;
  const spanZ = COURSE_MAX_Z - COURSE_MIN_Z - 1.2;
  for (const side of [-1, 1]) {
    addBox({
      group,
      colliders: null,
      name: `Collar Rail ${side > 0 ? 'E' : 'W'}`,
      cx: side * innerPostX,
      cy: collarY,
      cz: centerZ,
      sx: 0.24,
      sy: 0.2,
      sz: spanZ,
      material: beamMat,
      collider: false,
    });
  }

  // Level purlins under the metal roof — rest on rafters, carry the deck.
  addRoofPurlins({ group, halfW, rise, run });
}

/**
 * Level steel purlins under the gable roof (constant Y, run along +Z).
 * Positioned on the same pitch line as the metal deck so they actually seat
 * the roof instead of floating in open air.
 *
 * Fractions are eave → ridge (0 = wall plate, 1 = ridge).
 */
function addRoofPurlins({ group, halfW, rise, run }) {
  const centerZ = (COURSE_MIN_Z + COURSE_MAX_Z) * 0.5;
  const spanZ = COURSE_MAX_Z - COURSE_MIN_Z - 1.2;
  // Two purlin lines per pitch between eave and ridge (collar rail handles mid).
  const fractions = [0.2, 0.62];
  const purlinW = 0.22;
  const purlinH = 0.18;
  // Deck centreline sits ~+0.12 above the ideal pitch; underside is a bit lower.
  // Seat purlin tops against that underside.
  const roofLift = 0.05;

  for (const side of [-1, 1]) {
    for (let i = 0; i < fractions.length; i += 1) {
      const t = fractions[i];
      // Same pitch line as rafters / metal deck (eave at |x|=run, ridge at 0).
      const x = side * run * (1 - t);
      const yRoof = WALL_PLATE_Y + rise * t + roofLift;
      const y = yRoof - purlinH * 0.5 - 0.04;
      addBox({
        group,
        colliders: null,
        name: `Roof Purlin ${side > 0 ? 'E' : 'W'}_${i}`,
        cx: x,
        cy: y,
        cz: centerZ,
        sx: purlinW,
        sy: purlinH,
        sz: spanZ,
        material: pillarMat,
        collider: false,
      });
    }
  }

  // Eave purlin on the wall plate — rafter feet land on this continuous rail.
  for (const side of [-1, 1]) {
    addBox({
      group,
      colliders: null,
      name: `Eave Purlin ${side > 0 ? 'E' : 'W'}`,
      cx: side * (halfW - 0.55),
      cy: WALL_PLATE_Y + 0.08,
      cz: centerZ,
      sx: 0.26,
      sy: 0.2,
      sz: spanZ,
      material: pillarMat,
      collider: false,
    });
  }
}

/**
 * Solid gable roof deck over both pitches (covered).
 */
function addCoveredRoof({ group, colliders, halfW, centerZ, length }) {
  // Same pitch line as rafters / purlins so the deck sits on the frame.
  const rise = RIDGE_Y - WALL_PLATE_Y;
  const run = halfW + 0.35; // slight eave overhang past the wall plate
  const pitch = Math.atan2(rise, halfW);
  const panelLen = Math.hypot(run, rise) + 0.25;
  const panelDepth = length + 1.2;

  for (const side of [-1, 1]) {
    const midX = side * (halfW * 0.5);
    // Slightly above the ideal pitch so purlin tops tuck under the deck.
    const midY = WALL_PLATE_Y + rise * 0.5 + 0.1;
    // Outer corrugated metal deck
    const deck = new THREE.Mesh(
      prepareBoxGeometry(panelLen, 0.14, panelDepth, roofMat, METAL_TEXTURE_TILE_M),
      roofMat,
    );
    deck.name = `Roof Deck ${side}`;
    deck.position.set(midX, midY, centerZ);
    deck.rotation.z = -side * pitch;
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    // Inside metal roof (slightly inset underside)
    const under = new THREE.Mesh(
      prepareBoxGeometry(panelLen * 0.98, 0.06, panelDepth * 0.98, roofUndersideMat, METAL_TEXTURE_TILE_M),
      roofUndersideMat,
    );
    under.name = `Roof Under ${side}`;
    under.position.set(midX, midY - 0.08, centerZ);
    under.rotation.z = -side * pitch;
    under.castShadow = false;
    under.receiveShadow = true;
    group.add(under);

    // Physics proxy (axis-aligned slab at mid height — good enough for bullets)
    colliders.push({
      name: `Roof Collider ${side}`,
      minX: side < 0 ? -halfW - 0.4 : 0.1,
      maxX: side < 0 ? -0.1 : halfW + 0.4,
      minZ: COURSE_MIN_Z - 0.5,
      maxZ: COURSE_MAX_Z + 0.5,
      bottomY: WALL_PLATE_Y + 0.4,
      topY: RIDGE_Y + 0.35,
      surfaceClass: 'metal',
      noGroundSnap: true,
    });
  }

  // Ridge cap
  addBox({
    group,
    colliders: null,
    name: 'Ridge Cap',
    cx: 0,
    cy: RIDGE_Y + 0.22,
    cz: centerZ,
    sx: 0.55,
    sy: 0.2,
    sz: panelDepth,
    material: pillarMat,
    collider: false,
  });

  // Gable end triangles (visual fill under roof at ends)
  for (const z of [COURSE_MIN_Z, COURSE_MAX_Z]) {
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(
        prepareBoxGeometry(halfW - 0.2, 0.16, WALL_T * 0.9, brickWallMat),
        brickWallMat,
      );
      panel.name = `Gable Fill ${side}_${z}`;
      panel.position.set(
        side * (halfW * 0.5),
        WALL_PLATE_Y + rise * 0.5,
        z,
      );
      panel.rotation.z = -side * pitch;
      panel.castShadow = true;
      group.add(panel);
    }
  }
}

/**
 * Large clerestory windows wrapping the top of all four walls.
 */
function addClerestoryWindows({ group, halfW, centerZ, length }) {
  const winY = SOLID_WALL_H + CLERESTORY_H * 0.5;
  const paneH = CLERESTORY_H - 0.35;
  const bay = 4.0; // window module along wall

  // Long walls (west / east)
  for (const side of [-1, 1]) {
    const x = side * (halfW - 0.02);
    for (let z = COURSE_MIN_Z + 2; z < COURSE_MAX_Z - 2; z += bay) {
      const span = Math.min(bay - 0.35, COURSE_MAX_Z - 2 - z);
      if (span < 1.2) continue;
      const cz = z + span * 0.5;

      // Glass pane
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, paneH, span),
        glassMat,
      );
      glass.name = `Clerestory Glass ${side}_${z}`;
      glass.position.set(x, winY, cz);
      glass.castShadow = false;
      glass.receiveShadow = false;
      group.add(glass);

      // Vertical mullions
      for (let m = 0; m <= 2; m += 1) {
        const mz = z + (span * m) / 2;
        addBox({
          group,
          colliders: null,
          name: `Mullion V ${side}_${mz}`,
          cx: x,
          cy: winY,
          cz: mz,
          sx: 0.1,
          sy: paneH + 0.1,
          sz: 0.1,
          material: mullionMat,
          collider: false,
        });
      }
      // Horizontal muntin
      addBox({
        group,
        colliders: null,
        name: `Muntin H ${side}_${z}`,
        cx: x,
        cy: winY,
        cz: cz,
        sx: 0.09,
        sy: 0.08,
        sz: span,
        material: mullionMat,
        collider: false,
      });
    }
  }

  // End walls (north / south) — gable-side clerestory strip
  for (const z of [COURSE_MIN_Z + 0.08, COURSE_MAX_Z - 0.08]) {
    for (let x0 = -halfW + 1.5; x0 < halfW - 1.5; x0 += bay) {
      const span = Math.min(bay - 0.35, halfW - 1.5 - x0);
      if (span < 1.0) continue;
      const cx = x0 + span * 0.5;
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(span, paneH, 0.06),
        glassMat,
      );
      glass.name = `Clerestory End ${z}_${cx}`;
      glass.position.set(cx, winY, z);
      glass.castShadow = false;
      group.add(glass);

      addBox({
        group,
        colliders: null,
        name: `End Mullion ${z}_${cx}`,
        cx,
        cy: winY,
        cz: z,
        sx: 0.1,
        sy: paneH + 0.1,
        sz: 0.1,
        material: mullionMat,
        collider: false,
      });
    }
  }
}

/**
 * Cheap floating dust in sun-lit volumes (god rays themselves are a post pass).
 * Uses fixed sun-bias directions only as placement seeds — not visible shafts.
 */
function addRangeDustMotes({ group, halfW }) {
  const dustGroup = new THREE.Group();
  dustGroup.name = 'Range Dust';
  group.add(dustGroup);

  const winY = SOLID_WALL_H + CLERESTORY_H * 0.55;
  const dir = SUN_DIR.clone().normalize();
  let seed = 11;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const geo = new THREE.SphereGeometry(0.035, 4, 3);

  for (const side of [-1, 1]) {
    const step = side < 0 ? POST_SPACING : POST_SPACING * 1.6;
    for (let z = COURSE_MIN_Z + 8; z < COURSE_MAX_Z - 8; z += step) {
      const origin = new THREE.Vector3(side * (halfW - 1.2), winY - 0.4, z);
      const localDir = dir.clone();
      localDir.x += -side * 0.35;
      localDir.normalize();
      const count = side < 0 ? 7 : 4;
      for (let i = 0; i < count; i += 1) {
        const t = 0.15 + rand() * 0.7;
        const mote = new THREE.Mesh(geo, dustMoteMat);
        mote.name = `Dust ${side}_${z}_${i}`;
        mote.position
          .copy(origin)
          .addScaledVector(localDir, t * 10)
          .add(new THREE.Vector3((rand() - 0.5) * 1.5, (rand() - 0.5) * 0.6, (rand() - 0.5) * 1.5));
        mote.scale.setScalar(0.4 + rand() * 1.0);
        mote.castShadow = false;
        mote.receiveShadow = false;
        mote.renderOrder = 24;
        dustGroup.add(mote);
      }
    }
  }
}

function addPost({ group, colliders, x, z, h, name }) {
  addBox({
    group,
    colliders,
    name,
    cx: x,
    cy: h * 0.5,
    cz: z,
    sx: 0.38,
    sy: h,
    sz: 0.38,
    material: pillarMat,
    collider: true,
    surfaceClass: 'metal',
  });
  // Collision ballast under the decorative base plate (thin, mostly covered).
  addBox({
    group,
    colliders,
    name: `${name} Base`,
    cx: x,
    cy: 0.08,
    cz: z,
    sx: 0.72,
    sy: 0.16,
    sz: 0.72,
    material: pillarMat,
    collider: true,
    surfaceClass: 'metal',
  });
  // Transparent pillar-end plate cards (alpha-cut atlas) at the foot of the post.
  addPillarEndMeshes(group, x, z, name);
}

/**
 * Two crossed double-sided cards of the pillar-end atlas at the post foot.
 * Alpha-tested so only the rust base plate + stump silhouette remains.
 */
function addPillarEndMeshes(group, x, z, name) {
  const w = 0.95;
  const h = 0.78;
  const geo = new THREE.PlaneGeometry(w, h);
  for (const [i, yaw] of [0, Math.PI * 0.5].entries()) {
    const mesh = new THREE.Mesh(geo, pillarEndMat);
    mesh.name = `${name} End ${i}`;
    mesh.position.set(x, h * 0.48, z);
    mesh.rotation.y = yaw;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 3;
    // Alpha cards must not join the opaque static merge batch.
    mesh.userData.skipLevelRaycast = true;
    group.add(mesh);
  }
}

/**
 * Place chevron-arrow floor decals on both sides of every breach door so the
 * arrows converge inward toward the doorway.
 *
 * For X-axis doors (cross walls spanning X, player walks through along Z):
 *   • South side (z < door.z): arrows should point toward +Z → use normal tex
 *   • North side (z > door.z): arrows should point toward −Z → use flipped tex
 * For Z-axis doors (side walls spanning Z, player walks through along X):
 *   • West side (x < door.x): arrows should point toward +X → use normal tex
 *   • East side (x > door.x): arrows should point toward −X → use flipped tex
 *
 * The SVG chevrons point to the right (+U). A PlaneGeometry lies flat (rotated
 * −90° about X) with local +X → world +X and local +Y → world +Z.
 * For X-axis doors the plane is additionally rotated 90° about Y so local +X
 * runs along world +Z and the chevrons follow the approach direction.
 */
const BREACH_DECAL_W = 1.8;
const BREACH_DECAL_D = 0.9;
const BREACH_DECAL_Y = 0.015;
const BREACH_DECAL_OFFSET = 1.2;

function addBreachArrowDecals({ group }) {
  const geo = new THREE.PlaneGeometry(BREACH_DECAL_W, BREACH_DECAL_D);
  for (const spec of RANGE_DOOR_SPECS) {
    if (spec.axis === 'x') {
      // Cross-wall door — decals straddle along Z.
      // South decal: arrows point +Z (toward door) → normal texture.
      const south = new THREE.Mesh(geo, breachArrowMat);
      south.name = `BreachArrow ${spec.id} S`;
      south.rotation.x = -Math.PI * 0.5;
      south.rotation.z = Math.PI * 0.5;
      south.position.set(spec.x, BREACH_DECAL_Y, spec.z - BREACH_DECAL_OFFSET);
      south.receiveShadow = true;
      south.castShadow = false;
      south.renderOrder = 2;
      south.userData.skipLevelRaycast = true;
      group.add(south);
      // North decal: arrows point −Z (toward door) → flipped texture.
      const north = new THREE.Mesh(geo, breachArrowFlippedMat);
      north.name = `BreachArrow ${spec.id} N`;
      north.rotation.x = -Math.PI * 0.5;
      north.rotation.z = Math.PI * 0.5;
      north.position.set(spec.x, BREACH_DECAL_Y, spec.z + BREACH_DECAL_OFFSET);
      north.receiveShadow = true;
      north.castShadow = false;
      north.renderOrder = 2;
      north.userData.skipLevelRaycast = true;
      group.add(north);
    } else {
      // Side-wall door — decals straddle along X.
      // West decal: arrows point +X (toward door) → normal texture.
      const west = new THREE.Mesh(geo, breachArrowMat);
      west.name = `BreachArrow ${spec.id} W`;
      west.rotation.x = -Math.PI * 0.5;
      west.position.set(spec.x - BREACH_DECAL_OFFSET, BREACH_DECAL_Y, spec.z);
      west.receiveShadow = true;
      west.castShadow = false;
      west.renderOrder = 2;
      west.userData.skipLevelRaycast = true;
      group.add(west);
      // East decal: arrows point −X (toward door) → flipped texture.
      const east = new THREE.Mesh(geo, breachArrowFlippedMat);
      east.name = `BreachArrow ${spec.id} E`;
      east.rotation.x = -Math.PI * 0.5;
      east.position.set(spec.x + BREACH_DECAL_OFFSET, BREACH_DECAL_Y, spec.z);
      east.receiveShadow = true;
      east.castShadow = false;
      east.renderOrder = 2;
      east.userData.skipLevelRaycast = true;
      group.add(east);
    }
  }
}

/**
 * CQB shoot-house layout. Rooms progress south → north as a real breach:
 *   Staging (z −8..12) → Reception (12..32) → Corridor + flanking Break/Records
 *   rooms (32..54) → Warehouse floor (54..78) → Hostage room (78..92) →
 *   Final office (92..108).
 * Each solid divider is punched with one doorway whose gap matches a
 * RANGE_DOOR_SPECS entry so the door system can drop a knockable leaf into it.
 */
function buildInteriorLayout({ group, colliders, halfW }) {
  const INNER = halfW - 0.4;
  const H = 3.6;

  // D1 — reception front wall (full width, centred door).
  addPartitionWall({
    group, colliders, x0: -INNER, x1: INNER, z: 12, h: H,
    doorX: 0, doorW: DOOR_W, material: woodWallMat,
  });

  // D2 — corridor mouth, then the corridor's two spine walls (z 32..54) each
  // with a side door into the flanking rooms.
  addPartitionWall({
    group, colliders, x0: -INNER, x1: INNER, z: 32, h: H,
    doorX: 0, doorW: DOOR_W, material: woodWall2Mat,
  });
  addZWallWithDoor({
    group, colliders, x: -2.8, z0: 32, z1: 54, doorZ: 44, doorW: DOOR_W_SIDE,
    h: H, material: woodWallMat,
  });
  addZWallWithDoor({
    group, colliders, x: 2.8, z0: 32, z1: 54, doorZ: 44, doorW: DOOR_W_SIDE,
    h: H, material: woodWall2Mat,
  });

  // D3 — warehouse floor threshold (slightly wider single leaf).
  addPartitionWall({
    group, colliders, x0: -INNER, x1: INNER, z: 54, h: H + 0.3,
    doorX: 0, doorW: DOOR_W_WAREHOUSE, material: woodWallMat,
  });

  // D4 — hostage room (door pushed off-centre so entry is an angled cut).
  addPartitionWall({
    group, colliders, x0: -INNER, x1: INNER, z: 78, h: H,
    doorX: -4, doorW: DOOR_W, material: woodWall2Mat,
  });

  // D5 — final office.
  addPartitionWall({
    group, colliders, x0: -INNER, x1: INNER, z: 92, h: H,
    doorX: 4, doorW: DOOR_W, material: woodWallMat,
  });
}

/**
 * Wall running along +Z at constant x, with a doorway gap centred on doorZ.
 * Mirror of addPartitionWall for the corridor's side walls.
 */
function addZWallWithDoor({ group, colliders, x, z0, z1, doorZ, doorW, h, material }) {
  const leftMax = doorZ - doorW * 0.5;
  const rightMin = doorZ + doorW * 0.5;
  if (leftMax > z0 + 0.2) {
    const d = leftMax - z0;
    addBox({
      group, colliders, name: `ZWall ${x}_${z0}`,
      cx: x, cy: h * 0.5, cz: z0 + d * 0.5,
      sx: WALL_T * 0.9, sy: h, sz: d, material, collider: true,
    });
  }
  if (rightMin < z1 - 0.2) {
    const d = z1 - rightMin;
    addBox({
      group, colliders, name: `ZWall ${x}_${z1}`,
      cx: x, cy: h * 0.5, cz: rightMin + d * 0.5,
      sx: WALL_T * 0.9, sy: h, sz: d, material, collider: true,
    });
  }
  addBox({
    group, colliders, name: `ZWall Lintel ${x}_${doorZ}`,
    cx: x, cy: DOOR_CLEAR_H + (h - DOOR_CLEAR_H) * 0.5, cz: doorZ,
    sx: WALL_T * 0.85, sy: Math.max(0.3, h - DOOR_CLEAR_H), sz: doorW + 0.2,
    material: darkTimberMat, collider: true, noGroundSnap: true,
  });
}


function addPartitionWall({
  group, colliders, x0, x1, z, h, doorX = null, doorW = DOOR_W, material = woodWallMat,
}) {
  const mid = (x0 + x1) * 0.5;
  const fullW = x1 - x0;
  if (fullW < 0.3) return;
  const wallMat = material || woodWallMat;

  if (doorX == null || doorX < x0 || doorX > x1) {
    addBox({
      group,
      colliders,
      name: `Partition ${z}_${x0}`,
      cx: mid,
      cy: h * 0.5,
      cz: z,
      sx: fullW,
      sy: h,
      sz: WALL_T * 0.9,
      material: wallMat,
      collider: true,
    });
    return;
  }

  const leftMax = doorX - doorW * 0.5;
  const rightMin = doorX + doorW * 0.5;
  if (leftMax > x0 + 0.2) {
    const w = leftMax - x0;
    addBox({
      group,
      colliders,
      name: `Partition L ${z}`,
      cx: x0 + w * 0.5,
      cy: h * 0.5,
      cz: z,
      sx: w,
      sy: h,
      sz: WALL_T * 0.9,
      material: wallMat,
      collider: true,
    });
  }
  if (rightMin < x1 - 0.2) {
    const w = x1 - rightMin;
    addBox({
      group,
      colliders,
      name: `Partition R ${z}`,
      cx: rightMin + w * 0.5,
      cy: h * 0.5,
      cz: z,
      sx: w,
      sy: h,
      sz: WALL_T * 0.9,
      material: wallMat,
      collider: true,
    });
  }
  // Lintel sits just above the tall door leaf clear height.
  addBox({
    group,
    colliders,
    name: `Partition Lintel ${z}`,
    cx: doorX,
    cy: DOOR_CLEAR_H + (h - DOOR_CLEAR_H) * 0.5,
    cz: z,
    sx: doorW + 0.2,
    sy: Math.max(0.3, h - DOOR_CLEAR_H),
    sz: WALL_T * 0.85,
    material: darkTimberMat,
    collider: true,
    noGroundSnap: true,
  });
}

function placeCover({ group, colliders }) {
  const furniture = [
    // Staging bay — a couple of shipping crates to break up the empty approach.
    { name: 'Staging Crate L', x: -9.5, z: 4, w: 1.6, d: 1.4, h: 1.3, mat: crateMat },
    { name: 'Staging Crate R', x: 9.0, z: 6, w: 1.8, d: 1.3, h: 1.1, mat: crateMat },

    // Reception — front counter (cover in front of the desk shooter), a filing
    // cabinet east, a low bench by the west-corner civilian.
    { name: 'Reception Counter', x: -2, z: 25, w: 9, d: 0.7, h: 1.05, mat: plankMat },
    { name: 'Reception Cabinet', x: 11.6, z: 24, w: 1.6, d: 0.7, h: 1.5, mat: metalMat },
    { name: 'Reception Bench', x: -12, z: 21, w: 1.0, d: 2.6, h: 0.5, mat: crateMat },

    // West break room — table + wall lockers.
    { name: 'Break Table', x: -9, z: 45, w: 2.6, d: 1.2, h: 0.9, mat: plankMat },
    { name: 'Break Lockers', x: -13, z: 39, w: 0.6, d: 3.4, h: 2.0, mat: metalMat },

    // East records room — tall shelving row + work table.
    { name: 'Records Shelf', x: 12, z: 40, w: 0.6, d: 4.4, h: 2.2, mat: darkTimberMat },
    { name: 'Records Table', x: 6, z: 50, w: 3.0, d: 0.7, h: 0.95, mat: plankMat },

    // Warehouse floor — shelving lanes; the west shelf half-masks the worker so
    // the player has to positively ID before firing.
    { name: 'Ware Shelf A', x: -6, z: 60, w: 3.2, d: 0.7, h: 2.2, mat: darkTimberMat },
    { name: 'Ware Shelf B', x: 6, z: 64, w: 3.2, d: 0.7, h: 2.2, mat: darkTimberMat },
    { name: 'Ware Shelf C', x: -9, z: 73, w: 0.7, d: 3.2, h: 2.0, mat: darkTimberMat },
    { name: 'Ware Shelf D', x: 10, z: 68, w: 0.7, d: 3.2, h: 2.0, mat: darkTimberMat },
    { name: 'Ware Crate 1', x: -1, z: 62, w: 1.5, d: 1.4, h: 1.0, mat: crateMat },
    { name: 'Ware Crate 2', x: 3, z: 72, w: 1.6, d: 1.4, h: 1.3, mat: crateMat },

    // Hostage room — a single crate by the flanker; the sightline to the hostage
    // stays open from the offset doorway.
    { name: 'Hostage Crate', x: -10.5, z: 82, w: 1.6, d: 1.4, h: 1.2, mat: crateMat },

    // Final office — desks (the east desk shields the surrendering civilian) and
    // a back-wall cabinet.
    { name: 'Office Desk W', x: -6, z: 101, w: 2.6, d: 1.1, h: 0.95, mat: plankMat },
    { name: 'Office Desk E', x: 9.3, z: 97.5, w: 2.4, d: 1.0, h: 0.95, mat: plankMat },
    { name: 'Office Desk C', x: 0, z: 105, w: 2.6, d: 1.1, h: 0.95, mat: plankMat },
    { name: 'Office Cabinet', x: -12.4, z: 104, w: 0.7, d: 2.6, h: 1.6, mat: metalMat },
  ];

  for (const f of furniture) {
    addBox({
      group,
      colliders,
      name: f.name,
      cx: f.x,
      cy: f.h * 0.5,
      cz: f.z,
      sx: f.w,
      sy: f.h,
      sz: f.d,
      material: f.mat,
      collider: true,
    });
  }

  // A few low pallet stacks scattered for silhouette variety (visual planks over
  // one combined low collider).
  const pallets = [
    { x: -12, z: 6 }, { x: 12, z: 58 }, { x: -12, z: 96 },
  ];
  for (let i = 0; i < pallets.length; i += 1) {
    const p = pallets[i];
    for (let layer = 0; layer < 3; layer += 1) {
      addBox({
        group,
        colliders: null,
        name: `Pallet ${i}_${layer}`,
        cx: p.x,
        cy: 0.1 + layer * 0.22,
        cz: p.z,
        sx: 1.35,
        sy: 0.14,
        sz: 1.15,
        material: palletMat,
        collider: false,
      });
    }
    colliders.push({
      name: `Pallet Stack ${i}`,
      minX: p.x - 0.7,
      maxX: p.x + 0.7,
      minZ: p.z - 0.6,
      maxZ: p.z + 0.6,
      bottomY: 0,
      topY: 0.7,
    });
  }
}

function ensureAoUv2(geometry) {
  // aoMap samples uv2; BoxGeometry only has uv — duplicate for PBR wall materials.
  if (!geometry?.attributes?.uv || geometry.attributes.uv2) return geometry;
  geometry.setAttribute('uv2', geometry.attributes.uv.clone());
  return geometry;
}

/**
 * BoxGeometry maps every face to UV 0–1 regardless of world size, so a 100×5 m
 * wall stretches the texture ~20× horizontally. Rescale each face's UVs by
 * face meters / tileMeters so tiles stay square in world space.
 *
 * Face order matches three.js BoxGeometry: +X, −X, +Y, −Y, +Z, −Z (4 verts each).
 */
function applyWorldSpaceBoxUVs(geometry, sx, sy, sz, tileMeters = WALL_TEXTURE_TILE_M) {
  const uv = geometry.getAttribute('uv');
  if (!uv || uv.count < 24) return geometry;
  const tile = Math.max(Number(tileMeters) || WALL_TEXTURE_TILE_M, 1e-3);
  // Face width × height in local meters for each of the six sides.
  const faceDims = [
    [sz, sy], // +X
    [sz, sy], // −X
    [sx, sz], // +Y
    [sx, sz], // −Y
    [sx, sy], // +Z
    [sx, sy], // −Z
  ];
  for (let f = 0; f < 6; f += 1) {
    const su = Math.max(faceDims[f][0], 1e-4) / tile;
    const sv = Math.max(faceDims[f][1], 1e-4) / tile;
    for (let i = 0; i < 4; i += 1) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Build a box for range meshes. PBR wall materials get world-space UVs + uv2 for aoMap.
 * Non-PBR materials stay on default UVs so they still merge with raw BoxGeometry siblings.
 */
function prepareBoxGeometry(sx, sy, sz, material, tileMeters = null) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  if (material?.map || material?.aoMap || material?.normalMap) {
    const tile = tileMeters
      ?? (material === pillarMat || material === roofMat || material === roofUndersideMat
        ? METAL_TEXTURE_TILE_M
        : WALL_TEXTURE_TILE_M);
    applyWorldSpaceBoxUVs(geometry, sx, sy, sz, tile);
  }
  if (material?.aoMap) ensureAoUv2(geometry);
  return geometry;
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
}) {
  const mesh = new THREE.Mesh(prepareBoxGeometry(sx, sy, sz, material), material);
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
      surfaceClass: surfaceClass ?? rangeSurfaceForMaterial(material),
      ...(noGroundSnap ? { noGroundSnap: true } : {}),
    });
  }
  return mesh;
}

function rangeSurfaceForMaterial(material) {
  if ([plankMat, woodWallMat, woodWall2Mat, crateMat, palletMat].includes(material)) {
    return 'wood';
  }
  if ([
    metalMat, mullionMat, pillarMat, beamMat, darkTimberMat,
    roofMat, roofUndersideMat, pillarEndMat,
    dangerStripeMat, friendlyStripeMat,
  ].includes(material)) {
    return 'metal';
  }
  if (material === glassMat) return 'glass';
  return 'concrete';
}

/**
 * Merge the range's immutable meshes by material + render state. Transforms are
 * baked into each cloned geometry, leaving one identity mesh per batch. The
 * gameplay AABB colliders are separate data and remain unchanged.
 */
function mergeStaticRangeGeometry(root) {
  root.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const relative = new THREE.Matrix4();
  const meshes = [];
  const pointLights = [];
  const batches = new Map();

  root.traverse((object) => {
    if (object.isPointLight) pointLights.push(object);
    if (!object.isMesh || object.isSkinnedMesh || !object.geometry?.isBufferGeometry) return;
    if (Array.isArray(object.material) || !object.material) return;

    meshes.push(object);
    const skipLevelRaycast = object.material.transparent === true
      || object.userData?.skipLevelRaycast === true;
    const key = [
      object.material.uuid,
      object.castShadow === true ? 1 : 0,
      object.receiveShadow === true ? 1 : 0,
      object.renderOrder ?? 0,
      object.layers.mask,
      skipLevelRaycast ? 1 : 0,
    ].join(':');
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        material: object.material,
        castShadow: object.castShadow === true,
        receiveShadow: object.receiveShadow === true,
        renderOrder: object.renderOrder ?? 0,
        layerMask: object.layers.mask,
        skipLevelRaycast,
        geometries: [],
      };
      batches.set(key, batch);
    }

    relative.multiplyMatrices(rootInverse, object.matrixWorld);
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(relative);
    batch.geometries.push(geometry);
  });

  // Align attribute sets within each batch (e.g. uv2 only on some boxes) so
  // mergeGeometries does not fail on mismatched attribute counts.
  for (const batch of batches.values()) {
    if (batch.geometries.length < 2) continue;
    const common = new Set(Object.keys(batch.geometries[0].attributes));
    for (let i = 1; i < batch.geometries.length; i += 1) {
      const names = new Set(Object.keys(batch.geometries[i].attributes));
      for (const name of [...common]) {
        if (!names.has(name)) common.delete(name);
      }
    }
    for (const geometry of batch.geometries) {
      for (const name of Object.keys(geometry.attributes)) {
        if (!common.has(name)) geometry.deleteAttribute(name);
      }
    }
  }

  const mergedMeshes = [];
  for (const batch of batches.values()) {
    let geometry = null;
    try {
      geometry = batch.geometries.length === 1
        ? batch.geometries[0]
        : mergeGeometries(batch.geometries, false);
    } catch {
      geometry = null;
    }
    if (!geometry) {
      for (const candidate of batch.geometries) candidate.dispose();
      throw new Error('[ShootingRange] failed to merge a static geometry batch');
    }
    if (batch.geometries.length > 1) {
      for (const candidate of batch.geometries) candidate.dispose();
    }

    const mesh = new THREE.Mesh(geometry, batch.material);
    mesh.name = `Range Static Batch ${mergedMeshes.length + 1}`;
    mesh.castShadow = batch.castShadow;
    mesh.receiveShadow = batch.receiveShadow;
    mesh.renderOrder = batch.renderOrder;
    mesh.layers.mask = batch.layerMask;
    mesh.userData.skipLevelRaycast = batch.skipLevelRaycast;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.static = true;
    mergedMeshes.push(mesh);
  }

  // Dispose each source geometry once; dust motes within a shaft share theirs.
  const sourceGeometries = new Set(meshes.map((mesh) => mesh.geometry));
  for (const mesh of meshes) mesh.removeFromParent();
  for (const geometry of sourceGeometries) geometry.dispose();
  for (const mesh of mergedMeshes) root.add(mesh);

  return {
    sourceMeshes: meshes.length,
    batches: mergedMeshes.length,
    pointLights: pointLights.length,
  };
}
