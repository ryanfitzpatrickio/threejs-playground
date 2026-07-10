// Drives the vehicle around in World mode and captures the temporary
// [ClipmapShadow] instrumentation console logs (src/game/render/CachedClipmapShadowNode.js)
// to confirm which shadow clipmap levels re-render every frame while moving.
//
// Run: node scripts/probe-clipmap-shadow.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const clipmapLines = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.includes('[ClipmapShadow]')) {
    clipmapLines.push(text);
    console.log(text);
  }
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
console.log('game loaded (city mode)');
await page.keyboard.press('Escape'); // dismiss the first-run controls-guide overlay

// Switch to World mode via the mode button (real user path).
const worldBtn = page.locator('.mode-btn', { hasText: 'World' });
await worldBtn.click();
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.waitForTimeout(1500); // let terrain/world stream in around spawn
console.log('switched to World mode');

// Bump quality to Ultra if a preset selector exists (matches the trace's settings).
const ultraBtn = page.locator('button', { hasText: 'Ultra' });
if (await ultraBtn.count()) {
  await ultraBtn.first().click();
  await page.waitForTimeout(500);
  console.log('set quality: Ultra');
}

// Spawn a vehicle just ahead of the character, then mount it (KeyF).
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.vehicleSystem?.status === 'ready'
  || globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.player?.vehicleSystemStatus === 'ready', { timeout: 15000 }).catch(() => {});
let spawnResult = 'unknown';
for (let attempt = 0; attempt < 5; attempt += 1) {
  spawnResult = await page.evaluate(async () => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const res = await dbg.spawnVehicle({ ahead: 4 });
    return res?.error ?? 'ok';
  });
  if (spawnResult === 'ok') break;
  await page.waitForTimeout(1000);
}
console.log('spawnVehicle:', spawnResult);
await page.waitForTimeout(300);
await page.keyboard.press('KeyF');
await page.waitForTimeout(800);

// Drive forward with steering wiggle for ~20s so the camera covers real ground
// distance (the scenario that reproduced the draw-call bloat in the trace).
await page.keyboard.down('KeyW');
const driveMs = 20000;
const start = Date.now();
let steerLeft = true;
while (Date.now() - start < driveMs) {
  await page.keyboard.down(steerLeft ? 'KeyA' : 'KeyD');
  await page.waitForTimeout(1200);
  await page.keyboard.up(steerLeft ? 'KeyA' : 'KeyD');
  steerLeft = !steerLeft;
}
await page.keyboard.up('KeyW');

console.log(`\ncaptured ${clipmapLines.length} [ClipmapShadow] log line(s) over ~${driveMs / 1000}s of driving`);
await browser.close();
