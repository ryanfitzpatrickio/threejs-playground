// Isolate the downforce-saturation bounce on FLAT ground at highway speed, with
// the v^2 downforce CAPPED vs UNCAPPED. On flat ground the only vertical
// excitation is the suspension + downforce, so this cleanly shows whether the
// uncapped v^2 downforce saturates the springs and bounces the car at speed
// (the high-speed "pop"), and whether the cap removes it.
//
// Run: node scripts/probe-downforce-cap.mjs

function ctx() { const g = { addColorStop() {} }; return new Proxy({}, { get: (_t, p) => p === 'createLinearGradient' || p === 'createRadialGradient' ? (() => g) : p === 'getImageData' ? (() => ({ data: new Uint8ClampedArray(4) })) : (() => {}), set: () => true }); }
const canvas = () => ({ width: 64, height: 64, getContext: ctx, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {} });
globalThis.document = { createElement: (t) => t === 'canvas' ? canvas() : { style: {}, appendChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {} }, createElementNS: () => canvas() };

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

await RAPIER.init();
const dt = 0.016;

async function run(downforceMaxAccel, speed) {
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 });
  physics.world.numSolverIterations = 8;
  // Flat floor.
  const floor = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const fd = RAPIER.ColliderDesc.cuboid(4000, 0.5, 4000).setTranslation(0, -0.5, 0).setFriction(0.85);
  physics.world.createCollider(fd, floor);
  physics.world.step();

  const scene = new THREE.Scene();
  const vs = new VehicleSystem();
  vs.initialize({ physics, scene, level: null });
  const veh = new BaseVehicle({ position: new THREE.Vector3(0, 1.2, 0), rotationY: 0, config: { ground: { downforceMaxAccel } } });
  await vs.spawnVehicle({ vehicle: veh, snapToGround: false });
  vs.activeVehicle = veh;
  const bodyOf = () => physics.world.bodies.get(veh.bodyHandle);

  for (let i = 0; i < 90; i += 1) { // settle on flat ground
    veh.update({ dt, controls: { throttle: 0, steer: 0, brake: 0, handbrake: false, boost: false }, physics });
    physics.world.step();
  }

  const drive = { moveX: 0, moveZ: 0, jump: false, slide: false, brace: false, mountPressed: false };
  let prevVy = bodyOf().linvel().y;
  let sumJerk = 0, maxJerk = 0, sumGF = 0, n = 0, ySwingLo = Infinity, ySwingHi = -Infinity;
  for (let f = 0; f < 1200; f += 1) {
    vs.update({ delta: dt, input: drive, character: stub(veh), level: null });
    const b = bodyOf(); const v = b.linvel();
    b.setLinvel({ x: 0, y: v.y, z: -speed }, true); // force highway speed on flat ground
    physics.world.step();
    const nv = bodyOf().linvel();
    const y = bodyOf().translation().y;
    if (f > 60) {
      const dVy = nv.y - prevVy; sumJerk += Math.abs(dVy); maxJerk = Math.max(maxJerk, Math.abs(dVy));
      sumGF += veh.groundedFraction; n += 1; ySwingLo = Math.min(ySwingLo, y); ySwingHi = Math.max(ySwingHi, y);
    }
    prevVy = nv.y;
  }
  return { cap: downforceMaxAccel, speed, sumJerk: +sumJerk.toFixed(1), maxJerk: +maxJerk.toFixed(2), grounded: +(sumGF / n).toFixed(2), ySwing: +(ySwingHi - ySwingLo).toFixed(3) };
}

for (const speed of [45, 64]) {
  const uncapped = await run(null, speed);
  const capped = await run(16, speed);
  const f = (r) => `Σ|ΔVy|=${r.sumJerk} max|ΔVy|=${r.maxJerk} grounded=${r.grounded} ySwing=${r.ySwing}m`;
  console.log(`\n@ ${speed} m/s on FLAT ground:`);
  console.log('  downforce UNCAPPED:', f(uncapped));
  console.log('  downforce CAP 16  :', f(capped));
  const d = uncapped.sumJerk ? Math.round((1 - capped.sumJerk / uncapped.sumJerk) * 100) : 0;
  console.log(`  -> cap cuts vertical jerk ${d >= 0 ? '' : '+'}${-d < 0 ? '-' : ''}${Math.abs(d)}%`);
}

function stub(vehicle) { return { group: vehicle.group, velocity: new THREE.Vector3(), verticalVelocity: 0, grounded: true, vehicle: { active: true, vehicle, seatIndex: vehicle.driverSeatIndex, handTargets: null, anchorOffset: null }, animationController: { play() {} } }; }
