import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const out = path.resolve('.codex-tmp', 'visual-smoke');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
await page.waitForTimeout(600);
await page.keyboard.press('KeyQ');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed', { timeout: 4000 });
await page.waitForTimeout(500);
const box = await page.locator('canvas.game-canvas').boundingBox();
const cx = box.x + box.width/2, cy = box.y + box.height/2;

// armed + moving (jog legs + armed torso)
await page.keyboard.down('KeyW');
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, 'layer-armed-jog.png') });
await page.keyboard.up('KeyW');
await page.waitForTimeout(400);

// standing attack (full-body swing: legs follow attack)
await page.mouse.click(cx, cy, { button: 'left' });
await page.waitForTimeout(350);
await page.screenshot({ path: path.join(out, 'layer-standing-swing.png') });
await page.waitForTimeout(1500);

// moving attack (jog legs + swing torso)
await page.keyboard.down('KeyW');
await page.waitForTimeout(200);
await page.mouse.click(cx, cy, { button: 'left' });
await page.waitForTimeout(350);
await page.screenshot({ path: path.join(out, 'layer-moving-swing.png') });
await page.keyboard.up('KeyW');

console.log('captured layer-armed-jog.png, layer-standing-swing.png, layer-moving-swing.png');
await browser.close();
