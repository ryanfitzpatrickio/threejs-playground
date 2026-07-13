// Pure-node verifier for Horde M6 — spectacle presets + density readability.
//
// Guards:
//   1. Preset ladder is ordered: default < stretch < spectacle < heavy < extreme
//   2. Default gate stays 250 (shipped readability); extreme is 2000 debug ceiling
//   3. getHordeSpectaclePreset falls back to default
//   4. Flock packs tighten with density (separation/congestion)
//   5. Proxy applySpectacleTuning mutates flock + far-walk LOD
//   6. fill/apply APIs exist on GameRuntime source contract
//
// Run: node scripts/verify-horde-m6.mjs
// Alias: npm run verify:horde-m6

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  HORDE_BENCHMARK_MAX_COUNT,
  HORDE_DEFAULT_ENEMY_COUNT,
  HORDE_MAX_ENEMY_COUNT,
  HORDE_SPECTACLE_ENEMY_COUNT,
  HORDE_SPECTACLE_HEAVY_COUNT,
  HORDE_SPECTACLE_PRESETS,
  HORDE_STRETCH_ENEMY_COUNT,
  clampHordeEnemyCount,
  getHordeSpectaclePreset,
  listHordeSpectaclePresetIds,
} from '../src/game/config/hordePerformanceConfig.js';
import { HordeProxySystem } from '../src/game/systems/HordeProxySystem.js';
import { DEFAULT_FLOCK_WEIGHTS } from '../src/game/systems/hordeFlockSteering.js';

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

console.log('Horde M6 — spectacle presets + density readability\n');

test('preset ladder and hard caps', () => {
  assert.equal(HORDE_DEFAULT_ENEMY_COUNT, 250);
  assert.equal(HORDE_STRETCH_ENEMY_COUNT, 750);
  assert.equal(HORDE_SPECTACLE_ENEMY_COUNT, 1000);
  assert.equal(HORDE_SPECTACLE_HEAVY_COUNT, 1500);
  assert.equal(HORDE_BENCHMARK_MAX_COUNT, 2000);
  assert.equal(HORDE_MAX_ENEMY_COUNT, HORDE_BENCHMARK_MAX_COUNT);
  assert.ok(
    HORDE_DEFAULT_ENEMY_COUNT
      < HORDE_STRETCH_ENEMY_COUNT
      < HORDE_SPECTACLE_ENEMY_COUNT
      < HORDE_SPECTACLE_HEAVY_COUNT
      < HORDE_BENCHMARK_MAX_COUNT,
  );
  assert.equal(clampHordeEnemyCount(99999), 2000);
  assert.equal(clampHordeEnemyCount(100), 100);
});

test('spectacle presets are complete and ordered by count', () => {
  const ids = listHordeSpectaclePresetIds();
  assert.deepEqual(ids, ['default', 'stretch', 'spectacle', 'heavy', 'extreme']);
  let prev = 0;
  for (const id of ids) {
    const p = HORDE_SPECTACLE_PRESETS[id];
    assert.ok(p.label, id);
    assert.ok(p.count > prev, `${id} count should increase`);
    assert.ok(p.flock?.separationDistance > 0, id);
    assert.ok(p.flock?.attackRadius > 0, id);
    assert.ok(Number.isFinite(p.fogDensity), id);
    assert.ok(Number.isFinite(p.farWalkDistance), id);
    prev = p.count;
  }
  assert.equal(getHordeSpectaclePreset('nope').id, 'default');
  assert.equal(getHordeSpectaclePreset('spectacle').count, 1000);
});

