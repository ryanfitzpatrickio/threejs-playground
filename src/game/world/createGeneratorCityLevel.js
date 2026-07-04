import * as THREE from 'three';
import { color, floor, fract, mix, positionWorld, sin, step, varying } from 'three/tsl';
import { CityGenerator, createRoadMaterial, quantizeCarPaint } from '../../three-addons/generators/CityGenerator.js';
import { rainWetness, rainWind } from '../systems/weatherUniforms.js';
import { createSkyscraperMaterial } from '../../three-addons/generators/city/SkyscraperGenerator.js';
import { SidewalkGenerator } from '../../three-addons/generators/city/SidewalkGenerator.js';
import { createTraversalDebugOverlay, extractCityTraversal } from './extractCityTraversal.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildTrimeshColliderData } from './buildTrimeshColliderData.js';
import { MeshBVH } from 'three-mesh-bvh';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { createBenchMaterial } from '../../three-addons/generators/city/BenchGenerator.js';
import { createCarMaterialForType } from '../../three-addons/generators/city/CarGenerator.js';
import { createHydrantMaterial } from '../../three-addons/generators/city/HydrantGenerator.js';
import { createPersonMaterial } from '../../three-addons/generators/city/PersonGenerator.js';
import { createStreetTreeMaterial } from '../../three-addons/generators/city/StreetTreeGenerator.js';
import { createStreetlightMaterial } from '../../three-addons/generators/city/StreetlightGenerator.js';
import { createTrafficlightMaterial } from '../../three-addons/generators/city/TrafficlightGenerator.js';
import { createTrashcanMaterial } from '../../three-addons/generators/city/TrashcanGenerator.js';
import { CITY_FURNITURE_LAYER } from '../render/renderLayers.js';

export const CITY_SEED = 1;
const CITY_PARAMETERS = {
  blocksX: 2,
  blocksZ: 2,
  lotsX: 4,
  lotsZ: 3,
};
const ROOF_FLOOR_COLLIDER_THICKNESS = 0.16;
const CITY_ROAD_COLLIDER_THICKNESS = 0.6;

// Returns the chunk stride (cityW + street) without building any geometry.
// Used to initialise the streaming system before the first worker completes.
export function getCityStride() {
  const city = new CityGenerator({ ...CITY_PARAMETERS, seed: CITY_SEED });
  return {
    x: city.layout.cityW + city.layout.street,
    z: city.layout.cityD + city.layout.street,
  };
}

// Builds tiny Mesh + InstancedMesh variants for every shared city material.
// GameRuntime temporarily adds this group during the loading-screen prewarm so
// color, shadow, and SSAO pipeline variants compile before streamed chunks use
// them. Geometry carries every custom attribute referenced by the TSL shaders.
export function createCityMaterialWarmupGroup() {
  const city = new CityGenerator({ ...CITY_PARAMETERS, seed: CITY_SEED, furniture: { person: true } });
  const layout = city.layout;
  const sidewalk = getSidewalkMaterials();
  const materials = new Set([
    getBuildingMaterial(layout),
    getRoadMaterial(layout),
    getGenericSidewalkMaterial(),
    sidewalk.slab,
    sidewalk.curb,
    ...Object.values(getDistrictMaterials('suburbs')),
    ...Object.values(getDistrictMaterials('commercial')),
    getFurnitureMaterial({ materialRole: 'furnitureStreetTrees' }),
    getFurnitureMaterial({ materialRole: 'furnitureHydrants' }),
    getFurnitureMaterial({ materialRole: 'furnitureTrafficlights' }),
    getFurnitureMaterial({ materialRole: 'furnitureStreetlights' }),
    getFurnitureMaterial({ materialRole: 'furnitureTrashcans' }),
    getFurnitureMaterial({ materialRole: 'furnitureBenches' }),
    getFurnitureMaterial({ materialRole: 'furniturePeople' }),
    getFurnitureMaterial({ materialRole: 'furnitureCar', furniturePaint: 0x74787c, furnitureBodyType: 'sedan' }),
    getFurnitureMaterial({ materialRole: 'furnitureCar', furniturePaint: 0x111216, furnitureBodyType: 'suv' }),
    getFurnitureMaterial({ materialRole: 'furnitureCar', furniturePaint: 0xf5c518, furnitureBodyType: 'taxi' }),
  ]);

  const geometry = createWarmupGeometry();
  const group = new THREE.Group();
  group.name = 'City Pipeline Warmup';
  group.userData.pipelineWarmup = true;
  let index = 0;
  for (const material of materials) {
    const mesh = new THREE.Mesh(geometry, material);
    const instanced = new THREE.InstancedMesh(geometry, material, 1);
    mesh.name = `City Warmup Mesh ${index}`;
    instanced.name = `City Warmup Instanced ${index}`;
    mesh.frustumCulled = false;
    instanced.frustumCulled = false;
    mesh.castShadow = instanced.castShadow = true;
    mesh.receiveShadow = instanced.receiveShadow = true;
    mesh.position.set(0, -10000 - index, 0);
    instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, -10000 - index, 0));
    instanced.instanceMatrix.needsUpdate = true;
    group.add(mesh, instanced);
    index += 1;
  }
  group.userData.disposeWarmup = () => geometry.dispose();
  return group;
}

function createWarmupGeometry() {
  const geometry = new THREE.BoxGeometry(0.01, 0.01, 0.01).toNonIndexed();
  const count = geometry.getAttribute('position').count;
  const scalar = new Float32Array(count);
  const vectors = new Float32Array(count * 3);
  const sizes = new Float32Array(count * 3);
  sizes.fill(1);
  geometry.setAttribute('partId', new THREE.BufferAttribute(scalar, 1));
  geometry.setAttribute('roomCenter', new THREE.BufferAttribute(vectors, 3));
  geometry.setAttribute('roomSize', new THREE.BufferAttribute(sizes, 3));
  geometry.setAttribute('roadMark', new THREE.BufferAttribute(vectors.slice(), 3));
  geometry.setAttribute('roadIntersection', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1));
  return geometry;
}

// Fast skeleton: pure layout math (no geometry, no trimesh). Returns box colliders
// for the road, sidewalks, and all buildings so the main thread can register
// physics and show placeholder meshes before the full geometry worker finishes.
export function buildSkeletonColliderData({
  seed = CITY_SEED,
  cityStyle = 'downtown',
  cityZone = null,
  chunkKey = '0:0',
  chunkX = 0,
  chunkZ = 0,
  originX = 0,
  originZ = 0,
  furniture = null,
} = {}) {
  if (cityStyle !== 'downtown') {
    const district = buildLowRiseDistrict({ seed, cityStyle, cityZone, chunkKey, originX, originZ, geometry: false, extractTraversal: false });
    return { colliders: district.colliders, layout: district.layout, floorW: district.floorW, floorD: district.floorD };
  }
  const city = new CityGenerator({ ...CITY_PARAMETERS, seed, ...(furniture ? { furniture } : {}) });
  const floorW = city.layout.cityW + city.layout.street;
  const floorD = city.layout.cityD + city.layout.street;
  const roadW = city.layout.cityW + 2 * city.layout.street;
  const roadD = city.layout.cityD + 2 * city.layout.street;
  const layoutData = buildCollisionLayout(city.layout, seed, city.parameters, { chunkKey, originX, originZ });

  // Same zone clipping as the full build below: towers/sidewalk blocks outside
  // the authored city zone never get colliders, so the phase-1 skeleton matches
  // the phase-2 geometry.
  const insideZone = (rect) => !cityZone || rectInsideZone(cityZone, rect);
  const colliders = [
    ...createRoadSurfaceColliders(cityZone, {
      minX: originX - roadW * 0.5,
      maxX: originX + roadW * 0.5,
      minZ: originZ - roadD * 0.5,
      maxZ: originZ + roadD * 0.5,
    }, chunkKey, 'Generator City Road Collider'),
    ...layoutData.sidewalks
      .filter((s) => shouldKeepSidewalk(cityZone, s.collider, chunkX, chunkZ))
      .map((s) => s.collider),
    ...layoutData.buildings.filter((b) => insideZone(b.collider)).flatMap((b) => [b.collider, createRoofFloorCollider(b.collider)]),
  ];

  return { colliders, layout: city.layout, floorW, floorD };
}

