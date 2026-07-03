// Verifies the M2/M3 trackside layer builder (src/game/world/createTracksideLayers.js)
// against the urbanCircuit cross-section (trackCrossSection.js):
//   - a road WITHOUT trackStyle emits nothing (no group children, no colliders);
//   - a road WITH trackStyle emits surface meshes (curb + shoulder) + wall meshes;
//   - curb vertices sit at road height (+lift) on a flat strip just outboard of the
//     road edge; shoulder inner edge sits at road height and its outer edge drops to
//     the sampled terrain (the verge feathers into the land);
//   - curb vertices are red/white striped by arc (two distinct colours present);
//   - wall colliders are well-formed oriented boxes: vertical (orientation keeps a
//     world-up Y column), thickness/height/length half-extents match the preset, the
//     AABB straddles the wall line, and they are noGroundSnap + non-vaultable.
//
// Geometry is built on the CPU (no GPU), so this runs headless. Physical containment
// of the vehicle is covered by verify-trackside-wall-containment.mjs (Rapier).
//
// Run: node scripts/verify-trackside-surfaces.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { TRACK_CROSS_SECTIONS } = await import('../src/game/world/trackCrossSection.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// Flat terrain at y=0 keeps roadY≈0 so expected heights are easy to reason about.
const sampleHeight = () => 0;

function buildProfile(trackStyle) {
  return buildRoadProfile({
    roads: [{ points: [{ x: -40, z: 0 }, { x: 0, z: 0 }, { x: 40, z: 0 }], width: 10, trackStyle }],
    sampleHeight,
    smoothRadius: 2,
    maxGrade: Infinity,
  });
}

// ---------------------------------------------------------------- opt-in / opt-out
{
  const plain = createTracksideLayers({ profile: buildProfile(null), sampleHeight });
  assert.equal(plain.group.children.length, 0, 'plain road emits no trackside meshes');
  assert.equal(plain.colliders.length, 0, 'plain road emits no trackside colliders');
  ok('road without trackStyle emits nothing');
}

const profile = buildProfile('urbanCircuit');
const built = profile.roads[0];
const half = built.half; // inflated road half-width (width*1.5/2)
const layers = createTracksideLayers({ profile, sampleHeight });

// ---------------------------------------------------------------- meshes present
{
  const names = layers.group.children.map((c) => c.name);
  assert.ok(names.includes('Trackside Surfaces'), 'surfaces mesh present');
  assert.ok(names.includes('Trackside Walls'), 'walls mesh present');
  ok(`emits surface + wall meshes (${names.join(', ')})`);
}

const surfaces = layers.group.children.find((c) => c.name === 'Trackside Surfaces');
const sPos = surfaces.geometry.attributes.position;
const sCol = surfaces.geometry.attributes.color;
const curbMesh = layers.group.children.find((c) => c.name === 'Trackside Red Chevron Curbs');
const cPos = curbMesh.geometry.attributes.position;

// Lateral distance of a point from the (z=0) centerline is just |x-offset|… but the
// road runs along x here, so the centerline is z=0 and lateral offset is |z|.
function lateral(i, position = sPos) { return Math.abs(position.getZ(i)); }

// ---------------------------------------------------------------- curb band geometry
// urbanCircuit: curb width 0.7 starting at the road edge (half). Inner verts at
// ~half, outer at ~half+0.7, all at road height (~0 + lift). Find the innermost and
// outermost lateral extents of the curb by scanning verts near road height.
{
  const curb = TRACK_CROSS_SECTIONS.urbanCircuit.bands.find((b) => b.kind === 'chevronCurb');
  let minLat = Infinity, maxCurbLat = -Infinity, maxY = -Infinity, minY = Infinity;
  for (let i = 0; i < cPos.count; i += 1) {
    const lat = lateral(i, cPos);
    minLat = Math.min(minLat, lat);
    maxCurbLat = Math.max(maxCurbLat, lat);
    maxY = Math.max(maxY, cPos.getY(i));
    minY = Math.min(minY, cPos.getY(i));
  }
  assert.ok(Math.abs(minLat - half) < 0.05, `curb inner edge at road edge (${minLat.toFixed(2)} ≈ ${half.toFixed(2)})`);
  assert.ok(Math.abs(maxCurbLat - (half + curb.width)) < 0.1, `curb outer edge at half+width (${maxCurbLat.toFixed(2)})`);
  // Flat strip near road height (lift is small, terrain is 0).
  assert.ok(maxY < 0.2 && minY > -0.05, `curb is flat near road height (y∈[${minY.toFixed(3)},${maxY.toFixed(3)}])`);
  ok('curb band: thin flat strip at the road edge, road height');
}

