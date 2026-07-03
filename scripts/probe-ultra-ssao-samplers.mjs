// One-off census: run quality=ultra with each post-effect mode and report the
// fragment-stage sampler count of every render pipeline (WebGPU limit: 16/stage),
// by wrapping createBindGroupLayout/createPipelineLayout/createRenderPipeline.
// Requires a dev server (npm run dev). Run: node scripts/probe-ultra-ssao-samplers.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});

for (const mode of ['ssao', 'ssr', 'off']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));

  await page.addInitScript((m) => {
    localStorage.setItem('dreamfall:post-effect', m);
    localStorage.setItem('dreamfall:quality', 'ultra');
    localStorage.setItem('dreamfall:controls-dismissed', 'true');
    localStorage.setItem('dreamfall:level', 'world');

    // ---- fragment-sampler census instrumentation ----
    globalThis.__SAMPLER_CENSUS__ = [];
    const bglSamplers = new WeakMap(); // GPUBindGroupLayout -> fragment sampler count
    const plSamplers = new WeakMap(); // GPUPipelineLayout -> total fragment sampler count
    const FRAGMENT = 0x2;
    const origCreateBGL = GPUDevice.prototype.createBindGroupLayout;
    GPUDevice.prototype.createBindGroupLayout = function (desc) {
      const layout = origCreateBGL.call(this, desc);
      let n = 0;
      for (const e of desc?.entries ?? []) {
        if (e.sampler && (e.visibility & FRAGMENT)) n += 1;
      }
      bglSamplers.set(layout, n);
      return layout;
    };
    const origCreatePL = GPUDevice.prototype.createPipelineLayout;
    GPUDevice.prototype.createPipelineLayout = function (desc) {
      const layout = origCreatePL.call(this, desc);
      let n = 0;
      for (const bgl of desc?.bindGroupLayouts ?? []) n += bglSamplers.get(bgl) ?? 0;
      plSamplers.set(layout, n);
      return layout;
    };
    const record = (desc) => {
      const n = plSamplers.get(desc?.layout);
      if (n != null) globalThis.__SAMPLER_CENSUS__.push({ label: String(desc?.label ?? ''), samplers: n });
    };
    const origCreateRP = GPUDevice.prototype.createRenderPipeline;
    GPUDevice.prototype.createRenderPipeline = function (desc) {
      record(desc);
      return origCreateRP.call(this, desc);
    };
    const origCreateRPA = GPUDevice.prototype.createRenderPipelineAsync;
    GPUDevice.prototype.createRenderPipelineAsync = function (desc) {
      record(desc);
      return origCreateRPA.call(this, desc);
    };
  }, mode);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 90000 });
  await page.waitForTimeout(5000);

  const census = await page.evaluate(() => {
    const byLabel = new Map();
    for (const { label, samplers } of globalThis.__SAMPLER_CENSUS__ ?? []) {
      if (!byLabel.has(label) || byLabel.get(label) < samplers) byLabel.set(label, samplers);
    }
    return [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  });
  const backend = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.renderer?.backend);
  const validation = errors.filter((e) => !e.includes('favicon'));
  console.log(`\n=== ultra / ${mode} (backend ${backend}) — top fragment sampler counts (limit 16) ===`);
  for (const [label, n] of census) console.log(`   ${String(n).padStart(2)}  ${label}`);
  if (validation.length) console.log(`   ${validation.length} console errors; first: ${validation[0].slice(0, 200)}`);
  const stats = await page.evaluate(() => {
    const snap = globalThis.__DREAMFALL_DEBUG__?.snapshot?.() ?? {};
    return { fps: snap.fps, frameMs: snap.frameMs, render: snap.frameStats ?? snap.renderer?.frameStats ?? null, drawCalls: snap.renderer?.drawCalls };
  });
  console.log(`  [${mode}] stats:`, JSON.stringify(stats));
  await page.screenshot({ path: `/tmp/ultra-${mode}.png` });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `/tmp/ultra-${mode}-b.png` });
  await page.close();
}
await browser.close();
