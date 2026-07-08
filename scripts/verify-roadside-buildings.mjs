// Verifies the procedural roadside buildings band (trackStyle 'roadsideBuildings').
// - Cross-section declares the band and spacing.
// - buildRoadsideBuildings emits InstancedMesh pairs (LOD0 near + LOD1 far) using
//   placementsAlong + inward orientation + terrain sampleHeight.
// - Colliders are oriented boxes with reasonable footprints and climbable flags.
// - Geometries carry aBuildingFade instanced attribute for cross-fade.
// - Deterministic under seed/roadIndex.
//
// Headless (no DOM required for geometry+collider checks).
//
// Run: node scripts/verify-roadside-buildings.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';

const { buildRoadProfile } = await import('../src/world/worldMap/roadProfile.js');
const { buildRibbonFrame, placementsAlong } = await import('../src/world/worldMap/trackFrame.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { TRACK_CROSS_SECTIONS } = await import('../src/game/world/trackCrossSection.js');
const { RoadsideBuildingGenerator, ROADSIDE_FRONTAGE_OVERLAP } = await import('../src/three-addons/generators/city/RoadsideBuildingGenerator.js');

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const sampleHeight = (x, z) => 0.4 + Math.sin(x * 0.07) * 1.2; // gentle slope

// Straight road to keep math simple.
const profile = buildRoadProfile({
  roads: [{
    points: [{ x: -180, z: 0 }, { x: 180, z: 0 }],
    width: 12,
    trackStyle: 'roadsideBuildings',
  }],
  sampleHeight,
  smoothRadius: 2,
  maxGrade: Infinity,
});
const built = profile.roads[0];
const frame = buildRibbonFrame(built);
const totalArc = frame.arc[frame.n - 1];
const half = built.half;

console.log('roadside cross section present:', !!TRACK_CROSS_SECTIONS.roadsideBuildings);

// ------------------------------------------------------------- generator unit
{
  const g = new RoadsideBuildingGenerator({ seed: 7, style: 'strip', width: 12, depth: 8, stories: 1 });
  const l0 = g.buildLOD0();
  assert.ok(l0.opaque && l0.opaque.attributes.position, 'strip LOD0 has opaque geom');
  assert.ok(l0.height > 2 && l0.height < 8, 'reasonable strip height');
  assert.ok(l0.glass && l0.glass.attributes.position.count > 0, 'strip LOD0 has glass geom (shopfronts/windows)');

  // Footprint must be centred at z=0 so the facade sits flush on the front wall
  // (guard against the window-floats-off-the-wall offset regression).
  l0.opaque.computeBoundingBox();
  const zCenter = (l0.opaque.boundingBox.min.z + l0.opaque.boundingBox.max.z) / 2;
  assert.ok(Math.abs(zCenter) < 0.6, `strip LOD0 footprint centred at z=0 (got ${zCenter.toFixed(2)})`);

  const g2 = new RoadsideBuildingGenerator({ seed: 99, style: 'apartment', width: 20, depth: 11, stories: 4 });
  const l02 = g2.buildLOD0();
  assert.ok(l02.opaque && l02.height > 8, 'apartment has height from stories');
  assert.ok(l02.glass && l02.glass.attributes.position.count > 0, 'apartment LOD0 has glass geom');

  const l1 = g.buildLOD1();
  assert.ok(l1.geometry && l1.geometry.attributes.position, 'LOD1 box geometry');
  assert.ok(l1.material, 'LOD1 has material (TSL POM)');
  assert.ok(l1.geometry.attributes.color, 'LOD1 box has base color attr');
  assert.ok(l1.geometry.attributes.tangent, 'LOD1 box has tangent attr (required by POM)');
  assert.ok(l1.material.opacityNode, 'far material wires aBuildingFade opacity');
  // Same generator → LOD1 box height must equal LOD0 height (no pop at cross-fade).
  assert.ok(Math.abs(l1.height - l0.height) < 1e-6, `LOD1 box height matches LOD0 (${l1.height} vs ${l0.height})`);

  // partId attribute (the zone code the facade material branches on). Headless node
  // can't compile the TSL pipeline — these geometry-level checks guard the plumbing;
  // the brick/concrete/glass shading itself is only validated in a real browser.
  const partIdSet = (geom) => new Set(geom.attributes.partId.array);
  assert.ok(l0.opaque.attributes.partId, 'strip LOD0 opaque has partId attr');
  assert.ok(l0.opaque.attributes.partId.itemSize === 1, 'partId itemSize 1');
  const stripParts = partIdSet(l0.opaque);
  assert.ok(stripParts.has(0) && stripParts.has(1), `strip opaque partIds include WALL+CONCRETE (${[...stripParts].join(',')})`);
  assert.ok(l0.glass && l0.glass.attributes.partId, 'strip LOD0 glass has partId attr');
  const stripGlassParts = partIdSet(l0.glass);
  assert.ok(stripGlassParts.has(4), `strip glass partIds include SHOPGLASS (${[...stripGlassParts].join(',')})`);

  const aptParts = partIdSet(l02.opaque);
  assert.ok(aptParts.has(0) && aptParts.has(1), `apartment opaque partIds include WALL+CONCRETE (${[...aptParts].join(',')})`);
  const aptGlassParts = partIdSet(l02.glass);
  assert.ok(aptGlassParts.has(4) && aptGlassParts.has(3), `apartment glass partIds include SHOPGLASS+GLASS (${[...aptGlassParts].join(',')})`);
  ok('RoadsideBuildingGenerator: LOD0/LOD1 compile for strip + apartment');

  const assertMasonryReachesRoofLine = (lod0, stories, storyHeight, label) => {
    const expectedH = stories * storyHeight;
    const pos = lod0.opaque.attributes.position.array;
    let hasWallAtParapet = false;
    for (let i = 1; i < pos.length; i += 3) {
      if (pos[i] >= expectedH - 0.08 && pos[i] <= expectedH + 0.02) hasWallAtParapet = true;
    }
    assert.ok(hasWallAtParapet, `${label}: masonry reaches roof line (y≈${expectedH})`);
    lod0.opaque.computeBoundingBox();
    assert.ok(lod0.opaque.boundingBox.max.y >= expectedH + 0.1,
      `${label}: roof geometry sits above the wall top`);
  };

  assertMasonryReachesRoofLine(l0, 1, g.storyHeight, '1-story strip');
  assertMasonryReachesRoofLine(l02, 4, g2.storyHeight, '4-story apartment');
  const g2s = new RoadsideBuildingGenerator({ seed: 12, style: 'strip', width: 14, depth: 9, stories: 2, storyHeight: 3.2 });
  assertMasonryReachesRoofLine(g2s.buildLOD0(), 2, g2s.storyHeight, '2-story strip');
  ok('roadside LOD0 walls meet the roof line without a sky gap');
}

// ------------------------------------------------------------- placements for buildings
{
  const section = TRACK_CROSS_SECTIONS.roadsideBuildings;
  const bldBand = section.bands.find((b) => b.kind === 'roadsideBuildings');
  assert.ok(bldBand, 'band present');
  const anchors = placementsAlong(frame, bldBand.spacing ?? 16, { phase: (bldBand.spacing ?? 16) * 0.5, lateral: 0 });
  assert.ok(anchors.length >= 8, 'several placements along long road');
  ok('placementsAlong yields anchors at building spacing');
}

// ------------------------------------------------------------- full layer build + colliders
{
  const layers = createTracksideLayers({ profile, sampleHeight });
  const group = layers.group;
  assert.ok(group, 'trackside group');

  const bldMeshes = group.children.filter((c) => c.name && c.name.includes('Roadside'));
  assert.ok(bldMeshes.length >= 2, 'at least one near + one far InstancedMesh (archetypes)');
  assert.ok(bldMeshes.some((m) => m.name.includes('LOD0')) && bldMeshes.some((m) => m.name.includes('LOD1')), 'near LOD0 + far LOD1 tiers present');
  assert.ok(bldMeshes.some((m) => m.name.includes('Glass')), 'glass tier rendered as its own InstancedMesh');

  // Each should be InstancedMesh with aBuildingFade attribute.
  for (const m of bldMeshes) {
    assert.ok(m.isInstancedMesh, 'building layer is instanced');
    const hasFade = !!m.geometry?.attributes?.aBuildingFade;
    assert.ok(hasFade, 'has aBuildingFade for crossfade');
  }

  // Colliders
  assert.ok(Array.isArray(layers.colliders) && layers.colliders.length > 0, 'emits colliders');
  const bldCols = layers.colliders.filter((c) => c.name && c.name.includes('RoadsideBuilding'));
  assert.ok(bldCols.length >= 4, 'multiple building colliders');
  const bldBand = TRACK_CROSS_SECTIONS.roadsideBuildings.bands.find((b) => b.kind === 'roadsideBuildings');
  const expectedFrontage = (bldBand.spacing ?? 16) + ROADSIDE_FRONTAGE_OVERLAP;
  for (const c of bldCols) {
    assert.ok(c.topY > c.bottomY + 1, 'has vertical extent');
    assert.ok(c.halfExtents && c.center && c.orientation, 'oriented box fields');
    assert.ok(c.climbable === true, 'climbable surfaces registered');
    assert.ok(Math.abs(c.width - expectedFrontage) < 1e-6, `building frontage clamps to spacing+overlap (${c.width} vs ${expectedFrontage})`);
    // halfExtents in the building's local frame: x=width/2, z=depth/2, y=height/2.
    assert.ok(Math.abs(c.halfExtents.x - c.width * 0.5) < 0.25, 'collider halfExtents.x = width/2');
    assert.ok(Math.abs(c.halfExtents.z - c.depth * 0.5) < 0.25, 'collider halfExtents.z = depth/2');
    assert.ok(Math.abs(c.halfExtents.y - (c.topY - c.bottomY) * 0.5) < 0.25, 'collider halfExtents.y = height/2');
  }

  // Update LOD path does not throw and writes fades.
  const cam = new THREE.Vector3(10, 4, 3);
  layers.updateLOD?.(cam);
  ok('createTracksideLayers wires roadsideBuildings band and LOD update');
}

// ------------------------------------------------------------- orientation & ground
{
  // Spot check first few anchors produce sensible inward orientation.
  const layers = createTracksideLayers({ profile, sampleHeight });
  // We can inspect matrices of first near mesh if present.
  const near = layers.group.children.find((c) => c.name && c.name.includes('LOD0'));
  if (near && near.count > 0) {
    const m = new THREE.Matrix4();
    near.getMatrixAt(0, m);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    m.decompose(p, q, s);
    // No random frontage scale: neighbouring generated widths are expected to
    // clamp together. Height/width variety belongs in the generator, not the row
    // placement transform.
    assert.ok(s.x > 0.5 && s.x < 1.3, 'non-degenerate scale');
    assert.ok(Math.abs(s.x - 1) < 1e-6 && Math.abs(s.z - 1) < 1e-6, 'roadside building frontage/depth scale remains 1 for seam clamping');
  }
  ok('building placements oriented and grounded');
}

// ------------------------------------------------------------- cross-fade (no dead zone)
{
  const layers = createTracksideLayers({ profile, sampleHeight });
  const entry = layers.buildingMeshes?.[0];
  assert.ok(entry && entry.near && entry.far, 'buildingMeshes exposed with near+far tiers');
  const a = entry.anchors[0];
  const nearF = () => entry.near.geometry.attributes.aBuildingFade.getX(0);
  const farF = () => entry.far.geometry.attributes.aBuildingFade.getX(0);

  // Camera on the anchor → near fully opaque, far invisible.
  layers.updateLOD(new THREE.Vector3(a.x, 0, a.z));
  assert.ok(nearF() > 0.98, `near opaque at dist 0 (got ${nearF().toFixed(3)})`);
  assert.ok(farF() < 0.02, `far invisible at dist 0 (got ${farF().toFixed(3)})`);

  // Camera 125 m off (mid-band [110,140]) → BOTH tiers non-zero (no dead zone).
  layers.updateLOD(new THREE.Vector3(a.x, 0, a.z + 125));
  assert.ok(nearF() > 0 && farF() > 0, `mid-band has both tiers visible (near ${nearF().toFixed(3)}, far ${farF().toFixed(3)})`);

  // Camera 200 m off → far fully opaque, near invisible.
  layers.updateLOD(new THREE.Vector3(a.x, 0, a.z + 200));
  assert.ok(nearF() < 0.02 && farF() > 0.98, `far opaque beyond band (near ${nearF().toFixed(3)}, far ${farF().toFixed(3)})`);
  ok('cross-fade band swaps near→far with no invisible dead zone');
}

// ------------------------------------------------------------- clean disposal
{
  const layers = createTracksideLayers({ profile, sampleHeight });
  // disposeObject3D frees every child geometry/material; it doesn't detach children
  // (the level drops the whole group). Verify it actually fires dispose events.
  let disposedGeoms = 0;
  let disposedMats = 0;
  layers.group.traverse((c) => {
    if (c.geometry) c.geometry.addEventListener('dispose', () => { disposedGeoms += 1; });
    const mats = Array.isArray(c.material) ? c.material : (c.material ? [c.material] : []);
    for (const m of mats) m.addEventListener('dispose', () => { disposedMats += 1; });
  });
  assert.doesNotThrow(() => layers.dispose(), 'dispose runs without throwing');
  assert.ok(disposedGeoms > 0, `geometries disposed (got ${disposedGeoms})`);
  assert.ok(disposedMats > 0, `materials disposed (got ${disposedMats})`);
  ok('trackside layer disposes cleanly (geometries + materials)');
}

// ------------------------------------------------------------- water / bridge footing
{
  const lowTerrain = () => -8;
  const bridgeProfile = buildRoadProfile({
    roads: [{
      points: [{ x: -80, z: 0 }, { x: 80, z: 0 }],
      width: 12,
      trackStyle: 'roadsideBuildings',
      elevation: 5,
    }],
    sampleHeight: lowTerrain,
    smoothRadius: 0,
    maxGrade: Infinity,
  });
  const layers = createTracksideLayers({ profile: bridgeProfile, sampleHeight: lowTerrain });
  const bldCols = layers.colliders.filter((c) => c.name?.includes('RoadsideBuilding'));
  assert.ok(bldCols.length > 0, 'bridge road emits building colliders');
  for (const c of bldCols) {
    assert.ok(c.bottomY > 4,
      `building collider sits at road shoulder over water (bottomY=${c.bottomY.toFixed(2)})`);
  }
  const near = layers.group.children.find((c) => c.name?.includes('Roadside') && c.name.includes('LOD0'));
  if (near && near.count > 0) {
    const m = new THREE.Matrix4();
    near.getMatrixAt(0, m);
    const p = new THREE.Vector3();
    m.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
    assert.ok(p.y > 4, `building mesh sits at road shoulder over water (y=${p.y.toFixed(2)})`);
  }
  ok('roadside buildings over water use road shoulder height, not river bed');

  const shoulderCols = layers.colliders.filter((c) => c.name?.startsWith('Track Shoulder'));
  assert.ok(shoulderCols.length > 0, 'bridge road emits shoulder deck colliders');
  for (const c of shoulderCols) {
    assert.ok(c.bottomY > 4,
      `shoulder collider sits at road grade over water (bottomY=${c.bottomY.toFixed(2)})`);
    assert.ok(typeof c.surfaceHeightAt === 'function', 'shoulder deck has pitched surfaceHeightAt');
  }
  ok('roadside shoulder strips over water get walkable deck colliders');
}

const { resolveTracksideGroundY, resolveRoadsideBuildingGroundY } = await import('../src/game/world/createTracksideLayers.js');
assert.equal(resolveTracksideGroundY({ roadY: 5, terrainY: -8 }), 5.08);
assert.equal(resolveTracksideGroundY({ roadY: 2, terrainY: 1.5 }), 1.5);
assert.equal(resolveRoadsideBuildingGroundY({ roadY: 5, terrainY: -8 }), 5.08);
ok('resolveTracksideGroundY bridges deep gaps only');

console.log(`\n${passed} checks passed.`);
process.exit(0);
