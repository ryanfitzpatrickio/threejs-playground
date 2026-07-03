// Measures Rapier world.step() alone with terrain heightfields, static city-like
// colliders, dynamic debris, and a driven raycast vehicle in the world.
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';

await RAPIER.init();

async function measure(stepHz) {
  const level = createStreamingTerrainLevel({}, { worldMap: null });
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 });
  physics.world.numSolverIterations = 8;
  physics.world.numInternalPgsIterations = 2;
  for (const chunk of level.terrainChunks) physics.createTerrainHeightfield(chunk, chunk.chunkKey ?? null);
  // Representative streamed-city broad phase load without involving rendering.
  for (let z = -8; z <= 8; z += 1) {
    for (let x = -8; x <= 8; x += 1) {
      const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(5, 4 + ((x + z) & 3), 5).setTranslation(x * 14, 4, z * 14),
        body,
      );
    }
  }
  for (let i = 0; i < 80; i += 1) {
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation((i % 10) * 2, 3 + (i % 4), -20 - Math.floor(i / 10) * 2));
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.35, 0.35, 0.35), body);
  }
  const vehicles = new VehicleSystem();
  vehicles.initialize({ physics, scene: new THREE.Scene(), level });
  const vehicle = new BaseVehicle({ position: level.spawnPoint.clone(), model: new THREE.Group(), chassisOverlay: false });
  await vehicles.spawnVehicle({ vehicle });
  vehicles.activeVehicle = vehicle;
  const dt = 1 / stepHz;
  const controls = { throttle: 1, steer: 0.15, brake: 0, handbrake: false, boost: false };
  const samples = [];
  for (let tick = 0; tick < stepHz * 8; tick += 1) {
    vehicle.update({ dt, controls, physics, integrate: false });
    vehicle.substepIntegrate({ dt, physics });
    physics.world.timestep = dt;
    const start = performance.now();
    physics.world.step();
    if (tick >= stepHz * 2) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)];
  return { stepHz, mean, p95 };
}

for (const result of [await measure(60), await measure(120)]) {
  console.log(`${result.stepHz} Hz physics: world.step mean=${result.mean.toFixed(3)}ms p95=${result.p95.toFixed(3)}ms`);
  for (const renderHz of [60, 120]) {
    console.log(`  ${renderHz} Hz render: ${(result.stepHz / renderHz).toFixed(2)} steps/frame, ${(result.mean * result.stepHz / renderHz).toFixed(3)}ms mean step budget/frame`);
  }
}
