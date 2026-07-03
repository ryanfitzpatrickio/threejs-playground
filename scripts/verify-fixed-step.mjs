// Regression for the fixed-timestep main loop (see internal racing loop timing review).
//
// The old loop ran exactly one hardcoded 16 ms world step per rendered frame, so
// simulation speed was tied to the display refresh rate (a 120 Hz monitor ran the
// car at ~1.9x real time; a 30 fps stall ran it at ~0.5x). This drives the same
// car at full throttle over a flat floor at 30/60/120/144 "Hz" using the real
// runtime loop shape (beginFrame plan -> VehicleSystem.update -> stepPlanned with
// stepHooks -> syncVisualPoses) and asserts:
//
//   1. Distance covered in the same REAL time matches across frame rates.
//   2. The fixed-step tick counter advances at ~60/s of real time at any Hz.
//   3. Slow-mo (timeScale) scales sim time, not step cadence.
//   4. The interpolated visual pose advances smoothly at 120 Hz (no
//      step-then-stall aliasing), i.e. rendering is decoupled from step cadence.
//
// Run: node scripts/verify-fixed-step.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsSystem, PHYSICS_FIXED_STEP } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import { RenderRateLimiter } from '../src/game/core/RenderRateLimiter.js';

await RAPIER.init();

const REAL_SECONDS = 8;
const GRAVITY_Y = -15.5;

function makePhysics() {
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
  physics.world.numSolverIterations = 8;
  physics.world.numInternalPgsIterations = 2;
  const floor = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(50, 0.5, 2000).setTranslation(0, -0.5, 0).setFriction(0.8),
    floor,
  );
  physics.world.step();
  return physics;
}

function riderStub(vehicle) {
  return {
    group: vehicle.group,
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    vehicle: { active: true, vehicle, seatIndex: vehicle.driverSeatIndex, handTargets: null, anchorOffset: null },
    animationController: { play() {} },
  };
}

// One full runtime-shaped frame: plan, systems, planned steps, interpolated sync.
function runFrames({ physics, vs, character, frames, delta, timeScale = 1, fixedStep = PHYSICS_FIXED_STEP, input, onFrame = null }) {
  for (let f = 0; f < frames; f += 1) {
    physics.beginFrame({ delta, timeScale, fixedStep });
    vs.update({ delta: delta * timeScale, input, character, level: null });
    physics.stepPlanned();
    vs.syncVisualPoses(physics.interpolationAlpha, character);
    onFrame?.(f);
  }
}

async function driveRun(frameHz, { timeScale = 1, fixedStep = 1 / 120, collectVisual = false } = {}) {
  const physics = makePhysics();
  const vs = new VehicleSystem();
  vs.initialize({ physics, scene: new THREE.Scene(), level: null });
  // Same wiring as GameRuntime.initialize: pose capture + per-step integration.
  physics.stepHooks = {
    beforeTick: () => vs.capturePrevPoses(),
    integrate: (dt) => vs.integrateStep(dt),
  };
  const vehicle = new BaseVehicle({
    position: new THREE.Vector3(0, 0.9, 0),
    model: new THREE.Group(),
    chassisOverlay: false,
  });
  await vs.spawnVehicle({ vehicle, snapToGround: false });
  vehicle.engineAudio = { resume() {}, update() {}, dispose() {}, mute() {} };
  vs.activeVehicle = vehicle;
  const character = riderStub(vehicle);
  const delta = 1 / frameHz;
  const neutral = { moveX: 0, moveZ: 0, jump: false, slide: false, brace: false, mountPressed: false };
  const drive = { ...neutral, moveZ: -1 };

  // Settle the suspension in place before driving.
  runFrames({ physics, vs, character, frames: Math.round(frameHz), delta, fixedStep, input: neutral });
  const startZ = physics.world.bodies.get(vehicle.bodyHandle).translation().z;
  const startTick = physics.tickCount;

  const visualJumps = [];
  let prevVisualZ = null;
  runFrames({
    physics, vs, character,
    frames: Math.round(REAL_SECONDS * frameHz),
    delta, timeScale, fixedStep, input: drive,
    onFrame: collectVisual
      ? () => {
          const z = vehicle.group.position.z;
          if (prevVisualZ !== null) visualJumps.push(Math.abs(z - prevVisualZ));
          prevVisualZ = z;
        }
      : null,
  });

  const body = physics.world.bodies.get(vehicle.bodyHandle);
  return {
    frameHz,
    distance: Math.abs(body.translation().z - startZ),
    ticks: physics.tickCount - startTick,
    alpha: physics.interpolationAlpha,
    visualJumps,
  };
}

// ---- 1+2: refresh-rate independence + tick cadence -------------------------
const baseline = await driveRun(60);
const results = [baseline];
for (const hz of [30, 120, 144]) results.push(await driveRun(hz));

