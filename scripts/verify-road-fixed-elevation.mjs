import assert from 'node:assert/strict';
import {
  applyRoadCorridorHeight,
  buildRoadProfile,
} from '../src/world/worldMap/roadProfile.js';
import { normalizeRoad } from '../src/world/worldMap/worldMapSchema.js';
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

console.log('road fixed elevation verification passed');