export function createGeneratorCityLevel({
  seed = CITY_SEED,
  cityStyle = 'downtown',
  cityZone = null,
  chunkKey = '0:0',
  chunkX = 0,
  chunkZ = 0,
  originX = 0,
  originZ = 0,
  includeDebugOverlay = true,
  furniture = null,
  extractTraversal = true,
  castShadows = true,
} = {}) {
  if (cityStyle !== 'downtown') {
    return buildLowRiseDistrict({ seed, cityStyle, cityZone, chunkKey, chunkX, chunkZ, originX, originZ, geometry: true, includeDebugOverlay, extractTraversal, castShadows });
  }
  const city = new CityGenerator({ ...CITY_PARAMETERS, seed, ...(furniture ? { furniture } : {}) });
  const group = new THREE.Group();
  group.name = `Generator City Chunk ${chunkKey}`;
  group.userData.cityChunkKey = chunkKey;
  group.userData.cityChunkX = chunkX;
  group.userData.cityChunkZ = chunkZ;

  const floorW = city.layout.cityW + city.layout.street;
  const floorD = city.layout.cityD + city.layout.street;
  const roadVisualW = city.layout.cityW + 2 * city.layout.street;
  const roadVisualD = city.layout.cityD + 2 * city.layout.street;
  // The road markings are world-space procedural (createRoadMaterial reads
  // positionWorld), so clipping the plane to the zone can't misalign them.
  const roadCells = cityZone
    ? clippedSurfaceCells(cityZone, {
        minX: originX - roadVisualW / 2, maxX: originX + roadVisualW / 2,
        minZ: originZ - roadVisualD / 2, maxZ: originZ + roadVisualD / 2,
      }).map((cell) => new THREE.PlaneGeometry(cell.maxX - cell.minX, cell.maxZ - cell.minZ)
        .rotateX(-Math.PI / 2)
        .translate((cell.minX + cell.maxX) / 2, 0, (cell.minZ + cell.maxZ) / 2))
    : [new THREE.PlaneGeometry(roadVisualW, roadVisualD).rotateX(-Math.PI / 2).translate(originX, 0, originZ)];
  const roadGeometry = roadCells.length ? mergeGeometries(roadCells, false) : null;
  if (roadGeometry) {
    const road = new THREE.Mesh(roadGeometry, getRoadMaterial(city.layout));
    road.name = `Wet Asphalt Road ${chunkKey}`;
    road.userData.materialRole = 'roadMaterial';
    road.receiveShadow = true;
    group.add(road);
  }

  const buildingMaterial = getBuildingMaterial(city.layout);
  const cityGroup = city.build({ building: buildingMaterial });
  cityGroup.name = `Skyscraper Block Group ${chunkKey}`;
  cityGroup.position.set(originX, 0, originZ);
  group.add(cityGroup);
  cityGroup.updateMatrixWorld(true);
  // The sidewalk slab/curb are InstancedMeshes (one instance per block) the generator
  // leaves unnamed. Name them so the worker -> payload -> rebuild path can restore the
  // per-block placements and route the correct procedural material to each.
  tagSidewalkMeshes(cityGroup);
  if (cityZone) {
    // V1 clipping policy from the sync plan: omit furniture for clipped chunks.
    // Placement generation already completed, so this cannot perturb tower PRNG.
    cityGroup.getObjectByName('StreetFurniture')?.removeFromParent();
    city.furniturePlacements.cars = [];
  } else {
    tagFurnitureMeshes(cityGroup, castShadows);
  }

  const layoutData = buildCollisionLayout(city.layout, seed, city.parameters, {
    chunkKey,
    originX,
    originZ,
  });
  assertTowerCollisionLockstep(city.towers, layoutData.buildings, originX, originZ);
  // Clip to the authored city zone at lot/block granularity. Filter AFTER
  // buildCollisionLayout — it must replay CityGenerator's PRNG draws in full,
  // so skipping out-of-zone lots inside it would desync every later building's
  // collider from its mesh. layoutData.buildings and the 'Skyscraper' meshes
  // are generated in the same (bx,bz,lx,lz) order, so filtering both by the
  // same index keeps the collider↔trimesh pairing intact.
  const allBuildingMeshes = collectBuildingMeshes(cityGroup);
  const keptBuildings = [];
  const buildingMeshes = [];
  layoutData.buildings.forEach((building, index) => {
    if (cityZone && !rectInsideZone(cityZone, building.collider)) {
      allBuildingMeshes[index]?.removeFromParent();
      return;
    }
    keptBuildings.push(building);
    buildingMeshes.push(allBuildingMeshes[index]);
  });
  const sidewalkKeep = layoutData.sidewalks.map((sidewalk) => shouldKeepSidewalk(cityZone, sidewalk.collider, chunkX, chunkZ));
  const keptSidewalks = layoutData.sidewalks.filter((_, index) => sidewalkKeep[index]);
  // Slab/curb instances were placed one per block in the same (bx,bz) order
  // as layoutData.sidewalks — compact them down to owned, in-zone blocks.
  filterSidewalkInstances(cityGroup, sidewalkKeep);
  for (const mesh of buildingMeshes) mesh.userData.materialRole = 'buildingMaterial';
  const colliders = [
    ...createRoadSurfaceColliders(cityZone, {
      minX: originX - roadVisualW * 0.5,
      maxX: originX + roadVisualW * 0.5,
      minZ: originZ - roadVisualD * 0.5,
      maxZ: originZ + roadVisualD * 0.5,
    }, chunkKey, 'Generator City Road Collider'),
    ...keptSidewalks.map((sidewalk) => sidewalk.collider),
    ...buildCarColliders(city.furniturePlacements.cars, { originX, originZ, chunkKey }),
  ];
  const ledges = [];
  const climbSurfaces = [];
  const wallRunSurfaces = [];

  keptBuildings.forEach((building, index) => {
    const meshCollider = buildTrimeshColliderData(buildingMeshes[index]);
    if (meshCollider) {
      building.collider.physicsShape = 'trimesh';
      building.collider.physicsMesh = meshCollider;
    }

    colliders.push(building.collider);
    colliders.push(createRoofFloorCollider(building.collider));
  });

  // Colliders above were built from the individual building meshes (their trimesh
  // data creation happens via buildTrimeshColliderData inside the cityChunkWorker
  // for streaming, so main thread never does the heavy per-vertex work). Now merge
  // the building VISUALS into one mesh — they share one material — to cut ~24 draw
  // calls per chunk down to 1. Falls back to individual meshes if the merge fails.
  mergeBuildingVisuals(cityGroup, buildingMeshes, buildingMaterial, chunkKey, castShadows);

  const traversalBuildings = keptBuildings;
  const traversal = extractTraversal
    ? extractCityTraversal({ buildings: traversalBuildings })
    : { ledges: [], climbSurfaces: [], wallRunSurfaces: [] };

  if (includeDebugOverlay && extractTraversal) {
    group.add(createTraversalDebugOverlay(traversal));
  }
  ledges.push(...traversal.ledges);
  climbSurfaces.push(...traversal.climbSurfaces);
  wallRunSurfaces.push(...traversal.wallRunSurfaces);

  return {
    chunkKey,
    chunkX,
    chunkZ,
    originX,
    originZ,
    seed,
    cityStyle: 'downtown',
    layout: city.layout,
    floorW,
    floorD,
    group,
    colliders,
    ledges,
    climbSurfaces,
    wallRunSurfaces,
    ropes: [],
    traversalBuildings,
    traversalReady: extractTraversal,
    spawnPoint: new THREE.Vector3(originX, 0, originZ),
    dispose: () => {
      city.dispose();
      disposeChunkGroup(group);
    },
  };
}

export function serializeGeneratorCityChunk(chunk) {
  const meshes = [];

  chunk.group.updateMatrixWorld(true);
  chunk.group.traverse((object) => {
    if (!object.isMesh || !object.geometry?.isBufferGeometry) {
      return;
    }
    if (object.isInstancedMesh && object.count <= 0) {
      return;
    }

    meshes.push(serializeMesh(object));
  });

  return {
    chunkKey: chunk.chunkKey,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    originX: chunk.originX,
    originZ: chunk.originZ,
    seed: chunk.seed,
    cityStyle: chunk.cityStyle ?? 'downtown',
    layout: chunk.layout,
    floorW: chunk.floorW,
    floorD: chunk.floorD,
    meshes,
    colliders: chunk.colliders,
    ledges: chunk.ledges,
    climbSurfaces: chunk.climbSurfaces,
    wallRunSurfaces: chunk.wallRunSurfaces,
    ropes: chunk.ropes,
    traversalBuildings: chunk.traversalBuildings ?? [],
    traversalReady: chunk.traversalReady === true,
    records: chunk.records ?? [],
    spawnPoint: vectorToObject(chunk.spawnPoint),
  };
}

