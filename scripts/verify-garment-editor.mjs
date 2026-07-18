import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const simName = `Garment Editor Sim ${Date.now()}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

let garmentId = null;
let simId = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error?.message ?? error)));
  await page.goto(dreamfallAppUrl({ view: 'sim-creator', autostart: null }), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => globalThis.__SIMHUMAN_DEBUG__?.status === 'ready', { timeout: 120_000 });
  await page.locator('input[aria-label="Sim name"]').fill(simName);
  await page.getByRole('button', { name: 'Garments' }).click();
  await page.getByRole('tab', { name: 'Dynamic Cloth', exact: true }).click();
  await page.waitForSelector('canvas[data-sim-pattern-canvas="true"]', { timeout: 30_000 });
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.getGarmentSnapshot?.()?.steps > 10,
    { timeout: 60_000 },
  );

  const canvases = await page.evaluate(() => {
    const preview = document.querySelector('canvas[aria-label="Character Maker preview"]');
    const pattern = document.querySelector('canvas[data-sim-pattern-canvas="true"]');
    return {
      preview: Boolean(preview),
      pattern: Boolean(pattern),
      previewWidth: preview?.clientWidth ?? 0,
      patternWidth: pattern?.clientWidth ?? 0,
      webgpu: Boolean(preview?.getContext('webgpu')),
      webgl: Boolean(pattern?.getContext('webgl2') || pattern?.getContext('webgl')),
      garment: globalThis.__SIMHUMAN_DEBUG__.getGarmentSnapshot(),
    };
  });
  assert.equal(canvases.preview, true);
  assert.equal(canvases.pattern, true);
  assert.ok(canvases.previewWidth > 300 && canvases.patternWidth > 300, 'both canvases should have usable side-by-side width');
  assert.equal(canvases.webgpu, true, '3D creator preview should retain WebGPU');
  assert.equal(canvases.webgl, true, 'Pixi pattern editor should explicitly use WebGL');
  assert.equal(canvases.garment.panels, 2, 'demo should compile into two 3D panels');
  assert.ok(canvases.garment.renderVertices > 0);

  await page.getByRole('button', { name: 'Save garment' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="garment-status"]')?.textContent?.includes('saved and assigned'));
  garmentId = await page.evaluate(() => {
    const select = document.querySelector('[aria-label="Saved garments"]');
    return [...(select?.options ?? [])].find((option) => option.value)?.value ?? null;
  });
  assert.ok(garmentId, 'saved garment should appear in the collection selector');
  const response = await page.request.get(new URL(`/api/store/garments/${garmentId}`, dreamfallAppUrl()).toString());
  assert.equal(response.ok(), true, `saved garment REST lookup failed: ${response.status()}`);
  const saved = await response.json();
  assert.equal(Object.keys(saved.patterns).length, 2);
  assert.ok(Object.keys(saved.seams).length >= 8);

  await page.getByRole('button', { name: 'Save preset' }).click();
  const preset = await page.evaluate(async (expectedName) => {
    const snapshot = await fetch('/api/store/snapshot').then((value) => value.json());
    return Object.values(snapshot.sims ?? {}).find((entry) => entry.name === expectedName) ?? null;
  }, simName);
  assert.ok(preset?.id, 'creator should persist the Sim after garment assignment');
  assert.deepEqual(preset.garmentIds, [garmentId]);
  simId = preset.id;

  await page.getByRole('button', { name: 'Play Lot' }).click();
  await page.waitForFunction(
    ({ expectedSim, expectedGarment }) => {
      const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
      const sim = snapshot?.sims?.sims?.find((entry) => entry.id === expectedSim);
      return snapshot?.stage === 'running' && sim?.garments?.[0]?.id === expectedGarment;
    },
    { expectedSim: simId, expectedGarment: garmentId },
    { timeout: 150_000 },
  );

  const fatal = errors.filter((error) => /failed to initialize|failed to start|is not defined|Cannot read/i.test(error));
  assert.deepEqual(fatal, [], `fatal page errors: ${fatal.join(' | ')}`);
  console.log('verify-garment-editor: Pixi/WebGPU authoring, persistence, and Play Lot outfit handoff OK');
} finally {
  if (simId) {
    await fetch(new URL(`/api/store/sims/${simId}`, dreamfallAppUrl()), { method: 'DELETE' }).catch(() => {});
  }
  if (garmentId) {
    await fetch(new URL(`/api/store/garments/${garmentId}`, dreamfallAppUrl()), { method: 'DELETE' }).catch(() => {});
  }
  await browser.close();
}
