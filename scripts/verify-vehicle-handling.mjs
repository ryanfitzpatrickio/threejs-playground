// Overall handling regression umbrella (plan P6 / §6).
// Re-runs suspension / steer / first-drive under the active controller-slip model
// plus a short controller-fallback smoke, and asserts snapshot shape.
//
// Run: node scripts/verify-vehicle-handling.mjs
//   npm run verify:vehicle-handling

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BaseVehicle, makeNeutralControls } from '../src/game/vehicles/BaseVehicle.js';
import { DEFAULT_VEHICLE_CONFIG } from '../src/game/config/vehicleConfig.js';

const children = [
  'scripts/verify-vehicle-tire-model.mjs',
  'scripts/verify-vehicle-load-transfer.mjs',
  'scripts/verify-vehicle-powertrain.mjs',
  'scripts/verify-vehicle-suspension-dynamics.mjs',
  'scripts/verify-vehicle-drift.mjs',
  'scripts/verify-vehicle-steering.mjs',
  'scripts/verify-vehicle-first-drive.mjs',
  'scripts/verify-vehicle-suspension.mjs',
];

console.log('--- verify:vehicle-handling umbrella ---\n');
console.log(`handlingModel default: ${DEFAULT_VEHICLE_CONFIG.ground.handlingModel}`);

let failed = 0;
for (const script of children) {
  console.log(`\n>> ${script}`);
  const r = spawnSync(process.execPath, [script], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAIL ${script} exit=${r.status}`);
  } else {
    console.log(`PASS ${script}`);
  }
}

// ---------------------------------------------------------------- controller fallback smoke + snapshot shape
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
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(80, 2, 80).setFriction(0.55).setRestitution(0),
    ground,
  );
  const physics = { RAPIER, world, getFreshBody: (h) => world.bodies.get(h) };
  const scene = new THREE.Scene();

  // Fallback model.
  const vCtrl = new BaseVehicle({
    position: new THREE.Vector3(),
    chassisOverlay: false,
    config: { ground: { handlingModel: 'controller' } },
  });
  vCtrl.spawnPosition.y = vCtrl.getGroundSpawnClearance();
  await vCtrl.spawn({ scene, physics });
  vCtrl.wakeForDrive(physics);
  const c = makeNeutralControls();
  c.throttle = 1;
  let maxSpd = 0;
  for (let i = 0; i < 120; i += 1) {
    vCtrl.update({ dt: 1 / 60, controls: c, physics });
    world.step();
    const v = physics.getFreshBody(vCtrl.bodyHandle).linvel();
    maxSpd = Math.max(maxSpd, Math.hypot(v.x, v.z));
  }
  assert.ok(maxSpd > 5, `controller fallback moves (spd=${maxSpd.toFixed(1)})`);
  assert.ok(vCtrl.grounded, 'controller fallback grounded');
  console.log(`  ✓ controller fallback smoke (maxSpd=${maxSpd.toFixed(1)})`);

  // Snapshot shape under controller-slip.
  const vSlip = new BaseVehicle({
    position: new THREE.Vector3(10, 0, 0),
    chassisOverlay: false,
    config: { ground: { handlingModel: 'controller-slip', driveLayout: 'rwd' } },
  });
  vSlip.spawnPosition.y = vSlip.getGroundSpawnClearance();
  await vSlip.spawn({ scene, physics });
  vSlip.wakeForDrive(physics);
  const c2 = makeNeutralControls();
  c2.throttle = 0.6;
  c2.steer = 0.4;
  for (let i = 0; i < 90; i += 1) {
    vSlip.update({ dt: 1 / 60, controls: c2, physics });
    world.step();
  }
  const snap = vSlip.snapshot();
  assert.equal(snap.handlingModel, 'controller-slip');
  assert.equal(snap.handling?.model, 'controller-slip');
  assert.ok(Array.isArray(snap.wheels) && snap.wheels.length === 4);
  assert.ok(Number.isFinite(snap.wheels[0].alphaDeg));
  assert.ok(Number.isFinite(snap.wheels[0].kappa));
  assert.ok(Number.isFinite(snap.handling.heaveVel));
  assert.ok(Number.isFinite(snap.handling.pitch));
  assert.ok(Number.isFinite(snap.handling.roll));
  // P0 overlay: DebugPanel deleted — snapshot is the telemetry contract.
  console.log('  ✓ snapshot tyre telemetry shape (DebugPanel deleted; snapshot-only P0)');

  // RWD throttle → rear engineForce nonzero, front ~0 (issue 56).
  {
    const cRwd = makeNeutralControls();
    cRwd.throttle = 1;
    for (let i = 0; i < 30; i += 1) {
      vSlip.update({ dt: 1 / 60, controls: cRwd, physics });
      world.step();
    }
    const frontF = vSlip.wheelTelemetry
      .filter((w) => w?.isFront)
      .reduce((s, w) => s + Math.abs(w.engineForce ?? 0), 0);
    const rearF = vSlip.wheelTelemetry
      .filter((w) => w && !w.isFront)
      .reduce((s, w) => s + Math.abs(w.engineForce ?? 0), 0);
    assert.ok(rearF > 50, `RWD rear engineForce nonzero (${rearF.toFixed(0)})`);
    assert.ok(frontF < 1, `RWD front engineForce ~0 (${frontF.toFixed(0)})`);
    console.log(`  ✓ RWD engineForce rear-only (rear=${rearF.toFixed(0)} front=${frontF.toFixed(0)})`);
  }

  // Hard brake → front Fz sum > rear (issue 56).
  {
    const body = physics.getFreshBody(vSlip.bodyHandle);
    body.setLinvel({ x: 0, y: body.linvel().y, z: -20 }, true);
    const cBrk = makeNeutralControls();
    cBrk.brake = 1;
    for (let i = 0; i < 25; i += 1) {
      vSlip.update({ dt: 1 / 60, controls: cBrk, physics });
      world.step();
    }
    const frontFz = vSlip.wheelTelemetry
      .filter((w) => w?.isFront)
      .reduce((s, w) => s + (w.Fz ?? 0), 0);
    const rearFz = vSlip.wheelTelemetry
      .filter((w) => w && !w.isFront)
      .reduce((s, w) => s + (w.Fz ?? 0), 0);
    assert.ok(frontFz > rearFz,
      `brake loads front Fz (${frontFz.toFixed(0)}) > rear (${rearFz.toFixed(0)})`);
    console.log(`  ✓ hard brake front Fz > rear (${frontFz.toFixed(0)} > ${rearFz.toFixed(0)})`);
  }
}

if (failed > 0) {
  console.error(`\nverify-vehicle-handling: ${failed} child script(s) failed`);
  process.exit(1);
}
console.log('\nverify-vehicle-handling: all children + smokes passed');
