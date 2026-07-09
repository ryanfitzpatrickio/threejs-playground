// verify-terrain-infinite.mjs
//
// Regression guard for the infinite-view-distance stack (P0–P4):
// view distance reaches loaded terrain, horizon + parallax children exist,
// LOD ring config is coherent, and macro noise stays deterministic.
//
// Run: node scripts/verify-terrain-infinite.mjs

globalThis.document = {
  createElementNS: () => ({
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
  }),
};

import { createStreamingTerrainLevel } from '../src/game/world/createStreamingTerrainLevel.js';
import { getQualityPreset } from '../src/game/config/qualityPresets.js';
import { sampleMacroFbm } from '../src/world/terrain/Procedural.js';
import { terrainFadeRadius, syncTerrainViewDistance } from '../src/game/systems/terrainAerialUniforms.js';

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };

const ultra = getQualityPreset('ultra');
const level = createStreamingTerrainLevel(ultra, { worldMap: null });

if (Number.isFinite(level.viewDistance) && level.viewDistance > level.terrainReach) {
  ok(`viewDistance (${level.viewDistance}m) extends past terrainReach (${level.terrainReach}m)`);
} else {
  fail('viewDistance headroom', `view=${level.viewDistance} reach=${level.terrainReach}`);
}

const childNames = level.group.children.map((c) => c.name);
if (childNames.includes('Terrain Horizon')) ok('horizon skirt group present');
else fail('horizon skirt group present');
if (childNames.includes('Terrain Parallax Layers')) ok('parallax layers group present (ultra)');
else fail('parallax layers group present');

const rings = ultra.terrainLodRings ?? [];
const resolutions = ultra.terrainLodResolutions ?? [];
if (resolutions.length >= rings.length + 1) {
  ok(`LOD config has ${resolutions.length} resolutions for ${rings.length} ring boundaries`);
} else {
  fail('LOD ring/resolution pairing', `rings=${rings.length} res=${resolutions.length}`);
}

syncTerrainViewDistance(level.viewDistance, ultra.environment ?? {});
if (terrainFadeRadius.value === level.viewDistance) {
  ok('terrainFadeRadius syncs to level viewDistance');
} else {
  fail('terrainFadeRadius sync', `got ${terrainFadeRadius.value} expected ${level.viewDistance}`);
}

const a = sampleMacroFbm(40, -12);
const b = sampleMacroFbm(40, -12);
if (a === b) ok('macro fBm deterministic');
else fail('macro fBm deterministic');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll terrain infinite-distance wiring checks passed.');
