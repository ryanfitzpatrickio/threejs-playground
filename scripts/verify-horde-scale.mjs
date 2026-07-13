// Pure-node structural verification for the first Horde max-count pass.
// Guards the configurable cap, spatial broad phase, and demotion safety rules
// without loading GLBs.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  HORDE_INITIAL_SPAWN_BURST,
  HORDE_FULL_ACTOR_LIMIT,
  HORDE_FULL_ACTOR_MIN_RESIDENCE,
  HORDE_EMERGENCY_MIN_RESIDENCE,
  HORDE_FULL_SPAWN_BATCH_PER_FRAME,
  HORDE_DEFAULT_ENEMY_COUNT,
  HORDE_MAX_ENEMY_COUNT,
  HORDE_STRETCH_ENEMY_COUNT,
  HORDE_SECTOR_GRID,
  HORDE_PROXY_DEMOTION_RADIUS,
  HORDE_PROXY_DEMOTIONS_PER_TICK,
  HORDE_PROXY_PROMOTION_RADIUS,
  HORDE_PROXY_VERTEX_LIMIT,
  HORDE_SPAWN_BATCH_PER_FRAME,
  clampHordeEnemyCount,
  hordeSectorCapacity,
} from '../src/game/config/hordePerformanceConfig.js';
import { EnemySystem } from '../src/game/systems/EnemySystem.js';
import { UniformSpatialGrid } from '../src/game/systems/UniformSpatialGrid.js';
import {
  buildHordeSectors,
  findSectorWithRoom,
  sectorIndexAt,
  sectorMeshKey,
} from '../src/game/systems/hordeProxySectors.js';

assert.equal(HORDE_DEFAULT_ENEMY_COUNT, 250);
assert.equal(HORDE_STRETCH_ENEMY_COUNT, 750);
assert.ok(HORDE_MAX_ENEMY_COUNT >= HORDE_STRETCH_ENEMY_COUNT);
assert.equal(HORDE_FULL_ACTOR_LIMIT, 24);
assert.equal(HORDE_SECTOR_GRID, 4);
assert.ok(hordeSectorCapacity(750, 4) >= Math.ceil(750 / 16));
assert.ok(HORDE_PROXY_DEMOTION_RADIUS > HORDE_PROXY_PROMOTION_RADIUS, 'demotion must hysteresis past promote');
assert.ok(HORDE_FULL_ACTOR_MIN_RESIDENCE > 0);
assert.ok(HORDE_EMERGENCY_MIN_RESIDENCE < HORDE_FULL_ACTOR_MIN_RESIDENCE);
assert.ok(HORDE_PROXY_DEMOTIONS_PER_TICK >= 1);
assert.ok(HORDE_PROXY_VERTEX_LIMIT >= 1_000);
assert.ok(HORDE_INITIAL_SPAWN_BURST > HORDE_FULL_SPAWN_BATCH_PER_FRAME);
assert.ok(HORDE_SPAWN_BATCH_PER_FRAME > HORDE_FULL_SPAWN_BATCH_PER_FRAME);
assert.equal(clampHordeEnemyCount(-2), 0);
assert.equal(clampHordeEnemyCount(19.9), 19);
assert.equal(clampHordeEnemyCount(9999), HORDE_MAX_ENEMY_COUNT);

const items = [];
let seed = 0x5eed1234;
for (let i = 0; i < 250; i += 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const x = (seed / 0x100000000) * 100 - 50;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const z = (seed / 0x100000000) * 100 - 50;
  items.push({ id: i, position: { x, z } });
}

const interactionDistance = 1.2;
const grid = new UniformSpatialGrid(interactionDistance);
grid.rebuild(items, (item) => item.position);
const emitted = new Set();
grid.forEachCandidatePair((first, second) => {
  const low = Math.min(first.id, second.id);
  const high = Math.max(first.id, second.id);
  const key = `${low}:${high}`;
  assert.equal(emitted.has(key), false, `duplicate candidate pair ${key}`);
  emitted.add(key);
});

let trueNeighborPairs = 0;
for (let a = 0; a < items.length; a += 1) {
  for (let b = a + 1; b < items.length; b += 1) {
    const dx = items[a].position.x - items[b].position.x;
    const dz = items[a].position.z - items[b].position.z;
    if (Math.hypot(dx, dz) > interactionDistance) continue;
    trueNeighborPairs += 1;
    assert.ok(emitted.has(`${a}:${b}`), `grid missed neighbor ${a}:${b}`);
  }
}

