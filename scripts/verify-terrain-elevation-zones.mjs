// Verifies min/max elevation constraints on a World Map `terrain` zone
// (zone.props.minHeight / maxHeight, set via the "Min elevation" / "Max
// elevation" fields in WorldMapControls.jsx): a zone with minHeight guarantees
// the baked terrain never dips below it (e.g. "always > 0" for a guaranteed
// mountain); one with maxHeight guarantees it never rises above it (e.g.
// "always < 0" for a guaranteed canyon/valley floor). This builds a REAL
// createStreamingTerrainLevel (same integration path the game uses, not a
// reimplementation of the math) and inspects the baked chunk heights.
//
// Run: node scripts/verify-terrain-elevation-zones.mjs

globalThis.document = {
  createElementNS: () => ({ addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, style: {} }),
};

import assert from 'node:assert/strict';
import * as THREE from 'three';

const { createStreamingTerrainLevel } = await import('../src/game/world/createStreamingTerrainLevel.js');
const { createEmptyWorldMap } = await import('../src/world/worldMap/worldMapSchema.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// Math.max(...bigArray) blows the call stack for the large flattened height
// arrays here (spread has an engine-size argument limit); reduce instead.
const arrMax = (arr) => arr.reduce((m, v) => (v > m ? v : m), -Infinity);
const arrMin = (arr) => arr.reduce((m, v) => (v < m ? v : m), Infinity);

// The initial ring around the map spawn is built SYNCHRONOUSLY at construction
// (so physics has ground before the first frame) — read it straight from
// level.terrainChunks rather than via updateStreaming, which only reports NEW
// chunks and returns nothing for a ring that's already loaded.
function collectHeightsAt(level) {
  const heights = [];
  for (const chunk of level.terrainChunks) heights.push(...chunk.heights);
  return heights;
}

// Just the chunk at the origin (cx=0, cz=0): fully inside a zone with a 100m
// half-extent even after the 24m margin, so the constraint applies at FULL
// weight everywhere in it — unlike the outer rings of the loaded set, which
// straddle the zone's blend-margin edge and are only partially constrained.
function collectHeightsCore(level) {
  const chunk = level.terrainChunks.find((c) => c.cx === 0 && c.cz === 0);
  return chunk ? Array.from(chunk.heights) : [];
}

// Every loaded chunk safely inside the zone (well clear of its blend margin) —
// spans several hundred metres, unlike one 32m chunk, so it's a fair way to
// check for real relief: procedural noise has a wavelength much longer than a
// single chunk, so a one-chunk sample can look deceptively flat even with a
// healthy relief setting.
function collectHeightsCoreWide(level, safeHalfExtent = 60) {
  const heights = [];
  const CHUNK = 32;
  for (const chunk of level.terrainChunks) {
    const wx = chunk.cx * CHUNK, wz = chunk.cz * CHUNK;
    if (Math.abs(wx) <= safeHalfExtent && Math.abs(wz) <= safeHalfExtent) heights.push(...chunk.heights);
  }
  return heights;
}

// For a position far from spawn (nothing loaded yet), drive updateStreaming
// forward in big steps (mirrors verify-terrain-stream-spread.mjs) and collect
// heights only from chunks whose center is clearly outside the zone + its
// blend margin — the path crosses the zone itself on the way out, so chunks
// added in the early frames are still zone-influenced and must be excluded.
function collectHeightsFar(level, targetPos, clearOfWorldXZ, stepFrames = 200) {
  const heights = [];
  const pos = new THREE.Vector3(0, 0, 0);
  const step = targetPos.clone().divideScalar(stepFrames);
  const CHUNK = 32;
  for (let i = 0; i < stepFrames; i += 1) {
    pos.add(step);
    const changes = level.updateStreaming(pos);
    for (const chunk of changes?.addedTerrainChunks ?? []) {
      const wx = chunk.cx * CHUNK, wz = chunk.cz * CHUNK;
      if (Math.abs(wx) > clearOfWorldXZ && Math.abs(wz) > clearOfWorldXZ) heights.push(...chunk.heights);
    }
  }
  return heights;
}

const rectZone = (props) => ({
  id: 'z1', type: 'terrain', shape: 'rect',
  rect: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 },
  props,
});

// ---- baseline: no elevation zone, natural amplitude is tiny (~±2.5m)
const baseline = createStreamingTerrainLevel({}, { worldMap: null });
const baselineHeights = collectHeightsAt(baseline);
assert.ok(baselineHeights.length > 0, 'baseline produced heights');
const baselineMax = arrMax(baselineHeights);
assert.ok(baselineMax < 10, `baseline terrain stays small without a zone (max=${baselineMax.toFixed(2)})`);
ok('baseline (no elevation zone) terrain has small natural amplitude');

// ---- minHeight zone: guarantees terrain never dips below it (mountain)
const worldMin = { ...createEmptyWorldMap(), zones: [rectZone({ minHeight: 25 })] };
const minLevel = createStreamingTerrainLevel({}, { worldMap: worldMin });
const insideMin = collectHeightsCore(minLevel);
assert.ok(insideMin.length > 0, 'minHeight-zone chunk produced heights');
const insideMinLowest = arrMin(insideMin);
assert.ok(insideMinLowest >= 25 - 1e-6,
  `every height inside the minHeight zone is >= 25 (lowest=${insideMinLowest.toFixed(3)})`);
ok('minHeight zone guarantees terrain never dips below the floor (mountain)');

