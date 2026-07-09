// Guards the SSAO / SSR / Off post-effect selector (see internal post-effects plan):
// - persistence + normalization of the stored mode (default `ssao`)
// - preset overrides (Low preserves the stored preference but resolves to `off`)
// - mutually exclusive pipeline branches (the SSAO normal pre-pass and the SSR
//   MRT must never be allocated together), including the non-WebGPU fallback
// - the vendored SSAONode / DualKawaseBloomNode link against three r185 exports
//
// Run: node scripts/verify-post-effects.mjs

import assert from 'node:assert/strict';

// localStorage shim for the persistence helpers.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  getPostEffectMode,
  setPostEffectMode,
  normalizePostEffectMode,
  resolveEffectivePostEffectMode,
  getQualityPreset,
} = await import('../src/game/config/qualityPresets.js');
const { buildPostPipelinePlan } = await import('../src/game/render/postPipelinePlan.js');

// --- persistence + normalization ---

assert.equal(getPostEffectMode(), 'ssao', 'missing stored value defaults to ssao');
assert.equal(setPostEffectMode('ssr'), 'ssr');
assert.equal(getPostEffectMode(), 'ssr', 'stored mode round-trips');
assert.equal(setPostEffectMode('off'), 'off');
assert.equal(getPostEffectMode(), 'off');
assert.equal(setPostEffectMode('garbage'), 'ssao', 'invalid write normalizes to ssao');
assert.equal(getPostEffectMode(), 'ssao');
store.set('dreamfall:post-effect', 'bogus');
assert.equal(getPostEffectMode(), 'ssao', 'invalid stored value normalizes to ssao');
for (const [input, expected] of [['ssao', 'ssao'], ['ssr', 'ssr'], ['off', 'off'], [null, 'ssao'], [undefined, 'ssao'], [42, 'ssao'], ['SSAO', 'ssao']]) {
  assert.equal(normalizePostEffectMode(input), expected, `normalize(${input}) -> ${expected}`);
}

// --- preset overrides ---

const high = getQualityPreset('high');
const ultra = getQualityPreset('ultra');
const low = getQualityPreset('low');

assert.equal(resolveEffectivePostEffectMode('ssao', high), 'ssao');
assert.equal(resolveEffectivePostEffectMode('ssr', high), 'ssr');
assert.equal(resolveEffectivePostEffectMode('off', high), 'off');
for (const mode of ['ssao', 'ssr', 'off']) {
  assert.equal(resolveEffectivePostEffectMode(mode, low), 'off', `low quality runs off (requested ${mode})`);
}
assert.equal(resolveEffectivePostEffectMode('ssao', ultra), 'ssao');
assert.equal(high.ssao.samples, 12, 'high preset uses 12 SSAO samples');
assert.equal(ultra.ssao.samples, 12, 'ultra keeps 12 SSAO samples');
assert.equal(high.ssao.radius, 1.25);
assert.equal(high.ssao.intensity, 1.9);
assert.equal(high.ssao.blur, true, 'high SSAO uses depth-aware blur to hide half-res sample grid');
assert.equal(high.ssao.resolutionScale, 0.5, 'SSAO runs at half resolution');
assert.equal(high.environment.bloomResolutionScale, 0.25, 'bloom runs at quarter resolution');

// --- mutually exclusive pipeline branches ---

for (const [presetName, preset] of [['high', high], ['ultra', ultra], ['low', low]]) {
  for (const requestedMode of ['ssao', 'ssr', 'off', 'garbage']) {
    for (const backend of ['webgpu', 'webgl2-fallback']) {
      const plan = buildPostPipelinePlan({ requestedMode, qualityPreset: preset, backend });
      const label = `${presetName}/${requestedMode}/${backend}`;
      assert.ok(!(plan.normalPrePass && plan.ssrMrt), `${label}: pre-pass and SSR MRT never coexist`);
      assert.equal(plan.normalPrePass, plan.effectiveMode === 'ssao', `${label}: pre-pass tracks ssao mode`);
      assert.equal(plan.ssrMrt, plan.effectiveMode === 'ssr', `${label}: MRT tracks ssr mode`);
      assert.equal(plan.ssao !== null, plan.effectiveMode === 'ssao', `${label}: ssao config tracks mode`);
      if (backend !== 'webgpu') {
        assert.equal(plan.effectiveMode, 'off', `${label}: fallback backend runs off`);
      }
      if (presetName === 'low') {
        assert.equal(plan.effectiveMode, 'off', `${label}: low quality runs off`);
        assert.equal(plan.bloom, null, `${label}: low quality has no bloom`);
      } else if (presetName === 'ultra') {
        assert.equal(plan.bloom, null, `${label}: ultra drops bloom from the gameplay hot path`);
      } else {
        assert.equal(plan.bloom?.implementation, 'dualKawase', `${label}: dual kawase bloom active`);
        assert.equal(plan.bloom?.resolutionScale, 0.25, `${label}: bloom at quarter resolution`);
      }
    }
  }
}

