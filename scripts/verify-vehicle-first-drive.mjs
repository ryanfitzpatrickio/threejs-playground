import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';

const DT = 1 / 60;
const context2d = new Proxy(function () {}, {
  get: (_target, property) => (property === 'data' ? new Uint8ClampedArray(4) : context2d),
  apply: () => context2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => context2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

await RAPIER.init({});
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const physics = {
  RAPIER,
  world,
  fixedStepPlanning: true,
  getFreshBody: (handle) => world.bodies.get(handle),
};
const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
world.createCollider(
  RAPIER.ColliderDesc.cuboid(50, 2, 50).setFriction(0.55).setRestitution(0),
  ground,
);

const vehicle = new BaseVehicle({
  position: new THREE.Vector3(),
  chassisOverlay: false,
});
vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
await vehicle.spawn({ scene: new THREE.Scene(), physics });

const neutral = makeNeutralControls();
for (let frame = 0; frame < 360; frame += 1) {
  vehicle.update({ dt: DT, controls: neutral, physics, integrate: false });
  vehicle.substepIntegrate({ dt: DT, physics });
  world.step();
}

const body = physics.getFreshBody(vehicle.bodyHandle);
assert.equal(body.isSleeping(), true, 'parked vehicle should be asleep before first input');
const startZ = body.translation().z;

const forward = makeNeutralControls();
forward.throttle = 1;
for (let frame = 0; frame < 60; frame += 1) {
  vehicle.update({ dt: DT, controls: forward, physics, integrate: false });
  vehicle.substepIntegrate({ dt: DT, physics });
  world.step();
}

assert.equal(body.isSleeping(), false, 'first forward input must wake the chassis');
assert.ok(body.translation().z < startZ - 0.5,
  `first forward input did not move the chassis: dz=${body.translation().z - startZ}`);

vehicle.dispose({ scene: null, physics });
console.log('vehicle first-drive wake regression passed');
