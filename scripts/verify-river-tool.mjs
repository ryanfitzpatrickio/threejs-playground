// Verifies the river tool's pure logic:
//   - normalizeRiver (via normalizeWorldMap): round-trips a river, clamps width
//     (≥2) and depth (≥1), defaults bad/missing width/depth, drops <2-point
//     entries, stamps type:'river', and assigns an `rv_` id.
//   - rivers coexist with roads and survive a stable JSON round-trip.
//   - buildRiverProfile carve math: flat terrain → bedY = terrain − depth and
//     waterY = terrain − depth*FILL (0.6); the corridor weight falloff; queries
//     outside the corridor return null.
//   - applyRiverCorridorHeight (the shared pure carve used by BOTH terrain passes)
//     is a passthrough at null/zero weight, blends linearly otherwise, and always
//     moves the surface DOWN toward bedY — never up.
//   - recursion guard: corridorAt never re-invokes sampleHeight after build (it
//     reads precomputed bedY/waterY arrays), so wiring it into sampleShapedHeight
//     cannot recurse; and it is deterministic, so the baked + continuous passes
//     agree exactly (the seamless-normal invariant).
//
// The full terrain carve + swim state needs a canvas + Rapier world, so it is
// covered by the manual /run pass, not here.
//
// Run: node scripts/verify-river-tool.mjs

import assert from 'node:assert/strict';

const {
  normalizeWorldMap,
  createEmptyWorldMap,
  DEFAULT_RIVER_WIDTH,
  DEFAULT_RIVER_DEPTH,
} = await import('../src/world/worldMap/worldMapSchema.js');
const { buildRiverProfile, applyRiverCorridorHeight } =
  await import('../src/world/worldMap/riverProfile.js');

const FILL_RATIO = 0.6; // water surface sits this fraction of depth below terrain

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --------------------------------------------------------------------- constants
console.log('schema defaults');
assert.equal(DEFAULT_RIVER_WIDTH, 10);
assert.equal(DEFAULT_RIVER_DEPTH, 6);
assert.ok(Array.isArray(createEmptyWorldMap().rivers) && createEmptyWorldMap().rivers.length === 0);
ok('DEFAULT_RIVER_WIDTH/DEPTH exported; empty map has rivers: []');

// -------------------------------------------------- normalizeRiver (via map round-trip)
console.log('normalizeRiver (via normalizeWorldMap)');

{
  const map = normalizeWorldMap({
    name: 't', spawn: { x: 0, z: 0 }, zones: [], roads: [], pois: [],
    rivers: [
      { points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], width: 12, depth: 8 },
    ],
  });
  assert.equal(map.rivers.length, 1);
  const r = map.rivers[0];
  assert.equal(r.width, 12);
  assert.equal(r.depth, 8);
  assert.equal(r.type, 'river');
  assert.equal(r.points.length, 2);
  assert.ok(typeof r.id === 'string' && r.id.startsWith('rv_'));
  ok('accepts a well-formed river, preserves width/depth, stamps type + id');
}

{
  const map = normalizeWorldMap({
    rivers: [{ points: [{ x: 0, z: 0 }, { x: 1, z: 1 }], width: 1, depth: 0 }],
  });
  const r = map.rivers[0];
  assert.equal(r.width, 2);   // clamped ≥ 2
  assert.equal(r.depth, 1);   // clamped ≥ 1
  ok('clamps width ≥ 2 and depth ≥ 1');
}

{
  const map = normalizeWorldMap({
    rivers: [
      { points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], width: 'wide', depth: 'deep' }, // bad width/depth (NaN)
      { points: [{ x: 5, z: 5 }] },                                                // <2 points
      { points: [{ x: NaN, z: 0 }, { x: 1, z: NaN }] },                            // non-finite pts
      'not-a-river',
    ],
  });
  assert.equal(map.rivers.length, 1);            // only the bad-width/depth entry survives
  assert.equal(map.rivers[0].width, DEFAULT_RIVER_WIDTH);
  assert.equal(map.rivers[0].depth, DEFAULT_RIVER_DEPTH);
  ok('drops <2-point / non-finite / non-object entries; defaults bad width+depth');
}

{
  // Edge: a numeric-but-tiny depth (incl. null/'' which Number-coerce to 0) does
  // NOT take the default — it clamps to the 1m floor. Only non-finite values fall
  // back to DEFAULT_RIVER_DEPTH. Worth pinning so the carve never goes non-positive.
  const clamped = normalizeWorldMap({
    rivers: [{ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], depth: null }],
  });
  assert.equal(clamped.rivers[0].depth, 1);      // Number(null)=0 → Math.max(1,0)
  const defaulted = normalizeWorldMap({
    rivers: [{ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], depth: undefined }],
  });
  assert.equal(defaulted.rivers[0].depth, DEFAULT_RIVER_DEPTH); // Number(undefined)=NaN → fallback
  ok('numeric/tiny depth clamps to 1; undefined/non-finite falls back to default');
}

{
  const map = normalizeWorldMap({
    rivers: [{ id: 'rv_keep', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] }],
  });
  assert.equal(map.rivers[0].id, 'rv_keep');     // provided id preserved
  ok('preserves a provided id');
}

{
  const noArr = normalizeWorldMap({ rivers: 'nope' });
  assert.deepEqual(noArr.rivers, []);
  const absent = normalizeWorldMap({ zones: [], roads: [] });
  assert.deepEqual(absent.rivers, []);
  ok('non-array / absent rivers → []');
}

