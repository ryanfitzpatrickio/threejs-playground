// Verifies river control-point handle dragging (mirrors probe-road-point-drag.mjs)
// AND that the Runtime Preview panel rebuilds when a river is added/edited (it
// previously never did — WorldMapPreview3D.setMap()'s rebuild hash omitted
// map.rivers entirely).
//
// Run: node scripts/probe-river-point-drag.mjs
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
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

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
await page.mouse.click(cx, cy);
await page.mouse.dblclick(cx + 150, cy);
await page.waitForTimeout(200);

const readRivers = () => page.evaluate(() => {
  const raw = localStorage.getItem('dreamfall:worldmap:autosave');
  return raw ? JSON.parse(raw).rivers : null;
});

let rivers = await readRivers();
console.log('river created, points:', JSON.stringify(rivers?.[0]?.points));
if (!rivers || rivers.length === 0) {
  console.log('FAIL: no river was created');
  await browser.close();
  process.exit(1);
}
const before = rivers[0].points.map((p) => ({ ...p }));

// Drag the END point.
await page.mouse.move(cx - 150, cy);
await page.mouse.down();
await page.mouse.move(cx - 150, cy - 100, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
rivers = await readRivers();
const afterEndDrag = rivers[0].points.map((p) => ({ ...p }));
console.log('after dragging END point:', JSON.stringify(afterEndDrag));
const endMoved = Math.abs(afterEndDrag[0].z - before[0].z) > 10;
const middleUnchanged = Math.abs(afterEndDrag[1].x - before[1].x) < 1 && Math.abs(afterEndDrag[1].z - before[1].z) < 1;
console.log('end point moved:', endMoved, '| middle point unchanged:', middleUnchanged);

// Drag the MIDDLE point.
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 20, cy + 120, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
rivers = await readRivers();
const afterMiddleDrag = rivers[0].points.map((p) => ({ ...p }));
console.log('after dragging MIDDLE point:', JSON.stringify(afterMiddleDrag));
const middleMoved = Math.abs(afterMiddleDrag[1].z - afterEndDrag[1].z) > 10;
const endUnchangedAfterMiddleDrag = Math.abs(afterMiddleDrag[0].x - afterEndDrag[0].x) < 1 && Math.abs(afterMiddleDrag[0].z - afterEndDrag[0].z) < 1;
console.log('middle point moved:', middleMoved, '| end unchanged:', endUnchangedAfterMiddleDrag);

console.log('\nDRAG PASS:', endMoved && middleUnchanged && middleMoved && endUnchangedAfterMiddleDrag);

// Now check the preview panel actually picked up the river (give the 450ms
// debounce + a build/stream cycle time to settle), by screenshotting it.
await page.mouse.move(cx, cy);
await page.waitForTimeout(1500);
await page.screenshot({ path: '.codex-tmp/visual-smoke/river-point-drag.png' });
console.log('screenshot saved to .codex-tmp/visual-smoke/river-point-drag.png');
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
