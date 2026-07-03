import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.addInitScript(() => {
    localStorage.setItem('dreamfall:quality', 'high');
    localStorage.setItem('dreamfall:post-effect', 'ssao');
    localStorage.setItem('dreamfall:level', 'world');
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
  });
  await page.goto(process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForTimeout(12000);
  const renderListErrors = errors.filter((error) => error.includes('renderList') || error.includes('_renderObjects'));
  assert.deepEqual(renderListErrors, [], renderListErrors[0]);
  console.log('SSAO render-list verification passed.');
} finally {
  await browser.close();
}