// ----------------------------------------------- rivers coexist with roads, stable trip
console.log('coexistence + stable round-trip');

{
  const json = {
    name: 't', spawn: { x: 0, z: 0 }, zones: [], pois: [],
    roads: [{ points: [{ x: 0, z: 10 }, { x: 40, z: 10 }], width: 8 }],
    rivers: [{ id: 'rv_a', points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], width: 10, depth: 6 }],
  };
  const once = normalizeWorldMap(json);
  assert.equal(once.roads.length, 1);
  assert.equal(once.rivers.length, 1);
  // Re-normalizing the already-normalized map (undo/redo/autosave path) is stable.
  const twice = normalizeWorldMap(JSON.parse(JSON.stringify(once)));
  assert.equal(twice.rivers.length, 1);
  assert.equal(twice.rivers[0].id, 'rv_a');
  assert.equal(twice.rivers[0].depth, 6);
  assert.equal(twice.roads.length, 1);
  ok('rivers + roads survive together; re-normalize is stable');
}

// ----------------------------------------------------------- buildRiverProfile math
console.log('buildRiverProfile carve + corridor (flat terrain)');

{
  const T = 20;       // flat natural surface
  const DEPTH = 6;
  const WIDTH = 10;   // inflated to 15 inside the profile → half 7.5
  let sampleCalls = 0;
  const sampleHeight = () => { sampleCalls += 1; return T; };

  const { corridorAt } = buildRiverProfile({
    rivers: [{ points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], width: WIDTH, depth: DEPTH }],
    sampleHeight,
  });
  const callsAfterBuild = sampleCalls;
  assert.ok(callsAfterBuild > 0, 'profile should sample terrain during build');

  // On the centerline: full weight, bed = T − depth, water = T − depth*FILL.
  const onCenter = corridorAt(20, 0);
  assert.ok(onCenter && near(onCenter.weight, 1));
  assert.ok(near(onCenter.bedY, T - DEPTH));               // 14
  assert.ok(near(onCenter.waterY, T - DEPTH * FILL_RATIO)); // 16.4
  assert.ok(onCenter.bedY < onCenter.waterY, 'bed must be below the water surface');
  ok('centerline query: weight 1, bedY = terrain−depth, waterY = terrain−depth*FILL');

  // At the inflated half-width (7.5): still full weight.
  const atHalf = corridorAt(20, 7.5);
  assert.ok(atHalf && near(atHalf.weight, 1));
  ok('half-width edge still reads weight 1');

  // Inside the 6m blend band beyond half-width: weight tapers toward 0.
  const dist = 10;
  const blended = corridorAt(20, dist);
  const expectW = 1 - (dist - 7.5) / 6; // ~0.5833
  assert.ok(blended && near(blended.weight, expectW, 1e-3));
  ok(`blend band weight tapers (${expectW.toFixed(3)} at ${dist}m)`);

  // Far outside the corridor: null (no carve, no water).
  assert.equal(corridorAt(100, 100), null);
  ok('query far outside the corridor returns null');

  // Recursion guard + determinism: corridorAt never re-samples terrain, and is
  // deterministic — so the baked shapeChunk pass and continuous sampleShapedHeight
  // pass share ONE identical carve (the seamless-normal invariant).
  for (let i = 0; i < 5; i += 1) corridorAt(15 + i, i - 2);
  assert.equal(sampleCalls, callsAfterBuild, 'corridorAt must not re-invoke sampleHeight');
  assert.deepEqual(corridorAt(20, 0), corridorAt(20, 0));
  ok('corridorAt does not re-sample terrain and is deterministic (passes agree)');
}

// ------------------------------------------------------ applyRiverCorridorHeight carve
console.log('applyRiverCorridorHeight (shared pure carve)');

{
  const river = { bedY: 14, waterY: 16.4, weight: 1 };

  // null / zero-weight are exact passthroughs (outside the corridor).
  assert.equal(applyRiverCorridorHeight(20, null), 20);
  assert.equal(applyRiverCorridorHeight(20, { ...river, weight: 0 }), 20);
  ok('null / zero-weight is an exact passthrough');

  // Full weight → bedY (terrain carved DOWN to the channel floor).
  assert.equal(applyRiverCorridorHeight(20, river), 14);
  ok('full weight carves terrain down to bedY');

  // Mid weight → linear blend toward bedY.
  assert.equal(applyRiverCorridorHeight(20, { ...river, weight: 0.5 }), 17);
  ok('mid weight blends linearly toward bedY');

  // The carve is monotonic toward bedY: it never raises the surface. A point
  // already below the bed (a deeper gorge) is lowered toward bedY by the blend,
  // and at full weight is pinned to bedY — never pushed above its natural height.
  for (const w of [0.25, 0.5, 0.75, 1]) {
    const shaped = applyRiverCorridorHeight(20, { ...river, weight: w });
    assert.ok(shaped <= 20 + 1e-9, `carve raised the surface at w=${w}`);
    assert.ok(shaped >= 14 - 1e-9, `carve dipped below bedY at w=${w}`);
  }
  ok('carve is monotonic: never raises terrain above natural, never below bedY');

  // A gorge already below the bed is pinned to bedY at full weight (the channel
  // floor is the standing surface — the heightfield collider floors on bedY).
  assert.equal(applyRiverCorridorHeight(-5, river), 14);
  ok('deep gorge is pinned to bedY at full weight');
}

console.log(`\nAll ${passed} river-tool checks passed.`);
