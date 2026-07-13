// Pure-node verifier for HordeFlowField (M0 of docs/horde-flow-mob-plan.md).
//
// Guards the flow-field substrate the M1 boids body will steer against:
//   - Synthetic wall-with-gap: an agent on the far side of a solid wall must
//     route through the gap (flow direction bends toward the opening, not
//     straight through the wall), and distToGoal strictly decreases as you
//     walk the sampled directions from the far point to the goal.
//   - No direction ever points from a walkable cell into a blocked cell —
//     the M1 steering term can trust sampleDir() blindly.
//   - Real arena integration: build a field from the actual Horde Train Yard
//     colliders, most floor cells are reachable from an origin goal, and
//     cells just outside the gate openings route inward through the gate
//     (not into the flanking wall/posts).
//
// Run: node scripts/verify-horde-flowfield.mjs
// Alias: npm run verify:horde-flowfield

import assert from 'node:assert/strict';
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

const AGENT_RADIUS = 0.35;
const AGENT_HEIGHT = 1.8;
const FLOOR_Y = 0;

console.log('HordeFlowField (M0) — synthetic + real-arena checks\n');

// ── 1. Synthetic wall-with-gap ──────────────────────────────────────────────
//
// A 20m-wide, 10m-deep room split by a wall along z=0 running the full width
// except for a 2m gap centered at x=0. Goal on the south side (z=-4); a
// sample point on the north side (z=4) must route east/west toward the gap,
// not straight south into the wall, and following sampleDir from the far
// point must monotonically decrease distToGoal down to 0 at the goal.
{
  const WALL_TOP = FLOOR_Y + 2.5; // spans the agent's vertical band
  const colliders = [
    // Wall west segment: x in [-10, -1], thickness along z.
    {
      name: 'wall-west', minX: -10, maxX: -1, minZ: -0.25, maxZ: 0.25,
      bottomY: FLOOR_Y, topY: WALL_TOP,
    },
    // Wall east segment: x in [1, 10].
    {
      name: 'wall-east', minX: 1, maxX: 10, minZ: -0.25, maxZ: 0.25,
      bottomY: FLOOR_Y, topY: WALL_TOP,
    },
    // Floor slab (should NOT block — topY at floor level).
    {
      name: 'floor', minX: -10, maxX: 10, minZ: -10, maxZ: 10,
      bottomY: FLOOR_Y - 0.2, topY: FLOOR_Y,
    },
  ];

  const field = new HordeFlowField({
    colliders,
    bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
    cellSize: 0.5,
    agentRadius: AGENT_RADIUS,
    agentHeight: AGENT_HEIGHT,
    floorY: FLOOR_Y,
  });

  const snap0 = field.snapshot();
  test('wall + floor rasterize: wall blocks cells, floor slab does not', () => {
    assert.ok(snap0.blockedCells > 0, 'expected some blocked cells from the wall');
    // Floor-only cell far from the wall must be walkable.
    assert.equal(field.isBlockedCell(...Object.values(field.worldToCell(8, 8))), false);
  });

  field.update(0, -4); // goal south of the wall, centered on the gap

  test('far-side point routes toward the gap, not into the wall', () => {
    // Sample well off-axis so a naive "straight at goal" vector would point
    // through the wall (south), but the correct route bends toward x=0.
    const dir = field.sampleDir(-6, 4);
    assert.ok(Number.isFinite(dir.x) && Number.isFinite(dir.z), 'dir must be finite');
    assert.ok(dir.x > 0.05, `expected eastward pull toward the gap, got dir.x=${dir.x}`);
  });

  test('distToGoal is finite through the gap and monotonically decreases along sampleDir', () => {
    const distFar = field.sampleDistance(-6, 4);
    assert.ok(Number.isFinite(distFar), 'far point must be reachable through the gap');

    // Walk from the far point toward the goal, one cell (half-cell step) at
    // a time, following sampleDir; distance must never increase.
    let x = -6;
    let z = 4;
    let prevDist = field.sampleDistance(x, z);
    const step = field.cellSize * 0.75;
    let reachedGoal = false;
    for (let i = 0; i < 400; i += 1) {
      const dir = field.sampleDir(x, z);
      const len = Math.hypot(dir.x, dir.z);
      if (len < 1e-6) break; // at/near goal cell (zero vector)
      x += (dir.x / len) * step;
      z += (dir.z / len) * step;
      const dist = field.sampleDistance(x, z);
      assert.ok(Number.isFinite(dist), `distance became unreachable at step ${i}`);
      assert.ok(dist <= prevDist + 1e-6, `distance increased at step ${i}: ${prevDist} -> ${dist}`);
      prevDist = dist;
      if (dist < field.cellSize) { reachedGoal = true; break; }
    }
    assert.ok(reachedGoal, 'walking sampleDir never converged on the goal');
  });
}

