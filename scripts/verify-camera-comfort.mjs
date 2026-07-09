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
  // Mild FOV pump is allowed so speed still reads without a long chase pull-back.
  assert(tuning.speedFovBoost > 0 && tuning.speedFovBoost < 5, 'comfort FOV pump should stay mild');
  assert(tuning.speedDistanceBoost <= 1.6, 'comfort distance boost should stay modest');

  const cinematic = bootCamera({ comfortEnabled: false });
  const cinematicTuning = cinematic.getVehicleTuning();
  assert(cinematicTuning.steerLookStrength > 0, 'cinematic restore should re-enable steer coupling');
  assert(
    cinematicTuning.speedFovBoost > tuning.speedFovBoost,
    'cinematic should allow a stronger FOV pump than comfort',
  );
  console.log('  comfort tuning: no steer coupling; mild FOV; cinematic restores drama');
}

function cameraHorizontalOffset(cameraSystem, vehicle) {
  const cam = cameraSystem.camera.position;
  const car = vehicle.group.position;
  return Math.hypot(cam.x - car.x, cam.z - car.z);
}

function testHighSpeedStaysClose() {
  const cameraSystem = bootCamera({ comfortEnabled: true, feel: 'comfort' });
  const idleVehicle = makeVehicle({ velocity: { x: 0, y: 0, z: 0 } });
  driveFrames(cameraSystem, idleVehicle, 120);
  const idleOffset = cameraHorizontalOffset(cameraSystem, idleVehicle);

  const fastVehicle = makeVehicle({
    velocity: { x: 0, y: 0, z: GAME_CONFIG.camera.vehicle.maxSpeedForEffects },
  });
  // Match heading to velocity so chase settles cleanly behind the car.
  fastVehicle.group.rotation.set(0, 0, 0, 'YXZ');
  driveFrames(cameraSystem, fastVehicle, 180, (v, i) => {
    v.group.position.z -= GAME_CONFIG.camera.vehicle.maxSpeedForEffects * DT;
  });
  const fastOffset = cameraHorizontalOffset(cameraSystem, fastVehicle);
  const pullBack = fastOffset - idleOffset;

  // Slight dramatic ease-out is fine; reject the old long-chase pull-back.
  assert(pullBack < 3.2, `high-speed pull-back ${pullBack.toFixed(2)} m is too far`);
  assert(pullBack > 0.6, `high-speed should ease out a bit, got ${pullBack.toFixed(2)} m`);

  // FOV should open a bit so speed still feels punchy.
  const baseFov = GAME_CONFIG.camera.vehicle.baseFov;
  assert(
    cameraSystem.camera.fov > baseFov + 1.5,
    `expected FOV pump at speed, got ${cameraSystem.camera.fov.toFixed(1)} (base ${baseFov})`,
  );
  console.log(
    `  high-speed close: idle ${idleOffset.toFixed(2)} m → fast ${fastOffset.toFixed(2)} m`
      + ` (Δ ${pullBack.toFixed(2)} m), fov ${cameraSystem.camera.fov.toFixed(1)}`,
  );
}

function testHeadingNoiseDoesNotJitterOrientation() {
  // Guards the close-mode chase jitter: physics-step heading/velocity wobble used
  // to feed the raw heading into lookAt every frame, so the camera orientation
  // twitched even though its position path was smoothed.
  const cameraSystem = bootCamera();
  const speed = 18;
  const vehicle = makeVehicle({ velocity: { x: 0, y: 0, z: -speed } });

  // Settle driving straight first.
  driveFrames(cameraSystem, vehicle, 120, (v) => {
    v.group.position.z -= speed * DT;
  });

  const prevQuat = new THREE.Quaternion().copy(cameraSystem.camera.quaternion);
  let maxAngularRate = 0;
  driveFrames(cameraSystem, vehicle, 180, (v, i) => {
    // High-frequency heading wobble (~±0.02 rad) like per-step tyre corrections.
    const noise = Math.sin(i * 2.7) * 0.02;
    v.group.rotation.set(0, noise, 0, 'YXZ');
    v.linearVelocity.x = -Math.sin(noise) * speed;
    v.linearVelocity.z = -Math.cos(noise) * speed;
    v.group.position.z -= speed * DT;

    const angle = prevQuat.angleTo(cameraSystem.camera.quaternion);
    maxAngularRate = Math.max(maxAngularRate, angle / DT);
    prevQuat.copy(cameraSystem.camera.quaternion);
  });

  // Fixed behavior measures ~0.02 rad/s; reverting either the smoothed look-yaw
  // or the look-target low-pass pushes this above 0.2.
  assert(
    maxAngularRate < 0.1,
    `camera orientation jitters at ${maxAngularRate.toFixed(2)} rad/s under heading noise`,
  );
  console.log(`  heading-noise rejection: max angular rate ${maxAngularRate.toFixed(3)} rad/s`);
}

console.log('verify-camera-comfort');
testComfortDisablesSteerCoupling();
testHighSpeedStaysClose();
testYawRateCap();
testHeadingNoiseDoesNotJitterOrientation();
testNoModeSnap();
testCockpitRollLock();
testEasedModeBlend();
console.log('verify-camera-comfort: ok');
