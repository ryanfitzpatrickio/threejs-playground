// Measure the per-chunk build cost on the streaming hot path, to see whether the
// residual "tiny jump every ~1s" while driving is a leftover per-crossing build
// spike (the cap spreads 7 new chunks over a few frames, but if each chunk is
// several ms, those few frames are still heavy = a small lurch).
//
// Times updateStreaming-equivalent work: addChunk (procedural gen + shapeChunk +
// mesh + seamless normals) and the Rapier heightfield build, by driving the
// streaming position and timing each frame's build.
//
// Run: node scripts/probe-chunk-build-cost.mjs

globalThis.document = {
  createElementNS: () => ({ addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, style: {} }),
};

import { performance } from 'node:perf_hooks';
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

// Drive +x and time each streaming frame's total build cost (mesh gen in
// updateStreaming + heightfields in applyStreamingChanges), like GameRuntime does.
const pos = new THREE.Vector3(0, 0, 0);
const frames = [];
for (let f = 0; f < 400; f += 1) {
  pos.x += 0.6; // ~36 m/s at 60fps
  const t0 = performance.now();
  const changes = level.updateStreaming(pos);          // mesh gen (capped)
  const built = physics.applyStreamingChanges(changes); // heightfields
  const ms = performance.now() - t0;
  if ((changes.addedTerrainChunks?.length ?? 0) > 0) {
    frames.push({ f, chunks: changes.addedTerrainChunks.length, ms });
  }
}

const busy = frames.filter((x) => x.chunks > 0);
const times = busy.map((x) => x.ms);
const perChunk = busy.map((x) => x.ms / x.chunks);
const avg = (a) => (a.reduce((s, v) => s + v, 0) / (a.length || 1));
const max = (a) => Math.max(0, ...a);

console.log(`Streaming build frames (drove ${(0.6 * 400).toFixed(0)} m at ~36 m/s):`);
console.log(`  build-frames: ${busy.length} of 400`);
console.log(`  per-frame build ms:  avg ${avg(times).toFixed(2)}  max ${max(times).toFixed(2)}`);
console.log(`  per-chunk build ms:  avg ${avg(perChunk).toFixed(2)}  max ${max(perChunk).toFixed(2)}`);
console.log(`  (cap = 2 chunks/frame → a per-frame spike of ~${(2 * avg(perChunk)).toFixed(1)} ms recurs each crossing cluster)`);

// Where the per-chunk time goes: time addChunk alone vs heightfield alone for a
// few fresh coords far from anything built.
const m = level._manager;
function timeOne(label, fn, n = 20) {
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) fn(i);
  return (performance.now() - t0) / n;
}
// Heightfield-only cost from an existing payload.
const sample = level.terrainChunks[0];
const hfMs = timeOne('heightfield', () => physics.createTerrainHeightfield(sample, 'probe-throwaway'), 30);
console.log(`\n  isolated Rapier heightfield build: ${hfMs.toFixed(2)} ms each`);
console.log('  (the rest of per-chunk time is procedural gen + shapeChunk + seamless normals + mesh)');