test('higher density packs tighten (not paste-blob)', () => {
  const d = getHordeSpectaclePreset('default').flock;
  const s = getHordeSpectaclePreset('spectacle').flock;
  const e = getHordeSpectaclePreset('extreme').flock;
  // Separation distance shrinks (tighter columns) but separate weight rises.
  assert.ok(s.separationDistance <= d.separationDistance);
  assert.ok(e.separationDistance <= s.separationDistance);
  assert.ok(s.separate >= d.separate);
  assert.ok(e.congestionFull >= d.congestionFull);
  // Far walk weight falls with density (tip stays animated).
  assert.ok(getHordeSpectaclePreset('spectacle').farWalkWeight
    <= getHordeSpectaclePreset('default').farWalkWeight);
  assert.equal(getHordeSpectaclePreset('extreme').farWalkWeight, 0);
});

test('proxy applySpectacleTuning updates flock + far LOD', () => {
  const system = new HordeProxySystem({ capacity: 64, sectorGrid: 2, gpuWalk: false });
  const before = system.flockWeights.separationDistance;
  const applied = system.applySpectacleTuning({
    flock: { separationDistance: 1.05, separate: 1.9, congestionFull: 30 },
    farWalkWeight: 0.2,
    farWalkDistance: 33,
  });
  assert.equal(system.flockWeights.separationDistance, 1.05);
  assert.equal(system.flockWeights.separate, 1.9);
  assert.notEqual(system.flockWeights.separationDistance, before);
  assert.equal(system.farWalkWeight, 0.2);
  assert.equal(system.farWalkDistance, 33);
  assert.equal(applied.farWalkWeight, 0.2);
  // Defaults still defined for untouched keys.
  assert.equal(system.flockWeights.flow, DEFAULT_FLOCK_WEIGHTS.flow);
});

test('Horde feature exposes fill/apply spectacle APIs', async () => {
  const snap = await readFile(new URL('../src/game/runtime/features/horde/hordeRuntimeSnapshot.js', import.meta.url), 'utf8');
  const spawn = await readFile(new URL('../src/game/runtime/features/horde/HordeSpawnController.js', import.meta.url), 'utf8');
  const loader = await readFile(new URL('../src/game/runtime/RuntimeLoader.js', import.meta.url), 'utf8');
  assert.match(snap, /applyHordeSpectaclePreset\(/);
  assert.match(spawn, /fillHordeToPreset\(/);
  assert.match(spawn, /fillHordeToCount\(/);
  assert.match(snap, /_applyHordeSpectacleAtmosphere\(/);
  assert.match(loader, /applyHordeSpectaclePreset\('default'\)/);
});

test('level keeps fog off by default (spectacle presets may enable)', async () => {
  const src = await readFile(
    new URL('../src/game/world/createHordeModeLevel.js', import.meta.url),
    'utf8',
  );
  assert.match(src, /fogEnabled:\s*false/);
  assert.match(src, /fogDensity:/);
  const presetSrc = await readFile(
    new URL('../src/game/config/hordePerformanceConfig.js', import.meta.url),
    'utf8',
  );
  assert.match(presetSrc, /fogEnabled:\s*false/);
  assert.match(presetSrc, /fogEnabled:\s*true/);
});

test('horde quality overrides cut open-world post costs', async () => {
  const { applyHordeLevelOverrides } = await import('../src/game/config/hordePerformance.js');
  const base = {
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    ssao: { enabled: true, samples: 16, resolutionScale: 1, updateInterval: 1 },
    environment: { clouds: 'volumetric', aerialPerspective: true },
    shadowClipmap: { enabled: true },
  };
  const city = applyHordeLevelOverrides(base, 'city');
  assert.equal(city.maxPixelRatio, 2);
  const horde = applyHordeLevelOverrides(base, 'horde');
  assert.ok(horde.maxPixelRatio <= 1.15);
  assert.ok(horde.shadowMapSize <= 1024);
  assert.equal(horde.environment.clouds, 'dome');
  assert.equal(horde.environment.aerialPerspective, false);
  assert.equal(horde.shadowClipmap.enabled, false);
  assert.ok(horde.ssao.samples <= 6);
});

console.log('');
if (failures.length) {
  console.error(`FAIL: ${failures.length}/${testCount} checks failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: M6 spectacle contract holds (${testCount} checks).`);
