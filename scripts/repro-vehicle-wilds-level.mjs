// Probe the `wilds` LEVEL (createWildsLevel) — distinct from a wilds ZONE in the
// streaming world. createWildsLevel feeds terrain.heights (from three's
// TerrainGenerator) into ONE big heightfield. createTerrainHeightfield SILENTLY
// returns with no collider if heights.length !== resolution*resolution, so a
// layout/length mismatch here would leave the entire wilds level with NO ground
// collider (car AND character fall forever).
//
// Run: node scripts/repro-vehicle-wilds-level.mjs

globalThis.document = {
  createElementNS: () => ({ addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, style: {} }),
};

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createWildsLevel } from '../src/game/world/createWildsLevel.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

await RAPIER.init();

let level;
try {
  level = createWildsLevel({});
} catch (e) {
  console.log('createWildsLevel threw:', e.message);
  process.exit(0);
}

const tc = level.terrainChunks[0];
console.log('wilds terrainChunk:', {
  cx: tc.cx, cz: tc.cz, size: tc.size, resolution: tc.resolution,
  heightsLen: tc.heights?.length,
  expectedLen: tc.resolution * tc.resolution,
  match: tc.heights?.length === tc.resolution * tc.resolution,
  sampleHeights: tc.heights ? [tc.heights[0], tc.heights[Math.floor(tc.heights.length / 2)], tc.heights[tc.heights.length - 1]] : null,
});
console.log('spawnPoint:', level.spawnPoint);

const physics = new PhysicsSystem();
physics.RAPIER = RAPIER;
physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
physics.world.numSolverIterations = 8;

// Exactly what PhysicsSystem.createStaticLevelColliders does for the wilds level.
for (const c of level.colliders ?? []) physics.createStaticCollider(c, c.chunkKey ?? null);
for (const tcc of level.terrainChunks) physics.createTerrainHeightfield(tcc, tcc.chunkKey ?? null);
physics.world.step();

// Does a downward raycast at the spawn hit anything?
const spawn = level.spawnPoint;
const from = { x: spawn.x, y: spawn.y + 300, z: spawn.z };
const ray = new RAPIER.Ray(from, { x: 0, y: -1, z: 0 });
const hit = physics.world.castRay(ray, 2000, true);
const colliderTop = hit ? from.y - (hit.timeOfImpact ?? hit.toi) : null;
console.log(`raycast under spawn: ${hit ? `HIT @ ${colliderTop.toFixed(2)}` : 'NO HIT (no collider)'}`);

const vs = new VehicleSystem();
vs.initialize({ physics, scene: new THREE.Scene(), level });
const veh = new BaseVehicle({ position: spawn.clone(), rotationY: 0 });
await vs.spawnVehicle({ vehicle: veh });

let minY = veh.spawnPosition.y;
let lastY = minY;
for (let i = 0; i < 300; i += 1) {
  veh.update({ dt: 0.016, controls: null, physics });
  physics.world.step();
  const y = physics.world.bodies.get(veh.bodyHandle).translation().y;
  if (y < minY) minY = y;
  lastY = y;
}
const surface = level.getGroundHeightAt(spawn, 0);
console.log(
  `chassis: spawnY=${veh.spawnPosition.y.toFixed(2)} surface=${surface.toFixed(2)} ` +
  `final=${lastY.toFixed(2)} minY=${minY.toFixed(2)} -> ` +
  `${lastY < surface - 5 ? 'FELL THROUGH' : 'rested'}`,
);
