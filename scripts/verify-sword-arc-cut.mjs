/**
 * Sword V-attack contract: target-free realtime aim and an immediate, radial cut.
 * Run: node scripts/verify-sword-arc-cut.mjs
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  collectWorldArcTargets,
  EnemyCutSystem,
} from '../src/game/systems/EnemyCutSystem.js';

const character = { group: new THREE.Group() };
character.group.position.set(10, 4, -3);

const target = (id, x, y, z, options = {}) => {
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 2, 0.8)));
  model.position.set(x, y, z);
  model.visible = options.visible !== false;
  return {
    id,
    model,
    collisionRadius: options.collisionRadius ?? 0.45,
    defeated: options.defeated ?? false,
    pendingCorpse: options.pendingCorpse ?? false,
  };
};

const around = [
  target('north', 10, 4, -11),
  target('south', 10, 4, 5),
  target('east', 18, 4, -3),
  target('west', 2, 4, -3),
];

const outside = target('outside', 20, 4, -3);
const above = target('above', 10, 8, -3);
const hidden = target('hidden', 10, 4, -4, { visible: false });

assert.deepEqual(
  collectWorldArcTargets({
    character,
    targets: [...around, outside, above, hidden],
  }).map((entry) => entry.id),
  ['north', 'south', 'east', 'west'],
  'the arc is radial/world-spaced, includes every direction, and rejects invalid range/height targets',
);
assert.deepEqual(
  collectWorldArcTargets({ character, targets: [] }),
  [],
  'the attack can arm and fire without a target',
);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
camera.position.set(10, 7, 5);
camera.lookAt(character.group.position);
camera.updateMatrixWorld(true);

const cut = new EnemyCutSystem();
cut.initialize(scene);
assert.equal(cut.enterCutMode({ character, camera }), true);
assert.equal(cut.state, 'aiming');
assert.equal(cut.slashGuide.visible, true);

cut.updateAim({
  delta: 0.25,
  input: { moveX: 1 },
  character,
  camera,
});
assert.notEqual(cut.aim.angle, Math.PI * 0.5, 'A/D changes the cut angle live');

let executions = 0;
cut.executeCuts = ({ enemy, cuts }) => {
  executions += 1;
  assert.equal(cuts.length, 1);
  const center = new THREE.Box3().setFromObject(enemy.model).getCenter(new THREE.Vector3());
  assert.ok(Math.abs(cuts[0].plane.distanceToPoint(center)) < 1e-6);
  return { props: [{}], keepEnemy: false, outcome: null };
};
const removed = [];
assert.equal(cut.beginCutSwing({
  character,
  enemies: around,
  enemySystem: {
    markDefeated() {},
    removeEnemy(enemy) { removed.push(enemy.id); },
  },
  propSystem: null,
  physicsSystem: {},
}), true);
assert.equal(executions, 4, 'release cuts every target before animation playback');
assert.deepEqual(removed, ['north', 'south', 'east', 'west']);
assert.equal(cut.cutCommitted, true);
assert.equal(cut.lastArcCutCount, 4);

cut.finishCutSwing();
cut.enterCutMode({ character, camera });
cut.beginCutSwing({
  character,
  enemies: [],
  enemySystem: null,
  propSystem: null,
  physicsSystem: {},
});
assert.equal(cut.lastResult, 'arc-miss', 'empty-space release still fires');

cut.dispose();
console.log('PASS: sword arc cut is realtime, target-free, radial, and immediate.');
