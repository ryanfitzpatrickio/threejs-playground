import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
const url = process.argv[2];
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
const page = await browser.newPage({});
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
const snap = () => page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());

// teleport next to an enemy, arm, heavy-attack (instant cut)
let s = await snap();
const enemy = s.enemies.enemies[0];
await page.evaluate((pos) => globalThis.__DREAMFALL_DEBUG__.placeCharacter({ position: pos }), { x: enemy.position.x + 1, y: enemy.position.y, z: enemy.position.z + 1 });
await page.waitForTimeout(300);
await page.keyboard.press('KeyQ');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed', { timeout: 4000 });
await page.waitForTimeout(500);
const box = await page.locator('canvas.game-canvas').boundingBox();
// heavy attacks until the enemy count drops (a cut happened)
for (let i = 0; i < 4; i++) {
  if ((await snap()).enemies.count < s.enemies.count) break;
  await page.mouse.click(box.x+box.width/2, box.y+box.height/2, { button: 'right' });
  await page.waitForTimeout(2200);
}
const after = await snap();
console.log('enemies:', s.enemies.count, '->', after.enemies.count);
console.log('lastCutMs:', JSON.stringify(after.enemyCut.lastCutMs));
await browser.close();
