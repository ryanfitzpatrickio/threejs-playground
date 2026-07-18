import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSimLotLevel } from '../src/game/world/createSimLotLevel.js';

const level = createSimLotLevel();
try {
  assert.equal(level.name, 'Willow Creek Lot');
  assert.equal(level.simSpawnPoints.length, 2);
  assert.ok(level.colliders.length >= 15, `expected lot colliders, got ${level.colliders.length}`);
  assert.ok(level.geometryIndex.entries.length >= 20, 'house and prop geometry should be raycastable');
  assert.ok(level.spawnPoint.z < -30, 'hidden player park must be off-lot');

  for (const [index, point] of level.simSpawnPoints.entries()) {
    const ground = level.getGroundHeightAt(point, 0.35, { maxStepUp: 1, maxSnapDown: 2 });
    assert.ok(Number.isFinite(ground), `spawn ${index} has no ground`);
    assert.ok(Math.abs(ground) < 0.05, `spawn ${index} ground is ${ground}`);
    const blocking = level.getBlockingColliderAt({
      position: point,
      radius: 0.35,
      feetY: ground,
      height: 1.75,
      stepHeight: 0.3,
    });
    assert.equal(blocking, null, `spawn ${index} blocked by ${blocking?.name}`);
  }

  const hedgeHit = level.getBlockingColliderAt({
    position: new THREE.Vector3(19.3, 0, 0),
    radius: 0.35,
    feetY: 0,
    height: 1.75,
    stepHeight: 0.3,
  });
  assert.match(hedgeHit?.name ?? '', /Hedge/, 'perimeter hedge should block actors');
  assert.equal(level.snapshot().mode, 'sims');
  console.log(
    `verify-sim-lot-level: OK (${level.colliders.length} colliders, `
    + `${level.geometryIndex.entries.length} raycast meshes)`,
  );
} finally {
  level.dispose();
}
