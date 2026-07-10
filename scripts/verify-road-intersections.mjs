import assert from 'node:assert/strict';
import { buildRoadProfile } from '../src/world/worldMap/roadProfile.js';
import { createRoadworks } from '../src/game/world/createRoadworks.js';
import { createTracksideLayers } from '../src/game/world/createTracksideLayers.js';

const flat = () => 4;
const horizontal = { id: 'horizontal', width: 8, points: [{ x: -30, z: 0 }, { x: 30, z: 0 }] };
const vertical = { id: 'vertical', width: 8, points: [{ x: 0, z: -30 }, { x: 0, z: 30 }] };

// An interior crossing has four distinct approaches and produces one junction.
const cross = buildRoadProfile({ roads: [horizontal, vertical], sampleHeight: flat, smoothRadius: 0, maxGrade: Infinity });
assert.equal(cross.intersections.length, 1);
assert.equal(cross.intersections[0].wayCount, 4);
assert.ok(cross.intersections[0].arms.every((arm) => Math.abs(Math.hypot(arm.x, arm.z) - 1) < 1e-9));

// All connected samples in the polygon core share exactly one elevation; the
// approach mask suppresses ordinary ribbon lines where decals take over.
const junction = cross.intersections[0];
for (const road of cross.roads) {
  const coreSamples = road.samples
    .map((point, i) => ({ point, i }))
    .filter(({ point }) => Math.hypot(point.x - junction.x, point.z - junction.z) <= junction.radius - 0.25);
  assert.ok(coreSamples.length > 0);
  for (const { i } of coreSamples) {
    assert.ok(Math.abs(road.roadY[i] - junction.y) < 1e-9, 'junction core must be level');
    assert.equal(road.intersectionMask[i], 0, 'ordinary paint must be removed in junction core');
  }
}

// A terminating side road forms a T, not a four-way junction.
const tProfile = buildRoadProfile({
  roads: [horizontal, { id: 'terminating', width: 8, points: [{ x: 0, z: -30 }, { x: 0, z: 0 }] }],
  sampleHeight: flat,
  smoothRadius: 0,
  maxGrade: Infinity,
});
assert.equal(tProfile.intersections.length, 1);
assert.equal(tProfile.intersections[0].wayCount, 3);
assert.equal(tProfile.intersections[0].kind, 't');
assert.equal(tProfile.intersections[0].sizeClass, 'medium');

// Two endpoint-joined roads are a continuous terrain/width transition, not a
// marked intersection. The runtime may still retain an internal seam footprint
// so unequal road widths are fully backed by cut terrain.
const continuation = buildRoadProfile({
  roads: [
    { id: 'west', width: 6, points: [{ x: -30, z: 0 }, { x: 0, z: 0 }] },
    { id: 'east', width: 10, points: [{ x: 0, z: 0 }, { x: 30, z: 8 }] },
  ],
  sampleHeight: flat,
  smoothRadius: 0,
  maxGrade: Infinity,
});
assert.equal(continuation.intersections[0].kind, 'continuation');
assert.equal(continuation.intersections[0].wayCount, 2);
assert.ok(continuation.roads.every((road) => [...road.intersectionMask].every((value) => value === 1)),
  'a continuous seam must retain ordinary road markings');

// A single spline can cross itself; its two distant longitudinal sections are
// treated as four approaches rather than averaged into one connection.
const selfCrossing = buildRoadProfile({
  roads: [{
    id: 'self-crossing',
    width: 8,
    points: [
      { x: -24, z: -20 }, { x: 24, z: 20 },
      { x: -24, z: 20 }, { x: 24, z: -20 },
    ],
  }],
  sampleHeight: flat,
  smoothRadius: 0,
  maxGrade: Infinity,
});
assert.ok(selfCrossing.intersections.some((entry) => entry.wayCount === 4), 'self-crossing road should form a four-way junction');

// A geometrically crossing road 5 m above another is an overpass.
const overpass = buildRoadProfile({
  roads: [horizontal, vertical],
  // The north/south road stays on a high ridge; smoothing leaves the crossing
  // road near the low surrounding grade, producing a genuine height separation.
  sampleHeight: (x, z) => Math.abs(x) < 0.5 ? 9 : 4,
  smoothRadius: 8,
  maxGrade: Infinity,
});
assert.equal(overpass.intersections.length, 0, 'grade-separated crossing must remain separate');

// Nearby parallel roads do not create a chain of false intersections.
const parallel = buildRoadProfile({
  roads: [horizontal, { id: 'parallel', width: 8, points: [{ x: -20, z: 1 }, { x: 20, z: 1 }] }],
  sampleHeight: flat,
  smoothRadius: 0,
  maxGrade: Infinity,
});
assert.ok(parallel.intersections.length <= 2);

// A wide ordinary bend must not collide with itself merely because dense samples
// on the two sides of the curve fall within the road's own snap width.
const wideBend = buildRoadProfile({
  roads: [{
    id: 'wide-bend', width: 24,
    points: [{ x: -60, z: 0 }, { x: -20, z: 0 }, { x: 0, z: 20 }, { x: 0, z: 60 }],
  }],
  sampleHeight: flat,
  smoothRadius: 0,
  maxGrade: Infinity,
});
assert.equal(wideBend.intersections.length, 0, 'a continuous wide bend must not produce one-arm junction pads');

