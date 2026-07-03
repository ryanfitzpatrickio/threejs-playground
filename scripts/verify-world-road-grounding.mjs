import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MovementSystem } from '../src/game/systems/MovementSystem.js';
import { AnimationStateSystem } from '../src/game/systems/AnimationStateSystem.js';
import { deckSurfaceHeightAt } from '../src/game/world/createRoadworks.js';
import { applyRoadCorridorHeight } from '../src/world/worldMap/roadProfile.js';

const dt = 1 / 60;
const movementSystem = new MovementSystem();
const animationSystem = new AnimationStateSystem();
const character = makeCharacter();
const physics = {
  // Deliberately miss every contact. Analytic support must carry grounded road
  // locomotion through the same one-frame misses seen at graded seams.
  moveCharacter: ({ movement }) => ({ movement: movement.clone(), grounded: false }),
};
const cameraBasis = {
  forward: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
};
const input = { moveX: 1, moveZ: 0, brace: false, jumpPressed: false };

const roadHeight = (x) => {
  if (x < 0 || x > 16) return -5;
  if (x <= 4) return x * 0.12;                    // uphill grade
  if (x <= 8) return 0.48;                        // segment seam / level deck
  if (x <= 12) return 0.48 - (x - 8) * 0.12;     // downhill grade
  return 0;                                       // bridge-to-terrain transition
};
const level = { getGroundHeightAt: (position) => roadHeight(position.x) };

for (let frame = 0; frame < 600 && character.group.position.x < 15.8; frame += 1) {
  const movement = movementSystem.update({ dt, delta: dt, input, character, level, physics, cameraBasis });
  assert.equal(movement.grounded, true, `lost support at x=${character.group.position.x.toFixed(3)}`);
  assert.equal(character.forceFreeFallTimer, 0, 'supported road movement armed forced free fall');
  assert.ok(Math.abs(character.group.position.y - roadHeight(character.group.position.x)) < 1e-6);
  const state = animationSystem.resolveAnimationState({ input, movement, character, delta: dt });
  assert.equal(state, 'jog', `unexpected supported locomotion state ${state}`);
}

input.brace = true;
let movement = movementSystem.update({ delta: dt, input, character, level, physics, cameraBasis });
assert.equal(animationSystem.resolveAnimationState({ input, movement, character, delta: dt }), 'sprint');
input.brace = false;

// Advance beyond the road: this is genuine support loss and must free-fall.
while (character.group.position.x <= 16.1) {
  movement = movementSystem.update({ delta: dt, input, character, level, physics, cameraBasis });
}
assert.equal(movement.grounded, false);
assert.ok(character.forceFreeFallTimer > 0);
assert.equal(animationSystem.resolveAnimationState({ input, movement, character, delta: dt }), 'freeFall');

// A pitched bridge query returns its local interpolated height, not the high end.
const bridge = { x0: 0, z0: 2, y0: 3, x1: 10, z1: 2, y1: 4.2 };
assert.equal(deckSurfaceHeightAt({ x: 0, z: 2, ...bridge }), 3);
assert.ok(Math.abs(deckSurfaceHeightAt({ x: 5, z: 2, ...bridge }) - 3.6) < 1e-9);
assert.equal(deckSurfaceHeightAt({ x: 10, z: 2, ...bridge }), 4.2);

// Normal jump remains airborne and does not use forced-free-fall walk-off state.
Object.assign(character, makeCharacter());
input.moveX = 0;
input.jumpPressed = true;
movement = movementSystem.update({ delta: dt, input, character, level: { getGroundHeightAt: () => 0 }, physics, cameraBasis });
assert.equal(movement.justJumped, true);
assert.equal(movement.grounded, false);
assert.equal(character.forceFreeFallTimer, 0);
input.jumpPressed = false;
for (let frame = 0; frame < 240 && !movement.grounded; frame += 1) {
  movement = movementSystem.update({ delta: dt, input, character, level: { getGroundHeightAt: () => 0 }, physics, cameraBasis });
}
assert.equal(movement.grounded, true, 'jump did not land normally');

// Road corridor height transform (applyRoadCorridorHeight) — the shared pure
// helper used by BOTH the baked shapeChunk pass and the continuous
// sampleShapedHeight pass. Under a BRIDGED corridor the shaped terrain must stay
// at or below roadY - BRIDGE_CLEARANCE for EVERY weight>0, or the Rapier
// heightfield punches up through the thin deck box (invisible barrier, worst in
// tall alpine/wilds terrain). The old weighted blend violated this; the hard
// clamp must not.
{
  const roadY = 5;
  const clearance = 0.8;
  const cap = roadY - clearance;
  const alpineH = 31; // mid-range wilds/alpine vertex (amplitude ~62, p~0.5)

  for (const w of [0, 0.25, 0.5, 0.75, 1]) {
    const shaped = applyRoadCorridorHeight(alpineH, { roadY, grounded: false, weight: w }, clearance);
    if (w === 0) {
      assert.equal(shaped, alpineH, 'zero-weight (outside corridor) should pass natural height through');
    } else {
      assert.ok(shaped <= cap + 1e-9,
        `bridged corridor leaked above the deck at weight ${w}: ${shaped} > ${cap}`);
    }
  }

  // Sanity: the OLD weighted blend (cap*w + min(h,cap)*(1-w)) DID exceed the cap
  // at mid weights — this is the regression we are guarding against.
  const oldBlend = (w) => alpineH * (1 - w) + Math.min(alpineH, cap) * w;
  assert.ok(oldBlend(0.5) > cap, 'expected the old blend to violate the cap (harness sanity)');

  // Grounded corridor grades terrain up to roadY at full weight.
  assert.equal(
    applyRoadCorridorHeight(alpineH, { roadY, grounded: true, weight: 1 }, clearance),
    roadY,
    'grounded corridor should grade to roadY at full weight',
  );

  // A deep gorge (already below the cap) is left untouched by the bridged clamp.
  const gorge = -40;
  assert.equal(
    applyRoadCorridorHeight(gorge, { roadY, grounded: false, weight: 1 }, clearance),
    gorge,
    'bridged clamp should not lower terrain already below the cap',
  );

  // null corridor (outside the road entirely) is a passthrough.
  assert.equal(applyRoadCorridorHeight(alpineH, null, clearance), alpineH);
}

console.log('world-road grounding regression passed');

function makeCharacter() {
  return {
    group: new THREE.Object3D(),
    velocity: new THREE.Vector3(),
    verticalVelocity: 0,
    grounded: true,
    pendingImpulse: new THREE.Vector3(),
    stamina: 1,
    forceFreeFallTimer: 0,
    groundSnapBlockTimer: 0,
    traversalRecoveryTimer: 0,
    airMomentumLockTimer: 0,
  };
}
