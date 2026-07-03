// Reproduce the "tiny physics jump every ~1s while driving" by stepping the
// streaming world exactly like GameRuntime.update does while a driven car moves
// forward, and flag frames where the chassis Y velocity spikes — then correlate
// those frames with terrain streaming add/remove events.
//
// GameRuntime per-frame order (the relevant bits):
//   1. level.updateStreaming(pos) + physics.applyStreamingChanges(changes)
//   2. level.ensureGroundCollider(carPos, physics)   (VehicleSystem.update)
//   3. vehicle.update(...)  -> suspension raycasts + forces
//   4. physics.stepWorld()
//
// Run: node scripts/repro-vehicle-stream-jump.mjs

function makeCtxStub() {
  const grad = { addColorStop: () => {} };
  const ctx = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'canvas') return null;
      return () => {};
    },
    set: () => true,
  });
  return ctx;
}
function makeCanvasStub() {
  return { width: 64, height: 64, getContext: () => makeCtxStub(), style: {}, addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {} };
}
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvasStub() : { style: {}, addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, appendChild: () => {} }),
  createElementNS: () => makeCanvasStub(),
};

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

await RAPIER.init();

const dt = 0.016;
const STEPS = 1500; // ~24 s of driving
const driveInput = { moveX: 0, moveZ: -1, jump: false, slide: false, brace: false, mountPressed: false }; // W = forward

// Run one drive. stream=true → real streaming churn each frame (in-game path).
// stream=false → pre-build a wide strip of heightfields along the path and never
// call updateStreaming/applyStreamingChanges (controlled: zero collider churn).
async function runDrive(stream) {
  const level = createStreamingTerrainLevel({}, { worldMap: null });
  const physics = new PhysicsSystem();
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 }); // GAME_CONFIG.character.gravity
  physics.world.numSolverIterations = 8;
  physics.world.numInternalPgsIterations = 2;
  for (const tc of level.terrainChunks) physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);

  // Controlled run: pre-build every chunk the car will reach so there is NO
  // collider add/remove during the drive (the car drives -x, so cover -120..+40).
  if (!stream) {
    for (let cx = -5; cx <= 2; cx += 1) {
      for (let cz = -4; cz <= 4; cz += 1) {
        level.ensureGroundCollider(new THREE.Vector3(cx * 32, 0, cz * 32), physics, { radiusChunks: 0 });
      }
    }
  }
  physics.world.step();

  const scene = new THREE.Scene();
  const vs = new VehicleSystem();
  vs.initialize({ physics, scene, level });
  const spawn = level.spawnPoint.clone();
  const veh = new BaseVehicle({ position: spawn.clone(), rotationY: 0 });
  await vs.spawnVehicle({ vehicle: veh });
  vs.activeVehicle = veh;
  const bodyOf = () => physics.world.bodies.get(veh.bodyHandle);

  for (let i = 0; i < 60; i += 1) {
    vs.activeVehicle.update({ dt, controls: { throttle: 0, steer: 0, brake: 0, handbrake: false, boost: false }, physics });
    if (stream && level.ensureGroundCollider) level.ensureGroundCollider(veh.group.position, physics);
    physics.world.step();
  }

  let prevVy = 0;
  const events = [];
  let sumAbsDVy = 0;
  let maxDVy = 0;
  let startX = bodyOf().translation().x;
  for (let f = 0; f < STEPS; f += 1) {
    let added = 0;
    let removed = 0;
    if (stream) {
      const changes = level.updateStreaming(veh.group.position);
      physics.applyStreamingChanges(changes);
      added = changes.addedTerrainChunks?.length ?? 0;
      removed = changes.removedChunkKeys?.length ?? 0;
    }
    vs.update({ delta: dt, input: driveInput, character: stubCharacter(veh), level });
    physics.world.step();

    const v = bodyOf().linvel();
    const dVy = v.y - prevVy;
    sumAbsDVy += Math.abs(dVy);
    if (Math.abs(dVy) > maxDVy) maxDVy = Math.abs(dVy);
    if (Math.abs(dVy) > 0.15) events.push({ f, dVy, added, removed });
    prevVy = v.y;
  }
  const endX = bodyOf().translation().x;
  const spikesOnStream = events.filter((e) => e.added > 0 || e.removed > 0).length;
  return { stream, dist: endX - startX, events: events.length, spikesOnStream, sumAbsDVy, maxDVy };
}

const on = await runDrive(true);
const off = await runDrive(false);

const fmt = (r) =>
  `drove ${r.dist.toFixed(0)}m | vy-spikes ${r.events} (on stream frames: ${r.spikesOnStream}) | ` +
  `Σ|ΔVy| ${r.sumAbsDVy.toFixed(1)} | maxΔVy ${r.maxDVy.toFixed(2)}`;

console.log('STREAMING ON :', fmt(on));
console.log('STREAMING OFF:', fmt(off));
console.log('');
const similar = Math.abs(on.sumAbsDVy - off.sumAbsDVy) / Math.max(on.sumAbsDVy, off.sumAbsDVy) < 0.2;
if (on.spikesOnStream === 0) {
  console.log('✓ No vy-spike ever coincides with a streaming add/remove.');
}
console.log(similar
  ? '✓ Bounce profile is ~identical with streaming ON vs OFF → streaming is NOT the residual jump; it is suspension/terrain-following bounce.'
  : '⚠️  Streaming ON has materially more vertical disturbance → streaming churn contributes.');

function stubCharacter(vehicle) {
  // VehicleSystem.update needs a character with a group + vehicle state to drive
  // the active vehicle. Provide the minimum it touches.
  return {
    group: vehicle.group,
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    vehicle: { active: true, vehicle, seatIndex: vehicle.driverSeatIndex, handTargets: null, anchorOffset: null },
    animationController: { play: () => {} },
  };
}