export function collectGeneratorCityChunkTransferables(payload) {
  const transferables = [];
  const seen = new Set();

  for (const mesh of payload.meshes ?? []) {
    for (const attribute of Object.values(mesh.geometry.attributes ?? {})) {
      addBufferTransfer(transferables, seen, attribute.buffer);
    }

    if (mesh.geometry.index) {
      addBufferTransfer(transferables, seen, mesh.geometry.index.buffer);
    }

    if (mesh.instanceMatrix) {
      addBufferTransfer(transferables, seen, mesh.instanceMatrix.buffer);
    }

    for (const root of mesh.bvh?.roots ?? []) {
      addBufferTransfer(transferables, seen, root);
    }
  }

  for (const collider of payload.colliders ?? []) {
    if (!collider.physicsMesh) {
      continue;
    }

    addBufferTransfer(transferables, seen, collider.physicsMesh.vertices?.buffer);
    addBufferTransfer(transferables, seen, collider.physicsMesh.indices?.buffer);
    addBufferTransfer(transferables, seen, collider.physicsMesh.traversalIndices?.buffer);
  }

  return transferables;
}

export function createGeneratorCityChunkFromPayload(payload) {
  const group = new THREE.Group();
  group.name = `Generator City Chunk ${payload.chunkKey}`;
  group.userData.cityChunkKey = payload.chunkKey;
  group.userData.cityChunkX = payload.chunkX;
  group.userData.cityChunkZ = payload.chunkZ;
  group.userData.cityStyle = payload.cityStyle ?? 'downtown';

  const buildingMaterial = getBuildingMaterial(payload.layout);
  const roadMaterial = getRoadMaterial(payload.layout);
  const sidewalkMaterial = getGenericSidewalkMaterial();
  const sidewalkMaterials = getSidewalkMaterials();
  const materials = {
    buildingMaterial,
    roadMaterial,
    slabMaterial: sidewalkMaterials.slab,
    curbMaterial: sidewalkMaterials.curb,
    sidewalkMaterial,
    ...getDistrictMaterials(payload.cityStyle),
  };

  for (const meshPayload of payload.meshes ?? []) {
    if (meshPayload.instanced && meshPayload.count <= 0) {
      continue;
    }

    const geometry = deserializeGeometry(meshPayload.geometry);
    const material = materialForMeshPayload(meshPayload, materials);

    // Restore precomputed local boundingBox (from worker serialize) so that
    // createLevelGeometryIndex.addRoot can skip computeBoundingBox (vertex scan)
    // on streamed chunks. World bounds are still derived via matrix.
    if (meshPayload.boundingBox && geometry) {
      const bb = meshPayload.boundingBox;
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3().fromArray(bb.min),
        new THREE.Vector3().fromArray(bb.max),
      );
    }
    if (meshPayload.boundingSphere && geometry) {
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3().fromArray(meshPayload.boundingSphere.center),
        meshPayload.boundingSphere.radius,
      );
    }

    // Adopt the worker-built raycast BVH (cheap: wraps the transferred buffers).
    // The shipped geometry index already has the tree's triangle ordering, so
    // don't let deserialize touch it. Without a tree the geometry index skips
    // this mesh on hook/ledge raycasts.
    if (meshPayload.bvh && geometry) {
      geometry.boundsTree = MeshBVH.deserialize(meshPayload.bvh, geometry, { setIndex: false });
    }

    const mesh = meshPayload.instanced
      ? new THREE.InstancedMesh(geometry, material, meshPayload.count)
      : new THREE.Mesh(geometry, material);

    mesh.name = meshPayload.name;
    mesh.userData.materialRole = meshPayload.materialRole;
    mesh.userData.skipLevelRaycast = meshPayload.skipLevelRaycast === true;
    if (meshPayload.materialRole?.startsWith('furniture')) mesh.layers.set(CITY_FURNITURE_LAYER);
    if (meshPayload.furniturePaint != null) mesh.userData.furniturePaint = meshPayload.furniturePaint;
    if (meshPayload.furnitureBodyType) mesh.userData.furnitureBodyType = meshPayload.furnitureBodyType;
    mesh.castShadow = meshPayload.castShadow;
    mesh.receiveShadow = meshPayload.receiveShadow;

    if (meshPayload.instanced && meshPayload.instanceMatrix) {
      // Adopt the transferred matrix buffer directly. Assigning into the
      // constructor-created attribute copied every matrix again on attach.
      mesh.instanceMatrix = deserializeInstancedAttribute(meshPayload.instanceMatrix);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      if (meshPayload.instanceBoundingSphere) {
        mesh.boundingSphere = new THREE.Sphere(
          new THREE.Vector3().fromArray(meshPayload.instanceBoundingSphere.center),
          meshPayload.instanceBoundingSphere.radius,
        );
      }
    }

    mesh.matrix.fromArray(meshPayload.matrix);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    group.add(mesh);
  }

  return {
    chunkKey: payload.chunkKey,
    chunkX: payload.chunkX,
    chunkZ: payload.chunkZ,
    originX: payload.originX,
    originZ: payload.originZ,
    seed: payload.seed,
    cityStyle: payload.cityStyle ?? 'downtown',
    layout: payload.layout,
    floorW: payload.floorW,
    floorD: payload.floorD,
    group,
    colliders: payload.colliders ?? [],
    ledges: payload.ledges ?? [],
    climbSurfaces: payload.climbSurfaces ?? [],
    wallRunSurfaces: payload.wallRunSurfaces ?? [],
    ropes: payload.ropes ?? [],
    traversalBuildings: payload.traversalBuildings ?? [],
    traversalReady: payload.traversalReady === true,
    records: payload.records ?? [],
    spawnPoint: new THREE.Vector3(payload.spawnPoint.x, payload.spawnPoint.y, payload.spawnPoint.z),
    dispose: () => disposeChunkGroup(group),
  };
}

// Meshes at/above this index count get their BVH built in the worker and
// shipped serialized. Below it, the main thread's budgeted warmup builds the
// tree in microseconds. The merged building visual (the mesh hook/ledge
// raycasts actually need) is far above this.
const BVH_SERIALIZE_MIN_INDEX_COUNT = 3000;

function serializeMesh(mesh) {
  const instanced = mesh.isInstancedMesh === true;
  const geometry = mesh.geometry;

  // Compute local bounding box here (in worker) so main-thread attach can skip
  // the expensive per-mesh computeBoundingBox + vertex walk during addRoot.
  if (geometry && !geometry.boundingBox) {
    geometry.computeBoundingBox();
  }
  if (geometry && !geometry.boundingSphere) {
    geometry.computeBoundingSphere();
  }
  if (instanced && !mesh.boundingSphere) {
    mesh.computeBoundingSphere();
  }

  // Build the raycast BVH in the worker and ship it serialized: the geometry
  // index skips tree-less meshes on the query path (a brute-force fallback on a
  // merged chunk mesh measured ~900 ms per hook query), and building this tree
  // on the main thread would itself be a several-hundred-ms hitch. Build BEFORE
  // serializeGeometry — MeshBVH reorders (or creates) geometry.index in place,
  // and the shipped index must match the tree.
  let bvh = null;
  if (!instanced && geometry) {
    const indexCount = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
    if (indexCount >= BVH_SERIALIZE_MIN_INDEX_COUNT) {
      const tree = new MeshBVH(geometry);
      const data = MeshBVH.serialize(tree, { cloneBuffers: false });
      // The shipped geometry index already carries the post-build ordering, so
      // only the roots travel (deserialize runs with setIndex: false).
      bvh = { version: data.version, roots: data.roots };
    }
  }

  return {
    bvh,
    name: mesh.name,
    materialRole: mesh.userData?.materialRole ?? null,
    skipLevelRaycast: mesh.userData?.skipLevelRaycast === true,
    furniturePaint: mesh.userData?.furniturePaint ?? null,
    furnitureBodyType: mesh.userData?.furnitureBodyType ?? null,
    castShadow: mesh.castShadow === true,
    receiveShadow: mesh.receiveShadow === true,
    matrix: mesh.matrixWorld.toArray(),
    geometry: serializeGeometry(geometry),
    instanced,
    count: instanced ? mesh.count : 0,
    // Per-instance placements. Without these the rebuild collapses every block's slab/curb
    // onto a single mesh at the group origin — the sidewalk-placement bug in streamed chunks.
    // Trimmed to `count` entries: zone clipping can leave count < capacity, and the
    // rebuilt InstancedMesh only allocates count instances.
    instanceMatrix: instanced ? serializeAttributeWindow(mesh.instanceMatrix, mesh.count * 16) : null,
    // Precomputed local box (serialized as plain arrays) to allow fast world-bounds
    // construction in geometry index without main-thread vert scan or full updates.
    boundingBox: geometry?.boundingBox
      ? {
          min: geometry.boundingBox.min.toArray(),
          max: geometry.boundingBox.max.toArray(),
        }
      : null,
    boundingSphere: geometry?.boundingSphere
      ? { center: geometry.boundingSphere.center.toArray(), radius: geometry.boundingSphere.radius }
      : null,
    instanceBoundingSphere: instanced && mesh.boundingSphere
      ? { center: mesh.boundingSphere.center.toArray(), radius: mesh.boundingSphere.radius }
      : null,
  };
}

