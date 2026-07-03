// Draws a river in the Map editor, checks "Ocean fill: Left", and confirms
// (a) the autosave data has oceanLeft:true, and (b) the Runtime Preview panel
// visibly floods that side with water, including out past the river's ends.
//
// Run: node scripts/probe-river-ocean-fill.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
const mapBtn = page.locator('button', { hasText: 'Map' }).first();
await mapBtn.click({ timeout: 10000 }).catch(async () => { await page.keyboard.press('Escape'); await mapBtn.click(); });
const canvas = page.locator('canvas').first();
await canvas.waitFor({ state: 'visible', timeout: 10000 });
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

await page.locator('button', { hasText: 'River' }).first().click();
await page.mouse.click(cx - 150, cy);
await page.mouse.click(cx, cy + 40); // slight bend
await page.mouse.dblclick(cx + 150, cy);
await page.waitForTimeout(200);

// Check "Left is infinite ocean".
await page.locator('label', { hasText: 'Left is infinite ocean' }).locator('input[type=checkbox]').check();
await page.waitForTimeout(200);

const rivers = await page.evaluate(() => JSON.parse(localStorage.getItem('dreamfall:worldmap:autosave')).rivers);
console.log('river after checking oceanLeft:', JSON.stringify(rivers?.[0]));
console.log('oceanLeft is true:', rivers?.[0]?.oceanLeft === true);

await page.mouse.move(cx, cy);
await page.waitForTimeout(1800); // preview rebuild debounce + stream
await page.screenshot({ path: '.codex-tmp/visual-smoke/river-ocean-fill.png' });
console.log('screenshot saved to .codex-tmp/visual-smoke/river-ocean-fill.png');
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
