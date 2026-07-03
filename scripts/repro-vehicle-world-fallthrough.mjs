// Decisive repro for "the car falls through terrain / wilds / roads in the world."
//
// The existing verify scripts either (a) build a SYNTHETIC heightfield and step a
// dynamic chassis (verify:vehicle-suspension) or (b) build the REAL streaming
// terrain + heightfields but only check the spawn-snap MATH and never step the
// dynamic body (verify:vehicle-wilds-spawn). Neither covers the combination that
// actually fails at runtime: REAL streaming/wilds heightfield + dynamic chassis
// stepping to rest. This script builds that combination and lets physics run, then
// reports whether the chassis rests on the surface or falls to the void.
//
// Run: node scripts/repro-vehicle-world-fallthrough.mjs

// Headless DOM stub so createTerrainBiomeMaterial's TextureLoader doesn't throw.
globalThis.document = {
  createElementNS: () => ({
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
  }),
};

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

await RAPIER.init();

const NEUTRAL = null; // vehicle.update() falls back to makeNeutralControls()

function buildScene(worldMap, spawn) {
  const level = createStreamingTerrainLevel({}, { worldMap });

  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.world.numSolverIterations = 8;
  physics.world.numInternalPgsIterations = 2;

  // Initial ring (around world ORIGIN) — exactly what PhysicsSystem.initialize does.
  for (const tc of level.terrainChunks) {
    physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
  }
  // One streaming tick around the spawn, like GameRuntime.update does each frame.
  const changes = level.updateStreaming(new THREE.Vector3(spawn.x, 0, spawn.z));
  for (const tc of changes.addedTerrainChunks ?? []) {
    physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
  }
  // Mirrors PhysicsSystem.initialize's trailing step so the query pipeline sees
  // the heightfields before any movement / raycast.
  physics.world.step();

  const vehicleSystem = new VehicleSystem();
  vehicleSystem.initialize({ physics, scene: new THREE.Scene(), level });

  return { level, physics, vehicleSystem };
}

function colliderTopAt(physics, x, fromY) {
  const from = { x, y: fromY + 300, z: 0 };
  const ray = new RAPIER.Ray(from, { x: 0, y: -1, z: 0 });
  const hit = physics.world.castRay(ray, 2000, true);
  if (!hit) return null;
  return from.y - (hit.timeOfImpact ?? hit.toi);
}

async function trial(label, worldMap, spawn) {
  const { level, physics, vehicleSystem } = buildScene(worldMap, spawn);

  const surfaceY = level.getGroundHeightAt(new THREE.Vector3(spawn.x, 0, spawn.z), 0);

  const vehicle = new BaseVehicle({ position: new THREE.Vector3(spawn.x, 0, spawn.z), rotationY: 0 });
  await vehicleSystem.spawnVehicle({ vehicle });
  const spawnY = vehicle.spawnPosition.y;
  const clearance = vehicle.getGroundSpawnClearance();

  const topY = colliderTopAt(physics, spawn.x, spawnY);

  let minY = spawnY;
  let lastY = spawnY;
  const dt = 0.016;
  const steps = 300; // ~4.8s of sim — plenty to settle or fall to the floor
  for (let i = 0; i < steps; i += 1) {
    vehicle.update({ dt, controls: NEUTRAL, physics });
    physics.world.step();
    const body = physics.world.bodies.get(vehicle.bodyHandle);
    const y = body.translation().y;
    if (y < minY) minY = y;
    lastY = y;
  }

  const fellThrough = lastY < surfaceY - 5;
  const verdict = fellThrough
    ? `FELL THROUGH (final ${lastY.toFixed(2)} vs surface ${surfaceY.toFixed(2)})`
    : `rested (final ${lastY.toFixed(2)})`;

  console.log(
    `[${label}] spawn=(${spawn.x},0,0) ` +
    `surface=${surfaceY.toFixed(2)} colliderTop=${topY == null ? 'NONE' : topY.toFixed(2)} ` +
    `spawnY=${spawnY.toFixed(2)} clr=${clearance.toFixed(2)} minY=${minY.toFixed(2)} -> ${verdict}`,
  );

  vehicleSystem.removeVehicle(vehicle);
  return { label, surfaceY, topY, spawnY, minY, lastY, fellThrough };
}

console.log('Repro: dynamic chassis on REAL streaming terrain heightfields\n');

const results = [];

// 1. Gentle base terrain at ORIGIN (inside the initial heightfield ring).
results.push(await trial(
  'base @origin',
  { name: 'base', spawn: { x: 0, z: 0 }, zones: [], roads: [], pois: [] },
  { x: 0, z: 0 },
));

// 2. Gentle base terrain FAR from origin — relies entirely on streaming.
results.push(await trial(
  'base @far x=300',
  { name: 'base-far', spawn: { x: 300, z: 0 }, zones: [], roads: [], pois: [] },
  { x: 300, z: 0 },
));

// 3. Wilds (alpine, amp 62) zone — the steepest terrain; streamed (x>96).
results.push(await trial(
  'wilds alpine x=160',
  {
    name: 'wilds',
    spawn: { x: 160, z: 0 },
    zones: [{ id: 'w', type: 'wilds', shape: 'rect', rect: { minX: 100, minZ: -80, maxX: 400, maxZ: 80 } }],
    roads: [], pois: [],
  },
  { x: 160, z: 0 },
));

