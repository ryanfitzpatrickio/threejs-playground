// Guards arcade drift assist + progressive rear slip (plan M4 + F3/F4).
//
// Pure-math:
//   - Assist inactive below slip trigger / min speed
//   - Countersteer activates with rear α
//   - Recovery grip boost past envelope
// Integration (Rapier):
//   - RWD throttle-in-turn grows rear |α| progressively (not 1-frame snap)
//   - Drift assist ON widens recoverable envelope vs OFF
//
// Run: node scripts/verify-vehicle-drift.mjs
//   npm run verify:vehicle-drift

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { computeDriftAssist, resolveDriftAssistConfig } from '../src/game/vehicles/DriftAssist.js';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';
import { DEFAULT_VEHICLE_CONFIG } from '../src/game/config/vehicleConfig.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- pure assist
{
  const off = computeDriftAssist({
    rearAlpha: 0.05,
    yawRate: 0.2,
    steer: 0.5,
    speed: 20,
    throttle: 1,
    config: { enabled: true, strength: 1, slipTriggerDeg: 12, minSpeed: 4 },
  });
  assert.equal(off.active, false, 'inactive at low rear slip');

  const on = computeDriftAssist({
    rearAlpha: 0.4, // ~23°
    yawRate: 0.8,
    steer: 0.3,
    speed: 18,
    throttle: 1,
    config: { enabled: true, strength: 1, slipTriggerDeg: 12, minSpeed: 4, countersteerMax: 0.35 },
  });
  assert.ok(on.active, 'active above trigger');
  assert.ok(on.countersteerActive, 'countersteer engages');
  assert.ok(Math.abs(on.steerAdd) > 0.01, 'steerAdd nonzero');
  // Countersteer opposes rear α sign.
  assert.ok(Math.sign(on.steerAdd) === -Math.sign(0.4), 'countersteer opposes rear α');

  const recover = computeDriftAssist({
    rearAlpha: 0.9, // ~51° past 45° envelope
    yawRate: 1.5,
    steer: -0.2,
    speed: 16,
    throttle: 0.4,
    config: { enabled: true, strength: 1, recoveryEnvelopeDeg: 45, recoveryGripBoost: 0.45 },
  });
  assert.ok(recover.recoveryActive, 'recovery past envelope');
  assert.ok(recover.recoveryGripScale > 1, 'recovery boosts grip');

  const disabled = computeDriftAssist({
    rearAlpha: 0.5,
    yawRate: 1,
    steer: 0,
    speed: 20,
    throttle: 1,
    config: { enabled: false },
  });
  assert.equal(disabled.active, false);
  ok('drift assist countersteer + recovery math');
}

// ---------------------------------------------------------------- config default ON
{
  const cfg = resolveDriftAssistConfig(DEFAULT_VEHICLE_CONFIG.ground.driftAssist);
  assert.equal(cfg.enabled, true, 'assist ON by default');
  assert.ok(cfg.strength > 0);
  ok('driftAssist enabled by default in vehicleConfig');
}

// ---------------------------------------------------------------- Rapier progressive rear slip
const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

await RAPIER.init();

function makePhysics(world) {
  return { RAPIER, world, getFreshBody: (h) => world.bodies.get(h) };
}

function makeFlatGround(world) {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 2, 200).setFriction(0.55).setRestitution(0), body);
}

async function spawn(physics, scene, config = {}) {
  const vehicle = new BaseVehicle({
    position: new THREE.Vector3(0, 0, 0),
    chassisOverlay: false,
    config: {
      ground: {
        handlingModel: 'controller-slip',
        driveLayout: 'rwd',
        ...config,
      },
    },
  });
  vehicle.chassisOverlayOptions = null;
  vehicle.spawnPosition.y = vehicle.getGroundSpawnClearance();
  await vehicle.spawn({ scene, physics });
  vehicle.wakeForDrive(physics);
  return vehicle;
}

function settle(vehicle, physics, world, frames = 90) {
  const c = makeNeutralControls();
  for (let i = 0; i < frames; i += 1) {
    vehicle.update({ dt: 1 / 60, controls: c, physics });
    world.step();
  }
}

function meanRearAbsAlpha(vehicle) {
  let s = 0;
  let n = 0;
  for (const w of vehicle.wheelTelemetry) {
    if (!w || w.isFront) continue;
    s += Math.abs(w.alpha ?? 0);
    n += 1;
  }
  return n ? s / n : 0;
}

