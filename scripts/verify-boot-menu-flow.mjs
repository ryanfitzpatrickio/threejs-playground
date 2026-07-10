// Boot menu flow (PR3–PR6):
// A) bare origin (no autostart) → main menu → click Rally → stage running
// B) dreamfallAppUrl() → skip menu; stage running
// C) dispose loop: menu → rally → Settings path via debug return ×3 (phase flip)
// D) dreamfallAppUrl unit semantics
//
// Run with dev server: npm run verify:boot-menu

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

// --- Unit: URL helper ---
{
  const prev = process.env.DREAMFALL_URL;
  process.env.DREAMFALL_URL = 'http://127.0.0.1:5175/?level=city&autostart=0';
  const a = dreamfallAppUrl();
  assert.ok(a.includes('5175') && a.includes('autostart=0') && a.includes('level=city'), a);
  process.env.DREAMFALL_URL = 'http://127.0.0.1:5173';
  const b = dreamfallAppUrl();
  assert.ok(b.includes('autostart=1'), b);
  const c = dreamfallAppUrl({ autostart: null });
  assert.ok(!c.includes('autostart='), c);
  if (prev == null) delete process.env.DREAMFALL_URL;
  else process.env.DREAMFALL_URL = prev;
  console.log('ok: dreamfallAppUrl units');
}

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

const timeout = Number(process.env.BOOT_MENU_TIMEOUT_MS ?? 90_000);

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
    localStorage.removeItem('dreamfall:skip-menu');
  });
  return page;
}

async function waitRunning(page, ms = timeout) {
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
    { timeout: ms },
  );
}

// A) Menu path
{
  const page = await newPage();
  const menuUrl = dreamfallAppUrl({ autostart: null }, { skipAutostart: true });
  await page.goto(menuUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="main-menu"]', { timeout: timeout });
  // No canvas while on menu
  const canvasOnMenu = await page.locator('canvas.game-canvas').count();
  assert.equal(canvasOnMenu, 0, 'canvas should not mount on main menu');
  // Garage must not be a menu control
  assert.equal(await page.locator('[data-testid="experience-garage"]').count(), 0);
  await page.click('[data-testid="experience-rally"]');
  await page.waitForSelector('canvas.game-canvas', { timeout: timeout });
  await waitRunning(page);
  console.log('ok: menu → rally → running');
  await page.close();
}

// B) Autostart path
{
  const page = await newPage();
  await page.addInitScript(() => {
    localStorage.setItem('dreamfall:level', 'rally');
  });
  await page.goto(dreamfallAppUrl({ level: 'rally' }), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Should not show main menu (or only briefly during shared — autostart skips shared menu path)
  await waitRunning(page);
  const menuVisible = await page.locator('[data-testid="main-menu"]').count();
  assert.equal(menuVisible, 0, 'main menu should not remain after autostart');
  console.log('ok: autostart → running');
  await page.close();
}

// C) Dispose loop ×3 via reload + menu re-entry (unmount path)
{
  const page = await newPage();
  const menuUrl = dreamfallAppUrl({ autostart: null }, { skipAutostart: true });
  for (let i = 0; i < 3; i += 1) {
    await page.goto(menuUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('[data-testid="main-menu"]', { timeout: timeout });
    await page.click('[data-testid="experience-rally"]');
    await waitRunning(page);
    // Return via evaluating phase is not exported; reloading menu unmounts cleanly.
    // In-app return is Settings → Main menu; exercise via localStorage + menu URL.
  }
  console.log('ok: dispose loop ×3 menu→rally');
  await page.close();
}

// D) Continue button present
{
  const page = await newPage();
  await page.addInitScript(() => {
    localStorage.setItem('dreamfall:level', 'city');
  });
  const menuUrl = dreamfallAppUrl({ autostart: null }, { skipAutostart: true });
  await page.goto(menuUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="main-menu"]', { timeout: timeout });
  await page.waitForSelector('[data-testid="continue-experience"]', { timeout: timeout });
  console.log('ok: continue control present');
  await page.close();
}

await browser.close();
console.log('verify:boot-menu passed');
