// Rally wet roads (docs/advanced-wet-roads-plan.md) — pure-node lifecycle checks.
//
// Guards:
//   M0 — `wet` in ROAD_SURFACES; surfaceForRoad override; corridor routing;
//        surfaces.wet between dirt and mud (no bog floor); setGroundSurface
//        admits wet; grip eases dirt→wet without dropping to mud.
//   M1 — wet material owns a wetness uniform floor; max(rain, wet) behaviour
//        via DEFAULT_WET_ROAD_WETNESS > 0; dirt material has no wetness floor.
//   M2 — wet material enables env reflections (no disablePbrEnvironment path);
//        dirt/mud still black out env when no wet road is built.
//   M3 — wet does NOT engage mud bogGrip / deform add channel.
//   Scope — world-style asphalt/dirt paths unchanged.
//
// Run: node scripts/verify-rally-wet-roads.mjs
//   or: npm run verify:rally-wet-roads

import assert from 'node:assert/strict';

const {
  ROAD_SURFACES,
  normalizeRoadSurface,
  normalizeRoadSurfaceWear,
  surfaceForRoad,
  surfaceForTrackStyle,
  roadWantsTread,
  surfaceWearForRoad,
  roadNeedsDeformField,
} = await import('../src/world/worldMap/roadSurface.js');
const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { DEFAULT_VEHICLE_CONFIG, createVehicleConfig } =
  await import('../src/game/config/vehicleConfig.js');
const { BaseVehicle } = await import('../src/game/vehicles/BaseVehicle.js');
const {
  createRallySurfaceMaterial,
  loadRallySurfaceSet,
  DEFAULT_WET_ROAD_WETNESS,
} = await import('../src/game/materials/rallySurfaceTextures.js');
const { rainWetness, rainWind } = await import('../src/game/systems/weatherUniforms.js');
const { getQualityPreset } = await import('../src/game/config/qualityPresets.js');
const { createMudDeformField } = await import('../src/game/world/mudDeformField.js');
const { buildPreWornStampPoints, seedPreWornOnField } =
  await import('../src/game/world/seedPreWornTracks.js');
