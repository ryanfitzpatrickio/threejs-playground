// Pure-node lifecycle verifier for the M1 capability-based enemy refactor.
//
// Exercises the REAL EnemySystem spawn/despawn/clear/markDefeated APIs and the
// REAL PhysicsSystem.addEnemyCollider against a real Rapier world, using MOCK
// enemy records (no GLB needed — M1 is decoupled from the M0 assets). Guards the
// horde restart/defeat contract:
//   - one collider per spawned instance, none leaked across despawn/respawn;
//   - addEnemyCollider is idempotent (no double-body);
//   - markDefeated fires onEnemyDefeated exactly once across duplicate lethal calls;
//   - survivable state leaves an enemy alive (defeated stays false);
//   - clearEnemies purges enemies, colliders, deferred ragdolls, and slots;
//   - playerSlots grow on demand (the array is sized from ENEMY_COUNT=0);
//   - wave completion is `!defeated`, not array length (corpses don't count).
//
// Run: node scripts/verify-horde-lifecycle.mjs

import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EnemySystem } from '../src/game/systems/EnemySystem.js';
import { PhysicsSystem } from '../src/game/systems/PhysicsSystem.js';
import { ENEMY_ARCHETYPES } from '../src/game/config/enemyArchetypes.js';

// Headless canvas stub so the createGltfLoader import chain (DRACOLoader etc.)
// doesn't throw under node. Same pattern as verify-vehicle-suspension.mjs.
const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, setAttribute() {}, style: {} }),
};

await RAPIER.init();

const GRAVITY = { x: 0, y: -9.81, z: 0 };
const failures = [];
let testCount = 0;

function test(name, fn) {
  testCount += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function makePhysics() {
  const physics = new PhysicsSystem();
  // Skip initialize() (it builds a character controller) — addEnemyCollider
  // only needs RAPIER + world.
  physics.RAPIER = RAPIER;
  physics.world = new RAPIER.World(GRAVITY);
  return physics;
}

// Mock enemy: a plain THREE.Group model + the fields the lifecycle methods read.
// Capability fields are stamped from the real registry so the capability-gated
// paths (resolveCutStyle etc.) resolve the same way they will for a real clone.
function makeMockEnemy(id, { archetype = 'soldier' } = {}) {
  const cfg = ENEMY_ARCHETYPES[archetype] ?? ENEMY_ARCHETYPES.soldier;
  const model = new THREE.Group();
  model.name = id;
  model.position.set(0, 0, 0);
  return {
    id,
    archetype,
    boneScheme: cfg.boneScheme,
    rigProfile: cfg.rigProfile,
    cutProfile: cfg.cutProfile,
    limbLossProfile: cfg.limbLossProfile ?? null,
    model,
    mixer: { stopAllAction() {} },
    collisionRadius: cfg.collisionRadius,
    collisionHeight: cfg.collisionHeight,
    physicsBody: null,
    physicsCollider: null,
    playerSlotIndex: null,
    defeated: false,
    defeatCause: null,
    health: cfg.maxHealth,
    maxHealth: cfg.maxHealth,
  };
}

console.log('Horde lifecycle (M1) — mock enemies against real EnemySystem + PhysicsSystem\n');

// 1. Spawn/despawn collider parity — no leak across respawn.
test('spawn 10 -> 10 bodies; despawn 5 -> 5; spawn 5 -> 10 (no leak)', () => {
  const physics = makePhysics();
  const es = new EnemySystem();
  const enemies = [];
  for (let i = 0; i < 10; i += 1) {
    const e = makeMockEnemy(`e${i}`);
    enemies.push(e);
    es.enemies.push(e);
    physics.addEnemyCollider(e);
  }
  assert.equal(physics.enemyBodies.length, 10);
  for (const e of enemies) {
    assert.ok(e.physicsBody, `${e.id} missing physicsBody`);
    assert.ok(e.physicsCollider, `${e.id} missing physicsCollider`);
  }
  for (let i = 0; i < 5; i += 1) {
    es.despawnEnemy(enemies[i], { physicsSystem: physics });
  }
  assert.equal(physics.enemyBodies.length, 5, 'bodies not freed on despawn');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(enemies[i].physicsBody, null, `despawned enemy ${enemies[i].id} still has a body`);
  }
  assert.equal(es.enemies.length, 5, 'despawned enemies not removed from array');
  for (let i = 10; i < 15; i += 1) {
    const e = makeMockEnemy(`e${i}`);
    enemies.push(e);
    es.enemies.push(e);
    physics.addEnemyCollider(e);
  }
  assert.equal(physics.enemyBodies.length, 10, 'respawn leaked bodies');
});

// 2. addEnemyCollider is idempotent.
test('addEnemyCollider twice on one enemy -> one body, same reference', () => {
  const physics = makePhysics();
  const e = makeMockEnemy('idem');
  physics.addEnemyCollider(e);
  const before = physics.enemyBodies.length;
  const body1 = e.physicsBody;
  physics.addEnemyCollider(e);
  assert.equal(physics.enemyBodies.length, before, 'idempotent guard failed — leaked a second body');
  assert.equal(e.physicsBody, body1, 'physicsBody reference changed');
});

