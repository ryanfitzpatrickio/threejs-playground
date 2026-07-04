// M1 of the rally-mud plan (docs/rally-mud-tread-plan.md): the CPU-authoritative
// MudDeformField and its integration into the ground query + vehicle stamping.
//
// Guards:
//   - MudDeformField.stamp / sampleAt / sampleDepthAt: a stamp at a cell centre
//     reads back at full depth, off-stamp reads zero, bilinear falloff between;
//   - ring-buffer reclaim: a stamp at a world cell that ALIASES an earlier
//     stamped slot takes it over (the scrolled-out cell reads zero) so the field
//     follows the car with a fixed footprint and no explicit clear pass;
//   - two-timescale decay: tread melts faster than the rut fills in, and a long
//     decay clears the cell (activeCount → 0);
//   - determinism: identical stamp+decay sequences produce identical buffers;
//   - BaseVehicle.stampMudRuts stamps from telemetry only when moving on mud
//     (parked / off-mud stamp nothing);
//   - level wiring: a rally map WITH a mud road builds a field and its ruts sink
//     getGroundHeightAt; a world-mode map or a mud-less rally map build NO field
//     (scope guarantee).
//
// Pure-node. Run: node scripts/verify-rally-mud-field.mjs

import assert from 'node:assert/strict';