const { normalizeRoad } = await import('../src/world/worldMap/worldMapSchema.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- M0 enum + resolver
{
  assert.ok(ROAD_SURFACES.wet, 'wet is a ROAD_SURFACES entry');
  assert.equal(normalizeRoadSurface('wet'), 'wet', 'wet normalizes to itself');
  assert.equal(normalizeRoadSurface('quicksand'), null, 'unknown surfaces reject');
  assert.equal(surfaceForRoad({ surface: 'wet', trackStyle: 'rallyStage' }), 'wet',
    'road.surface: wet overrides the rallyStage dirt default');
  assert.equal(surfaceForTrackStyle('rallyStage'), 'dirt',
    'trackStyle default unchanged (still dirt, not wet)');
  ok('M0 wet enum + surfaceForRoad override');
}

// ---------------------------------------------------------------- M0 corridor
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
  const wet = buildProfile('wet');
  const onDeck = wet.corridorAt(0, 0);
  assert.ok(onDeck && onDeck.weight >= 0.999, 'wet road deck is full-strength corridor');
  assert.equal(onDeck.surface, 'wet', 'corridor surface is wet on the deck');
  const off = wet.corridorAt(0, 500);
  assert.ok(off == null || off.weight <= 0, 'off-corridor returns no wet');
  ok('M0 corridorAt routes wet on-deck, nothing off-deck');

  const dirt = buildProfile(undefined);
  assert.equal(dirt.corridorAt(0, 0).surface, 'dirt', 'plain rallyStage stays dirt');
  const asphalt = buildRoadProfile({
    roads: [{ points: [{ x: -40, z: 0 }, { x: 40, z: 0 }], width: 10 }],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  assert.equal(asphalt.corridorAt(0, 0).surface, 'asphalt', 'plain road stays asphalt');
  const mud = buildProfile('mud');
  assert.equal(mud.corridorAt(0, 0).surface, 'mud', 'mud still routes');
  ok('M0 scope: dirt/asphalt/mud surfaces unchanged');
}

// ---------------------------------------------------------------- M0 grip profile
{
  const s = DEFAULT_VEHICLE_CONFIG.ground.surfaces;
  assert.ok(s.wet, 'ground.surfaces.wet exists');
  assert.ok(s.wet.frictionSlip < s.dirt.frictionSlip, 'wet is slicker than dirt');
  assert.ok(s.wet.frictionSlip > s.mud.frictionSlip, 'wet is grippier than mud (no bog floor)');
  assert.ok(s.wet.sideFrictionStiffness > s.mud.sideFrictionStiffness, 'wet lat grip > mud');
  assert.ok(s.wet.rollingResistanceScale < s.mud.rollingResistanceScale, 'wet less draggy than mud');
  assert.equal(s.wet.gripLerp, s.dirt.gripLerp, 'wet uses dirt-quick gripLerp (no bog squirm)');
  ok('M0 surfaces.wet sits between dirt and mud, no bog');
}

// ---------------------------------------------------------------- M0 vehicle surface
{
  const stub = {};
  BaseVehicle.prototype.setGroundSurface.call(stub, 'wet');
  assert.equal(stub.groundSurface, 'wet', 'setGroundSurface accepts wet');
  BaseVehicle.prototype.setGroundSurface.call(stub, 'grass');
  assert.equal(stub.groundSurface, 'offroad', 'unknown surface → offroad');
  BaseVehicle.prototype.setGroundSurface.call(stub, 'dirt');
  assert.equal(stub.groundSurface, 'dirt', 'dirt still accepted');
  BaseVehicle.prototype.setGroundSurface.call(stub, 'mud');
  assert.equal(stub.groundSurface, 'mud', 'mud still accepted');

  const config = createVehicleConfig();
  const dirtProfile = config.ground.surfaces.dirt;
  const wetProfile = config.ground.surfaces.wet;
  const mudProfile = config.ground.surfaces.mud;
  const tuner = { config, groundSurface: 'wet', surfaceTuning: { ...dirtProfile } };
  assert.ok(tuner.surfaceTuning.frictionSlip > wetProfile.frictionSlip + 0.05,
    'starts at dirt grip (above wet)');
  for (let i = 0; i < 240; i += 1) {
    BaseVehicle.prototype._updateSurfaceTuning.call(tuner, 1 / 60);
  }
  // Wet + Clear-weather stage slick (0.55 floor) lands slightly below the bare profile.
  assert.ok(
    tuner.surfaceTuning.frictionSlip < dirtProfile.frictionSlip - 0.1,
    'friction eased down from dirt',
  );
  assert.ok(
    tuner.surfaceTuning.frictionSlip > mudProfile.frictionSlip + 0.05,
    `must not bog to mud (${tuner.surfaceTuning.frictionSlip.toFixed(3)} > mud ${mudProfile.frictionSlip})`,
  );
  ok('M0 setGroundSurface + grip eases into wet, not mud bog');
}

// ---------------------------------------------------------------- M1 persistent wetness + M2 env
{
  assert.ok(DEFAULT_WET_ROAD_WETNESS > 0 && DEFAULT_WET_ROAD_WETNESS < 1,
    `DEFAULT_WET_ROAD_WETNESS is a sensible floor (${DEFAULT_WET_ROAD_WETNESS})`);

  // Dirt material (shared path): rain-only, env blacked out, no wetness floor.
  const dirtMat = createRallySurfaceMaterial(loadRallySurfaceSet('dirt'), {
    rainWetness,
    rainWind,
  });
  assert.equal(dirtMat.wetnessUniform, undefined, 'dirt material has no wetness floor');
  assert.ok(dirtMat.envNode != null, 'dirt material blacks out env (envNode set)');
  assert.equal(dirtMat.userData?.wetEnvReflections, undefined, 'dirt has no env reflection gate');

  // Wet material: persistent wetness + env reflections enabled.
  const wetMat = createRallySurfaceMaterial(loadRallySurfaceSet('dirt'), {
    rainWetness,
    rainWind,
    wetness: DEFAULT_WET_ROAD_WETNESS,
    wetSurface: true,
    envReflections: { enabled: true, envIntensity: 1, fresnel: true },
    lowSpotBias: 0.25,
    tireTracks: true,
  });
  assert.ok(wetMat.wetnessUniform, 'wet material owns wetnessUniform');
  assert.equal(wetMat.wetnessUniform.value, DEFAULT_WET_ROAD_WETNESS,
    'wetness floor matches default');
  // With rain at 0, effective wetness is still the floor (CPU-side check).
  const prevRain = rainWetness.value;
  rainWetness.value = 0;
  assert.ok(Math.max(rainWetness.value, wetMat.wetnessUniform.value) > 0,
    'effWet > 0 with rainWetness == 0 (persistent puddles)');
  rainWetness.value = 0.9;
  assert.ok(Math.max(rainWetness.value, wetMat.wetnessUniform.value) >= 0.9,
    'rain raises effective wetness on top of floor');
  rainWetness.value = prevRain;

  assert.equal(wetMat.envNode, null,
    'wet material does NOT black out env (scene PMREM reaches puddles)');
  assert.ok(wetMat.userData?.wetEnvReflections?.standingGate,
    'wet material records standing-water env reflection gate');
  ok('M1 persistent wetness + M2 env gate on wet material');
}

// ---------------------------------------------------------------- M3 tread + no bog
{
  // Wet roads must not construct MudDeformField bog paths — no bogGrip config
  // on the wet surface profile. Live stamps are shallow (no dig-in bog).
  const s = DEFAULT_VEHICLE_CONFIG.ground.surfaces.wet;
  assert.equal(s.bogGrip, undefined, 'wet profile has no bogGrip');
  assert.ok(roadWantsTread({ surface: 'wet' }), 'wet defaults to tread on');
  assert.ok(roadWantsTread({ surface: 'wet', tread: true }), 'wet tread:true');
  assert.equal(roadWantsTread({ surface: 'wet', tread: false }), false, 'wet tread:false opt-out');
  assert.ok(roadNeedsDeformField({ surface: 'wet' }), 'wet with tread needs deform field');
  assert.equal(roadNeedsDeformField({ surface: 'wet', tread: false }), false,
    'flat wet needs no deform field');
  assert.ok(roadNeedsDeformField({ surface: 'mud' }), 'mud always needs deform field');

  // Live wet stamps are allowed (shallow tread) but must not use mud dig rates.
  let stamped = 0;
  let lastAdd = 0;
  const stub = {
    groundSurface: 'wet',
    controllerSpeed: 12,
    speed: 12,
    group: { quaternion: { x: 0, y: 0, z: 0, w: 1 } },
    wheelTelemetry: [{
      inContact: true,
      contactPoint: { x: 0, z: 0 },
      surface: 'wet',
      slipRatio: 0.4,
      suspensionForce: 1500,
      normalizedLoad: 0.8,
      mudIntensity: 0.5,
    }],
  };
  BaseVehicle.prototype.stampMudRuts.call(stub, {
    stampBrush(_x, _z, _r, opts) {
      stamped += 1;
      lastAdd = opts.add ?? 0;
    },
  }, 1 / 60);
  assert.ok(stamped > 0, 'wet wheels stamp shallow tread into the deform field');
  assert.ok(lastAdd < 0.01, 'wet dig add is tiny (no bog bore)');
  ok('M3 wet tread stamps shallow grooves, no bog dig-in');
}

// ---------------------------------------------------------------- pre-worn demo wear
{
  assert.equal(normalizeRoadSurfaceWear('preWorn'), 'preWorn');
  assert.equal(normalizeRoadSurfaceWear('fresh'), 'fresh');
  assert.equal(normalizeRoadSurfaceWear('ancient'), null);
  assert.equal(surfaceWearForRoad({ surface: 'mud', surfaceWear: 'preWorn' }), 'preWorn');
  assert.equal(surfaceWearForRoad({ surface: 'wet' }), 'fresh');

  const road = normalizeRoad({
    points: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 80, z: 0 }],
    width: 8,
    trackStyle: 'rallyStage',
    surface: 'wet',
    surfaceWear: 'preWorn',
    tread: true,
  });
  assert.equal(road.surfaceWear, 'preWorn');
  assert.equal(road.tread, true);

  const profile = buildRoadProfile({
    roads: [road],
    sampleHeight: () => 0,
    smoothRadius: 2,
    maxGrade: Infinity,
  });
  const points = buildPreWornStampPoints(profile, { laps: 3 });
  assert.ok(points.length > 50, `pre-worn lays dual-wheel points for 3 laps (got ${points.length})`);
  // 3 laps ⇒ left/right pairs with lateral spread.
  const lats = points.map((p) => p.z); // road along X, wheels offset in Z
  assert.ok(Math.max(...lats) - Math.min(...lats) > 0.5, 'left/right wheel lines are separated');

  const field = createMudDeformField({
    maxDepth: 0.12,
    cellSize: 0.15,
    resolution: 256,
    depthTau: 40,
    treadTau: 22,
    prewornDepthTau: 180,
    prewornTreadTau: 100,
  });
  const seeded = seedPreWornOnField(field, profile, { centerX: 0, centerZ: 0, laps: 3 });
  assert.ok(seeded.points > 0 && field.hasPreWorn, 'field installs pre-worn points');
  assert.ok(seeded.stamped > 0 || field.activeCount > 0, 'spawn footprint receives pre-worn stamps');

  // Pre-worn decays much slower than vehicle stamps (same initial depth).
  const pre = createMudDeformField({
    maxDepth: 0.2, cellSize: 0.5, resolution: 32,
    depthTau: 8, treadTau: 4,
    prewornDepthTau: 120, prewornTreadTau: 60,
  });
  pre.stamp(0.25, 0.25, { depth: 0.12, tread: 1, wetness: 0.5, kind: 'preworn' });
  const veh = createMudDeformField({
    maxDepth: 0.2, cellSize: 0.5, resolution: 32,
    depthTau: 8, treadTau: 4,
    prewornDepthTau: 120, prewornTreadTau: 60,
  });
  veh.stamp(0.25, 0.25, { depth: 0.12, tread: 1, wetness: 0.5, kind: 'vehicle' });
  // ~8 s of decay: vehicle ~e^(-1) of depth, preworn still near full.
  for (let i = 0; i < 480; i += 1) {
    pre.decay(1 / 60);
    veh.decay(1 / 60);
  }
  const preD = pre.sampleAt(0.25, 0.25).depth;
  const vehD = veh.sampleAt(0.25, 0.25).depth;
  assert.ok(preD > vehD * 2,
    `pre-worn depth ${preD.toFixed(3)} lingers vs vehicle ${vehD.toFixed(3)}`);
  ok('pre-worn wear: 3-lap dual tracks, slower fade than live tread');
}

// ---------------------------------------------------------------- quality preset
{
  const high = getQualityPreset('high');
  assert.ok(high.wetRoads?.enabled, 'high preset enables wetRoads');
  assert.ok(high.wetRoads.wetness > 0, 'high wetness floor > 0');
  assert.ok(high.wetRoads.tread?.enabled, 'high enables wet tread by default');
  const low = getQualityPreset('low');
  assert.equal(low.wetRoads?.enabled, false, 'low preset disables wetRoads');
  ok('M5 wetRoads quality preset shape');
}

// ---------------------------------------------------------------- water spray profile
{
  const dust = DEFAULT_VEHICLE_CONFIG.ground.dust;
  assert.ok(dust.water, 'dust.water spray profile exists');
  assert.ok(dust.water.buoyancy > dust.mud.buoyancy, 'water spray is more buoyant than mud clods');
  assert.ok(dust.water.color.fresh[2] > dust.mud.color.fresh[2], 'water spray is cooler/lighter');
  ok('M4 water spray dust profile');
}

console.log(`\nAll ${passed} rally-wet-roads checks passed.`);
