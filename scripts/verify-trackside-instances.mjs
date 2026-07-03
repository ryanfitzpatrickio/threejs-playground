// Verifies M4: the trackside fence + sponsor INSTANCED bands
// (createTracksideLayers.js + placementsAlong in trackFrame.js).
//   - placementsAlong yields evenly arc-spaced anchors (count ≈ arc/spacing) with
//     unit normals/tangents and interpolated position;
//   - the urbanCircuit cross-section emits one Trackside Fence + one Trackside
//     Sponsors InstancedMesh per side (both sides present);
//   - fence cards stand vertical, are scaled (panel × height), sit at the fence
//     offset, and face ACROSS the road (normal along the road perpendicular);
//   - sponsor boards stand vertical, are scaled (boardWidth × height), mounted above
//     the road, face IN toward the centerline, and use side-specific materials.
//
// Geometry/instances are built on the CPU, so this runs headless.
//
// Run: node scripts/verify-trackside-instances.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { buildRibbonFrame, placementsAlong } = await import('../src/world/worldMap/trackFrame.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { TRACK_CROSS_SECTIONS } = await import('../src/game/world/trackCrossSection.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const sampleHeight = () => 0;
// Straight road along +x, centerline z=0 → road-perpendicular normal is (0,0,±1).
const profile = buildRoadProfile({
  roads: [{ points: [{ x: -100, z: 0 }, { x: 100, z: 0 }], width: 10, trackStyle: 'urbanCircuit' }],
  sampleHeight, smoothRadius: 2, maxGrade: Infinity,
});
const built = profile.roads[0];
const frame = buildRibbonFrame(built);
const totalArc = frame.arc[frame.n - 1];
const half = built.half;
const bands = TRACK_CROSS_SECTIONS.urbanCircuit.bands;

// ------------------------------------------------------------- placementsAlong unit
{
  const anchors = placementsAlong(frame, 10, { phase: 5, lateral: 0 });
  const expected = Math.floor((totalArc - 5) / 10) + 1;
  assert.ok(Math.abs(anchors.length - expected) <= 1, `anchor count ≈ arc/spacing (${anchors.length} vs ~${expected})`);
  for (const a of anchors) {
    assert.ok(Math.abs(Math.hypot(a.nx, a.nz) - 1) < 1e-9, 'normal is unit');
    assert.ok(Math.abs(Math.hypot(a.tx, a.tz) - 1) < 1e-9, 'tangent is unit');
    assert.ok(a.s >= 0 && a.s <= totalArc + 1e-6, 'arc within range');
  }
  // lateral offset shifts the point along the (0,0,1) normal for this straight road.
  const off = placementsAlong(frame, 10, { phase: 5, lateral: 3 });
  assert.ok(Math.abs(Math.abs(off[0].z) - 3) < 1e-6, 'lateral offset applied along normal');
  ok('placementsAlong: evenly spaced, unit dirs, lateral offset applied');
}

const layers = createTracksideLayers({ profile, sampleHeight });
const fences = layers.group.children.filter((c) => c.name === 'Trackside Fence');
const sponsors = layers.group.children.filter((c) => c.name === 'Trackside Sponsors');
const assetBands = bands.filter((b) => b.kind === 'asset');
const fenceFlagPoles = layers.group.children.filter((c) => c.name === 'Trackside Fence Flag Poles');
const fenceFlags = layers.group.children.filter((c) => c.name.startsWith('Trackside Fence Flag flag_'));

const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const up = new THREE.Vector3();
const fwd = new THREE.Vector3();
const m = new THREE.Matrix4();

// ------------------------------------------------------------- fence instances
{
  assert.equal(fences.length, 2, 'one fence InstancedMesh per side');
  const fenceBand = bands.find((b) => b.kind === 'fence');
  const expected = Math.floor((totalArc - fenceBand.panel * 0.5) / fenceBand.panel) + 1;
  let sawLeft = false, sawRight = false;
  for (const mesh of fences) {
    assert.ok(Math.abs(mesh.count - expected) <= 1, `fence count ≈ arc/panel (${mesh.count} vs ~${expected})`);
    mesh.getMatrixAt(0, m);
    m.decompose(pos, quat, scl);
    // Safety-fence geometry is authored at final dimensions; instances only orient it.
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x - fenceBand.panel) < 1e-4, 'fence width = panel');
    assert.ok(Math.abs(size.y - fenceBand.height) < 1e-4, 'fence height');
    // Vertical: local up stays world up.
    up.set(0, 1, 0).applyQuaternion(quat);
    assert.ok(Math.abs(up.y - 1) < 1e-4, 'fence card is vertical');
    // Faces across the road: normal (local +Z) lies along ±z (the perpendicular).
    fwd.set(0, 0, 1).applyQuaternion(quat);
    assert.ok(Math.abs(Math.abs(fwd.z) - 1) < 1e-4, 'fence faces across the road');
    if (pos.z > 0) sawLeft = true; else sawRight = true;
  }
  assert.ok(sawLeft && sawRight, 'fences on both sides');
  ok(`fence: ${fences.length} instanced meshes, vertical panels facing across road, both sides`);
}