const highSsaoPlan = buildPostPipelinePlan({ requestedMode: 'ssao', qualityPreset: high, backend: 'webgpu' });
assert.equal(highSsaoPlan.requestedMode, 'ssao');
assert.deepEqual(highSsaoPlan.ssao, {
  resolutionScale: 0.5,
  samples: 12,
  radius: 1.25,
  intensity: 1.9,
  bias: 0.055,
  blurSharpness: 0.9,
  blur: true,
  updateInterval: 2,
});
assert.equal(highSsaoPlan.ssao.updateInterval, 2, 'high renders AO every other frame');
const ultraSsaoPlan = buildPostPipelinePlan({ requestedMode: 'ssao', qualityPreset: ultra, backend: 'webgpu' });
assert.deepEqual(ultraSsaoPlan.ssao, {
  resolutionScale: 0.5,
  samples: 12,
  radius: 1.25,
  intensity: 2.2,
  bias: 0.055,
  blurSharpness: 1.0,
  blur: true,
  updateInterval: 2,
});
assert.equal(ultraSsaoPlan.ssao.updateInterval, 2, 'ultra renders AO every other frame when static');
assert.equal(ultraSsaoPlan.bloom, null, 'ultra omits the bloom pass');

const interiorUltraPlan = buildPostPipelinePlan({
  requestedMode: 'ssao',
  qualityPreset: ultra,
  backend: 'webgpu',
  sceneContext: 'interior',
});
assert.equal(interiorUltraPlan.effectiveMode, 'off', 'office interior disables SSAO pre-pass');
assert.equal(interiorUltraPlan.normalPrePass, false);
assert.equal(interiorUltraPlan.sceneContext, 'interior');

const { mergeQualityPresetForScene } = await import('../src/game/config/qualityPresets.js');
assert.equal(mergeQualityPresetForScene(ultra, 'interior').maxPixelRatio, 1.5);

assert.equal(highSsaoPlan.bloom.strength, high.environment.bloomStrength, 'bloom keeps preset strength');
assert.equal(highSsaoPlan.bloom.radius, high.environment.bloomRadius, 'bloom keeps preset radius');
assert.equal(highSsaoPlan.bloom.threshold, high.environment.bloomThreshold, 'bloom keeps preset threshold');

// --- vendored nodes link + construct against three r185 ---
// A missing named export in `three/tsl` or `three/webgpu` fails at import time.

const { DirectionalLight, PerspectiveCamera } = await import('three/webgpu');
const { vec3, vec4, texture } = await import('three/tsl');
const { ssao, default: SSAONode } = await import('../src/three-addons/tsl/display/SSAONode.js');
const { dualKawaseBloom, default: DualKawaseBloomNode } = await import('../src/three-addons/tsl/display/DualKawaseBloomNode.js');
await import('../src/three-addons/tsl/display/depthAwareBlur.js');

const camera = new PerspectiveCamera();
const aoNode = ssao(vec4(1), vec3(0, 0, 1), camera);
assert.ok(aoNode instanceof SSAONode);
aoNode.samples.value = 8;
aoNode.radius.value = 1.5;
aoNode.intensity.value = 4;
aoNode.blurEnabled = false;
aoNode.setSize(200, 100);
assert.equal(aoNode.resolution.x, 100, 'SSAO render target honors 0.5 resolution scale');
assert.equal(aoNode.resolution.y, 50);
assert.ok(aoNode.getTextureNode(), 'SSAO exposes its result texture node');
aoNode.dispose();

const bloomNode = dualKawaseBloom(texture(null), 0.035, 0.14, 2.4);
assert.ok(bloomNode instanceof DualKawaseBloomNode);
assert.equal(bloomNode.strength.value, 0.035);
assert.equal(bloomNode.radius.value, 0.14);
assert.equal(bloomNode.threshold.value, 2.4);
bloomNode.setResolutionScale(0.25);
assert.equal(bloomNode.getResolutionScale(), 0.25);
bloomNode.setSize(400, 300);
assert.equal(bloomNode._renderTargetBright.width, 100, 'bloom bright pass honors 0.25 resolution scale');
assert.equal(bloomNode._renderTargetBright.height, 75);
bloomNode.dispose();

const { CachedClipmapShadowNode } = await import('../src/game/render/CachedClipmapShadowNode.js');
const clipmap = new CachedClipmapShadowNode(new DirectionalLight(), { updateBudget: 0.5 });
assert.equal(clipmap.updateBudget, 0.5, 'fractional clipmap budgets are not clamped to one update per frame');
clipmap.dispose();

console.log('verify-post-effects: all assertions passed');
