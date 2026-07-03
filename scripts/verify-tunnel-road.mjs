// Verifies the tunnel road type (trackStyle: 'tunnel'):
//   - roadY is a straight-line grade from portal to portal, ignoring whatever
//     the terrain does in between (flat if both ends are level) — NOT the
//     smoothed terrain-following profile ordinary roads get;
//   - terrain corridor: raise-only clamp never lowers terrain, leaves a real
//     mountain alone (already covers the bore), and berms up open/thin ground
//     to the minimum cover line, feathered at the corridor edge like other roads;
//   - portal approach: within TUNNEL_PORTAL_LENGTH of each end, terrain is
//     carved DOWN toward roadY (an open cutting exposing the bore mouth) instead
//     of being buried, tapering smoothly into the buried behavior deeper in;
//   - tunnel-cut terrain topology omits shell-intersecting cells from the Rapier
//     trimesh while allowing high collidable terrain to remain above the ceiling;
//   - every tunnel segment gets a physical road-floor deck even when roadY lies
//     below the natural terrain (and would normally be classified grounded);
//   - the bore shell (walls + arched ceiling) produces colliders that physically
//     contain a fast dynamic chassis on every side, not just left/right — this
//     re-creates the exact same headless-Rapier containment check
//     verify-trackside-wall-containment.mjs uses for the urbanCircuit wall band.
//
// Run: node scripts/verify-tunnel-road.mjs

import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';

const {
  buildRoadProfile, applyRoadCorridorHeight,
  TUNNEL_INTERIOR_HEIGHT, TUNNEL_ROCK_COVER, TUNNEL_PORTAL_LENGTH,
} = await import('../src/world/worldMap/roadProfile.js');
const { createTracksideLayers } = await import('../src/game/world/createTracksideLayers.js');
const { createRoadworks } = await import('../src/game/world/createRoadworks.js');
const { TRACK_CROSS_SECTIONS, resolveCrossSection } = await import('../src/game/world/trackCrossSection.js');
const { buildTerrainGridIndices, buildTerrainTrimeshData } = await import('../src/world/terrain/TerrainChunk.js');

await RAPIER.init();

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ---- preset resolves and carries the two new band kinds
{
  assert.ok(resolveCrossSection('tunnel'), 'tunnel preset resolves');
  const kinds = TRACK_CROSS_SECTIONS.tunnel.bands.map((b) => b.kind);
  assert.ok(kinds.includes('tunnelBore'), 'tunnel preset has a tunnelBore band');
  assert.ok(kinds.includes('tunnelLight'), 'tunnel preset has a tunnelLight band');
  ok('tunnel preset registered with tunnelBore + tunnelLight bands');
}

