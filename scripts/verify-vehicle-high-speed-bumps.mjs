// A/B the previous and current raycast suspension over repeated short bumps.
// Run: node scripts/verify-vehicle-high-speed-bumps.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';

const ctx = new Proxy(function () {}, {
  get: (_target, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : ctx),
  apply: () => ctx,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

await RAPIER.init();
const DT = 1 / 60;

function addTrack(world) {
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, -50));
  world.createCollider(RAPIER.ColliderDesc.cuboid(20, 1, 80).setFriction(0.7), ground);
  for (let z = -12; z >= -92; z -= 10) {
    const bump = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0.1, z));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(20, 0.1, 0.65).setFriction(0.7).setRestitution(0),
      bump,
    );
  }
}

async function run(label, rayCast) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  addTrack(world);
  const physics = { RAPIER, world, getFreshBody: (handle) => world.bodies.get(handle) };
  const scene = new THREE.Scene();
  const vehicle = new BaseVehicle({
    position: new THREE.Vector3(0, 0, 0),
    chassisOverlay: false,
    config: { ground: { rayCast } },
  });
  vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  const neutral = makeNeutralControls();
  for (let i = 0; i < 90; i += 1) {
    vehicle.update({ dt: DT, controls: neutral, physics });
    world.step();
  }

  const body = physics.getFreshBody(vehicle.bodyHandle);
  body.setLinvel({ x: 0, y: 0, z: -35 }, true);
  let maxUpSpeed = 0;
  let maxTiltRate = 0;
  let contactSum = 0;
  let samples = 0;
  for (let i = 0; i < 150; i += 1) {
    vehicle.update({ dt: DT, controls: neutral, physics });
    world.step();
    const v = body.linvel();
    const a = body.angvel();
    maxUpSpeed = Math.max(maxUpSpeed, Math.max(0, v.y));
    maxTiltRate = Math.max(maxTiltRate, Math.hypot(a.x, a.z));
    contactSum += vehicle.groundedFraction;
    samples += 1;
  }
  vehicle.dispose({ scene, physics });
  return {
    label,
    maxUpSpeed,
    maxTiltRate,
    contact: contactSum / samples,
  };
}

const previous = await run('previous', {
  connectionHeight: -0.1,
  suspensionRestLength: 0.3,
  suspensionStiffness: 28,
  suspensionCompression: 8,
  suspensionRelaxation: 10,
  maxSuspensionTravel: 0.3,
  settleSag: 0.13,
});
const current = await run('current', {});

for (const result of [previous, current]) {
  console.log(
    `${result.label.padEnd(8)} maxUp=${result.maxUpSpeed.toFixed(3)}m/s `
    + `maxTilt=${result.maxTiltRate.toFixed(3)}rad/s contact=${result.contact.toFixed(3)}`,
  );
}

assert.ok(
  current.maxUpSpeed < previous.maxUpSpeed * 0.1,
  `expected at least 90% less bump launch (${current.maxUpSpeed} vs ${previous.maxUpSpeed})`,
);
assert.ok(
  current.maxTiltRate < previous.maxTiltRate * 0.4,
  `expected at least 60% less bump tilt (${current.maxTiltRate} vs ${previous.maxTiltRate})`,
);
assert.ok(current.contact > 0.95, `expected tyres to retain contact, got ${current.contact}`);
console.log('High-speed bump checks passed.');
