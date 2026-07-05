// probe-office-interior-samplers.mjs — M6 sampler census for office interior materials.
// Run with dev server: node scripts/probe-office-interior-samplers.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  localStorage.setItem('dreamfall:quality', 'ultra');
  localStorage.setItem('dreamfall:post-effect', 'ssao');
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
  globalThis.__SAMPLER_CENSUS__ = [];
  const bglSamplers = new WeakMap();
  const plSamplers = new WeakMap();
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
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(8000);

const census = await page.evaluate(() => {
  const byLabel = new Map();
  for (const { label, samplers } of globalThis.__SAMPLER_CENSUS__ ?? []) {
    if (!byLabel.has(label) || byLabel.get(label) < samplers) byLabel.set(label, samplers);
  }
  return [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
});

const over = census.filter(([, n]) => n > 16);
console.log('Top fragment sampler counts:');
for (const [label, n] of census.slice(0, 15)) console.log(`  ${n}\t${label}`);
if (over.length > 0) {
  console.error(`\nFAIL: ${over.length} pipeline(s) exceed 16 fragment samplers`);
  process.exit(1);
}
console.log('\nOffice interior sampler census: all pipelines <= 16 fragment samplers.');
await browser.close();
