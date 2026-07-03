// Verifies the M1 trackFrame extraction (src/world/worldMap/trackFrame.js).
//
// trackFrame lifts a buildRoadProfile `built` entry into a per-sample frame (arc,
// unit tangent, road-perpendicular normal, position, roadY). createRoadworks used
// to compute this inline; the refactor must be byte-identical or the visible road
// ribbon / skirts / deck colliders shift. This re-implements the OLD inline math
// (arc via hypot; tangent from clamped neighbours, normalized via sqrt as
// THREE.Vector2 did; perpendicular px=-tan.z, pz=tan.x; edges at samples ± p*half)
// and asserts buildRibbonFrame + offsetPoint reproduce it EXACTLY (===, no eps).
//
// Pure math only — no THREE / canvas — so it runs headless. The full visual ribbon
// is covered by the manual /run pass.
//
// Run: node scripts/verify-track-frame.mjs

import assert from 'node:assert/strict';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { buildRibbonFrame, offsetPoint } = await import('../src/world/worldMap/trackFrame.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// A sloped, non-axis-aligned terrain so roadY varies and tangents point every way.
const sampleHeight = (x, z) => 5 + 0.04 * x + 0.02 * z + 3 * Math.sin(x * 0.03);

// Two roads: a curving one (exercises turning tangents) and a near-degenerate
// short one (exercises the clamped-endpoint / tiny-segment paths).
const profile = buildRoadProfile({
  roads: [
    { points: [{ x: -60, z: -40 }, { x: -10, z: 20 }, { x: 40, z: 10 }, { x: 90, z: 70 }], width: 10 },
    { points: [{ x: 0, z: 0 }, { x: 0, z: 30 }], width: 6 },
  ],
  sampleHeight,
  smoothRadius: 2,
  maxGrade: Infinity,
});

assert.ok(profile.roads.length === 2, 'both roads built');
ok('buildRoadProfile produced 2 roads');

// ---- Old inline reference implementation (copied from pre-refactor createRoadworks).
function referenceFrame(b) {
  const { samples, n, roadY, half } = b;
  const arc = new Float64Array(n);
  arc[0] = 0;
  for (let i = 1; i < n; i += 1) {
    arc[i] = arc[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
  }
  const edgeL = [];
  const edgeR = [];
  for (let i = 0; i < n; i += 1) {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x;
    let tz = next.z - prev.z; // Vector2(x->x, y->z)
    // THREE.Vector2.normalize() = divideScalar(len) = multiplyScalar(1/len), i.e. a
    // reciprocal multiply — NOT a direct divide (they differ by an ULP). Match it.
    if (tx * tx + tz * tz < 1e-8) { tx = 1; tz = 0; }
    else { const inv = 1 / Math.sqrt(tx * tx + tz * tz); tx *= inv; tz *= inv; }
    const px = -tz; // perpendicular (was -tan.y)
    const pz = tx;  // (was tan.x)
    edgeL.push({ x: samples[i].x + px * half, z: samples[i].z + pz * half });
    edgeR.push({ x: samples[i].x - px * half, z: samples[i].z - pz * half });
  }
  return { arc, edgeL, edgeR };
}

for (let r = 0; r < profile.roads.length; r += 1) {
  const b = profile.roads[r];
  const ref = referenceFrame(b);
  const frame = buildRibbonFrame(b);
  const { n, half } = b;

  assert.equal(frame.n, n);
  assert.equal(frame.half, half);

  for (let i = 0; i < n; i += 1) {
    // arc length: exact.
    assert.equal(frame.arc[i], ref.arc[i], `road ${r} arc[${i}]`);
    // roadY passthrough: exact.
    assert.equal(frame.roadY[i], b.roadY[i], `road ${r} roadY[${i}]`);
    // normal is unit-length (or the +x fallback), perpendicular to tangent.
    const nlen = Math.hypot(frame.norX[i], frame.norZ[i]);
    assert.ok(Math.abs(nlen - 1) < 1e-12, `road ${r} normal[${i}] unit length`);
    const dot = frame.tanX[i] * frame.norX[i] + frame.tanZ[i] * frame.norZ[i];
    assert.ok(Math.abs(dot) < 1e-12, `road ${r} tangent⊥normal[${i}]`);

    // Edges via offsetPoint must equal the old inline edges EXACTLY (byte-identical).
    const eL = offsetPoint(frame, i, half);
    const eR = offsetPoint(frame, i, -half);
    assert.equal(eL.x, ref.edgeL[i].x, `road ${r} edgeL.x[${i}]`);
    assert.equal(eL.z, ref.edgeL[i].z, `road ${r} edgeL.z[${i}]`);
    assert.equal(eR.x, ref.edgeR[i].x, `road ${r} edgeR.x[${i}]`);
    assert.equal(eR.z, ref.edgeR[i].z, `road ${r} edgeR.z[${i}]`);

    // Centerline offset (u=0) returns the sample position exactly.
    const c = offsetPoint(frame, i, 0);
    assert.equal(c.x, b.samples[i].x, `road ${r} center.x[${i}]`);
    assert.equal(c.z, b.samples[i].z, `road ${r} center.z[${i}]`);
  }
  ok(`road ${r}: frame matches old inline math exactly across ${n} samples`);
}

// offsetPoint sign convention: +half is LEFT of travel, -half is RIGHT, and the two
// edges are symmetric about the centerline (their midpoint is the sample).
{
  const b = profile.roads[0];
  const frame = buildRibbonFrame(b);
  const i = Math.floor(b.n / 2);
  const eL = offsetPoint(frame, i, b.half);
  const eR = offsetPoint(frame, i, -b.half);
  const midX = (eL.x + eR.x) / 2;
  const midZ = (eL.z + eR.z) / 2;
  assert.ok(Math.abs(midX - b.samples[i].x) < 1e-9, 'edge midpoint x = centerline');
  assert.ok(Math.abs(midZ - b.samples[i].z) < 1e-9, 'edge midpoint z = centerline');
  ok('offsetPoint left/right edges are symmetric about the centerline');
}

console.log(`\nAll ${passed} track-frame checks passed.`);
