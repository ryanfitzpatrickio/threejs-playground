// Regression guard for the "road sinks below the spline on steep terrain" bug.
//
// buildRoadProfile used to hard-clamp the road grade to MAX_GRADE (0.12) and
// heavily smooth the centerline (SMOOTH_RADIUS = 16 ≈ 64 m window). On a steep
// hill that caps how fast roadY may climb, so the road falls further and further
// below the terrain the steeper the hill — "a lot lower than the spline, no
// matter how steep". The Map Builder editor + the world pipeline now pass
// { smoothRadius: 2, maxGrade: Infinity } so a road follows the sculpted grade
// faithfully (spiral up a hill). This script proves both halves:
//   - faithful opts  → roadY tracks a 63° hill within a few metres at the top,
//   - legacy defaults → roadY is clamped ~70 m below the terrain at the top.
//
// Run: node scripts/verify-road-steep-conformance.mjs

import assert from 'node:assert/strict';
import { buildRoadProfile } from '../src/world/worldMap/roadProfile.js';

// A 63° hill (grade 2.0): height doubles the run. Road runs along +X from 0..40.
const sampleHeight = (x) => 2 * x; // x=40 → 80 m
const road = { id: 'r1', points: [{ x: 0, z: 0 }, { x: 40, z: 0 }], width: 8 };

function topRoadY(opts) {
  const { corridorAt } = buildRoadProfile({ roads: [road], sampleHeight, ...opts });
  // Query the corridor at the hilltop (full weight at the centerline).
  const c = corridorAt(40, 0);
  assert.ok(c, 'corridor should cover the hilltop');
  return c.roadY;
}

const faithful = topRoadY({ smoothRadius: 2, maxGrade: Infinity });
const legacy = topRoadY({}); // module defaults: smoothRadius 16, maxGrade 0.12

console.log(`  faithful roadY at hilltop (terrain=80): ${faithful.toFixed(1)}`);
console.log(`  legacy   roadY at hilltop (terrain=80): ${legacy.toFixed(1)}`);

// Faithful: tracks the 80 m hilltop within the tiny smoothing window's edge pull.
assert.ok(faithful > 72,
  `faithful road should climb the steep hill, got roadY=${faithful.toFixed(1)} (want > 72)`);

// Legacy: the 64 m smoothing window flattens the 40 m hill toward its mean, and
// the 12 % grade clamp holds it there — so the road sinks far below the peak.
assert.ok(legacy < 55,
  `legacy defaults should flatten/sink the road (the bug), got roadY=${legacy.toFixed(1)} (want < 55)`);

// And the faithful road sits well above the flattened legacy one.
assert.ok(faithful - legacy > 25, 'faithful road must sit well above the legacy road');

console.log('\nroad steep-conformance regression passed');
