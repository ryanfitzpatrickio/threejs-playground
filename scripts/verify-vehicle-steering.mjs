// Headless Rapier harness: closed-loop yaw-rate steering must hit minimum turn
// rates at crawl, city, and highway speeds on flat ground.
//
// Run: node scripts/verify-vehicle-steering.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BaseVehicle,
  computeRayCastSteerAngle,
  makeNeutralControls,
} from '../src/game/vehicles/BaseVehicle.js';

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const DT = 1 / 60;
const FRAMES = 120;

const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

await RAPIER.init();

function makePhysics(world) {
  return {
    RAPIER,
    world,
    getFreshBody: (handle) => world.bodies.get(handle),
  };
}

function makeFlatGround(world, topY = 0) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, topY - 2, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(60, 2, 60).setFriction(0.55).setRestitution(0),
    body,
  );
  return topY;
}

async function spawnVehicle(physics, scene, y = 0) {
  const vehicle = new BaseVehicle({
    position: new THREE.Vector3(0, y, 0),
    chassisOverlay: false,
  });
  vehicle.spawnPosition.y = y + vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  return vehicle;
}

function settle(vehicle, physics, world, frames = 90) {
  const controls = makeNeutralControls();
  for (let i = 0; i < frames; i += 1) {
    vehicle.update({ dt: DT, controls, physics });
    world.step();
  }
}

function measureYawRate({ vehicle, physics, world, speedFwd, steer = 1, frames = FRAMES }) {
  const body = physics.getFreshBody(vehicle.bodyHandle);
  const p = body.translation();
  body.setTranslation({ x: 0, y: Math.max(p.y, 0.7), z: 0 }, true);
  body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  const v = body.linvel();
  body.setLinvel({ x: 0, y: v.y, z: -Math.abs(speedFwd) }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  const controls = makeNeutralControls();
  controls.steer = steer;

  if (speedFwd > 0.5) {
    const settleControls = makeNeutralControls();
    for (let i = 0; i < 45; i += 1) {
      vehicle.update({ dt: DT, controls: settleControls, physics });
      world.step();
    }
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  let peak = 0;
  for (let i = 0; i < frames; i += 1) {
    vehicle.update({ dt: DT, controls, physics });
    world.step();
    const b = physics.getFreshBody(vehicle.bodyHandle);
    const av = b.angvel();
    peak = Math.max(peak, Math.abs(av.y));
  }
  return peak;
}

function measureStraightDrift({ vehicle, physics, world, speedFwd, frames = FRAMES }) {
  const body = physics.getFreshBody(vehicle.bodyHandle);
  const p = body.translation();
  body.setTranslation({ x: 0, y: Math.max(p.y, 0.7), z: 0 }, true);
  body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  body.setLinvel({ x: 0, y: body.linvel().y, z: -Math.abs(speedFwd) }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  const controls = makeNeutralControls();
  for (let i = 0; i < 60; i += 1) {
    vehicle.update({ dt: DT, controls, physics });
    world.step();
  }

  let peak = 0;
  for (let i = 0; i < frames; i += 1) {
    vehicle.update({ dt: DT, controls, physics });
    world.step();
    const av = physics.getFreshBody(vehicle.bodyHandle).angvel();
    peak = Math.max(peak, Math.abs(av.y));
  }
  return peak;
}

const scene = new THREE.Scene();
const world = new RAPIER.World(GRAVITY);
const physics = makePhysics(world);
makeFlatGround(world, 0);

const vehicle = await spawnVehicle(physics, scene, 0);
settle(vehicle, physics, world);

const thresholds = [
  { speed: 0, minYaw: 0.2, maxYaw: 0.6, label: 'standstill' },
  { speed: 5, minYaw: 0.3, maxYaw: 0.7, label: 'city (~5 m/s)' },
  { speed: 15, minYaw: 0.58, maxYaw: 0.9, label: 'mid (~15 m/s)' },
  { speed: 30, minYaw: 0.38, maxYaw: 0.65, label: 'highway (~30 m/s)' },
];

console.log('--- vehicle steering verify ---\n');

for (const { speed, minYaw, maxYaw, label } of thresholds) {
  settle(vehicle, physics, world, 30);
  const peak = measureYawRate({ vehicle, physics, world, speedFwd: speed, steer: 1 });
  const ok = peak >= minYaw && peak <= maxYaw;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}: peak |yawRate|=${peak.toFixed(3)} rad/s (${minYaw}–${maxYaw})`,
  );
  assert.ok(peak >= minYaw, `${label}: expected |yawRate| >= ${minYaw}, got ${peak}`);
  assert.ok(peak <= maxYaw, `${label}: expected |yawRate| <= ${maxYaw}, got ${peak}`);
}

const rc = vehicle.config.ground.rayCast;
const lowLock = Math.abs(computeRayCastSteerAngle(0, 1, rc));
const highwayLock = Math.abs(computeRayCastSteerAngle(32, 1, rc));
console.log(`\nphysical wheel lock: low=${lowLock.toFixed(3)} rad, highway=${highwayLock.toFixed(3)} rad`);
assert.ok(highwayLock < lowLock * 0.2, 'high-speed wheel lock must be less than one fifth low-speed lock');

settle(vehicle, physics, world, 30);
const drift = measureStraightDrift({ vehicle, physics, world, speedFwd: 15 });
console.log(`\nstraight drift at 15 m/s: peak |yawRate|=${drift.toFixed(3)} (max 0.08)`);
assert.ok(drift < 0.08, `straight-line drift too high: ${drift}`);

vehicle.dispose({ scene, physics });
console.log('\nAll steering checks passed.');