// ------------------------------------------------------------- fence flag rows
{
  assert.equal(fenceFlagPoles.length, 2, 'one fence flag-pole row per side');
  assert.ok(fenceFlags.length >= 2, 'vertical textured fence flags emitted');
  assert.ok(fenceFlagPoles.every((mesh) => mesh.count > 0), 'flag poles have instances');
  assert.ok(fenceFlags.every((mesh) => mesh.material.userData.trackTexture?.startsWith('flag_')), 'flag rows use flag textures');
  ok(`fence flags: ${fenceFlagPoles.length} pole rows and ${fenceFlags.length} textured flag rows`);
}

// ------------------------------------------------------------- atlas asset cards
{
  for (const band of assetBands) {
    const meshes = layers.group.children.filter((c) => c.name === `Trackside Asset ${band.asset}`);
    const hasAnchor = (band.phase ?? (band.every ?? 30) * 0.5) <= totalArc;
    const expectedSides = hasAnchor ? (band.side === 'both' ? 2 : 1) : 0;
    assert.equal(meshes.length, expectedSides, `${band.asset}: emitted on configured side(s)`);
    for (const mesh of meshes) {
      assert.ok(mesh.count > 0, `${band.asset}: has instances`);
      assert.equal(mesh.material.userData.trackTexture, band.texture, `${band.asset}: uses configured atlas texture`);
      mesh.getMatrixAt(0, m);
      m.decompose(pos, quat, scl);
      assert.ok(Math.abs(scl.x - band.width) < 1e-4, `${band.asset}: configured width`);
      assert.ok(Math.abs(scl.y - band.height) < 1e-4, `${band.asset}: configured height`);
      fwd.set(0, 0, 1).applyQuaternion(quat);
      assert.ok(Math.sign(fwd.z) === -Math.sign(pos.z), `${band.asset}: faces toward track`);
    }
  }
  ok(`atlas cards: all ${assetBands.length} configured asset families emitted`);
}

// Every sliced atlas image must be reachable from a material in this layer stack.
{
  const manifest = JSON.parse(fs.readFileSync(
    new URL('../public/assets/textures/urban-track/urban-track-atlas.json', import.meta.url),
    'utf8',
  ));
  const expectedTextures = new Set(Object.values(manifest.assets).map((asset) => asset.file.split('/').pop()));
  // The square red/white render includes a large black studio backdrop and is no
  // longer suitable for continuous wall geometry. Keep it in the source atlas,
  // but do not require runtime assignment.
  expectedTextures.delete('barrier_red_white.png');
  const usedTextures = new Set();
  layers.group.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material?.userData?.trackTexture) usedTextures.add(material.userData.trackTexture);
    }
  });
  for (const texture of expectedTextures) {
    assert.ok(usedTextures.has(texture), `atlas texture ${texture} is assigned to road-layer geometry`);
  }
  ok(`atlas coverage: all ${expectedTextures.size} active textures assigned`);
}

// ------------------------------------------------------------- sponsor instances
{
  assert.equal(sponsors.length, 2, 'one sponsor InstancedMesh per side');
  const sp = bands.find((b) => b.kind === 'sponsor');
  const expected = Math.floor((totalArc - sp.every * 0.5) / sp.every) + 1;
  for (const mesh of sponsors) {
    assert.ok(Math.abs(mesh.count - expected) <= 1, `sponsor count ≈ arc/every (${mesh.count} vs ~${expected})`);
    assert.equal(mesh.instanceColor, null, 'sponsor texture is not tinted per instance');
    mesh.getMatrixAt(0, m);
    m.decompose(pos, quat, scl);
    assert.ok(Math.abs(scl.x - sp.boardWidth) < 1e-4, 'board width = boardWidth');
    assert.ok(Math.abs(scl.y - sp.height) < 1e-4, 'board height');
    // Mounted above the road: centre at mountY + height/2.
    assert.ok(Math.abs(pos.y - (sp.mountY + sp.height / 2)) < 1e-3, 'board mounted above road');
    // Faces IN toward the centerline: the inward normal points opposite the board's
    // own +z position (left boards at z>0 face -z; right boards at z<0 face +z).
    fwd.set(0, 0, 1).applyQuaternion(quat);
    assert.ok(Math.sign(fwd.z) === -Math.sign(pos.z), 'board faces toward the track');
  }
  assert.notEqual(sponsors[0].material, sponsors[1].material, 'opposite sides use different sponsor artwork');
  ok(`sponsor: ${sponsors.length} instanced meshes, vertical textured boards facing in`);
}

layers.dispose();
console.log(`\nAll ${passed} trackside-instance checks passed.`);
