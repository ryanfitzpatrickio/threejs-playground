/**
 * Highway hijack M4 contract (pure node).
 *
 * Guards:
 *   1. transferPlayerTo swaps activeVehicle pointer; old released, new driven.
 *   2. getHijackCandidate requires free stance + hijackable platform owner.
 *   3. tryHijack consumes ability/F and claims traffic pool vehicle.
 *   4. claimVehicleForPlayer removes lease from traffic pool.
 *
 * Run: node scripts/verify-highway-hijack.mjs
 * Alias: npm run verify:highway-hijack
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createVehicleConfig } from '../src/game/config/vehicleConfig.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import {
  HighwayTrafficSystem,
  LEASE_PLAYER,
  LEASE_TRAFFIC,
} from '../src/game/systems/HighwayTrafficSystem.js';
import { PlatformRidingSystem } from '../src/game/systems/PlatformRidingSystem.js';

let passed = 0;
const ok = (message) => {
  passed += 1;
  console.log(`  ✓ ${message}`);
};

function makeStubVehicle(name, { bodyHandle = 1 } = {}) {
  const vehicle = new BaseVehicle({
    name,
    position: new THREE.Vector3(),
    model: new THREE.Group(),
    chassisOverlay: false,
  });
  vehicle.config = createVehicleConfig();
  vehicle.occupants = new Array(vehicle.config.seats.length).fill(null);
  vehicle.group = new THREE.Group();
  vehicle.status = 'ready';
  vehicle.bodyHandle = bodyHandle;
  vehicle.speed = 14;
  vehicle.wakeForDrive = () => {};
  vehicle.onEnter = () => {};
  vehicle.onExit = () => {};
  vehicle.park = () => {};
  vehicle.getSeatWorldTransform = (seatIndex, outPos, outQuat) => {
    const seat = vehicle.config.seats[seatIndex];
    outPos.set(...(seat?.offset ?? [0, 0.4, 0]));
    outQuat.identity();
    return outPos;
  };
  vehicle.getExitWorldPosition = (out) => out.set(-2, 0, 0);
  vehicle.getSeatHandTargets = () => null;
  vehicle.getSeatFootTargets = () => null;
  return vehicle;
}

function makeCharacter() {
  return {
    group: new THREE.Group(),
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    vehicle: null,
    platformSupport: null,
    carLeap: null,
    animationController: { play() {} },
  };
}

// ── 1. transferPlayerTo ─────────────────────────────────────────────────────

{
  const system = new VehicleSystem();
  system.status = 'ready';
  system.physics = { world: {}, getFreshBody: () => null };
  system.scene = new THREE.Scene();

  const carA = makeStubVehicle('Player Car', { bodyHandle: 10 });
  const carB = makeStubVehicle('Traffic Sedan', { bodyHandle: 20 });
  system.registerVehicle(carA);
  system.registerVehicle(carB);

  const character = makeCharacter();
  system._enter({ character, vehicle: carA });
  assert.equal(system.activeVehicle, carA);
  assert.equal(character.vehicle.vehicle, carA);

  const okTransfer = system.transferPlayerTo(character, carB, {
    fromSeat: 'roof',
    toSeat: 'driver',
    animate: false,
  });
  assert.equal(okTransfer, true);
  assert.equal(system.activeVehicle, carB, 'activeVehicle points at new car');
  assert.equal(character.vehicle.vehicle, carB);
  assert.equal(character.vehicle.active, true);
  assert.equal(carB.config.seats[character.vehicle.seatIndex].name, 'driver');
  assert.equal(carA.occupants.every((o) => o == null), true, 'old car unoccupied');
  assert.equal(carB.hasDriver(), true);
  ok('transferPlayerTo swaps player-vehicle pointer');
}

// ── 2. getHijackCandidate ───────────────────────────────────────────────────

{
  const system = new VehicleSystem();
  system.status = 'ready';
  const platforms = new PlatformRidingSystem();
  platforms.status = 'ready';
  platforms.physics = { getFreshBody: () => null };

  const traffic = makeStubVehicle('Hijackable', { bodyHandle: 42 });
  platforms.register(42, {
    owner: traffic,
    localCenter: { x: 0, y: 0, z: 0 },
    halfExtents: { x: 1, y: 0.1, z: 2 },
    surfaceY: 0.5,
    kind: 'vehicleRoof',
    hijackable: true,
  });

  const character = makeCharacter();
  character.platformSupport = { bodyHandle: 42, localContact: { x: 0, y: 0.5, z: 0 } };

  assert.equal(system.getHijackCandidate(character, platforms), traffic);

  character.vehicle = { active: true };
  assert.equal(system.getHijackCandidate(character, platforms), null, 'no hijack while seated');

  character.vehicle = null;
  platforms.platforms.get(42).hijackable = false;
  assert.equal(system.getHijackCandidate(character, platforms), null, 'requires hijackable');
  ok('getHijackCandidate requires free stance + hijackable roof');
}

// ── 3–4. tryHijack + traffic claim ──────────────────────────────────────────

{
  const system = new VehicleSystem();
  system.status = 'ready';
  system.physics = { world: {}, getFreshBody: () => null };
  system.scene = new THREE.Scene();

  const traffic = makeStubVehicle('Pool Car', { bodyHandle: 7 });
  system.registerVehicle(traffic);

  const platforms = new PlatformRidingSystem();
  platforms.status = 'ready';
  platforms.register(7, {
    owner: traffic,
    localCenter: { x: 0, y: 0, z: 0 },
    halfExtents: { x: 1, y: 0.1, z: 2 },
    surfaceY: 0.5,
    kind: 'vehicleRoof',
    hijackable: true,
  });

  // Minimal traffic system with a live lease on this vehicle.
  const trafficSystem = new HighwayTrafficSystem({
    physics: { world: {} },
    vehicleSystem: system,
    platformRiding: platforms,
  });
  trafficSystem.status = 'ready';
  trafficSystem.pools.set('sedan', [{
    state: LEASE_TRAFFIC,
    slotId: '0:0',
    archetype: 'sedan',
    vehicle: traffic,
    colorIndex: 0,
    poolIndex: 0,
  }]);
  trafficSystem.liveBySlot.set('0:0', trafficSystem.pools.get('sedan')[0]);

  const character = makeCharacter();
  character.platformSupport = { bodyHandle: 7 };

  const result = system.tryHijack({
    character,
    input: { abilityPressed: true },
    platforms,
    trafficSystem,
  });

  assert.equal(result.hijacked, true);
  assert.equal(result.input.abilityPressed, false, 'F/ability consumed');
  assert.equal(system.activeVehicle, traffic);
  assert.equal(character.vehicle?.vehicle, traffic);
  assert.equal(trafficSystem.liveBySlot.has('0:0'), false, 'lease removed');
  assert.equal(trafficSystem.pools.get('sedan').length, 0, 'removed from pool');
  // claim marks LEASE_PLAYER on the lease object before filter — vehicle is gone from pool
  ok('tryHijack consumes F and claims traffic vehicle');
}

// ── claimVehicleForPlayer unit ──────────────────────────────────────────────

{
  const trafficSystem = new HighwayTrafficSystem({
    physics: { world: {} },
    vehicleSystem: {},
  });
  trafficSystem.status = 'ready';
  const v = { id: 'x' };
  const lease = {
    state: LEASE_TRAFFIC,
    slotId: '1:2',
    vehicle: v,
    archetype: 'sedan',
    poolIndex: 0,
  };
  trafficSystem.pools.set('sedan', [lease, {
    state: 'idle',
    slotId: null,
    vehicle: { id: 'other' },
    archetype: 'sedan',
    poolIndex: 1,
  }]);
  trafficSystem.liveBySlot.set('1:2', lease);
  trafficSystem.claimVehicleForPlayer(v);
  assert.equal(lease.state, LEASE_PLAYER);
  assert.equal(trafficSystem.liveBySlot.has('1:2'), false);
  assert.equal(trafficSystem.pools.get('sedan').length, 1);
  assert.equal(trafficSystem.pools.get('sedan')[0].vehicle.id, 'other');
  ok('claimVehicleForPlayer strips lease and pool membership');
}

console.log(`\nAll ${passed} highway-hijack checks passed.`);
