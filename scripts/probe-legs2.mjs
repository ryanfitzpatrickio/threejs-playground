import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
const page = await browser.newPage({});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
await page.waitForTimeout(400);
const snap = () => page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
await page.keyboard.press('KeyQ');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed', { timeout: 4000 });
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.character?.animation?.currentState === 'idle', { timeout: 3000 }).catch(()=>{});
await page.waitForTimeout(200);
const box = await page.locator('canvas.game-canvas').boundingBox();
await page.mouse.click(box.x+box.width/2, box.y+box.height/2, { button:'left' });
for (const ms of [100, 300, 600]) {
  await page.waitForTimeout(ms);
  const s = await snap();
  console.log(`after+${ms}ms: override=${s.combat.animationOverride} upper=${s.character.animation.upperBodyState} attackLegState=${s.character.animation.attackLegState} weight=${s.character.animation.attackLegWeight} target=${s.character.animation.attackLegTarget} base=${s.character.animation.currentState}`);
}
await browser.close();
