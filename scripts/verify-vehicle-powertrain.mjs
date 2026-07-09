// Guards engine curve / gears / clutch / differentials (plan M5).
//
//   - Engine torque peaks mid-range then falls toward redline
//   - Gears + final drive scale wheel torque
//   - Clutch slip allows rev flare (open clutch + throttle)
//   - LSD biases torque to the higher-load wheel
//   - Open diff sends more torque to the freer/slipping wheel
//   - AWD centre split / RWD / FWD layouts selectable
//
// Pure-node math. Run: node scripts/verify-vehicle-powertrain.mjs
//   npm run verify:vehicle-powertrain

import assert from 'node:assert/strict';
import {
  engineTorque,
  gearRatio,
  resolvePowertrainConfig,
  stepPowertrain,
  wheelForceFromTorque,
  wheelTorqueFromEngine,
} from '../src/game/vehicles/Powertrain.js';
import {
  distributeDriveForce,
  resolveDifferentials,
  splitPair,
} from '../src/game/vehicles/Differential.js';
import { DEFAULT_VEHICLE_CONFIG } from '../src/game/config/vehicleConfig.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---------------------------------------------------------------- torque curve
{
  const eng = resolvePowertrainConfig().engine;
  const idle = engineTorque(eng.idleRPM, eng);
  const peak = engineTorque(eng.peakRPM, eng);
  const red = engineTorque(eng.redline, eng);
  const mid = engineTorque((eng.idleRPM + eng.peakRPM) * 0.5, eng);
  assert.ok(peak >= idle, 'peak ≥ idle torque');
  assert.ok(peak >= red, 'peak ≥ redline torque');
  assert.ok(mid > idle, 'mid-range above idle');
  assert.ok(Math.abs(peak - eng.peakTorque) < 1, `peak ≈ peakTorque (${peak})`);
  ok('engine torque curve peaks mid-range');
}

// ---------------------------------------------------------------- gears
{
  const cfg = resolvePowertrainConfig();
  const g1 = gearRatio(1, cfg.gears, cfg.finalDrive);
  const g5 = gearRatio(5, cfg.gears, cfg.finalDrive);
  assert.ok(g1 > g5, '1st overall ratio > 5th');
  const Tw1 = wheelTorqueFromEngine({ rpm: 4000, throttle: 1, gearIndex: 1, clutchLock: 1, config: cfg });
  const Tw5 = wheelTorqueFromEngine({ rpm: 4000, throttle: 1, gearIndex: 5, clutchLock: 1, config: cfg });
  assert.ok(Tw1 > Tw5, '1st gear multiplies wheel torque more');
  const F = wheelForceFromTorque(Tw1, 0.38);
  assert.ok(F > 0, 'wheel force positive');
  ok('gears + final drive → wheel torque / force');
}

// ---------------------------------------------------------------- clutch rev flare
{
  const cfg = resolvePowertrainConfig({ autoShift: false });
  // Stationary wheels, full throttle: clutch opens and RPM should climb above locked.
  let rpm = 900;
  let gear = 1;
  let timer = 0;
  for (let i = 0; i < 30; i += 1) {
    const s = stepPowertrain({
      rpm,
      gear,
      throttle: 1,
      driveWheelSpeed: 0.5,
      dt: 1 / 60,
      shiftTimer: timer,
      config: cfg,
      mass: 1000,
      enginePower: 7.5,
    });
    rpm = s.rpm;
    gear = s.gear;
    timer = s.shiftTimer;
  }
  assert.ok(rpm > 1500, `rev flare under load-less throttle (rpm=${rpm.toFixed(0)})`);
  ok('clutch slip allows rev flare');
}

// ---------------------------------------------------------------- step produces drive force
{
  const s = stepPowertrain({
    rpm: 4000,
    gear: 2,
    throttle: 1,
    driveWheelSpeed: 12,
    dt: 1 / 60,
    config: resolvePowertrainConfig(),
    mass: 1000,
    enginePower: 7.5,
  });
  assert.ok(s.totalDriveForce > 100, `drive force ${s.totalDriveForce.toFixed(0)} N`);
  assert.ok(s.clutchLock > 0 && s.clutchLock <= 1);
  ok('stepPowertrain yields drive force + clutch state');
}

// ---------------------------------------------------------------- disabled falls back to flat enginePower
{
  const s = stepPowertrain({
    rpm: 4000,
    gear: 1,
    throttle: 1,
    driveWheelSpeed: 10,
    config: { enabled: false },
    mass: 200,
    enginePower: 7.5,
  });
  assert.ok(Math.abs(s.totalDriveForce - 7.5 * 200) < 1e-6, 'flat enginePower*mass');
  ok('powertrain disabled → flat enginePower model');
}

