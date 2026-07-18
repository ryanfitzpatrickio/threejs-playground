import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDogParkLevel } from '../src/game/world/createDogParkLevel.js';

const level = createDogParkLevel({
  forestTreeBudget: 18,
  forestNearCount: 18,
  forestLodMode: 'static',
  shadows: false,
  dogParkHeroTrees: true,
});

try {
  await level.ready;
  assert.equal(level.name, 'Riverside Dog Park');
  assert.equal(level.snapshot().mode, 'dog-park');
  assert.ok(level.colliders.length >= 20, `expected park colliders, got ${level.colliders.length}`);
  assert.ok(level.geometryIndex.entries.length >= 30, 'park architecture should be raycastable');
  assert.ok(level.snapshot().forest.forestTrees >= 8, 'shared forest path should populate park trees');

  const spawnGround = level.getGroundHeightAt(level.dogSpawnPoint, 0.35, { maxStepUp: 0.5, maxSnapDown: 2 });
  assert.ok(Math.abs(spawnGround) < 0.05, `dog spawn ground is ${spawnGround}`);
  assert.equal(level.getSurfaceAt(-13, 7), 'sand');
  assert.equal(level.getSurfaceAt(-21, -5), 'mud');
  assert.equal(level.getSurfaceAt(10.5, 8.2), 'mud', 'authored shore wallow overrides lake water');
  assert.equal(level.getSurfaceAt(0, 0), 'grass');

  const mudPoint = new THREE.Vector3(-21, 0.1, -5);
  const mudGroundBefore = level.getGroundHeightAt(mudPoint, 0.1, { maxStepUp: 1, maxSnapDown: 2 });
  const grassGroundBefore = level.getGroundHeightAt(new THREE.Vector3(0, 0.1, 0), 0.1, {
    maxStepUp: 1,
    maxSnapDown: 2,
  });
  level.mudField.stampDogPaw(-21, -5, {
    depth: 0.07,
    wetness: 0.9,
    tread: 0.7,
    directionX: 0,
    directionZ: 1,
    side: -1,
  });
  level.updateMud(1 / 60, mudPoint);
  const mudGroundAfter = level.getGroundHeightAt(mudPoint, 0.1, { maxStepUp: 1, maxSnapDown: 2 });
  const grassGroundAfter = level.getGroundHeightAt(new THREE.Vector3(0, 0.1, 0), 0.1, {
    maxStepUp: 1,
    maxSnapDown: 2,
  });
  assert.ok(mudGroundAfter < mudGroundBefore - 0.015,
    `stamped mud ground should sink (${mudGroundBefore} -> ${mudGroundAfter})`);
  assert.equal(grassGroundAfter, grassGroundBefore, 'deformation must not change ground outside mud');
  assert.equal(level.addDogPawVisual({ x: -21, z: -5, headingX: 0, headingZ: 1, scale: 1 }), true);
  assert.equal(level.snapshot().mud.visiblePawPrints, 1, 'paw trail overlay mirrors accepted field stamps');

  const beforeImpact = level.snapshot().mud;
  assert.equal(level.applyDogFlopImpact({ position: mudPoint, headingX: 0, headingZ: 1 }), true);
  level.updateMud(1 / 60, mudPoint);
  const impact = level.snapshot().mud;
  assert.equal(impact.flopImpactCount, beforeImpact.flopImpactCount + 1, 'one flop records one broad impact');
  assert.equal(impact.groundBlob.pulses, 1, 'one flop deposits exactly one springy ground blob');
  assert.ok(impact.groundBlob.active && impact.groundBlob.totalAmount > 0, 'mud blob becomes active');
  assert.ok(impact.activeDeformCells > beforeImpact.activeDeformCells, 'broad body print grows deform field');
  assert.equal(level.applyDogFlopImpact({
    position: new THREE.Vector3(0, 0, 0),
    headingX: 0,
    headingZ: 1,
  }), false, 'grass flop emits no mud effects');
  assert.equal(level.snapshot().mud.flopImpactCount, impact.flopImpactCount);

  const lake = level.getWaterHeightAt(new THREE.Vector3(16, 0, 8));
  assert.ok(lake.weight > 0.99, `lake center weight=${lake.weight}`);
  const shore = level.getWaterHeightAt(new THREE.Vector3(0, 0, 0));
  assert.equal(shore.weight, 0);
  const lakeFloor = level.getGroundHeightAt(new THREE.Vector3(16, 0, 8), 0.25, { maxStepUp: 1, maxSnapDown: 2 });
  assert.ok(lakeFloor < -0.35, `lake floor should be depressed, got ${lakeFloor}`);

  const platform = level.getGroundHeightAt(new THREE.Vector3(-9, 0.8, -5.2), 0.25, {
    maxStepUp: 1,
    maxSnapDown: 2,
  });
  assert.ok(platform > 1.15 && platform < 1.25, `platform top=${platform}`);

  const fenceHit = level.getBlockingColliderAt({
    position: new THREE.Vector3(30, 0, 0),
    radius: 0.35,
    feetY: 0,
    height: 0.9,
    stepHeight: 0.3,
  });
  assert.match(fenceHit?.name ?? '', /Fence/, 'park perimeter should block dog');
  console.log(`verify-dog-park-level: OK (${level.colliders.length} colliders, ${level.snapshot().forest.forestTrees} trees)`);
} finally {
  level.dispose();
}