// 4. Wilds near ORIGIN so it's covered by the initial ring too.
results.push(await trial(
  'wilds alpine @origin',
  {
    name: 'wilds-origin',
    spawn: { x: 0, z: 0 },
    zones: [{ id: 'w', type: 'wilds', shape: 'rect', rect: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 } }],
    roads: [], pois: [],
  },
  { x: 0, z: 0 },
));

console.log('\nSummary:');
for (const r of results) {
  console.log(`  ${r.label.padEnd(22)} ${r.fellThrough ? 'FELL THROUGH' : 'rested'}`);
}

// -------------------------------------------------------------------
// ROAD / BRIDGE DECK — the collider type the static trials didn't cover.
// A road across wilds alpine terrain bridges wherever it clears a gorge by
// >2.5m; those spans emit oriented-box deck colliders. Spawn ON a deck.
// -------------------------------------------------------------------
console.log('\n--- ROAD / BRIDGE DECK ---');
{
  const worldMap = {
    name: 'road-bridge',
    spawn: { x: 0, z: 0 },
    zones: [{ id: 'w', type: 'wilds', shape: 'rect', rect: { minX: -300, minZ: -60, maxX: 300, maxZ: 60 } }],
    roads: [{ id: 'r1', width: 8, points: [{ x: -200, z: 0 }, { x: 0, z: 0 }, { x: 200, z: 0 }] }],
    pois: [],
  };
  const level = createStreamingTerrainLevel({}, { worldMap });
  const decks = (level.colliders ?? []).filter((c) => c.name?.startsWith('Road Deck'));
  console.log(`road emitted ${decks.length} deck collider(s)`);
  if (decks.length > 0) {
    const physics = new PhysicsSystem();
    physics.RAPIER = RAPIER;
    physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    physics.world.numSolverIterations = 8;
    for (const tc of level.terrainChunks) physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
    for (const c of level.colliders) physics.createStaticCollider(c, c.chunkKey ?? null);
    const d = decks[Math.floor(decks.length / 2)];
    const cx = (d.minX + d.maxX) * 0.5;
    const cz = (d.minZ + d.maxZ) * 0.5;
    const changes = level.updateStreaming(new THREE.Vector3(cx, 0, cz));
    for (const tc of changes.addedTerrainChunks ?? []) physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
    physics.world.step();

    const vs = new VehicleSystem();
    vs.initialize({ physics, scene: new THREE.Scene(), level });
    const surfaceY = level.getGroundHeightAt(new THREE.Vector3(cx, 0, cz), 0);
    const veh = new BaseVehicle({ position: new THREE.Vector3(cx, 0, cz), rotationY: 0 });
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
    const fell = lastY < surfaceY - 5;
    console.log(
      `  deck spawn @(${cx.toFixed(0)},${cz.toFixed(0)}) ` +
      `surface=${surfaceY.toFixed(2)} spawnY=${veh.spawnPosition.y.toFixed(2)} ` +
      `final=${lastY.toFixed(2)} minY=${minY.toFixed(2)} -> ${fell ? 'FELL THROUGH' : 'rested'}`,
    );
    vs.removeVehicle(veh);
  }
}

// -------------------------------------------------------------------
// DRIVING — streaming follows the moving car across chunk boundaries.
// If a chunk's heightfield isn't built before the car drives onto it, the
// chassis drops into the gap. Full-throttle straight line for ~10s.
// -------------------------------------------------------------------
console.log('\n--- DRIVING (streaming follows the car) ---');
{
  const worldMap = { name: 'drive', spawn: { x: 0, z: 0 }, zones: [], roads: [], pois: [] };
  const level = createStreamingTerrainLevel({}, { worldMap });
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.world.numSolverIterations = 8;
  for (const tc of level.terrainChunks) physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
  physics.world.step();

  const vs = new VehicleSystem();
  vs.initialize({ physics, scene: new THREE.Scene(), level });
  const veh = new BaseVehicle({ position: new THREE.Vector3(0, 0, 0), rotationY: 0 });
  await vs.spawnVehicle({ vehicle: veh });

  const drive = { throttle: 1, steer: 0, brake: 0, handbrake: false, pitch: 0, roll: 0, yaw: 0, boost: false, vertical: 0 };
  let minY = veh.spawnPosition.y;
  let fellFrames = 0;
  let maxDist = 0;
  for (let i = 0; i < 600; i += 1) {
    veh.update({ dt: 0.016, controls: drive, physics });
    const p = physics.world.bodies.get(veh.bodyHandle).translation();
    const changes = level.updateStreaming(new THREE.Vector3(p.x, 0, p.z));
    physics.applyStreamingChanges(changes);
    physics.world.step();
    const y = physics.world.bodies.get(veh.bodyHandle).translation().y;
    if (y < minY) minY = y;
    const dist = Math.hypot(p.x, p.z);
    if (dist > maxDist) maxDist = dist;
    const surf = level.getGroundHeightAt(new THREE.Vector3(p.x, 0, p.z), 0);
    if (y < surf - 8) fellFrames += 1;
  }
  console.log(
    `  drove ~10s full-throttle: travelled ${maxDist.toFixed(0)}m ` +
    `minY=${minY.toFixed(2)} frames->8m-below-surface=${fellFrames}/600`,
  );
}
