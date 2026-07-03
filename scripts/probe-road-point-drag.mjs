// Verifies the new road control-point handle dragging in the 2D World Map
// editor: draw a 2-point road, select it, drag its END point to a new spot,
// then drag a MIDDLE point (after adding a 3rd point) — confirm road.points
// actually changed (read back from the autosave localStorage key) and that
// dragging a handle did NOT move the whole road (other points unchanged).
//
// Run: node scripts/probe-road-point-drag.mjs
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

// Reach the 2D World Map editor (dev tools "Map" mode button).
const mapBtn = page.locator('button', { hasText: 'Map' }).first();
await mapBtn.click({ timeout: 10000 }).catch(async () => {
  // Fallback: dev tools may need a toggle first.
  await page.keyboard.press('Escape');
  await mapBtn.click();
});
const canvas = page.locator('canvas').first();
await canvas.waitFor({ state: 'visible', timeout: 10000 });
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// Select the Road tool, draw a 3-point road: (-100,0) -> (0,0) -> (100,0) in
// screen px terms, roughly centered, then finish with double-click.
await page.locator('button', { hasText: 'Road' }).first().click();
await page.mouse.click(cx - 150, cy);
await page.mouse.click(cx, cy);
await page.mouse.dblclick(cx + 150, cy);
await page.waitForTimeout(200);

const readRoads = () => page.evaluate(() => {
  const raw = localStorage.getItem('dreamfall:worldmap:autosave');
  return raw ? JSON.parse(raw).roads : null;
});

let roads = await readRoads();
console.log('road created, points:', JSON.stringify(roads?.[0]?.points));
if (!roads || roads.length === 0) {
  console.log('FAIL: no road was created');
  await browser.close();
  process.exit(1);
}
const before = roads[0].points.map((p) => ({ ...p }));

// The road should already be selected (auto-selected on finish). Drag its
// FIRST (end) point handle to a new spot.
await page.mouse.move(cx - 150, cy);
await page.mouse.down();
await page.mouse.move(cx - 150, cy - 100, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);

roads = await readRoads();
const afterEndDrag = roads[0].points.map((p) => ({ ...p }));
console.log('after dragging END point:', JSON.stringify(afterEndDrag));

const endMoved = Math.abs(afterEndDrag[0].z - before[0].z) > 10;
const middleUnchanged = Math.abs(afterEndDrag[1].x - before[1].x) < 1 && Math.abs(afterEndDrag[1].z - before[1].z) < 1;
const lastUnchanged = Math.abs(afterEndDrag[2].x - before[2].x) < 1 && Math.abs(afterEndDrag[2].z - before[2].z) < 1;
console.log('end point moved:', endMoved, '| middle point unchanged:', middleUnchanged, '| last point unchanged:', lastUnchanged);

// Now drag the MIDDLE point.
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 20, cy + 120, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);

roads = await readRoads();
const afterMiddleDrag = roads[0].points.map((p) => ({ ...p }));
console.log('after dragging MIDDLE point:', JSON.stringify(afterMiddleDrag));
const middleMoved = Math.abs(afterMiddleDrag[1].z - afterEndDrag[1].z) > 10;
const endsUnchangedAfterMiddleDrag =
  Math.abs(afterMiddleDrag[0].x - afterEndDrag[0].x) < 1 && Math.abs(afterMiddleDrag[0].z - afterEndDrag[0].z) < 1 &&
  Math.abs(afterMiddleDrag[2].x - afterEndDrag[2].x) < 1 && Math.abs(afterMiddleDrag[2].z - afterEndDrag[2].z) < 1;
console.log('middle point moved:', middleMoved, '| both ends unchanged:', endsUnchangedAfterMiddleDrag);

console.log('\nPASS:', endMoved && middleUnchanged && lastUnchanged && middleMoved && endsUnchangedAfterMiddleDrag);
console.log('page errors:', errors.length ? errors.slice(0, 5) : 'none');

await page.mouse.move(cx, cy); // move mouse off any handle before the shot
await page.screenshot({ path: '.codex-tmp/visual-smoke/road-point-drag.png' });
console.log('screenshot saved to .codex-tmp/visual-smoke/road-point-drag.png');
await browser.close();
