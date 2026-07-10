#!/usr/bin/env node
/**
 * Ground-truth probe: load the app in a real browser, capture EVERY console
 * message + pageerror, screenshot it, and dump the __DREAMFALL_DEBUG__ snapshot
 * so we can see whether skinned models crash, fall back to procedural, or spike.
 */
import { existsSync } from 'node:fs';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const appUrl = dreamfallAppUrl() /* was 5174 default */;
const outDir = path.resolve('.codex-tmp', 'probe-browser');
await mkdir(outDir, { recursive: true });

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

const errors = [];
const warnings = [];
const webgpuLogs = [];
const notFound = [];
page.on('console', (msg) => {
  const t = msg.type();
  const text = msg.text();
  if (t === 'error') errors.push(text);
  else if (t === 'warning') warnings.push(text);
  if (/webgpu|skin|spike|matrixWorld|applyBone|normalize|createRenderPipeline|unorm|vertex format/i.test(text)) {
    webgpuLogs.push(`[${t}] ${text}`);
  }
});
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

try {
  console.log('navigating to', appUrl);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // wait for canvas to exist
  await page.waitForSelector('canvas.game-canvas', { timeout: 20000 }).catch(() => console.log('no canvas selector match'));
  // let it run
  await new Promise((r) => setTimeout(r, 16000));

  await page.screenshot({ path: path.join(outDir, 'load.png') });

  const snap = await page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    if (!dbg?.snapshot) return { hasDebug: false, gpu: !!navigator.gpu };
    const s = dbg.snapshot();
    const sceneStats = dbg.sceneStats ? dbg.sceneStats() : null;
    return {
      hasDebug: true,
      gpu: !!navigator.gpu,
      stage: s?.stage,
      backend: s?.renderer?.backend,
      triangles: s?.renderer?.triangles,
      character: s?.character,
      animationStatus: s?.animation?.status,
      animationStatesCount: s?.animation?.availableStates?.length,
      enemyStatus: s?.enemies?.status,
      enemyCount: s?.enemies?.enemies?.length,
      horseStatus: s?.horse?.status,
      sceneStats,
    };
  });

  console.log('\n=== SNAPSHOT ===');
  console.log(JSON.stringify(snap, null, 2));

  console.log('\n=== 404s ===');
  for (const u of [...new Set(notFound)]) console.log(' ', u);

  console.log('\n=== WEBGPU/SKIN-RELATED LOGS (' + webgpuLogs.length + ') ===');
  for (const l of webgpuLogs.slice(0, 60)) console.log(l);

  console.log('\n=== PAGE/CONSOLE ERRORS (' + errors.length + ') ===');
  const seen = new Set();
  for (const e of errors) {
    const key = e.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(e);
  }

  console.log('\n=== WARNINGS (' + warnings.length + ', first 30 unique) ===');
  const wseen = new Set();
  let n = 0;
  for (const w of warnings) {
    const key = w.slice(0, 120);
    if (wseen.has(key)) continue;
    wseen.add(key);
    console.log(w);
    if (++n >= 30) break;
  }
} catch (e) {
  console.log('CAPTURE FAILED:', e.message);
} finally {
  await browser.close();
}