// ---------------------------------------------------------------- splitPair open vs LSD
{
  const [oA, oB] = splitPair('open', 0.5, 100, 1000, 1.0, 0.0);
  assert.ok(oA > oB, 'open diff prefers free/slipping low-load wheel');

  const [lA, lB] = splitPair('lsd', 0.7, 100, 1000, 1.0, 0.0);
  assert.ok(lB > lA, 'LSD biases to higher-load / lower-slip wheel');

  const [kA, kB] = splitPair('locked', 0.5, 100, 1000, 1, 0);
  assert.ok(Math.abs(kA - 0.5) < 1e-6 && Math.abs(kB - 0.5) < 1e-6, 'locked = 50/50');
  ok('open vs LSD vs locked pair split');
}

// ---------------------------------------------------------------- distribute layouts
{
  const wheels = [
    { isFront: true, isLeft: true, load: 400, slip: 0.1, inContact: true },
    { isFront: true, isLeft: false, load: 400, slip: 0.1, inContact: true },
    { isFront: false, isLeft: true, load: 500, slip: 0.2, inContact: true },
    { isFront: false, isLeft: false, load: 500, slip: 0.05, inContact: true },
  ];
  const total = 1000;
  const rwd = distributeDriveForce({ totalForce: total, driveLayout: 'rwd', wheels });
  assert.ok(Math.abs(rwd[0]) < 1e-6 && Math.abs(rwd[1]) < 1e-6, 'RWD zero front');
  assert.ok(Math.abs(rwd[2] + rwd[3] - total) < 1, 'RWD all rear');

  const fwd = distributeDriveForce({ totalForce: total, driveLayout: 'fwd', wheels });
  assert.ok(Math.abs(fwd[2]) < 1e-6 && Math.abs(fwd[3]) < 1e-6, 'FWD zero rear');
  assert.ok(Math.abs(fwd[0] + fwd[1] - total) < 1, 'FWD all front');

  const awd = distributeDriveForce({
    totalForce: total,
    driveLayout: 'awd',
    wheels,
    differentials: { centre: { type: 'lsd', bias: 0.55 } },
  });
  const frontSum = awd[0] + awd[1];
  const rearSum = awd[2] + awd[3];
  assert.ok(frontSum > 100 && rearSum > 100, 'AWD splits both axles');
  assert.ok(Math.abs(frontSum + rearSum - total) < 2, 'AWD conserves force');
  // Rear bias 0.55 → rear should get a bit more on average.
  assert.ok(rearSum > frontSum * 0.8, 'AWD centre bias keeps rear competitive');
  ok('RWD / FWD / AWD layouts distribute force');
}

// ---------------------------------------------------------------- LSD axle bias to high-load wheel
{
  const wheels = [
    { isFront: false, isLeft: true, load: 200, slip: 0.8, inContact: true },
    { isFront: false, isLeft: false, load: 800, slip: 0.05, inContact: true },
    { isFront: true, isLeft: true, load: 0, slip: 0, inContact: false },
    { isFront: true, isLeft: false, load: 0, slip: 0, inContact: false },
  ];
  // Indices: 0 RL light spinning, 1 RR heavy planted — but isFront flags wrong order.
  // Rebuild with correct isFront for distribute (fronts first is not required).
  const axle = [
    { isFront: true, isLeft: true, load: 1, slip: 0, inContact: true },
    { isFront: true, isLeft: false, load: 1, slip: 0, inContact: true },
    { isFront: false, isLeft: true, load: 200, slip: 0.9, inContact: true },
    { isFront: false, isLeft: false, load: 900, slip: 0.05, inContact: true },
  ];
  const forces = distributeDriveForce({
    totalForce: 1000,
    driveLayout: 'rwd',
    wheels: axle,
    differentials: { rear: { type: 'lsd', bias: 0.75 } },
  });
  assert.ok(forces[3] > forces[2],
    `LSD rear prefers high-load low-slip (RR=${forces[3].toFixed(0)} > RL=${forces[2].toFixed(0)})`);
  ok('LSD biases torque to higher-load wheel');
}

