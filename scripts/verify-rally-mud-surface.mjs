// M0 of the rally-mud plan (docs/rally-mud-tread-plan.md): `mud` as a
// first-class road surface.
//
// Guards:
//   - `mud` is a normalizable ROAD_SURFACES entry and an explicit
//     `road.surface: 'mud'` override survives sanitisation (surfaceForRoad);
//   - buildRoadProfile.corridorAt reports surface 'mud' on a mud road's deck and
//     the plain 'dirt'/'asphalt' surfaces are UNCHANGED (scope: adding the enum
//     didn't perturb existing surfaces), and returns nothing off-corridor;
//   - vehicleConfig.ground.surfaces.mud exists and is the lowest-grip profile;
//   - BaseVehicle.setGroundSurface admits 'mud' (and still falls back to
//     'offroad' for junk), and _updateSurfaceTuning eases friction toward the
//     mud profile across a dirt→mud boundary.
//
// Pure-node (CPU geometry + prototype method calls); no GPU. Physical mud feel
// (deform field, visuals) is later milestones.
//
// Run: node scripts/verify-rally-mud-surface.mjs

import assert from 'node:assert/strict';

const { ROAD_SURFACES, normalizeRoadSurface, surfaceForRoad, surfaceForTrackStyle } =
  await import('../src/world/worldMap/roadSurface.js');
const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { DEFAULT_VEHICLE_CONFIG, createVehicleConfig } =
  await import('../src/game/config/vehicleConfig.js');
const { BaseVehicle } = await import('../src/game/vehicles/BaseVehicle.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- enum + resolver
{
  assert.ok(ROAD_SURFACES.mud, 'mud is a ROAD_SURFACES entry');
  assert.equal(normalizeRoadSurface('mud'), 'mud', 'mud normalizes to itself');
  assert.equal(normalizeRoadSurface('quicksand'), null, 'unknown surfaces reject');
  // Explicit override wins over the trackStyle default (a rallyStage is 'dirt').
  assert.equal(surfaceForRoad({ surface: 'mud', trackStyle: 'rallyStage' }), 'mud',
    'road.surface: mud overrides the rallyStage dirt default');
  assert.equal(surfaceForTrackStyle('rallyStage'), 'dirt',
    'trackStyle default unchanged (no rallyMud style yet)');
  ok('mud enum + surfaceForRoad override');
}

// ---------------------------------------------------------------- corridor routing
const sampleHeight = () => 0;
function buildProfile(surface) {
  return buildRoadProfile({
    roads: [{
      points: [{ x: -40, z: 0 }, { x: 0, z: 0 }, { x: 40, z: 0 }],
      width: 10,
      trackStyle: 'rallyStage',
      surface,
    }],
    sampleHeight,
    smoothRadius: 2,
    maxGrade: Infinity,
  });
}
{
  const mud = buildProfile('mud');
  const onDeck = mud.corridorAt(0, 0);
  assert.ok(onDeck && onDeck.weight >= 0.999, 'mud road deck is full-strength corridor');
  assert.equal(onDeck.surface, 'mud', 'corridor surface is mud on the deck');
  const off = mud.corridorAt(0, 500);
  assert.ok(off == null || off.weight <= 0, 'off-corridor returns no mud');
  ok('corridorAt routes mud on-deck, nothing off-deck');

  // Scope: an unmarked rallyStage road still resolves to 'dirt', a normal road
  // to 'asphalt' — the enum addition perturbs nothing existing.
  const dirt = buildProfile(undefined);
  assert.equal(dirt.corridorAt(0, 0).surface, 'dirt', 'plain rallyStage stays dirt');
  const asphalt = buildRoadProfile({
    roads: [{ points: [{ x: -40, z: 0 }, { x: 40, z: 0 }], width: 10 }],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  assert.equal(asphalt.corridorAt(0, 0).surface, 'asphalt', 'plain road stays asphalt');
  ok('scope: dirt/asphalt surfaces unchanged');
}

// ---------------------------------------------------------------- grip profile
{
  const s = DEFAULT_VEHICLE_CONFIG.ground.surfaces;
  assert.ok(s.mud, 'ground.surfaces.mud exists');
  // Lowest grip of all surfaces.
  assert.ok(s.mud.frictionSlip < s.dirt.frictionSlip && s.mud.frictionSlip < s.offroad.frictionSlip,
    'mud frictionSlip is the lowest');
  assert.ok(s.mud.rollingResistanceScale > s.offroad.rollingResistanceScale,
    'mud is the draggiest');
  ok('surfaces.mud is the lowest-grip, draggiest profile');
}

// ---------------------------------------------------------------- vehicle surface
{
  // setGroundSurface widened to admit mud; junk still falls back to offroad.
  const stub = {};
  BaseVehicle.prototype.setGroundSurface.call(stub, 'mud');
  assert.equal(stub.groundSurface, 'mud', 'setGroundSurface accepts mud');
  BaseVehicle.prototype.setGroundSurface.call(stub, 'grass');
  assert.equal(stub.groundSurface, 'offroad', 'unknown surface → offroad');
  BaseVehicle.prototype.setGroundSurface.call(stub, 'dirt');
  assert.equal(stub.groundSurface, 'dirt', 'dirt still accepted');

  // _updateSurfaceTuning eases toward the mud profile across a dirt→mud switch.
  const config = createVehicleConfig();
  const dirtProfile = config.ground.surfaces.dirt;
  const mudProfile = config.ground.surfaces.mud;
  const tuner = { config, groundSurface: 'mud', surfaceTuning: { ...dirtProfile } };
  assert.ok(tuner.surfaceTuning.frictionSlip > mudProfile.frictionSlip + 0.1,
    'starts at dirt grip (above mud)');
  for (let i = 0; i < 240; i += 1) {
    BaseVehicle.prototype._updateSurfaceTuning.call(tuner, 1 / 60);
  }
  assert.ok(Math.abs(tuner.surfaceTuning.frictionSlip - mudProfile.frictionSlip) < 0.02,
    `friction eased to mud (${tuner.surfaceTuning.frictionSlip.toFixed(3)} ≈ ${mudProfile.frictionSlip})`);
  ok('setGroundSurface + _updateSurfaceTuning ease into mud grip');
}

console.log(`\nAll ${passed} rally-mud surface (M0) checks passed.`);
