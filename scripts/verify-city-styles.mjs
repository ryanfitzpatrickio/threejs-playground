import assert from 'node:assert/strict';
import * as THREE from 'three';
import { normalizeWorldMap, CITY_STYLE_ORDER } from '../src/world/worldMap/worldMapSchema.js';
import { getCityStride, buildSkeletonColliderData, createCityMaterialWarmupGroup, createGeneratorCityLevel, serializeGeneratorCityChunk, createGeneratorCityChunkFromPayload } from '../src/game/world/createGeneratorCityLevel.js';
import { seedForChunk } from '../src/game/world/createInfiniteCityLevel.js';
import { resolveCityChunkDistrict } from '../src/game/world/createComposedWorldLevel.js';
import { extractCityTraversal } from '../src/game/world/extractCityTraversal.js';

const zone = (id, style, seed, rect) => ({ id, type: 'city', shape: 'rect', rect, props: { cityStyle: style, seed } });
const legacy = normalizeWorldMap({ zones: [{ id: 'legacy', type: 'city', shape: 'rect', rect: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 } }] });
assert.equal(legacy.zones[0].props.cityStyle, 'downtown');

const roundTrip = normalizeWorldMap(JSON.parse(JSON.stringify({ zones: [zone('z', 'suburbs', 913, { minX: -20, minZ: -20, maxX: 20, maxZ: 20 })] })));
assert.equal(roundTrip.zones[0].props.cityStyle, 'suburbs');
assert.equal(roundTrip.zones[0].props.seed, 913);
assert.equal(seedForChunk(3, -2, 913), seedForChunk(3, -2, 913));
assert.notEqual(seedForChunk(3, -2, 913), seedForChunk(3, -2, 914));

const stride = getCityStride();
const chunks = new Map();
for (const style of CITY_STYLE_ORDER) {
  const options = { cityStyle: style, seed: seedForChunk(1, 2, 913), chunkKey: `1:2-${style}`, chunkX: 1, chunkZ: 2, originX: stride.x, originZ: stride.z * 2, includeDebugOverlay: false };
  const skeleton = buildSkeletonColliderData(options);
  assert.equal(skeleton.floorW, stride.x);
  assert.equal(skeleton.floorD, stride.z);
  if (style === 'downtown') continue;
  const chunk = createGeneratorCityLevel(options);
  chunks.set(style, chunk);
  const skeletonBuildings = skeleton.colliders.filter((c) => c.role === 'building').map(footprint);
  const fullBuildings = chunk.colliders.filter((c) => c.role === 'building' && !c.roofFloor).map(footprint);
  assert.deepEqual(skeletonBuildings, fullBuildings, `${style} skeleton footprints`);
  const payload = serializeGeneratorCityChunk(chunk);
  assert.equal(payload.cityStyle, style);
  assert.ok(payload.meshes.every((mesh) => mesh.materialRole), `${style} material roles`);
  const rebuilt = createGeneratorCityChunkFromPayload(payload);
  assert.equal(rebuilt.cityStyle, style);
  assert.deepEqual(rebuilt.records, chunk.records);
  assert.ok(rebuilt.group.children.every((mesh) => mesh.userData.materialRole), `${style} reconstructed roles`);
  rebuilt.dispose();
}

const suburbKinds = new Set(chunks.get('suburbs').records.map((r) => r.kind));
for (const kind of ['house', 'roof', 'yard', 'driveway', 'garage']) assert.ok(suburbKinds.has(kind), `suburbs ${kind}`);
const commercialKinds = new Set(chunks.get('commercial').records.map((r) => r.kind));
assert.ok(commercialKinds.has('store') || commercialKinds.has('stripMall'));
assert.ok(commercialKinds.has('parking'));
assert.ok(serializeGeneratorCityChunk(chunks.get('commercial')).meshes.some((m) => m.materialRole === 'marking'));
assert.notDeepEqual(chunks.get('suburbs').records, chunks.get('commercial').records);

