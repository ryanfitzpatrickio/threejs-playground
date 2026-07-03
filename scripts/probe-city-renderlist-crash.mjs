// Repro probe for the "Cannot destructure property 'object' of 'renderList[i]'"
// crash on the city stage (ultra + SSAO). Captures FULL stack traces
// (Error.stackTraceLimit raised before app code loads) and drives the player
// to force chunk attach / reveal / traversal backfill.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const driveSeconds = Number(process.env.DRIVE_SECONDS ?? 30);
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (error) => {
  errors.push(error.stack || String(error));
  console.error('--- pageerror ---\n' + (error.stack || error));
});

await page.addInitScript(() => {
  Error.stackTraceLimit = 200;
  localStorage.setItem('dreamfall:quality', 'ultra');
  localStorage.setItem('dreamfall:post-effect', 'ssao');
  localStorage.setItem('dreamfall:level', 'city');
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
  // Capture full stacks from window.onerror too (pageerror can truncate).
  window.addEventListener('error', (e) => {
    if (e.error?.stack) console.log('FULLSTACK::' + e.error.stack);
  });
});
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('FULLSTACK::')) console.error('--- full stack ---\n' + t.slice(11));
});

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
    { timeout: 120000 },
  );
  console.log('stage=running; driving for', driveSeconds, 's...');

  await page.keyboard.down('w');
  const start = Date.now();
  let turn = false;
  while (Date.now() - start < driveSeconds * 1000) {
    // Weave so we cross chunk boundaries in both axes.
    turn = !turn;
    await page.keyboard.down(turn ? 'a' : 'd');
    await page.waitForTimeout(1500);
    await page.keyboard.up(turn ? 'a' : 'd');
    if (errors.length > 0) break;
  }
  await page.keyboard.up('w');

  const snap = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.level?.city ?? null).catch(() => null);
  console.log('city snapshot:', JSON.stringify(snap));
  console.log(errors.length > 0 ? `REPRODUCED: ${errors.length} error(s)` : 'no errors captured');
} finally {
  await browser.close();
}
process.exit(errors.length > 0 ? 2 : 0);
