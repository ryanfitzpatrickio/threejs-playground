// verify-rally-pom.mjs
//
// Guards the P0 "free win" from docs/silhouette-pom-plan.md: the rally surface
// set already loads height.png but never sampled it. Ultra now points the
// vendored parallax-occlusion addon at that height map so dirt/mud roads get
// self-occluding relief.
//
// This checks the wiring, not the shader output (a real-browser WebGPU pass is
// needed to see pixels — see docs + [[playwright-webgpu-capture-limit]]):
//   1. the vendored addon's `three/tsl` imports all resolve (no import crash),
//   2. enabling POM builds a material without throwing and assigns the base
//      colour/roughness/normal node slots,
//   3. the default (POM-disabled) path still builds — no regression,
//   4. computeTangents() succeeds on a road-ribbon-shaped geometry (indexed,
//      with uv + normal), the P0 blocker the addon requires.
//
// Run: node scripts/verify-rally-pom.mjs  (or npm run verify:rally-pom)

import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { parallaxOcclusionUV } from '../src/three-addons/tsl/utils/ParallaxOcclusion.js';
import { createRallySurfaceMaterial } from '../src/game/materials/rallySurfaceTextures.js';
import { getQualityPreset } from '../src/game/config/qualityPresets.js';

let failures = 0;
const ok = (label) => console.log(`  ok  ${label}`);
const fail = (label, detail) => { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); };

// 1. Every TSL symbol the vendored addon imports must exist in this repo's three
//    build, or the module import throws at runtime.
const REQUIRED_TSL = [
  'Break', 'Fn', 'If', 'Loop', 'abs', 'clamp', 'dFdx', 'dFdy', 'dot', 'float',
  'max', 'min', 'mix', 'normalViewGeometry', 'normalize', 'positionViewDirection',
  'tangentGeometry', 'tangentView', 'texture', 'textureLevel', 'uv', 'vec2', 'vec3',
];
const missing = REQUIRED_TSL.filter((n) => TSL[n] === undefined);
if (missing.length === 0) ok('all addon TSL imports resolve');
else fail('addon TSL imports resolve', `missing: ${missing.join(', ')}`);

if (typeof parallaxOcclusionUV !== 'function') fail('parallaxOcclusionUV is a function');
else ok('parallaxOcclusionUV is a function');

// 2. The ultra preset actually enables POM (so createRoadworks turns it on).
const ultra = getQualityPreset('ultra').parallaxOcclusion;
if (ultra?.enabled === true) ok('ultra preset enables parallaxOcclusion');
else fail('ultra preset enables parallaxOcclusion', JSON.stringify(ultra));
for (const level of ['low', 'high']) {
  const p = getQualityPreset(level).parallaxOcclusion;
  if (p?.enabled === false) ok(`${level} preset disables parallaxOcclusion`);
  else fail(`${level} preset disables parallaxOcclusion`, JSON.stringify(p));
}

// A stand-in for the loaded surface set (node has no document, so the real
// loader returns null maps — pass explicit fake textures to exercise the graph).
function fakeMaps() {
  const tex = () => new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  return { map: tex(), normalMap: tex(), roughnessMap: tex(), heightMap: tex() };
}

// 3. POM-enabled build assigns the base node slots and does not throw.
try {
  const mat = createRallySurfaceMaterial(fakeMaps(), {
    parallaxOcclusion: { enabled: true, scale: 0.02, minLayers: 8, maxLayers: 32 },
  });
  const slots = ['colorNode', 'roughnessNode', 'normalNode'];
  const unset = slots.filter((s) => mat[s] == null);
  if (unset.length === 0) ok('POM-enabled material assigns colour/roughness/normal nodes');
  else fail('POM-enabled material assigns node slots', `unset: ${unset.join(', ')}`);
} catch (err) {
  fail('POM-enabled material builds without throwing', err.message);
}

// 4. Default (disabled) path still builds — regression guard.
try {
  const mat = createRallySurfaceMaterial(fakeMaps(), { parallaxOcclusion: { enabled: false } });
  if (mat.colorNode != null) ok('POM-disabled material still builds (default unchanged)');
  else fail('POM-disabled material still builds', 'colorNode unset');
} catch (err) {
  fail('POM-disabled material builds without throwing', err.message);
}

// 5. Tangents on the ACTUAL rendered geometry: chunkGeometriesByGrid emits
//    NON-indexed triangle soup, and THREE.computeTangents() requires an index —
//    so calling it directly on a chunk throws "Missing required attributes". The
//    fix adds a trivial sequential index first. This reproduces that path.
try {
  const geom = new THREE.BufferGeometry();
  // A single triangle as non-indexed soup with position + uv (like a chunk).
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1,
  ]), 2));
  geom.computeVertexNormals();

  // Direct computeTangents on non-indexed geometry logs an error and returns
  // early WITHOUT creating a tangent attribute — that was the bug (the POM
  // material then warned `"tangent" not found`). The console.error below is
  // expected and asserted-around.
  geom.computeTangents();
  if (geom.getAttribute('tangent') == null) ok('computeTangents() no-ops on non-indexed chunk geometry (the bug it guards)');
  else fail('computeTangents() no-ops on non-indexed geometry', 'it unexpectedly produced tangents');

  // The fix: add a trivial sequential index, then tangents build.
  const count = geom.attributes.position.count;
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) idx[i] = i;
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeTangents();
  const tangent = geom.getAttribute('tangent');
  if (tangent && tangent.itemSize === 4 && tangent.count === count) ok('trivial-index fix produces a vec4 tangent attribute');
  else fail('trivial-index fix produces tangents', tangent ? `count=${tangent.count} size=${tangent.itemSize}` : 'no tangent attribute');
} catch (err) {
  fail('tangent build on chunk-like geometry', err.message);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll rally POM wiring checks passed.');
