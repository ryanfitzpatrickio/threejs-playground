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

// Sliced PBR sets (from 2×2 atlas sheets brickwall/woodwall/woodwall2.png).
// Texture.repeat stays 1×1 — world-space box UVs in prepareBoxGeometry set
// tile density so long walls do not stretch the pattern horizontally.
/** Meters covered by one full albedo tile (keep brick/wood roughly square). */
const WALL_TEXTURE_TILE_M = 2.8;
const brickPbr = loadRangePbrSet('brickwall', { repeatX: 1, repeatY: 1 });
const woodPbr = loadRangePbrSet('woodwall', { repeatX: 1, repeatY: 1 });
const wood2Pbr = loadRangePbrSet('woodwall2', { repeatX: 1, repeatY: 1 });

// Warm weathered wood palette — MeshStandard picks up scene.environment (PMREM sky).
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x6e5438,
  roughness: 0.88,
  metalness: 0.04,
  envMapIntensity: 0.55,
});
const plankMat = new THREE.MeshStandardMaterial({
  color: 0x7a5c3c,
  roughness: 0.84,
  metalness: 0.05,
  envMapIntensity: 0.6,
});
const darkTimberMat = new THREE.MeshStandardMaterial({
  color: 0x3f2c1a,
  roughness: 0.78,
  metalness: 0.06,
  envMapIntensity: 0.7,
});
const beamMat = new THREE.MeshStandardMaterial({
  color: 0x4a3420,
  roughness: 0.72,
  metalness: 0.08,
  envMapIntensity: 0.85,
});
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
const metalMat = new THREE.MeshStandardMaterial({
  color: 0x5a5c60,
  roughness: 0.42,
  metalness: 0.65,
  envMapIntensity: 1.25,
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
const roofMat = new THREE.MeshStandardMaterial({
  color: 0x4a4036,
  roughness: 0.78,
  metalness: 0.12,
  envMapIntensity: 0.75,
});
const roofUndersideMat = new THREE.MeshStandardMaterial({
  color: 0x5c4832,
  roughness: 0.9,
  metalness: 0.04,
  envMapIntensity: 0.45,
  side: THREE.BackSide,
});
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
const mullionMat = new THREE.MeshStandardMaterial({
  color: 0x2e2a24,
  roughness: 0.55,
  metalness: 0.35,
  envMapIntensity: 0.9,
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
 * Layout scaled for the enlarged timber warehouse.
 */
export const RANGE_TARGET_SPAWNS = [
  // Bay A — entry loading
  { id: 'a-h1', x: -8.5, z: 10, yaw: Math.PI, friendly: false },
  { id: 'a-h2', x: 7.2, z: 14, yaw: Math.PI * 0.95, friendly: false },
  { id: 'a-f1', x: 0.5, z: 18, yaw: Math.PI, friendly: true },
  { id: 'a-h3', x: -4.0, z: 22, yaw: Math.PI * 1.05, friendly: false },
  // West alcove A
  { id: 'aw-h1', x: -11.5, z: 16, yaw: Math.PI * 0.5, friendly: false },
  { id: 'aw-f1', x: -10.8, z: 24, yaw: Math.PI * 0.45, friendly: true },
  // East alcove A
  { id: 'ae-h1', x: 11.2, z: 20, yaw: -Math.PI * 0.5, friendly: false },
  // Split corridor
  { id: 's-h1', x: -6.0, z: 34, yaw: Math.PI, friendly: false },
  { id: 's-h2', x: 5.5, z: 38, yaw: Math.PI * 0.9, friendly: false },
  { id: 's-f1', x: 2.0, z: 42, yaw: Math.PI, friendly: true },
  { id: 's-h3', x: -9.5, z: 44, yaw: Math.PI * 0.55, friendly: false },
  { id: 's-h4', x: 10.0, z: 46, yaw: -Math.PI * 0.55, friendly: false },
  // Storage maze
  { id: 'm-h1', x: -8.0, z: 56, yaw: Math.PI * 0.85, friendly: false },
  { id: 'm-h2', x: 3.5, z: 58, yaw: Math.PI, friendly: false },
  { id: 'm-f1', x: -2.5, z: 62, yaw: Math.PI * 1.1, friendly: true },
  { id: 'm-h3', x: 9.0, z: 60, yaw: -Math.PI * 0.7, friendly: false },
  { id: 'm-h4', x: -11.0, z: 66, yaw: Math.PI * 0.5, friendly: false },
  { id: 'm-h5', x: 6.5, z: 68, yaw: Math.PI * 1.15, friendly: false },
  { id: 'm-f2', x: 11.5, z: 64, yaw: -Math.PI * 0.4, friendly: true },
  // Cross hall / side bays
  { id: 'c-h1', x: -4.0, z: 78, yaw: Math.PI, friendly: false },
  { id: 'c-h2', x: 8.0, z: 80, yaw: Math.PI * 0.9, friendly: false },
  { id: 'c-f1', x: 0.0, z: 84, yaw: Math.PI, friendly: true },
  { id: 'c-h3', x: -10.5, z: 82, yaw: Math.PI * 0.5, friendly: false },
  { id: 'c-h4', x: 11.0, z: 86, yaw: -Math.PI * 0.55, friendly: false },
  // Final chamber
  { id: 'f-h1', x: -7.0, z: 94, yaw: Math.PI, friendly: false },
  { id: 'f-h2', x: 5.5, z: 96, yaw: Math.PI * 0.95, friendly: false },
  { id: 'f-h3', x: 0.2, z: 100, yaw: Math.PI, friendly: false },
  { id: 'f-f1', x: 9.5, z: 98, yaw: -Math.PI * 0.65, friendly: true },
  { id: 'f-h4', x: -10.0, z: 102, yaw: Math.PI * 0.4, friendly: false },
  { id: 'f-h5', x: 3.0, z: 104, yaw: Math.PI * 1.05, friendly: false },
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
  timeOfDay: 0.42,
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
    floorMat, plankMat, darkTimberMat, beamMat,
    brickWallMat, woodWallMat, woodWall2Mat,
    crateMat, palletMat, metalMat, dangerStripeMat, friendlyStripeMat,
    roofMat, roofUndersideMat, glassMat, mullionMat, dustMoteMat,
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
  });
  addFloorPlanks({ group, halfW, minZ: COURSE_MIN_Z, maxZ: COURSE_MAX_Z });

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

  // ── Intricate interior: bays, split corridor, maze, cross-hall ───────────
  buildInteriorLayout({ group, colliders, halfW });

  // ── Cover: crates, pallets, timber stacks ────────────────────────────────
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

function addFloorPlanks({ group, halfW, minZ, maxZ }) {
  // Visual decking strips (no colliders — slab handles walk).
  const plankW = 0.42;
  let x = -halfW + 0.35;
  let i = 0;
  while (x < halfW - 0.3) {
    const mat = i % 3 === 0 ? darkTimberMat : plankMat;
    addBox({
      group,
      colliders: null,
      name: `Deck Plank ${i}`,
      cx: x,
      cy: 0.015,
      cz: (minZ + maxZ) * 0.5,
      sx: plankW * 0.92,
      sy: 0.03,
      sz: maxZ - minZ - 0.4,
      material: mat,
      collider: false,
    });
    x += plankW;
    i += 1;
  }
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
  const rise = RIDGE_Y - WALL_PLATE_Y;
  const run = halfW - 0.35;
  const rafterLen = Math.hypot(run, rise);
  // Pitch so outer (eave) is low and ridge is high.
  // side=+1 (east): rotation.z = -pitch; side=-1 (west): rotation.z = +pitch
  const pitch = Math.atan2(rise, run);

  for (let z = COURSE_MIN_Z + 4; z <= COURSE_MAX_Z - 4; z += POST_SPACING) {
    for (const x of [-halfW + 0.55, halfW - 0.55]) {
      addPost({ group, colliders, x, z, h: WALL_PLATE_Y + 0.15, name: `Post ${x}_${z}` });
    }
    if (Math.round(z / POST_SPACING) % 2 === 0) {
      addPost({ group, colliders, x: -4.5, z, h: SOLID_WALL_H + 0.2, name: `Inner Post L ${z}` });
      addPost({ group, colliders, x: 4.5, z, h: SOLID_WALL_H + 0.2, name: `Inner Post R ${z}` });
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

    // Collar tie below ridge (horizontal)
    addBox({
      group,
      colliders: null,
      name: `Collar ${z}`,
      cx: 0,
      cy: WALL_PLATE_Y + rise * 0.42,
      cz: z,
      sx: HALL_WIDTH * 0.55,
      sy: 0.2,
      sz: 0.26,
      material: darkTimberMat,
      collider: false,
    });

    // Main rafters — eave low, ridge high (pitch sign fixed)
    for (const side of [-1, 1]) {
      const midX = side * (run * 0.5);
      const midY = WALL_PLATE_Y + rise * 0.5;
      const rafter = new THREE.Mesh(
        new THREE.BoxGeometry(rafterLen, 0.2, 0.26),
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

      // Angle strut (web) from wall plate up toward ridge — not inverted
      const strutLen = rafterLen * 0.42;
      const strut = new THREE.Mesh(
        new THREE.BoxGeometry(strutLen, 0.14, 0.16),
        darkTimberMat,
      );
      strut.name = `Strut ${side}_${z}`;
      // Sits under the rafter, from ~1/4 span up to collar line
      const strutMidX = side * (run * 0.32);
      const strutMidY = WALL_PLATE_Y + rise * 0.28;
      strut.position.set(strutMidX, strutMidY, z);
      // Steeper than rafter, still eave-low → ridge-high
      strut.rotation.z = -side * (pitch + 0.22);
      strut.castShadow = true;
      strut.receiveShadow = true;
      group.add(strut);
    }

    // King post under ridge
    addBox({
      group,
      colliders: null,
      name: `King ${z}`,
      cx: 0,
      cy: (WALL_PLATE_Y + rise * 0.42 + RIDGE_Y) * 0.5,
      cz: z,
      sx: 0.18,
      sy: (RIDGE_Y - (WALL_PLATE_Y + rise * 0.42)) * 0.9,
      sz: 0.18,
      material: darkTimberMat,
      collider: false,
    });

    // Metal connector plate
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
      material: metalMat,
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
}

/**
 * Solid gable roof deck over both pitches (covered).
 */
function addCoveredRoof({ group, colliders, halfW, centerZ, length }) {
  const rise = RIDGE_Y - WALL_PLATE_Y;
  const run = halfW + 0.45;
  const pitch = Math.atan2(rise, halfW);
  const panelLen = Math.hypot(run, rise) + 0.3;
  const panelDepth = length + 1.2;

  for (const side of [-1, 1]) {
    const midX = side * (halfW * 0.5);
    const midY = WALL_PLATE_Y + rise * 0.5 + 0.12;
    // Outer deck
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(panelLen, 0.14, panelDepth),
      roofMat,
    );
    deck.name = `Roof Deck ${side}`;
    deck.position.set(midX, midY, centerZ);
    deck.rotation.z = -side * pitch;
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    // Underside planking (slightly inset)
    const under = new THREE.Mesh(
      new THREE.BoxGeometry(panelLen * 0.98, 0.06, panelDepth * 0.98),
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
    material: metalMat,
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
    material: darkTimberMat,
    collider: true,
  });
  // Base block
  addBox({
    group,
    colliders,
    name: `${name} Base`,
    cx: x,
    cy: 0.12,
    cz: z,
    sx: 0.7,
    sy: 0.24,
    sz: 0.7,
    material: beamMat,
    collider: true,
  });
}

function buildInteriorLayout({ group, colliders, halfW }) {
  // Bay A partial dividers (z ~ 12–28) — interior wood walls
  addPartitionWall({
    group, colliders,
    x0: -halfW + 0.4, x1: -3.2, z: 28, h: 3.4, door: null,
    material: woodWallMat,
  });
  addPartitionWall({
    group, colliders,
    x0: 3.5, x1: halfW - 0.4, z: 28, h: 3.4, door: null,
    material: woodWall2Mat,
  });
  // Center doorway gap at z=28 remains open (−3.2..3.5)

  // West storage alcove walls
  addPartitionWall({
    group, colliders,
    x0: -halfW + 0.4, x1: -halfW + 5.5, z: 18, h: 3.0,
    material: woodWallMat,
  });
  addBox({
    group,
    colliders,
    name: 'West Alcove Side',
    cx: -halfW + 5.5,
    cy: 1.5,
    cz: 21,
    sx: 0.28,
    sy: 3.0,
    sz: 6.5,
    material: woodWall2Mat,
    collider: true,
  });

  // East storage alcove
  addBox({
    group,
    colliders,
    name: 'East Alcove Side',
    cx: halfW - 5.2,
    cy: 1.55,
    cz: 22,
    sx: 0.28,
    sy: 3.1,
    sz: 8.0,
    material: woodWallMat,
    collider: true,
  });

  // Split corridor spine (z 32–50) with staggered openings
  addBox({
    group,
    colliders,
    name: 'Spine Wall North',
    cx: -1.2,
    cy: 1.7,
    cz: 36,
    sx: 0.3,
    sy: 3.4,
    sz: 10,
    material: woodWallMat,
    collider: true,
  });
  addBox({
    group,
    colliders,
    name: 'Spine Wall South',
    cx: 1.8,
    cy: 1.7,
    cz: 46,
    sx: 0.3,
    sy: 3.4,
    sz: 10,
    material: woodWall2Mat,
    collider: true,
  });
  // Cross walls with doors
  addPartitionWall({
    group, colliders,
    x0: -halfW + 0.5, x1: -1.4, z: 41, h: 3.2, doorX: -7, doorW: 2.4,
    material: woodWallMat,
  });
  addPartitionWall({
    group, colliders,
    x0: 2.0, x1: halfW - 0.5, z: 41, h: 3.2, doorX: 7.5, doorW: 2.4,
    material: woodWall2Mat,
  });

  // Storage maze (z 52–72)
  const mazeWalls = [
    { cx: -6, cz: 54, sx: 10, sz: 0.3, h: 3.0 },
    { cx: 5, cz: 54, sx: 8, sz: 0.3, h: 3.0 },
    { cx: -3, cz: 58, sx: 0.3, sz: 7, h: 3.1 },
    { cx: 4, cz: 60, sx: 0.3, sz: 8, h: 3.1 },
    { cx: -9, cz: 62, sx: 0.3, sz: 6, h: 2.9 },
    { cx: 9, cz: 63, sx: 0.3, sz: 7, h: 2.9 },
    { cx: -5, cz: 66, sx: 9, sz: 0.3, h: 3.0 },
    { cx: 6, cz: 68, sx: 10, sz: 0.3, h: 3.0 },
    { cx: 0, cz: 70, sx: 0.3, sz: 5.5, h: 3.2 },
  ];
  for (let i = 0; i < mazeWalls.length; i += 1) {
    const w = mazeWalls[i];
    addBox({
      group,
      colliders,
      name: `Maze Wall ${i}`,
      cx: w.cx,
      cy: w.h * 0.5,
      cz: w.cz,
      sx: w.sx,
      sy: w.h,
      sz: w.sz,
      material: i % 2 === 0 ? woodWallMat : woodWall2Mat,
      collider: true,
    });
  }

  // Cross-hall partial walls (z 74–90)
  addPartitionWall({
    group, colliders,
    x0: -halfW + 0.5, x1: -2.5, z: 76, h: 3.3, doorX: -8, doorW: 2.6,
    material: woodWall2Mat,
  });
  addPartitionWall({
    group, colliders,
    x0: 2.5, x1: halfW - 0.5, z: 76, h: 3.3, doorX: 8, doorW: 2.6,
    material: woodWallMat,
  });
  addBox({
    group,
    colliders,
    name: 'Cross Bay West',
    cx: -halfW + 4.5,
    cy: 1.45,
    cz: 84,
    sx: 0.28,
    sy: 2.9,
    sz: 9,
    material: woodWallMat,
    collider: true,
  });
  addBox({
    group,
    colliders,
    name: 'Cross Bay East',
    cx: halfW - 4.5,
    cy: 1.45,
    cz: 85,
    sx: 0.28,
    sy: 2.9,
    sz: 10,
    material: woodWall2Mat,
    collider: true,
  });

  // Final chamber threshold
  addPartitionWall({
    group, colliders,
    x0: -halfW + 0.5, x1: -2.8, z: 92, h: 3.5, door: null,
    material: woodWallMat,
  });
  addPartitionWall({
    group, colliders,
    x0: 2.8, x1: halfW - 0.5, z: 92, h: 3.5, door: null,
    material: woodWall2Mat,
  });

  // Low timber barricades / workbenches (partial cover)
  const benches = [
    { x: -8, z: 12, w: 3.2, d: 0.7, h: 1.05 },
    { x: 9, z: 32, w: 2.8, d: 0.65, h: 1.0 },
    { x: -5, z: 50, w: 3.5, d: 0.7, h: 1.1 },
    { x: 7, z: 74, w: 3.0, d: 0.7, h: 1.05 },
    { x: -6, z: 96, w: 2.6, d: 0.65, h: 1.0 },
  ];
  for (let i = 0; i < benches.length; i += 1) {
    const b = benches[i];
    addBox({
      group,
      colliders,
      name: `Work Bench ${i}`,
      cx: b.x,
      cy: b.h * 0.5,
      cz: b.z,
      sx: b.w,
      sy: b.h,
      sz: b.d,
      material: plankMat,
      collider: true,
    });
  }
}

function addPartitionWall({
  group, colliders, x0, x1, z, h, doorX = null, doorW = 2.3, material = woodWallMat,
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
  // Lintel
  addBox({
    group,
    colliders,
    name: `Partition Lintel ${z}`,
    cx: doorX,
    cy: 2.35 + (h - 2.35) * 0.5,
    cz: z,
    sx: doorW + 0.2,
    sy: Math.max(0.3, h - 2.35),
    sz: WALL_T * 0.85,
    material: darkTimberMat,
    collider: true,
    noGroundSnap: true,
  });
}

function placeCover({ group, colliders }) {
  const crates = [
    { x: -9.5, z: 8, s: [1.6, 1.2, 1.4] },
    { x: 8.5, z: 11, s: [1.8, 1.0, 1.3] },
    { x: 4.0, z: 16, s: [1.3, 1.5, 1.2] },
    { x: -11, z: 20, s: [1.4, 1.3, 2.2] },
    { x: 10.5, z: 24, s: [1.5, 1.6, 1.4] },
    { x: -7, z: 30, s: [1.7, 1.1, 1.5] },
    { x: 6, z: 35, s: [1.4, 1.4, 1.8] },
    { x: -3, z: 39, s: [2.2, 0.95, 1.3] },
    { x: 10, z: 48, s: [1.5, 1.3, 1.5] },
    { x: -10, z: 52, s: [1.6, 1.2, 1.4] },
    { x: 2, z: 56, s: [1.3, 1.5, 1.3] },
    { x: -6, z: 60, s: [1.8, 1.1, 1.6] },
    { x: 8, z: 65, s: [1.4, 1.4, 1.4] },
    { x: -11, z: 70, s: [1.5, 1.0, 1.5] },
    { x: 5, z: 78, s: [1.7, 1.3, 1.5] },
    { x: -8, z: 82, s: [1.4, 1.5, 1.3] },
    { x: 11, z: 88, s: [1.5, 1.2, 1.6] },
    { x: -5, z: 94, s: [1.6, 1.1, 1.4] },
    { x: 4, z: 98, s: [1.3, 1.6, 1.3] },
    { x: -9, z: 101, s: [1.4, 1.0, 1.2] },
  ];
  for (let i = 0; i < crates.length; i += 1) {
    const c = crates[i];
    addBox({
      group,
      colliders,
      name: `Crate ${i + 1}`,
      cx: c.x,
      cy: c.s[1] * 0.5,
      cz: c.z,
      sx: c.s[0],
      sy: c.s[1],
      sz: c.s[2],
      material: crateMat,
      collider: true,
    });
  }

  // Pallet stacks (low cover)
  const pallets = [
    { x: -4, z: 14 }, { x: 11, z: 36 }, { x: -2, z: 48 },
    { x: 7, z: 70 }, { x: -10, z: 90 }, { x: 2, z: 102 },
  ];
  for (let i = 0; i < pallets.length; i += 1) {
    const p = pallets[i];
    for (let layer = 0; layer < 3; layer += 1) {
      addBox({
        group,
        colliders,
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
    // Combined collider for stack
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

  // Tall timber stacks (visual + collider)
  const stacks = [
    { x: 11.5, z: 55, h: 2.4 },
    { x: -11.2, z: 40, h: 2.1 },
    { x: 10.8, z: 95, h: 2.6 },
  ];
  for (let i = 0; i < stacks.length; i += 1) {
    const s = stacks[i];
    addBox({
      group,
      colliders,
      name: `Timber Stack ${i}`,
      cx: s.x,
      cy: s.h * 0.5,
      cz: s.z,
      sx: 1.8,
      sy: s.h,
      sz: 1.2,
      material: darkTimberMat,
      collider: true,
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
function prepareBoxGeometry(sx, sy, sz, material) {
  const geometry = new THREE.BoxGeometry(sx, sy, sz);
  if (material?.map || material?.aoMap || material?.normalMap) {
    applyWorldSpaceBoxUVs(geometry, sx, sy, sz, WALL_TEXTURE_TILE_M);
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
      ...(noGroundSnap ? { noGroundSnap: true } : {}),
    });
  }
  return mesh;
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