function serializeGeometry(geometry) {
  const attributes = {};

  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    attributes[name] = serializeAttribute(attribute);
  }

  return {
    attributes,
    index: geometry.index ? serializeAttribute(geometry.index) : null,
    groups: geometry.groups.map((group) => ({ ...group })),
    drawRange: { ...geometry.drawRange },
  };
}

function serializeAttribute(attribute) {
  return {
    arrayType: attribute.array.constructor.name,
    buffer: attribute.array.buffer,
    byteOffset: attribute.array.byteOffset,
    length: attribute.array.length,
    itemSize: attribute.itemSize,
    normalized: attribute.normalized === true,
  };
}

function serializeAttributeWindow(attribute, length) {
  return {
    arrayType: attribute.array.constructor.name,
    buffer: attribute.array.buffer,
    byteOffset: attribute.array.byteOffset,
    length,
    itemSize: attribute.itemSize,
    normalized: attribute.normalized === true,
  };
}

function deserializeGeometry(payload) {
  const geometry = new THREE.BufferGeometry();

  for (const [name, attributePayload] of Object.entries(payload.attributes ?? {})) {
    geometry.setAttribute(name, deserializeAttribute(attributePayload));
  }

  if (payload.index) {
    geometry.setIndex(deserializeAttribute(payload.index));
  }

  for (const group of payload.groups ?? []) {
    geometry.addGroup(group.start, group.count, group.materialIndex);
  }

  if (payload.drawRange) {
    geometry.setDrawRange(payload.drawRange.start, payload.drawRange.count);
  }

  // Fix attributes that would produce invalid GPUVertexFormat like 'unorm32x4' on WebGPU.
  // Some quantized GLBs or serialized data can produce normalized Uint32Array(4) attributes.
  sanitizeAttributesForWebGPU(geometry);

  return geometry;
}

function sanitizeAttributesForWebGPU(geometry) {
  if (!geometry || !geometry.attributes) return;
  Object.keys(geometry.attributes).forEach((name) => {
    const attr = geometry.attributes[name];
    if (!attr) return;
    const arr = attr.array;
    if ((arr instanceof Uint32Array || arr instanceof Int32Array) && attr.normalized) {
      const floatArr = new Float32Array(arr.length);
      const divisor = arr instanceof Uint32Array ? 0xffffffff : 0x7fffffff;
      for (let i = 0; i < arr.length; i++) {
        floatArr[i] = Number(arr[i]) / divisor;
      }
      const replacement = new THREE.BufferAttribute(floatArr, attr.itemSize, false);
      geometry.setAttribute(name, replacement);
      console.warn(`[WebGPU fix] Converted normalized ${arr.constructor.name} attr "${name}" (size ${attr.itemSize}) → float32x${attr.itemSize} to avoid invalid vertex format 'unorm32x4' etc.`);
    }
  });
}

function deserializeAttribute(payload) {
  const ArrayType = globalThis[payload.arrayType];
  const array = new ArrayType(payload.buffer, payload.byteOffset, payload.length);
  return new THREE.BufferAttribute(array, payload.itemSize, payload.normalized);
}

function deserializeInstancedAttribute(payload) {
  const ArrayType = globalThis[payload.arrayType];
  const array = new ArrayType(payload.buffer, payload.byteOffset, payload.length);
  return new THREE.InstancedBufferAttribute(array, payload.itemSize, payload.normalized);
}

function materialForMeshPayload(meshPayload, materials) {
  if (meshPayload.materialRole && materials[meshPayload.materialRole]) return materials[meshPayload.materialRole];
  if (meshPayload.name.startsWith('Wet Asphalt Road')) {
    return materials.roadMaterial;
  }

  if (meshPayload.name === 'Skyscraper' || meshPayload.name.startsWith('Merged Skyscrapers')) {
    return materials.buildingMaterial;
  }

  if (meshPayload.name === 'Sidewalk Slab') {
    return materials.slabMaterial;
  }

  if (meshPayload.name === 'Sidewalk Curb') {
    return materials.curbMaterial;
  }

  if (meshPayload.materialRole?.startsWith('furniture')) {
    return getFurnitureMaterial(meshPayload);
  }

  return materials.sidewalkMaterial;
}

function addBufferTransfer(transferables, seen, buffer) {
  if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) {
    return;
  }

  seen.add(buffer);
  transferables.push(buffer);
}

function vectorToObject(vector) {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}

function collectBuildingMeshes(cityGroup) {
  return cityGroup.children.filter((child) => child.isMesh && child.name === 'Skyscraper');
}

// Merge all the Skyscraper visual meshes in a chunk into a single mesh. They
// share one building material, so this collapses ~24 draw calls per chunk into
// 1 with no visual change. Each building's local offset is baked into its
// geometry (so the merged mesh sits at cityGroup origin). Colliders are built
// separately (copied into collider.physicsMesh) and are unaffected. If the
// merge throws (e.g. mismatched vertex attributes), we keep the individual
// meshes — no regression, just no win.
function mergeBuildingVisuals(cityGroup, buildingMeshes, material, chunkKey, castShadows = true) {
  if (buildingMeshes.length < 2) {
    return;
  }

  const geometries = [];
  for (const mesh of buildingMeshes) {
    if (!mesh.geometry) {
      continue;
    }
    mesh.updateMatrix();
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    g.applyMatrix4(mesh.matrix);
    // geometry.applyMatrix4 only transforms position/normal/tangent. The window
    // interior-mapping shader also reads a custom `roomCenter` attribute, which
    // is a POSITION in the building's local space (the shader does
    // positionLocal - roomCenter). Once we bake the per-building offset into the
    // positions, roomCenter has to move with them or every off-origin building's
    // panes ray-march into a box at the wrong place (windows render flat/garbled).
    transformPointAttribute(g.getAttribute('roomCenter'), mesh.matrix);
    geometries.push(g);
  }

  let merged = null;
  try {
    merged = geometries.length >= 2 ? mergeGeometries(geometries, false) : null;
  } catch (error) {
    merged = null;
  }

  for (const g of geometries) {
    g.dispose();
  }

  if (!merged) {
    return;
  }

  for (const mesh of buildingMeshes) {
    mesh.removeFromParent();
  }

  const mergedMesh = new THREE.Mesh(merged, material);
  mergedMesh.name = `Merged Skyscrapers ${chunkKey}`;
  mergedMesh.userData.materialRole = 'buildingMaterial';
  mergedMesh.castShadow = castShadows;
  mergedMesh.receiveShadow = true;
  cityGroup.add(mergedMesh);
}

const _roomCenterVec = new THREE.Vector3();

// Transform a vec3 position attribute in place by a Matrix4 (handles translation
// + rotation + scale). Used to keep the window shader's `roomCenter` aligned with
// the positions when per-building offsets get baked in during the merge.
function transformPointAttribute(attribute, matrix) {
  if (!attribute || attribute.itemSize < 3) {
    return;
  }

  for (let index = 0; index < attribute.count; index += 1) {
    _roomCenterVec.fromBufferAttribute(attribute, index).applyMatrix4(matrix);
    attribute.setXYZ(index, _roomCenterVec.x, _roomCenterVec.y, _roomCenterVec.z);
  }

  attribute.needsUpdate = true;
}

// Name the sidewalk generator's slab and curb InstancedMeshes (built unnamed, in that
// order: group.add(slab, curb)) so the payload rebuild can identify and dress each.
function tagSidewalkMeshes(cityGroup) {
  const sidewalkGroup = cityGroup.getObjectByName('Sidewalk');

  if (!sidewalkGroup) {
    return;
  }

  const [slab, curb] = sidewalkGroup.children;

  if (slab?.isInstancedMesh) {
    slab.name = 'Sidewalk Slab';
    slab.userData.materialRole = 'slabMaterial';
  }
  if (curb?.isInstancedMesh) {
    curb.name = 'Sidewalk Curb';
    curb.userData.materialRole = 'curbMaterial';
  }
}

