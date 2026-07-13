/**
 * Matrix Highway level factory.
 *
 * Owns: batched road visuals (instanced segments), fixed road/barrier collider
 * descriptors, spawn transforms, highway environment metadata, analytic ground
 * queries, dispose.
 *
 * Must not: import VehicleSystem, create BaseVehicle, or touch Rapier.
 * Dynamic traffic lives under SceneSystem.scene via VehicleSystem.
 *
 * O2: road is a handful of InstancedMesh batches (not 500+ unique boxes).
 * Materials and geometries are factory-owned — remount does not share disposed state.
 */

import * as THREE from 'three';
import { disposeObject3D } from '../utils/disposeObject3D.js';
import { createMaterialWarmupGroup } from './createMaterialWarmupGroup.js';
import {
  HIGHWAY_Y,
  HIGHWAY_ORIGIN_Z,
  HIGHWAY_PHYSICAL_HALF_LENGTH,
  ROAD_HALF_WIDTH,
  ROAD_SEGMENT_LENGTH,
  ROAD_SEGMENT_COUNT,
  LANE_COUNT,
  LANE_WIDTH,
  LANES,
  SHOULDER_WIDTH,
  playerCharacterSpawnPosition,
  playerVehicleSpawnPosition,
  sToWorldZ,
  worldZToS,
} from '../config/highwayRunManifest.js';

/** Deck slab thickness for the fixed collider (metres). */
const DECK_THICKNESS = 0.8;

/** Low side barrier height above deck (metres). */
const BARRIER_HEIGHT = 0.85;

/** Barrier thickness (metres). */
const BARRIER_THICKNESS = 0.35;

/**
 * When the focus approaches this many metres of either end of the physical
 * slab, the Rapier road/barrier bodies and analytic ground recenter on the
 * player. Visuals already wrap; without this, the fixed 2 km half-length
 * slab ends and vehicles fall through mid-run.
 */
const PHYSICS_RECENTER_MARGIN_M = 500;

/** Shared owner key for highway road + barrier fixed bodies (PhysicsSystem). */
export const HIGHWAY_PHYSICS_OWNER = 'highway-physics-ribbon';

/** Daylight highway environment — distance fog hides the visual recycle horizon. */
export const HIGHWAY_ENVIRONMENT = Object.freeze({
  timeOfDay: 0.46,
  weather: 'clear',
  fogEnabled: true,
  fogDensity: 0.0038,
  fogColor: 0xb8c4d0,
  fogNear: 80,
  fogFar: 280,
});

const DASH_COUNT_PER_LANE_GAP = 8;

/**
 * @param {object} [_qualityPreset]
 */
