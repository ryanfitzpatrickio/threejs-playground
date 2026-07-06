import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
const url = process.argv[2] ?? 'http://127.0.0.1:5174';
const exe = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;
const browser = await chromium.launch({ headless: false, executablePath: exe, args: ['--enable-unsafe-webgpu','--enable-features=Vulkan'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type()==='error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 60_000 });
await page.waitForTimeout(1500);
const snap = () => page.evaluate(() => { const s = globalThis.__DREAMFALL_DEBUG__.snapshot(); return { draw: s.renderer?.drawCalls, tri: s.renderer?.triangles, objects: s.renderer?.objects, p: s.player }; });
console.log('spawn:', JSON.stringify(await snap()));
await page.evaluate(async () => { await globalThis.__DREAMFALL_DEBUG__.enterVehicleByName?.('Spawn Car'); });
await page.waitForTimeout(400);
await page.keyboard.down('KeyW');
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(900);
  console.log(`t=${(i+1)*0.9}s`, JSON.stringify(await snap()));
}
await page.keyboard.up('KeyW');
if (errors.length) console.log('errors:', errors.slice(0,6).join(' | '));
await browser.close();