const furnitureMaterials = new Map();
const FURNITURE_MATERIAL_FACTORIES = {
  furnitureStreetTrees: createStreetTreeMaterial,
  furnitureHydrants: createHydrantMaterial,
  furnitureTrafficlights: createTrafficlightMaterial,
  furnitureStreetlights: createStreetlightMaterial,
  furnitureTrashcans: createTrashcanMaterial,
  furnitureBenches: createBenchMaterial,
  furniturePeople: createPersonMaterial,
};

function getFurnitureMaterial(payload) {
  const role = payload.materialRole;
  const paint = role === 'furnitureCar'
    ? quantizeCarPaint(payload.furniturePaint ?? 0x74787c)
    : null;
  const key = role === 'furnitureCar'
    ? `${role}:${payload.furnitureBodyType ?? 'sedan'}:${paint}`
    : role;
  if (!furnitureMaterials.has(key)) {
    const material = role === 'furnitureCar'
      ? createCarMaterialForType(paint, payload.furnitureBodyType ?? 'sedan')
      : FURNITURE_MATERIAL_FACTORIES[role]?.();
    if (!material) return getSidewalkMaterials().slab;
    furnitureMaterials.set(key, material);
    sharedCityMaterials.add(material);
  }
  return furnitureMaterials.get(key);
}

function tagFurnitureMeshes(cityGroup, castShadows = true) {
  const furniture = cityGroup.getObjectByName('StreetFurniture');
  furniture?.traverse((mesh) => {
    if (!mesh.isMesh) return;
    mesh.userData.skipLevelRaycast = true;
    mesh.userData.materialRole = `furniture${mesh.name.replace(/[^A-Za-z0-9]/g, '')}`;
    mesh.layers.set(CITY_FURNITURE_LAYER);
    // Only large furniture makes a useful clipmap-shadow contribution.
    mesh.castShadow = castShadows && (mesh.name === 'Car' || mesh.name === 'StreetTrees');
  });
}

function buildCarColliders(cars, { originX, originZ, chunkKey }) {
  return cars.map(({ matrix }, index) => {
    const e = matrix.elements;
    const alongZ = Math.abs(e[10]) > Math.abs(e[8]);
    const width = alongZ ? 2.05 : 4.75;
    const depth = alongZ ? 4.75 : 2.05;
    const x = originX + e[12];
    const z = originZ + e[14];
    return {
      name: `Street Car ${chunkKey}-${index + 1}`,
      minX: x - width / 2,
      maxX: x + width / 2,
      minZ: z - depth / 2,
      maxZ: z + depth / 2,
      bottomY: 0.18,
      topY: 1.62,
      width,
      depth,
      vaultable: false,
      noGroundSnap: true,
      chunkKey,
      role: 'vehicleObstacle',
    };
  });
}

function assertTowerCollisionLockstep(towers, buildings, originX, originZ) {
  if (towers.length !== buildings.length) {
    throw new Error(`City tower/collision count drift: ${towers.length} !== ${buildings.length}`);
  }
  const epsilon = 1e-7;
  for (let index = 0; index < towers.length; index += 1) {
    const tower = towers[index];
    const collider = buildings[index].collider;
    const matches =
      Math.abs(collider.minX - (originX + tower.x - tower.w / 2)) < epsilon
      && Math.abs(collider.maxX - (originX + tower.x + tower.w / 2)) < epsilon
      && Math.abs(collider.minZ - (originZ + tower.z - tower.d / 2)) < epsilon
      && Math.abs(collider.maxZ - (originZ + tower.z + tower.d / 2)) < epsilon
      && Math.abs(collider.topY - (tower.y + tower.h / 2)) < epsilon;
    if (!matches) {
      throw new Error(`City tower/collision PRNG drift at tower ${index}`);
    }
  }
}

// Compact the slab/curb InstancedMeshes down to the blocks whose keep flag is
// set (flags are in the generator's (bx,bz) block order, one instance each).
const _sidewalkInstanceMatrix = new THREE.Matrix4();

function sidewalkBelongsToChunk(collider, chunkX, chunkZ, strideX, strideZ) {
  const centerX = (collider.minX + collider.maxX) * 0.5;
  const centerZ = (collider.minZ + collider.maxZ) * 0.5;
  return Math.round(centerX / strideX) === chunkX && Math.round(centerZ / strideZ) === chunkZ;
}

// Full-block instanced sidewalks cannot be width-trimmed like clipped asphalt.
// Reject blocks unless essentially their entire footprint lies inside the zone
// (same conservative rule as clippedSurfaceCells for roads). Inset slightly so
// the curb ring (which reaches the block bbox) does not bleed past polygon edges.
function sidewalkKeepInZone(zone, collider) {
  if (!zone) return true;
  const margin = 0.15;
  const test = {
    minX: collider.minX + margin,
    maxX: collider.maxX - margin,
    minZ: collider.minZ + margin,
    maxZ: collider.maxZ - margin,
  };
  if (test.maxX <= test.minX || test.maxZ <= test.minZ) return false;
  if (zone.shape === 'rect') {
    return rectInsideZone(zone, test);
  }
  const cells = clippedSurfaceCells(zone, test);
  if (cells.length === 0) return false;
  const blockArea = (test.maxX - test.minX) * (test.maxZ - test.minZ);
  let clippedArea = 0;
  for (const cell of cells) {
    clippedArea += (cell.maxX - cell.minX) * (cell.maxZ - cell.minZ);
  }
  return clippedArea >= blockArea * 0.98;
}

function shouldKeepSidewalk(cityZone, collider, chunkX, chunkZ) {
  const stride = getCityStride();
  if (!sidewalkBelongsToChunk(collider, chunkX, chunkZ, stride.x, stride.z)) {
    return false;
  }
  return sidewalkKeepInZone(cityZone, collider);
}

function filterSidewalkInstances(cityGroup, keep) {
  const sidewalkGroup = cityGroup.getObjectByName('Sidewalk');

  if (!sidewalkGroup) {
    return;
  }

  for (const mesh of sidewalkGroup.children.slice()) {
    if (!mesh.isInstancedMesh) continue;
    let write = 0;
    for (let read = 0; read < mesh.count; read += 1) {
      if (!keep[read]) continue;
      if (write !== read) {
        mesh.getMatrixAt(read, _sidewalkInstanceMatrix);
        mesh.setMatrixAt(write, _sidewalkInstanceMatrix);
      }
      write += 1;
    }
    if (write === 0) {
      mesh.removeFromParent();
      continue;
    }

    mesh.count = write;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }
}