// ---- REGRESSION: the floor must be REMAPPED into, not clamped to — a hard
// clamp (h = max(h, floor)) pins every point whose raw noise falls below the
// floor to the SAME value (most of a zone, since noise averages ~0), producing
// a flat plateau with only rare peaks. Remapping means every point keeps its
// own relative height, so across the zone (procedural noise has a wavelength
// much longer than one 32m chunk, so this needs the WIDE multi-chunk sample,
// not just the origin chunk) there should be real spread above the floor, not
// most samples pinned at exactly 25.
const insideMinWide = collectHeightsCoreWide(minLevel);
const insideMinWideLowest = arrMin(insideMinWide);
const insideMinSpread = arrMax(insideMinWide) - insideMinWideLowest;
assert.ok(insideMinSpread > 1,
  `minHeight zone preserves real relief above the floor, not a flat plateau (spread=${insideMinSpread.toFixed(2)}m)`);
const nearFloorFraction = insideMinWide.filter((h) => h < 25 + 0.05).length / insideMinWide.length;
assert.ok(nearFloorFraction < 0.5,
  `most of the zone is NOT pinned within 5cm of the floor (${(nearFloorFraction * 100).toFixed(0)}% pinned)`);
ok('minHeight zone remaps noise (preserves relief) instead of clamping it flat');

// ---- a taller biome + minHeight should read as a proper mountain: floor at 50,
// peaks well above it with real rolling variation (this is the exact case that
// regressed to a flat-topped plateau before the remap fix).
const worldMountain = { ...createEmptyWorldMap(), zones: [rectZone({ minHeight: 50, biome: 'mountains' })] };
const mountainLevel = createStreamingTerrainLevel({}, { worldMap: worldMountain });
const insideMountain = collectHeightsCoreWide(mountainLevel);
const mountainLowest = arrMin(insideMountain);
const mountainSpread = arrMax(insideMountain) - mountainLowest;
assert.ok(mountainLowest >= 50 - 1e-6, `mountains-biome zone floor holds at 50 (lowest=${mountainLowest.toFixed(2)})`);
assert.ok(mountainSpread > 15,
  `mountains-biome + minHeight=50 shows real mountain relief, not a flat top (spread=${mountainSpread.toFixed(2)}m)`);
ok('minHeight=50 with a tall biome produces rolling peaks above 50, not a flat plateau');

const outsideMin = collectHeightsFar(minLevel, new THREE.Vector3(600, 0, 600), 200);
assert.ok(outsideMin.length > 0, 'far-away streaming produced heights');
const outsideMinMax = arrMax(outsideMin);
assert.ok(outsideMinMax < 10, `far outside the zone, terrain is unaffected (max=${outsideMinMax.toFixed(2)})`);
ok('minHeight zone does not affect terrain far outside its bounds');

// ---- maxHeight zone: guarantees terrain never rises above it (canyon)
const worldMax = { ...createEmptyWorldMap(), zones: [rectZone({ maxHeight: -25 })] };
const maxLevel = createStreamingTerrainLevel({}, { worldMap: worldMax });
const insideMax = collectHeightsCore(maxLevel);
assert.ok(insideMax.length > 0, 'maxHeight-zone chunk produced heights');
const insideMaxHighest = arrMax(insideMax);
assert.ok(insideMaxHighest <= -25 + 1e-6,
  `every height inside the maxHeight zone is <= -25 (highest=${insideMaxHighest.toFixed(3)})`);
ok('maxHeight zone guarantees terrain never rises above the ceiling (canyon)');
const insideMaxWide = collectHeightsCoreWide(maxLevel);
const maxSpread = arrMax(insideMaxWide) - arrMin(insideMaxWide);
assert.ok(maxSpread > 1, `maxHeight zone preserves relief below the ceiling, not a flat floor (spread=${maxSpread.toFixed(2)}m)`);
ok('maxHeight zone remaps noise downward (preserves relief) instead of clamping it flat');

// ---- explicit `relief` override controls how much variation is kept
const worldReliefSmall = { ...createEmptyWorldMap(), zones: [rectZone({ minHeight: 25, relief: 3 })] };
const worldReliefBig = { ...createEmptyWorldMap(), zones: [rectZone({ minHeight: 25, relief: 40 })] };
const reliefSmall = collectHeightsCoreWide(createStreamingTerrainLevel({}, { worldMap: worldReliefSmall }));
const reliefBig = collectHeightsCoreWide(createStreamingTerrainLevel({}, { worldMap: worldReliefBig }));
const spreadSmall = arrMax(reliefSmall) - arrMin(reliefSmall);
const spreadBig = arrMax(reliefBig) - arrMin(reliefBig);
assert.ok(spreadBig > spreadSmall * 3,
  `explicit relief scales the variation (relief=3 spread=${spreadSmall.toFixed(2)}, relief=40 spread=${spreadBig.toFixed(2)})`);
ok('explicit relief field controls how much variation is kept above the floor');

// ---- both set on the same zone (a bounded plateau/band)
const worldBoth = { ...createEmptyWorldMap(), zones: [rectZone({ minHeight: 5, maxHeight: 8 })] };
const bothLevel = createStreamingTerrainLevel({}, { worldMap: worldBoth });
const insideBoth = collectHeightsCore(bothLevel);
assert.ok(insideBoth.length > 0, 'both-bounds zone chunk produced heights');
assert.ok(insideBoth.every((h) => h >= 5 - 1e-6 && h <= 8 + 1e-6),
  'zone with both min and max bounds every height inside [5, 8]');
ok('a zone with both minHeight and maxHeight bounds terrain into that band');

console.log(`\nAll ${passed} terrain-elevation-zone checks passed.`);
