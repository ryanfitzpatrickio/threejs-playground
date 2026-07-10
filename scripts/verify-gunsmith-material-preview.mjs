#!/usr/bin/env node
/**
 * Browser smoke: Gunsmith loads a catalog gun and switches one mesh to the
 * supplied texture-set + TSL-metal finish without losing the PBR map requests.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pbrFailures = [];
  page.on('requestfailed', (request) => {
    if (request.url().includes('/assets/textures/guns/')) pbrFailures.push(request.url());
  });

  await page.goto(dreamfallAppUrl(), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Continue/ }).click();
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Guns', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.gunsmith-shell')?.textContent?.includes('Loaded Modern AR-15'));

  await page.getByRole('button', { name: 'mesh_0', exact: true }).click();
  const selects = page.locator('.gunsmith-shell select');
  await page.waitForFunction(() => document.querySelectorAll('.gunsmith-shell select').length >= 4);
  await selects.nth(3).selectOption('texture_metal_tsl');
  await page.waitForFunction(() => document.querySelectorAll('.gunsmith-shell select').length >= 5);
  await page.waitForTimeout(500);

  assert.equal(await selects.nth(3).inputValue(), 'texture_metal_tsl');
  assert.equal(await selects.nth(4).inputValue(), 'field-panel');
  assert.deepEqual(pbrFailures, [], `PBR texture requests failed: ${pbrFailures.join(', ')}`);

  const screenshot = PNG.sync.read(await page.screenshot());
  assert.ok(screenshot.width > 100 && screenshot.height > 100, 'Gunsmith screenshot missing');
  console.log('verify-gunsmith-material-preview: texture-set + TSL metal preview passed');
} finally {
  await browser.close();
}
