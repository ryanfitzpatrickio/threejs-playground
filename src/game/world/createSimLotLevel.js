import * as THREE from 'three';
import { createSceneSurfaceMaterial } from '../materials/createSceneSurfaceMaterial.js';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createLevelGeometryIndex } from './createLevelGeometryIndex.js';
import { createMaterialWarmupGroup } from './createMaterialWarmupGroup.js';
import { getBlockingColliderAt, getGroundHeightAt } from './createBaseLevel.js';

const LOT_HALF_X = 20;
const LOT_HALF_Z = 15;
const FLOOR_Y = 0;

export function createSimLotLevel() {
  const group = new THREE.Group();
  group.name = 'Willow Creek Residential Lot';
  group.userData.freezeStaticWorldMatrices = true;
  const colliders = [];
  // Hex-tiled PBR ground/paths shared with dog park and rally terrain.
  const materials = {
    lawn: createSceneSurfaceMaterial('grass'),
    path: createSceneSurfaceMaterial('concrete', { albedoTint: 0xc9b89a, tilesPerMetre: 1 / 2.2 }),
    wall: material(0xd9d0bc, 0.82),
    roof: material(0x61524a, 0.76),
    hedge: createSceneSurfaceMaterial('grass', { tilesPerMetre: 1 / 1.4, albedoTint: 0x6aa05a }),
    wood: createSceneSurfaceMaterial('wood'),
    accent: material(0x6489a0, 0.72),
  };

  addBox(group, colliders, 'Lot Lawn', [0, -0.15, 0], [40, 0.3, 30], materials.lawn, {
    collider: true,
    surfaceClass: 'grass',
  });
  addBox(group, colliders, 'Front Walk', [0, 0.015, -10.5], [2.2, 0.03, 9], materials.path);
  addBox(group, colliders, 'Patio', [0, 0.025, 5.3], [14, 0.05, 7], materials.path);

  // Simple open-front house shell: enough architecture to establish the lot
  // without requiring interior pathfinding in the first playable slice.
  addBox(group, colliders, 'House Back Wall', [0, 1.55, 10.5], [14, 3.1, 0.3], materials.wall, { collider: true });
  addBox(group, colliders, 'House Left Wall', [-7, 1.55, 6.8], [0.3, 3.1, 7.7], materials.wall, { collider: true });
  addBox(group, colliders, 'House Right Wall', [7, 1.55, 6.8], [0.3, 3.1, 7.7], materials.wall, { collider: true });
  addBox(group, colliders, 'House Front Left', [-4.6, 1.55, 3], [4.8, 3.1, 0.3], materials.wall, { collider: true });
  addBox(group, colliders, 'House Front Right', [4.6, 1.55, 3], [4.8, 3.1, 0.3], materials.wall, { collider: true });
  addBox(group, colliders, 'House Roof', [0, 3.25, 6.8], [14.6, 0.35, 8.3], materials.roof, { collider: true });

  // Perimeter hedge leaves a broad opening at the front walk.
  addBox(group, colliders, 'North Hedge', [0, 0.8, 14.4], [39, 1.6, 0.8], materials.hedge, { collider: true });
  addBox(group, colliders, 'West Hedge', [-19.4, 0.8, 0], [0.8, 1.6, 28], materials.hedge, { collider: true });
  addBox(group, colliders, 'East Hedge', [19.4, 0.8, 0], [0.8, 1.6, 28], materials.hedge, { collider: true });
  addBox(group, colliders, 'South Hedge Left', [-11.8, 0.8, -14.4], [14.4, 1.6, 0.8], materials.hedge, { collider: true });
  addBox(group, colliders, 'South Hedge Right', [11.8, 0.8, -14.4], [14.4, 1.6, 0.8], materials.hedge, { collider: true });

  // Readable domestic props; boxes are deliberate prototype geometry.
  addBox(group, colliders, 'Kitchen Island', [-3.8, 0.5, 7.3], [3.2, 1, 1.1], materials.accent, { collider: true });
  addBox(group, colliders, 'Sofa', [3.8, 0.55, 7.6], [3.3, 1.1, 1.15], materials.accent, { collider: true });
  addBox(group, colliders, 'Patio Table', [5, 0.55, 0], [1.5, 1.1, 1.5], materials.wood, { collider: true });
  for (const x of [-5.9, -4.1, 4.1, 5.9]) {
    addBox(group, colliders, `Patio Chair ${x}`, [x, 0.45, 0], [0.7, 0.9, 0.7], materials.wood, { collider: true });
  }

  const geometryIndex = createLevelGeometryIndex(group);
  const spawnPoint = new THREE.Vector3(0, FLOOR_Y, -48);
  // RuntimeFramePipeline requires a live player body. Keep its hidden capsule
  // grounded on a collider outside the playable lot.
  colliders.push({
    name: 'Hidden Player Park',
    minX: -2,
    maxX: 2,
    minZ: -50,
    maxZ: -46,
    bottomY: -0.3,
    topY: 0,
    surfaceClass: 'concrete',
  });
  const simSpawnPoints = [
    new THREE.Vector3(-4, FLOOR_Y, -7),
    new THREE.Vector3(4, FLOOR_Y, -7),
  ];

  return {
    name: 'Willow Creek Lot',
    group,
    colliders,
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    geometryIndex,
    spawnPoint,
    spawnYaw: 0,
    simSpawnPoints,
    isNearFieldReady: () => true,
    createPipelineWarmupGroup: () => createMaterialWarmupGroup(Object.values(materials), 'Sim Lot Pipeline Warmup'),
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
      mode: 'sims',
      lotSize: [LOT_HALF_X * 2, LOT_HALF_Z * 2],
      simSpawnPoints: simSpawnPoints.length,
      colliders: colliders.length,
    }),
    dispose: () => disposeObject3D(group),
  };
}

function material(color, roughness) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
}

function addBox(group, colliders, name, [x, y, z], [sx, sy, sz], boxMaterial, options = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), boxMaterial);
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.castShadow = options.collider === true && sy > 0.2;
  mesh.receiveShadow = true;
  if (options.surfaceClass) mesh.userData.surfaceClass = options.surfaceClass;
  group.add(mesh);
  if (options.collider) {
    colliders.push({
      name,
      minX: x - sx * 0.5,
      maxX: x + sx * 0.5,
      minZ: z - sz * 0.5,
      maxZ: z + sz * 0.5,
      bottomY: y - sy * 0.5,
      topY: y + sy * 0.5,
      surfaceClass: options.surfaceClass ?? null,
    });
  }
  return mesh;
}
