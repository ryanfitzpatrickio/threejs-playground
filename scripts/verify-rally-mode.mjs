import assert from 'node:assert/strict';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { getDefaultRallyWorldMap } = await import('../src/world/worldMap/defaultRallyMap.js');
const { normalizeRoad } = await import('../src/world/worldMap/worldMapSchema.js');
const { rallyVehicleOptions } = await import('../src/game/vehicles/garageBuilds.js');
const { BaseVehicle } = await import('../src/game/vehicles/BaseVehicle.js');

let passed = 0;
const ok = (message) => { passed += 1; console.log(`  ✓ ${message}`); };
const sampleHeight = () => 0;
const points = [{ x: -120, z: 0 }, { x: 0, z: 0 }, { x: 120, z: 0 }];

{
  const road = normalizeRoad({ points, width: 6, trackStyle: 'rallyStage' });
  const profile = buildRoadProfile({ roads: [road], sampleHeight, smoothRadius: 0, maxGrade: Infinity });
  assert.equal(profile.corridorAt(0, 0)?.surface, 'dirt');
  assert.equal(profile.corridorAt(0, 20), null);
  const asphalt = normalizeRoad({ points, width: 6, trackStyle: 'rallyStage', surface: 'asphalt' });
  const override = buildRoadProfile({ roads: [asphalt], sampleHeight, smoothRadius: 0, maxGrade: Infinity });
  assert.equal(override.corridorAt(0, 0)?.surface, 'asphalt');
  ok('track style defaults to dirt and explicit surface override wins');
}

{
  const road = normalizeRoad({ points, width: 6, trackStyle: 'rallySpectator' });
  const profile = buildRoadProfile({ roads: [road], sampleHeight, smoothRadius: 0, maxGrade: Infinity });
  const layers = createTracksideLayers({ profile, sampleHeight });
  const ropeGroups = layers.group.children.filter((child) => child.name === 'Rally Safety Rope');
  const crowds = layers.group.children.filter((child) => child.name === 'Rally Spectator Crowd');
  assert.equal(ropeGroups.length, 2);
  assert.equal(crowds.length, 2);
  assert.ok(crowds.every((crowd) => crowd.count > 0 && crowd.count <= 260));
  assert.equal(layers.colliders.length, 0);
  layers.dispose();
  ok('spectator theme emits capped crowds and non-colliding safety ropes');
}

{
  const map = getDefaultRallyWorldMap();
  assert.equal(map.name, 'Pine Ridge Rally');
  assert.ok(map.roads.length >= 2);
  assert.ok(map.roads.every((road) => road.surface === 'mud'));
  ok('built-in rally map is normalized and fully mud surfaced');
}

{
  const options = rallyVehicleOptions();
  assert.equal(options.chassisOverlay.profileId, 'subaru-rally');
  assert.match(options.chassisOverlay.url, /subaru-rally-chassis\.glb$/);
  assert.match(options.wheelVisual.url, /tire-rally-wheel\.glb$/);
  assert.equal(options.config.ground.driveLayout, 'awd');
  assert.ok(options.config.ground.rayCast.maxSuspensionTravel >= 0.5);
  assert.equal(options.config.ground.traction, 0.68);
  const vehicle = new BaseVehicle(options);
  const asphaltGrip = vehicle.surfaceTuning.frictionSlip;
  vehicle.setGroundSurface('dirt');
  vehicle._updateSurfaceTuning(0.5);
  assert.ok(vehicle.surfaceTuning.frictionSlip < asphaltGrip);
  ok('rally car uses Subaru shell, gravel wheels, AWD, long travel, and eased dirt grip');
}

console.log(`\nAll ${passed} rally-mode checks passed.`);
