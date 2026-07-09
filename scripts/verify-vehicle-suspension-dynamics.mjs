// Guards suspension dynamics modulation (plan M3) — slow/fast damper,
// progressive spring, bump stop. Extends the spirit of verify:vehicle-suspension
// with pure-math unit checks + a flat-ground settle under controller-slip.
//
// Out of scope (Tier B): surface-normal suspension force / ramp glide — the
// Rapier controller casts body-up only; deferred per plan.
//
// Run: node scripts/verify-vehicle-suspension-dynamics.mjs
//   npm run verify:vehicle-suspension-dynamics

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  bumpStopContribution,
  damperCoefficient,
  progressiveSpringScale,
  resolveSuspensionDynamics,
  resolveWheelSuspension,
} from '../src/game/vehicles/SuspensionModel.js';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';
import { DEFAULT_VEHICLE_CONFIG } from '../src/game/config/vehicleConfig.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- dual-rate damper
{
  const dyn = resolveSuspensionDynamics().damper;
  const slow = damperCoefficient(0.2, dyn, true);
  const fast = damperCoefficient(1.2, dyn, true);
  assert.ok(slow < fast, `slow bump c (${slow}) < fast (${fast})`);
  const slowReb = damperCoefficient(0.2, dyn, false);
  const fastReb = damperCoefficient(1.2, dyn, false);
  assert.ok(slowReb <= fastReb, 'rebound also dual-rate');
  assert.ok(dyn.cLowRebound !== dyn.cLowBump, 'default bump ≠ rebound config rates');
  // Strict output compare — no always-true config OR.
  assert.ok(Math.abs(slowReb - slow) > 0.05,
    `slow rebound c (${slowReb}) differs from slow bump c (${slow})`);
  ok('slow/fast damper split');
}

// ---------------------------------------------------------------- progressive spring
{
  const mid = progressiveSpringScale(0.4, DEFAULT_VEHICLE_CONFIG.ground.suspensionDynamics.spring);
  const deep = progressiveSpringScale(0.95, DEFAULT_VEHICLE_CONFIG.ground.suspensionDynamics.spring);
  assert.equal(mid, 1, 'below progressiveStart scale=1');
  assert.ok(deep > 1, 'near full compression progressive stiffens');
  ok('progressive spring stiffens near full compression');
}

// ---------------------------------------------------------------- bump stop
{
  const none = bumpStopContribution(0.5, DEFAULT_VEHICLE_CONFIG.ground.suspensionDynamics.spring);
  const hit = bumpStopContribution(0.95, DEFAULT_VEHICLE_CONFIG.ground.suspensionDynamics.spring);
  assert.equal(none.kAdd, 0);
  assert.ok(hit.kAdd > 0 && hit.cAdd > 0, 'bump stop engages near end of travel');
  ok('bump stop engages in last travel fraction');
}

// ---------------------------------------------------------------- resolveWheelSuspension respects launch cap
{
  const r = resolveWheelSuspension({
    suspensionLength: 0.05, // nearly metal-bottom (compressionFrac ~0.83)
    prevSuspensionLength: 0.35,
    dt: 1 / 60,
    restLength: 0.4,
    maxTravel: 0.42,
    baseStiffness: 24,
    baseCompression: 12,
    baseRelaxation: 12,
    baseMaxForce: 4000,
    dynamics: DEFAULT_VEHICLE_CONFIG.ground.suspensionDynamics,
  });
  // Launch invariant: deep compression + bump stop still returns exact base cap.
  assert.equal(r.maxForce, 4000, 'maxForce equals baseMaxForce launch cap');
  assert.ok(r.stiffness > 24, 'deep compression progressive/bump stiffens above base');
  assert.ok(r.compressionFrac > 0.8, 'near-bottom compression detected');
  assert.ok(r.shaftSpeed > 0, 'compressing shaft speed > 0');
  assert.ok(r.maxTravel <= 0.4 - 0.02 + 1e-6, 'maxTravel clamped vs restLength');
  ok('wheel suspension setters respect launch cap');
}

// ---------------------------------------------------------------- disabled passthrough
{
  const r = resolveWheelSuspension({
    suspensionLength: 0.2,
    baseStiffness: 30,
    baseCompression: 10,
    baseRelaxation: 11,
    baseMaxForce: 4000,
    dynamics: { enabled: false },
  });
  assert.equal(r.stiffness, 30);
  assert.equal(r.compression, 10);
  assert.equal(r.relaxation, 11);
  ok('dynamics disabled → base rayCast params');
}

// ---------------------------------------------------------------- flat settle under controller-slip
const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

await RAPIER.init();

{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.numSolverIterations = 8;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(60, 2, 60).setFriction(0.55).setRestitution(0),
    ground,
  );
  const physics = {
    RAPIER,
    world,
    getFreshBody: (h) => world.bodies.get(h),
  };
  const scene = new THREE.Scene();
  const vehicle = new BaseVehicle({
    position: new THREE.Vector3(0, 0, 0),
    chassisOverlay: false,
    config: { ground: { handlingModel: 'controller-slip' } },
  });
  vehicle.chassisOverlayOptions = null;
  vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });

  const controls = makeNeutralControls();
  const samples = [];
  for (let i = 0; i < 240; i += 1) {
    vehicle.update({ dt: 1 / 60, controls, physics });
    world.step();
    const b = physics.getFreshBody(vehicle.bodyHandle);
    const t = b.translation();
    const v = b.linvel();
    samples.push({ y: t.y, vy: v.y });
  }
  const tail = samples.slice(-120);
  let minY = Infinity;
  let maxY = -Infinity;
  let signChanges = 0;
  let prevSign = 0;
  for (const s of tail) {
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
    const sign = Math.sign(s.vy);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) signChanges += 1;
    if (sign !== 0) prevSign = sign;
  }
  const swing = maxY - minY;
  console.log(`    settle swing=${swing.toFixed(3)}m osc=${signChanges}`);
  assert.ok(swing < 0.08, `flat settle calm (swing=${swing.toFixed(3)})`);
  assert.ok(signChanges < 12, `not continuously bouncing (osc=${signChanges})`);
  assert.ok(vehicle.grounded, 'grounded after settle');
  ok('controller-slip flat-ground settle stays calm');
}

console.log(`\nverify-vehicle-suspension-dynamics: ${passed} checks passed`);
