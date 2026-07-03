// Headless regression for collision detection, state/limp, and deformation.
// Run: node scripts/verify-vehicle-collision-damage.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';
import { VehicleDamageSystem } from '../src/game/systems/VehicleDamageSystem.js';
import { applyCrumple } from '../src/game/vehicles/vehicleDeformation.js';

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
const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
world.timestep = DT;
const physics = { RAPIER, world, getFreshBody: (handle) => world.bodies.get(handle) };
const scene = new THREE.Scene();
const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1, 0));
world.createCollider(RAPIER.ColliderDesc.cuboid(5, 3, 0.25), wallBody);

const vehicle = new BaseVehicle({
  chassisOverlay: false,
  position: new THREE.Vector3(0, 1, 8),
  config: {
    damping: { linear: 0, angular: 0 },
    ground: { useRayCastController: false, wheelColliders: false },
  },
});
vehicle._ensureEngineAudio = async () => {};
await vehicle.spawn({ scene, physics });
// A synthetic overlay exercises the browser-only GLB bumper path without loading
// assets in Node.
const syntheticOverlay = new THREE.Group();
const syntheticShell = new THREE.Mesh(
  new THREE.BoxGeometry(2, 0.5, 6, 2, 1, 8),
  new THREE.MeshStandardMaterial(),
);
syntheticShell.name = 'tripo_part_0';
syntheticOverlay.add(syntheticShell);
vehicle.chassisSocket.add(syntheticOverlay);
vehicle.chassisOverlay = syntheticOverlay;
const body = physics.getFreshBody(vehicle.bodyHandle);
body.setLinvel({ x: 0, y: 0, z: -15 }, true);
const neutral = makeNeutralControls();
const damageSystem = new VehicleDamageSystem();
damageSystem.initialize({ physics, scene });

for (let frame = 0; frame < 90 && !vehicle.damage?.impactCount; frame += 1) {
  vehicle.update({ dt: DT, controls: neutral, physics });
  damageSystem.update({ delta: DT, vehicles: [vehicle] });
  world.step();
}

assert.equal(vehicle.damage?.impactCount, 1, 'wall collision should register once');
assert.equal(vehicle.damage.lastImpact.zone, 'front');
assert.ok(
  ['crumple', 'severe'].includes(vehicle.damage.lastImpact.tier),
  `15 m/s wall impact should crumple (got ${JSON.stringify(vehicle.damage.lastImpact)})`,
);
assert.ok(vehicle.damage.engineHealth < 1, 'front impact should damage the engine');
assert.ok(vehicle.enginePowerScale < 1, 'engine damage should reduce drive power');
assert.ok(vehicle.maxSpeedScale < 1, 'engine damage should reduce max speed');
assert.equal(vehicle.damage.bumpers.front, 'dangling', 'severe front hit should detach the overlay bumper');
assert.equal(damageSystem.detachedBumpers.length, 1);
for (let frame = 0; frame < 30; frame += 1) {
  vehicle.update({ dt: DT, controls: neutral, physics });
  damageSystem.update({ delta: DT, vehicles: [vehicle] });
  world.step();
}
assert.equal(vehicle.damage.impactCount, 1, 'cooldown should suppress multi-frame contact repeats');
damageSystem.applyImpact(vehicle, vehicle.damage.lastImpact);
assert.equal(vehicle.damage.bumpers.front, 'gone', 'a second hit should break the dangling joint');
assert.equal(damageSystem.repair(vehicle), true);
assert.equal(vehicle.damage.engineHealth, 1, 'repair should restore engine health');
assert.equal(vehicle.damage.bumpers.front, 'intact', 'repair should restore bumper state');
assert.equal(damageSystem.detachedBumpers.length, 0, 'repair should remove detached bumper physics');

// A landing-dominated discontinuity must not enqueue body damage.
vehicle.pendingDamageImpacts.length = 0;
vehicle._damageImpactCooldown = 0;
vehicle._hasDamageVelocity = true;
vehicle._previousDamageVelocity.set(0, -12, 0);
vehicle.linearVelocity.set(3.2, 0, 0);
vehicle._detectCollisionImpact({ rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }) }, DT);
assert.equal(vehicle.pendingDamageImpacts.length, 0, 'hard landing should be rejected');

// Pure deformation: near vertices move, distant vertices do not, repeated hits
// saturate at the configured world-space maximum.
const geometry = new THREE.BoxGeometry(2, 1, 1, 4, 2, 2);
const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
scene.add(mesh);
mesh.updateMatrixWorld(true);
const original = new Float32Array(geometry.getAttribute('position').array);
for (let hit = 0; hit < 8; hit += 1) {
  applyCrumple(mesh, {
    point: new THREE.Vector3(0, 0, -0.5),
    dir: new THREE.Vector3(0, 0, 1),
    radius: 1.2,
    depth: 0.12,
    bendUp: 0.25,
    noise: 0.1,
    maxDepth: 0.3,
  });
}
const positions = mesh.geometry.getAttribute('position');
let maxOffset = 0;
let moved = 0;
for (let index = 0; index < positions.count; index += 1) {
  const dx = positions.getX(index) - original[index * 3];
  const dy = positions.getY(index) - original[index * 3 + 1];
  const dz = positions.getZ(index) - original[index * 3 + 2];
  const offset = Math.hypot(dx, dy, dz);
  if (offset > 1e-5) moved += 1;
  maxOffset = Math.max(maxOffset, offset);
}
assert.ok(moved > 0, 'crumple kernel should move nearby vertices');
assert.ok(maxOffset <= 0.3001, `crumple offset should saturate (got ${maxOffset})`);

damageSystem.dispose();
vehicle.dispose({ scene, physics });
mesh.geometry.dispose();
geometry.dispose();
mesh.material.dispose();
console.log('vehicle collision damage verification passed');