const bruteForcePairs = items.length * (items.length - 1) * 0.5;
assert.ok(grid.candidatePairs < bruteForcePairs * 0.05, {
  candidatePairs: grid.candidatePairs,
  bruteForcePairs,
});
assert.ok(trueNeighborPairs > 0, 'seeded set should exercise actual neighbors');

const hordeSpawnSource = await readFile(new URL('../src/game/runtime/features/horde/HordeSpawnController.js', import.meta.url), 'utf8');
const hordePopSource = await readFile(new URL('../src/game/runtime/features/horde/HordePopulationController.js', import.meta.url), 'utf8');
const hordeCombatSource = await readFile(new URL('../src/game/runtime/features/horde/HordeCombatAdapter.js', import.meta.url), 'utf8');
const frameSource = await readFile(new URL('../src/game/runtime/RuntimeFramePipeline.js', import.meta.url), 'utf8');
const enemySource = await readFile(new URL('../src/game/systems/EnemySystem.js', import.meta.url), 'utf8');
assert.match(hordeSpawnSource, /_processHordeSpawnQueue\(limit = HORDE_SPAWN_BATCH_PER_FRAME\)/);
assert.match(hordePopSource, /_processHordeDemotions\(/);
assert.match(hordePopSource, /emergencyPromoteHordeProxy\(/);
assert.match(hordeCombatSource, /resolveHordeCombatTarget\(/);
assert.match(frameSource, /this\.hordeProxySystem\.update\(/);
assert.match(hordeSpawnSource, /clampHordeEnemyCount\(count \?\? mods\.spawnCount\)/);
// Lazy limb prep: must not warm gun-sever masks on every full spawn.
assert.doesNotMatch(hordeSpawnSource, /prepareGunLimbSever\?\.\(enemy\)/);
assert.doesNotMatch(hordeSpawnSource, /Math\.min\(40, Math\.floor\(Number\(count/);
assert.match(enemySource, /new UniformSpatialGrid\(2\)/);
assert.match(enemySource, /isSafeToDemoteHordeActor\(/);
assert.match(enemySource, /demoteHordeActorToDescriptor\(/);
assert.doesNotMatch(enemySource, /for \(let b = a \+ 1; b < this\.enemies\.length/);

const proxySource = await readFile(new URL('../src/game/systems/HordeProxySystem.js', import.meta.url), 'utf8');
assert.match(proxySource, /loadProxyBakeSource/);
assert.match(proxySource, /proxyUrl/);
assert.match(proxySource, /DISPLAY_POSE/);
assert.match(proxySource, /stableSlots/);
assert.match(proxySource, /getHitTargets\(/);
assert.match(proxySource, /applyLightweightDamage\(/);
assert.match(proxySource, /sectorCulled|buildHordeSectors|_buildSectorMeshes/);
assert.match(proxySource, /bakeHordeProxyVatGeometry|createProxyVatMaterial|pose1/);
// Fixed draw range prevents WebGPU proxy strobing.

// M5 sector math
const bounds = { minX: -36, maxX: 36, minZ: -36, maxZ: 36 };
const sectors = buildHordeSectors(bounds, 4);
assert.equal(sectors.length, 16);
assert.equal(sectorIndexAt(0, 0, bounds, 4), sectorIndexAt(1, 1, bounds, 4));
assert.notEqual(sectorIndexAt(-30, -30, bounds, 4), sectorIndexAt(30, 30, bounds, 4));
assert.equal(sectorMeshKey('faceless', 3), 'faceless@3');
let filled = new Set([0, 1, 2]);
// Preferred sector 0 is full; spiral finds first free neighbor (index 4 = (0,1)).
const overflow = findSectorWithRoom(0, 4, (i) => !filled.has(i));
assert.ok(overflow >= 0 && !filled.has(overflow), `overflow sector ${overflow}`);
assert.match(proxySource, /mesh\.count = this\.sectorCapacity/);
assert.match(proxySource, /frustumCulled = true/);

const bakeSource = await readFile(new URL('../src/game/geometry/prepareBakedCrowdPoses.js', import.meta.url), 'utf8');
assert.match(
  bakeSource,
  /topology:\s*['"]indexed['"]/,
  'crowd pose bake must keep indexed topology so proxy GLBs stay under the vertex budget',
);

const skinnedBakeSource = await readFile(new URL('../src/game/geometry/bakeSkinnedModelGeometry.js', import.meta.url), 'utf8');
assert.match(skinnedBakeSource, /topology === 'indexed'/);

const archetypeSource = await readFile(new URL('../src/game/config/enemyArchetypes.js', import.meta.url), 'utf8');
assert.match(archetypeSource, /proxyUrl: '\/assets\/models\/horde\/cyclop-proxy\.glb'/);
assert.match(archetypeSource, /proxyUrl: '\/assets\/models\/horde\/tessy-proxy\.glb'/);
assert.match(archetypeSource, /proxyUrl: '\/assets\/models\/horde\/faceless-proxy\.glb'/);

const weaponSource = await readFile(new URL('../src/game/systems/WeaponSystem.js', import.meta.url), 'utf8');
assert.match(weaponSource, /resolveHordeTarget/);
assert.match(weaponSource, /hordeProxySystem/);

const combatSource = await readFile(new URL('../src/game/systems/CombatSystem.js', import.meta.url), 'utf8');
assert.match(combatSource, /resolveHordeTarget/);
assert.match(combatSource, /isHordeProxy/);

// Demotion safety rules against lightweight mock actors (no GLB load).
const enemySystem = new EnemySystem();
const playerPosition = { x: 0, z: 0 };
const now = 10_000;
const farSafe = {
  defeated: false,
  pendingCorpse: false,
  staggerTimer: 0,
  knockbackVelocity: null,
  state: 'chase',
  cutCount: 0,
  splitAnimationActive: false,
  limbLoss: { head: true, armL: true, armR: true, legL: true, legR: true },
  playerSlotIndex: null,
  hordePromotedAt: now - 2_000,
  model: { position: { x: 40, z: 0 }, rotation: { y: 1.2 } },
  id: 'far',
  archetype: 'faceless',
  health: 80,
  maxHealth: 100,
  baseMaxHealth: 100,
};
assert.equal(
  enemySystem.isSafeToDemoteHordeActor(farSafe, {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  true,
);
assert.equal(
  enemySystem.isSafeToDemoteHordeActor({ ...farSafe, state: 'attack' }, {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  false,
);
assert.equal(
  enemySystem.isSafeToDemoteHordeActor({
    ...farSafe,
    model: { position: { x: 10, z: 0 }, rotation: { y: 0 } },
  }, {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  false,
  'inside demotion radius must stay full',
);
assert.equal(
  enemySystem.isSafeToDemoteHordeActor({
    ...farSafe,
    hordePromotedAt: now - 100,
  }, {
    now,
    minResidenceMs: HORDE_FULL_ACTOR_MIN_RESIDENCE * 1000,
    playerPosition,
    demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  }),
  false,
  'residence hysteresis blocks thrashing',
);

console.log('PASS: Horde scale foundation (M2–M5: sectors + VAT + promote/demote/hit)');
console.log({
  defaultCap: HORDE_DEFAULT_ENEMY_COUNT,
  stretchCap: HORDE_STRETCH_ENEMY_COUNT,
  cap: HORDE_MAX_ENEMY_COUNT,
  sectorGrid: HORDE_SECTOR_GRID,
  initialBurst: HORDE_INITIAL_SPAWN_BURST,
  perFrameBatch: HORDE_SPAWN_BATCH_PER_FRAME,
  fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
  fullPerFrameBatch: HORDE_FULL_SPAWN_BATCH_PER_FRAME,
  promotionRadius: HORDE_PROXY_PROMOTION_RADIUS,
  demotionRadius: HORDE_PROXY_DEMOTION_RADIUS,
  demotionsPerTick: HORDE_PROXY_DEMOTIONS_PER_TICK,
  minResidenceSec: HORDE_FULL_ACTOR_MIN_RESIDENCE,
  emergencyResidenceSec: HORDE_EMERGENCY_MIN_RESIDENCE,
  displayPose: 'GPU walk VAT + sector cull',
  vertexLimit: HORDE_PROXY_VERTEX_LIMIT,
  items: items.length,
  gridCells: grid.cells.size,
  candidatePairs: grid.candidatePairs,
  bruteForcePairs,
  trueNeighborPairs,
});
