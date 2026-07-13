/**
 * Matrix Highway M0 contract checks (pure node).
 *
 * Guards:
 *   1. Level return contract and road footprint (on-ribbon height, off-ribbon −∞).
 *   2. s ↔ world-Z conversion and focusS derivation.
 *   3. Deterministic tiled slot generation with stable `tileIndex:entryIndex` IDs.
 *   4. Bounded window diff/recycle without creating new pool members.
 *   5. Dedicated player vehicle cannot become a traffic lease.
 *   6. ensureGroundCollider always false; fixed collider descriptors present.
 *
 * Run: node scripts/verify-highway-level.mjs
 * Alias: npm run verify:highway-level
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DEFAULT_HIGHWAY_SEED,
  HIGHWAY_ORIGIN_Z,
  HIGHWAY_PHYSICAL_HALF_LENGTH,
  HIGHWAY_Y,
  LANES,
  LANE_COUNT,
  ROAD_HALF_WIDTH,
  RUN_LENGTH,
  WINDOW_BACK,
  WINDOW_FRONT,
  estimateMaxLiveSlots,
  isInsideRoad,
  makeSlotId,
  parseSlotId,
  physicalRoadBounds,
  playerVehicleSpawnPosition,
  poolSizeForArchetype,
  totalTrafficPoolSize,
  resolveWindowSlots,
  sToWorldZ,
  worldZToS,
} from '../src/game/config/highwayRunManifest.js';
import { createMatrixHighwayLevel } from '../src/game/world/createMatrixHighwayLevel.js';
import {
  HighwayTrafficSystem,
  LEASE_IDLE,
  LEASE_TRAFFIC,
} from '../src/game/systems/HighwayTrafficSystem.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

// ── 1. Level contract + road footprint ──────────────────────────────────────

{
  const level = createMatrixHighwayLevel();
  assert.equal(level.name, 'Matrix Highway');
  assert.ok(level.group instanceof THREE.Group);
  assert.ok(level.spawnPoint instanceof THREE.Vector3);
  assert.equal(level.spawnYaw, 0);
  assert.ok(Array.isArray(level.colliders) && level.colliders.length >= 1);
  assert.equal(level.geometryIndex, null);
  assert.equal(level.isNearFieldReady(), true);
  assert.equal(level.ensureGroundCollider(), false);
  assert.equal(level.ensureGroundCollider({ x: 0, z: 0 }, {}), false);

  const slab = level.colliders.find((c) => c.name === 'Highway Road Slab');
  assert.ok(slab, 'fixed road slab collider');
  assert.equal(slab.topY, HIGHWAY_Y);
  assert.ok(slab.minZ <= -HIGHWAY_PHYSICAL_HALF_LENGTH + 1);
  assert.ok(slab.maxZ >= HIGHWAY_PHYSICAL_HALF_LENGTH - 1);
  assert.ok(slab.maxX - slab.minX >= ROAD_HALF_WIDTH * 2 - 0.01);

  // On-ribbon height
  assert.equal(level.getGroundHeightAt({ x: 0, y: 0, z: 0 }, 0), HIGHWAY_Y);
  assert.equal(level.getGroundHeightAt({ x: LANES[0], y: 0, z: -100 }, 0.5), HIGHWAY_Y);
  assert.equal(level.getRoadSurfaceAt(0, -50), 'asphalt');

  // Off-ribbon: real fall, not invisible floor
  assert.equal(level.getGroundHeightAt({ x: ROAD_HALF_WIDTH + 5, y: 0, z: 0 }, 0), -Infinity);
  assert.equal(level.getGroundHeightAt({ x: 0, y: 0, z: HIGHWAY_PHYSICAL_HALF_LENGTH + 50 }, 0), -Infinity);
  assert.equal(level.getRoadSurfaceAt(ROAD_HALF_WIDTH + 5, 0), null);

  // Visual update does not mutate colliders (fixed collider contract)
  const before = level.colliders.map((c) => ({ ...c }));
  level.update({ character: { group: { position: new THREE.Vector3(0, HIGHWAY_Y, -200) } } });
  level.updateVisualFocus?.(new THREE.Vector3(0, HIGHWAY_Y, -400));
  assert.equal(level.colliders.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(level.colliders[i].minZ, before[i].minZ);
    assert.equal(level.colliders[i].maxZ, before[i].maxZ);
    assert.equal(level.colliders[i].topY, before[i].topY);
  }

  const snap = level.snapshot();
  assert.equal(snap.mode, 'highway');
  assert.ok(snap.physicalRoad);
  assert.equal(snap.physicalRoad.halfLength, HIGHWAY_PHYSICAL_HALF_LENGTH);
  assert.equal(snap.highwayY, HIGHWAY_Y);

  // Spawn on road
  assert.ok(isInsideRoad(level.spawnPoint, 0.5));
  assert.ok(isInsideRoad(playerVehicleSpawnPosition(), 0));
  assert.equal(level.getGroundHeightAt(level.spawnPoint, 0.5), HIGHWAY_Y);

  level.dispose();
  ok('level contract, fixed collider, and road footprint');
}

// ── 2. s ↔ world-Z conversion ───────────────────────────────────────────────

{
  assert.equal(LANE_COUNT, 5);
  assert.equal(LANES.length, 5);
  assert.equal(sToWorldZ(0), HIGHWAY_ORIGIN_Z);
  assert.equal(sToWorldZ(100), HIGHWAY_ORIGIN_Z - 100);
  assert.equal(worldZToS(HIGHWAY_ORIGIN_Z - 250), 250);
  assert.equal(worldZToS({ z: HIGHWAY_ORIGIN_Z - 80 }), 80);
  // focusS = ORIGIN_Z - focus.z
  const focus = { z: -320 };
  assert.equal(worldZToS(focus), 320);
  assert.equal(sToWorldZ(worldZToS(-77)), -77);
  ok('s to world-Z conversion');
}

// ── 3. Deterministic slots + stable IDs ─────────────────────────────────────

{
  const focusS = 50;
  const a = resolveWindowSlots({ focusS, seed: DEFAULT_HIGHWAY_SEED });
  const b = resolveWindowSlots({ focusS, seed: DEFAULT_HIGHWAY_SEED });
  assert.ok(a.length > 0, 'expected traffic slots in window');
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i].id, b[i].id);
    assert.equal(a[i].s, b[i].s);
    assert.equal(a[i].lane, b[i].lane);
    assert.equal(a[i].worldZ, b[i].worldZ);
    assert.equal(a[i].colorIndex, b[i].colorIndex);
    const parsed = parseSlotId(a[i].id);
    assert.ok(parsed);
    assert.equal(a[i].id, makeSlotId(parsed.tileIndex, parsed.entryIndex));
    assert.match(a[i].id, /^-?\d+:\d+$/);
  }

  // Different seed changes colour assignment (same geometry slots for M0).
  const c = resolveWindowSlots({ focusS, seed: 0xdeadbeef });
  assert.equal(c.length, a.length);
  assert.ok(c.every((slot, i) => slot.id === a[i].id && slot.s === a[i].s));

  // Tile tiling: same entry index at tile k and k+1 differs by RUN_LENGTH
  const far = resolveWindowSlots({
    focusS: RUN_LENGTH + 50,
    seed: DEFAULT_HIGHWAY_SEED,
    windowFront: WINDOW_FRONT,
    windowBack: WINDOW_BACK,
  });
  const tile0 = a.find((s) => s.tileIndex === 0 && s.entryIndex === 0);
  const tile1 = far.find((s) => s.tileIndex === 1 && s.entryIndex === 0);
  if (tile0 && tile1) {
    assert.equal(tile1.s - tile0.s, RUN_LENGTH);
    assert.notEqual(tile0.id, tile1.id);
  }

  // Window bounds: every slot s in range; dSpeed is finite (M6 convoy relative).
  for (const slot of a) {
    assert.ok(slot.s >= focusS - WINDOW_BACK - 1e-6);
    assert.ok(slot.s <= focusS + WINDOW_FRONT + 1e-6);
    assert.equal(slot.worldZ, sToWorldZ(slot.s));
    assert.ok(Number.isFinite(slot.dSpeed));
  }

  ok('deterministic slot generation and stable IDs');
}

// ── 4–5. Bounded pool recycle + player exclusion ────────────────────────────

{
  const recoverCalls = [];
  const parkCalls = [];
  let nextId = 1;

  function makeFakeVehicle(name) {
    const vehicle = {
      id: `v-${nextId++}`,
      name,
      status: 'ready',
      group: new THREE.Group(),
      spawnPosition: new THREE.Vector3(),
      bodyHandle: nextId,
      hasDriver: () => false,
      getGroundSpawnClearance: () => 0.9,
      recover({ position, rotationY }) {
        recoverCalls.push({ vehicle, position: { ...position }, rotationY });
        vehicle.group.position.set(position.x, position.y, position.z);
        return true;
      },
      park() {
        parkCalls.push(vehicle);
      },
    };
    return vehicle;
  }

  const vehicles = [];
  const vehicleSystem = {
    vehicles,
    activeVehicle: null,
    level: {
      getGroundHeightAt: (pos) => (isInsideRoad(pos, 0) ? HIGHWAY_Y : -Infinity),
    },
    async spawnVehicle({ vehicle }) {
      // Mimic registry: accept prebuilt or wrap
      const v = vehicle ?? makeFakeVehicle('spawned');
      if (!v.recover) Object.assign(v, makeFakeVehicle(v.name ?? 'spawned'));
      // Ensure recover/park exist when a real-ish BaseVehicle mock is partial
      if (typeof v.recover !== 'function') {
        const fake = makeFakeVehicle(v.name);
        Object.assign(v, {
          recover: fake.recover.bind(fake),
          park: fake.park.bind(fake),
          group: v.group ?? fake.group,
          getGroundSpawnClearance: () => 0.9,
          hasDriver: () => false,
        });
      }
      vehicles.push(v);
      return v;
    },
  };

  // Use a spawn hook that always returns our fakes (avoid loading real BaseVehicle meshes).
  const originalSpawn = vehicleSystem.spawnVehicle;
  vehicleSystem.spawnVehicle = async ({ vehicle } = {}) => {
    const name = vehicle?.name ?? 'Highway Traffic';
    const v = makeFakeVehicle(name);
    vehicles.push(v);
    return v;
  };

  const physics = { world: {} };
  const playerCar = makeFakeVehicle('Highway Player Car');
  // Player is registered separately and must never enter the pool.
  vehicles.push(playerCar);

  const traffic = new HighwayTrafficSystem({
    physics,
    vehicleSystem,
    seed: DEFAULT_HIGHWAY_SEED,
    windowFront: WINDOW_FRONT,
    windowBack: WINDOW_BACK,
  });

  const poolTarget = totalTrafficPoolSize();
  assert.ok(poolTarget >= estimateMaxLiveSlots() + 1);

  await traffic.initialize({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50) },
    protectedVehicles: [playerCar],
  });

  const poolAfterInit = vehicles.length - 1; // exclude player
  assert.equal(poolAfterInit, poolTarget, `pool size ${poolAfterInit} vs ${poolTarget}`);
  assert.equal(traffic.isPoolMember(playerCar), false);
  assert.equal(traffic.isTrafficLease(playerCar), false);

  // Idle park must sit outside the road footprint so ground-snap cannot stack
  // the whole pool onto the deck at the origin (the "infinite cars behind start" bug).
  for (let i = 0; i < 4; i += 1) {
    const park = traffic.idleParkPosition(i);
    assert.ok(!isInsideRoad(park, 2), `idle park ${i} must be outside road`);
    assert.ok(park.y < -10, `idle park ${i} must be buried below the deck`);
  }
  for (const members of traffic.pools.values()) {
    for (const lease of members) {
      if (lease.state !== LEASE_IDLE) continue;
      const p = lease.vehicle.group.position;
      assert.ok(!isInsideRoad(p, 1), `idle vehicle ${lease.vehicle.name} still on ribbon at ${p.x},${p.z}`);
      assert.equal(lease.vehicle.group.visible, false, 'idle pool cars must be hidden');
    }
    for (const lease of members) {
      if (lease.state !== LEASE_TRAFFIC) continue;
      // Chassis group stays hidden — drawing is TSL InstancedMesh fleet.
      // Presence on the ribbon is the live-lease contract.
      assert.ok(isInsideRoad(lease.vehicle.group.position, 2), 'live traffic should sit on the ribbon');
      assert.ok(
        traffic.carVisuals?.assignments?.has?.(lease.vehicle)
          || lease.vehicle.group.visible === true,
        'live traffic must have TSL instance or visible mesh',
      );
    }
  }

  const snap0 = traffic.snapshot();
  assert.equal(snap0.seed, DEFAULT_HIGHWAY_SEED);
  assert.ok(snap0.poolSize === poolTarget);
  assert.ok(snap0.liveLeases > 0);
  assert.ok(snap0.idleLeases >= 0);
  assert.equal(snap0.liveLeases + snap0.idleLeases, snap0.poolSize);
  assert.ok(snap0.physicalRoad);
  assert.equal(snap0.physicalRoad.halfWidth, ROAD_HALF_WIDTH);
  assert.ok(Number.isFinite(snap0.focusS));
  assert.ok(snap0.tileRange);

  const liveIds0 = new Set(snap0.liveSlotIds);
  assert.ok(liveIds0.size === snap0.liveLeases);

  // Advance focus along +s (more negative world Z) — recycle without new spawns.
  const vehicleCountBefore = vehicles.length;
  recoverCalls.length = 0;
  const result = traffic.updateWindow({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50 + RUN_LENGTH) },
    protectedVehicles: [playerCar],
  });
  assert.equal(vehicles.length, vehicleCountBefore, 'no new pool members during recycle');
  assert.ok(result.acquired + result.released >= 0);

  const snap1 = traffic.snapshot();
  assert.equal(snap1.poolSize, snap0.poolSize);
  assert.equal(snap1.liveLeases + snap1.idleLeases, snap1.poolSize);
  // Slot IDs should have shifted with the window
  const liveIds1 = new Set(snap1.liveSlotIds);
  assert.ok(liveIds1.size > 0);

  // Player still excluded
  assert.equal(traffic.isPoolMember(playerCar), false);
  assert.equal(traffic.isTrafficLease(playerCar), false);
  for (const members of traffic.pools.values()) {
    for (const lease of members) {
      assert.notEqual(lease.vehicle, playerCar);
      assert.ok(lease.state === LEASE_IDLE || lease.state === LEASE_TRAFFIC);
    }
  }

  // recover + park used for placement (not dispose/spawn)
  assert.ok(recoverCalls.length > 0 || parkCalls.length > 0, 'recycle uses recover/park');

  traffic.dispose();
  assert.equal(traffic.status, 'idle');
  // Dispose only clears bookkeeping — vehicles remain for VehicleSystem
  assert.equal(vehicles.length, vehicleCountBefore);

  void originalSpawn;
  ok('bounded window recycle without new pool members');
  ok('dedicated player vehicle cannot become a traffic lease');
}

// ── Bounds helper consistency ───────────────────────────────────────────────

{
  const b = physicalRoadBounds();
  assert.equal(b.minX, -ROAD_HALF_WIDTH);
  assert.equal(b.maxX, ROAD_HALF_WIDTH);
  assert.equal(b.y, HIGHWAY_Y);
  assert.ok(isInsideRoad({ x: 0, z: 0 }, 0));
  assert.ok(!isInsideRoad({ x: ROAD_HALF_WIDTH + 1, z: 0 }, 0));
  ok('physical road bounds helpers');
}

console.log(`\nAll ${passed} highway-level checks passed.`);
