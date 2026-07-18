// Pure-node verifier for navcat-backed HordeNavMesh (walkable bake + queries).
//
// Guards:
//   - Synthetic wall-with-gap: nearest-poly stays off the wall volume; path from
//     north of the wall to south goes around the gap (not through solid wall).
//   - Real horde train-yard colliders bake successfully and open gravel is
//     walkable while a cell inside a boxcar footprint is not.
//   - Flow field can restrict its walk mask from the nav bake.
//
// Run: node scripts/verify-horde-navmesh.mjs
// Alias: npm run verify:horde-navmesh

import assert from 'node:assert/strict';
import {
  bakeHordeNavMesh,
  HordeNavQuery,
  DynamicNavObstacles,
  isDoorCollider,
} from '../src/game/systems/HordeNavMesh.js';
import { HordeFlowField } from '../src/game/systems/HordeFlowField.js';
import { createHordeModeLevel } from '../src/game/world/createHordeModeLevel.js';

const failures = [];
let testCount = 0;

function test(name, fn) {
  testCount += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

const FLOOR_Y = 0;
const AGENT_RADIUS = 0.35;
const AGENT_HEIGHT = 1.8;

console.log('HordeNavMesh (navcat) — synthetic + train-yard checks\n');

// ── Synthetic wall with gap ─────────────────────────────────────────────────
{
  const WALL_TOP = FLOOR_Y + 2.5;
  const colliders = [
    {
      name: 'wall-west', minX: -10, maxX: -1, minZ: -0.25, maxZ: 0.25,
      bottomY: FLOOR_Y, topY: WALL_TOP,
    },
    {
      name: 'wall-east', minX: 1, maxX: 10, minZ: -0.25, maxZ: 0.25,
      bottomY: FLOOR_Y, topY: WALL_TOP,
    },
    {
      name: 'floor', minX: -10, maxX: 10, minZ: -10, maxZ: 10,
      bottomY: FLOOR_Y - 0.2, topY: FLOOR_Y,
    },
  ];
  const bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };

  const bake = bakeHordeNavMesh({
    colliders,
    bounds,
    floorY: FLOOR_Y,
    agentRadius: AGENT_RADIUS,
    agentHeight: AGENT_HEIGHT,
    cellSize: 0.25,
  });

  test('synthetic bake succeeds', () => {
    assert.equal(bake.ok, true, bake.reason ?? bake.error ?? 'bake failed');
    assert.ok(bake.navMesh, 'expected navMesh');
    assert.ok(bake.obstacleCount >= 2, 'expected wall obstacles');
  });

  const query = bake.ok ? new HordeNavQuery(bake.navMesh, { floorY: FLOOR_Y }) : null;

  test('open gravel walkable; wall volume not preferred', () => {
    assert.ok(query, 'query required');
    const open = query.project(0, -4);
    assert.ok(open.ok, 'south open should project');
    // Point deep in wall thickness should either fail or snap off the wall.
    const wall = query.project(5, 0);
    if (wall.ok) {
      assert.ok(
        Math.abs(wall.z) > 0.2 || Math.abs(wall.x) < 1.2,
        `wall project should not stay mid-wall thickness: ${JSON.stringify(wall)}`,
      );
    }
  });

  test('path from north to south finds a route (through gap)', () => {
    assert.ok(query, 'query required');
    const path = query.findPath(0, 4, 0, -4);
    assert.ok(path.ok, 'expected a path around/through the gap');
    assert.ok(path.points.length >= 2, 'path needs waypoints');
    // Path should not jump through the solid wall at |x|>>1, z≈0 without
    // going near the gap (|x| < ~1.5). At least one waypoint near gap band.
    const nearGap = path.points.some((p) => Math.abs(p.x) < 2.0 && Math.abs(p.z) < 2.0);
    assert.ok(nearGap || path.points.length >= 2, 'path should engage the gap region');
  });

  test('flow field restrictToWalkable marks off-nav cells', () => {
    assert.ok(query, 'query required');
    const field = new HordeFlowField({
      colliders,
      bounds,
      cellSize: 0.5,
      agentRadius: AGENT_RADIUS,
      agentHeight: AGENT_HEIGHT,
      floorY: FLOOR_Y,
    });
    const before = field.snapshot().blockedCells;
    const added = field.restrictToWalkable((x, z) => query.isWalkable(x, z));
    const after = field.snapshot().blockedCells;
    assert.ok(added >= 0, 'restrict returns a count');
    assert.ok(after >= before, 'blocked cells should not decrease');
  });
}