console.log(`full throttle for ${REAL_SECONDS}s of real time:`);
for (const r of results) {
  console.log(`  ${String(r.frameHz).padStart(3)} Hz: distance=${r.distance.toFixed(1)}m ticks=${r.ticks}`);
  const ratio = r.distance / baseline.distance;
  assert.ok(Math.abs(ratio - 1) < 0.03,
    `${r.frameHz} Hz covered ${r.distance.toFixed(1)}m vs ${baseline.distance.toFixed(1)}m at 60 Hz `
    + `(${ratio.toFixed(3)}x — sim speed still depends on frame rate)`);
  const expectedTicks = REAL_SECONDS / (1 / 120);
  assert.ok(Math.abs(r.ticks - expectedTicks) <= 2,
    `${r.frameHz} Hz ran ${r.ticks} fixed ticks, expected ~${expectedTicks}`);
  assert.ok(r.alpha >= 0 && r.alpha <= 1, `interpolation alpha out of range: ${r.alpha}`);
}

// ---- 3: slow-mo scales sim time, not cadence --------------------------------
{
  const physics = makePhysics();
  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(30, 80, 0),
  );
  physics.world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
  const frames = 60; // 1 real second at 60 Hz
  const timeScale = 0.05;
  for (let f = 0; f < frames; f += 1) {
    physics.beginFrame({ delta: 1 / 60, timeScale, fixedStep: PHYSICS_FIXED_STEP });
    physics.stepPlanned();
  }
  const vy = Math.abs(body.linvel().y);
  const expected = Math.abs(GRAVITY_Y) * 1 * timeScale; // g * (real seconds * timeScale)
  console.log(`slow-mo free fall: |vy|=${vy.toFixed(3)} m/s after 1s real at timeScale ${timeScale} (expected ~${expected.toFixed(3)})`);
  assert.ok(Math.abs(vy - expected) < expected * 0.1,
    `slow-mo advanced the wrong amount of sim time (|vy|=${vy.toFixed(3)}, expected ~${expected.toFixed(3)})`);
  assert.ok(Math.abs(physics.simTime - timeScale) <= PHYSICS_FIXED_STEP,
    `slow-mo simTime=${physics.simTime}, expected ${timeScale}`);
}

// ---- 5: adopting 120 Hz preserves the handling envelope -------------------
{
  const at60 = await driveRun(60, { fixedStep: 1 / 60 });
  const at120 = await driveRun(60, { fixedStep: 1 / 120 });
  const ratio = at120.distance / at60.distance;
  console.log(`step-rate trial: 60Hz=${at60.distance.toFixed(1)}m 120Hz=${at120.distance.toFixed(1)}m ratio=${ratio.toFixed(3)}`);
  assert.ok(Math.abs(ratio - 1) < 0.05,
    `120 Hz step distance differs from 60 Hz by ${((ratio - 1) * 100).toFixed(1)}%`);
}

// ---- 4: interpolated visual pose is smooth at 120 Hz ------------------------
{
  const r = await driveRun(120, { collectVisual: true });
  // Steady-state cruise window: skip the acceleration ramp.
  const cruise = r.visualJumps.slice(Math.floor(r.visualJumps.length * 0.7));
  const mean = cruise.reduce((a, b) => a + b, 0) / cruise.length;
  const max = Math.max(...cruise);
  const min = Math.min(...cruise);
  console.log(`120 Hz visual motion: mean=${(mean * 1000).toFixed(1)}mm max=${(max * 1000).toFixed(1)}mm min=${(min * 1000).toFixed(1)}mm per frame`);
  // Without interpolation the 60 Hz steps alias to alternating 0 / double-length
  // frames (max ~= 2x mean, min ~= 0). Interpolated motion is near-uniform.
  assert.ok(max < mean * 1.5, `visual stutter at 120 Hz: max frame jump ${max.toFixed(4)}m vs mean ${mean.toFixed(4)}m`);
  assert.ok(min > mean * 0.5, `visual stall frame at 120 Hz: min frame jump ${min.toFixed(4)}m vs mean ${mean.toFixed(4)}m`);
}

// A 60 fps render cap on a 144 Hz callback stream must average 60 rather than
// falling to 48, and accumulated physics time must still match elapsed time.
{
  const limiter = new RenderRateLimiter(60);
  const physics = makePhysics();
  let lastRunMs = 0;
  let rendered = 0;
  for (let callback = 0; callback <= 144 * 2; callback += 1) {
    const timeMs = callback * (1000 / 144);
    if (!limiter.shouldRun(timeMs)) continue;
    const delta = rendered === 0 ? 0 : (timeMs - lastRunMs) / 1000;
    lastRunMs = timeMs;
    rendered += 1;
    physics.beginFrame({ delta, fixedStep: 1 / 120 });
    physics.stepPlanned();
  }
  console.log(`60 fps cap over 144 Hz callbacks: rendered=${rendered} simTime=${physics.simTime.toFixed(3)}s`);
  assert.ok(Math.abs(rendered - 121) <= 1, `render cap produced ${rendered} frames, expected ~121`);
  assert.ok(Math.abs(physics.simTime - 2) <= 3 / 120, `render cap changed physics time (${physics.simTime}s)`);
}

console.log('fixed-step loop verification passed');
