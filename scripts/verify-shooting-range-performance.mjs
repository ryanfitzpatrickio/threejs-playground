import assert from 'node:assert/strict';
import * as THREE from 'three';

import { getQualityPreset } from '../src/game/config/qualityPresets.js';
import { applyRangeLevelOverrides } from '../src/game/config/rangePerformance.js';
import { createShootingRangeLevel } from '../src/game/world/createShootingRangeLevel.js';

const baseUltra = getQualityPreset('ultra');
const rangeUltra = applyRangeLevelOverrides(baseUltra, 'range');

assert.notEqual(rangeUltra, baseUltra, 'range override returns a new preset');
assert.equal(baseUltra.environment.clouds, 'volumetric', 'base Ultra stays unchanged');
assert.equal(rangeUltra.environment.clouds, 'dome', 'range avoids hidden volumetric sky pass');
assert.equal(rangeUltra.environment.aerialPerspective, false, 'range omits exterior aerial post work');
assert.equal(rangeUltra.maxPixelRatio, 1.25, 'range caps full-screen target DPR');
assert.equal(rangeUltra.shadows, true, 'Ultra range retains directional shadows');
assert.equal(rangeUltra.shadowMapSize, 1024, 'range uses a focused 1k shadow map');
assert.equal(rangeUltra.ssao.enabled, true, 'Ultra range retains SSAO');
assert.equal(rangeUltra.ssao.samples, 8, 'range SSAO uses the performant sample count');
assert.equal(rangeUltra.ssao.updateInterval, 2, 'range SSAO is half rate');
assert.equal(rangeUltra.ssao.updateOnCameraMotion, false, 'camera motion preserves half-rate AO');

const level = createShootingRangeLevel(rangeUltra);
const census = {
  meshes: 0,
  pointLights: 0,
  triangles: 0,
};
level.group.traverse((object) => {
  if (object.isPointLight) census.pointLights += 1;
  if (!object.isMesh) return;
  census.meshes += 1;
  const primitives = object.geometry?.index?.count
    ?? object.geometry?.attributes?.position?.count
    ?? 0;
  census.triangles += primitives / 3;
});

const snapshot = level.snapshot();
assert.ok(snapshot.staticSourceMeshes >= 900, 'fixture still exercises the traced mesh-heavy layout');
assert.ok(snapshot.staticBatches <= 24, `static batches stay bounded (got ${snapshot.staticBatches})`);
assert.ok(census.meshes <= 24, `render mesh census stays bounded (got ${census.meshes})`);
assert.ok(census.pointLights <= 20, `clustered fill-light census stays bounded (got ${census.pointLights})`);
assert.ok(census.triangles >= 15_000, 'batching preserves authored geometry');
assert.ok(level.geometryIndex.entries.length <= 20, 'raycast/BVH index uses merged opaque batches');
assert.equal(level.group.userData.freezeStaticWorldMatrices, true);

const warmedMeshes = level.geometryIndex.warmupBoundsTrees({ maxMs: 1_000, maxCount: 100 });
assert.equal(warmedMeshes, level.geometryIndex.entries.length, 'merged range BVHs warm successfully');
const floorHits = level.geometryIndex.raycast({
  origin: new THREE.Vector3(0, 4, 0),
  direction: new THREE.Vector3(0, -1, 0),
  far: 10,
});
assert.ok(floorHits.length > 0, 'merged geometry index still raycasts the range floor');
assert.ok(Math.abs(floorHits[0].distance - 4) < 0.01, 'range floor raycast keeps world-space transforms');

level.dispose();
console.log('shooting-range performance verification passed', {
  sourceMeshes: snapshot.staticSourceMeshes,
  renderMeshes: census.meshes,
  staticBatches: snapshot.staticBatches,
  pointLights: census.pointLights,
  triangles: Math.round(census.triangles),
  geometryIndexMeshes: level.geometryIndex.entries.length,
});
