// Verifies M5: the trackside hero PROPS + gantries (createTracksideLayers.js).
//   - the urbanCircuit cross-section emits one InstancedMesh per prop row
//     (grandstand left, streetlight right, brakingBoard right) + a gantry row;
//   - each prop geometry merges (non-empty position attribute);
//   - prop instance counts ≈ arc/every;
//   - props stand upright, rest their base on the terrain, and face IN toward the
//     track (inward normal opposite their own offset side);
//   - gantries sit on the centerline (≈0 lateral) and span the road (geometry wider
//     than the road), aligned across it.
//
// CPU-only build → runs headless.
//
// Run: node scripts/verify-trackside-props.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { buildRibbonFrame } = await import('../src/world/worldMap/trackFrame.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { TRACK_CROSS_SECTIONS } = await import('../src/game/world/trackCrossSection.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const sampleHeight = () => 0; // flat terrain → prop bases at y≈0
const profile = buildRoadProfile({
  roads: [{ points: [{ x: -150, z: 0 }, { x: 150, z: 0 }], width: 10, trackStyle: 'urbanCircuit' }],
  sampleHeight, smoothRadius: 2, maxGrade: Infinity,
});
const built = profile.roads[0];
const frame = buildRibbonFrame(built);
const totalArc = frame.arc[frame.n - 1];
const half = built.half;
const bands = TRACK_CROSS_SECTIONS.urbanCircuit.bands;
const layers = createTracksideLayers({ profile, sampleHeight });

const byName = (name) => layers.group.children.filter((c) => c.name === name);
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const up = new THREE.Vector3();
const fwd = new THREE.Vector3();
const m = new THREE.Matrix4();

function expectedCount(every) { return Math.floor((totalArc - every * 0.5) / every) + 1; }

// ------------------------------------------------------------------ prop rows
for (const band of bands.filter((b) => b.kind === 'prop')) {
  const meshes = byName(`Trackside Prop ${band.prop}`);
  assert.equal(meshes.length, 1, `${band.prop}: one instanced row`);
  const mesh = meshes[0];

  // Geometry merged + non-empty.
  assert.ok(mesh.geometry.attributes.position && mesh.geometry.attributes.position.count > 0,
    `${band.prop}: merged geometry has vertices`);
  assert.ok(mesh.geometry.attributes.color, `${band.prop}: geometry is vertex-coloured`);

  // Count ≈ arc/every.
  const exp = expectedCount(band.every);
  assert.ok(mesh.count > 0 && mesh.count <= exp && mesh.count >= exp - 3,
    `${band.prop}: intersection-gated count ≈ arc/every (${mesh.count} vs ~${exp})`);

  const expectSign = band.side === 'left' ? 1 : -1; // left props sit at +z on this road
  for (let k = 0; k < mesh.count; k += 1) {
    mesh.getMatrixAt(k, m);
    m.decompose(pos, quat, scl);
    up.set(0, 1, 0).applyQuaternion(quat);
    assert.ok(Math.abs(up.y - 1) < 1e-4, `${band.prop}: upright`);
    assert.ok(Math.abs(pos.y) < 1e-4, `${band.prop}: base on terrain (y≈0)`);
    assert.ok(Math.sign(pos.z) === expectSign, `${band.prop}: on the ${band.side} side`);
    fwd.set(0, 0, 1).applyQuaternion(quat);
    assert.ok(Math.sign(fwd.z) === -expectSign, `${band.prop}: faces in toward the track`);
  }
  ok(`prop ${band.prop}: ${mesh.count} instances, upright, grounded, facing the track`);
}

// ------------------------------------------------------------------ gantry row
{
  const gantryBand = bands.find((b) => b.kind === 'gantry');
  const meshes = byName('Trackside Gantry');
  assert.equal(meshes.length, 1, 'one gantry row');
  const mesh = meshes[0];
  assert.ok(mesh.geometry.attributes.position.count > 0, 'gantry geometry has vertices');
  const exp = expectedCount(gantryBand.every);
  assert.ok(Math.abs(mesh.count - exp) <= 1, `gantry count ≈ arc/every (${mesh.count} vs ~${exp})`);

  // Geometry spans the road: its X bounding box is wider than the road width.
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const spanX = bb.max.x - bb.min.x;
  assert.ok(spanX > half * 2, `gantry spans wider than the road (${spanX.toFixed(1)} > ${(half * 2).toFixed(1)})`);

  for (let k = 0; k < mesh.count; k += 1) {
    mesh.getMatrixAt(k, m);
    m.decompose(pos, quat, scl);
    assert.ok(Math.abs(pos.z) < 0.5, 'gantry on the centerline (≈0 lateral)');
    up.set(0, 1, 0).applyQuaternion(quat);
    assert.ok(Math.abs(up.y - 1) < 1e-4, 'gantry upright');
  }
  ok(`gantry: ${mesh.count} instances on centerline, spanning the road`);
}

layers.dispose();
console.log(`\nAll ${passed} trackside-prop checks passed.`);