{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.numSolverIterations = 8;
  makeFlatGround(world);
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const vehicle = await spawn(physics, scene, {
    driftAssist: { enabled: false },
    // Lower rear grip a bit so RWD throttle-turn can step the tail out.
    tyre: { mu0Lat: 1.3, residualMin: 0.28 },
    surfaces: {
      asphalt: { mu0Lat: 1.3, sideFrictionStiffness: 0.75 },
    },
  });
  settle(vehicle, physics, world, 100);

  // Bring up to speed in a straight line.
  const body = physics.getFreshBody(vehicle.bodyHandle);
  body.setLinvel({ x: 0, y: body.linvel().y, z: -18 }, true);
  const go = makeNeutralControls();
  go.throttle = 1;
  for (let i = 0; i < 60; i += 1) {
    vehicle.update({ dt: 1 / 60, controls: go, physics });
    world.step();
  }

  // Throttle + steer mid-corner: rear α should grow over many frames, not snap.
  go.steer = 1;
  go.throttle = 1;
  const samples = [];
  for (let i = 0; i < 45; i += 1) {
    vehicle.update({ dt: 1 / 60, controls: go, physics });
    world.step();
    samples.push(meanRearAbsAlpha(vehicle));
  }
  const early = samples.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const late = samples.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const maxA = Math.max(...samples);
  const maxAt = samples.indexOf(maxA);
  console.log(`    rear|α| early=${early.toFixed(3)} late=${late.toFixed(3)} max=${maxA.toFixed(3)} @${maxAt}`);
  assert.ok(late >= early + 0.008 || maxA >= early + 0.015,
    `rear slip grows meaningfully (early=${early.toFixed(3)} late=${late.toFixed(3)} max=${maxA.toFixed(3)})`);
  assert.ok(maxAt >= 5, `peak after frame ≥5 (got @${maxAt}) — not a 1-frame snap`);
  assert.ok(samples[0] < maxA * 0.9 + 0.01, 'frame-0 rear α well below peak');
  ok('RWD throttle-in-turn grows rear slip progressively');
}

// ---------------------------------------------------------------- assist recovery envelope
{
  // Pure: assist with recovery vs without — recovery scale differs.
  const bigSlip = {
    rearAlpha: 0.95,
    yawRate: 2,
    steer: -0.5,
    speed: 15,
    throttle: 0.3,
  };
  const withAssist = computeDriftAssist({
    ...bigSlip,
    config: { enabled: true, strength: 1, recoveryEnvelopeDeg: 45, recoveryGripBoost: 0.5 },
  });
  const noAssist = computeDriftAssist({
    ...bigSlip,
    config: { enabled: false },
  });
  assert.ok(withAssist.recoveryGripScale > noAssist.recoveryGripScale,
    'assist recovery grip > no-assist');
  assert.ok(withAssist.countersteerActive && !noAssist.countersteerActive,
    'assist adds countersteer when disabled path does not');
  ok('drift assist widens recoverable envelope vs off');
}

// ---------------------------------------------------------------- handbrake initiates more rear slip / yaw than baseline
{
  async function runHandbrake(handbrake) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    makeFlatGround(world);
    const physics = makePhysics(world);
    const scene = new THREE.Scene();
    const vehicle = await spawn(physics, scene, {
      driftAssist: { enabled: false },
      driveLayout: 'rwd',
    });
    settle(vehicle, physics, world, 60);
    const body = physics.getFreshBody(vehicle.bodyHandle);
    body.setLinvel({ x: 0, y: body.linvel().y, z: -16 }, true);
    const c = makeNeutralControls();
    c.throttle = 0.5;
    c.steer = 0.9;
    c.handbrake = handbrake;
    let peakYaw = 0;
    let peakRearA = 0;
    for (let i = 0; i < 50; i += 1) {
      vehicle.update({ dt: 1 / 60, controls: c, physics });
      world.step();
      peakYaw = Math.max(peakYaw, Math.abs(physics.getFreshBody(vehicle.bodyHandle).angvel().y));
      peakRearA = Math.max(peakRearA, meanRearAbsAlpha(vehicle));
    }
    return { peakYaw, peakRearA, snap: vehicle.snapshot() };
  }
  const off = await runHandbrake(false);
  const on = await runHandbrake(true);
  console.log(`    handbrake off rear|α|=${off.peakRearA.toFixed(3)} yaw=${off.peakYaw.toFixed(3)} | on rear|α|=${on.peakRearA.toFixed(3)} yaw=${on.peakYaw.toFixed(3)}`);
  assert.ok(
    on.peakRearA > off.peakRearA * 1.15 || on.peakYaw > off.peakYaw * 1.1,
    'handbrake increases rear slip or yaw vs baseline',
  );
  assert.ok(on.snap.wheels?.length === 4, 'snapshot wheels length 4');
  assert.equal(on.snap.handling?.model, 'controller-slip');
  assert.ok(Number.isFinite(on.snap.wheels[0].alphaDeg));
  ok('handbrake initiates more rear slip/yaw; snapshot shape');
}

