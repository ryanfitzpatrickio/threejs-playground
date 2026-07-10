// Captures a screenshot of the character with the sword drawn (armed idle), to
// visually verify the neonblade socket. Presses Q, waits for armedIdle, snaps.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const appUrl = dreamfallAppUrl();
const outDir = path.resolve('.codex-tmp', 'visual-smoke');
await mkdir(outDir, { recursive: true });
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, executablePath: existsSync(chromePath) ? chromePath : undefined });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
  await page.waitForTimeout(800);

  // Sheathed shot.
  await page.screenshot({ path: path.join(outDir, 'sword-sheathed.png') });

  // Draw the sword.
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed',
    { timeout: 4000 },
  );
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.state === 'armedIdle',
    { timeout: 4000 },
  ).catch(() => {});
  await page.waitForTimeout(600);

  const s = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  console.log(`sword source: ${s.character?.swordSource ?? 'n/a'}, anim: ${s.animation?.state}, weapon: ${s.combat?.weapon}`);
  await page.screenshot({ path: path.join(outDir, 'sword-armed.png') });

  // A swing mid-attack.
  const box = await page.locator('canvas.game-canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'left' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'sword-swing.png') });

  console.log(`screenshots: ${path.join(outDir, 'sword-sheathed.png')}, sword-armed.png, sword-swing.png`);
} finally {
  await browser.close();
}