function buildLowRiseDistrict({ seed, cityStyle, cityZone = null, chunkKey, chunkX = 0, chunkZ = 0, originX, originZ, geometry, includeDebugOverlay = true, extractTraversal = true, castShadows = true }) {
  const city = new CityGenerator({ ...CITY_PARAMETERS, seed });
  const layout = city.layout;
  const floorW = layout.cityW + layout.street;
  const floorD = layout.cityD + layout.street;
  const roadW = layout.cityW + 2 * layout.street;
  const roadD = layout.cityD + 2 * layout.street;
  const random = createRandom(seed);
  const group = new THREE.Group();
  group.name = `Generator City Chunk ${chunkKey}`;
  Object.assign(group.userData, { cityChunkKey: chunkKey, cityChunkX: chunkX, cityChunkZ: chunkZ, cityStyle });
  const colliders = createRoadSurfaceColliders(cityZone, {
    minX: originX - roadW / 2,
    maxX: originX + roadW / 2,
    minZ: originZ - roadD / 2,
    maxZ: originZ + roadD / 2,
  }, chunkKey, 'District Road').map((collider) => ({ ...collider, role: 'surface' }));
  const buildings = [];
  const records = [];
  const parts = new Map();
  const addPart = (role, source, position, rotationY = 0) => {
    if (!geometry) { source.dispose(); return; }
    const matrix = new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY), new THREE.Vector3(1, 1, 1));
    source.applyMatrix4(matrix);
    if (!parts.has(role)) parts.set(role, []);
    parts.get(role).push(source);
  };
  const box = (role, x, y, z, w, h, d) => addPart(role, new THREE.BoxGeometry(w, h, d), new THREE.Vector3(x, y, z));
  const plane = (role, x, y, z, w, d) => {
    if (!cityZone) return addPart(role, new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.Vector3(x, y, z));
    for (const cell of clippedSurfaceCells(cityZone, { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 })) {
      addPart(role, new THREE.PlaneGeometry(cell.maxX - cell.minX, cell.maxZ - cell.minZ).rotateX(-Math.PI / 2),
        new THREE.Vector3((cell.minX + cell.maxX) / 2, y, (cell.minZ + cell.maxZ) / 2));
    }
  };
  plane('asphalt', originX, 0.005, originZ, roadW, roadD);
  const addBuilding = ({ name, x, z, w, d, bodyH, roofH = 0, kind }) => {
    const collider = { name, role: 'building', minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2,
      bottomY: 0.12, topY: 0.12 + bodyH + roofH, width: w, depth: d, vaultable: false, noGroundSnap: true, chunkKey };
    colliders.push(collider, createRoofFloorCollider(collider));
    buildings.push({ name, height: bodyH + roofH, centerX: x, centerZ: z, collider, layout });
    records.push({ kind, x, z, width: w, depth: d, height: bodyH + roofH });
    return collider;
  };

  if (cityStyle === 'suburbs') {
    const cols = 4, rows = 2, lotW = layout.cityW / cols, lotD = layout.cityD / rows;
    for (let ix = 0; ix < cols; ix += 1) for (let iz = 0; iz < rows; iz += 1) {
      const x = originX - layout.cityW / 2 + lotW * (ix + 0.5);
      const z = originZ - layout.cityD / 2 + lotD * (iz + 0.5);
      const w = Math.min(lotW - 7, 12 + random() * 5), d = Math.min(lotD - 12, 10 + random() * 5);
      const bodyH = (random() > 0.62 ? 2 : 1) * 3.1, roofH = 2.2 + random() * 1.2;
      const hz = z + (random() - 0.5) * 3;
      plane('lawn', x, 0.025, z, lotW - 1, lotD - 1);
      if (cityZone && !rectInsideZone(cityZone, { minX: x - lotW / 2, maxX: x + lotW / 2, minZ: z - lotD / 2, maxZ: z + lotD / 2 })) continue;
      const driveX = x + (random() > 0.5 ? 1 : -1) * (w / 2 + 1.5);
      plane('concrete', driveX, 0.04, z + (iz === 0 ? lotD * 0.25 : -lotD * 0.25), 3.2, lotD * 0.52);
      box('siding', x, 0.12 + bodyH / 2, hz, w, bodyH, d);
      addPart('roof', new THREE.ConeGeometry(Math.max(w, d) * 0.7, roofH, 4), new THREE.Vector3(x, 0.12 + bodyH + roofH / 2, hz), Math.PI / 4);
      const garageW = 3.8, garageD = 5;
      box('siding', driveX, 1.55, hz, garageW, 3, garageD);
      const house = addBuilding({ name: `House ${chunkKey}-${ix}-${iz}`, x, z: hz, w, d, bodyH, roofH, kind: 'house' });
      colliders.push({ ...house, name: `Garage ${chunkKey}-${ix}-${iz}`, minX: driveX - garageW / 2, maxX: driveX + garageW / 2,
        minZ: hz - garageD / 2, maxZ: hz + garageD / 2, width: garageW, depth: garageD, topY: 3.05 });
      records.push({ kind: 'roof', x, z: hz }, { kind: 'yard', x, z }, { kind: 'driveway', x: driveX, z }, { kind: 'garage', x: driveX, z: hz });
    }
    plane('concrete', originX, 0.055, originZ - layout.cityD / 2 + 1.5, layout.cityW, 2.2);
    plane('concrete', originX, 0.055, originZ + layout.cityD / 2 - 1.5, layout.cityW, 2.2);
  } else {
    const bigBox = random() >= 0.45;
    const storeW = layout.cityW * (bigBox ? 0.62 : 0.78), storeD = layout.cityD * (bigBox ? 0.30 : 0.22);
    const storeX = originX + (bigBox ? 0 : layout.cityW * 0.05), storeZ = originZ - layout.cityD * 0.31;
    const storeH = (bigBox ? 9 : 6.5) + random() * 3;
    plane('parking', originX, 0.03, originZ + layout.cityD * 0.12, layout.cityW - 2, layout.cityD * 0.58);
    const storeInside = !cityZone || rectInsideZone(cityZone, { minX: storeX - storeW / 2, maxX: storeX + storeW / 2, minZ: storeZ - storeD / 2, maxZ: storeZ + storeD / 2 });
    if (storeInside) {
    box('masonry', storeX, storeH / 2 + 0.08, storeZ, storeW, storeH, storeD);
    box('storefront', storeX, 2.4, storeZ + storeD / 2 + 0.08, storeW * 0.88, 4.2, 0.22);
    box('canopy', storeX, 4.5, storeZ + storeD / 2 + 1.2, storeW * 0.65, 0.35, 2.4);
    box('roof', storeX, storeH + 0.18, storeZ, storeW + 0.5, 0.35, storeD + 0.5);
    addBuilding({ name: `${bigBox ? 'Big Box Store' : 'Strip Mall'} ${chunkKey}`, x: storeX, z: storeZ, w: storeW, d: storeD, bodyH: storeH, kind: bigBox ? 'store' : 'stripMall' });
    }
    records.push({ kind: 'parking', x: originX, z: originZ });
    for (let row = 0; row < 3; row += 1) for (let stall = -7; stall <= 7; stall += 1) {
      const x = originX + stall * 3.1 - 1.45, z = originZ - layout.cityD * 0.02 + row * 7.2;
      if (!cityZone || rectInsideZone(cityZone, { minX: x - 0.045, maxX: x + 0.045, minZ: z - 2.6, maxZ: z + 2.6 })) {
        box('marking', x, 0.065, z, 0.09, 0.025, 5.2);
      }
    }
    for (const side of [-1, 1]) {
      const x = originX + side * layout.cityW * 0.23;
      const z = originZ + layout.cityD * 0.17;
      if (cityZone && !rectInsideZone(cityZone, { minX: x - 2.75, maxX: x + 2.75, minZ: z - 1.2, maxZ: z + 1.2 })) continue;
      box('curb', x, 0.16, z, 5.5, 0.28, 2.4);
      colliders.push({ name: `Parking Island ${chunkKey}-${side}`, role: 'curb', minX: x - 2.75, maxX: x + 2.75,
        minZ: z - 1.2, maxZ: z + 1.2, bottomY: 0.02, topY: 0.30, width: 5.5, depth: 2.4, vaultable: true, chunkKey });
      records.push({ kind: 'parkingIsland', x, z });
    }
  }
  if (geometry) {
    const materials = getDistrictMaterials(cityStyle);
    for (const [role, geometries] of parts) {
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, materials[role] ?? materials.concrete);
      mesh.name = `${cityStyle} ${role} ${chunkKey}`;
      mesh.userData.materialRole = role;
      mesh.castShadow = castShadows && !['asphalt', 'parking', 'lawn', 'concrete', 'marking'].includes(role);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  const traversal = extractTraversal
    ? extractCityTraversal({ buildings })
    : { ledges: [], climbSurfaces: [], wallRunSurfaces: [] };
  if (geometry && includeDebugOverlay && extractTraversal) group.add(createTraversalDebugOverlay(traversal));
  return { chunkKey, chunkX, chunkZ, originX, originZ, seed, cityStyle, layout, floorW, floorD, group, colliders, records,
    ledges: traversal.ledges, climbSurfaces: traversal.climbSurfaces, wallRunSurfaces: traversal.wallRunSurfaces,
    ropes: [], traversalBuildings: buildings, traversalReady: extractTraversal,
    spawnPoint: new THREE.Vector3(originX, 0, originZ), dispose: () => disposeChunkGroup(group) };
}

function clippedSurfaceCells(zone, rect) {
  if (zone?.shape === 'rect') {
    const clipped = {
      minX: Math.max(rect.minX, zone.rect.minX), maxX: Math.min(rect.maxX, zone.rect.maxX),
      minZ: Math.max(rect.minZ, zone.rect.minZ), maxZ: Math.min(rect.maxZ, zone.rect.maxZ),
    };
    return clipped.maxX > clipped.minX && clipped.maxZ > clipped.minZ ? [clipped] : [];
  }
  // Polygon surfaces are conservatively tessellated. Keeping all four corners
  // inside guarantees no generated asphalt/lawn crosses the authored edge.
  const size = 3;
  const cells = [];
  for (let minX = rect.minX; minX < rect.maxX; minX += size) {
    for (let minZ = rect.minZ; minZ < rect.maxZ; minZ += size) {
      const cell = { minX, maxX: Math.min(minX + size, rect.maxX), minZ, maxZ: Math.min(minZ + size, rect.maxZ) };
      if (rectInsideZone(zone, cell)) cells.push(cell);
    }
  }
  return cells;
}

