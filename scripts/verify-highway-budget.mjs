/**
 * Highway structural budget gates (pure node) — O0/O1/O2.
 *
 * Guards:
 *   1. Per-archetype pool sizes (sedan + semi) stay bounded; total fleet pool gated.
 *   2. Road mesh/geometry batch counts under submission caps.
 *   3. Dormant pool members skip simulated vehicle list.
 *   4. No pool growth during recycle; remount keeps road resource counts stable.
 *   5. Traffic maintenance can skip frames when force=false.
 *
 * Run: node scripts/verify-highway-budget.mjs
 * Alias: npm run verify:highway-budget
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  POOL_SPARE_PER_ARCHETYPE,
  WINDOW_BACK,
  WINDOW_FRONT,
  estimateMaxLiveSlots,
  isInsideRoad,
  poolSizeForArchetype,
  totalTrafficPoolSize,
  TRAFFIC_ARCHETYPES,
  HIGHWAY_Y,
  sToWorldZ,
  DEFAULT_HIGHWAY_SEED,
} from '../src/game/config/highwayRunManifest.js';
import { createMatrixHighwayLevel } from '../src/game/world/createMatrixHighwayLevel.js';
import {
  HighwayTrafficSystem,
  LEASE_IDLE,
} from '../src/game/systems/HighwayTrafficSystem.js';
import {
  VEHICLE_ACTIVITY_ACTIVE,
  VEHICLE_ACTIVITY_DORMANT,
  VehicleSystem,
} from '../src/game/systems/VehicleSystem.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

// ── 1. Exact pool budget ────────────────────────────────────────────────────

{
  const exact = estimateMaxLiveSlots({
    windowFront: WINDOW_FRONT,
    windowBack: WINDOW_BACK,
  });
  const pool = totalTrafficPoolSize({
    windowFront: WINDOW_FRONT,
    windowBack: WINDOW_BACK,
  });
  // Per-archetype pools: sum of (max live of type + spare).
  let perType = 0;
  for (const type of TRAFFIC_ARCHETYPES) {
    const e = estimateMaxLiveSlots({ windowFront: WINDOW_FRONT, windowBack: WINDOW_BACK, type });
    const p = poolSizeForArchetype({ windowFront: WINDOW_FRONT, windowBack: WINDOW_BACK, type });
    assert.equal(p, e + POOL_SPARE_PER_ARCHETYPE, `${type} pool`);
    perType += p;
  }
  assert.equal(pool, perType);
  assert.ok(exact >= 18, `mixed fleet max live ${exact}`);
  assert.ok(pool < 50, `total pool ${pool} still bounded`);
  ok(`exact pool demand ${exact}; total fleet pool ${pool} (sedan+semi)`);
}

// ── 2. Road batch budgets ───────────────────────────────────────────────────

{
  const level = createMatrixHighwayLevel();
  const snap = level.snapshot();
  assert.ok(snap.roadMeshCount <= 20, `road meshes ${snap.roadMeshCount} > 20`);
  assert.ok(snap.roadGeometryCount <= 20, `road geos ${snap.roadGeometryCount} > 20`);
  assert.ok(snap.roadBatchCount >= 4, 'expected multiple instanced batches');
  assert.ok(snap.roadMeshCount < 50, 'road must not be hundreds of unique boxes');

  // Remount stability: create/dispose/create keeps counts.
  level.dispose();
  const level2 = createMatrixHighwayLevel();
  const snap2 = level2.snapshot();
  assert.equal(snap2.roadMeshCount, snap.roadMeshCount);
  assert.equal(snap2.roadGeometryCount, snap.roadGeometryCount);
  level2.dispose();
  ok(`road batches meshes=${snap.roadMeshCount} geos=${snap.roadGeometryCount}`);
}

// ── 3–4. Dormant pool + recycle without growth ──────────────────────────────

{
  let nextId = 1;
  const activityLog = [];
  function makeFakeVehicle(name) {
    const vehicle = {
      id: `v-${nextId++}`,
      name,
      status: 'ready',
      bodyHandle: nextId,
      group: new THREE.Group(),
      linearVelocity: new THREE.Vector3(),
      speed: 0,
      parkedMode: true,
      activity: VEHICLE_ACTIVITY_ACTIVE,
      highwayCruise: null,
      hasDriver: () => false,
      getGroundSpawnClearance: () => 0.9,
      recover({ position }) {
        vehicle.group.position.set(position.x, position.y, position.z);
        return true;
      },
      park() {
        vehicle.parkedMode = true;
      },
    };
    return vehicle;
  }

  const vehicles = [];
  const simulatedVehicles = [];
  const vehicleSystem = {
    vehicles,
    simulatedVehicles,
    activeVehicle: null,
    level: {
      getGroundHeightAt: (pos) => (isInsideRoad(pos, 0) ? HIGHWAY_Y : -Infinity),
    },
    async spawnVehicle({ vehicle } = {}) {
      const v = makeFakeVehicle(vehicle?.name ?? 't');
      vehicles.push(v);
      simulatedVehicles.push(v);
      return v;
    },
    setVehicleActivity(vehicle, activity) {
      activityLog.push({ id: vehicle.id, activity });
      vehicle.activity = activity;
      if (activity === VEHICLE_ACTIVITY_DORMANT) {
        vehicle.group.visible = false;
        const i = simulatedVehicles.indexOf(vehicle);
        if (i >= 0) simulatedVehicles.splice(i, 1);
      } else if (!simulatedVehicles.includes(vehicle)) {
        simulatedVehicles.push(vehicle);
        vehicle.group.visible = true;
      }
      return true;
    },
  };

  const physics = {
    world: {},
    getFreshBody() {
      return {
        setLinvel() {},
        setAngvel() {},
        wakeUp() {},
        setEnabled() {},
        sleep() {},
      };
    },
  };

  const traffic = new HighwayTrafficSystem({
    physics,
    vehicleSystem,
    seed: DEFAULT_HIGHWAY_SEED,
  });
  await traffic.initialize({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50) },
  });

  const poolTarget = totalTrafficPoolSize();
  assert.equal(vehicles.length, poolTarget);
  const dormant = vehicles.filter((v) => v.activity === VEHICLE_ACTIVITY_DORMANT);
  const live = vehicles.filter((v) => v.activity === VEHICLE_ACTIVITY_ACTIVE);
  assert.ok(dormant.length > 0, 'idle pool members must be dormant');
  assert.ok(live.length > 0, 'live traffic must be active');
  assert.equal(simulatedVehicles.length, live.length);
  assert.ok(
    activityLog.some((e) => e.activity === VEHICLE_ACTIVITY_DORMANT),
    'setVehicleActivity(dormant) used',
  );

  const count0 = vehicles.length;
  traffic.updateWindow({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50 + 400) },
    force: true,
  });
  assert.equal(vehicles.length, count0, 'no async spawn after init');

  // Throttle: immediate second call without force/focus move should skip.
  const skip = traffic.updateWindow({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50 + 400) },
    force: false,
    now: 0,
  });
  // First init + force run already happened; with now=0 and lastMaintTime set high,
  // force another maint then skip.
  traffic.updateWindow({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50 + 400) },
    force: true,
    now: 100,
  });
  const skipped = traffic.updateWindow({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50 + 400.5) },
    force: false,
    now: 100.01,
  });
  assert.equal(skipped.skipped, true, 'steady drive skips maintenance');
  assert.ok(traffic.snapshot().skippedMaintenance >= 1);

  traffic.dispose();
  void skip;
  ok('dormant pool + recycle without growth + throttled maintenance');
}

// ── 5. VehicleSystem activity filter ────────────────────────────────────────

{
  const vs = new VehicleSystem();
  vs.status = 'ready';
  const a = { id: 'a', activity: VEHICLE_ACTIVITY_ACTIVE, status: 'ready' };
  const b = { id: 'b', activity: VEHICLE_ACTIVITY_DORMANT, status: 'ready' };
  vs.vehicles.push(a, b);
  vs._syncSimulatedList();
  assert.deepEqual(vs.simulatedVehicles.map((v) => v.id), ['a']);
  assert.equal(vs.isSimulated(a), true);
  assert.equal(vs.isSimulated(b), false);
  const counts = vs.activityCounts();
  assert.equal(counts.total, 2);
  assert.equal(counts.dormantPool, 1);
  assert.equal(counts.simulated, 1);
  ok('VehicleSystem simulated list filters dormant');
}

// ── 6. TSL car fleet is a handful of instanced draws ────────────────────────

{
  const { HighwayCarVisuals } = await import('../src/game/systems/HighwayCarVisuals.js');
  const {
    BODY_SPECS,
    buildCarGeometryForType,
  } = await import('../src/three-addons/generators/city/CarGenerator.js');
  const scene = new THREE.Scene();
  const visuals = new HighwayCarVisuals({ scene, capacity: 22 });
  visuals.initialize({ scene, capacity: 22, types: ['sedan', 'semi'] });
  const snap = visuals.snapshot();
  // paint × body-type buckets (sedan + semi); still a handful of draws.
  assert.ok(snap.bucketCount <= 24, `paint×type buckets ${snap.bucketCount} should stay modest`);
  assert.ok(snap.bucketCount >= 2, 'expected at least sedan + semi buckets');

  const fakes = [];
  for (let i = 0; i < 8; i += 1) {
    const v = { group: new THREE.Group() };
    v.group.position.set(i * 3, 12, -i * 10);
    fakes.push(v);
    assert.equal(visuals.attach(v, [0x3a4a5c, 0x8a3030, 0x2e5a3a, 0xc4a84a][i % 4]), true);
  }
  visuals.syncAll();
  const live = visuals.snapshot();
  assert.equal(live.liveInstances, 8);
  assert.ok(live.drawBuckets <= live.bucketCount);
  assert.ok(live.drawBuckets <= 8, 'instanced fleet must not be 1 draw per car');

  for (const v of fakes) visuals.detach(v);
  visuals.dispose();
  ok(`TSL car fleet buckets=${snap.bucketCount} (not full BaseVehicle meshes)`);

  const cabSpec = BODY_SPECS.semiCab;
  const trailerSpec = BODY_SPECS.semiTrailer;
  assert.equal(cabSpec.sectionShape, 'boxy');
  assert.equal(trailerSpec.sectionShape, 'boxy');
  const cabBack = cabSpec.stations.at(-1);
  const cabBeforeBack = cabSpec.stations.at(-2);
  assert.deepEqual(
    [cabBack[1], cabBack[2], cabBack[4], cabBack[5]],
    [cabBeforeBack[1], cabBeforeBack[2], cabBeforeBack[4], cabBeforeBack[5]],
    'cab sleeper ends in a vertical rear wall',
  );
  assert.equal(new Set(trailerSpec.stations.map((s) => s[1])).size, 1, 'trailer wall width stays square');
  assert.equal(new Set(trailerSpec.stations.map((s) => s[5])).size, 1, 'trailer roof stays flat');

  const cabGeometry = buildCarGeometryForType('semiCab');
  const trailerGeometry = buildCarGeometryForType('semiTrailer');
  cabGeometry.computeBoundingBox();
  trailerGeometry.computeBoundingBox();
  assert.ok(cabGeometry.boundingBox.max.y >= 2.3, 'cab has full-height sleeper');
  assert.ok(trailerGeometry.boundingBox.max.y >= 2.58, 'trailer has full-height box');
  cabGeometry.dispose();
  trailerGeometry.dispose();
  ok('semi cab and trailer retain squared commercial-vehicle silhouettes');
}

console.log(`\nAll ${passed} highway-budget checks passed.`);
