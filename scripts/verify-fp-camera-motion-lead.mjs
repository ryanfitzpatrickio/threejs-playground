#!/usr/bin/env node
/**
 * Regression: position smoothing must not leave an on-foot FP sprint camera
 * behind the headless body, where the neck seam becomes visible.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GAME_CONFIG } from '../src/game/config/gameConfig.js';
import { CameraSystem } from '../src/game/systems/CameraSystem.js';

const cameraSystem = new CameraSystem();
cameraSystem.initialize(new THREE.Scene());
cameraSystem.yaw = 0;
cameraSystem.pitch = 0;

const target = new THREE.Vector3(0, 0, 0);
const character = {
  // yaw 0 looks toward -Z, the same direction as this sprint.
  velocity: new THREE.Vector3(0, 0, -GAME_CONFIG.character.sprintSpeed),
};
const delta = 1 / 60;

// Let the spring settle while moving at top on-foot speed.
for (let frame = 0; frame < 240; frame += 1) {
  target.z += character.velocity.z * delta;
  cameraSystem.updateOnFootFirstPerson({
    delta,
    target,
    config: GAME_CONFIG.camera,
    character,
  });
}

// Negative Z is in front of the root at yaw 0. The idle eye offset alone is
// 6cm forward; this allows a little spring error but rejects the old behind-body
// result (about +16cm at sprint speed, or +40cm with the prior -18cm offset).
assert.ok(
  cameraSystem.camera.position.z < target.z - 0.09,
  `FP sprint camera fell behind body: camera=${cameraSystem.camera.position.z}, root=${target.z}`,
);

// The composition push is movement-only: settle back to the centred idle eye.
character.velocity.set(0, 0, 0);
for (let frame = 0; frame < 240; frame += 1) {
  cameraSystem.updateOnFootFirstPerson({
    delta,
    target,
    config: GAME_CONFIG.camera,
    character,
  });
}
assert.ok(
  Math.abs(cameraSystem.camera.position.z - target.z) < 0.01,
  'FP camera should return to the centred eye position at idle',
);

// Pitch should hinge the eye vertically, not drive it farther through the body.
const settlePitch = (pitch) => {
  const system = new CameraSystem();
  system.initialize(new THREE.Scene());
  system.yaw = 0;
  system.pitch = pitch;
  const still = new THREE.Vector3();
  for (let frame = 0; frame < 240; frame += 1) {
    system.updateOnFootFirstPerson({
      delta,
      target: still,
      config: GAME_CONFIG.camera,
      character: { velocity: new THREE.Vector3() },
    });
  }
  return system.camera.position.y;
};
const neutralY = settlePitch(0);
assert.ok(settlePitch(-0.9) > neutralY + 0.05, 'looking down should hinge the eye up');
assert.ok(settlePitch(0.9) < neutralY - 0.05, 'looking up should hinge the eye down');

console.log('verify-fp-camera-motion-lead: sprint lead and pitch hinge passed');
