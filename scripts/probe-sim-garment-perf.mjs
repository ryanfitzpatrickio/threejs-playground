import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => localStorage.setItem('dreamfall:controls-dismissed', 'true'));
  await page.goto(dreamfallAppUrl({ level: 'sims', autostart: '1' }), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => {
      const sims = globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.sims?.sims;
      return sims?.length === 2 && sims.every((sim) => sim.garments?.[0]?.steps > 30);
    },
    { timeout: 150_000 },
  );
  await page.waitForTimeout(2_000);
  const sample = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().sims.sims.map((sim) => ({
    sim: sim.name,
    ...sim.garments[0],
  })));
  const combinedAverageMs = sample.reduce((sum, garment) => sum + garment.averageStepMs, 0);
  console.table(sample.map((garment) => ({
    sim: garment.sim,
    particles: garment.particles,
    renderVertices: garment.renderVertices,
    averageStepMs: garment.averageStepMs.toFixed(2),
    lastStepMs: garment.lastStepMs.toFixed(2),
    bvh: garment.hasBvh,
  })));
  console.log(`probe-sim-garment-perf: ${combinedAverageMs.toFixed(2)}ms combined average solver time for ${sample.length} garments`);
} finally {
  await browser.close();
}
