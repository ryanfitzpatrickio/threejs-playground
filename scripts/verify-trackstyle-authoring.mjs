// Verifies the M6 authoring data path: a road's `trackStyle` (set by the World Map
// editor dropdown) survives schema normalization and the autosave round-trip, so the
// playable World actually builds trackside layers for it.
//   - normalizeRoad keeps a valid trackStyle string;
//   - missing/empty/non-string trackStyle → null (plain road);
//   - the value survives a normalize → JSON → normalize round-trip (autosave/undo);
//   - every editor-offered preset id resolves in createTracksideLayers.
//
// Run: node scripts/verify-trackstyle-authoring.mjs

import assert from 'node:assert/strict';

const { normalizeWorldMap } = await import('../src/world/worldMap/worldMapSchema.js');
const { TRACK_CROSS_SECTION_ORDER, resolveCrossSection } =
  await import('../src/game/world/trackCrossSection.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const roadWith = (trackStyle) => normalizeWorldMap({
  roads: [{ points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], width: 10, trackStyle }],
}).roads[0];

// ---- valid trackStyle preserved
{
  const r = roadWith('urbanCircuit');
  assert.equal(r.trackStyle, 'urbanCircuit');
  ok('normalizeRoad preserves a valid trackStyle');
}

// ---- missing / empty / non-string → null
{
  assert.equal(roadWith(undefined).trackStyle, null);
  assert.equal(roadWith('').trackStyle, null);
  assert.equal(roadWith(123).trackStyle, null);
  assert.equal(roadWith(null).trackStyle, null);
  // A road authored before this field existed (no key at all) → null.
  const legacy = normalizeWorldMap({ roads: [{ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], width: 8 }] }).roads[0];
  assert.equal(legacy.trackStyle, null);
  ok('missing/empty/non-string/legacy trackStyle → null (plain road)');
}

// ---- autosave round-trip (normalize → JSON → normalize) is stable
{
  const once = normalizeWorldMap({
    roads: [{ id: 'r_a', points: [{ x: 0, z: 0 }, { x: 50, z: 10 }], width: 12, trackStyle: 'urbanCircuit' }],
  });
  const twice = normalizeWorldMap(JSON.parse(JSON.stringify(once)));
  assert.equal(twice.roads[0].trackStyle, 'urbanCircuit');
  assert.equal(twice.roads[0].id, 'r_a');
  ok('trackStyle survives the autosave/undo round-trip');
}

// ---- every editor-offered preset resolves at build time
{
  assert.ok(TRACK_CROSS_SECTION_ORDER.length > 0, 'at least one preset offered');
  for (const id of TRACK_CROSS_SECTION_ORDER) {
    const section = resolveCrossSection(id);
    assert.ok(section && Array.isArray(section.bands) && section.bands.length > 0,
      `preset '${id}' resolves to a non-empty cross-section`);
  }
  ok(`all ${TRACK_CROSS_SECTION_ORDER.length} editor preset(s) resolve to valid cross-sections`);
}

console.log(`\nAll ${passed} trackstyle-authoring checks passed.`);
