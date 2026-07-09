// Guards geometric load transfer + ARB (docs/vehicle-advanced-suspension-plan.md M2).
//
//   - Braking (ax < 0) loads the front axle
//   - Cornering (ay > 0) loads outer (right) wheels
//   - Stiffer front ARB increases front L/R delta (understeer bias)
//   - Stiffer rear ARB increases rear L/R delta (oversteer bias)
//
// Pure-node math. Run: node scripts/verify-vehicle-load-transfer.mjs
//   npm run verify:vehicle-load

import assert from 'node:assert/strict';
import {
  computeAxleGeometry,
  computeBodyAccel,
  computeRollResistTorque,
  computeWheelLoads,
  resolveAntiRollConfig,
} from '../src/game/vehicles/LoadTransfer.js';
import { DEFAULT_VEHICLE_CONFIG } from '../src/game/config/vehicleConfig.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const anchors = [
  { x: -0.8, y: -0.4, z: -1.5 }, // FL
  { x: 0.8, y: -0.4, z: -1.5 },  // FR
  { x: -0.8, y: -0.4, z: 1.5 },  // RL
  { x: 0.8, y: -0.4, z: 1.5 },   // RR
];

const wheels = [
  { isFront: true, isLeft: true, inContact: true },
  { isFront: true, isLeft: false, inContact: true },
  { isFront: false, isLeft: true, inContact: true },
  { isFront: false, isLeft: false, inContact: true },
];

// ---------------------------------------------------------------- geometry
{
  const g = computeAxleGeometry(anchors);
  assert.ok(Math.abs(g.L - 3.0) < 1e-6, `wheelbase L=${g.L}`);
  assert.ok(Math.abs(g.a - 1.5) < 1e-6 && Math.abs(g.b - 1.5) < 1e-6);
  assert.ok(Math.abs(g.trackFront - 1.6) < 1e-6);
  ok('axle geometry from wheel anchors');
}

// ---------------------------------------------------------------- static loads
{
  const g = computeAxleGeometry(anchors);
  const r = computeWheelLoads({
    mass: 1000,
    ax: 0,
    ay: 0,
    geometry: g,
    wheels,
    loadTransfer: { blendSusp: 0 },
  });
  const front = r.loads[0] + r.loads[1];
  const rear = r.loads[2] + r.loads[3];
  assert.ok(Math.abs(front - r.staticFront) < 1, 'front axle ≈ staticFront');
  assert.ok(Math.abs(rear - r.staticRear) < 1, 'rear axle ≈ staticRear');
  assert.ok(Math.abs(front + rear - 1000 * 9.81) < 2, 'total = weight');
  ok('static axle loads sum to weight');
}

// ---------------------------------------------------------------- braking loads front
{
  const g = computeAxleGeometry(anchors);
  const coast = computeWheelLoads({
    mass: 1000, ax: 0, ay: 0, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55 },
  });
  // ax < 0 = decelerating in travel direction → load moves forward.
  const brake = computeWheelLoads({
    mass: 1000, ax: -6, ay: 0, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55 },
  });
  const coastFront = coast.loads[0] + coast.loads[1];
  const brakeFront = brake.loads[0] + brake.loads[1];
  assert.ok(brakeFront > coastFront, `braking loads front (${brakeFront.toFixed(0)} > ${coastFront.toFixed(0)})`);
  assert.ok(brake.dLong < 0, 'dLong negative under braking');
  ok('braking loads the front axle');
}

// ---------------------------------------------------------------- accel unloads front
{
  const g = computeAxleGeometry(anchors);
  const coast = computeWheelLoads({
    mass: 1000, ax: 0, ay: 0, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55 },
  });
  const accel = computeWheelLoads({
    mass: 1000, ax: 5, ay: 0, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55 },
  });
  const coastFront = coast.loads[0] + coast.loads[1];
  const accelFront = accel.loads[0] + accel.loads[1];
  assert.ok(accelFront < coastFront, 'accel unloads front');
  ok('acceleration unloads the front axle');
}

// ---------------------------------------------------------------- cornering loads outer
{
  const g = computeAxleGeometry(anchors);
  // ay > 0 = rightward accel → right (outer) wheels load up.
  const turn = computeWheelLoads({
    mass: 1000, ax: 0, ay: 8, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55 },
    antiRoll: { front: 0.5, rear: 0.5 },
  });
  assert.ok(turn.loads[1] > turn.loads[0], 'FR > FL under +ay');
  assert.ok(turn.loads[3] > turn.loads[2], 'RR > RL under +ay');
  ok('cornering loads outer wheels');
}

// ---------------------------------------------------------------- ARB front vs rear balance
{
  const g = computeAxleGeometry(anchors);
  const base = {
    mass: 1000, ax: 0, ay: 8, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55 },
  };
  const frontStiff = computeWheelLoads({
    ...base,
    antiRoll: { front: 0.85, rear: 0.25 },
  });
  const rearStiff = computeWheelLoads({
    ...base,
    antiRoll: { front: 0.25, rear: 0.85 },
  });
  const frontDeltaF = Math.abs(frontStiff.loads[1] - frontStiff.loads[0]);
  const frontDeltaR = Math.abs(rearStiff.loads[1] - rearStiff.loads[0]);
  const rearDeltaF = Math.abs(frontStiff.loads[3] - frontStiff.loads[2]);
  const rearDeltaR = Math.abs(rearStiff.loads[3] - rearStiff.loads[2]);
  // Stiffer front ARB → larger front L/R delta (understeer).
  assert.ok(frontDeltaF > frontDeltaR,
    `front ARB raises front ΔL/R (${frontDeltaF.toFixed(0)} > ${frontDeltaR.toFixed(0)})`);
  // Stiffer rear ARB → larger rear L/R delta (oversteer).
  assert.ok(rearDeltaR > rearDeltaF,
    `rear ARB raises rear ΔL/R (${rearDeltaR.toFixed(0)} > ${rearDeltaF.toFixed(0)})`);
  ok('ARB front increases understeer bias; rear increases oversteer bias');
}

