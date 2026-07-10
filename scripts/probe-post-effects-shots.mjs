import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
for (const mode of ['ssao', 'off']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript((m) => {
    localStorage.setItem('dreamfall:post-effect', m);
    localStorage.setItem('dreamfall:quality', 'high');
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
  }, mode);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/post-effect-${mode}.png` });
  await page.close();
}
await browser.close();
console.log('done');