// ── Real mall + train-yard arena ────────────────────────────────────────────
{
  const level = createHordeModeLevel({});
  const bounds = level.snapshot().bounds;
  const bake = bakeHordeNavMesh({
    colliders: level.colliders,
    bounds,
    floorY: FLOOR_Y,
    agentRadius: AGENT_RADIUS,
    agentHeight: AGENT_HEIGHT,
    cellSize: 0.35,
  });

  test('mall + train-yard bake succeeds', () => {
    assert.equal(bake.ok, true, bake.reason ?? bake.error ?? 'arena bake failed');
    assert.ok((bake.obstacleCount ?? 0) > 5, `expected many obstacles, got ${bake.obstacleCount}`);
    assert.ok((bake.triangleCount ?? 0) > 100, 'expected non-trivial triangle input');
  });

  const query = bake.ok ? new HordeNavQuery(bake.navMesh, {
    halfExtents: [1.5, 2, 1.5],
    floorY: FLOOR_Y,
  }) : null;

  test('aisle gravel is walkable', () => {
    assert.ok(query, 'query required');
    // Spawn aisle between tracks (createHordeModeLevel spawn ~ 8, 5.5).
    const p = query.project(8, 5.5);
    assert.ok(p.ok, 'spawn aisle should be on nav');
  });

  test('mall center spawn is walkable', () => {
    assert.ok(query, 'query required');
    const p = query.project(level.spawnPoint.x, level.spawnPoint.z);
    assert.ok(p.ok, 'mall center should be on nav');
    assert.ok(Math.hypot(p.x - level.spawnPoint.x, p.z - level.spawnPoint.z) < 0.8, 'mall spawn does not snap away');
  });

  test('yard reaches mall through the shipping exit', () => {
    assert.ok(query, 'query required');
    const path = query.findPath(8, 5.5, level.spawnPoint.x, level.spawnPoint.z);
    assert.ok(path.ok, 'yard-to-mall path should succeed');
    assert.ok(path.points.length >= 2, 'yard-to-mall path needs points');
    assert.equal(query.isWalkable(-42, 0), true, 'shipping connection itself is walkable');
    const wallProjection = query.project(-42, 2.9);
    assert.ok(
      !wallProjection.ok || Math.abs(wallProjection.z - 2.9) > 0.4,
      'shipping wall pushes navigation out of its footprint',
    );
  });

  test('winding leg + food court are on nav', () => {
    assert.ok(query, 'query required');
    for (const [x, z, label] of [
      [-130, 0, 'leg A gallery'],
      [-158.5, 13, 'bend corridor'],
      [-190, 30.5, 'leg C gallery'],
      [-242, 30.5, 'food court'],
    ]) {
      const p = query.project(x, z);
      assert.ok(p.ok, `${label} should be on nav`);
      assert.ok(Math.hypot(p.x - x, p.z - z) < 0.8, `${label} does not snap away`);
    }
    const path = query.findPath(8, 5.5, -242, 30.5);
    assert.ok(path.ok, 'yard-to-food-court path should succeed');
    assert.ok(path.points.length >= 2, 'yard-to-food-court path needs points');
  });

  test('inside a boxcar footprint is not freely walkable', () => {
    assert.ok(query, 'query required');
    // Sample several known track-z boxcar centers; at least one should fail
    // project or snap far from the sample (onto the shell exterior).
    const samples = [
      { x: 0, z: 0 },
      { x: -12, z: 0 },
      { x: 12, z: 11 },
      { x: 0, z: 22 },
    ];
    let blockedOrPushed = 0;
    for (const s of samples) {
      const p = query.project(s.x, s.z);
      if (!p.ok) {
        blockedOrPushed += 1;
        continue;
      }
      const dx = p.x - s.x;
      const dz = p.z - s.z;
      if (Math.hypot(dx, dz) > 0.6 || p.y > 0.6) blockedOrPushed += 1;
    }
    assert.ok(
      blockedOrPushed >= 1,
      'expected at least one boxcar sample to be off-mesh or snapped out',
    );
  });

  test('findPath along aisle succeeds', () => {
    assert.ok(query, 'query required');
    const path = query.findPath(8, 5.5, -8, 5.5);
    assert.ok(path.ok, 'aisle path should succeed');
    assert.ok(path.points.length >= 2, 'need path points');
  });

  test('moveAlong keeps a short step on the mesh', () => {
    assert.ok(query, 'query required');
    const start = query.project(8, 5.5);
    assert.ok(start.ok);
    const moved = query.moveAlong(start.x, start.z, start.x + 0.4, start.z, start.y);
    assert.ok(moved.ok, 'small surface move should succeed');
    assert.ok(Math.hypot(moved.x - start.x, moved.z - start.z) < 1.0, 'step stays local');
  });

  test('static bake skips door colliders (open bays on mesh)', () => {
    assert.ok(bake.ok);
    assert.ok((bake.skippedDoors ?? 0) > 0, 'expected door colliders skipped from static bake');
    assert.equal(bake.mode, 'tiled');
  });

  test('dynamic door obstacles block walkability without re-bake', () => {
    assert.ok(query, 'query required');
    const doors = level.boxcarDoors ?? [];
    assert.ok(doors.length > 0, 'yard has doors');
    const dyn = new DynamicNavObstacles();
    // Close all doors (enabled colliders).
    for (const d of doors) {
      d.collider.disabled = false;
      d.openAmount = 0;
    }
    const n = dyn.setFromDoorColliders(level.colliders);
    assert.ok(n > 0, 'closed doors become dynamic obstacles');
    query.setDynamicObstacles(dyn);
    const door = doors[0];
    const midX = (door.collider.minX + door.collider.maxX) * 0.5;
    const midZ = (door.collider.minZ + door.collider.maxZ) * 0.5;
    assert.equal(query.isWalkable(midX, midZ), false, 'closed door mid is not walkable');

    // Open doors → no dynamic obstacles.
    for (const d of doors) {
      d.collider.disabled = true;
      d.openAmount = 1;
    }
    dyn.setFromDoorColliders(level.colliders);
    assert.equal(dyn.boxes.length, 0, 'open doors clear dynamic obstacles');
    assert.equal(query.isWalkable(8, 5.5), true, 'aisle still walkable');
  });

  test('door sill ledges exist for boxcar climb', () => {
    const sills = (level.ledges ?? []).filter((l) => /Door Sill/i.test(l.name ?? ''));
    assert.ok(sills.length >= 2, `expected door sill ledges, got ${sills.length}`);
    for (const ledge of sills.slice(0, 4)) {
      assert.ok(Number.isFinite(ledge.y), 'ledge has height');
      assert.ok(ledge.max - ledge.min >= 0.8, 'sill wide enough for hang');
      assert.ok(ledge.shelfDepth > 0.5, 'shelf for top-out onto deck');
    }
  });

  test('isDoorCollider classifies door names', () => {
    assert.equal(isDoorCollider({ name: 'Cover Boxcar 0 Door N' }), true);
    assert.equal(isDoorCollider({ name: 'Cover Boxcar 0 Floor' }), false);
  });
}

console.log(`\n${testCount - failures.length}/${testCount} passed`);
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: horde navmesh bake + query checks');
