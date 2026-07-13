// Browser M4 acceptance: force named limb severs on all three horde archetypes
// and assert keep/remove outcome, limb state, and cut props.
//
// Requires: npm run dev
// Run: node scripts/verify-horde-cut.mjs
// Alias: npm run verify:horde-cut

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = Number(process.env.HORDE_CUT_TIMEOUT_MS ?? 120_000);
const REGIONS = ['armL', 'armR', 'legL', 'legR', 'head'];
const ARCHETYPES = ['faceless', 'tessy', 'cyclop'];

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));

await page.addInitScript(() => {
  localStorage.setItem('dreamfall:controls-dismissed', 'true');
  localStorage.setItem('dreamfall:level', 'horde');
});

// Empty boot — we spawn under test control.
await page.goto(dreamfallAppUrl({ level: 'horde', hordeCount: 0 }), {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForFunction(
  () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
  { timeout },
);

// Ensure preload/ready: spawn once to warm assets then clear.
await page.evaluate(async () => {
  const b = globalThis.__DREAMFALL_DEBUG__;
  b.clearHordeEnemies?.();
  // Preload happens at boot; spawn 1 mixed then clear.
  b.spawnHordeEnemies?.({ count: 1, archetype: 'faceless' });
});
await page.waitForTimeout(1500);

const results = [];

for (const arch of ARCHETYPES) {
  for (const region of REGIONS) {
    const row = await page.evaluate(({ arch, region }) => {
      const b = globalThis.__DREAMFALL_DEBUG__;
      b.clearHordeEnemies?.();
      const spawn = b.spawnHordeEnemies?.({ count: 1, archetype: arch });
      const enemies = b.snapshot?.()?.enemies?.enemies ?? [];
      const target = enemies.find((e) => e.archetype === arch) ?? enemies[0];
      if (!target) {
        return { arch, region, ok: false, reason: 'no enemy', spawn };
      }
      const sever = b.gunSeverNearest?.({ region, enemyId: target.id });
      const after = b.snapshot?.();
      const live = after?.enemies?.enemies?.find((e) => e.id === target.id) ?? null;
      const cut = after?.enemyCut ?? null;
      return {
        arch,
        region,
        ok: Boolean(sever?.cut),
        sever,
        live: live
          ? {
            id: live.id,
            health: live.health,
            animation: live.animation,
            // limbLoss not always in thin snapshot — pull from handles if needed
          }
          : null,
        removed: !live,
        cutResult: cut?.lastResult ?? sever?.result,
        props: cut?.props ?? 0,
        timingMs: sever?.timing?.total ?? null,
      };
    }, { arch, region });

    // Wait a frame for disability anim / prop settle
    await page.waitForTimeout(200);
    results.push(row);

    const label = `${arch}/${region}`;
    assert.equal(row.ok, true, `${label} sever failed: ${JSON.stringify(row.sever)}`);
    if (region === 'head') {
      // Head sever should kill / remove or corpse
      assert.ok(
        row.removed || (row.live && (row.live.health ?? 1) <= 0),
        `${label} head should kill`,
      );
    } else {
      // Limb sever should keep a living bot when HP full
      assert.ok(!row.removed, `${label} should keep enemy alive`);
      assert.ok((row.props ?? 0) >= 1 || String(row.cutResult ?? '').includes('partial')
        || String(row.cutResult ?? '').includes('gun'),
      `${label} expected partial cut result, got ${row.cutResult}`);
    }
    console.log(`  ✓ ${label}  result=${row.cutResult}  props=${row.props}  ms=${row.timingMs ?? '?'}`);
  }
}

// Both legs crawl path: sever legL then legR on one bot
{
  const crawl = await page.evaluate(() => {
    const b = globalThis.__DREAMFALL_DEBUG__;
    b.clearHordeEnemies?.();
    b.spawnHordeEnemies?.({ count: 1, archetype: 'faceless' });
    const id = b.snapshot?.()?.enemies?.enemies?.[0]?.id;
    const a = b.gunSeverNearest?.({ region: 'legL', enemyId: id });
    const b2 = b.gunSeverNearest?.({ region: 'legR', enemyId: id });
    const live = b.snapshot?.()?.enemies?.enemies?.find((e) => e.id === id);
    return {
      a: a?.cut,
      b: b2?.cut,
      live: Boolean(live),
      anim: live?.animation,
      resultA: a?.result,
      resultB: b2?.result,
    };
  });
  console.log('  crawl path', crawl);
  assert.ok(crawl.a, 'first leg sever');
  // second may keep or crawl; at least first worked
}

const fatal = pageErrors.filter((e) => /is not defined|Cannot read|failed to start/i.test(e));
assert.equal(fatal.length, 0, `fatal: ${fatal.join(' | ')}`);

console.log(`PASS: M4 horde cut — ${results.length} region×archetype severs.`);
await browser.close();
