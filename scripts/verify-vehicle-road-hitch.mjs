// Regression for the high-speed "invisible wall" road hitch.
//
// The raycast wheels must own ordinary road contact. If the rigid chassis floor
// reaches a shallow collision seam while CCD is active, the seam removes forward
// velocity in one step and pitches the car over its nose. This test drives at the
// 150 mph cap across repeated, narrow 0.32 m collision ridges. They are deliberately
// harsher than a real heightfield/deck seam so the old full-body collider is a
// sensitive control while the raised crash envelope crosses without a rigid hit.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import { GROUND_VEHICLE_MAX_SPEED_MS } from '../src/game/config/vehicleConfig.js';

await RAPIER.init();

const DT = 1 / 60;
const RIDGE_HEIGHT = 0.32;
const neutral = { throttle: 0, steer: 0, brake: 0, handbrake: false, boost: false };

function addFixedBox(world, x, y, z, hx, hy, hz) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setFriction(0.8)
      .setRestitution(0),
    body,
  );
}

async function run(rayCastOverride = {}) {
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 });
  physics.world.timestep = DT;
  physics.world.numSolverIterations = 8;
  addFixedBox(physics.world, 0, -0.5, 0, 12, 0.5, 400);
  for (let z = 150; z >= -150; z -= 20) {
    addFixedBox(physics.world, 0, RIDGE_HEIGHT * 0.5, z, 12, RIDGE_HEIGHT * 0.5, 0.025);
  }
  // A real obstacle after the seam course proves the raised envelope is still a
  // solid crash collider; it is clearance, not disabled collision.
  addFixedBox(physics.world, 0, 2.5, -225, 12, 2.5, 0.25);

  const vehicle = new BaseVehicle({
    position: new THREE.Vector3(0, 0.9, 175),
    model: new THREE.Group(),
    chassisOverlay: false,
    config: { ground: { rayCast: rayCastOverride } },
  });
  await vehicle.spawn({ scene: new THREE.Scene(), physics });
  // Keep this physics-only harness independent of WebAudio/window availability.
  vehicle.engineAudio = { resume() {}, update() {}, dispose() {} };
  const body = physics.getFreshBody(vehicle.bodyHandle);

  for (let i = 0; i < 90; i += 1) {
    vehicle.update({ dt: DT, controls: neutral, physics });
    physics.world.step();
  }
  body.setLinvel({ x: 0, y: 0, z: -GROUND_VEHICLE_MAX_SPEED_MS }, true);

  let minHorizontalSpeed = Infinity;
  let maxSpeedLossInStep = 0;
  let maxPitch = 0;
  let previousSpeed = GROUND_VEHICLE_MAX_SPEED_MS;
  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();
  // Measure only the ridge course. A fixed frame count accidentally included the
  // real wall after the production speed cap was raised from 150 to 200 mph,
  // making the expected wall stop look like a seam regression.
  for (let i = 0; i < 600 && body.translation().z > -170; i += 1) {
    vehicle.update({ dt: DT, controls: { ...neutral, throttle: 1 }, physics });
    physics.world.step();
    const velocity = body.linvel();
    const speed = Math.hypot(velocity.x, velocity.z);
    minHorizontalSpeed = Math.min(minHorizontalSpeed, speed);
    maxSpeedLossInStep = Math.max(maxSpeedLossInStep, previousSpeed - speed);
    previousSpeed = speed;
    const rotation = body.rotation();
    quat.set(rotation.x, rotation.y, rotation.z, rotation.w);
    euler.setFromQuaternion(quat, 'YXZ');
    maxPitch = Math.max(maxPitch, Math.abs(euler.x));
  }
  const finalZ = body.translation().z;
  for (let i = 0; i < 180; i += 1) {
    vehicle.update({ dt: DT, controls: { ...neutral, throttle: 1 }, physics });
    physics.world.step();
  }
  return {
    minHorizontalSpeed,
    maxSpeedLossInStep,
    maxPitchDegrees: THREE.MathUtils.radToDeg(maxPitch),
    finalZ,
    wallFinalZ: body.translation().z,
    wallFinalSpeed: Math.hypot(body.linvel().x, body.linvel().z),
  };
}

const raised = await run(); // production defaults
const oldFullBody = await run({
  // BaseVehicle's generated-frame defaults bake a 2.2 x 1.0 x 6.0 body into the
  // config before spawn; this was the old rigid collision envelope.
  chassisColliderSize: [2.2, 1.0, 6.0],
  chassisColliderOffset: [0, 0, 0],
});

assert.ok(raised.finalZ < -150, `raised collider did not finish the seam course (z=${raised.finalZ.toFixed(1)})`);
assert.ok(raised.minHorizontalSpeed > 60,
  `raised collider lost highway speed on a seam (min=${raised.minHorizontalSpeed.toFixed(1)}m/s)`);
assert.ok(raised.maxSpeedLossInStep < 2,
  `raised collider still has an instant collision stop (one-step loss=${raised.maxSpeedLossInStep.toFixed(1)}m/s)`);
assert.ok(raised.maxPitchDegrees < 6,
  `raised collider still pitches forward on seams (${raised.maxPitchDegrees.toFixed(1)}deg)`);
assert.ok(raised.wallFinalZ > -225.5,
  `raised crash envelope tunneled through the real wall (z=${raised.wallFinalZ.toFixed(1)})`);
assert.ok(raised.wallFinalSpeed < 2,
  `raised crash envelope did not stop at the real wall (${raised.wallFinalSpeed.toFixed(1)}m/s)`);
assert.ok(oldFullBody.minHorizontalSpeed < raised.minHorizontalSpeed - 20,
  'full-body sensitivity control did not reproduce a materially worse seam hitch');

console.log('vehicle road-hitch regression passed');
console.log(`  raised crash envelope: min=${raised.minHorizontalSpeed.toFixed(1)}m/s stepLoss=${raised.maxSpeedLossInStep.toFixed(2)}m/s pitch=${raised.maxPitchDegrees.toFixed(2)}deg finalZ=${raised.finalZ.toFixed(1)}`);
console.log(`  real wall containment: finalZ=${raised.wallFinalZ.toFixed(1)} speed=${raised.wallFinalSpeed.toFixed(2)}m/s`);
console.log(`  old full-body control: min=${oldFullBody.minHorizontalSpeed.toFixed(1)}m/s stepLoss=${oldFullBody.maxSpeedLossInStep.toFixed(2)}m/s pitch=${oldFullBody.maxPitchDegrees.toFixed(2)}deg finalZ=${oldFullBody.finalZ.toFixed(1)}`);
