// Verifies the new WeatherSystem end-to-end: 'clear' renders with no errors
// (baseline unaffected), the debug panel's weather selector switches to
// 'rain', the rain effect actually shows up in the scene, and frame stats stay
// healthy (no new hitches from the added draw call).
//
// Run: node scripts/probe-weather-rain.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const out = path.resolve('.codex-tmp', 'visual-smoke');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => { try { return globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'; } catch { return false; } }, { timeout: 30000 });
await page.keyboard.press('Escape');

const worldBtn = page.locator('.mode-btn', { hasText: 'World' });
await worldBtn.click();
await page.waitForFunction(() => { try { return globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running'; } catch { return false; } }, { timeout: 30000 });
await page.waitForTimeout(2000);

console.log('errors after loading World (clear weather, baseline):', errors.length ? errors.slice(0, 5) : 'none');
await page.screenshot({ path: path.join(out, 'weather-clear.png') });

// Open debug panel and switch to Rain.
await page.keyboard.press('KeyP');
await page.waitForTimeout(300);
const select = page.locator('select.dbg-select');
await select.waitFor({ state: 'visible', timeout: 5000 });
await select.selectOption('rain');
await page.waitForTimeout(1500); // let the intensity ramp in

const afterRain = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
console.log('weather after selecting rain:', afterRain.renderer?.weather);

const rainMeshInfo = await page.evaluate(() => {
  const scene = globalThis.__DREAMFALL_DEBUG__.getScene();
  let found = null;
  scene.traverse((obj) => {
    if (obj.name === 'RainEffect') {
      const mesh = obj.children[0];
      found = { count: mesh?.count, instanceMax: mesh?.instanceMatrix?.count ?? null, visible: mesh?.visible };
    }
  });
  return found;
});
console.log('rain mesh info:', JSON.stringify(rainMeshInfo));

await page.keyboard.press('KeyP'); // close debug panel before the shot
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, 'weather-rain.png') });

const frame = (await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot())).frame;
console.log('frame stats with rain active:', JSON.stringify({ avg: frame.recentAvgMs, p95: frame.recentP95Ms, max: frame.recentMaxMs, hitches: frame.hitches }));

console.log('\npage errors total:', errors.length ? errors.slice(0, 10) : 'none');
await browser.close();
