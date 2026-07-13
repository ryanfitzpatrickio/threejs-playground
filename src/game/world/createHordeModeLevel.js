/**
 * Horde Mode arena — industrial train yard.
 *
 * Gravel pads, parallel tracks, boxcars + oil tank cars as cover, corrugated
 * perimeter walls with spawn gates. Reuses warehouse/range PBR sets
 * (concrete, metalroof, woodwall, brickwall, rust pillars) so materials match
 * the shooting-range warehouse look.
 *
 * Layout stays open enough for direct-steering AI (docs/horde-mode-plan.md).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { createMaterialWarmupGroup } from './createMaterialWarmupGroup.js';
import { getGroundHeightAt, getBlockingColliderAt } from './createBaseLevel.js';
const FLOOR_Y = 0;
/** Half-extent of the square combat yard (full width = 2 * HALF). */
const HALF = 36;
const WALL_H = 4.2;
const WALL_T = 0.45;
const GATE_W = 3.6;
const GATE_H = 3.0;
const PLAYER_SAFE_RADIUS = 10;
const MIN_GATE_SPACING = 4.5;

/** Rolling-stock scale (approx US freight, readable as cover). */
const BOXCAR_L = 15.4;
const BOXCAR_W = 3.2;
const BOXCAR_H = 3.85;
const TANK_L = 14.6;
const TANK_W = 3.0;
const TANK_R = 1.28;
/**
 * Visual coupler gap (still reads as a continuous rake). Colliders are shorter
 * than the body so the player can jump through the connection pocket.
 */
const COUPLER_GAP = 0.85;
/** How much each car collider is inset from the visual ends (metres per end). */
const COLLIDER_END_INSET = 0.55;
const DECK_Y = 0.72;
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

const concretePbr = loadRangePbrSet('concrete');
const metalRoofPbr = loadRangePbrSet('metalroof');
const woodPbr = loadRangePbrSet('woodwall');
const brickPbr = loadRangePbrSet('brickwall');
const rustPbr = loadRangePbrSet('pillarmiddle');
const rustEndPbr = loadRangePbrSet('pillarend');

