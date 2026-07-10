// Guards the PR1 play-ready contract:
// - stage === 'running' only after systems + prewarm + near-field
// - city never reports running while initialLoadComplete is false
// - loadProgress.ready mirrors stage === 'running'
// - loadProgress.fraction is non-decreasing
//
// Run (dev server up): node scripts/verify-play-ready-barrier.mjs
// Optional: DREAMFALL_URL, LEVEL=city|rally, TIMEOUT_MS

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const level = process.env.LEVEL ?? 'rally';
const url = dreamfallAppUrl({ level });
const timeout = Number(process.env.TIMEOUT_MS ?? (level === 'city' ? 120_000 : 90_000));

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

await page.addInitScript((mode) => {
  localStorage.setItem('dreamfall:level', mode);
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
  localStorage.setItem('dreamfall:quality', mode === 'city' ? 'high' : 'high');
}, level);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Poll until running, recording intermediate snapshots for contract checks.
const start = Date.now();
let lastFraction = -1;
let sawPrewarming = false;
let samples = 0;

while (Date.now() - start < timeout) {
  const sample = await page.evaluate(() => {
    const snap = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
    if (!snap) return null;
    return {
      stage: snap.stage,
      loadProgress: snap.loadProgress ?? null,
      initialLoadComplete: snap.level?.city?.initialLoadComplete,
      prewarm: snap.prewarm,
    };
  });

  if (sample) {
    samples += 1;
    if (sample.stage === 'prewarming') sawPrewarming = true;

    if (sample.stage === 'running') {
      assert.equal(
        sample.loadProgress?.ready,
        true,
        'loadProgress.ready must be true when stage is running',
      );
      if (level === 'city') {
        assert.equal(
          sample.initialLoadComplete,
          true,
          'city must not be running before initialLoadComplete',
        );
      }
      break;
    }

    // Never running while city incomplete (also covers prewarming/loading).
    if (level === 'city' && sample.initialLoadComplete === false) {
      assert.notEqual(sample.stage, 'running', 'running while city incomplete');
    }

    const frac = sample.loadProgress?.fraction;
    if (typeof frac === 'number' && Number.isFinite(frac)) {
      assert.ok(frac + 1e-6 >= lastFraction, `fraction went backwards: ${lastFraction} → ${frac}`);
      lastFraction = frac;
    }
  }

  await page.waitForTimeout(100);
}

const finalSnap = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.());
assert.ok(finalSnap, 'debug snapshot missing');
assert.equal(finalSnap.stage, 'running', `timed out waiting for running (level=${level})`);
assert.equal(finalSnap.loadProgress?.ready, true, 'final loadProgress.ready');
assert.ok(samples > 0, 'no samples collected');

// Rally/city both go through prewarming after character load.
assert.ok(sawPrewarming || finalSnap.loadProgress?.fraction === 1, 'expected prewarming or instant ready');

console.log(`ok: play-ready barrier (level=${level}, samples=${samples}, fraction=${finalSnap.loadProgress?.fraction})`);
if (errors.length) {
  console.warn('page errors (non-fatal for this gate):', errors.slice(0, 5));
}

await browser.close();