const { createMudDeformField } = await import('../src/game/world/mudDeformField.js');
const { BaseVehicle } = await import('../src/game/vehicles/BaseVehicle.js');
const { createStreamingTerrainLevel } = await import('../src/game/world/createStreamingTerrainLevel.js');
const { normalizeRoad } = await import('../src/world/worldMap/worldMapSchema.js');
const { LevelSystem } = await import('../src/game/systems/LevelSystem.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- stamp / sample
{
  const f = createMudDeformField({ cellSize: 0.5, resolution: 64 });
  // Cell (0,0) centre is at ((0+0.5)*0.5) = 0.25.
  const cx = 0.25, cz = 0.25;
  f.stamp(cx, cz, { depth: 0.1, wetness: 0.5, tread: 1 });
  const s = f.sampleAt(cx, cz);
  assert.ok(Math.abs(s.depth - 0.1) < 1e-5, `centre sample = stamped depth (${s.depth})`);
  assert.ok(Math.abs(s.wetness - 0.5) < 1e-5 && Math.abs(s.tread - 1) < 1e-5, 'wetness+tread read back');
  assert.ok(Math.abs(f.sampleDepthAt(cx, cz) - 0.1) < 1e-5, 'sampleDepthAt matches sampleAt.depth');
  // Far from any stamp → zero.
  assert.equal(f.sampleDepthAt(50, 50), 0, 'unstamped area reads zero');
  // Midway between the stamped cell centre and the next (empty) cell → bilinear falloff.
  const mid = f.sampleDepthAt(cx + 0.25, cz);
  assert.ok(mid > 0 && mid < 0.1, `bilinear falloff between cells (${mid.toFixed(4)})`);
  ok('stamp + bilinear sample + depth fast-path');
}

// ---------------------------------------------------------------- ring reclaim
{
  const R = 64, cell = 0.5;
  const f = createMudDeformField({ cellSize: cell, resolution: R });
  const near = 0.25;                    // cell (0,0)
  const far = R * cell + 0.25;          // cell (R,0) → wraps onto slot (0,0)
  f.stamp(near, near, { depth: 0.1 });
  assert.ok(f.sampleDepthAt(near, near) > 0.09, 'near cell stamped');
  f.stamp(far, near, { depth: 0.08 });  // reclaims the aliased slot
  assert.ok(f.sampleDepthAt(far, near) > 0.07, 'far (scrolled-in) cell now owns the slot');
  assert.equal(f.sampleDepthAt(near, near), 0, 'scrolled-out near cell reads zero (reclaimed)');
  ok('ring-buffer slot reclaim (fixed footprint follows the car)');
}

// ---------------------------------------------------------------- decay
{
  const f = createMudDeformField({ cellSize: 0.5, resolution: 32, depthTau: 9, treadTau: 4 });
  f.stamp(0.25, 0.25, { depth: 0.1, wetness: 0.5, tread: 1 });
  f.decay(2);
  const s = f.sampleAt(0.25, 0.25);
  assert.ok(s.depth < 0.1 && s.depth > 0, 'depth decayed but present');
  // tread (tau 4) melts faster than the rut (tau 9): tread keeps a smaller fraction.
  assert.ok(s.tread / 1 < s.depth / 0.1, 'tread melts faster than the rut fills in');
  assert.ok(f.activeCount > 0, 'cell still active after a short decay');
  f.decay(120);
  assert.equal(f.sampleDepthAt(0.25, 0.25), 0, 'long decay clears the cell');
  assert.equal(f.activeCount, 0, 'cleared cell drops out of the active set');
  ok('two-timescale decay + cell clearing');
}

// ---------------------------------------------------------------- determinism
{
  const run = () => {
    const f = createMudDeformField({ cellSize: 0.5, resolution: 32 });
    for (let i = 0; i < 20; i += 1) {
      f.stamp(i * 0.3, 0.25, { depth: 0.05 + i * 0.001, wetness: 0.4, tread: 1 });
      f.decay(1 / 60);
    }
    return Array.from(f._buffers.depth);
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'equal stamp+decay sequences produce identical fields');
  ok('determinism across equal-dt runs');
}

// ---------------------------------------------------------------- vehicle stamping
{
  const field = createMudDeformField({ cellSize: 0.5, resolution: 64 });
  const telemetry = [
    { inContact: true, contactPoint: { x: 1.0, z: 0 }, suspensionForce: 2500 },
    { inContact: true, contactPoint: { x: 1.0, z: 2 }, suspensionForce: 2500 },
    { inContact: false, contactPoint: { x: 5, z: 5 }, suspensionForce: 0 },
  ];
  // Parked → nothing.
  const parked = { groundSurface: 'mud', controllerSpeed: 0, wheelTelemetry: telemetry };
  BaseVehicle.prototype.stampMudRuts.call(parked, field);
  assert.equal(field.activeCount, 0, 'parked car bores no rut');
  // Moving on mud → stamps at the in-contact contacts (not the airborne wheel).
  const moving = { groundSurface: 'mud', controllerSpeed: 12, wheelTelemetry: telemetry };
  BaseVehicle.prototype.stampMudRuts.call(moving, field);
  assert.ok(field.sampleDepthAt(1.0, 0) > 0, 'in-contact wheel cut a rut');
  assert.ok(field.sampleDepthAt(1.0, 2) > 0, 'second in-contact wheel cut a rut');
  assert.equal(field.sampleDepthAt(5, 5), 0, 'airborne wheel left no rut');
  // Off mud → nothing added.
  const before = field.activeCount;
  const offMud = { groundSurface: 'dirt', controllerSpeed: 12, wheelTelemetry: telemetry };
  BaseVehicle.prototype.stampMudRuts.call(offMud, field);
  assert.equal(field.activeCount, before, 'off-mud surface stamps nothing');
  ok('BaseVehicle.stampMudRuts gates on speed + mud surface');
}

// ---------------------------------------------------------------- progressive dig
{
  const f = createMudDeformField({ cellSize: 0.5, resolution: 32, maxDepth: 0.2 });
  const cx = 0.25, cz = 0.25; // cell (0,0) centre
  f.stamp(cx, cz, { depth: 0.05 });
  const d0 = f.sampleDepthAt(cx, cz);
  for (let i = 0; i < 10; i += 1) f.stamp(cx, cz, { add: 0.02 });
  const d1 = f.sampleDepthAt(cx, cz);
  assert.ok(d1 > d0 + 0.1, `accumulating 'add' bores deeper (${d0.toFixed(3)} → ${d1.toFixed(3)})`);
  for (let i = 0; i < 50; i += 1) f.stamp(cx, cz, { add: 0.05 });
  assert.ok(f.sampleDepthAt(cx, cz) <= 0.2 + 1e-6, 'dig caps at maxDepth');

  // A wheel spinning in place (speed 0, high slip) still bores a hole.
  const field = createMudDeformField({ cellSize: 0.5, resolution: 32 });
  const spun = {
    groundSurface: 'mud', controllerSpeed: 0,
    wheelTelemetry: [{ inContact: true, contactPoint: { x: 0.25, z: 0.25 }, slipRatio: 0.6, suspensionForce: 2500 }],
  };
  const stationary = { ...spun, wheelTelemetry: [{ inContact: true, contactPoint: { x: 0.25, z: 0.25 }, slipRatio: 0, suspensionForce: 2500 }] };
  BaseVehicle.prototype.stampMudRuts.call(stationary, field, 1 / 60);
  assert.equal(field.sampleDepthAt(0.25, 0.25), 0, 'parked, no-spin wheel bores nothing');
  for (let i = 0; i < 30; i += 1) BaseVehicle.prototype.stampMudRuts.call(spun, field, 1 / 60);
  assert.ok(field.sampleDepthAt(0.25, 0.25) > 0.02, 'stationary wheelspin digs a rut (dig-yourself-in)');
  ok('progressive dig: wheelspin accumulates depth toward maxDepth');
}

// ---------------------------------------------------------------- level wiring
{
  const mudRoad = () => normalizeRoad({
    points: [{ x: -120, z: 0 }, { x: 0, z: 0 }, { x: 120, z: 0 }],
    width: 8, trackStyle: 'rallyStage', surface: 'mud',
  });
  const build = (surface, mode) => createStreamingTerrainLevel({}, {
    worldMap: {
      name: 'T', spawn: { x: 0, z: 0 }, zones: [], rivers: [],
      roads: [normalizeRoad({
        points: [{ x: -120, z: 0 }, { x: 0, z: 0 }, { x: 120, z: 0 }],
        width: 8, trackStyle: 'rallyStage', surface,
      })],
    },
    levelMode: mode,
  });

  const level = build('mud', 'rally');
  assert.ok(level.mudField, 'rally + mud road → mud field present');
  assert.equal(level.getRoadSurfaceAt(0, 0), 'mud', 'surface resolves to mud on the deck');
  // Sample at a cell centre so bilinear returns the full stamped depth regardless
  // of the field's cell size.
  const cs = level.mudField.cellSize;
  const px = 0.5 * cs; // cell (0,0) centre
  const g0 = level.getGroundHeightAt({ x: px, y: 0, z: px }, 0, { preferRoadSurface: true });
  level.mudField.stamp(px, px, { depth: 0.1, wetness: 0.5, tread: 1 });
  const g1 = level.getGroundHeightAt({ x: px, y: 0, z: px }, 0, { preferRoadSurface: true });
  assert.ok(Math.abs((g0 - g1) - 0.1) < 1e-3, `rut sinks the analytic ground (${(g0 - g1).toFixed(4)} m)`);

  assert.equal(build('mud', 'world').mudField, null, 'world mode builds no mud field (scope)');
  assert.equal(build(undefined, 'rally').mudField, null, 'mud-less rally map builds no field');
  void mudRoad;
  ok('level wiring: rally-only field + rut folds into getGroundHeightAt');

  // VehicleSystem holds the LevelSystem FACADE (not the raw level object), so the
  // facade MUST forward `mudField` — otherwise stamping/decay silently no-op and
  // no ruts ever appear (the "no tracks on the mud stage" bug).
  const facade = new LevelSystem();
  assert.equal(facade.mudField, null, 'facade with no level → null field');
  facade.level = level;
  assert.equal(facade.mudField, level.mudField, 'LevelSystem facade forwards the mud field');
  ok('LevelSystem facade forwards mudField (VehicleSystem can reach it)');
}

console.log(`\nAll ${passed} rally-mud field (M1) checks passed.`);
