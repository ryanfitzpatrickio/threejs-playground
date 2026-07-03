// Probe the BUILT Rapier terrain heightfields for a vertical discontinuity at a
// chunk boundary — the suspected cause of the small "physics jump every ~1s"
// (= every 32 m chunk crossing) the vehicle shows while driving.
//
// Builds the streaming world's initial heightfields exactly like
// PhysicsSystem.createStaticLevelColliders, then raycasts straight down at a
// dense set of x positions sweeping across a chunk boundary and prints the
// surface height. A clean ramp = no seam step (bump is collider-edge clipping);
// a sudden jump at the boundary = a real height step to fix.
//
// Run: node scripts/probe-terrain-heightfield-seam.mjs

globalThis.document = {
  createElementNS: () => ({ addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, style: {} }),
};

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';

await RAPIER.init();

const level = createStreamingTerrainLevel({}, { worldMap: null });

const physics = new PhysicsSystem();
physics.RAPIER = RAPIER;
physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
physics.world.numSolverIterations = 8;
for (const tc of level.terrainChunks) physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
physics.world.step();

const CHUNK = 32;
// Boundary between chunk 0 and chunk 1 sits at world x = 0*32 + 16 = 16.
const boundaryX = 16;
const z = 0;

const surfaceAt = (x) => {
  const from = { x, y: 500, z };
  const ray = new RAPIER.Ray(from, { x: 0, y: -1, z: 0 });
  const hit = physics.world.castRay(ray, 2000, true);
  return hit ? from.y - (hit.timeOfImpact ?? hit.toi) : null;
};

// Analytic surface (what the character/ camera rides) for comparison.
const analyticAt = (x) => level.getGroundHeightAt(new THREE.Vector3(x, 0, z), 0);

console.log(`Sweeping x across chunk boundary at x=${boundaryX} (z=${z})`);
console.log('   x      physicsY    analyticY    Δ(phys-analytic)');
let prevPhys = null;
let maxStep = 0;
let stepX = null;
for (let x = boundaryX - 1.5; x <= boundaryX + 1.5 + 1e-9; x += 0.25) {
  const p = surfaceAt(x);
  const a = analyticAt(x);
  const mark = Math.abs(x - boundaryX) < 1e-6 ? '  <-- boundary' : '';
  console.log(
    `${x.toFixed(2).padStart(6)}  ${fmt(p)}  ${fmt(a)}  ${fmt(p != null && a != null ? p - a : null)}${mark}`,
  );
  if (prevPhys != null && p != null) {
    const step = Math.abs(p - prevPhys);
    if (step > maxStep) { maxStep = step; stepX = x; }
  }
  prevPhys = p;
}

// Expected per-step change from terrain slope alone (0.25 m apart). A seam shows
// as a step much larger than its neighbours.
console.log(`\nLargest adjacent physics-height step across the sweep: ${maxStep.toFixed(4)} m near x=${stepX?.toFixed(2)}`);
console.log(maxStep > 0.05
  ? '⚠️  Discontinuity at the seam — real height step to fix.'
  : '✓  Physics surface is continuous across the boundary (no seam step).');

function fmt(v) {
  return v == null ? '    null  ' : v.toFixed(4).padStart(10);
}