// 3. markDefeated is idempotent and fires the subscriber exactly once.
test('markDefeated 3x -> onEnemyDefeated fires once, enemy.defeated true', () => {
  const es = new EnemySystem();
  const e = makeMockEnemy('def');
  let calls = 0;
  let lastCause = null;
  es.onEnemyDefeated = (_enemy, cause) => { calls += 1; lastCause = cause; };
  assert.equal(es.markDefeated(e, 'firearm'), true, 'first markDefeated should return true');
  assert.equal(es.markDefeated(e, 'firearm'), false, 'second markDefeated should return false');
  assert.equal(es.markDefeated(e, 'sword-cut'), false, 'third markDefeated (diff cause) should still return false');
  assert.equal(calls, 1, 'onEnemyDefeated fired more than once');
  assert.equal(lastCause, 'firearm', 'cause should be the first lethal call');
  assert.equal(e.defeated, true);
  assert.equal(e.defeatCause, 'firearm');
  assert.ok(es._defeatedIds.has('def'), 'defeat id not tracked');
});

// 4. Survivable state leaves an enemy alive. (applySoldierPartialCut needs a
//    posed skinned mesh + real mixer, so this asserts the contract directly:
//    a fresh enemy is not defeated, and the defeat set only grows via markDefeated.
//    The partial-cut path's lack of a markDefeated call is enforced by the gate-6
//    capability check — see EnemySystem.applySoldierPartialCut.)
test('fresh enemy is alive (defeated=false); defeat set empty until markDefeated', () => {
  const es = new EnemySystem();
  const e = makeMockEnemy('pcut', { archetype: 'soldier' });
  assert.equal(e.defeated, false);
  assert.equal(e.defeatCause, null);
  assert.equal(es._defeatedIds.size, 0);
  // A survivable partial cut does not route through markDefeated; the enemy
  // remains in the alive set.
  assert.equal(es.enemies.filter((x) => !x.defeated).length, 0); // not yet spawned
  es.enemies.push(e);
  assert.equal(es.enemies.filter((x) => !x.defeated).length, 1);
});

// 5. clearEnemies purges enemies, colliders, deferred ragdolls, and slots.
test('clearEnemies purges bodies, ragdolls, slots, defeat set', () => {
  const physics = makePhysics();
  const es = new EnemySystem();
  es.lastPlayerPosition = new THREE.Vector3();
  const weaponMock = {
    _pendingRagdolls: [{ enemy: 'a' }, { enemy: 'b' }],
    clearPendingRagdolls() { this._pendingRagdolls.length = 0; },
  };
  for (let i = 0; i < 3; i += 1) {
    const e = makeMockEnemy(`c${i}`);
    es.enemies.push(e);
    es.ensurePlayerSlotCapacity();
    physics.addEnemyCollider(e);
    es.checkoutPlayerSlot(e);
  }
  assert.equal(physics.enemyBodies.length, 3);
  assert.ok(es.playerSlots.some((s) => s.holderId != null), 'no slot was claimed');
  es.markDefeated(es.enemies[0], 'firearm'); // defeat one pre-clear
  const removed = es.clearEnemies({ physicsSystem: physics, weaponSystem: weaponMock });
  assert.equal(removed, 3);
  assert.equal(es.enemies.length, 0);
  assert.equal(physics.enemyBodies.length, 0, 'bodies not purged');
  assert.equal(weaponMock._pendingRagdolls.length, 0, 'deferred ragdolls not purged');
  for (const slot of es.playerSlots) {
    assert.equal(slot.holderId, null, 'slot not released');
  }
  assert.equal(es._defeatedIds.size, 0, 'defeat set not cleared');
});

// 6. playerSlots grow on demand (array is sized from ENEMY_COUNT=0).
test('playerSlots grow on demand; checkout works past the initial empty pool', () => {
  const es = new EnemySystem();
  es.lastPlayerPosition = new THREE.Vector3();
  assert.equal(es.playerSlots.length, 0, 'pool should start empty (ENEMY_COUNT=0)');
  for (let i = 0; i < 20; i += 1) {
    const e = makeMockEnemy(`s${i}`);
    es.enemies.push(e);
    es.ensurePlayerSlotCapacity();
  }
  assert.ok(es.playerSlots.length >= 20, 'pool did not grow to fit spawns');
  const slot = es.checkoutPlayerSlot(es.enemies[0]);
  assert.ok(slot, 'checkout returned no slot despite capacity');
});

// 7. Wave-completion contract: alive = !defeated, NOT array length. Corpses
//    (defeated but not yet despawned) don't count; despawn removes from array.
test('wave completion: alive = !defeated, corpses dont count', () => {
  const es = new EnemySystem();
  const enemies = [];
  for (let i = 0; i < 3; i += 1) {
    const e = makeMockEnemy(`w${i}`);
    enemies.push(e);
    es.enemies.push(e);
  }
  const alive = () => es.enemies.filter((e) => !e.defeated).length;
  assert.equal(alive(), 3);
  // Two lethal blows — enemies stay in the array as pending corpses.
  es.markDefeated(enemies[0], 'firearm');
  es.markDefeated(enemies[1], 'sword-cut');
  assert.equal(alive(), 1, 'defeated-but-present corpses should not count as alive');
  assert.equal(es.enemies.length, 3, 'corpses removed too early');
  es.despawnEnemy(enemies[0]);
  es.despawnEnemy(enemies[1]);
  assert.equal(alive(), 1);
  assert.equal(es.enemies.length, 1);
  es.despawnEnemy(enemies[2]);
  assert.equal(alive(), 0, 'wave did not complete');
  assert.equal(es.enemies.length, 0);
});

console.log(`\n${testCount - failures.length}/${testCount} passed.`);
if (failures.length) {
  console.log('FAIL:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: M1 lifecycle contract holds (collider parity, idempotent defeat, clean restart, wave-completion accounting).');