// ---------------------------------------------------------------- body accel helper
{
  const prev = { x: 0, y: 0, z: -10 };
  const vel = { x: 2, y: 0, z: -12 };
  const forward = { x: 0, y: 0, z: -1 };
  const right = { x: 1, y: 0, z: 0 };
  const a = computeBodyAccel(prev, vel, 0.1, forward, right);
  // Δv along forward (−Z): (−12)−(−10)=−2 over 0.1s → ax contribution from z is +20
  // wait: dvz = -2/0.1 = -20; forward·dv = (0,0,-1)·(20,0,-20) along axes:
  // dv = (20, 0, -20); ax = 20*0 + 0 + (-20)*(-1) = 20. Good (accelerating forward).
  assert.ok(a.ax > 15, `ax≈20 got ${a.ax}`);
  assert.ok(a.ay > 15, `ay≈20 got ${a.ay}`);
  ok('body-frame accel from linvel samples');
}

// ---------------------------------------------------------------- roll resist
{
  const t = computeRollResistTorque({
    rollRate: 1,
    rollAngle: 0.1,
    antiRoll: resolveAntiRollConfig(DEFAULT_VEHICLE_CONFIG.ground.antiRoll),
    groundedFraction: 1,
  });
  assert.ok(t < 0, 'roll resist opposes positive roll');
  ok('roll-resist torque opposes roll');
}

// ---------------------------------------------------------------- config
{
  assert.ok(DEFAULT_VEHICLE_CONFIG.ground.loadTransfer);
  assert.ok(DEFAULT_VEHICLE_CONFIG.ground.antiRoll.front > DEFAULT_VEHICLE_CONFIG.ground.antiRoll.rear);
  ok('vehicleConfig loadTransfer + understeer-safe ARB');
}

// ---------------------------------------------------------------- absolute lateral magnitude (no half-scale bug)
{
  const g = computeAxleGeometry(anchors);
  const turn = computeWheelLoads({
    mass: 1000, ax: 0, ay: 8, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55, useGeometric: true },
    antiRoll: { front: 0.5, rear: 0.5 },
  });
  // Outer−inner should be ~2 * dLat (full transfer, not half).
  const frontDelta = turn.loads[1] - turn.loads[0];
  assert.ok(Math.abs(frontDelta - 2 * turn.dLatFront) < 5,
    `front outer−inner ≈ 2·dLat (${frontDelta.toFixed(0)} vs ${(2 * turn.dLatFront).toFixed(0)})`);
  ok('lateral transfer absolute magnitude (full dLat)');
}

// ---------------------------------------------------------------- edge cases: blendSusp, airborne, useGeometric false, dt≤0
{
  const g = computeAxleGeometry(anchors);
  const geo = computeWheelLoads({
    mass: 1000, ax: 0, ay: 0, geometry: g,
    wheels: wheels.map((w) => ({ ...w, suspForce: 500 })),
    loadTransfer: { blendSusp: 1, useGeometric: true },
  });
  assert.ok(geo.loads.every((L) => Math.abs(L - 500) < 1e-6), 'blendSusp=1 uses susp force');

  const air = computeWheelLoads({
    mass: 1000, ax: 0, ay: 0, geometry: g,
    wheels: wheels.map((w, i) => ({ ...w, inContact: i !== 0 })),
    loadTransfer: { blendSusp: 0 },
  });
  assert.equal(air.loads[0], 0, 'airborne wheel load = 0');

  const nog = computeWheelLoads({
    mass: 1000, ax: 5, ay: 8, geometry: g, wheels,
    loadTransfer: { useGeometric: false, blendSusp: 0 },
  });
  assert.equal(nog.dLong, 0);
  assert.equal(nog.dLatFront, 0);

  const a0 = computeBodyAccel({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 });
  assert.equal(a0.ax, 0);
  assert.equal(a0.ay, 0);
  ok('blendSusp / airborne / useGeometric false / dt≤0 edges');
}

// ---------------------------------------------------------------- hard corner: inner clamp conserves axle load (issue 54)
{
  const g = computeAxleGeometry(anchors);
  // Huge ay so raw inner would go negative without redistribute.
  const hard = computeWheelLoads({
    mass: 1000, ax: 0, ay: 40, geometry: g, wheels,
    loadTransfer: { blendSusp: 0, hCG: 0.55, useGeometric: true },
    antiRoll: { front: 0.5, rear: 0.5 },
  });
  const frontSum = hard.loads[0] + hard.loads[1];
  const rearSum = hard.loads[2] + hard.loads[3];
  const weight = 1000 * 9.81;
  assert.ok(Math.abs(frontSum + rearSum - weight) < 5,
    `total Fz conserved under lift (${(frontSum + rearSum).toFixed(0)} vs ${weight.toFixed(0)})`);
  assert.ok(hard.loads[0] === 0 || hard.loads[1] === 0 || Math.min(hard.loads[0], hard.loads[1]) > 0,
    'inner may lift to 0');
  // Outer front should carry the whole front axle when inner is 0.
  if (hard.loads[0] === 0) {
    assert.ok(Math.abs(hard.loads[1] - hard.staticFront) < 5, 'outer gets full front axle');
  }
  ok('hard corner load conservation on lift');
}

console.log(`\nverify-vehicle-load-transfer: ${passed} checks passed`);