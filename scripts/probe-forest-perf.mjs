/**
 * Capture a forest performance time series from a running dev server.
 *
 * Usage: npm run probe:forest-perf -- [url] [seconds]
 * Set DREAMFALL_HEADLESS=false for representative desktop GPU measurements.
 */
import { existsSync } from 'node:fs';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import { chromium } from 'playwright';

const url = process.argv[2] ?? dreamfallAppUrl();
const durationSeconds = Math.max(2, Number(process.argv[3] ?? 12));
const headless = process.env.DREAMFALL_HEADLESS !== 'false';
const drive = process.env.DREAMFALL_DRIVE !== 'false';
const executablePath = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : undefined;

const browser = await chromium.launch({ headless, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.addInitScript(() => {
  const frameTimes = [];
  let previous = 0;
  const tick = (now) => {
    if (previous) frameTimes.push(now - previous);
    previous = now;
    if (frameTimes.length > 600) frameTimes.shift();
    globalThis.__FOREST_FRAME_TIMES__ = frameTimes;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(
  () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
  { timeout: 60_000 },
);

const startPosition = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot()?.player ?? null);
if (drive) {
  await page.evaluate(async () => {
    await globalThis.__DREAMFALL_DEBUG__.enterVehicleByName?.('Spawn Car');
  });
  await page.keyboard.down('KeyW');
}

const samples = [];
const sampleCount = durationSeconds * 4;
for (let index = 0; index < sampleCount; index += 1) {
  samples.push(await page.evaluate(() => {
    const snapshot = globalThis.__DREAMFALL_DEBUG__.snapshot();
    const level = snapshot.level?.city ?? {};
    const forest = level.terrain ?? level;
    const renderer = snapshot.renderer ?? {};
    const frames = globalThis.__FOREST_FRAME_TIMES__ ?? [];
    const recentFrames = frames.slice(-120);
    const averageFrameMs = recentFrames.length
      ? recentFrames.reduce((sum, value) => sum + value, 0) / recentFrames.length
      : 0;
    return {
      at: performance.now(),
      fps: averageFrameMs > 0 ? 1000 / averageFrameMs : 0,
      drawCalls: renderer.drawCalls ?? 0,
      triangles: renderer.triangles ?? 0,
      forestRebinMs: forest.forestRebinMs ?? 0,
      forestNear: forest.forestNear ?? 0,
      forestImpostors: forest.forestImpostors ?? 0,
      forestImpostorBakeStatus: forest.forestImpostorBakeStatus ?? 'unknown',
    };
  }));
  await page.waitForTimeout(250);
}

if (drive) await page.keyboard.up('KeyW');

const snapshot = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
await browser.close();

const level = snapshot.level?.city ?? {};
const forest = level.terrain ?? level;
const endPosition = snapshot.player ?? null;
const distanceTravelled = startPosition && endPosition
  ? Math.hypot(endPosition.x - startPosition.x, endPosition.z - startPosition.z)
  : 0;
const values = (key) => samples.map((sample) => sample[key]).filter(Number.isFinite);
const percentile = (list, fraction) => {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};
const average = (list) => list.length
  ? list.reduce((sum, value) => sum + value, 0) / list.length
  : 0;

const report = {
  mode: headless ? 'headless (comparative only)' : 'headed desktop',
  driveEnabled: drive,
  distanceTravelled: Number(distanceTravelled.toFixed(1)),
  durationSeconds,
  loadPhasesMs: {
    archetypes: forest.forestArchetypeBuildMs ?? 0,
    placements: forest.forestPlacementMs ?? 0,
    colliders: forest.forestColliderBuildMs ?? 0,
    offRoadPool: forest.forestOffRoadPoolBuildMs ?? 0,
    litter: forest.forestLitterBuildMs ?? 0,
    impostorBake: forest.forestImpostorBakeMs ?? 0,
  },
  cacheHit: forest.forestArchetypeCacheHit ?? false,
  impostorBakeStatus: forest.forestImpostorBakeStatus ?? 'unknown',
  trees: forest.forestTrees ?? 0,
  forestDetected: (forest.forestTrees ?? 0) > 0,
  active: {
    nearMax: Math.max(0, ...values('forestNear')),
    impostorMax: Math.max(0, ...values('forestImpostors')),
  },
  fps: {
    average: Number(average(values('fps')).toFixed(1)),
    p05: Number(percentile(values('fps'), 0.05).toFixed(1)),
  },
  rebinMs: {
    average: Number(average(values('forestRebinMs')).toFixed(3)),
    p95: Number(percentile(values('forestRebinMs'), 0.95).toFixed(3)),
    max: Number(Math.max(0, ...values('forestRebinMs')).toFixed(3)),
  },
  gpuWork: {
    drawCallsAverage: Number(average(values('drawCalls')).toFixed(1)),
    trianglesAverage: Math.round(average(values('triangles'))),
  },
  consoleErrors: errors.filter((error) =>
    !error.includes('favicon') && !error.includes('Failed to load resource')).slice(0, 10),
  samples,
};

if (!report.forestDetected) {
  report.warning = 'No forest zone is active; select a forest map before using this run for forest conclusions.';
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.consoleErrors.length ? 1 : 0;
