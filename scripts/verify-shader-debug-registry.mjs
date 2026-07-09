/**
 * Pure-node checks for ShaderDebugRegistry (PR1).
 * No WebGPU / Tweakpane — import registry directly.
 *
 *   npm run verify:shader-debug-registry
 */

import assert from 'node:assert/strict';
import {
  __resetShaderDebugRegistryForTests,
  registerShaderDebugFolder,
  registerUniformFloat,
  systemWrite,
  isUserOverride,
  hasAnyUserOverrideInFolder,
  clearOverridesForFolders,
  clearAllUserOverrides,
  clearUserOverride,
  getShaderDebugSnapshot,
  applyShaderDebugSnapshot,
  listShaderDebugParams,
} from '../src/game/debug/shaderDebugRegistry.js';

__resetShaderDebugRegistryForTests();

const uCoverage = { value: 0.5 };
const uDensity = { value: 0.02 };
const uBloom = { value: 0.8 };

registerShaderDebugFolder('Clouds Shape', { expanded: true });

registerUniformFloat('clouds.coverage', 'Clouds Shape', 'Coverage', uCoverage, { default: 0.5 });
registerUniformFloat('clouds.density', 'Clouds Shape', 'Density', uDensity, { default: 0.02 });
registerUniformFloat('post.bloom', 'Post', 'Bloom', uBloom, { default: 0.8 });

assert.equal(listShaderDebugParams().length, 3, 'three params registered');

// systemWrite applies when not pinned
assert.equal(systemWrite('clouds.coverage', () => { uCoverage.value = 0.9; }), true);
assert.equal(uCoverage.value, 0.9);

// user pin blocks systemWrite
const param = listShaderDebugParams().find((p) => p.id === 'clouds.coverage');
param.set(0.33);
assert.equal(uCoverage.value, 0.33);
assert.equal(isUserOverride('clouds.coverage'), true);
assert.equal(systemWrite('clouds.coverage', () => { uCoverage.value = 0.99; }), false);
assert.equal(uCoverage.value, 0.33, 'pinned coverage holds');

// density not pinned — system still writes
assert.equal(systemWrite('clouds.density', () => { uDensity.value = 0.12; }), true);
assert.equal(uDensity.value, 0.12);

// folder helpers
assert.equal(hasAnyUserOverrideInFolder('Clouds Shape'), true);
assert.equal(hasAnyUserOverrideInFolder('Post'), false);

// pin bloom, then clear only Clouds folders — bloom survives
param.set(0.4); // re-ensure coverage pin
listShaderDebugParams().find((p) => p.id === 'post.bloom').set(0.55);
assert.equal(isUserOverride('post.bloom'), true);

const cleared = clearOverridesForFolders(['Clouds Shape', 'Clouds Lighting', 'Clouds Wind']);
assert.ok(cleared >= 1, 'cleared at least coverage');
assert.equal(isUserOverride('clouds.coverage'), false);
assert.equal(isUserOverride('post.bloom'), true, 'bloom pin survives cloud-type folder clear');
assert.equal(hasAnyUserOverrideInFolder('Post'), true);

// full clear
clearAllUserOverrides();
assert.equal(isUserOverride('post.bloom'), false);

// clearUserOverride
listShaderDebugParams().find((p) => p.id === 'clouds.density').set(0.2);
assert.equal(clearUserOverride('clouds.density'), true);
assert.equal(isUserOverride('clouds.density'), false);

// snapshot round-trip
listShaderDebugParams().find((p) => p.id === 'clouds.coverage').set(0.77);
const snap = getShaderDebugSnapshot();
assert.equal(snap.params['clouds.coverage'].value, 0.77);
assert.equal(snap.params['clouds.coverage'].override, true);

clearAllUserOverrides();
uCoverage.value = 0.1;
applyShaderDebugSnapshot({ params: { 'clouds.coverage': { value: 0.66 } } }, { asOverride: true });
assert.equal(uCoverage.value, 0.66);
assert.equal(isUserOverride('clouds.coverage'), true);

console.log('verify-shader-debug-registry: ok');
