// Record normalized controls by fixed tick, replay them from the same initial
// state, and require the final chassis transform to match within 1 mm.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsSystem, VEHICLE_PHYSICS_FIXED_STEP } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

await RAPIER.init();

async function createRun() {
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 });
  physics.world.numSolverIterations = 8;
  physics.world.numInternalPgsIterations = 2;
  const floor = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(100, 0.5, 1000).setTranslation(0, -0.5, 0).setFriction(0.8),
    floor,
  );
  physics.world.step();
  const vehicles = new VehicleSystem();
  vehicles.initialize({ physics, scene: new THREE.Scene() });
  const vehicle = new BaseVehicle({
    position: new THREE.Vector3(0, 0.9, 0),
    model: new THREE.Group(),
    chassisOverlay: false,
  });
  await vehicles.spawnVehicle({ vehicle, snapToGround: false });
  vehicles.activeVehicle = vehicle;
  physics.stepHooks = {
    beforeTick: () => vehicles.capturePrevPoses(),
    integrate: (dt, tick) => vehicles.integrateStep(dt, tick),
  };
  return { physics, vehicles, vehicle };
}

function controlsForTick(tick) {
  return {
    throttle: tick < 120 ? tick / 120 : tick < 600 ? 1 : 0.35,
    steer: tick < 240 ? 0 : tick < 420 ? 0.42 : tick < 620 ? -0.3 : 0,
    brake: tick >= 700 ? 0.65 : 0,
    handbrake: tick >= 520 && tick < 545,
    boost: false,
    pitch: 0,
    roll: 0,
    yaw: 0,
    vertical: 0,
  };
}

function step({ physics, vehicle }, controls) {
  physics.beginFrame({ delta: VEHICLE_PHYSICS_FIXED_STEP, fixedStep: VEHICLE_PHYSICS_FIXED_STEP });
  vehicle.update({ dt: VEHICLE_PHYSICS_FIXED_STEP, controls, physics, integrate: false });
  physics.stepPlanned();
}

function finalPose(run) {
  const body = run.physics.getFreshBody(run.vehicle.bodyHandle);
  return { position: body.translation(), rotation: body.rotation(), velocity: body.linvel() };
}

const recordedRun = await createRun();
for (let tick = 0; tick < 840; tick += 1) step(recordedRun, controlsForTick(tick));
const replay = recordedRun.vehicles.exportControlRecording();
assert.equal(replay.version, 1);
assert.equal(replay.samples.length, 840);

const replayedRun = await createRun();
for (const sample of replay.samples) step(replayedRun, sample.controls);

const a = finalPose(recordedRun);
const b = finalPose(replayedRun);
const positionDrift = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
const velocityDrift = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y, a.velocity.z - b.velocity.z);
const rotationDrift = Math.hypot(
  a.rotation.x - b.rotation.x,
  a.rotation.y - b.rotation.y,
  a.rotation.z - b.rotation.z,
  a.rotation.w - b.rotation.w,
);
console.log(`replayed ${replay.samples.length} ticks: position drift=${positionDrift}m velocity drift=${velocityDrift}m/s rotation drift=${rotationDrift}`);
assert.ok(positionDrift < 0.001, `position drift ${positionDrift}m exceeds 1 mm`);
assert.ok(velocityDrift < 0.001, `velocity drift ${velocityDrift}m/s exceeds tolerance`);
assert.ok(rotationDrift < 0.0001, `rotation drift ${rotationDrift} exceeds tolerance`);
console.log('vehicle determinism verification passed');
