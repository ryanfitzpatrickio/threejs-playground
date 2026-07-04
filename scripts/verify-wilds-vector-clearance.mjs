import assert from 'node:assert/strict';
import { isForestCorridorExcluded } from '../src/game/world/createZoneForest.js';
import { buildRoadProfile } from '../src/world/worldMap/roadProfile.js';
import { buildRiverProfile } from '../src/world/worldMap/riverProfile.js';

const flatGround = () => 12;

// Non-origin coordinates model vectors after a placed blueprint's local→world
// translation. Mark the entire road as Wilds to cover the bridged-road path.
const road = buildRoadProfile({
  roads: [{
    points: [{ x: 140, z: -90 }, { x: 240, z: -90 }],
    width: 8,
  }],
  sampleHeight: flatGround,
  isWilds: () => true,
  smoothRadius: 2,
  maxGrade: Infinity,
}).corridorAt;

const river = buildRiverProfile({
  rivers: [{
    points: [{ x: -210, z: 75 }, { x: -110, z: 75 }],
    width: 10,
    depth: 5,
  }],
  sampleHeight: flatGround,
  smoothRadius: 2,
}).corridorAt;

assert.equal(isForestCorridorExcluded(190, -90, road, river), true,
  'tree on a translated Wilds road must be rejected');
assert.equal(isForestCorridorExcluded(190, -101, road, river), true,
  'tree in the road edge feather must be rejected');
assert.equal(isForestCorridorExcluded(-160, 75, road, river), true,
  'tree on a translated river must be rejected');
assert.equal(isForestCorridorExcluded(-160, 87, road, river), true,
  'tree on the river bank feather must be rejected');
assert.equal(isForestCorridorExcluded(0, 0, road, river), false,
  'tree away from authored vectors must remain eligible');
assert.equal(isForestCorridorExcluded(0, 0, null, null), false,
  'maps without roads or rivers must remain eligible');

console.log('Wilds vector clearance verification passed.');
