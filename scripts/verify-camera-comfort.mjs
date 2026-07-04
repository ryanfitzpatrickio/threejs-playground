// Pure-node regression harness for comfort-first vehicle camera behavior.
//
// Asserts:
//   1. Camera yaw rate stays within maxCameraYawRate while heading whips.
//   2. Mode cycling does not jump-cut position (no single-frame snap).
//   3. Cockpit view locks roll to zero under chassis roll.
//   4. Mode transitions ease in over modeBlendDuration (no instant param snap).
//
// Run: node scripts/verify-camera-comfort.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraSystem } from '../src/game/systems/CameraSystem.js';
import { GAME_CONFIG } from '../src/game/config/gameConfig.js';

const DT = 1 / 60;

function makeScene() {
  return new THREE.Scene();
}

function makeVehicle({
  position = new THREE.Vector3(0, 1, 0),
  yaw = 0,
  roll = 0,
  pitch = 0,
  velocity = { x: 0, y: 0, z: 0 },
  steer = 0,
} = {}) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.rotation.set(pitch, yaw, roll, 'YXZ');
  return {
    group,
    linearVelocity: velocity,
    steerTelemetry: { steer },
    config: {
      seats: [{ offset: [0, 0.5, 0.2] }],
    },
    driverSeatIndex: 0,
    frameParameters: { offsetFromTires: 0 },
  };
}

function bootCamera({ comfortEnabled = true, feel = 'comfort' } = {}) {
  const scene = makeScene();
  const cameraSystem = new CameraSystem();
  cameraSystem.initialize(scene, {});
  cameraSystem.setComfortOptions({ enabled: comfortEnabled, feel });
  cameraSystem.resize({ aspect: 16 / 9 });
  return cameraSystem;
}

function driveFrames(cameraSystem, vehicle, frames, mutate) {
  for (let i = 0; i < frames; i += 1) {
    mutate?.(vehicle, i);
    cameraSystem.update({
      delta: DT,
      target: vehicle.group.position,
      viewport: { aspect: 16 / 9 },
      input: null,
      vehicle,
    });
  }
}

function testYawRateCap() {
  const cameraSystem = bootCamera();
  const vehicle = makeVehicle({ velocity: { x: 0, y: 0, z: 18 } });
  const tuning = cameraSystem.getVehicleTuning();
  const maxRate = tuning.maxCameraYawRate;
  assert(Number.isFinite(maxRate) && maxRate > 0, 'comfort tuning must define a finite yaw-rate cap');

  let prevYaw = cameraSystem.vehicleCameraYaw;
  let observedMax = 0;

  driveFrames(cameraSystem, vehicle, 180, (v, i) => {
    const heading = Math.sin(i * 0.22) * 1.4;
    v.group.rotation.set(0, heading, 0, 'YXZ');
    v.linearVelocity.x = Math.sin(heading) * 18;
    v.linearVelocity.z = Math.cos(heading) * 18;

    const yaw = cameraSystem.vehicleCameraYaw;
    let delta = yaw - prevYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    observedMax = Math.max(observedMax, Math.abs(delta) / DT);
    prevYaw = yaw;
  });

  assert(
    observedMax <= maxRate * 1.05,
    `camera yaw rate ${observedMax.toFixed(2)} rad/s exceeded cap ${maxRate}`,
  );
  console.log(`  yaw-rate cap: observed ${observedMax.toFixed(2)} <= ${maxRate} rad/s`);
}

function testNoModeSnap() {
  const cameraSystem = bootCamera();
  const vehicle = makeVehicle({ velocity: { x: 0, y: 0, z: 12 } });

  driveFrames(cameraSystem, vehicle, 90);
  cameraSystem.setVehicleCameraMode('far');

  let maxStep = 0;
  let firstStep = 0;
  for (let i = 0; i < 45; i += 1) {
    const prev = cameraSystem.camera.position.clone();
    cameraSystem.update({
      delta: DT,
      target: vehicle.group.position,
      viewport: { aspect: 16 / 9 },
      input: null,
      vehicle,
    });
    const step = prev.distanceTo(cameraSystem.camera.position);
    if (i === 0) {
      firstStep = step;
    }
    maxStep = Math.max(maxStep, step);
  }

  assert(firstStep < 1.2, `first frame after mode cycle jumped ${firstStep.toFixed(2)} m`);
  assert(maxStep < 2.5, `mode cycle frame step ${maxStep.toFixed(2)} m looks like a snap`);
  console.log(`  no snap: first step ${firstStep.toFixed(2)} m, max step ${maxStep.toFixed(2)} m`);
}

function testCockpitRollLock() {
  const cameraSystem = bootCamera();
  const vehicle = makeVehicle({ roll: 0.55 });

  driveFrames(cameraSystem, vehicle, 120, (v, i) => {
    v.group.rotation.z = 0.35 + Math.sin(i * 0.4) * 0.25;
  });

  cameraSystem.setVehicleCameraMode('firstPerson');
  driveFrames(cameraSystem, vehicle, 90, (v, i) => {
    v.group.rotation.z = 0.35 + Math.sin(i * 0.4) * 0.25;
  });

  const roll = cameraSystem.camera.rotation.z;
  assert(Math.abs(roll) < 1e-4, `cockpit roll should be locked, got ${roll}`);
  console.log(`  cockpit roll lock: |z|=${Math.abs(roll).toExponential(2)}`);
}

function testEasedModeBlend() {
  const cameraSystem = bootCamera();
  const vehicle = makeVehicle({ velocity: { x: 0, y: 0, z: 10 } });
  const duration = GAME_CONFIG.camera.vehicle.modeBlendDuration;

  driveFrames(cameraSystem, vehicle, 60);
  cameraSystem.setVehicleCameraMode('medium');

  const samples = [];
  for (let i = 0; i < Math.ceil(duration / DT) + 5; i += 1) {
    cameraSystem.update({
      delta: DT,
      target: vehicle.group.position,
      viewport: { aspect: 16 / 9 },
      input: null,
      vehicle,
    });
    samples.push(cameraSystem.snapshot().modeBlendT);
  }

  assert(samples[0] < 0.2, `blend should start near 0, got ${samples[0]}`);
  assert(samples.at(-1) >= 0.99, `blend should finish at 1, got ${samples.at(-1)}`);
  const monotonic = samples.every((value, index) => index === 0 || value >= samples[index - 1] - 1e-6);
  assert(monotonic, 'mode blend progress must be monotonic');
  console.log(`  eased blend: ${samples[0].toFixed(2)} → ${samples.at(-1).toFixed(2)} over ${duration}s`);
}

function testComfortDisablesSteerCoupling() {
  const cameraSystem = bootCamera({ comfortEnabled: true, feel: 'comfort' });
  const tuning = cameraSystem.getVehicleTuning();
  assert.equal(tuning.steerLookStrength, 0);
  assert.equal(tuning.lateralShift, 0);
  assert.equal(tuning.speedFovBoost, 0);

  const cinematic = bootCamera({ comfortEnabled: false });
  const cinematicTuning = cinematic.getVehicleTuning();
  assert(cinematicTuning.steerLookStrength > 0, 'cinematic restore should re-enable steer coupling');
  console.log('  comfort tuning: steer/FOV pump disabled; cinematic restores drama');
}

console.log('verify-camera-comfort');
testComfortDisablesSteerCoupling();
testYawRateCap();
testNoModeSnap();
testCockpitRollLock();
testEasedModeBlend();
console.log('verify-camera-comfort: ok');