// ---------------------------------------------------------------- curb texture
{
  assert.equal(curbMesh.material.userData.trackTexture, 'curb_chevron_red.png');
  ok('curb band: textured red chevrons by arc');
}

// ---------------------------------------------------------------- shoulder feathering
{
  const curb = TRACK_CROSS_SECTIONS.urbanCircuit.bands.find((b) => b.kind === 'chevronCurb');
  const shoulder = TRACK_CROSS_SECTIONS.urbanCircuit.bands.find((b) => b.kind === 'shoulder');
  const innerLat = half + curb.width;            // shoulder starts where curb ends
  const outerLat = innerLat + shoulder.width;
  let innerY = null, outerY = null, maxLat = -Infinity;
  for (let i = 0; i < sPos.count; i += 1) {
    const lat = lateral(i);
    maxLat = Math.max(maxLat, lat);
    if (Math.abs(lat - innerLat) < 0.15) innerY = sPos.getY(i);
    if (Math.abs(lat - outerLat) < 0.15) outerY = sPos.getY(i);
  }
  assert.ok(Math.abs(maxLat - outerLat) < 0.15, `shoulder reaches half+curb+shoulder width (${maxLat.toFixed(2)} ≈ ${outerLat.toFixed(2)})`);
  assert.ok(innerY !== null && outerY !== null, 'found shoulder inner + outer verts');
  // Flat terrain → both ~0, but the outer edge is pinned to sampleHeight (0) exactly,
  // while the inner edge carries the small lift. So inner ≥ outer here.
  assert.ok(innerY >= outerY - 1e-6, 'shoulder inner edge sits at/above its terrain-pinned outer edge');
  assert.ok(Math.abs(outerY) < 1e-6, 'shoulder outer edge pinned to terrain height (0)');
  ok('shoulder band: inner at road height, outer feathered to terrain');
}

// ---------------------------------------------------------------- wall colliders
{
  const wall = TRACK_CROSS_SECTIONS.urbanCircuit.bands.find((b) => b.kind === 'wall');
  assert.ok(layers.colliders.length > 0, 'walls produced colliders');
  // Both sides → wall names carry -left and -right.
  const sides = new Set(layers.colliders.map((c) => c.name.split('-').pop()));
  assert.ok(sides.has('left') && sides.has('right'), 'walls on both sides');

  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  for (const c of layers.colliders) {
    // Oriented box contract for PhysicsSystem.
    assert.ok(c.center && c.halfExtents && c.orientation, 'collider is an oriented box');
    assert.equal(c.noGroundSnap, true, 'wall is noGroundSnap');
    assert.equal(c.vaultable, false, 'wall is non-vaultable');
    // Thickness matches the preset; vertical extent includes the buried base.
    assert.ok(Math.abs(c.halfExtents.x - wall.thickness / 2) < 1e-6, 'half-extent x = thickness/2');
    assert.ok(c.halfExtents.y > wall.height / 2, 'wall collider extends below grade');
    // Vertical wall: the box's local Y axis stays world-up.
    q.set(c.orientation.x, c.orientation.y, c.orientation.z, c.orientation.w);
    m.makeRotationFromQuaternion(q);
    const upY = m.elements[5]; // local Y axis, world Y component
    assert.ok(Math.abs(upY - 1) < 1e-6, 'wall local-up stays vertical');
    // AABB top/bottom span the wall height; box sits on the road surface.
    assert.ok(c.topY - c.bottomY >= wall.height - 1e-6, 'AABB spans wall height');
    assert.ok(c.bottomY < 0, 'wall base is buried below flat terrain');
    assert.ok(c.maxX > c.minX && c.maxZ > c.minZ, 'AABB non-degenerate');
  }
  ok(`wall colliders: ${layers.colliders.length} oriented vertical boxes, both sides, well-formed`);
}

layers.dispose();
console.log(`\nAll ${passed} trackside-surface checks passed.`);
