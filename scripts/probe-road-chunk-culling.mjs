// Confirms road/river ribbon chunking in a real World scene: mesh names bucket
// cleanly under "Road Ribbon" via sceneStats(), and total scene mesh count is
// a small, sane number (not one merged giant mesh, not thousands of tiny ones).
//
// Run: node scripts/probe-road-chunk-culling.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.keyboard.press('Escape');

const worldBtn = page.locator('.mode-btn', { hasText: 'World' });
await worldBtn.click();
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.waitForTimeout(2500); // let terrain/roads stream in

const stats = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.sceneStats());
console.log('total meshes:', stats.totalMeshes, ' total triangles:', stats.totalTriangles);
const relevant = Object.entries(stats.tally).filter(([k]) => /Road Ribbon|River Water|Riverworks|Roadworks/.test(k));
console.log('road/river buckets:', JSON.stringify(relevant, null, 2));
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