// Wide enough to contain complete street-fronted inner lots from the upstream
// layout while still clipping both axes. The old rect only intersected towers;
// none fit wholly inside after adopting the sidewalk setback/building line.
const clipRect = { minX: -45, minZ: -45, maxX: 75, maxZ: 75 };
const clipped = createGeneratorCityLevel({ cityStyle: 'suburbs', cityZone: { shape: 'rect', rect: clipRect }, seed: 42, chunkKey: 'clipped', includeDebugOverlay: false });
for (const mesh of clipped.group.children) {
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  assert.ok(bounds.min.x >= clipRect.minX - 1e-6 && bounds.max.x <= clipRect.maxX + 1e-6, `${mesh.name} x clip`);
  assert.ok(bounds.min.z >= clipRect.minZ - 1e-6 && bounds.max.z <= clipRect.maxZ + 1e-6, `${mesh.name} z clip`);
}
clipped.dispose();

// Downtown must clip to the authored zone too: towers, sidewalk blocks, and the
// road plane outside the rect are dropped, and skeleton colliders match the
// full build (same rectInsideZone filter on both paths).
const dtZone = { shape: 'rect', rect: clipRect };
const dtOptions = { cityStyle: 'downtown', cityZone: dtZone, seed: 42, chunkKey: 'dt-clip', includeDebugOverlay: false };
const dtSkeleton = buildSkeletonColliderData(dtOptions);
const dtChunk = createGeneratorCityLevel(dtOptions);
const dtSkeletonBuildings = dtSkeleton.colliders.filter((c) => c.role === 'building').map(footprint);
const dtFullBuildings = dtChunk.colliders.filter((c) => c.role === 'building' && !c.roofFloor).map(footprint);
assert.ok(dtFullBuildings.length > 0, 'downtown clip keeps in-zone towers');
assert.deepEqual(dtSkeletonBuildings, dtFullBuildings, 'downtown clipped skeleton footprints');
const dtUnclipped = createGeneratorCityLevel({ ...dtOptions, cityZone: null, chunkKey: 'dt-full' });
const furnitureMeshes = [];
dtUnclipped.group.getObjectByName('StreetFurniture')?.traverse((mesh) => {
  if (mesh.isMesh) furnitureMeshes.push(mesh);
});
assert.ok(furnitureMeshes.length >= 7, 'downtown builds enabled furniture categories');
assert.ok(furnitureMeshes.every((mesh) => mesh.userData.skipLevelRaycast), 'furniture skips level raycasts');
assert.ok(dtUnclipped.colliders.some((collider) => collider.role === 'vehicleObstacle'), 'cars receive obstacle colliders');
const dtUnclippedPayload = serializeGeneratorCityChunk(dtUnclipped);
const serializedFurniture = dtUnclippedPayload.meshes.filter((mesh) => mesh.materialRole?.startsWith('furniture'));
assert.equal(serializedFurniture.length, furnitureMeshes.length, 'furniture material roles serialize');
assert.ok(serializedFurniture.every((mesh) => mesh.skipLevelRaycast), 'furniture raycast flags serialize');
assert.ok(dtUnclippedPayload.meshes.every((mesh) => mesh.boundingBox && mesh.boundingSphere), 'worker ships mesh bounds');
const instancedPayload = dtUnclippedPayload.meshes.find((mesh) => mesh.instanced);
assert.ok(instancedPayload?.instanceMatrix?.buffer instanceof ArrayBuffer, 'instance matrices serialize as zero-copy views');
const dtPerformanceRebuilt = createGeneratorCityChunkFromPayload(dtUnclippedPayload);
const rebuiltInstanced = [];
dtPerformanceRebuilt.group.traverse((mesh) => { if (mesh.isInstancedMesh) rebuiltInstanced.push(mesh); });
assert.ok(rebuiltInstanced.some((mesh) => mesh.instanceMatrix.array.buffer === instancedPayload.instanceMatrix.buffer), 'rebuild adopts transferred matrix buffer');
dtPerformanceRebuilt.dispose();

