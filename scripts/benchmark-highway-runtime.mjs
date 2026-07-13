/**
 * Highway runtime benchmark (Playwright / optional real Chrome).
 *
 * Requires a running dev server (`npm run dev`). Absolute headless FPS is not a
 * release gate; relative counters and optional DREAMFALL_ASSERT_PERF=1 are.
 *
 * Usage:
 *   node scripts/benchmark-highway-runtime.mjs
 *   DREAMFALL_ASSERT_PERF=1 node scripts/benchmark-highway-runtime.mjs
 *
 * Alias: npm run benchmark:highway
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import {
  estimateMaxLiveSlots,
  poolSizeForArchetype,
} from '../src/game/config/highwayRunManifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, '.codex-tmp');
const assertPerf = process.env.DREAMFALL_ASSERT_PERF === '1';
const soakMs = Math.max(2000, Math.floor(Number(process.env.HIGHWAY_BENCH_SOAK_MS) || 8000));

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchOptions = {
  headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
};

let browser;
try {
  browser = await chromium.launch({
    ...launchOptions,
    executablePath: existsSync(chromePath) ? chromePath : undefined,
  });
} catch (err) {
  console.warn(`Chrome launch failed; bundled Chromium: ${err.message.split('\n')[0]}`);
  browser = await chromium.launch(launchOptions);
}

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(() => {
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
  localStorage.setItem('dreamfall:level', 'highway');
});

const url = dreamfallAppUrl({ level: 'highway', autostart: 1 });
console.log(`Highway benchmark → ${url}`);
console.log(`soak=${soakMs}ms  assertPerf=${assertPerf}`);

const bootStart = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(
  () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
  { timeout: 180_000 },
);
const bootToRunningMs = Date.now() - bootStart;

// Wait for traffic system ready if exposed.
await page.waitForFunction(() => {
  const snap = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
  return snap?.highwayTraffic?.status === 'ready' || snap?.stage === 'running';
}, { timeout: 60_000 }).catch(() => {});

const trafficReadyMs = Date.now() - bootStart;

// Drive forward for soakMs while sampling debug snapshot counters.
const sample = await page.evaluate(async (ms) => {
  const dbg = globalThis.__DREAMFALL_DEBUG__;
  const frames = [];
  const t0 = performance.now();
  let last = t0;
  // Light throttle input via debug if available; otherwise just observe idle cruise seed.
  while (performance.now() - t0 < ms) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    const dt = now - last;
    last = now;
    const snap = dbg?.snapshot?.() ?? {};
    const renderer = dbg?.getRenderer?.() ?? null;
    const info = renderer?.info;
    frames.push({
      dt,
      drawCalls: info?.render?.calls ?? null,
      triangles: info?.render?.triangles ?? null,
      geometries: info?.memory?.geometries ?? null,
      textures: info?.memory?.textures ?? null,
      vehicleCounts: snap.vehicles?.vehicleCounts ?? snap.vehicleCounts ?? null,
      highwayTraffic: snap.highwayTraffic
        ? {
          poolSize: snap.highwayTraffic.poolSize,
          liveLeases: snap.highwayTraffic.liveLeases,
          idleLeases: snap.highwayTraffic.idleLeases,
          maintenanceRuns: snap.highwayTraffic.maintenanceRuns,
          slotResolves: snap.highwayTraffic.slotResolves,
          skippedMaintenance: snap.highwayTraffic.skippedMaintenance,
        }
        : null,
      platforms: snap.platforms
        ? {
          platformCount: snap.platforms.platformCount,
          queries: snap.platforms.queries,
        }
        : null,
      level: snap.level
        ? {
          roadMeshCount: snap.level.roadMeshCount,
          roadGeometryCount: snap.level.roadGeometryCount,
        }
        : null,
    });
  }
  return { frames, sampleMs: performance.now() - t0 };
}, soakMs);

await browser.close();

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

const dts = sample.frames.map((f) => f.dt).filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
const avg = dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : null;
const p95 = percentile(dts, 95);
const p99 = percentile(dts, 99);
const max = dts.length ? dts[dts.length - 1] : null;
const hitches = dts.filter((d) => d > 33).length;

const last = sample.frames[sample.frames.length - 1] ?? {};
const first = sample.frames[0] ?? {};

const result = {
  generatedAt: new Date().toISOString(),
  url,
  soakMs,
  bootToRunningMs,
  trafficReadyMs,
  structural: {
    exactMaxLive: estimateMaxLiveSlots(),
    poolBudget: poolSizeForArchetype(),
  },
  frame: {
    samples: dts.length,
    avgMs: avg,
    p95Ms: p95,
    p99Ms: p99,
    maxMs: max,
    hitchCount_gt33ms: hitches,
  },
  lastSample: {
    drawCalls: last.drawCalls,
    triangles: last.triangles,
    geometries: last.geometries,
    textures: last.textures,
    vehicleCounts: last.vehicleCounts,
    highwayTraffic: last.highwayTraffic,
    platforms: last.platforms,
    level: last.level,
  },
  firstSample: {
    drawCalls: first.drawCalls,
    vehicleCounts: first.vehicleCounts,
    highwayTraffic: first.highwayTraffic,
  },
  note: 'Headless Chromium often throttles ~30fps; use relative comparisons and real-GPU probes for draw/triangle gates.',
};

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'highway-benchmark.json');
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
console.log(`\nWrote ${outPath}`);

if (assertPerf) {
  // Soft structural asserts only when opt-in (machine-specific timings skipped).
  if (result.structural.poolBudget > 22) {
    throw new Error(`pool budget ${result.structural.poolBudget} > 22`);
  }
  if (result.lastSample.level?.roadMeshCount > 20) {
    throw new Error(`roadMeshCount ${result.lastSample.level.roadMeshCount} > 20`);
  }
}

console.log('Highway benchmark complete.');
