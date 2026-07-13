/**
 * Matrix Highway M6 convoy flow contract (pure node).
 *
 * Guards:
 *   1. FLOW_SPEED + dSpeed helpers and wider window.
 *   2. Manifest variety: mixed dSpeeds, denser tile packing.
 *   3. Place lease sets highwayCruise + seeds velocity (no park).
 *   4. Release clears cruise and parks off-ribbon.
 *   5. claimVehicleForPlayer clears cruise.
 *   6. computeHighwayCruiseControls holds lane + targets speed.
 *   7. Recycle is vehicle-s based (co-moving cars stay live).
 *
 * Run: node scripts/verify-highway-convoy.mjs
 * Alias: npm run verify:highway-convoy
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DEFAULT_HIGHWAY_SEED,
  FLOW_SPEED,
  HIGHWAY_Y,
  RUN_LENGTH,
  WINDOW_BACK,
  WINDOW_FRONT,
  cruiseSpeedForDSpeed,
  cruiseWorldVelocity,
  isInsideRoad,
  poolSizeForArchetype,
  totalTrafficPoolSize,
  resolveWindowSlots,
  runPlatforms,
  sToWorldZ,
  worldZToS,
} from '../src/game/config/highwayRunManifest.js';
import {
  HighwayTrafficSystem,
  LEASE_IDLE,
  LEASE_TRAFFIC,
} from '../src/game/systems/HighwayTrafficSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import { advanceSemiTrailerYaw } from '../src/game/vehicles/HighwaySemiRig.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

// ── 1. Speed helpers + window size ──────────────────────────────────────────

{
  assert.equal(FLOW_SPEED, 22);
  assert.equal(cruiseSpeedForDSpeed(0), 22);
  assert.equal(cruiseSpeedForDSpeed(-2), 20);
  assert.equal(cruiseSpeedForDSpeed(3), 25);
  assert.equal(cruiseSpeedForDSpeed(-100), 0); // floored
  const v0 = cruiseWorldVelocity(0);
  assert.deepEqual(v0, { x: 0, y: 0, z: -FLOW_SPEED });
  const vNeg = cruiseWorldVelocity(-2);
  assert.equal(vNeg.z, -20);
  // Catch-up headroom: front window must be generous vs tile length.
  assert.ok(WINDOW_FRONT >= 400, `WINDOW_FRONT ${WINDOW_FRONT} should be ≥ 400`);
  assert.ok(WINDOW_BACK >= 160, `WINDOW_BACK ${WINDOW_BACK} should be ≥ 160`);
  assert.ok(WINDOW_FRONT > WINDOW_BACK);
  ok('FLOW_SPEED helpers and wider window');
}

// ── 2. Manifest variety ─────────────────────────────────────────────────────

{
  assert.ok(runPlatforms.length >= 10, 'denser tile packing');
  const speeds = new Set(runPlatforms.map((p) => p.dSpeed ?? 0));
  assert.ok(speeds.size >= 3, 'mixed dSpeeds in runPlatforms');
  assert.ok(speeds.has(0), 'includes flow-matched cars');
  assert.ok([...speeds].some((d) => d < 0), 'includes catch-up (negative dSpeed)');
  assert.ok([...speeds].some((d) => d > 0), 'includes pull-ahead (positive dSpeed)');

  const slots = resolveWindowSlots({
    focusS: 50,
    seed: DEFAULT_HIGHWAY_SEED,
    windowFront: WINDOW_FRONT,
    windowBack: WINDOW_BACK,
  });
  assert.ok(slots.length > 0);
  const slotSpeeds = new Set(slots.map((s) => s.dSpeed));
  assert.ok(slotSpeeds.size >= 2, 'resolved slots carry varied dSpeed');
  for (const slot of slots) {
    assert.ok(Number.isFinite(slot.dSpeed));
    assert.equal(cruiseSpeedForDSpeed(slot.dSpeed), FLOW_SPEED + slot.dSpeed);
  }
  ok('manifest variety and resolved dSpeeds');
}

// ── 3–5. Place / release / claim cruise lifecycle ───────────────────────────

{
  let nextId = 1;
  const recoverCalls = [];
  const parkCalls = [];
  const linvelCalls = [];

  function makeFakeVehicle(name) {
    const vehicle = {
      id: `v-${nextId++}`,
      name,
      status: 'ready',
      bodyHandle: nextId,
      group: new THREE.Group(),
      spawnPosition: new THREE.Vector3(),
      linearVelocity: new THREE.Vector3(),
      speed: 0,
      parkedMode: true,
      _parkedPose: {},
      highwayCruise: null,
      hasDriver: () => false,
      getGroundSpawnClearance: () => 0.9,
      recover({ position, rotationY }) {
        recoverCalls.push({ vehicle, position: { ...position }, rotationY });
        vehicle.group.position.set(position.x, position.y, position.z);
        vehicle.speed = 0;
        vehicle.linearVelocity.set(0, 0, 0);
        return true;
      },
      park() {
        parkCalls.push(vehicle);
        vehicle.parkedMode = true;
        vehicle.highwayCruise = null;
      },
      computeHighwayCruiseControls() {
        return BaseVehicle.prototype.computeHighwayCruiseControls.call(vehicle);
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
    async spawnVehicle({ vehicle } = {}) {
      const name = vehicle?.name ?? 'Highway Traffic';
      const v = makeFakeVehicle(name);
      vehicles.push(v);
      return v;
    },
  };

  const physics = {
    world: {},
    getFreshBody(handle) {
      return {
        handle,
        setLinvel(v) {
          linvelCalls.push({ ...v });
        },
        setAngvel() {},
        wakeUp() {},
      };
    },
  };

  const traffic = new HighwayTrafficSystem({
    physics,
    vehicleSystem,
    seed: DEFAULT_HIGHWAY_SEED,
    windowFront: WINDOW_FRONT,
    windowBack: WINDOW_BACK,
  });

  await traffic.initialize({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(50) },
  });

  assert.ok(traffic.liveBySlot.size > 0, 'live traffic after init');
  const snap = traffic.snapshot();
  assert.ok(snap.cruisingLeases > 0, 'snapshot reports cruising leases');
  assert.equal(snap.cruisingLeases, snap.liveLeases);

  // Every live lease must have highwayCruise and must NOT have been parked after place.
  let liveWithCruise = 0;
  for (const lease of traffic.liveBySlot.values()) {
    assert.equal(lease.state, LEASE_TRAFFIC);
    assert.ok(lease.vehicle.highwayCruise, 'live car has highwayCruise');
    assert.equal(lease.vehicle.parkedMode, false, 'live car is not parked');
    const expectedSpeed = lease.archetype === 'semi'
      ? 18 + (lease.dSpeed ?? 0)
      : cruiseSpeedForDSpeed(lease.dSpeed ?? 0);
    assert.ok(Math.abs(lease.vehicle.highwayCruise.targetSpeed - expectedSpeed) < 1e-6);
    assert.ok(Number.isFinite(lease.vehicle.highwayCruise.laneX));
    liveWithCruise += 1;
  }
  assert.ok(liveWithCruise > 0);
  assert.ok(linvelCalls.length > 0, 'seeded linvel on place');
  assert.ok(linvelCalls.some((v) => v.z < -10), 'seeded velocity along −Z near flow');

  // 4. Release one lease → cruise cleared + parked off-ribbon
  const firstLease = traffic.liveBySlot.values().next().value;
  const releasedVehicle = firstLease.vehicle;
  traffic._releaseLease(firstLease);
  assert.equal(releasedVehicle.highwayCruise, null);
  assert.equal(releasedVehicle.parkedMode, true);
  assert.equal(releasedVehicle.group.visible, false);
  assert.ok(!isInsideRoad(releasedVehicle.group.position, 2));
  assert.ok(parkCalls.includes(releasedVehicle));
  ok('place sets cruise; release clears cruise and parks');

  // Re-init a clean system for claim check
  const traffic2 = new HighwayTrafficSystem({
    physics,
    vehicleSystem: {
      ...vehicleSystem,
      vehicles: [],
      async spawnVehicle({ vehicle } = {}) {
        const v = makeFakeVehicle(vehicle?.name ?? 't');
        vehicleSystem.vehicles.push(v);
        return v;
      },
    },
    seed: DEFAULT_HIGHWAY_SEED,
  });
  await traffic2.initialize({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(80) },
  });
  const claimTarget = traffic2.liveBySlot.values().next().value?.vehicle;
  assert.ok(claimTarget?.highwayCruise);
  traffic2.claimVehicleForPlayer(claimTarget);
  assert.equal(claimTarget.highwayCruise, null, 'claim clears cruise');
  assert.equal(traffic2.isPoolMember(claimTarget), false);
  assert.equal(traffic2.isTrafficLease(claimTarget), false);
  ok('claimVehicleForPlayer clears cruise and removes from pool');
}

// ── 6. computeHighwayCruiseControls ─────────────────────────────────────────

{
  const v = new BaseVehicle({
    name: 'Cruise Test',
    position: new THREE.Vector3(0, HIGHWAY_Y, 0),
    rotationY: 0,
  });
  // Minimal group (constructor already builds mesh async in real path — set directly).
  if (!v.group) {
    v.group = new THREE.Group();
    v.group.position.set(laneXForTest(1), HIGHWAY_Y, 0);
    v.group.rotation.y = 0;
  } else {
    v.group.position.set(0, HIGHWAY_Y, 0);
    v.group.rotation.y = 0;
  }
  v.speed = 10;
  v.linearVelocity = new THREE.Vector3(0, 0, -10);
  v.highwayCruise = {
    targetSpeed: FLOW_SPEED,
    laneX: 0,
    dSpeed: 0,
  };

  const controls = v.computeHighwayCruiseControls();
  assert.ok(controls.throttle > 0.1, 'below target → throttle');
  assert.ok(controls.brake === 0 || controls.brake < 0.1);

  v.speed = 40;
  v.linearVelocity.set(0, 0, -40);
  const over = v.computeHighwayCruiseControls();
  assert.ok(over.throttle < 0.2, 'above target → low throttle');
  assert.ok(over.brake > 0, 'above target → brake');

  // Lane correction: car right of lane wants left steer (negative in our convention?)
  v.group.position.x = 4;
  v.highwayCruise.laneX = 0;
  v.speed = FLOW_SPEED;
  v.linearVelocity.set(0, 0, -FLOW_SPEED);
  const lane = v.computeHighwayCruiseControls();
  assert.ok(Math.abs(lane.steer) > 0.01, 'off-lane produces steer');
  ok('computeHighwayCruiseControls throttle/brake/steer');
}

function laneXForTest(lane) {
  // Avoid importing LANES for one call — BaseVehicle test uses 0.
  return lane * 3.5;
}

// ── 7. Co-moving recycle: car near focus stays live after focus advances a little ─

{
  let nextId = 1;
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
      _parkedPose: {},
      highwayCruise: null,
      hasDriver: () => false,
      getGroundSpawnClearance: () => 0.9,
      recover({ position }) {
        vehicle.group.position.set(position.x, position.y, position.z);
        return true;
      },
      park() {
        vehicle.parkedMode = true;
        vehicle.highwayCruise = null;
      },
    };
    return vehicle;
  }

  const vehicleSystem = {
    vehicles: [],
    activeVehicle: null,
    level: {
      getGroundHeightAt: (pos) => (isInsideRoad(pos, 0) ? HIGHWAY_Y : -Infinity),
    },
    async spawnVehicle({ vehicle } = {}) {
      const v = makeFakeVehicle(vehicle?.name ?? 't');
      vehicleSystem.vehicles.push(v);
      return v;
    },
  };
  const physics = {
    world: {},
    getFreshBody() {
      return {
        setLinvel() {},
        setAngvel() {},
        wakeUp() {},
      };
    },
  };

  const traffic = new HighwayTrafficSystem({
    physics,
    vehicleSystem,
    seed: DEFAULT_HIGHWAY_SEED,
  });

  const focus0 = 100;
  await traffic.initialize({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(focus0) },
  });
  const live0 = traffic.liveBySlot.size;
  assert.ok(live0 > 0);

  // Simulate co-moving: advance every live car by +ds along s, and advance focus by same.
  const ds = 40;
  for (const lease of traffic.liveBySlot.values()) {
    const p = lease.vehicle.group.position;
    const s = worldZToS(p);
    p.z = sToWorldZ(s + ds);
  }
  const result = traffic.updateWindow({
    focusPosition: { x: 0, y: HIGHWAY_Y, z: sToWorldZ(focus0 + ds) },
  });
  // Co-moving cars should largely remain (not mass-released).
  assert.ok(
    traffic.liveBySlot.size >= Math.max(1, live0 - 2),
    `co-moving keep live: before ${live0} after ${traffic.liveBySlot.size} (released ${result.released})`,
  );
  // Pool size never grows past init.
  assert.equal(
    vehicleSystem.vehicles.length,
    totalTrafficPoolSize({ windowFront: WINDOW_FRONT, windowBack: WINDOW_BACK }),
  );
  ok('co-moving recycle keeps convoy cars live');
}

// ── 8. Idle still parked; cruise controller unparks via throttle ────────────

{
  const v = Object.assign(new BaseVehicle({ name: 'x', position: new THREE.Vector3() }), {});
  if (!v.group) v.group = new THREE.Group();
  v.group.position.set(0, 0, 0);
  v.group.rotation.y = 0;
  v.speed = 0;
  v.linearVelocity = new THREE.Vector3();
  v.highwayCruise = { targetSpeed: FLOW_SPEED, laneX: 0, dSpeed: 0 };
  const c = v.computeHighwayCruiseControls();
  // vehicleControlsRequestUnpark needs throttle — cruise always requests some.
  assert.ok(Math.abs(c.throttle) > 0.001, 'cruise throttle unparks chassis');
  ok('cruise controls request unpark');
}

// ── 9. Semi speed, lease matching, and articulated yaw ──────────────────────

{
  const traffic = new HighwayTrafficSystem();
  traffic._focusSpeedS = 90;
  assert.equal(traffic._cruiseTargetSpeed(-1, 'semi'), 17);
  assert.equal(traffic._cruiseTargetSpeed(0, 'semi'), 18);
  assert.equal(traffic._cruiseTargetSpeed(3, 'semi'), 20, 'semi speed remains capped');
  assert.ok(traffic._cruiseTargetSpeed(0, 'sedan') > 40, 'sedan catch-up remains enabled');

  const semi = {
    archetype: 'semi',
    vehicle: {
      group: { position: { z: sToWorldZ(100) } },
      highwayCruise: { laneX: 3.5 },
    },
  };
  const sedan = {
    archetype: 'sedan',
    vehicle: {
      group: { position: { z: sToWorldZ(101) } },
      highwayCruise: { laneX: 3.5 },
    },
  };
  traffic.liveBySlot.set('semi', semi);
  traffic.liveBySlot.set('sedan', sedan);
  assert.equal(
    traffic._findLiveNearS(100, 10, null, { archetype: 'semi', laneX: 3.5 }),
    semi,
  );
  assert.equal(
    traffic._findLiveNearS(100, 10, null, { archetype: 'semi', laneX: -3.5 }),
    null,
    'semi cannot be rebound across lanes',
  );

  const firstYaw = advanceSemiTrailerYaw(0, 0.2, 1 / 60);
  assert.ok(firstYaw > 0 && firstYaw < 0.2, 'trailer yaw follows instead of snapping');
  assert.ok(firstYaw <= 0.42 / 60 + 1e-9, 'trailer yaw rate is bounded');
  let yaw = 0;
  for (let i = 0; i < 180; i += 1) {
    yaw = advanceSemiTrailerYaw(yaw, 0.2, 1 / 60);
  }
  assert.ok(Math.abs(yaw - 0.2) < 0.001, 'trailer yaw converges to cab heading');
  ok('semi cruise cap, stable lane matching, and articulated trailer yaw');
}

console.log(`\nAll ${passed} highway-convoy checks passed.`);
