import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { MARA_ANIMATION_MANIFEST } from '../src/game/characters/mara/maraAnimationManifest.js';
import {
  resolveLocomotionSurface,
  resolveSurfacePlaybackState,
} from '../src/game/systems/AnimationStateSystem.js';
import {
  MUD_ON_FOOT_SPEED_SCALE,
  updateMudFootstepTrail,
} from '../src/game/systems/MovementSystem.js';

const mudStates = [
  'mudIdle', 'mudHurtingIdle', 'mudStumbleIdle', 'mudWaveIdle',
  'mudWalk', 'mudWalkBack', 'mudWalkTurnLeft', 'mudWalkTurnRight',
  'mudTurnLeft', 'mudTurnRight', 'mudBackTurnLeft', 'mudBackTurnRight',
  'mudRun', 'mudRunBack', 'mudRunTurnLeft', 'mudRunTurnRight',
  'mudRunBackTurnLeft', 'mudRunBackTurnRight', 'mudStandingJump', 'mudRunJump',
];

for (const state of mudStates) {
  const entry = MARA_ANIMATION_MANIFEST[state];
  assert.ok(entry, `${state} is registered`);
  await access(path.join('public', entry.url));
}

const available = new Set(mudStates);
const controller = { hasState: (state) => available.has(state) };
const resolve = (state, speed = 0) => resolveSurfacePlaybackState({
  state,
  movement: { speed },
  surface: 'mud',
  controller,
});

assert.equal(resolve('idle'), 'mudIdle');
assert.equal(resolve('jog', 2), 'mudWalk');
assert.equal(resolve('jog', 5), 'mudRun');
assert.equal(resolve('sprint', 8), 'mudRun');
assert.equal(resolve('jump'), 'mudStandingJump');
assert.equal(resolve('jumpMoving'), 'mudRunJump');
assert.equal(resolve('freeFall'), 'freeFall');
assert.equal(resolveSurfacePlaybackState({
  state: 'jog', movement: { speed: 5 }, surface: null, controller,
}), 'jog');
assert.equal(resolveSurfacePlaybackState({
  state: 'jog', movement: { speed: 5 }, surface: 'mud', controller: { hasState: () => false },
}), 'jog');

assert.equal(resolveLocomotionSurface({
  character: { group: { position: { x: 4, z: 8 } } },
  level: { getRoadSurfaceAt: (x, z) => (x === 4 && z === 8 ? 'mud' : null) },
}), 'mud');
assert.equal(MUD_ON_FOOT_SPEED_SCALE, 0.25, 'mud walking retains 25% speed (75% reduction)');

const stamps = [];
const walker = {
  group: { position: { x: 0, z: 0 }, rotation: { y: 0 } },
  velocity: { x: 0, z: 1 },
};
const mudLevel = { mudField: { stampFootprint: (...args) => stamps.push(args) } };
updateMudFootstepTrail({ character: walker, level: mudLevel, groundSurface: 'mud', grounded: true, moving: true });
walker.group.position.z = 0.43;
updateMudFootstepTrail({ character: walker, level: mudLevel, groundSurface: 'mud', grounded: true, moving: true });
walker.group.position.z = 0.86;
updateMudFootstepTrail({ character: walker, level: mudLevel, groundSurface: 'mud', grounded: true, moving: true });
assert.equal(stamps.length, 2, 'distance-driven footsteps stamp one print per stride');
assert.ok(stamps[0][0] * stamps[1][0] < 0, 'footprints alternate left/right');
assert.equal(stamps[0][2].side, -1);
assert.equal(stamps[1][2].side, 1);
assert.equal(stamps[0][2].depth, 0.065);

console.log(`verify-mara-mud-animations: ${mudStates.length} clips and mud remapping passed`);
