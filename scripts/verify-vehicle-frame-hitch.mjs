// A long render/chunk-loading frame must not increase fixed-step vehicle impulse.
// Run: node scripts/verify-vehicle-frame-hitch.mjs

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
const STEP_DT = 0.016;

async function run(frameDtAt, groundConfig = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, -1800));
  world.createCollider(RAPIER.ColliderDesc.cuboid(40, 1, 2000).setFriction(0.7), ground);
  const physics = { RAPIER, world, getFreshBody: (handle) => world.bodies.get(handle) };
  const scene = new THREE.Scene();
  const vehicle = new BaseVehicle({
    chassisOverlay: false,
    config: {
      controls: { throttleSmoothing: 1000 },
      ground: groundConfig,
    },
  });
  vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });

  const neutral = makeNeutralControls();
  for (let i = 0; i < 90; i += 1) {
    vehicle.update({ dt: STEP_DT, controls: neutral, physics });
    world.step();
  }

  const drive = makeNeutralControls();
  drive.throttle = 1;
  let largestStep = 0;
  let previousSpeed = 0;
  let frameAt60Mph = null;
  let frameAt60 = null;
  let frameAt66 = null;
  for (let frame = 0; frame < 1800; frame += 1) {
    vehicle.update({ dt: frameDtAt(frame), controls: drive, physics });
    world.step();
    const velocity = physics.getFreshBody(vehicle.bodyHandle).linvel();
    const speed = Math.hypot(velocity.x, velocity.z);
    largestStep = Math.max(largestStep, speed - previousSpeed);
    if (frameAt60Mph == null && speed >= 26.8224) frameAt60Mph = frame;
    if (frameAt60 == null && speed >= 60) frameAt60 = frame;
    if (frameAt66 == null && speed >= 66) frameAt66 = frame;
    previousSpeed = speed;
  }
  vehicle.dispose({ scene, physics });
  return { finalSpeed: previousSpeed, largestStep, frameAt60Mph, frameAt60, frameAt66 };
}

const previous = await run(() => STEP_DT, { enginePower: 22, engineTaperBand: 0.32 });
const smooth = await run(() => STEP_DT);
const hitched = await run((frame) => (frame > 0 && frame % 12 === 0 ? 0.05 : STEP_DT));
const finalDelta = Math.abs(hitched.finalSpeed - smooth.finalSpeed);
const stepDelta = Math.abs(hitched.largestStep - smooth.largestStep);

const format = (result) => (
  `final=${result.finalSpeed.toFixed(4)}m/s maxStep=${result.largestStep.toFixed(4)}m/s `
  + `60mph@${((result.frameAt60Mph ?? Infinity) * STEP_DT).toFixed(2)}s `
  + `60m/s@${((result.frameAt60 ?? Infinity) * STEP_DT).toFixed(2)}s `
  + `66m/s@${((result.frameAt66 ?? Infinity) * STEP_DT).toFixed(2)}s`
);
console.log(`previous ${format(previous)}`);
console.log(`smooth   ${format(smooth)}`);
console.log(`hitched  ${format(hitched)}`);
assert.ok(finalDelta < 0.02, `hitch changed final speed by ${finalDelta}m/s`);
assert.ok(stepDelta < 0.01, `hitch changed peak per-step acceleration by ${stepDelta}m/s`);
assert.ok(smooth.frameAt66 != null, 'vehicle must still reach the 150 mph neighbourhood');
assert.ok(
  smooth.frameAt66 > previous.frameAt66,
  'new high-speed taper must take longer to reach the 150 mph neighbourhood',
);
assert.ok(
  smooth.frameAt60Mph * STEP_DT >= 3.5,
  '0–60 mph must not be rocket-car acceleration',
);
console.log('Vehicle frame-hitch check passed.');
