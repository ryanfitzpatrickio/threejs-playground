// probe-simhuman-samplers.mjs — fragment-sampler census for the vibe-human
// skin materials (head skin alone binds 8 textures; WebGPU budget is 16 per
// fragment stage). Runs the ?view=simhuman viewer, which renders with
// shadow maps enabled — close to sim-scene conditions. If a pipeline trips
// the budget once the full sim scene adds env/fog samplers, the fallback is
// DataArrayTexture packing of the same-size skin maps.
//
// Run with dev server: node scripts/probe-simhuman-samplers.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const url = dreamfallAppUrl({ view: 'simhuman' });
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
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

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForFunction(
  () => ['ready', 'failed'].includes(globalThis.__SIMHUMAN_DEBUG__?.status),
  { timeout: 90_000 },
);
await page.waitForTimeout(4_000);

const census = await page.evaluate(() => {
  const byLabel = new Map();
  for (const { label, samplers } of globalThis.__SAMPLER_CENSUS__ ?? []) {
    if (!byLabel.has(label) || byLabel.get(label) < samplers) byLabel.set(label, samplers);
  }
  return [...byLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
});

const over = census.filter(([, n]) => n > 16);
console.log('Sim human viewer — top fragment sampler counts:');
for (const [label, n] of census.slice(0, 12)) console.log(`  ${n}\t${label || '(unlabeled pipeline)'}`);
if (over.length > 0) {
  console.error(`\nFAIL: ${over.length} pipeline(s) exceed 16 fragment samplers`);
  process.exit(1);
}
console.log('\nSim human sampler census: all pipelines <= 16 fragment samplers.');
await browser.close();
