import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => localStorage.setItem('dreamfall:quality', 'ultra'));
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.waitForTimeout(2000);
const read = () => page.evaluate(() => {
  const s = globalThis.__DREAMFALL_DEBUG__.snapshot();
  return { char: s.character.position, shadow: s.scene?.shadowTarget, frustum: s.scene?.shadowFrustum, map: s.scene?.shadowMapSize, shadows: s.renderer?.shadows };
});
console.log('at spawn:', JSON.stringify(await read()));
await page.keyboard.down('KeyW');
await page.waitForTimeout(4000);
await page.keyboard.up('KeyW');
await page.waitForTimeout(400);
const after = await read();
console.log('after walk:', JSON.stringify(after));
const dx = after.shadow[0] - after.char.x;
const dz = after.shadow[2] - after.char.z;
// The snapshot position is physics/interpolation based while shadow follow uses
// the render group, so allow their normal sub-metre offset after movement.
const maxFollowError = Math.max((after.frustum / after.map) * 2, 1);
console.log(`shadow target vs player delta: dx=${dx.toFixed(2)} dz=${dz.toFixed(2)}`);
if (!after.shadows) throw new Error('Ultra preset did not enable renderer shadows');
if (Math.abs(dx) > maxFollowError || Math.abs(dz) > maxFollowError) {
  throw new Error(`shadow target is not tracking the player (max error ${maxFollowError.toFixed(3)})`);
}
await browser.close();
