/** Lightweight propane state-machine contract. */

import assert from 'node:assert/strict';
import {
  createPropaneTankModel,
  PROPANE_TANK_STATE,
} from '../src/game/items/propaneTankModel.js';

const model = createPropaneTankModel([
  { id: 'a', seed: 11 },
  { id: 'b', seed: 22 },
]);

let events = model.hit('a', { localPoint: [0.15, 0.4, 0], localNormal: [1, 0, 0] });
assert.equal(model.get('a').state, PROPANE_TANK_STATE.LEAKING);
assert.ok(events.some((event) => event.type === 'hole'));
assert.ok(events.some((event) => event.type === 'leakStart'));

events = model.hit('a', { damage: 1 });
assert.equal(model.get('a').state, PROPANE_TANK_STATE.BURNING);
assert.ok(events.some((event) => event.type === 'ignite'));
assert.ok(model.get('a').fuseRemaining >= 1.6 && model.get('a').fuseRemaining <= 2.4);

events = model.hit('a', { damage: 1 });
assert.equal(model.get('a').state, PROPANE_TANK_STATE.EXPLODED);
assert.ok(events.some((event) => event.type === 'detonate'));

assert.equal(model.scheduleChain('b', { instant: true }), true);
assert.equal(model.update(0).length, 0, 'chain does not recurse in the detonation frame');
events = model.update(0.01);
assert.equal(model.get('b').state, PROPANE_TANK_STATE.BURNING);
assert.ok(events.some((event) => event.type === 'ignite'));
events = model.update(0.1);
assert.equal(model.get('b').state, PROPANE_TANK_STATE.EXPLODED);
assert.ok(events.some((event) => event.type === 'detonate'));

console.log('PASS: propane leak, ignition, fuse, damage detonation, and staggered chain.');
