// Confirms road ribbon chunk meshes are actually eligible for automatic
// per-object frustum culling: frustumCulled=true (Three.js default) and each
// chunk has its own (non-null, reasonably small) bounding sphere — not one
// shared giant sphere covering the whole network.
//
// Run: node scripts/probe-frustum-cull-check.mjs
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

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.keyboard.press('Escape');
const worldBtn = page.locator('.mode-btn', { hasText: 'World' });
await worldBtn.click();
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const scene = globalThis.__DREAMFALL_DEBUG__.getScene();
  const rows = [];
  scene.traverse((obj) => {
    if (obj.isMesh && obj.name.startsWith('Road Ribbon')) {
      if (!obj.geometry.boundingSphere) obj.geometry.computeBoundingSphere();
      rows.push({
        name: obj.name,
        frustumCulled: obj.frustumCulled,
        radius: obj.geometry.boundingSphere ? Math.round(obj.geometry.boundingSphere.radius) : null,
      });
    }
  });
  return rows;
});
console.log('road ribbon chunk count:', info.length);
console.log(JSON.stringify(info.slice(0, 8), null, 2));
const allCulled = info.every((r) => r.frustumCulled === true);
const radii = info.map((r) => r.radius).filter((r) => r != null);
console.log('all frustumCulled=true:', allCulled);
console.log('bounding sphere radius min/max:', Math.min(...radii), Math.max(...radii), '(expect small, well under chunk-diagonal ~181m, not spanning the whole network)');
await browser.close();