// ---- roadY is a straight-line grade, not a terrain-following trace
{
  // A bumpy hill in between two equal-elevation portals: a normal road would
  // smooth-trace the bump; a tunnel must ignore it entirely and stay level.
  const bumpyMountain = (x) => Math.max(0, 40 - Math.abs(x) * 0.6);
  const sampleHeight = (x) => bumpyMountain(x);
  const profile = buildRoadProfile({
    roads: [{ points: [{ x: -100, z: 0 }, { x: 0, z: 0 }, { x: 100, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  const built = profile.roads[0];
  const spread = Math.max(...built.roadY) - Math.min(...built.roadY);
  assert.ok(spread < 0.01, `roadY stays flat despite a 40m hill in between (spread=${spread.toFixed(3)})`);
  ok('tunnel roadY ignores terrain undulation (straight line between equal-height portals)');

  // Different portal elevations: roadY must be a straight (linear) grade, not a
  // curve that dips toward the terrain profile in between.
  const slopeRoads = buildRoadProfile({
    roads: [{ points: [{ x: -50, z: 0 }, { x: 0, z: 0 }, { x: 50, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight: (x) => (x + 50) * 0.4, // linear terrain rising 0 -> 40
    smoothRadius: 2, maxGrade: Infinity,
  }).roads[0];
  const midIdx = Math.floor(slopeRoads.n / 2);
  const expectedMid = (slopeRoads.roadY[0] + slopeRoads.roadY[slopeRoads.n - 1]) / 2;
  assert.ok(Math.abs(slopeRoads.roadY[midIdx] - expectedMid) < 0.5,
    `roadY at the midpoint sits on the straight line between the two portal elevations (got ${slopeRoads.roadY[midIdx].toFixed(2)}, expected ~${expectedMid.toFixed(2)})`);
  ok('tunnel roadY is a straight-line grade between differing portal elevations');
}

// ---- portal approach: open cutting tapering into the buried bore
{
  // Mountain whose slope starts right at the road endpoints, like a real
  // hillside at the tunnel mouth.
  const mountain = (x) => Math.max(0, 30 - Math.abs(x) * 0.5);
  const profile = buildRoadProfile({
    roads: [{ points: [{ x: -60, z: 0 }, { x: 0, z: 0 }, { x: 60, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight: mountain, smoothRadius: 2, maxGrade: Infinity,
  });

  // Right at the mouth (portalDist=0): fully carved down to roadY — flush, open.
  const mouth = profile.corridorAt(-60, 0);
  assert.equal(mouth.portalDist, 0);
  assert.equal(applyRoadCorridorHeight(mountain(-60), mouth, 0.8), mouth.roadY,
    'terrain is carved flush with roadY right at the portal mouth');
  ok('portal mouth is fully carved open (no berm blocking the entrance)');

  // Deep inside (portalDist far beyond TUNNEL_PORTAL_LENGTH): back to the
  // ordinary buried/raise-only behavior.
  const deep = profile.corridorAt(0, 0);
  assert.ok(deep.portalDist > TUNNEL_PORTAL_LENGTH);
  assert.equal(applyRoadCorridorHeight(mountain(0), deep, 0.8), mountain(0),
    'deep inside the mountain, terrain is left untouched (buried behavior)');
  ok('interior of the bore reverts to buried (raise-only) behavior past the portal length');

  // Within the portal zone itself (0..TUNNEL_PORTAL_LENGTH): stay fully carved
  // open — never berm up toward buried cover (that hid the headwall arch).
  const withinPortal = [0, 2, 6, 10, 14].map((x) => {
    const wx = -60 + x;
    const c = profile.corridorAt(wx, 0);
    return applyRoadCorridorHeight(mountain(wx), c, 0.8);
  });
  for (const value of withinPortal) {
    assert.equal(value, mouth.roadY,
      `portal zone stays carved flush with roadY (${withinPortal.map((v) => v.toFixed(2))})`);
  }
  ok('portal zone stays fully carved open (no bury blend over the headwall)');

  // Past the portal zone, buried cover eases in over TUNNEL_PORTAL_BURY_BLEND.
  const buryBlend = [14, 16, 20, 22].map((x) => {
    const wx = -60 + x;
    const c = profile.corridorAt(wx, 0);
    return applyRoadCorridorHeight(mountain(wx), c, 0.8);
  });
  for (let i = 1; i < buryBlend.length; i += 1) {
    assert.ok(buryBlend[i] >= buryBlend[i - 1] - 1e-9,
      `buried cover rises smoothly after the portal zone (${buryBlend.map((v) => v.toFixed(2))})`);
  }
  ok('buried cover rises smoothly after the portal zone');

  // No discontinuity at the portal/buried boundary (portalDist ≈ 14).
  const justInside = applyRoadCorridorHeight(mountain(-60 + 13.9), profile.corridorAt(-60 + 13.9, 0), 0.8);
  const justOutside = applyRoadCorridorHeight(mountain(-60 + 14.1), profile.corridorAt(-60 + 14.1, 0), 0.8);
  assert.ok(Math.abs(justOutside - justInside) < 0.5,
    `no jump at the portal/buried boundary (${justInside.toFixed(2)} -> ${justOutside.toFixed(2)})`);
  ok('portal-to-buried transition has no discontinuity');
}

// ---- visible portal frame (headwall) at each end of the bore
{
  const sampleHeight = () => 0;
  const profile = buildRoadProfile({
    roads: [{ points: [{ x: -60, z: 0 }, { x: 0, z: 0 }, { x: 60, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  const built = profile.roads[0];
  const bore = TRACK_CROSS_SECTIONS.tunnel.bands.find((b) => b.kind === 'tunnelBore');
  const segments = Math.max(2, Math.round(bore.archSegments ?? 6));
  const ringSize = segments + 3;

  const withFrames = createTracksideLayers({ profile, sampleHeight });
  const wallMesh = withFrames.group.children.find((c) => c.name === 'Trackside Walls');
  assert.ok(wallMesh, 'bore shell mesh exists');
  const vertCount = wallMesh.geometry.attributes.position.count;

  // Expect exactly 2 extra annulus rings (one per portal) beyond the tube itself:
  // (ringSize-1) quads * 4 verts, times 2 ends.
  const frameVerts = 2 * (ringSize - 1) * 4;
  const tubeVerts = (built.n - 1) * (ringSize - 1) * 4;
  assert.equal(vertCount, tubeVerts + frameVerts,
    `bore mesh includes both portal-frame annuli (${vertCount} verts = ${tubeVerts} tube + ${frameVerts} frame)`);
  ok(`built a visible portal frame at both bore ends (+${frameVerts} verts)`);

  withFrames.dispose();
}

// ---- bore reaches its own endpoint even when that endpoint is a junction
// (a plain road meeting the tunnel's mouth). The general-purpose intersection
// gate (INTERSECTION_CLEARANCE) is right for decorative signs/fences — it must
// NOT also delete the bore shell + portal frame exactly where the tunnel
// connects to another road, since that's precisely where the entrance is.
{
  const sampleHeight = () => 0;
  const isolated = buildRoadProfile({
    roads: [{ points: [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  const atJunction = buildRoadProfile({
    roads: [
      { points: [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }], width: 10, trackStyle: 'tunnel' },
      { points: [{ x: -30, z: 0 }, { x: 0, z: 0 }], width: 10 }, // meets the tunnel's mouth head-on
    ],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  assert.ok(atJunction.intersections.length > 0, 'test setup actually produced a junction at the tunnel mouth');

  const isolatedLayers = createTracksideLayers({ profile: isolated, sampleHeight });
  const junctionLayers = createTracksideLayers({ profile: atJunction, sampleHeight });
  assert.equal(junctionLayers.colliders.length, isolatedLayers.colliders.length,
    `bore colliders unaffected by an intersection at its own mouth (${junctionLayers.colliders.length} vs ${isolatedLayers.colliders.length})`);
  assert.ok(junctionLayers.colliders.some((c) => c.name.includes('-0-')),
    'bore colliders exist at segment 0 (right at the junction), not just deeper in');
  ok('tunnel bore + colliders are NOT suppressed by the intersection gate at its own junction');

  isolatedLayers.dispose();
  junctionLayers.dispose();
}

// ---- terrain corridor: raise-only clamp
{
  const sampleHeight = () => 0;
  const profile = buildRoadProfile({
    roads: [{ points: [{ x: -60, z: 0 }, { x: 60, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  const corridor = profile.corridorAt(0, 0);
  assert.ok(corridor?.tunnel, 'corridorAt tags the sample as a tunnel corridor');

  const minCover = TUNNEL_INTERIOR_HEIGHT + TUNNEL_ROCK_COVER;

  // A real mountain (terrain already exceeds min cover) is left untouched.
  const mountainH = minCover + 20;
  assert.equal(applyRoadCorridorHeight(mountainH, corridor, 0.8), mountainH,
    'mountain terrain already covering the bore is left untouched');
  ok('mountain terrain (well above min cover) is not carved');

  // Open ground (h=0, weight=1 at centerline) is raised to bury the bore.
  const raised = applyRoadCorridorHeight(0, corridor, 0.8);
  assert.equal(raised, minCover, 'open ground raised exactly to the min-cover line at full weight');
  ok(`open ground berms up to bury the bore (raised to ${raised.toFixed(1)}m)`);

  // Never lowers: a value already above 0 but below minCover only ever rises.
  const partial = applyRoadCorridorHeight(3, corridor, 0.8);
  assert.ok(partial >= 3, `partial cover (3m) never lowered (got ${partial.toFixed(2)})`);
  ok('raise-only clamp never lowers terrain');

  // Outside the corridor: untouched.
  const outside = profile.corridorAt(0, 500);
  assert.equal(outside, null, 'far outside the corridor returns null');
  assert.equal(applyRoadCorridorHeight(5, outside, 0.8), 5, 'null corridor leaves height untouched');
  ok('terrain outside the corridor is untouched');
}

// ---- terrain topology: the bore is a real visual/physics opening
{
  const resolution = 5;
  const cells = resolution - 1;
  const holeMask = new Uint8Array(cells * cells);
  for (let j = 1; j <= 2; j += 1) {
    for (let i = 1; i <= 2; i += 1) holeMask[j * cells + i] = 1;
  }
  const chunk = {
    cx: 0, cz: 0, size: 4, resolution,
    heights: new Float32Array(resolution * resolution).fill(4),
    holeMask,
  };
  const physicsIndices = buildTerrainGridIndices(chunk);
  assert.equal(physicsIndices.length / 3, 24, 'four cut cells remove eight terrain triangles');

  // The topology helper can apply a narrowed shell-intersection mask, retaining
  // high mountain cover rather than cutting an open trench through it.
  const visualMask = new Uint8Array(cells * cells);
  visualMask[1 * cells + 1] = 1;
  const visualIndices = buildTerrainGridIndices(chunk, resolution, visualMask);
  assert.equal(visualIndices.length / 3, 30, 'visual cut can be narrower than the full physics bore');
  ok('terrain grid supports a narrowed tunnel-shell cut that retains mountain cover');

  const { vertices, indices } = buildTerrainTrimeshData(chunk);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices), body);
  world.step();
  const down = { x: 0, y: -1, z: 0 };
  const throughBore = world.castRay(new RAPIER.Ray({ x: 0, y: 20, z: 0 }, down), 100, true);
  const onTerrain = world.castRay(new RAPIER.Ray({ x: -1.5, y: 20, z: 0 }, down), 100, true);
  assert.equal(throughBore, null, 'ray through the bore must not hit terrain');
  assert.ok(onTerrain && Math.abs(onTerrain.timeOfImpact - 16) < 1e-4, 'terrain beside the bore remains collidable');
  ok('Rapier terrain trimesh has an actual collision hole through the bore');
}

// ---- tunnel road ribbon always has a collidable floor
{
  const mountain = (x) => Math.max(0, 30 - Math.abs(x) * 0.5);
  const profile = buildRoadProfile({
    roads: [{ points: [{ x: -60, z: 0 }, { x: 0, z: 0 }, { x: 60, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight: mountain, smoothRadius: 2, maxGrade: Infinity,
  });
  const roadworks = createRoadworks({ profile, sampleHeight: mountain });
  const decks = roadworks.colliders.filter((collider) => collider.name.startsWith('Road Deck'));
  assert.equal(decks.length, profile.roads[0].n - 1, 'every tunnel segment needs a floor collider');
  ok('every tunnel segment has a physical road-floor deck');
  roadworks.dispose();
}

// ---- bore shell physically contains the vehicle (walls + ceiling)
{
  const sampleHeight = () => 0;
  const profile = buildRoadProfile({
    roads: [{ points: [{ x: -60, z: 0 }, { x: 0, z: 0 }, { x: 60, z: 0 }], width: 10, trackStyle: 'tunnel' }],
    sampleHeight, smoothRadius: 2, maxGrade: Infinity,
  });
  const built = profile.roads[0];
  const half = built.half;
  const bore = TRACK_CROSS_SECTIONS.tunnel.bands.find((b) => b.kind === 'tunnelBore');

  const layers = createTracksideLayers({ profile, sampleHeight });
  const colliders = layers.colliders;
  assert.ok(colliders.length > 0, 'tunnelBore produced colliders');
  assert.ok(colliders.some((c) => c.name.includes('Wall')), 'has wall colliders');
  assert.ok(colliders.some((c) => c.name.includes('Ceiling')), 'has a ceiling collider');
  ok(`built ${colliders.length} bore colliders (walls + ceiling)`);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  for (const c of colliders) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(c.halfExtents.x, c.halfExtents.y, c.halfExtents.z)
        .setTranslation(c.center.x, c.center.y, c.center.z)
        .setRotation(c.orientation)
        .setFriction(0.55).setRestitution(0),
      body,
    );
  }

  // Launch a chassis straight at the +z wall from inside the bore.
  const CHASSIS_HALF = [1.0, 0.4, 1.0];
  const wallOuterZ = half + bore.thickness;
  const startZ = half - 3;
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 1.2, startZ)
    .setLinvel(0, 0, 28)
    .setLinearDamping(0.05)
    .setCcdEnabled(true);
  const chassis = world.createRigidBody(desc);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF).setDensity(40).setFriction(0.55).setRestitution(0),
    chassis,
  );
  let maxZ = startZ;
  for (let step = 0; step < 240; step += 1) {
    world.step();
    maxZ = Math.max(maxZ, chassis.translation().z);
  }
  const chassisFarMax = maxZ + CHASSIS_HALF[2];
  assert.ok(chassisFarMax < wallOuterZ,
    `chassis never tunnels past the side wall (far face max ${chassisFarMax.toFixed(2)} < outer ${wallOuterZ.toFixed(2)})`);
  ok('side wall contains a fast chassis (no CCD tunnelling)');

  // Launch a second chassis straight UP toward the ceiling from the road surface.
  const ceilingDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 0.5, 0)
    .setLinvel(0, 22, 0)
    .setCcdEnabled(true);
  const ceilingChassis = world.createRigidBody(ceilingDesc);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF).setDensity(40).setFriction(0.55).setRestitution(0),
    ceilingChassis,
  );
  const apexY = bore.wallHeight + bore.archRise;
  let maxY = 0.5;
  for (let step = 0; step < 180; step += 1) {
    world.step();
    maxY = Math.max(maxY, ceilingChassis.translation().y);
  }
  assert.ok(maxY < apexY + 1.5, `chassis stopped by the ceiling (max y ${maxY.toFixed(2)}, apex ${apexY.toFixed(2)})`);
  ok(`ceiling contains a chassis launched upward (max y ${maxY.toFixed(2)}m vs apex ${apexY.toFixed(2)}m)`);

  layers.dispose();
}

console.log(`\nAll ${passed} tunnel-road checks passed.`);
