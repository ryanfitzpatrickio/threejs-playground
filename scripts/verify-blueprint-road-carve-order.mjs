// Regression guard for the blueprint-road carve/merge ORDER in
// createStreamingTerrainLevel. A road authored inside a blueprint (Edit editor)
// looked right in the editor but showed NO terrain displacement at runtime,
// because the road carve was applied BEFORE the merge stamp (and the road
// profile sampled the raw procedural base): the merge stamp then overwrote the
// carve, burying the road.
//
// The fix mirrors how rivers already work — bake order is now:
//   biome -> flatten -> MERGE -> road -> river
// and the road profile samples the merged surface. This script reproduces the
// per-vertex bake math (shapeChunk) with the real pure helpers and asserts:
//   - NEW order (merge then road): terrain conforms to the road (carve visible).
//   - OLD order (road then merge): the carve is buried (the bug).
//
// Run: node scripts/verify-blueprint-road-carve-order.mjs

import assert from 'node:assert/strict';

const { buildRoadProfile, applyRoadCorridorHeight } =
  await import('../src/world/worldMap/roadProfile.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const BRIDGE_CLEARANCE = 0.6;

// Procedural base is flat at 0. A blueprint merges a sculpted hill (height 80)
// over a square footprint at full weight (mirrors a merge-mode entity).
const proceduralAt = () => 0;
const SCULPT_Y = 80;
const inFootprint = (x, z) => Math.abs(x) <= 60 && Math.abs(z) <= 60;
const mergeAt = (x, z) => (inFootprint(x, z) ? { weight: 1, height: SCULPT_Y } : { weight: 0, height: 0 });

const mergedSurface = (x, z) => {
  const m = mergeAt(x, z);
  return proceduralAt(x, z) * (1 - m.weight) + m.height * m.weight;
};

// A road authored inside the blueprint, running along the sculpted hilltop.
const road = { id: 'r', width: 8, type: 'road', points: [{ x: -50, z: 0 }, { x: 50, z: 0 }] };

// --- NEW order: road profile samples the MERGED surface (as the fixed pipeline does) ---
const profileNew = buildRoadProfile({
  roads: [road], sampleHeight: mergedSurface, smoothRadius: 2, maxGrade: Infinity,
});
// --- OLD order: road profile samples the raw PROCEDURAL base (the bug) ---
const profileOld = buildRoadProfile({
  roads: [road], sampleHeight: proceduralAt, smoothRadius: 2, maxGrade: Infinity,
});

// Sample a vertex on the road centerline, inside the footprint.
const px = 0, pz = 0;

// NEW bake: merge -> road.
{
  let h = proceduralAt(px, pz);
  const m = mergeAt(px, pz);
  if (m.weight > 0) h = h * (1 - m.weight) + m.height * m.weight; // merge first
  h = applyRoadCorridorHeight(h, profileNew.corridorAt(px, pz), BRIDGE_CLEARANCE); // then road
  const roadY = profileNew.corridorAt(px, pz).roadY;
  // The road sits on the sculpted hill, and terrain conforms to it.
  assert.ok(Math.abs(roadY - SCULPT_Y) < 3, `roadY (${roadY.toFixed(1)}) tracks the sculpted hilltop`);
  assert.ok(Math.abs(h - roadY) < 1e-6, `terrain conforms to road (h=${h.toFixed(2)}, roadY=${roadY.toFixed(2)})`);
  ok('NEW order (merge -> road): terrain is displaced to meet the blueprint road');
}

// OLD bake: road -> merge (reproduces the bug).
{
  let h = proceduralAt(px, pz);
  h = applyRoadCorridorHeight(h, profileOld.corridorAt(px, pz), BRIDGE_CLEARANCE); // road first
  const m = mergeAt(px, pz);
  if (m.weight > 0) h = h * (1 - m.weight) + m.height * m.weight; // merge buries it
  const roadY = profileOld.corridorAt(px, pz).roadY;
  // roadY was computed on the flat procedural base, and the merge stamp overwrote
  // the carve — the surface ends at the sculpted height, ~80 above the road.
  assert.ok(Math.abs(roadY) < 3, `OLD roadY (${roadY.toFixed(1)}) was stuck on the procedural base`);
  assert.ok(Math.abs(h - SCULPT_Y) < 1e-6, `surface buried at sculpted height (h=${h.toFixed(2)})`);
  assert.ok(h - roadY > 70, `road buried ~${(h - roadY).toFixed(0)}m below the surface (the bug)`);
  ok('OLD order (road -> merge): merge stamp buries the carve — no displacement');
}

console.log(`\nAll ${passed} blueprint-road carve-order checks passed.`);