const deferredTraversal = createGeneratorCityLevel({
  cityStyle: 'downtown', seed: 77, chunkKey: 'deferred-traversal',
  includeDebugOverlay: false, extractTraversal: false,
});
assert.equal(deferredTraversal.traversalReady, false);
assert.ok(deferredTraversal.traversalBuildings.length > 0, 'deferred chunk retains extraction input');
assert.equal(deferredTraversal.ledges.length + deferredTraversal.climbSurfaces.length + deferredTraversal.wallRunSurfaces.length, 0);
const deferredPayload = serializeGeneratorCityChunk(deferredTraversal);
const deferredRebuilt = createGeneratorCityChunkFromPayload(deferredPayload);
const backfilledTraversal = extractCityTraversal({ buildings: deferredRebuilt.traversalBuildings });
assert.ok(backfilledTraversal.ledges.length > 0, 'deferred serialized input supports traversal backfill');
deferredRebuilt.dispose();
deferredTraversal.dispose();

const warmup = createCityMaterialWarmupGroup();
const warmupMeshes = [];
warmup.traverse((mesh) => { if (mesh.isMesh) warmupMeshes.push(mesh); });
assert.ok(warmupMeshes.some((mesh) => mesh.isInstancedMesh), 'warmup includes instanced variants');
assert.ok(warmupMeshes.some((mesh) => !mesh.isInstancedMesh), 'warmup includes ordinary mesh variants');
assert.ok(new Set(warmupMeshes.map((mesh) => mesh.material)).size >= 10, 'warmup covers city material roles');
warmup.userData.disposeWarmup();
assert.ok(
  dtFullBuildings.length < dtUnclipped.colliders.filter((c) => c.role === 'building' && !c.roofFloor).length,
  'downtown clip drops out-of-zone towers',
);
for (const collider of dtChunk.colliders) {
  assert.ok(collider.minX >= clipRect.minX - 1e-6 && collider.maxX <= clipRect.maxX + 1e-6, `${collider.name} x clip`);
  assert.ok(collider.minZ >= clipRect.minZ - 1e-6 && collider.maxZ <= clipRect.maxZ + 1e-6, `${collider.name} z clip`);
}
const assertMeshesInsideZone = (root, label) => {
  root.updateMatrixWorld(true);
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    if (mesh.isInstancedMesh && mesh.count === 0) return;
    const bounds = new THREE.Box3().setFromObject(mesh);
    if (bounds.isEmpty()) return;
    assert.ok(bounds.min.x >= clipRect.minX - 1e-6 && bounds.max.x <= clipRect.maxX + 1e-6, `${label} ${mesh.name} x clip`);
    assert.ok(bounds.min.z >= clipRect.minZ - 1e-6 && bounds.max.z <= clipRect.maxZ + 1e-6, `${label} ${mesh.name} z clip`);
  });
};
assertMeshesInsideZone(dtChunk.group, 'downtown');
// Streamed path: the worker serializes the clipped chunk (including the compacted
// sidewalk InstancedMeshes) and the main thread rebuilds it inside the zone.
const dtRebuilt = createGeneratorCityChunkFromPayload(serializeGeneratorCityChunk(dtChunk));
assertMeshesInsideZone(dtRebuilt.group, 'downtown rebuilt');
dtRebuilt.dispose();
dtUnclipped.dispose();
dtChunk.dispose();

const overlap = [
  zone('first', 'suburbs', 10, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 }),
  zone('last', 'commercial', 20, { minX: -50, minZ: -50, maxX: 50, maxZ: 50 }),
];
assert.equal(resolveCityChunkDistrict(overlap, 0, 0, stride).style, 'commercial');
assert.equal(resolveCityChunkDistrict(overlap, 0, 0, stride).zoneSeed, 20);
assert.equal(resolveCityChunkDistrict([], 0, 0, stride), null);

for (const chunk of chunks.values()) chunk.dispose();
console.log('City style verification passed.');

function footprint(collider) {
  return [collider.minX, collider.maxX, collider.minZ, collider.maxZ, collider.topY, collider.bottomY];
}
