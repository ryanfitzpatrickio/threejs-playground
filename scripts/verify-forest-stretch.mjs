import assert from 'node:assert/strict';
import { buildForestLitterMask } from '../src/game/world/forest/forestLitter.js';
import { createForestOffRoadPool } from '../src/game/world/forest/forestOffRoadPool.js';
import { placementToTrunkCollider } from '../src/game/world/forest/forestColliders.js';

const zone = {
  shape: 'rect',
  rect: { minX: 0, minZ: 0, maxX: 40, maxZ: 40 },
};

const placements = [
  { x: 10, y: 0, z: 10, scale: 1 },
  { x: 12, y: 0, z: 11, scale: 1 },
  { x: 30, y: 0, z: 30, scale: 1 },
];

const mask = buildForestLitterMask([zone], placements, 64);
assert.ok(mask, 'litter mask builds from placements');
assert.ok(mask.maxValue > 0.2, 'mask has canopy stamps');
assert.equal(mask.texture.image.width, 64);

const staticIndices = new Set([0]);
const pool = createForestOffRoadPool(placements, { staticPlacementIndices: staticIndices, poolSize: 2, radius: 30 });
const physics = {
  owners: new Map(),
  removeStaticBodiesForOwner(key) { this.owners.delete(key); },
  createStaticCollider(collider, key) { this.owners.set(key, collider.name); },
};
pool.update({ x: 30, y: 0, z: 30 }, physics);
assert.equal(physics.owners.size, 2, 'off-road pool fills nearby non-static trunks');
assert.ok([...physics.owners.values()].every((name) => !name.includes('0')), 'static road trunk excluded');

const trunk = placementToTrunkCollider(placements[1], 1);
assert.ok(trunk.topY > trunk.bottomY);
assert.equal(trunk.role, 'prop');

console.log('Forest stretch verification passed.');