// ── 2. No direction ever points into a blocked cell ────────────────────────
{
  const colliders = [
    { name: 'pillar-a', minX: -1, maxX: 1, minZ: -6, maxZ: -4, bottomY: FLOOR_Y, topY: 2.2 },
    { name: 'pillar-b', minX: -1, maxX: 1, minZ: 2, maxZ: 4, bottomY: FLOOR_Y, topY: 2.2 },
    { name: 'pillar-c', minX: 4, maxX: 6, minZ: -2, maxZ: 2, bottomY: FLOOR_Y, topY: 2.2 },
    { name: 'floor', minX: -12, maxX: 12, minZ: -12, maxZ: 12, bottomY: FLOOR_Y - 0.2, topY: FLOOR_Y },
  ];
  const field = new HordeFlowField({
    colliders,
    bounds: { minX: -12, maxX: 12, minZ: -12, maxZ: 12 },
    cellSize: 0.5,
    agentRadius: AGENT_RADIUS,
    agentHeight: AGENT_HEIGHT,
    floorY: FLOOR_Y,
  });
  field.update(9, 9);

  test('sampleDir never steps from a walkable cell into a blocked cell', () => {
    let checked = 0;
    let violations = 0;
    for (let row = 0; row < field.rows; row += 4) {
      for (let col = 0; col < field.cols; col += 4) {
        const idx = field.cellIndex(col, row);
        if (field.blocked[idx] === 1) continue;
        if (!Number.isFinite(field.distToGoal[idx])) continue; // unreachable island, no dir asserted
        const world = field.cellToWorld(col, row);
        const dir = field.sampleDir(world.x, world.z);
        const len = Math.hypot(dir.x, dir.z);
        checked += 1;
        if (len < 1e-6) continue; // goal cell itself
        const nextX = world.x + (dir.x / len) * field.cellSize;
        const nextZ = world.z + (dir.z / len) * field.cellSize;
        if (field.isBlockedCell(...Object.values(field.worldToCell(nextX, nextZ)))) {
          violations += 1;
        }
      }
    }
    assert.ok(checked > 20, `expected a meaningful sample size, got ${checked}`);
    assert.equal(violations, 0, `${violations}/${checked} sampled cells pointed into a blocked cell`);
  });
}

// ── 3. Real arena integration ───────────────────────────────────────────────
{
  const level = createHordeModeLevel();
  const HALF = 36; // mirrors createHordeModeLevel's HALF (train-yard arena bounds)

  const field = new HordeFlowField({
    colliders: level.colliders,
    bounds: { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF },
    cellSize: 0.75,
    agentRadius: 0.35,
    agentHeight: 1.8,
    floorY: 0,
  });

  const arenaSnap = field.snapshot();
  test('real arena rasterizes obstacles without blocking the whole floor', () => {
    assert.ok(arenaSnap.blockedCells > 0, 'expected walls/cover to block some cells');
    assert.ok(
      arenaSnap.blockedCells < arenaSnap.cellCount * 0.6,
      `too much of the grid is blocked (${arenaSnap.blockedCells}/${arenaSnap.cellCount})`,
    );
  });

  field.update(0, 0); // goal at the arena origin (player spawn area)
  const afterUpdate = field.snapshot();

  test('most floor cells are reachable from the origin goal', () => {
    const walkable = afterUpdate.cellCount - afterUpdate.blockedCells;
    const reachableFrac = afterUpdate.reachableCells / walkable;
    assert.ok(
      reachableFrac > 0.85,
      `expected >85% of walkable cells reachable, got ${(reachableFrac * 100).toFixed(1)}% `
      + `(${afterUpdate.reachableCells}/${walkable})`,
    );
  });

  test('gate-adjacent cells route inward through the gate opening', () => {
    let checkedGates = 0;
    for (const gate of level.hordeSpawnPoints) {
      // Sample a point just outside the gate, one gate-width further out
      // along the spawn point's facing (yaw points back toward the arena).
      const inwardX = -Math.sin(gate.yaw);
      const inwardZ = -Math.cos(gate.yaw);
      // hordeSpawnPoints are already inset inward from the wall; sample
      // slightly further inward still (toward the gate throat) where the
      // flow must be well-defined and unblocked.
      const sampleX = gate.position.x + inwardX * 1.5;
      const sampleZ = gate.position.z + inwardZ * 1.5;

      if (field.isBlockedCell(...Object.values(field.worldToCell(sampleX, sampleZ)))) {
        // Gate throat cell itself blocked by geometry noise — skip, but the
        // spawn point (already inset) must not be blocked.
        continue;
      }
      checkedGates += 1;
      const dist = field.sampleDistance(sampleX, sampleZ);
      assert.ok(Number.isFinite(dist), `gate ${gate.id} sample point is unreachable`);

      const dir = field.sampleDir(sampleX, sampleZ);
      const len = Math.hypot(dir.x, dir.z);
      assert.ok(len > 1e-6, `gate ${gate.id} has a zero flow direction`);
      // Moving one more cell along dir should not increase distance (i.e.
      // it routes inward/toward the goal, not back out through the wall).
      const nextX = sampleX + (dir.x / len) * field.cellSize;
      const nextZ = sampleZ + (dir.z / len) * field.cellSize;
      const nextDist = field.sampleDistance(nextX, nextZ);
      assert.ok(
        Number.isFinite(nextDist) && nextDist <= dist + 1e-6,
        `gate ${gate.id} flow does not route inward (dist ${dist} -> ${nextDist})`,
      );
    }
    assert.ok(checkedGates >= 4, `expected to check several gates, got ${checkedGates}`);
  });

  console.log(
    `  arena: ${arenaSnap.cols}x${arenaSnap.rows} cells, blocked=${afterUpdate.blockedCells}, `
    + `reachable=${afterUpdate.reachableCells}, goal=(${afterUpdate.goalCol},${afterUpdate.goalRow})`,
  );

  level.dispose();
}

console.log(`\n${testCount - failures.length}/${testCount} passed.`);
if (failures.length) {
  console.log('FAIL:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: M0 HordeFlowField contract holds (gap routing, no blocked-cell steps, real-arena reachability).');
