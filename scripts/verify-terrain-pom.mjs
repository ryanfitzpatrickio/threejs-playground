// verify-terrain-pom.mjs
//
// Guards P1 terrain parallax occlusion wiring (docs/terrain-infinite-distance-plan.md):
// ultra enables terrain POM, material builds with POM + macro paths, and chunk
// geometry can produce tangents for the vendored marcher.
//
// Run: node scripts/verify-terrain-pom.mjs  (or npm run verify:terrain-pom)

import * as THREE from 'three';
import { createTerrainBiomeMaterial } from '../src/game/materials/createTerrainBiomeMaterial.js';
import { createTerrainChunkMesh, createChunkData } from '../src/world/terrain/TerrainChunk.js';
import { sampleMacroFbm } from '../src/world/terrain/Procedural.js';
import { getQualityPreset } from '../src/game/config/qualityPresets.js';

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };

const ultra = getQualityPreset('ultra');
const pom = ultra.parallaxOcclusion;
if (pom?.enabled === true && pom?.terrain === true) ok('ultra enables terrain parallaxOcclusion');
else fail('ultra enables terrain parallaxOcclusion', JSON.stringify(pom));

try {
  const mat = createTerrainBiomeMaterial({
    parallaxOcclusion: pom,
    macroDetail: ultra.terrainMacroDetail,
    hextile: null,
  });
  if (mat.colorNode != null && mat.normalNode != null) ok('terrain material builds with POM + macro');
  else fail('terrain material builds with POM + macro', 'missing node slots');
} catch (err) {
  fail('terrain material builds with POM + macro', err.message);
}

try {
  const mat = createTerrainBiomeMaterial({
    hextile: { enabled: true },
    parallaxOcclusion: { enabled: false },
  });
  if (mat.colorNode != null) ok('hextile path still builds when POM disabled');
  else fail('hextile path still builds');
} catch (err) {
  fail('hextile path still builds', err.message);
}

const data = createChunkData({ cx: 0, cz: 0, size: 32, resolution: 5 });
const handle = createTerrainChunkMesh(data, { computeTangents: true, visualResolution: 5 });
const tangent = handle.geometry.getAttribute('tangent');
if (tangent && tangent.itemSize === 4) ok('terrain chunk geometry exposes vec4 tangents for POM');
else fail('terrain chunk tangents', tangent ? `size=${tangent.itemSize}` : 'missing');
handle.geometry.dispose();

const a = sampleMacroFbm(120.5, -48.25);
const b = sampleMacroFbm(120.5, -48.25);
const c = sampleMacroFbm(120.5, -48.26);
if (a === b) ok('macro fBm is deterministic at a fixed world coordinate');
else fail('macro fBm determinism', `${a} !== ${b}`);
if (a !== c) ok('macro fBm varies across world space');
else fail('macro fBm varies across world space');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll terrain POM / macro checks passed.');