// Runtime geometry includes one flat asphalt polygon plus dedicated white paint,
// and exposes detected way counts for diagnostics/editor overlays.
const roadworks = createRoadworks({ profile: cross, sampleHeight: flat });
assert.deepEqual(roadworks.group.userData.intersections.map((entry) => entry.wayCount), [4]);
const ribbon = roadworks.group.children.find((child) => child.name.startsWith('Road Ribbon '));
const paint = roadworks.group.getObjectByName('Intersection White Paint Decals');
assert.ok(ribbon?.geometry.getAttribute('roadIntersection'));
assert.ok(paint?.geometry.getAttribute('position').count > 0);
assert.ok([...paint.geometry.getAttribute('normal').array].some((value, i) => i % 3 === 1 && value > 0.9), 'paint decals must face upward');
roadworks.dispose();

// Track dressing must stop before a junction. In particular, neither visible wall
// triangles nor their physics boxes may span the cross street.
const styledProfile = buildRoadProfile({
  roads: [
    { ...horizontal, trackStyle: 'urbanCircuit' },
    vertical,
  ],
  sampleHeight: flat,
  smoothRadius: 0,
  maxGrade: Infinity,
});
const styledJunction = styledProfile.intersections[0];
const layers = createTracksideLayers({ profile: styledProfile, sampleHeight: flat });
const exclusion = styledJunction.radius + 2.5;
for (const collider of layers.colliders) {
  assert.ok(
    collider.maxX < styledJunction.x - exclusion || collider.minX > styledJunction.x + exclusion,
    `track wall collider ${collider.name} intrudes into intersection`,
  );
}
const walls = layers.group.getObjectByName('Trackside Walls');
const wallPositions = walls.geometry.getAttribute('position');
for (const vertexIndex of walls.geometry.index.array) {
  const x = wallPositions.getX(vertexIndex);
  assert.ok(Math.abs(x - styledJunction.x) > exclusion - 0.1, 'visible track wall intrudes into intersection');
}
layers.dispose();

// Wide-road junction conform: the topology-shaped junction polygon must be fully
// backed by weight-1 terrain conform at the leveled height —
// including past an unequal-width butt joint (where nearest-centerline selection
// once let the narrow road's feather shadow the wide road's full corridor) and
// in the pad corners of a perpendicular crossing.
{
  const buttProfile = buildRoadProfile({
    roads: [
      { id: 'wide', points: [{ x: -400, z: 0 }, { x: 0, z: 0 }], width: 42, elevation: 0 },
      { id: 'narrow', points: [{ x: 0, z: 0 }, { x: 400, z: 0 }], width: 32, elevation: 0 },
    ],
    sampleHeight: () => 10,
    smoothRadius: 2,
    maxGrade: Infinity,
  });
  for (const [qx, qz] of [[5, 25], [5, 28], [10, 30], [15, 25], [33, 10]]) {
    const c = buttProfile.corridorAt(qx, qz);
    assert.ok(c && c.weight >= 0.999 && Math.abs(c.roadY) < 1e-6,
      `unequal-width joint conform hole at (${qx},${qz}): ${c ? `weight ${c.weight.toFixed(2)}` : 'null'}`);
  }

  const crossProfile = buildRoadProfile({
    roads: [
      { id: 'wide', points: [{ x: -400, z: 0 }, { x: 400, z: 0 }], width: 42, elevation: 0 },
      { id: 'narrow', points: [{ x: 0, z: -400 }, { x: 0, z: 400 }], width: 8, elevation: 0 },
    ],
    sampleHeight: () => 10,
    smoothRadius: 2,
    maxGrade: Infinity,
  });
  const pad = crossProfile.intersections[0];
  assert.ok(pad && pad.grounded, 'crossing junction detected and grounded');
  for (const point of pad.footprint) {
    const c = crossProfile.corridorAt(point.x, point.z);
    assert.ok(c && c.weight >= 0.999,
      `junction polygon conform hole at (${point.x.toFixed(2)},${point.z.toFixed(2)}): ${c ? `weight ${c.weight.toFixed(2)}` : 'null'}`);
  }
}

// Large roads automatically receive a widened footprint, turn/slip markings,
// physical refuge islands, and instanced traffic/street lights.
{
  const largeProfile = buildRoadProfile({
    roads: [
      { id: 'large-ew', width: 18, points: [{ x: -80, z: 0 }, { x: 80, z: 0 }] },
      { id: 'large-ns', width: 18, points: [{ x: 0, z: -80 }, { x: 0, z: 80 }] },
    ],
    sampleHeight: flat,
    smoothRadius: 0,
    maxGrade: Infinity,
  });
  assert.equal(largeProfile.intersections[0].sizeClass, 'large');
  const works = createRoadworks({ profile: largeProfile, sampleHeight: flat });
  assert.ok(works.group.getObjectByName('Trafficlights'));
  assert.ok(works.group.getObjectByName('Streetlights'));
  assert.ok(works.group.getObjectByName('Intersection Traffic Islands'));
  assert.equal(works.colliders.filter((entry) => entry.name.startsWith('Traffic Island')).length, 4);
  works.dispose();
}

console.log('road intersection regression passed');
