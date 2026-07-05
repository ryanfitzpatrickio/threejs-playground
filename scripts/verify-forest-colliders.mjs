import assert from 'node:assert/strict';
import { buildForestTrunkColliders } from '../src/game/world/forest/forestColliders.js';

const placements = [
  { x: 10, y: 0, z: 0, scale: 1, rotY: 0, archetypeIndex: 0 },
  { x: 200, y: 0, z: 200, scale: 1, rotY: 0, archetypeIndex: 0 },
];

const findNearRoad = (x, z, { maxDistance = 30 } = {}) => {
  const dist = Math.hypot(x - 12, z - 0);
  if (dist > maxDistance) return null;
  return { distance: dist, x: 12, z: 0 };
};

const { colliders, staticPlacementIndices } = buildForestTrunkColliders(placements, { findNearestRoadPoint: findNearRoad });

assert.equal(colliders.length, 1, 'only road-adjacent trees get trunk colliders');
assert.equal(staticPlacementIndices.size, 1);
assert.ok(staticPlacementIndices.has(0));
const c = colliders[0];
assert.ok(c.maxX - c.minX <= 0.55, 'trunk footprint is narrow');
assert.ok(c.topY > c.bottomY, 'trunk has height');
assert.equal(c.role, 'prop');

console.log('Forest trunk collider verification passed.');
