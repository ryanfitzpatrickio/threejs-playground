// Regression for "the car falls through the ground when spawned on terrain
// bordering a wilds zone." Builds the REAL streaming terrain level with a wilds
// (alpine, amplitude 62) zone, feeds its terrain chunks through the REAL
// PhysicsSystem.createTerrainHeightfield, then spawns a BaseVehicle through the
// REAL VehicleSystem snap-to-ground path at points marching from gentle base
// terrain into the wilds.
//
// Root cause it guards: getGroundHeightAt multi-samples the chassis FOOTPRINT and
// returns the highest point (correct for not sinking a character). On the ~80°
// faces in wilds/alpine the tallest footprint point is many metres above the
// surface under the car's center, so a footprint-MAX snap floated the chassis high
// in the air and it free-fell / tumbled down the slope on spawn. The fix snaps to
// the surface directly under the spawn CENTER (radius 0). This asserts the snap
// lands the chassis on that surface, and that the test actually exercises terrain
// steep enough for the old footprint-MAX snap to have overshot badly.
//
// Run: node scripts/verify-vehicle-wilds-spawn.mjs

// Headless DOM stub so createTerrainBiomeMaterial's TextureLoader and the vehicle's
// tyre/rim CanvasTextures don't throw (textures are irrelevant to the physics we're
// probing). The 2d-context proxy returns itself for chained gradient calls.
const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
  }),
};

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { VehicleSystem } from '../src/game/systems/VehicleSystem.js';
import { LevelSystem } from '../src/game/systems/LevelSystem.js';
import { BaseVehicle } from '../src/game/vehicles/BaseVehicle.js';

await RAPIER.init();

// A wilds zone (alpine amplitude) covering one side of the origin. The opposite
// side is gentle base terrain, so x sweeps across the border.
const worldMap = {
  name: 'Wilds Border Probe',
  spawn: { x: -40, z: 0 },
  zones: [
    { id: 'w1', type: 'wilds', shape: 'rect', rect: { minX: 8, minZ: -80, maxX: 200, maxZ: 80 } },
  ],
  roads: [],
  pois: [],
};

const level = createStreamingTerrainLevel({}, { worldMap });

// Stand up a Rapier world and build heightfields exactly like PhysicsSystem does.
const physics = new PhysicsSystem();
physics.RAPIER = RAPIER;
physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
physics.world.numSolverIterations = 8;
for (const tc of level.terrainChunks) {
  physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
}
// Stream the ring around each probe point in too, so the chunk under the spawn
// always has a heightfield (mirrors GameRuntime streaming before a debug spawn).
const ensureChunksAround = (x, z) => {
  const changes = level.updateStreaming(new THREE.Vector3(x, 0, z));
  for (const tc of changes.addedTerrainChunks ?? []) {
    physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
  }
};

const vehicleSystem = new VehicleSystem();
vehicleSystem.initialize({ physics, scene: new THREE.Scene(), level });

async function probe(x, z) {
  ensureChunksAround(x, z);
  // ground0 = surface directly under the spawn center; groundMax = the footprint
  // MAX the OLD snap used. Their difference is the overshoot the bug introduced.
  const pos = new THREE.Vector3(x, 0, z);
  const ground0 = level.getGroundHeightAt(pos, 0);
  const groundMax = level.getGroundHeightAt(pos, 2.1);

  const vehicle = new BaseVehicle({ position: pos.clone(), rotationY: 0 });
  vehicle.chassisOverlayOptions = null; // GLB overlay: visual-only; a repeat failed load never settles under node
  await vehicleSystem.spawnVehicle({ vehicle });
  const spawnY = vehicle.spawnPosition.y;
  const clearance = vehicle.getGroundSpawnClearance();
  const SPAWN_EXTRA_CLEARANCE = 0.15; // keep in sync with VehicleSystem
  // How far above the surface-under-center the snap placed the chassis, beyond the
  // intended rest clearance + spawn lift. ~0 = lands on the surface; large = floats and drops.
  const overshoot = spawnY - (ground0 + clearance + SPAWN_EXTRA_CLEARANCE);

  vehicleSystem.removeVehicle(vehicle);

  console.log(
    `x=${String(x).padStart(4)} ground0=${ground0.toFixed(1).padStart(7)} ` +
    `groundMax=${groundMax.toFixed(1).padStart(7)} spawnY=${spawnY.toFixed(1).padStart(7)} ` +
    `overshoot=${overshoot.toFixed(2).padStart(6)}  ` +
    `${overshoot > 0.5 ? 'FLOATS' : 'ok'}`,
  );
  return { x, ground0, groundMax, spawnY, overshoot };
}

console.log('--- car spawn across the wilds (alpine, amp 62) border ---');
console.log('(border at x=8; x<8 gentle base terrain, x>8 ramps into alpine over 48m)\n');
const results = [];
for (let x = 8; x <= 140; x += 4) {
  results.push(await probe(x, 0));
}

