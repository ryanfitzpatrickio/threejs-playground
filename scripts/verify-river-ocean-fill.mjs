// Verifies river ocean-fill (river.oceanLeft / oceanRight, set via the "Ocean
// fill" checkboxes in WorldMapControls.jsx): the flagged side carves to bedY
// with weight=1 arbitrarily far from the river (an "infinite ocean"), instead
// of fading back to natural terrain past width/2 + EDGE_BLEND like a normal
// riverbank; the unflagged side keeps the normal fade-out; and the 90° corner
// at each end of the polyline extends the ocean past the tip (while the land
// side past the tip stays unaffected).
//
// Run: node scripts/verify-river-ocean-fill.mjs

import assert from 'node:assert/strict';

const { buildRiverProfile, applyRiverCorridorHeight } = await import('../src/world/worldMap/riverProfile.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const sampleHeight = () => 0;
const river = { points: [{ x: -100, z: 0 }, { x: 0, z: 0 }, { x: 100, z: 0 }], width: 10, depth: 6, oceanLeft: true };
const profile = buildRiverProfile({ rivers: [river], sampleHeight, smoothRadius: 2 });
const bedY = -6; // sampleHeight(0) - depth

// ---- ocean (left, +z) side never fades back to land, at any distance
{
  const near = profile.corridorAt(0, 20);
  const far = profile.corridorAt(0, 5000);
  assert.ok(near && near.weight === 1, 'near-shore left point is fully carved');
  assert.equal(applyRiverCorridorHeight(0, near), bedY, 'near-shore left carves to bedY');
  assert.ok(far && far.weight === 1, 'far (5000m) left point is still fully carved');
  assert.equal(applyRiverCorridorHeight(0, far), bedY, 'far left point still carves to bedY (infinite ocean)');
  ok('ocean-flagged side never fades back to land, at any distance');
}

// ---- unflagged (right, -z) side keeps the normal riverbank fade-out
{
  const half = Math.max(2, river.width) * 1.5 * 0.5;
  const justInside = profile.corridorAt(0, -(half - 1));
  const justOutside = profile.corridorAt(0, -(half + 20)); // well past half + EDGE_BLEND(6)
  assert.ok(justInside && justInside.weight > 0, 'right side near the bank is still carved');
  assert.equal(justOutside, null, 'right side far out returns null (normal land, not ocean)');
  ok('unflagged side keeps the normal fade-out (finite riverbank)');
}

// ---- 90° corner: past the polyline's end, the ocean side keeps going, the land side does not
{
  const pastEndOcean = profile.corridorAt(300, 50); // past +x end, +z (ocean) side
  const pastEndLand = profile.corridorAt(300, -50); // past +x end, -z (land) side
  const beforeStartOcean = profile.corridorAt(-300, 50); // before -x start, +z (ocean) side
  const beforeStartLand = profile.corridorAt(-300, -50);
  assert.ok(pastEndOcean && pastEndOcean.weight === 1, 'past the +x end, ocean side is still ocean');
  assert.equal(pastEndLand, null, 'past the +x end, land side is untouched');
  assert.ok(beforeStartOcean && beforeStartOcean.weight === 1, 'before the -x start, ocean side is still ocean');
  assert.equal(beforeStartLand, null, 'before the -x start, land side is untouched');
  ok('90° corner extends the ocean past both ends without leaking onto the land side');
}

// ---- a plain river (no ocean flags) is completely unaffected
{
  const plain = buildRiverProfile({
    rivers: [{ points: [{ x: -100, z: 0 }, { x: 100, z: 0 }], width: 10, depth: 6 }],
    sampleHeight, smoothRadius: 2,
  });
  const far = plain.corridorAt(0, 5000);
  assert.equal(far, null, 'a plain river (no ocean flags) has no long-range effect');
  ok('plain rivers are unaffected (no ocean flags set)');
}

// ---- both sides flagged: a channel/strait with ocean on both banks
{
  const strait = buildRiverProfile({
    rivers: [{ points: [{ x: -100, z: 0 }, { x: 100, z: 0 }], width: 10, depth: 6, oceanLeft: true, oceanRight: true }],
    sampleHeight, smoothRadius: 2,
  });
  const left = strait.corridorAt(0, 5000);
  const right = strait.corridorAt(0, -5000);
  assert.ok(left && left.weight === 1 && right && right.weight === 1, 'both sides ocean when both flags are set');
  ok('both oceanLeft + oceanRight together fill both banks');
}

console.log(`\nAll ${passed} river-ocean-fill checks passed.`);