export function createMatrixHighwayLevel(_qualityPreset = {}) {
  const group = new THREE.Group();
  group.name = 'Matrix Highway';

  const roadVisualRoot = new THREE.Group();
  roadVisualRoot.name = 'roadVisualRoot';
  group.add(roadVisualRoot);

  const roadsideVisualRoot = new THREE.Group();
  roadsideVisualRoot.name = 'roadsideVisualRoot';
  group.add(roadsideVisualRoot);

  // Factory-owned materials (never mutate a module-global list).
  const asphaltMat = new THREE.MeshStandardMaterial({
    color: 0x3a3d42,
    roughness: 0.92,
    metalness: 0.04,
    envMapIntensity: 0.45,
  });
  const shoulderMat = new THREE.MeshStandardMaterial({
    color: 0x4a4640,
    roughness: 0.95,
    metalness: 0.02,
    envMapIntensity: 0.35,
  });
  const laneMarkMat = new THREE.MeshStandardMaterial({
    color: 0xe8e4d4,
    roughness: 0.7,
    metalness: 0.05,
    envMapIntensity: 0.5,
  });
  const barrierMat = new THREE.MeshStandardMaterial({
    color: 0x6a6e74,
    roughness: 0.65,
    metalness: 0.25,
    envMapIntensity: 0.7,
  });
  const supportMat = new THREE.MeshStandardMaterial({
    color: 0x555860,
    roughness: 0.8,
    metalness: 0.15,
    envMapIntensity: 0.5,
  });
  const distantGroundMat = new THREE.MeshStandardMaterial({
    color: 0x6a7a4a,
    roughness: 1,
    metalness: 0,
    envMapIntensity: 0.25,
  });

  const materials = [
    asphaltMat,
    shoulderMat,
    laneMarkMat,
    barrierMat,
    supportMat,
    distantGroundMat,
  ];

  const colliders = [];
  // Physics ribbon is a long cuboid centred on origin at boot; body translation
  // slides along Z as the player approaches either end (see updatePhysicsRibbon).
  let physicsCenterZ = HIGHWAY_ORIGIN_Z;
  const halfLen = HIGHWAY_PHYSICAL_HALF_LENGTH;
  const deckBottom = HIGHWAY_Y - DECK_THICKNESS;

  function physicsBounds(centerZ = physicsCenterZ) {
    return {
      minX: -ROAD_HALF_WIDTH,
      maxX: ROAD_HALF_WIDTH,
      minZ: centerZ - halfLen,
      maxZ: centerZ + halfLen,
      y: HIGHWAY_Y,
      halfLength: halfLen,
      halfWidth: ROAD_HALF_WIDTH,
      centerZ,
    };
  }

  function insidePhysicsRoad(position, radius = 0) {
    const x = position?.x ?? 0;
    const z = position?.z ?? 0;
    const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
    const b = physicsBounds();
    return (
      x + r >= b.minX
      && x - r <= b.maxX
      && z + r >= b.minZ
      && z - r <= b.maxZ
    );
  }

  /**
   * Analytic ground for the elevated ribbon only (follows sliding physics center).
   * Outside the footprint: -Infinity (real fall).
   */
  function highwayGroundHeightAt(position, radius = 0, options = {}) {
    if (!insidePhysicsRoad(position, radius)) return -Infinity;

    const surfaceY = HIGHWAY_Y;
    const y = position?.y;
    if (Number.isFinite(y)) {
      if (Number.isFinite(options.maxStepUp) && surfaceY > y + options.maxStepUp) {
        return -Infinity;
      }
      if (Number.isFinite(options.maxSnapDown) && surfaceY < y - options.maxSnapDown) {
        return -Infinity;
      }
    }
    return surfaceY;
  }

  const bootBounds = physicsBounds(HIGHWAY_ORIGIN_Z);

  // Road slab — collider local centre is origin; body translation recenters Z.
  colliders.push({
    name: 'Highway Road Slab',
    minX: bootBounds.minX,
    maxX: bootBounds.maxX,
    minZ: bootBounds.minZ,
    maxZ: bootBounds.maxZ,
    bottomY: deckBottom,
    topY: HIGHWAY_Y,
    surfaceClass: 'asphalt',
    physicsOwnerKey: HIGHWAY_PHYSICS_OWNER,
  });

  // Side barriers along the same physical range / owner (slide with the slab).
  for (const side of [-1, 1]) {
    const cx = side * (ROAD_HALF_WIDTH - BARRIER_THICKNESS * 0.5);
    colliders.push({
      name: side < 0 ? 'Highway Barrier L' : 'Highway Barrier R',
      minX: cx - BARRIER_THICKNESS * 0.5,
      maxX: cx + BARRIER_THICKNESS * 0.5,
      minZ: bootBounds.minZ,
      maxZ: bootBounds.maxZ,
      bottomY: HIGHWAY_Y,
      topY: HIGHWAY_Y + BARRIER_HEIGHT,
      surfaceClass: 'metal',
      noGroundSnap: true,
      physicsOwnerKey: HIGHWAY_PHYSICS_OWNER,
    });
  }

  const halfSeg = ROAD_SEGMENT_LENGTH * 0.5;
  const laneStripHalf = (LANE_COUNT * LANE_WIDTH) * 0.5;
  const deckThickness = 0.35;
  const barrierY = HIGHWAY_Y + BARRIER_HEIGHT * 0.5;
  const pierHeight = Math.max(2, HIGHWAY_Y - 0.6);
  const nSeg = ROAD_SEGMENT_COUNT;

  // Shared geometries (one per batch type).
  const geoDeck = new THREE.BoxGeometry(laneStripHalf * 2, deckThickness, ROAD_SEGMENT_LENGTH);
  const geoSoffit = new THREE.BoxGeometry(laneStripHalf * 2 + SHOULDER_WIDTH * 2, 0.18, ROAD_SEGMENT_LENGTH);
  const geoShoulder = new THREE.BoxGeometry(SHOULDER_WIDTH, deckThickness * 0.85, ROAD_SEGMENT_LENGTH);
  const dashLen = ROAD_SEGMENT_LENGTH / DASH_COUNT_PER_LANE_GAP * 0.45;
  const geoDash = new THREE.BoxGeometry(0.12, 0.02, dashLen);
  const geoEdge = new THREE.BoxGeometry(0.14, 0.02, ROAD_SEGMENT_LENGTH * 0.98);
  const geoRail = new THREE.BoxGeometry(BARRIER_THICKNESS, BARRIER_HEIGHT, ROAD_SEGMENT_LENGTH * 0.98);
  const geoPier = new THREE.BoxGeometry(1.1, pierHeight, 1.4);
  const geoBeam = new THREE.BoxGeometry(laneStripHalf * 2 + 1.2, 0.55, 1.0);
  const geometries = [
    geoDeck, geoSoffit, geoShoulder, geoDash, geoEdge, geoRail, geoPier, geoBeam,
  ];

  const laneGapCount = LANE_COUNT - 1;
  const dashTotal = nSeg * laneGapCount * DASH_COUNT_PER_LANE_GAP;
  const edgeTotal = nSeg * 2;
  const shoulderTotal = nSeg * 2;
  const railTotal = nSeg * 2;
  const pierTotal = nSeg * 3;
  const beamTotal = nSeg;
  const deckTotal = nSeg;
  const soffitTotal = nSeg;

  const meshDeck = makeInstanced(geoDeck, asphaltMat, deckTotal, {
    castShadow: false,
    receiveShadow: true,
    name: 'Highway Deck Batch',
  });
  const meshSoffit = makeInstanced(geoSoffit, supportMat, soffitTotal, {
    castShadow: true,
    receiveShadow: true,
    name: 'Highway Soffit Batch',
  });
  const meshShoulder = makeInstanced(geoShoulder, shoulderMat, shoulderTotal, {
    castShadow: false,
    receiveShadow: true,
    name: 'Highway Shoulder Batch',
  });
  const meshDash = makeInstanced(geoDash, laneMarkMat, dashTotal, {
    castShadow: false,
    receiveShadow: false,
    name: 'Highway Dash Batch',
  });
  const meshEdge = makeInstanced(geoEdge, laneMarkMat, edgeTotal, {
    castShadow: false,
    receiveShadow: false,
    name: 'Highway Edge Batch',
  });
  const meshRail = makeInstanced(geoRail, barrierMat, railTotal, {
    castShadow: true,
    receiveShadow: true,
    name: 'Highway Rail Batch',
  });
  const meshPier = makeInstanced(geoPier, supportMat, pierTotal, {
    castShadow: true,
    receiveShadow: true,
    name: 'Highway Pier Batch',
  });
  const meshBeam = makeInstanced(geoBeam, supportMat, beamTotal, {
    castShadow: true,
    receiveShadow: false,
    name: 'Highway Beam Batch',
  });

  const batches = [
    meshDeck, meshSoffit, meshShoulder, meshDash, meshEdge, meshRail, meshPier, meshBeam,
  ];
  for (const mesh of batches) roadVisualRoot.add(mesh);

  // Per-segment base Z centres (world). Updated only when the treadmill wraps.
  const segmentZs = new Float64Array(nSeg);
  let focusZ = HIGHWAY_ORIGIN_Z;
  const _mat = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);

  function writeInstance(mesh, index, x, y, z) {
    _pos.set(x, y, z);
    _mat.compose(_pos, _quat, _scale);
    mesh.setMatrixAt(index, _mat);
  }

  function layoutInstances(zFocus) {
    const totalLen = nSeg * ROAD_SEGMENT_LENGTH;
    const halfTotal = totalLen * 0.5;
    const base = Math.round(zFocus / ROAD_SEGMENT_LENGTH) * ROAD_SEGMENT_LENGTH;

    let dashIndex = 0;
    let edgeIndex = 0;
    let shoulderIndex = 0;
    let railIndex = 0;
    let pierIndex = 0;

    for (let i = 0; i < nSeg; i += 1) {
      let z = base + (i - Math.floor(nSeg / 2)) * ROAD_SEGMENT_LENGTH;
      let rel = z - zFocus + halfTotal;
      rel = ((rel % totalLen) + totalLen) % totalLen;
      z = zFocus - halfTotal + rel;
      z = Math.round(z / ROAD_SEGMENT_LENGTH) * ROAD_SEGMENT_LENGTH;
      segmentZs[i] = z;

      writeInstance(meshDeck, i, 0, HIGHWAY_Y - deckThickness * 0.5, z);
      writeInstance(meshSoffit, i, 0, HIGHWAY_Y - deckThickness - 0.09, z);
      writeInstance(meshBeam, i, 0, HIGHWAY_Y - deckThickness - 0.4, z);

      for (const side of [-1, 1]) {
        writeInstance(
          meshShoulder,
          shoulderIndex,
          side * (laneStripHalf + SHOULDER_WIDTH * 0.5),
          HIGHWAY_Y - (deckThickness * 0.85) * 0.5,
          z,
        );
        shoulderIndex += 1;

        writeInstance(
          meshEdge,
          edgeIndex,
          side * laneStripHalf,
          HIGHWAY_Y + 0.012,
          z,
        );
        edgeIndex += 1;

        writeInstance(
          meshRail,
          railIndex,
          side * (ROAD_HALF_WIDTH - BARRIER_THICKNESS * 0.5),
          barrierY,
          z,
        );
        railIndex += 1;
      }

      for (const px of [-laneStripHalf * 0.55, 0, laneStripHalf * 0.55]) {
        writeInstance(meshPier, pierIndex, px, pierHeight * 0.5, z);
        pierIndex += 1;
      }

      const gap = ROAD_SEGMENT_LENGTH / DASH_COUNT_PER_LANE_GAP;
      for (let lane = 0; lane < laneGapCount; lane += 1) {
        const markX = LANES[lane] + LANE_WIDTH * 0.5;
        for (let d = 0; d < DASH_COUNT_PER_LANE_GAP; d += 1) {
          const localZ = -halfSeg + gap * (d + 0.5);
          writeInstance(meshDash, dashIndex, markX, HIGHWAY_Y + 0.01, z + localZ);
          dashIndex += 1;
        }
      }
    }

    for (const mesh of batches) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere?.();
      // Keep frustum culling honest after wrap (large bounds cover the ring).
      if (mesh.boundingSphere) {
        mesh.boundingSphere.center.set(0, HIGHWAY_Y, zFocus);
        mesh.boundingSphere.radius = halfTotal + ROAD_HALF_WIDTH + 20;
      }
    }
  }

  layoutInstances(focusZ);

  // Distant ground plane below the elevated ribbon (visual only — not a catch floor).
  const distantGround = new THREE.Mesh(
    new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 40, HIGHWAY_PHYSICAL_HALF_LENGTH * 2.2),
    distantGroundMat,
  );
  distantGround.rotation.x = -Math.PI / 2;
  distantGround.position.set(0, 0.02, 0);
  distantGround.receiveShadow = true;
  distantGround.castShadow = false;
  distantGround.name = 'Highway Distant Ground';
  roadsideVisualRoot.add(distantGround);

  const characterSpawn = playerCharacterSpawnPosition();
  const vehicleSpawn = playerVehicleSpawnPosition();
  const spawnPoint = new THREE.Vector3(characterSpawn.x, characterSpawn.y, characterSpawn.z);
  const vehicleSpawnPoint = new THREE.Vector3(vehicleSpawn.x, vehicleSpawn.y, vehicleSpawn.z);

  function updateVisuals(focusPosition) {
    const z = focusPosition?.z;
    if (!Number.isFinite(z)) return;
    // Only re-layout when focus crossed a segment boundary far enough to matter.
    if (Math.abs(z - focusZ) < ROAD_SEGMENT_LENGTH * 0.35) return;
    focusZ = z;
    layoutInstances(focusZ);
  }

  /**
   * Slide the fixed Rapier road/barrier bodies so the focus stays well inside
   * the physical half-length. Body translation is pure Z; collider local
   * offsets keep the slab centred on that body pose.
   */
  function updatePhysicsRibbon(focusPosition, physics) {
    const z = focusPosition?.z;
    if (!Number.isFinite(z)) return false;
    const edge = halfLen - PHYSICS_RECENTER_MARGIN_M;
    if (edge <= 0) return false;
    if (Math.abs(z - physicsCenterZ) < edge) return false;

    physicsCenterZ = z;
    if (!physics?.setStaticOwnerTranslation) return false;
    return physics.setStaticOwnerTranslation(HIGHWAY_PHYSICS_OWNER, {
      x: 0,
      y: 0,
      z: physicsCenterZ,
    });
  }

  function countRoadMeshes() {
    let n = 0;
    roadVisualRoot.traverse((obj) => {
      if (obj.isMesh || obj.isInstancedMesh) n += 1;
    });
    roadsideVisualRoot.traverse((obj) => {
      if (obj.isMesh || obj.isInstancedMesh) n += 1;
    });
    return n;
  }

  function countRoadGeometries() {
    const set = new Set();
    const walk = (root) => {
      root.traverse((obj) => {
        if ((obj.isMesh || obj.isInstancedMesh) && obj.geometry) set.add(obj.geometry.uuid);
      });
    };
    walk(roadVisualRoot);
    walk(roadsideVisualRoot);
    return set.size;
  }

  return {
    name: 'Matrix Highway',
    group,
    colliders,
    geometryIndex: null,
    ledges: [],
    climbSurfaces: [],
    wallRunSurfaces: [],
    ropes: [],
    spawnPoint,
    spawnYaw: 0,
    vehicleSpawnPoint,
    vehicleSpawnYaw: 0,
    highwayEnvironment: { ...HIGHWAY_ENVIRONMENT },
    /** Expose constants for systems/debug without re-importing. */
    highwayMeta: {
      y: HIGHWAY_Y,
      originZ: HIGHWAY_ORIGIN_Z,
      physicalHalfLength: HIGHWAY_PHYSICAL_HALF_LENGTH,
      halfWidth: ROAD_HALF_WIDTH,
      laneCount: LANE_COUNT,
      lanes: [...LANES],
      segmentLength: ROAD_SEGMENT_LENGTH,
      segmentCount: ROAD_SEGMENT_COUNT,
      roadMeshCount: countRoadMeshes(),
      roadGeometryCount: countRoadGeometries(),
      roadBatchCount: batches.length,
    },

    getGroundHeightAt: (position, radius = 0, options = {}) => (
      highwayGroundHeightAt(position, radius, options)
    ),

    getRoadSurfaceAt: (x, z) => (
      insidePhysicsRoad({ x, z }, 0) ? 'asphalt' : null
    ),

    getBlockingColliderAt: () => null,

    /**
     * Slab already exists at physics init — never report a newly built collider
     * (truthy would make VehicleSystem.spawnVehicle step the world).
     */
    ensureGroundCollider: () => false,

    isNearFieldReady: () => true,

    createPipelineWarmupGroup: () => createMaterialWarmupGroup(materials, 'Highway Pipeline Warmup'),

    /**
     * Wrap visual segments around the current focus and slide the Rapier road
     * slab when the focus nears either end of the physical range.
     */
    update: ({ character, physics = null, focusPosition = null } = {}) => {
      const vehiclePos = character?.vehicle?.vehicle?.group?.position
        ?? character?.vehicle?.group?.position;
      const focus = focusPosition
        ?? vehiclePos
        ?? character?.group?.position;
      if (!focus) return;
      updateVisuals(focus);
      updatePhysicsRibbon(focus, physics);
    },

    /** Allow traffic system / tests to drive visuals from an explicit focus. */
    updateVisualFocus: (position) => {
      updateVisuals(position);
    },

    /** Test/debug: force physics ribbon centre (world Z). */
    setPhysicsCenterZ: (centerZ, physics = null) => {
      if (!Number.isFinite(centerZ)) return false;
      physicsCenterZ = centerZ;
      return physics?.setStaticOwnerTranslation?.(HIGHWAY_PHYSICS_OWNER, {
        x: 0,
        y: 0,
        z: physicsCenterZ,
      }) ?? true;
    },

    getPhysicsCenterZ: () => physicsCenterZ,

    snapshot: () => ({
      mode: 'highway',
      name: 'Matrix Highway',
      focusS: worldZToS(focusZ),
      focusZ,
      physicalRoad: physicsBounds(),
      physicsCenterZ,
      visualSegments: nSeg,
      segmentLength: ROAD_SEGMENT_LENGTH,
      colliders: colliders.length,
      highwayY: HIGHWAY_Y,
      originZ: HIGHWAY_ORIGIN_Z,
      roadMeshCount: countRoadMeshes(),
      roadGeometryCount: countRoadGeometries(),
      roadBatchCount: batches.length,
      // Coordinate helpers for debug consumers
      sAtOrigin: 0,
      worldZAtS100: sToWorldZ(100),
    }),

    dispose: () => {
      disposeObject3D(group);
      group.clear();
      // Explicitly dispose factory-owned shared resources (disposeObject3D may
      // skip shared refs depending on implementation).
      for (const geo of geometries) geo.dispose?.();
      for (const mat of materials) mat.dispose?.();
      distantGround.geometry?.dispose?.();
    },
  };
}

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material
 * @param {number} count
 * @param {{ castShadow?: boolean, receiveShadow?: boolean, name?: string }} opts
 */
function makeInstanced(geometry, material, count, opts = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.count = count;
  mesh.castShadow = opts.castShadow === true;
  mesh.receiveShadow = opts.receiveShadow === true;
  mesh.name = opts.name ?? 'Highway Batch';
  mesh.frustumCulled = true;
  // Identity seed so bounds exist before first layout.
  const id = new THREE.Matrix4();
  for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, id);
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
