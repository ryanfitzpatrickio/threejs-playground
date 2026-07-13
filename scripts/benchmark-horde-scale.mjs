// M0 Horde scale benchmark — multi-gate soak with frame p50/p95 samples.
//
// Requires a running dev server (`npm run dev`). Headless Chromium often
// throttles ~30fps; treat absolute fps as a floor, relative gates as the signal.
//
// Usage:
//   node scripts/benchmark-horde-scale.mjs
//   HORDE_BENCH_COUNTS=40,250,750 node scripts/benchmark-horde-scale.mjs
//   node scripts/benchmark-horde-scale.mjs --write-doc
//
// Alias: npm run benchmark:horde-scale

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import {
  HORDE_DEFAULT_ENEMY_COUNT,
  HORDE_FULL_ACTOR_LIMIT,
  HORDE_MAX_ENEMY_COUNT,
  HORDE_SPECTACLE_ENEMY_COUNT,
  HORDE_STRETCH_ENEMY_COUNT,
} from '../src/game/config/hordePerformanceConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const writeDoc = process.argv.includes('--write-doc');
const soakMs = Math.max(800, Math.floor(Number(process.env.HORDE_BENCH_SOAK_MS) || 2200));
const defaultCounts = [
  40,
  HORDE_DEFAULT_ENEMY_COUNT,
  HORDE_STRETCH_ENEMY_COUNT,
  HORDE_SPECTACLE_ENEMY_COUNT,
];
const counts = String(process.env.HORDE_BENCH_COUNTS ?? '')
  .split(',')
  .map((s) => Math.floor(Number(s.trim())))
  .filter((n) => Number.isFinite(n) && n > 0);
const gateCounts = (counts.length ? counts : defaultCounts)
  .map((n) => Math.min(HORDE_MAX_ENEMY_COUNT, n));

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
  localStorage.setItem('dreamfall:level', 'horde');
});

const url = dreamfallAppUrl({ level: 'horde', hordeCount: 0 });
console.log(`M0 benchmark → ${url}`);
console.log(`Gates: ${gateCounts.join(', ')}  soak=${soakMs}ms`);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await page.waitForFunction(
  () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
  { timeout: 180_000 },
);

// Freeze camera: look slightly into the yard, no player input.
await page.evaluate(() => {
  const dbg = globalThis.__DREAMFALL_DEBUG__;
  const cam = dbg.getCamera?.();
  if (cam) {
    cam.position.set(8, 4.5, 12);
    cam.lookAt(0, 1.2, 0);
  }
});

