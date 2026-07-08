import assert from 'node:assert/strict';
import {
  applyRoadCorridorHeight,
  buildRoadProfile,
  clampBridgedRoadFloor,
} from '../src/world/worldMap/roadProfile.js';
import { applyRiverCorridorHeight } from '../src/world/worldMap/riverProfile.js';
import { normalizeRoad, roadElevationMode } from '../src/world/worldMap/worldMapSchema.js';
import { createRoadworks } from '../src/game/world/createRoadworks.js';

const points = [{ x: -20, z: 0 }, { x: 20, z: 0 }];
const bumpyHeight = (x, z) => 9 * Math.sin(x * 0.31) + 3 * Math.cos(z * 0.47);

const fixed = buildRoadProfile({
  roads: [{ id: 'fixed', points, width: 8, elevation: 5 }],
  sampleHeight: bumpyHeight,
  isWilds: (x) => x > -5 && x < 5,
});
assert.equal(fixed.roads.length, 1);
assert.ok([...fixed.roads[0].roadY].every((y) => y === 5), 'fixed profile must be flat');
assert.ok([...fixed.roads[0].grounded].every((value) => value === 1), 'fixed profile must always be grounded');
assert.ok([...fixed.roads[0].wilds].every((value) => value === 0), 'fixed profile must not create wilds gaps');
for (const x of [-15, 0, 15]) {
  const corridor = fixed.corridorAt(x, 0);
  assert.ok(corridor && corridor.weight === 1);
  assert.equal(applyRoadCorridorHeight(-30, corridor, 4), 5);
  assert.equal(applyRoadCorridorHeight(40, corridor, 4), 5);
}
const fixedRoadworks = createRoadworks({ profile: fixed, sampleHeight: () => -30 });
assert.equal(fixedRoadworks.colliders.length, 0, 'fixed grounded roads must not regain bridge colliders');
fixedRoadworks.dispose();

const fixedOverRiver = buildRoadProfile({
  roads: [{ id: 'fixed', points, width: 8, elevation: 5 }],
  sampleHeight: bumpyHeight,
});
const fixedRiverRoadworks = createRoadworks({
  profile: fixedOverRiver,
  sampleHeight: (x, z) => {
    let h = bumpyHeight(x, z);
    h = applyRoadCorridorHeight(h, fixedOverRiver.corridorAt(x, z), 4);
    if (Math.abs(z) < 12 && Math.abs(x) < 15) {
      h = applyRiverCorridorHeight(h, { bedY: -12, waterY: -6, weight: 1 });
      h = clampBridgedRoadFloor(h, fixedOverRiver.corridorAt(x, z), 4);
    }
    return h;
  },
  riverCorridorAt: (x, z) => (Math.abs(z) < 12 && Math.abs(x) < 15
    ? { bedY: -12, waterY: -6, weight: 1 }
    : null),
});
assert.equal(fixedRiverRoadworks.colliders.length, 0,
  'fixed roads grade terrain to roadY and must not regain bridge decks over rivers');
const shaped = fixedOverRiver.corridorAt(0, 0);
let terrainAtCrossing = bumpyHeight(0, 0);
terrainAtCrossing = applyRoadCorridorHeight(terrainAtCrossing, shaped, 4);
terrainAtCrossing = applyRiverCorridorHeight(terrainAtCrossing, { bedY: -12, waterY: -6, weight: 1 });
terrainAtCrossing = clampBridgedRoadFloor(terrainAtCrossing, shaped, 4);
assert.equal(terrainAtCrossing, 5, 'fixed road over river keeps terrain at roadY');
fixedRiverRoadworks.dispose();

const common = {
  roads: [{ id: 'follow', points, width: 8 }],
  sampleHeight: bumpyHeight,
  isWilds: (x) => x > -5 && x < 5,
};
const absent = buildRoadProfile(common);
const explicitNull = buildRoadProfile({
  ...common,
  roads: [{ ...common.roads[0], elevation: null }],
});
assert.deepEqual([...explicitNull.roads[0].roadY], [...absent.roads[0].roadY]);
assert.deepEqual([...explicitNull.roads[0].grounded], [...absent.roads[0].grounded]);

const crossing = buildRoadProfile({
  roads: [
    { id: 'flat', points: [{ x: -20, z: 0 }, { x: 20, z: 0 }], width: 8, elevation: 5 },
    { id: 'follow', points: [{ x: 0, z: -20 }, { x: 0, z: 20 }], width: 8 },
  ],
  sampleHeight: () => 4,
  smoothRadius: 0,
  maxGrade: Infinity,
});
assert.ok(crossing.intersections.length > 0, 'crossing roads should form an intersection');
assert.ok([...crossing.roads[0].roadY].every((y) => y === 5), 'intersection must not rewrite fixed road');
const followRoad = crossing.roads[1];
const middle = Math.floor(followRoad.n / 2);
assert.ok(Math.abs(followRoad.roadY[middle] - 5) < 1e-9, 'follow road must meet fixed elevation');

const normalized = normalizeRoad({ id: 'roundtrip', points, width: 8, elevation: -3.5 });
assert.equal(normalized.elevation, -3.5);
for (const elevation of [null, undefined, 'garbage', Infinity, {}, []]) {
  assert.equal(normalizeRoad({ id: 'invalid', points, width: 8, elevation }).elevation, null);
}

const gentle = buildRoadProfile({
  roads: [{ id: 'slope', points, width: 8, elevationMode: 'gentleSlope' }],
  sampleHeight: bumpyHeight,
  smoothRadius: 0,
  maxGrade: Infinity,
});
assert.equal(gentle.roads.length, 1);
const gentleRoad = gentle.roads[0];
assert.ok([...gentleRoad.grounded].every((value) => value === 1), 'gentle slope road must be grounded');
assert.ok(Math.abs(gentleRoad.roadY[0] - gentleRoad.terrainY[0]) < 1e-6,
  'gentle slope road starts flush with terrain (no top ledge)');
assert.ok(Math.abs(gentleRoad.roadY[gentleRoad.n - 1] - gentleRoad.terrainY[gentleRoad.n - 1]) < 1e-6,
  'gentle slope road ends flush with terrain');
const grades = [];
for (let k = 1; k < gentleRoad.n; k += 1) {
  const ds = gentleRoad.s[k] - gentleRoad.s[k - 1];
  if (ds > 1e-6) grades.push((gentleRoad.roadY[k] - gentleRoad.roadY[k - 1]) / ds);
}
const g0 = grades[0];
assert.ok(grades.every((g) => Math.abs(g - g0) < 1e-6), 'gentle slope road has uniform grade');
assert.ok((gentleRoad.edgeBlend ?? 6) >= 20, 'gentle slope uses a wider terrain feather');

const hillside = (x) => 12 + x * 0.35;
const cliff = buildRoadProfile({
  roads: [{ id: 'hill', points: [{ x: -30, z: 0 }, { x: 30, z: 0 }], width: 8, elevationMode: 'gentleSlope' }],
  sampleHeight: hillside,
  smoothRadius: 0,
  maxGrade: Infinity,
});
const hillRoad = cliff.roads[0];
assert.ok(Math.abs(hillRoad.roadY[0] - hillRoad.terrainY[0]) < 1e-6,
  'downhill gentle slope does not drop below terrain at the top');

const gentleNorm = normalizeRoad({ id: 'slope', points, width: 8, elevationMode: 'gentleSlope' });
assert.equal(gentleNorm.elevationMode, 'gentleSlope');
assert.equal(gentleNorm.elevation, null);

console.log('road fixed elevation verification passed');
