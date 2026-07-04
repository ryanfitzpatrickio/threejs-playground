import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const timeout = Number(process.env.CITY_VERIFY_TIMEOUT_MS ?? 120000);
const sampleMs = Number(process.env.CITY_ALLOC_SAMPLE_MS ?? 3000);
const RETAINED_KB_PER_SEC_CEILING = Number(process.env.HEAP_GROWTH_KB_PER_SEC_CEILING ?? 1500);

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  const isFavicon = message.text().includes('favicon') || message.location()?.url?.includes('favicon');
  if (message.type() === 'error' && !isFavicon) errors.push(message.text());
});

await page.addInitScript(() => {
  localStorage.setItem('dreamfall:quality', 'ultra');
  localStorage.setItem('dreamfall:post-effect', 'ssao');
  localStorage.setItem('dreamfall:level', 'city');
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
});

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout });
  await page.waitForFunction(() => {
    const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
    return snapshot?.level?.city?.initialLoadComplete === true && snapshot.level.ledges > 0;
  }, { timeout });
  await new Promise((r) => setTimeout(r, 1200));

  const result = await page.evaluate(async (duration) => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    dbg.startAllocationSample(duration);
    await new Promise((resolve) => {
      const start = performance.now();
      const wait = () => {
        const status = dbg.allocationSampleReport();
        if (!status.active || performance.now() - start >= duration + 250) {
          resolve(dbg.allocationSampleReport());
          return;
        }
        requestAnimationFrame(wait);
      };
      requestAnimationFrame(wait);
    });
    const city = dbg.snapshot().level?.city ?? {};
    const scene = dbg.sceneStats();
    const furniture = dbg.furnitureStats();
    return { allocation: dbg.allocationSampleReport(), city, scene, furniture };
  }, sampleMs);

  assert.equal(errors.length, 0, errors[0]);
  assert.ok(result.allocation.sampleCount >= 10, 'allocation samples recorded');
  assert.ok(result.city.chunks > 0, 'city chunks loaded');
  assert.ok(result.furniture?.meshes > 0, 'global furniture batch meshes exist');
  assert.ok(result.furniture.drawCalls <= 20,
    `furniture draw calls batched (${result.furniture.drawCalls})`);
  assert.ok(result.furniture.instances > result.furniture.drawCalls,
    'multiple instances share batched draws');

  if (process.env.DREAMFALL_ASSERT_HEAP === '1' && result.allocation.retainedKbPerSec != null) {
    assert.ok(
      result.allocation.retainedKbPerSec < RETAINED_KB_PER_SEC_CEILING,
      `retained heap ${result.allocation.retainedKbPerSec} KB/s over ceiling ${RETAINED_KB_PER_SEC_CEILING}`,
    );
  }

  console.log('City allocation verification passed.', JSON.stringify(result));
} catch (error) {
  const snapshot = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.() ?? null).catch(() => null);
  console.error('City allocation snapshot at failure:', JSON.stringify(snapshot?.level ?? snapshot));
  throw error;
} finally {
  await browser.close();
}