/** Yard gravel — warehouse concrete PBR, warm grit tint + heavy normal. */
const gravelMat = makePbrMaterial(concretePbr, {
  roughness: 0.96,
  metalness: 0.02,
  normalScale: 1.4,
  aoMapIntensity: 0.85,
  color: 0x7a7468,
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
const shedMat = makePbrMaterial(brickPbr, {
  roughness: 0.9,
  metalness: 0.04,
  color: 0xc4b8a8,
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
const ballastMat = makePbrMaterial(concretePbr, {
  roughness: 0.97,
  metalness: 0.02,
  normalScale: 1.5,
  color: 0x6e685c,
});

const MATERIALS = [
  gravelMat, wallMat, railMat, tieMat, boxcarBodyMat, boxcarRoofMat, boxcarDoorMat,
  tankShellMat, tankChassisMat, tankBandMat, shedMat, gateFrameMat, shutterMat,
  accentMat, ballastMat,
];

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
  group.name = 'Horde Train Yard';
  const colliders = [];
  const ledges = [];
  /** Ladder climb planes + roof hang ledges + long-side wall runs. */
  const climbSurfaces = [];
  const wallRunSurfaces = [];
  const materials = [...MATERIALS];

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

  // Yard props — poles, drums, pallets, switch stands, sheds.
  addYardDetails({ group, colliders, ledges, wallRunSurfaces });

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
  // Open gravel aisle between track z=0 (short cut) and z=11.
  const spawnPoint = new THREE.Vector3(8, FLOOR_Y, 5.5);
  const spawnYaw = 0;

  return {
    name: 'Horde Arena',
    group,
    colliders,
    ledges,
    climbSurfaces,
    wallRunSurfaces,
    ropes: [],
    boxcarDoors,
    geometryIndex,
    spawnPoint,
    spawnYaw,
    hordeSpawnPoints,
    hordeEnvironment: { ...HORDE_ENVIRONMENT },
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
    /** Slide boxcar doors on E / mount when nearby. */
    update: ({ delta = 0, character = null, input = null } = {}) => {
      updateBoxcarDoors({
        doors: boxcarDoors,
        delta,
        playerPosition: character?.group?.position ?? null,
        mountPressed: Boolean(input?.mountPressed),
      });
    },
    snapshot: () => ({
      mode: 'horde',
      theme: 'train-yard',
      colliders: colliders.length,
      gates: hordeSpawnPoints.length,
      tracks: TRACK_Z.length,
      boxcars: boxcarPlacements.length,
      tankCars: tankPlacements.length,
      rakes: TRAIN_RAKES.length,
      halfExtent: HALF,
      drawCalls: staticGeometry.batches,
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

/** Floor / roof / ends / side walls with door bay open (walk-through when doors slide). */
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
  // Floor (standable inside)
  pushOrientedCollider(colliders, {
    name: `${name} Floor`,
    x,
    z,
    yaw,
    sx: bodyLen,
    sy: deck + 0.08,
    sz: W * 0.96,
    bottomY: FLOOR_Y,
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
    noGroundSnap: false,
  });
  // Ends
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
  // Side wall segments (door bay open)
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

function updateBoxcarDoors({ doors, delta, playerPosition, mountPressed }) {
  if (!doors?.length) return;

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
  for (const door of doors) {
    // Ensure geometry-index freeze never sticks on interactive doors.
    if (door.mesh.matrixAutoUpdate === false) door.mesh.matrixAutoUpdate = true;
    if (door.mesh.matrixWorldAutoUpdate === false) door.mesh.matrixWorldAutoUpdate = true;
    if (door.mesh.static) door.mesh.static = false;

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
  }
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

  // Light poles along aisles between tracks
  const poleZs = [-16.5, -5.5, 5.5, 16.5];
  for (const pz of poleZs) {
    for (const px of [-22, 0, 22]) {
      addBox({
        group,
        colliders: null,
        name: `Light Pole ${px}_${pz}`,
        cx: px,
        cy: FLOOR_Y + 4.2,
        cz: pz,
        sx: 0.22,
        sy: 8.4,
        sz: 0.22,
        material: railMat,
        collider: false,
        tileMeters: METAL_TILE_M,
      });
      // Lamp head
      addBox({
        group,
        colliders: null,
        name: `Lamp ${px}_${pz}`,
        cx: px,
        cy: FLOOR_Y + 8.3,
        cz: pz,
        sx: 0.9,
        sy: 0.2,
        sz: 0.45,
        material: tankBandMat,
        collider: false,
        tileMeters: METAL_TILE_M,
      });
    }
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
    // Long sides (north / south)
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

  // Wall-run strips along the long sides (airborne run into the car face).
  if (wallRunSurfaces) {
    for (const side of [-1, 1]) {
      const face = side > 0 ? 'north' : 'south';
      const normal = new THREE.Vector3(0, 0, side).applyAxisAngle(_yUp, yaw).normalize();
      const tangent = new THREE.Vector3(1, 0, 0).applyAxisAngle(_yUp, yaw).normalize();
      // Origin: bottom-left of the run band looking at the face.
      _tmpLocal.set(-L * 0.46, 0.75, side * (W * 0.5 + 0.05));
      _tmpLocal.applyAxisAngle(_yUp, yaw);
      wallRunSurfaces.push({
        name: `${name} ${face} Wall Run`,
        blockName: name,
        face,
        origin: { x: x + _tmpLocal.x, y: 0.75, z: z + _tmpLocal.z },
        normal: { x: normal.x, y: 0, z: normal.z },
        tangent: { x: tangent.x, y: 0, z: tangent.z },
        up: { x: 0, y: 1, z: 0 },
        minU: 0.15,
        maxU: L * 0.92,
        minV: 0,
        maxV: Math.min(2.85, Math.max(1.6, H * 0.72)),
        rootOffset: 0.38,
        handYOffset: 1.15,
        handForwardOffset: -0.22,
        handNormalOffset: 0.02,
      });
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
  if (max - min < 1.2) return;

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
    noGroundSnap: true,
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
    const gateCentres = gates.map((_, i) => {
      const u = (i + 1) / (gates.length + 1);
      return -HALF + u * (HALF * 2);
    });
    const openings = gateCentres
      .map((c) => ({ centre: c, half: GATE_W * 0.5 }))
      .sort((a, b) => a.centre - b.centre);

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
      addGate({ group, colliders, side, centre: open.centre });
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
    for (let i = 0; i < gates.length; i += 1) {
      const u = (i + 1) / (gates.length + 1);
      const along = -HALF + u * (HALF * 2);
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
