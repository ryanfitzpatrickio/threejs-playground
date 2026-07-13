// Pure-node checks for Horde M3 promote/demote/hit-target contracts.
// No GLB load — exercises EnemySystem safety helpers and proxy pose catalog.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  HORDE_EMERGENCY_MIN_RESIDENCE,
  HORDE_FULL_ACTOR_LIMIT,
  HORDE_FULL_ACTOR_MIN_RESIDENCE,
  HORDE_PROXY_DEMOTION_RADIUS,
  HORDE_PROXY_PROMOTION_RADIUS,
} from '../src/game/config/hordePerformanceConfig.js';
import { HORDE_PROXY_POSE_CATALOG } from '../src/game/config/hordeProxyPoses.js';
import { EnemySystem } from '../src/game/systems/EnemySystem.js';

const enemySystem = new EnemySystem();
const playerPosition = { x: 0, z: 0 };
const now = 20_000;

function mockActor(overrides = {}) {
  return {
    defeated: false,
    pendingCorpse: false,
    staggerTimer: 0,
    knockbackVelocity: null,
    state: 'chase',
    cutCount: 0,
    splitAnimationActive: false,
    limbLoss: { head: true, armL: true, armR: true, legL: true, legR: true },
    playerSlotIndex: null,
    hordePromotedAt: now - 5_000,
    model: { position: { x: 40, z: 0 }, rotation: { y: 0.5 } },
    id: 'mock-far',
    archetype: 'faceless',
    health: 70,
    maxHealth: 100,
    baseMaxHealth: 100,
    ...overrides,
  };
}

// Far, settled actor may demote under normal hysteresis.
assert.equal(
  enemySystem.isSafeToDemoteHordeActor(mockActor(), {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  true,
);

// Attackers / cut survivors / recent promotions never demote.
assert.equal(
  enemySystem.isSafeToDemoteHordeActor(mockActor({ state: 'attack' }), {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  false,
);
assert.equal(
  enemySystem.isSafeToDemoteHordeActor(mockActor({ cutCount: 1 }), {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  false,
);
assert.equal(
  enemySystem.isSafeToDemoteHordeActor(mockActor({
    hordePromotedAt: now - 50,
  }), {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  false,
);

// Emergency demotion may free a slot even inside the normal demotion band.
assert.equal(
  enemySystem.isSafeToDemoteHordeActor(mockActor({
    model: { position: { x: 10, z: 0 }, rotation: { y: 0 } },
    hordePromotedAt: now - HORDE_EMERGENCY_MIN_RESIDENCE * 1000 - 50,
  }), {
    now,
    minResidenceMs: HORDE_EMERGENCY_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: 0,
  }),
  true,
  'emergency demote ignores distance floor',
);

// Pose catalog covers the five anim families.
const anims = new Set(HORDE_PROXY_POSE_CATALOG.map((entry) => entry.anim));
for (const anim of ['idle', 'advance', 'attack', 'hit', 'fallen']) {
  assert.ok(anims.has(anim), `missing anim family ${anim}`);
}

// Source contracts for the combat promote seam.
const hordePopSource = await readFile(new URL('../src/game/runtime/features/horde/HordePopulationController.js', import.meta.url), 'utf8');
const hordeCombatSource = await readFile(new URL('../src/game/runtime/features/horde/HordeCombatAdapter.js', import.meta.url), 'utf8');
const hordeSpawnSource = await readFile(new URL('../src/game/runtime/features/horde/HordeSpawnController.js', import.meta.url), 'utf8');
const weaponSource = await readFile(new URL('../src/game/systems/WeaponSystem.js', import.meta.url), 'utf8');
const combatSource = await readFile(new URL('../src/game/systems/CombatSystem.js', import.meta.url), 'utf8');
const cutSource = await readFile(new URL('../src/game/systems/EnemyCutSystem.js', import.meta.url), 'utf8');

assert.match(hordePopSource, /emergencyPromoteHordeProxy\(/);
assert.match(hordePopSource, /_forceDemoteForEmergency\(/);
assert.match(hordeCombatSource, /getHordeCombatTargets\(/);
assert.doesNotMatch(hordeSpawnSource, /prepareGunLimbSever\?\.\(enemy\)/);
assert.match(weaponSource, /isHordeProxy/);
assert.match(weaponSource, /resolveHordeTarget/);
assert.match(combatSource, /isHordeProxy/);
assert.match(combatSource, /resolveHordeTarget/);
// Gun sever still computes region masks on demand (lazy, not at spawn).
assert.match(cutSource, /getGunRegionTriangleMask\(/);
assert.match(cutSource, /prepareGunLimbSever\(/);

assert.equal(HORDE_FULL_ACTOR_LIMIT, 24);
assert.ok(HORDE_PROXY_PROMOTION_RADIUS < HORDE_PROXY_DEMOTION_RADIUS);

console.log('PASS: Horde promotion / demotion / lazy sever contracts');
console.log({
  fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
  promotionRadius: HORDE_PROXY_PROMOTION_RADIUS,
  demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  poseCatalog: HORDE_PROXY_POSE_CATALOG.length,
  animFamilies: [...anims],
});