// ---------------------------------------------------------------- open axle prefers slipper
{
  const axle = [
    { isFront: true, isLeft: true, load: 400, slip: 0, inContact: true },
    { isFront: true, isLeft: false, load: 400, slip: 0, inContact: true },
    { isFront: false, isLeft: true, load: 400, slip: 1.2, inContact: true },
    { isFront: false, isLeft: false, load: 400, slip: 0.05, inContact: true },
  ];
  const forces = distributeDriveForce({
    totalForce: 1000,
    driveLayout: 'rwd',
    wheels: axle,
    differentials: { rear: { type: 'open', bias: 0.5 } },
  });
  assert.ok(forces[2] > forces[3],
    `open rear prefers spinning wheel (RL=${forces[2].toFixed(0)} > RR=${forces[3].toFixed(0)})`);
  ok('open diff sends torque to the slipping wheel');
}

// ---------------------------------------------------------------- config wiring
{
  assert.ok(DEFAULT_VEHICLE_CONFIG.ground.powertrain?.enabled);
  assert.ok(DEFAULT_VEHICLE_CONFIG.ground.differentials?.centre);
  assert.ok(['rwd', 'fwd', 'awd'].includes(DEFAULT_VEHICLE_CONFIG.ground.driveLayout));
  const d = resolveDifferentials(DEFAULT_VEHICLE_CONFIG.ground.differentials);
  assert.equal(d.centre.type, 'lsd');
  assert.doesNotThrow(() => resolvePowertrainConfig(null));
  assert.doesNotThrow(() => resolveDifferentials(null));
  ok('vehicleConfig powertrain + differentials present');
}

// ---------------------------------------------------------------- auto-shift + soft-cap + gear force order
{
  const cfg = resolvePowertrainConfig({ autoShift: true, upshiftRPM: 5000, shiftTime: 0.05 });
  let rpm = 5200;
  let gear = 1;
  let timer = 0;
  for (let i = 0; i < 20; i += 1) {
    const s = stepPowertrain({
      rpm, gear, throttle: 1, driveWheelSpeed: 18, dt: 1 / 60, shiftTimer: timer,
      config: cfg, mass: 1000, enginePower: 7.5,
    });
    rpm = s.rpm;
    gear = s.gear;
    timer = s.shiftTimer;
  }
  assert.ok(gear >= 2, `auto-shift upshifts under throttle (gear=${gear})`);

  const g1 = stepPowertrain({
    rpm: 4000, gear: 1, throttle: 1, driveWheelSpeed: 8, dt: 1 / 60,
    config: resolvePowertrainConfig({ autoShift: false }), mass: 1000, enginePower: 7.5,
  });
  const g5 = stepPowertrain({
    rpm: 4000, gear: 5, throttle: 1, driveWheelSpeed: 30, dt: 1 / 60,
    config: resolvePowertrainConfig({ autoShift: false }), mass: 1000, enginePower: 7.5,
  });
  assert.ok(Math.abs(g1.totalDriveForce) > Math.abs(g5.totalDriveForce),
    '1st gear force > 5th at similar rpm demand');
  assert.ok(Math.abs(g1.totalDriveForce) <= g1.flatPeak + 1e-3, 'force ≤ soft-cap flatPeak');
  ok('auto-shift + soft-cap + 1st>5th launch force');
}

// ---------------------------------------------------------------- airborne force renormalization conserves total
{
  const wheels = [
    { isFront: true, isLeft: true, load: 400, slip: 0.1, inContact: true },
    { isFront: true, isLeft: false, load: 400, slip: 0.1, inContact: false },
    { isFront: false, isLeft: true, load: 500, slip: 0.1, inContact: true },
    { isFront: false, isLeft: false, load: 500, slip: 0.1, inContact: true },
  ];
  const total = 1000;
  const forces = distributeDriveForce({
    totalForce: total, driveLayout: 'awd', wheels,
    differentials: { centre: { type: 'locked', bias: 0.5 } },
  });
  const sum = forces.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - total) < 2, `airborne redistribute conserves force (${sum})`);
  assert.equal(forces[1], 0, 'airborne wheel gets 0');
  ok('airborne force renormalization conserves total');
}

// ---------------------------------------------------------------- reverse does not upshift
{
  const cfg = resolvePowertrainConfig({ autoShift: true, upshiftRPM: 3000 });
  let rpm = 5000;
  let gear = 1;
  let timer = 0;
  for (let i = 0; i < 15; i += 1) {
    const s = stepPowertrain({
      rpm, gear, throttle: -1, driveWheelSpeed: -5, dt: 1 / 60, shiftTimer: timer,
      config: cfg, mass: 1000, enginePower: 7.5,
    });
    rpm = s.rpm; gear = s.gear; timer = s.shiftTimer;
  }
  assert.equal(gear, 1, 'no upshift under reverse throttle');
  ok('auto-shift gated off reverse');
}

console.log(`\nverify-vehicle-powertrain: ${passed} checks passed`);
