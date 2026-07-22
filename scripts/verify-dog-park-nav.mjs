/**
 * Guards dog-park nav bake (navcat) + path steering around lake/fence.
 *
 * Run: node scripts/verify-dog-park-nav.mjs
 * Alias: npm run verify:dog-park-nav
 */
import assert from 'node:assert/strict';
import {
  bakeDogParkNavMesh,
  lakeToColliders,
  pathSteer,
  DogParkNav,
} from '../src/game/runtime/features/dogPark/DogParkNav.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const bounds = { minX: -30, maxX: 30, minZ: -22.5, maxZ: 22.5 };
const lake = { x: 16, z: 8, radiusX: 8, radiusZ: 5.5 };

// Synthetic park: floor bounds + fence walls + platform.
const colliders = [
  {
    name: 'North Park Fence',
    minX: -30, maxX: 30, minZ: 22.4, maxZ: 22.6,
    bottomY: 0, topY: 1.3, noGroundSnap: true,
  },
  {
    name: 'South Park Fence Left',
    minX: -30, maxX: -2.5, minZ: -22.6, maxZ: -22.4,
    bottomY: 0, topY: 1.3, noGroundSnap: true,
  },
  {
    name: 'South Park Fence Right',
    minX: 2.5, maxX: 30, minZ: -22.6, maxZ: -22.4,
    bottomY: 0, topY: 1.3, noGroundSnap: true,
  },
  {
    name: 'West Park Fence',
    minX: -30.1, maxX: -29.9, minZ: -22.5, maxZ: 22.5,
    bottomY: 0, topY: 1.3, noGroundSnap: true,
  },
  {
    name: 'East Park Fence',
    minX: 29.9, maxX: 30.1, minZ: -22.5, maxZ: 22.5,
    bottomY: 0, topY: 1.3, noGroundSnap: true,
  },
  {
    name: 'Dog Platform',
    minX: -10.6, maxX: -7.4, minZ: -6.7, maxZ: -3.7,
    bottomY: 0, topY: 1.2,
  },
];

{
  const lakes = lakeToColliders(lake, 0);
  assert.ok(lakes.length >= 8, 'lake expands to multiple AABB obstacles');
  ok(`lakeToColliders → ${lakes.length} boxes`);
}

{
  const bake = bakeDogParkNavMesh({
    colliders,
    bounds,
    lake,
    floorY: 0,
    cellSize: 0.4,
  });
  assert.equal(bake.ok, true, bake.reason ?? bake.error ?? 'bake failed');
  assert.ok(bake.navMesh, 'navMesh present');
  assert.ok(bake.obstacleCount >= 4, `obstacles ${bake.obstacleCount}`);
  ok(`park nav bake ok (obstacles=${bake.obstacleCount}, tris=${bake.triangleCount})`);

  const nav = new DogParkNav({ colliders, bounds, lake, floorY: 0 });
  assert.equal(nav.ready, true);

  // Open lawn should be walkable.
  assert.equal(nav.isWalkable(-5, -8), true, 'lawn walkable');
  // Deep lake center should not be preferred walkable.
  assert.equal(nav.isWalkable(16, 8), false, 'lake center not walkable');

  // Path from west lawn to east lawn should not go through lake core.
  const path = nav.query.findPath(-10, 0, 24, 0, 0);
  assert.equal(path.ok, true, 'path west→east');
  assert.ok(path.points.length >= 2, 'has waypoints');
  // No waypoint deep inside the lake ellipse.
  for (const p of path.points) {
    const dx = (p.x - lake.x) / (lake.radiusX * 0.55);
    const dz = (p.z - lake.z) / (lake.radiusZ * 0.55);
    assert.ok(dx * dx + dz * dz >= 1, `waypoint inside lake ${JSON.stringify(p)}`);
  }
  ok(`path around lake (${path.points.length} pts)`);

  const steer = pathSteer({ x: -10, z: 0 }, path.points);
  assert.equal(steer.ok, true);
  assert.equal(steer.arrived, false);
  assert.ok(Math.hypot(steer.dirX, steer.dirZ) > 0.9);
  ok('pathSteer returns unit direction');

  const random = nav.randomPoint(() => 0.37, 2.5, 40);
  assert.equal(nav.isWalkable(random.x, random.z), true);
  ok('randomPoint is walkable');

  const snap = nav.snapshot();
  assert.equal(snap.ready, true);
  assert.equal(snap.bake.ok, true);
  ok('nav snapshot');

  nav.dispose();
}

console.log(`\n${passed} passed`);
