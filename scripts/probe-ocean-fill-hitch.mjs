// Reproduces the scenario that caused a severe, sustained (~700ms) frame hitch
// in a real perf trace: a long ocean-fill river, with the vehicle driving
// around (triggering terrain chunk streaming) so lots of terrain vertices hit
// riverProfile.js's far-field ocean fallback. Confirms the coarse-subsample
// fix (COARSE_STRIDE) keeps frame times healthy while streaming.
//
// Run: node scripts/probe-ocean-fill-hitch.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
const mapBtn = page.locator('button', { hasText: 'Map' }).first();
await mapBtn.click({ timeout: 10000 }).catch(async () => { await page.keyboard.press('Escape'); await mapBtn.click(); });
const canvas = page.locator('canvas').first();
await canvas.waitFor({ state: 'visible', timeout: 10000 });

// Draw a long (~1000m), gently curved river directly via the editor's world-map
// data (much longer than a few UI clicks could conveniently draw) and flag it
// oceanLeft, matching the shape of coastline a user would actually build.
await page.evaluate(() => {
  const points = [];
  for (let x = -500; x <= 500; x += 40) points.push({ x, z: Math.sin(x / 150) * 30 });
  const raw = JSON.parse(localStorage.getItem('dreamfall:worldmap:autosave') || 'null') || {
    version: 1, name: 'Untitled World', chunkSize: 32,
    bounds: { minX: -1024, minZ: -1024, maxX: 1024, maxZ: 1024 },
    spawn: { x: 0, z: 0, yaw: 0 }, zones: [], roads: [], rivers: [], pois: [], entities: [], createdAt: Date.now(),
  };
  raw.rivers = [{ id: 'rv_hitch_test', points, width: 10, depth: 6, type: 'river', oceanLeft: true, oceanRight: false }];
  raw.spawn = { x: 0, z: 200, yaw: 0 }; // spawn well out in the "ocean" so streaming immediately hits it
  localStorage.setItem('dreamfall:worldmap:autosave', JSON.stringify(raw));
});
console.log('injected a 1000m ocean-fill river into the active world map');

// Switch to the actual game and enter World mode.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => { try { return globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'; } catch { return false; } }, { timeout: 30000 });
await page.keyboard.press('Escape');
const worldBtn = page.locator('.mode-btn', { hasText: 'World' });
await worldBtn.click();
await page.waitForFunction(() => { try { return globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'; } catch { return false; } }, { timeout: 30000 });
await page.waitForTimeout(2000);

const reset = () => page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.resetFrameStats());
const snap = () => page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());

await reset();
// Spawn a vehicle and drive through/around the ocean area to force chunk streaming.
await page.evaluate(async () => { await globalThis.__DREAMFALL_DEBUG__.spawnVehicle({ ahead: 4 }); });
await page.waitForTimeout(500);
await page.keyboard.press('KeyF');
await page.waitForTimeout(500);
await reset();

await page.keyboard.down('KeyW');
let steerLeft = true;
for (let i = 0; i < 10; i += 1) {
  await page.keyboard.down(steerLeft ? 'KeyA' : 'KeyD');
  await page.waitForTimeout(1200);
  await page.keyboard.up(steerLeft ? 'KeyA' : 'KeyD');
  steerLeft = !steerLeft;
}
await page.keyboard.up('KeyW');

const f = (await snap()).frame;
console.log('\nframe stats after ~12s of driving through the ocean-fill area:');
console.log(`  avg=${f.recentAvgMs}ms p95=${f.recentP95Ms}ms max=${f.recentMaxMs}ms hitches=${f.hitches} streamingHitches=${f.streamingHitches}`);
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
