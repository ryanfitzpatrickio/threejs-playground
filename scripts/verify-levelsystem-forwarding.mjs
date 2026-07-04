// Guards the class of bug behind "car falls through in world mode": a level method
// that a game system calls on the LevelSystem WRAPPER (e.g. VehicleSystem holds
// `this.level = levelSystem`) must actually be forwarded to the underlying level.
// Optional chaining (`this.level.foo?.()`) hides a missing forward as a silent
// no-op, so adding a raw-level method + consuming it via the wrapper without
// forwarding compiles, passes other tests, and fails only in the live game.
//
// This asserts every wrapper-consumed method (a) exists on LevelSystem and (b)
// actually delegates to the underlying level (or its geometryIndex), by spying on
// a stub level. Add to this list whenever a system calls a new level method on the
// wrapper.
//
// Run: node scripts/verify-levelsystem-forwarding.mjs

// Headless DOM stub (LevelSystem's import graph reaches the terrain material).
globalThis.document = {
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LevelSystem } from '../src/game/systems/LevelSystem.js';

const calls = [];
const spy = (name, ret) => (...args) => { calls.push(name); return typeof ret === 'function' ? ret(...args) : ret; };

const stubLevel = {
  group: new THREE.Group(),
  updateStreaming: spy('updateStreaming', {}),
  getGroundHeightAt: spy('getGroundHeightAt', 1),
  getRoadSurfaceAt: spy('getRoadSurfaceAt', 'dirt'),
  getBlockingColliderAt: spy('getBlockingColliderAt', null),
  ensureGroundCollider: spy('ensureGroundCollider', true),
  geometryIndex: {
    entries: [],
    raycast: spy('geometryIndex.raycast', []),
    warmupBoundsTrees: spy('geometryIndex.warmupBoundsTrees', 0),
  },
};

const ls = new LevelSystem();
ls.level = stubLevel;

// name on LevelSystem -> [invoke it, name of the underlying call it must trigger]
const cases = [
  ['getGroundHeightAt', () => ls.getGroundHeightAt(new THREE.Vector3(), 0.5), 'getGroundHeightAt'],
  ['getRoadSurfaceAt', () => ls.getRoadSurfaceAt(0, 0), 'getRoadSurfaceAt'],
  ['ensureGroundCollider', () => ls.ensureGroundCollider(new THREE.Vector3(), {}), 'ensureGroundCollider'],
  ['getBlockingColliderAt', () => ls.getBlockingColliderAt({ position: new THREE.Vector3(), radius: 0.3 }), 'getBlockingColliderAt'],
  ['updateStreaming', () => ls.updateStreaming(new THREE.Vector3()), 'updateStreaming'],
  ['raycastGeometry', () => ls.raycastGeometry({}), 'geometryIndex.raycast'],
  ['warmupGeometryRaycasts', () => ls.warmupGeometryRaycasts({}), 'geometryIndex.warmupBoundsTrees'],
];

for (const [method, invoke, underlying] of cases) {
  assert.equal(typeof ls[method], 'function', `LevelSystem.${method} is missing (systems call it on the wrapper)`);
  calls.length = 0;
  invoke();
  assert.ok(
    calls.includes(underlying),
    `LevelSystem.${method} did not delegate to the level (expected underlying "${underlying}", saw [${calls.join(', ')}]). ` +
    'A wrapper method that does not forward is a silent no-op in the live game.',
  );
  console.log(`ok: LevelSystem.${method} -> ${underlying}`);
}

console.log('levelsystem forwarding regression passed');