const results = [];
for (const count of gateCounts) {
  const presetId = count <= 250
    ? 'default'
    : count <= 750
      ? 'stretch'
      : count <= 1000
        ? 'spectacle'
        : count <= 1500
          ? 'heavy'
          : 'extreme';

  console.log(`\n── gate ${count} (preset=${presetId}) ──`);
  const boot = await page.evaluate(({ count: n, presetId: pid }) => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    return dbg.spawnHordeBenchmark({
      count: n,
      archetype: 'mixed',
      passive: true,
      frozen: false,
      presetId: pid,
    });
  }, { count, presetId });

  assert.ok(boot.ok, `spawnHordeBenchmark failed for ${count}: ${JSON.stringify(boot)}`);
  assert.ok(boot.spawn?.accepted > 0 || count === 0, boot);

  // Drain spawn queue until occupied reaches target (or timeout).
  await page.waitForFunction((target) => {
    const scale = globalThis.__DREAMFALL_DEBUG__?.getHordeDebug?.();
    if (!scale) return false;
    const occupied = (scale.fullActors ?? 0) + (scale.proxies ?? 0);
    return (scale.queued ?? 0) === 0 && occupied >= Math.min(target, scale.cap ?? target);
  }, count, { timeout: 180_000 });

  // Settle promote/demote, then sample frame window.
  await page.waitForTimeout(600);
  await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.resetFrameStats());
  await page.waitForTimeout(soakMs);

  const sample = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.sampleHordeBenchmark());
  const row = {
    count,
    presetId,
    occupied: sample.scale?.occupied ?? null,
    alive: sample.scale?.alive ?? null,
    fullActors: sample.scale?.fullActors ?? null,
    fullActorLimit: sample.scale?.fullActorLimit ?? HORDE_FULL_ACTOR_LIMIT,
    proxies: sample.scale?.proxies ?? null,
    proxyDrawCalls: sample.proxies?.drawCalls ?? null,
    geometrySource: sample.proxies?.geometrySource ?? sample.scale?.geometrySource ?? null,
    sectors: sample.proxies?.sectorCount ?? null,
    occupiedSectors: sample.proxies?.occupiedSectors ?? null,
    enemyBodies: sample.physics?.enemyBodies ?? null,
    avgMs: sample.frame?.recentAvgMs ?? null,
    p95Ms: sample.frame?.recentP95Ms ?? null,
    maxMs: sample.frame?.recentMaxMs ?? null,
    hitches: sample.frame?.hitches ?? null,
    systems: sample.frame?.systems ?? null,
    drawStats: sample.renderer?.drawStats ?? null,
    heapUsedMb: sample.heapUsedMb,
  };
  results.push(row);
  console.log(
    `  occupied=${row.occupied} full=${row.fullActors}/${row.fullActorLimit} proxies=${row.proxies}`
    + `  avg=${row.avgMs}ms p95=${row.p95Ms}ms max=${row.maxMs}ms hitches=${row.hitches}`
    + `  proxyDraws=${row.proxyDrawCalls} heap=${row.heapUsedMb ?? '?'}MB`,
  );
  if (row.systems) {
    const top = Object.entries(row.systems).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  systems: ${top.map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join('  ')}`);
  }
}

await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.clearHordeEnemies());
await browser.close();

const outDir = join(root, '.codex-tmp');
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, 'horde-scale-benchmark.json');
const payload = {
  generatedAt: new Date().toISOString(),
  note: 'Headless Chromium often caps ~30fps; use relative gate scaling, not absolute desktop 60fps claims.',
  viewport: { width: 1280, height: 720 },
  soakMs,
  fullActorLimit: HORDE_FULL_ACTOR_LIMIT,
  gates: results,
};
writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nWrote ${jsonPath}`);

if (writeDoc) {
  const docPath = join(root, 'docs/horde-scale-benchmark.md');
  writeFileSync(docPath, renderBenchmarkMarkdown(payload));
  console.log(`Wrote ${docPath}`);
}

console.log('\nPASS: M0 horde scale benchmark complete.');

function renderBenchmarkMarkdown(data) {
  const rows = data.gates.map((g) => {
    const sys = g.systems
      ? Object.entries(g.systems)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} ${Number(v).toFixed(2)}ms`)
        .join(', ')
      : '—';
    return `| ${g.count} | ${g.presetId} | ${g.occupied ?? '—'} | ${g.fullActors ?? '—'}/${g.fullActorLimit ?? '—'} | ${g.proxies ?? '—'} | ${g.avgMs ?? '—'} | ${g.p95Ms ?? '—'} | ${g.maxMs ?? '—'} | ${g.hitches ?? '—'} | ${g.proxyDrawCalls ?? '—'} | ${g.heapUsedMb ?? '—'} | ${sys} |`;
  }).join('\n');

  return `# Horde Scale Benchmark (M0)

**Generated:** ${data.generatedAt}  
**Method:** Playwright headless Chromium + WebGPU, camera-stable horde arena, passive AI, invulnerable soak.  
**Soak:** ${data.soakMs} ms frame window after spawn queue drain.  
**Full actor limit:** ${data.fullActorLimit}

> ${data.note}

## Gates

| Count | Preset | Occupied | Full | Proxies | avg ms | p95 ms | max ms | hitches | proxy draws | heap MB | top systems |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
${rows}

## Interpretation

- **Full actors** stay near the Tier A cap (~${data.fullActorLimit}); overflow is proxies.
- **p95 frame time** should stay stable from the 250 gate through stretch (750) if sector culling + proxy path hold.
- **proxy draws** scale with occupied sectors × archetypes, not with raw agent count (M5 sector batches).
- **Dominant systems** in the top list identify the next budget to cut (enemy, combat, physics, render).

## Reproduce

\`\`\`sh
npm run dev   # separate terminal
npm run benchmark:horde-scale
# or rewrite this doc:
node scripts/benchmark-horde-scale.mjs --write-doc
\`\`\`

Raw JSON: \`.codex-tmp/horde-scale-benchmark.json\`
`;
}
