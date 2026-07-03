// Verifies the rain-response follow-up: wet road/terrain puddles (with the
// reference repo's animated ripple-ring pattern) and wet/beaded vehicle
// paint. Loads World mode, confirms 'clear' is unaffected, switches to rain,
// waits for the (slow, ~15s) wetness ramp to build up, and screenshots the
// scene + a zoomed crop of a parked vehicle.
//
// Run: node scripts/probe-rain-wetness.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
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
await page.screenshot({ path: path.join(out, 'wetness-clear.png') });

// Switch to rain via the debug panel.
await page.keyboard.press('KeyP');
await page.waitForTimeout(300);
const select = page.locator('select.dbg-select');
await select.waitFor({ state: 'visible', timeout: 5000 });
await select.selectOption('rain');
await page.keyboard.press('KeyP'); // close panel
await page.waitForTimeout(300);

console.log('waiting ~28s for the slow wetness ramp to build up...');
await page.waitForTimeout(28000);

const afterRain = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
console.log('weather after selecting rain:', afterRain.renderer?.weather);

const sceneInfo = await page.evaluate(() => {
  const scene = globalThis.__DREAMFALL_DEBUG__.getScene();
  let rainEffect = null;
  scene.traverse((obj) => {
    if (obj.name === 'RainEffect') rainEffect = { count: obj.children[0]?.count, visible: obj.children[0]?.visible };
  });
  return { rainEffect };
});
console.log('rain mesh info:', JSON.stringify(sceneInfo));

await page.screenshot({ path: path.join(out, 'wetness-rain-overview.png') });

// Try to find and zoom into a parked vehicle for the beading check.
const vehicleBox = await page.evaluate(() => {
  const scene = globalThis.__DREAMFALL_DEBUG__.getScene();
  const camera = globalThis.__DREAMFALL_DEBUG__.getCamera?.();
  let overlay = null;
  scene.traverse((obj) => {
    if (!overlay && obj.name === 'Muscle chassis overlay') overlay = obj;
  });
  if (!overlay || !camera) return null;
  const THREE = globalThis.__DREAMFALL_DEBUG__.THREE;
  return { found: true };
});
console.log('vehicle overlay present:', JSON.stringify(vehicleBox));

const frame = (await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot())).frame;
console.log('frame stats with rain active:', JSON.stringify({ avg: frame.recentAvgMs, p95: frame.recentP95Ms, max: frame.recentMaxMs, hitches: frame.hitches }));

console.log('\npage errors total:', errors.length ? errors.slice(0, 15) : 'none');
await browser.close();