const maxOvershoot = Math.max(...results.map((r) => Math.abs(r.overshoot)));
const maxFootprintBias = Math.max(...results.map((r) => r.groundMax - r.ground0));
console.log(
  `\nmax snap overshoot above surface-under-center: ${maxOvershoot.toFixed(2)}m  ` +
  `(footprint-MAX bias on this terrain reached ${maxFootprintBias.toFixed(1)}m)`,
);

// The snap must land the chassis on the surface directly under it, within the
// rest clearance — never float it metres up to a nearby alpine peak.
assert.ok(
  maxOvershoot < 0.1,
  `vehicle spawn floated above the ground under it by up to ${maxOvershoot.toFixed(2)}m ` +
  '(regressed to a footprint-MAX snap?)',
);
// Sanity: confirm the probe actually crossed terrain steep enough that the OLD
// footprint-MAX snap WOULD have floated the car several metres — otherwise this
// test isn't exercising the bug it guards.
assert.ok(
  maxFootprintBias > 3,
  `test terrain not steep enough to exercise the bug (footprint bias only ${maxFootprintBias.toFixed(1)}m)`,
);

console.log('wilds-border vehicle spawn regression passed');

// ---------------------------------------------------------------------------
// Divergence regression: a terrain chunk can be VISUALLY live (so analytic
// getGroundHeightAt returns a real shaped height) while its physics heightfield
// was never built — the character rides analytic ground so it never shows, but a
// dynamic vehicle drops straight through. Reproduce by making a far chunk live
// (updateStreaming) WITHOUT feeding the changes to physics, then assert that
// spawning a vehicle there builds the missing heightfield (via ensureGroundCollider)
// so the car has real ground under it.
// ---------------------------------------------------------------------------
{
  const divLevel = createStreamingTerrainLevel({}, { worldMap });
  const divPhysics = new PhysicsSystem();
  divPhysics.RAPIER = RAPIER;
  divPhysics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  for (const tc of divLevel.terrainChunks) divPhysics.createTerrainHeightfield(tc, tc.chunkKey ?? null);

  // Far spawn well outside the origin ring, inside the wilds zone.
  const far = new THREE.Vector3(180, 0, 0);
  // Make it visually live but DROP the streaming changes (the live-game bug).
  divLevel.updateStreaming(far, {});
  divPhysics.world.step();
  const before = divPhysics.world.castRay(new RAPIER.Ray({ x: 180, y: 400, z: 0 }, { x: 0, y: -1, z: 0 }), 4000, true);
  assert.ok(!before, 'harness sanity: far chunk should start WITHOUT a heightfield');

  // Route through the LevelSystem WRAPPER (as the real game does), not the raw
  // level — this guards the forwarding gap that made the fix a silent no-op live
  // (VehicleSystem holds the LevelSystem, which must forward ensureGroundCollider).
  const divLevelSystem = new LevelSystem();
  divLevelSystem.level = divLevel;
  assert.equal(
    typeof divLevelSystem.ensureGroundCollider, 'function',
    'LevelSystem must expose ensureGroundCollider so VehicleSystem can reach it',
  );

  const divSystem = new VehicleSystem();
  divSystem.initialize({ physics: divPhysics, scene: new THREE.Scene(), level: divLevelSystem });
  const car = new BaseVehicle({ position: far.clone() });
  car.chassisOverlayOptions = null;
  await divSystem.spawnVehicle({ vehicle: car });
  divPhysics.world.step();

  const after = divPhysics.world.castRay(new RAPIER.Ray({ x: 180, y: 400, z: 0 }, { x: 0, y: -1, z: 0 }), 4000, true);
  assert.ok(after, 'spawn did not build a heightfield under the car (ensureGroundCollider missing?)');

  // The car is unpowered on a near-vertical alpine face, so it stays grounded but
  // slides DOWNHILL (both in Y and horizontally) over the settle window. The
  // fall-through guard is therefore "did it stay on the surface", measured two ways:
  //  - it remained grounded for ~all of the window (a fall-through goes airborne),
  //  - its final Y is at/above the analytic ground AT ITS FINAL POSITION (not the
  //    spawn position — it slid away from there, so spawn-x ground is the wrong ref).
  const end = new THREE.Vector3();
  let groundedFrames = 0;
  for (let i = 0; i < 240; i += 1) {
    car.update({ dt: 1 / 60, controls: null, physics: divPhysics });
    divPhysics.world.step();
    const tr = divPhysics.getFreshBody(car.bodyHandle).translation();
    end.set(tr.x, tr.y, tr.z);
    if (car.groundedFraction > 0) groundedFrames += 1;
  }
  const ground = divLevel.getGroundHeightAt(end, 0);
  assert.ok(groundedFrames > 240 * 0.9,
    `car was airborne too often (fell through?): grounded ${groundedFrames}/240 frames`);
  assert.ok(end.y > ground - 1.5,
    `car fell through the backfilled terrain: endY=${end.y.toFixed(2)} ground@car=${ground.toFixed(2)}`);
  console.log(`heightfield-divergence regression passed (car rode at ${end.y.toFixed(2)} on ground ${ground.toFixed(2)}, grounded ${groundedFrames}/240)`);
}