// ---------------------------------------------------------------- assist ON vs OFF recovery (seeded spin)
{
  async function runAssist(enabled) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    makeFlatGround(world);
    const physics = makePhysics(world);
    const scene = new THREE.Scene();
    const vehicle = await spawn(physics, scene, {
      driftAssist: { enabled, strength: 1, recoveryEnvelopeDeg: 40, recoveryGripBoost: 0.55 },
      driveLayout: 'rwd',
    });
    settle(vehicle, physics, world, 50);
    const body = physics.getFreshBody(vehicle.bodyHandle);
    body.setLinvel({ x: 0, y: body.linvel().y, z: -16 }, true);
    // Seed a yaw spin + rear slip demand.
    body.setAngvel({ x: 0, y: 1.8, z: 0 }, true);
    const c = makeNeutralControls();
    c.throttle = 0.35;
    c.steer = -0.6; // countersteer input
    let peakYaw = 0;
    let sawRecovery = false;
    let sawCounter = false;
    const series = [];
    for (let i = 0; i < 60; i += 1) {
      vehicle.update({ dt: 1 / 60, controls: c, physics });
      world.step();
      const yaw = Math.abs(physics.getFreshBody(vehicle.bodyHandle).angvel().y);
      series.push(yaw);
      peakYaw = Math.max(peakYaw, yaw);
      if (vehicle.driftAssistTelemetry?.recoveryActive) sawRecovery = true;
      if (vehicle.driftAssistTelemetry?.countersteerActive) sawCounter = true;
    }
    const endYaw = series[series.length - 1];
    const tail = series.slice(-20);
    const meanTail = tail.reduce((a, b) => a + b, 0) / tail.length;
    const mid = series[15];
    return { peakYaw, endYaw, meanTail, mid, sawRecovery, sawCounter };
  }
  const off = await runAssist(false);
  const on = await runAssist(true);
  console.log(
    `    assist recovery meanTail off=${off.meanTail.toFixed(3)} on=${on.meanTail.toFixed(3)} ` +
    `mid off=${off.mid.toFixed(3)} on=${on.mid.toFixed(3)} counter=${on.sawCounter}`,
  );
  assert.ok(off.endYaw < 1.2 && on.endYaw < 1.2, 'both recover below spin threshold');
  assert.ok(on.sawCounter || on.sawRecovery, 'assist ON engages countersteer/recovery');
  assert.equal(off.sawCounter, false);
  // Strict: assist must reduce yaw faster (mid) and keep mean tail lower.
  assert.ok(on.mid < off.mid * 0.9,
    `assist ON mid yaw (${on.mid.toFixed(3)}) faster than OFF (${off.mid.toFixed(3)})`);
  assert.ok(on.meanTail <= off.meanTail * 0.95 + 0.01,
    `assist ON meanTail (${on.meanTail.toFixed(3)}) ≤ OFF (${off.meanTail.toFixed(3)})`);
  ok('drift assist recovery ON vs OFF');
}

// ---------------------------------------------------------------- park holds under parked controls (issue 1)
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  makeFlatGround(world);
  const physics = makePhysics(world);
  const scene = new THREE.Scene();
  const vehicle = await spawn(physics, scene, {});
  settle(vehicle, physics, world, 40);
  vehicle.park(physics);
  assert.equal(vehicle.parkedMode, true);
  const body = physics.getFreshBody(vehicle.bodyHandle);
  const y0 = body.translation().y;
  const { makeParkedControls } = await import('../src/game/vehicles/BaseVehicle.js');
  const parked = makeParkedControls();
  for (let i = 0; i < 60; i += 1) {
    vehicle.update({ dt: 1 / 60, controls: parked, physics });
    world.step();
  }
  assert.equal(vehicle.parkedMode, true, 'parkedMode stays true under brake/handbrake');
  assert.ok(vehicle._parkedPose, 'park pose retained');
  const y1 = physics.getFreshBody(vehicle.bodyHandle).translation().y;
  assert.ok(Math.abs(y1 - y0) < 0.02, 'park pose holds height');
  ok('park holds under makeParkedControls (no unpark on brake)');
}

console.log(`\nverify-vehicle-drift: ${passed} checks passed`);
