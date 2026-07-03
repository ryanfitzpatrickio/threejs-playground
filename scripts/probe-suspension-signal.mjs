// Decisive, dynamics-free test of the suspension sampling claim: at highway-speed
// sample spacing (the chassis crosses ~1 m of terrain per 16 ms step at ~64 m/s),
// compare the ground-distance signal produced by a POINT RAY vs a wheel-radius
// SPHERE cast under a wheel as it sweeps across the procedural terrain.
//
// The spring force is driven by step-to-step change in this signal. If the sphere
// signal has smaller step-to-step jumps (less high-frequency "jerk"), it directly
// proves the sphere cast removes the aliasing that spikes the spring at speed —
// without the confounding body dynamics of a forced-velocity drive.
//
// Run: node scripts/probe-suspension-signal.mjs

globalThis.document = { createElementNS: () => ({ addEventListener(){}, removeEventListener(){}, setAttribute(){}, style:{} }) };

import RAPIER from '@dimforge/rapier3d-compat';
import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';

await RAPIER.init();
const level = createStreamingTerrainLevel({}, { worldMap: null });
const physics = new PhysicsSystem();
physics.RAPIER = RAPIER;
physics.world = new RAPIER.World({ x: 0, y: -15.5, z: 0 });
for (const tc of level.terrainChunks) physics.createTerrainHeightfield(tc, tc.chunkKey ?? null);
physics.world.step();

const ORIGIN_Y = 80;
const rot = { x: 0, y: 0, z: 0, w: 1 };
const down = { x: 0, y: -1, z: 0 };

function rayDist(x, z) {
  const ray = new RAPIER.Ray({ x, y: ORIGIN_Y, z }, down);
  const hit = physics.world.castRay(ray, 200, true);
  return hit ? (hit.timeOfImpact ?? hit.toi) : null;
}
function sphereDist(x, z, r, shape) {
  const hit = physics.world.castShape({ x, y: ORIGIN_Y, z }, rot, down, shape, 0, 200, true);
  if (!hit) return null;
  const toi = hit.time_of_impact ?? hit.timeOfImpact ?? hit.toi;
  return toi == null ? null : toi + r; // ball centre -> ground distance
}

// Sweep 1 m steps (≈64 m/s @ 16 ms) over 400 m of terrain; jerk = |2nd difference|
// of the ground-distance signal (what makes the spring force spike step-to-step).
const ball = new RAPIER.Ball(0.34);
const step = 1.0;
const z0 = 0;
const rayS = [], sphS = [];
for (let i = 0; i < 400; i += 1) {
  const x = i * step;
  rayS.push(rayDist(x, z0));
  sphS.push(sphereDist(x, z0, 0.34, ball));
}
function jerkStats(sig) {
  let sum = 0, max = 0, n = 0, big = 0;
  for (let i = 2; i < sig.length; i += 1) {
    if (sig[i] == null || sig[i - 1] == null || sig[i - 2] == null) continue;
    const j = Math.abs(sig[i] - 2 * sig[i - 1] + sig[i - 2]); // 2nd diff
    sum += j; if (j > max) max = j; if (j > 0.15) big += 1; n += 1;
  }
  return { meanJerk: +(sum / Math.max(1, n)).toFixed(4), maxJerk: +max.toFixed(3), bigJerks: big, n };
}
const r = jerkStats(rayS);
const s = jerkStats(sphS);
console.log('Ground-distance signal jerk (2nd difference) at 1 m / step spacing (~64 m/s):');
console.log('  POINT RAY   :', r);
console.log('  SPHERE 0.34 :', s);
const dMean = r.meanJerk ? Math.round((1 - s.meanJerk / r.meanJerk) * 100) : 0;
const dMax = r.maxJerk ? Math.round((1 - s.maxJerk / r.maxJerk) * 100) : 0;
const dBig = r.bigJerks ? Math.round((1 - s.bigJerks / r.bigJerks) * 100) : 0;
console.log(`\n  sphere vs ray: mean jerk -${dMean}%, max jerk -${dMax}%, big jerks(>0.15m) -${dBig}%`);
console.log(dMean > 0 ? '✓ sphere cast smooths the high-speed ground signal (less spring spiking).'
  : '✗ no improvement — sphere cast not helping here.');
