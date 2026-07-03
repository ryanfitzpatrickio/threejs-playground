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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.keyboard.press('Escape');

const worldBtn = page.locator('.mode-btn', { hasText: 'World' });
await worldBtn.click();
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.waitForTimeout(2000);

const ultraBtn = page.locator('button', { hasText: 'Ultra' });
if (await ultraBtn.count()) { await ultraBtn.first().click(); await page.waitForTimeout(1000); }

await page.keyboard.press('Escape');
await page.waitForTimeout(3000); // let the world finish streaming in
await page.screenshot({ path: path.join(out, 'clipmap-shadow-after-fix.png') });
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
console.log('screenshot saved to', path.join(out, 'clipmap-shadow-after-fix.png'));
await browser.close();
