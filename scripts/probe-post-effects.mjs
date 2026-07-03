// Runtime smoke test for the SSAO / SSR / Off post-effect selector
// (see internal SSAO/bloom planning notes): loads the game once per mode, waits
// for the pipeline to render, and fails on any WebGPU validation / shader
// compilation error in the console. Also prints the renderer snapshot's
// post-effect diagnostics for each mode.
//
// Requires a dev server (npm run dev). Run: node scripts/probe-post-effects.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});

let failed = false;

for (const mode of ['ssao', 'ssr', 'off']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${msg.text()} [${msg.location()?.url ?? ''}]`);
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.addInitScript((m) => {
    localStorage.setItem('dreamfall:post-effect', m);
    localStorage.setItem('dreamfall:quality', 'high');
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
  }, mode);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 60000 });
  await page.waitForTimeout(3000); // let several frames render through the full pipeline

  const renderer = await page.evaluate(() => {
    const snap = globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.renderer ?? {};
    const {
      backend, postEffectModeRequested, postEffectMode, ssao, ssr,
      bloom, bloomImplementation, bloomResolutionScale,
      normalPrePassAllocated, ssrMrtAllocated, drawCalls,
    } = snap;
    return {
      backend, postEffectModeRequested, postEffectMode, ssao, ssr,
      bloom, bloomImplementation, bloomResolutionScale,
      normalPrePassAllocated, ssrMrtAllocated, drawCalls,
    };
  });

  console.log(`\n=== mode: ${mode} ===`);
  console.log(JSON.stringify(renderer, null, 2));

  const validationErrors = errors.filter((e) => !e.includes('favicon'));
  if (validationErrors.length > 0) {
    failed = true;
    console.log(`FAIL: ${validationErrors.length} console error(s):`);
    for (const e of validationErrors.slice(0, 10)) console.log('  ', e.slice(0, 400));
  } else {
    console.log('no console errors');
  }

  if (renderer.postEffectModeRequested !== mode) {
    failed = true;
    console.log(`FAIL: requested mode reports ${renderer.postEffectModeRequested}, expected ${mode}`);
  }
  if (renderer.backend === 'webgpu' && renderer.postEffectMode !== mode) {
    failed = true;
    console.log(`FAIL: effective mode reports ${renderer.postEffectMode}, expected ${mode} on high quality`);
  }
  if (renderer.normalPrePassAllocated && renderer.ssrMrtAllocated) {
    failed = true;
    console.log('FAIL: normal pre-pass and SSR MRT allocated together');
  }

  await page.close();
}

await browser.close();
console.log(failed ? '\nprobe-post-effects: FAILED' : '\nprobe-post-effects: all modes clean');
process.exit(failed ? 1 : 0);
