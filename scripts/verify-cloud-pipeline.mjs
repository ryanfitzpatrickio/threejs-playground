import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  getQualityPreset,
} from '../src/game/config/qualityPresets.js';
import {
  normalizeCloudMode,
  resolveCloudConfig,
  resolveCloudTypePreset,
  listCloudTypePresets,
  CLOUD_TYPE_PRESETS,
  DEFAULT_CLOUD_TYPE,
} from '../src/game/render/cloud/cloudConfig.js';

const low = getQualityPreset('low');
const high = getQualityPreset('high');
const ultra = getQualityPreset('ultra');
assert.equal(normalizeCloudMode('bad'), 'dome');
// Every tier now defaults to the simple SkyMesh dome clouds; the volumetric
// pipeline is opt-in via the debug-panel checkbox (localStorage dreamfall:clouds
// = 'volumetric'). resolveCloudConfig therefore returns null unless forced, but
// the volumetricClouds config still drives the pipeline when it is enabled.
assert.equal(low.environment.clouds, 'dome');
assert.equal(high.environment.clouds, 'dome');
assert.equal(ultra.environment.clouds, 'dome');
assert.equal(resolveCloudConfig(high), null);
assert.equal(resolveCloudConfig(high, { force: true }).march.maxSteps, 96);
assert.equal(resolveCloudConfig(ultra, { force: true }).volumetric.godRays, true);
assert.equal(resolveCloudConfig(ultra, { force: true }).volumetric.shadowResolution, 1024);

// --- Cloud-type presets (distinct morphologies) -----------------------------
const presetList = listCloudTypePresets();
assert.ok(presetList.length >= 7, 'expected the full spread of cloud types');
assert.equal(presetList[0].id, DEFAULT_CLOUD_TYPE);
for (const { id, label } of presetList) {
  assert.ok(typeof label === 'string' && label.length > 0, `${id} needs a label`);
  const resolved = resolveCloudTypePreset(id);
  // Every preset resolves to a COMPLETE param set (partial overrides merged
  // over the defaults), so the provider can write every uniform unconditionally.
  for (const key of ['altitude', 'thickness', 'coverage', 'density', 'weatherScale', 'baseScale', 'baseStrength']) {
    assert.ok(Number.isFinite(resolved.shape[key]), `${id}.shape.${key} must be finite`);
  }
  for (const key of ['scatteringAlbedo', 'powderStrength', 'ambientIntensity']) {
    assert.ok(Number.isFinite(resolved.lighting[key]), `${id}.lighting.${key} must be finite`);
  }
  for (const key of ['heading', 'speed', 'evolutionSpeed', 'skew']) {
    assert.ok(Number.isFinite(resolved.wind[key]), `${id}.wind.${key} must be finite`);
  }
}
// The 'default' preset is an empty override → identical to DEFAULT_CLOUD_PARAMS.
assert.equal(resolveCloudTypePreset('default').shape.altitude, 1200);
// Distinct types actually differ in shape (not just coverage).
assert.notEqual(resolveCloudTypePreset('cirrus').shape.altitude, resolveCloudTypePreset('storm').shape.altitude);
assert.ok(resolveCloudTypePreset('cirrus').shape.altitude > resolveCloudTypePreset('stratus').shape.altitude);
assert.ok(resolveCloudTypePreset('storm').shape.thickness > resolveCloudTypePreset('stratus').shape.thickness);
// Unknown names fall back to the default type rather than throwing.
assert.deepEqual(resolveCloudTypePreset('nope'), resolveCloudTypePreset(DEFAULT_CLOUD_TYPE));
assert.ok(CLOUD_TYPE_PRESETS.cumulonimbus === undefined && CLOUD_TYPE_PRESETS.storm, 'storm is the cumulonimbus id');

if (process.env.DREAMFALL_CLOUD_BROWSER === '0') {
  console.log('verify-cloud-pipeline: static assertions passed');
  process.exit(0);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const errors = [];
const browserQuality = process.env.DREAMFALL_CLOUD_QUALITY === 'ultra' ? 'ultra' : 'high';
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error' || (message.type() === 'warning' && message.text().includes('THREE.TSL'))) {
    errors.push(message.text());
  }
});

try {
  await page.addInitScript(() => {
    localStorage.setItem('dreamfall:quality', globalThis.__CLOUD_TEST_QUALITY__ ?? 'high');
    localStorage.setItem('dreamfall:post-effect', 'off');
    localStorage.setItem('dreamfall:level', 'world');
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
    // Opt into the volumetric pipeline — it is no longer the default, but this
    // smoke test exists to exercise it (temporal, shadows, god-rays, rain).
    localStorage.setItem('dreamfall:clouds', 'volumetric');
  });
  await page.addInitScript((quality) => {
    globalThis.__CLOUD_TEST_QUALITY__ = quality;
    localStorage.setItem('dreamfall:quality', quality);
  }, browserQuality);
  await page.goto(process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => {
    try {
      return globalThis.__DREAMFALL_DEBUG__?.snapshot?.().scene?.sky?.model;
    } catch {
      return false;
    }
  }, null, {
    timeout: 30000,
  });
  await page.waitForTimeout(8000);
  const snapshot = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  assert.equal(snapshot.scene.sky.model, 'volumetric');
  assert.equal(snapshot.scene.sky.clouds, 'volumetric');
  assert.equal(snapshot.scene.sky.temporal, true);
  assert.equal(snapshot.scene.sky.shadowResolution, browserQuality === 'ultra' ? 1024 : 512);
  assert.equal(snapshot.scene.sky.godRays, browserQuality === 'ultra');
  assert.ok(snapshot.renderer.drawCalls > 0, 'renderer produced frames');

  // Rain rebuilds the pipeline with height fog underneath the cloud composite.
  // This catches expression-vs-texture mistakes in that less common branch.
  await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.setWeather('rain'));
  await page.waitForTimeout(3000);
  const rainSnapshot = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  assert.equal(rainSnapshot.renderer.weather, 'rain');
  assert.ok(rainSnapshot.scene.sky.cloudCoverage >= 0.85);

  const shaderErrors = errors.filter((error) => /WGSL|shader|validation|uncaught|renderList|THREE\.TSL/i.test(error));
  assert.deepEqual(shaderErrors, [], shaderErrors.join('\n'));
  if (process.env.DREAMFALL_CLOUD_SCREENSHOT) {
    await page.screenshot({ path: process.env.DREAMFALL_CLOUD_SCREENSHOT });
  }
  console.log(`verify-cloud-pipeline: static + WebGPU ${browserQuality} smoke passed`);
} finally {
  await browser.close();
}