function createRoadSurfaceColliders(zone, rect, chunkKey, namePrefix) {
  let cells = zone ? clippedSurfaceCells(zone, rect) : [rect];
  // Polygon clipping produces 3 m cells for visual tessellation. Merge adjacent
  // cells along each row so physics receives a few strips instead of thousands
  // of tiny boxes, while retaining the exact visible footprint.
  if (zone?.shape !== 'rect' && cells.length > 1) {
    cells = [...cells]
      .sort((a, b) => a.minZ - b.minZ || a.maxZ - b.maxZ || a.minX - b.minX)
      .reduce((strips, cell) => {
        const previous = strips.at(-1);
        if (
          previous
          && Math.abs(previous.minZ - cell.minZ) < 1e-6
          && Math.abs(previous.maxZ - cell.maxZ) < 1e-6
          && Math.abs(previous.maxX - cell.minX) < 1e-6
        ) {
          previous.maxX = cell.maxX;
        } else {
          strips.push({ ...cell });
        }
        return strips;
      }, []);
  }
  return cells.map((cell, index) => ({
    name: `${namePrefix} ${chunkKey}${cells.length > 1 ? `-${index}` : ''}`,
    minX: cell.minX,
    maxX: cell.maxX,
    minZ: cell.minZ,
    maxZ: cell.maxZ,
    topY: 0,
    bottomY: -CITY_ROAD_COLLIDER_THICKNESS,
    width: cell.maxX - cell.minX,
    depth: cell.maxZ - cell.minZ,
    vaultable: false,
    surface: 'asphalt',
    chunkKey,
  }));
}

function rectInsideZone(zone, rect) {
  return pointInsideZone(zone, rect.minX, rect.minZ) && pointInsideZone(zone, rect.maxX, rect.minZ)
    && pointInsideZone(zone, rect.maxX, rect.maxZ) && pointInsideZone(zone, rect.minX, rect.maxZ);
}

function pointInsideZone(zone, x, z) {
  if (!zone) return true;
  if (zone.shape === 'rect') return x >= zone.rect.minX && x <= zone.rect.maxX && z >= zone.rect.minZ && z <= zone.rect.maxZ;
  const points = zone.points ?? [];
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if (((a.z > z) !== (b.z > z)) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

const districtMaterialCache = new Map();
function getDistrictMaterials(style) {
  if (style === 'downtown' || !style) return {};
  if (districtMaterialCache.has(style)) return districtMaterialCache.get(style);
  const colors = style === 'suburbs'
    ? { asphalt: 0x202327, lawn: 0x4e713b, concrete: 0xaaa79b, siding: 0xb59c7b, roof: 0x493d38 }
    : { asphalt: 0x202327, parking: 0x292c30, masonry: 0x8b7965, storefront: 0x315060, canopy: 0xb84b35, roof: 0x3b3b3b, curb: 0xb5b1a5, marking: 0xe8dfba, concrete: 0xaaa79b };
  const result = {};
  for (const [role, hex] of Object.entries(colors)) {
    const material = new MeshStandardNodeMaterial({ roughness: role === 'storefront' ? 0.25 : 0.86, metalness: role === 'storefront' ? 0.18 : 0.02 });
    const variation = fract(sin(positionWorld.x.mul(0.13).add(positionWorld.z.mul(0.17))).mul(43758.5453));
    material.colorNode = mix(color(hex).mul(0.88), color(hex).mul(1.08), variation);
    result[role] = material;
    sharedCityMaterials.add(material);
  }
  districtMaterialCache.set(style, result);
  return result;
}

// City chunks share one building + road + sidewalk material. All of them are world-space
// (procedural variation is driven by positionWorld / deterministic noise, no per-chunk
// params), so a single instance tiles seamlessly across every chunk. Crucially this means a
// single TSL program is compiled once instead of recompiled per chunk — the per-chunk
// building material used a literal seed baked into the shader source, so every streamed
// chunk was forcing a full GLSL compile+link, a major source of the stream-in hitch.
// `sharedCityMaterials` tracks these so per-chunk dispose never frees them.
const sharedCityMaterials = new Set();
let cachedSidewalkMaterials = null;
let cachedBuildingMaterial = null;
let cachedRoadMaterial = null;
let cachedGenericSidewalkMaterial = null;

function getGenericSidewalkMaterial() {
  if (!cachedGenericSidewalkMaterial) {
    cachedGenericSidewalkMaterial = new THREE.MeshStandardMaterial({
      color: 0xb9b6aa,
      roughness: 0.86,
      metalness: 0.02,
    });
    sharedCityMaterials.add(cachedGenericSidewalkMaterial);
  }
  return cachedGenericSidewalkMaterial;
}

// The building material uses a constant seed equal to the spawn chunk's (seedForChunk(0,0)
// === CITY_SEED), so streamed chunks match the centre chunk exactly and there are no seams.
function getBuildingMaterial(layout) {
  if (cachedBuildingMaterial) {
    return cachedBuildingMaterial;
  }
  cachedBuildingMaterial = buildBuildingMaterial(layout, CITY_SEED);
  sharedCityMaterials.add(cachedBuildingMaterial);
  return cachedBuildingMaterial;
}

function getRoadMaterial(layout) {
  if (cachedRoadMaterial) {
    return cachedRoadMaterial;
  }
  cachedRoadMaterial = createRoadMaterial(layout, { rainWetness, rainWind });
  sharedCityMaterials.add(cachedRoadMaterial);
  return cachedRoadMaterial;
}

// The SidewalkGenerator owns its procedural concrete/curb materials but only creates them
// inside build(). Run one throwaway build to populate the cache, then free its geometry —
// dispose() nulls the mesh but leaves the materials behind. The materials are world-space
// (deterministic noise, no per-chunk params) so one pair is reused across every streamed chunk.
function getSidewalkMaterials() {
  if (cachedSidewalkMaterials) {
    return cachedSidewalkMaterials;
  }

  const generator = new SidewalkGenerator({ width: 90, depth: 60 });
  generator.build([new THREE.Matrix4()]);
  cachedSidewalkMaterials = { slab: generator.material, curb: generator.curbMaterial };
  sharedCityMaterials.add(cachedSidewalkMaterials.slab);
  sharedCityMaterials.add(cachedSidewalkMaterials.curb);
  generator.dispose();
  return cachedSidewalkMaterials;
}

// Dispose a chunk's GPU resources without touching the shared (cached) materials — unloading
// one chunk must not destroy the materials every other loaded chunk is still rendering.
function disposeChunkGroup(group) {
  group.traverse((child) => {
    child.geometry?.dispose();

    const material = child.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        if (!sharedCityMaterials.has(entry)) {
          entry.dispose();
        }
      }
      return;
    }

    if (material && !sharedCityMaterials.has(material)) {
      material.dispose();
    }
  });
}



function buildBuildingMaterial(layout, seed) {
  const palette = [
    color(0xc6c0b2), color(0xc6c0b2), color(0xbdb7a8), color(0xd1ccbe), color(0xb4afa1),
    color(0x9a988f), color(0x8b8983), color(0xa5a39a),
    color(0xb1a484), color(0xbcae8b),
    color(0x80705b), color(0x786755),
    color(0x946d5b), color(0x885f4e),
    color(0xdbd6cb),
    color(0x7c868d),
    color(0x4c4943),
  ];

  const periodX = layout.blockW + layout.street;
  const periodZ = layout.blockD + layout.street;
  const gx = positionWorld.x.add(layout.cityW / 2);
  const gz = positionWorld.z.add(layout.cityD / 2);
  const blockIX = floor(gx.div(periodX));
  const blockIZ = floor(gz.div(periodZ));
  const cellX = blockIX.mul(layout.lotsX).add(floor(gx.sub(blockIX.mul(periodX)).div(layout.lot)));
  const cellZ = blockIZ.mul(layout.lotsZ).add(floor(gz.sub(blockIZ.mul(periodZ)).div(layout.lot)));
  const cellHash = (a, b) => fract(sin(cellX.mul(a).add(cellZ.mul(b)).add(seed)).mul(43758.5453));

  const pick = cellHash(127.1, 311.7);
  let buildingBase = palette[0];
  for (let i = 1; i < palette.length; i += 1) {
    buildingBase = mix(buildingBase, palette[i], step(i / palette.length, pick));
  }
  const ageVariation = cellHash(269.5, 183.3).mul(0.14).add(0.9);
  const sootMask = step(0.76, cellHash(43.9, 219.4));
  const mossMask = step(0.88, cellHash(119.5, 17.3));
  const rustMask = step(0.9, cellHash(211.1, 73.7));
  const verticalStreaks = step(
    0.9,
    fract(sin(positionWorld.x.mul(0.17).add(positionWorld.z.mul(0.23)).add(seed)).mul(19873.241)),
  );

  buildingBase = buildingBase.mul(ageVariation);
  buildingBase = mix(buildingBase, color(0x3f3d36), sootMask.mul(0.08));
  buildingBase = mix(buildingBase, color(0x586346), mossMask.mul(0.05));
  buildingBase = mix(buildingBase, color(0x8a5b45), rustMask.mul(0.05));
  buildingBase = mix(buildingBase, color(0x34332d), verticalStreaks.mul(0.06));

  return createSkyscraperMaterial(varying(buildingBase));
}

