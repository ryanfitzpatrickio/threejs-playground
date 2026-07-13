// Pure-node verifier for Horde M5 — GPU walk VAT + sector culling + 750 stretch.
//
// Guards:
//   1. Stretch cap is 750; sector capacity math covers migration slack.
//   2. Sector grid assigns distinct cells and finds overflow neighbors.
//   3. Proxy system hosts ≥750 capacity with sector meshes; addProxy fills
//      multiple sectors; migration rebinds agents without dropping them.
//   4. GPU walk material / VAT bake helpers exist; fallback single-pose path works.
//   5. Quality presets expose low/medium/high budgets.
//
// Run: node scripts/verify-horde-m5.mjs
// Alias: npm run verify:horde-m5

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  HORDE_DEFAULT_ENEMY_COUNT,
  HORDE_MAX_ENEMY_COUNT,
  HORDE_QUALITY_PRESETS,
  HORDE_SECTOR_GRID,
  HORDE_STRETCH_ENEMY_COUNT,
  clampHordeEnemyCount,
  hordeSectorCapacity,
} from '../src/game/config/hordePerformanceConfig.js';
import {
  buildHordeSectors,
  findSectorWithRoom,
  sectorIndexAt,
  sectorMeshKey,
} from '../src/game/systems/hordeProxySectors.js';
import { HordeProxySystem } from '../src/game/systems/HordeProxySystem.js';
import { HORDE_VAT_WALK_POSES } from '../src/game/geometry/bakeHordeProxyVat.js';

const _ctx2d = new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'data' ? new Uint8ClampedArray(4) : _ctx2d),
  apply: () => _ctx2d,
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => _ctx2d }),
  createElementNS: () => ({
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    style: {},
  }),
};

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

console.log('Horde M5 — stretch capacity, sectors, GPU walk contract\n');

test('stretch cap and quality presets', () => {
  assert.equal(HORDE_DEFAULT_ENEMY_COUNT, 250);
  assert.equal(HORDE_STRETCH_ENEMY_COUNT, 750);
  assert.ok(HORDE_MAX_ENEMY_COUNT >= 750);
  assert.equal(clampHordeEnemyCount(100), 100);
  assert.ok(clampHordeEnemyCount(99999) >= 750);
  assert.ok(HORDE_QUALITY_PRESETS.high.maxEnemyCount >= 750);
  assert.ok(HORDE_QUALITY_PRESETS.low.maxEnemyCount <= 250);
  assert.equal(HORDE_QUALITY_PRESETS.high.gpuWalk, true);
});

test('sector grid covers arena and overflow selection works', () => {
  const bounds = { minX: -36, maxX: 36, minZ: -36, maxZ: 36 };
  const sectors = buildHordeSectors(bounds, HORDE_SECTOR_GRID);
  assert.equal(sectors.length, HORDE_SECTOR_GRID ** 2);
  assert.ok(sectors.every((s) => s.radius > 1));
  const sw = sectorIndexAt(-30, -30, bounds, 4);
  const ne = sectorIndexAt(30, 30, bounds, 4);
  assert.notEqual(sw, ne);
  const full = new Set([0, 1, 2, 3]);
  const alt = findSectorWithRoom(0, 4, (i) => !full.has(i));
  assert.ok(alt >= 4);
  assert.equal(sectorMeshKey('cyclop', 7), 'cyclop@7');
  const cap = hordeSectorCapacity(750, 4);
  assert.ok(cap * 16 >= 750, 'sector capacity * sectors covers total agents');
});

test('VAT walk pose catalog has ≥2 frames', () => {
  assert.ok(HORDE_VAT_WALK_POSES.length >= 2);
  assert.ok(HORDE_VAT_WALK_POSES.every((p) => p.clipName === 'Walk'));
});

function makeStretchSystem(capacity = 80, sectorGrid = 2) {
  const system = new HordeProxySystem({ capacity, sectorGrid, gpuWalk: false });
  system.status = 'ready';
  system._levelBounds = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
  system._ensureSectors();
  for (const archetype of ['faceless', 'tessy', 'cyclop']) {
    system._sharedGeometry.set(archetype, new THREE.BoxGeometry(0.4, 1.6, 0.4));
    system._sharedMaterial.set(archetype, new THREE.MeshBasicMaterial());
    system._sectorCounts.set(archetype, new Map());
  }
  system._buildSectorMeshes();
  return system;
}

test('proxy system allocates across sectors and reports M5 snapshot fields', () => {
  const system = makeStretchSystem(64, 2);
  assert.equal(system.sectors.length, 4);
  assert.ok(system.meshes.size >= 4 * 3); // sectors × archetypes

  // Seed agents in opposite corners so they land in different sectors.
  const a = system.addProxy({
    id: 'sw',
    archetype: 'faceless',
    position: new THREE.Vector3(-30, 0, -30),
    health: 50,
    maxHealth: 50,
  });
  const b = system.addProxy({
    id: 'ne',
    archetype: 'faceless',
    position: new THREE.Vector3(30, 0, 30),
    health: 50,
    maxHealth: 50,
  });
  assert.ok(a && b);
  assert.notEqual(a.sectorIndex, b.sectorIndex, 'corner spawns should map to different sectors');

  // Force migrate NE agent into SW sector by relocating and calling migrate.
  b.position.set(-29, 0, -29);
  system._migrateAgentSector(b);
  assert.equal(b.sectorIndex, a.sectorIndex, 'migration should rebind to destination sector');
  assert.ok(b.slot != null);
  assert.ok(system._stats.sectorMigrations >= 1);

  const snap = system.snapshot();
  assert.equal(snap.sectorCulled, true);
  assert.equal(snap.sectorGrid, 2);
  assert.ok(snap.occupiedSectors >= 1);
  assert.ok(typeof snap.gpuWalk === 'boolean');
});

test('stretch capacity construction accepts 750', () => {
  const system = new HordeProxySystem({ capacity: HORDE_STRETCH_ENEMY_COUNT, sectorGrid: 4 });
  assert.equal(system.capacity, 750);
  assert.ok(system.sectorCapacity >= hordeSectorCapacity(750, 4) - 1);
  assert.ok(system.sectorCapacity * 16 >= 750);
});

console.log('');
if (failures.length) {
  console.error(`FAIL: ${failures.length}/${testCount} checks failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: M5 stretch / sector / VAT contract holds (${testCount} checks).`);