function buildCollisionLayout(layout, seed, parameters = {}, { chunkKey = '0:0', originX = 0, originZ = 0 } = {}) {
  const curbHeight = parameters.curbHeight ?? 0;
  const sidewalkWidth = parameters.sidewalkWidth ?? layout.sidewalkWidth ?? 5;
  const sidewalks = [];
  const buildings = [];
  const random = createRandom(seed);

  for (let bx = 0; bx < layout.blocksX; bx += 1) {
    for (let bz = 0; bz < layout.blocksZ; bz += 1) {
      const blockX = originX - layout.cityW / 2 + bx * (layout.blockW + layout.street);
      const blockZ = originZ - layout.cityD / 2 + bz * (layout.blockD + layout.street);
      const sidewalk = {
        name: `Sidewalk Slab ${chunkKey}-${bx + 1}-${bz + 1}`,
        minX: blockX,
        maxX: blockX + layout.blockW,
        minZ: blockZ,
        maxZ: blockZ + layout.blockD,
        topY: curbHeight,
        bottomY: 0,
        width: layout.blockW,
        depth: layout.blockD,
        vaultable: false,
        chunkKey,
      };

      sidewalks.push({
        name: sidewalk.name,
        collider: sidewalk,
      });

      const zoneX = blockX + sidewalkWidth;
      const zoneZ = blockZ + sidewalkWidth;

      for (let lx = 0; lx < layout.lotsX; lx += 1) {
        for (let lz = 0; lz < layout.lotsZ; lz += 1) {
          const cornerX = lx === 0 ? -1 : (lx === layout.lotsX - 1 ? 1 : 0);
          const cornerZ = lz === 0 ? -1 : (lz === layout.lotsZ - 1 ? 1 : 0);
          const corner = cornerX !== 0 && cornerZ !== 0;
          // Lockstep contract with CityGenerator.build(): tall -> width -> depth
          // -> seed -> style draws. Do not filter lots or alter this sequence.
          const tall = random();
          const width = layout.innerLotX - (0.4 + random());
          const depth = layout.innerLotZ - (0.4 + random());
          const height = 38 + tall * tall * 114;
          random(); // SkyscraperGenerator seed.
          random(); // floorHeight
          random(); // bayWidth
          random(); // pierWidth
          random(); // pierDepth
          if (corner) random(); // chamferWidth
          if (random() < 0.4) {
            random(); // setbackDepth
          }
          // stringCourseEvery: CityGenerator draws a probability and, when it passes
          // (< 0.85), a SECOND draw for the floor count (`3 + Math.floor(random()*6)`).
          // Mirror both so this layout's PRNG stays in lockstep with the generated mesh.
          // Without the second draw, every building after the first drifted by one random,
          // so its predicted height/footprint (-> collider topY) no longer matched the real
          // tower — the roof cuboid and ground-snap then resolved to the wrong height and
          // dumped the player off the roof (teleport to the road inside the footprint).
          if (random() < 0.85) {
            random(); // Math.floor(random() * 6)
          }

          const lotLeft = zoneX + lx * layout.innerLotX;
          const lotNear = zoneZ + lz * layout.innerLotZ;
          const x = cornerX === -1
            ? lotLeft + width / 2
            : (cornerX === 1 ? lotLeft + layout.innerLotX - width / 2 : lotLeft + layout.innerLotX / 2);
          const z = cornerZ === -1
            ? lotNear + depth / 2
            : (cornerZ === 1 ? lotNear + layout.innerLotZ - depth / 2 : lotNear + layout.innerLotZ / 2);
          const collider = {
            name: `Gothic Tower ${chunkKey}-${bx + 1}-${bz + 1}-${lx + 1}-${lz + 1}`,
            minX: x - width * 0.5,
            maxX: x + width * 0.5,
            minZ: z - depth * 0.5,
            maxZ: z + depth * 0.5,
            topY: curbHeight + height,
            bottomY: curbHeight,
            width,
            depth,
            vaultable: false,
            noGroundSnap: true,
            chunkKey,
            role: 'building',
          };

          buildings.push({
            name: collider.name,
            height,
            corner,
            cornerX,
            cornerZ,
            bx,
            bz,
            lx,
            lz,
            centerX: x,
            centerZ: z,
            layout,
            collider,
          });
        }
      }
    }
  }

  return { sidewalks, buildings };
}

function createRoofFloorCollider(collider) {
  return {
    name: `${collider.name} Roof Floor`,
    minX: collider.minX,
    maxX: collider.maxX,
    minZ: collider.minZ,
    maxZ: collider.maxZ,
    topY: collider.topY,
    bottomY: collider.topY - ROOF_FLOOR_COLLIDER_THICKNESS,
    width: collider.width,
    depth: collider.depth,
    vaultable: false,
    noGroundSnap: true,
    roofFloor: true,
    chunkKey: collider.chunkKey,
  };
}

function addTopLedges({ ledges, name, collider, hangMode }) {
  ledges.push(
    {
      name: `${name} Front Roof Ledge`,
      blockName: name,
      face: 'front',
      hangMode,
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      y: collider.topY,
      x: (collider.minX + collider.maxX) * 0.5,
      z: collider.maxZ,
      normal: { x: 0, y: 0, z: 1 },
      tangent: { x: 1, y: 0, z: 0 },
    },
    {
      name: `${name} Back Roof Ledge`,
      blockName: name,
      face: 'back',
      hangMode,
      axis: 'x',
      min: collider.minX,
      max: collider.maxX,
      y: collider.topY,
      x: (collider.minX + collider.maxX) * 0.5,
      z: collider.minZ,
      normal: { x: 0, y: 0, z: -1 },
      tangent: { x: -1, y: 0, z: 0 },
    },
  );
}

function addClimbSurface({ climbSurfaces, name, collider, face }) {
  const front = face !== 'back';
  climbSurfaces.push({
    name: `${name} Stone Climb Surface`,
    blockName: name,
    face,
    origin: {
      x: (collider.minX + collider.maxX) * 0.5,
      y: collider.bottomY + 0.55,
      z: front ? collider.maxZ + 0.04 : collider.minZ - 0.04,
    },
    normal: { x: 0, y: 0, z: front ? 1 : -1 },
    tangent: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    minU: -collider.width * 0.36,
    maxU: collider.width * 0.36,
    minV: 0.2,
    maxV: Math.max(1, collider.topY - collider.bottomY - 0.8),
    rootOffset: 0.38,
  });
}

function addWallRunSurface({ wallRunSurfaces, name, collider, face }) {
  const right = face === 'right';
  const origin = right
    ? { x: collider.maxX + 0.04, y: collider.bottomY + 0.3, z: collider.minZ + 0.3 }
    : { x: collider.minX + 0.3, y: collider.bottomY + 0.3, z: collider.maxZ + 0.04 };
  wallRunSurfaces.push({
    name: `${name} Wall Run Surface`,
    blockName: name,
    origin,
    normal: right ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 },
    tangent: right ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    minU: 0.2,
    maxU: (right ? collider.depth : collider.width) - 0.6,
    minV: 0.12,
    maxV: Math.min(3.4, collider.topY - collider.bottomY - 0.2),
    rootOffset: 0,
    handYOffset: 1.22,
    handForwardOffset: -0.28,
    handNormalOffset: 0,
  });
}

function createRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
