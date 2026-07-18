// Browser M2 probe: ?level=horde reaches stage==='running', player grounded,
// smoke bots on ground, gates present, and reload does not duplicate the level
// group.
//
// Requires dev server: npm run dev
// Run: node scripts/verify-horde-mode.mjs
// Alias: npm run verify:horde-mode

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = Number(process.env.HORDE_MODE_TIMEOUT_MS ?? 120_000);

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

// Boot with a known pack so the probe does not depend on the debug panel.
const url = dreamfallAppUrl({ level: 'horde', hordeCount: 12 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
  { timeout },
);

function collectProbe() {
  return page.evaluate(() => {
    const dbg = globalThis.__DREAMFALL_DEBUG__;
    const s = dbg.snapshot();
    const scene = dbg.getScene?.();
    let hordeGroups = 0;
    scene?.traverse?.((o) => {
      if (o.name === 'Horde Arena') hordeGroups += 1;
    });
    const gates = dbg.getLevelHandles?.()?.colliders
      ? null
      : null;
    // Spawn points live on the live level object via handles or scene children.
    const levelGroup = (() => {
      let found = null;
      scene?.traverse?.((o) => {
        if (o.name === 'Horde Arena') found = o;
      });
      return found;
    })();
    return {
      stage: s.stage,
      levelName: s.level?.name,
      hordeGates: s.level?.hordeGates ?? 0,
      grounded: s.character?.grounded === true,
      charY: s.character?.position?.y ?? s.character?.y ?? null,
      charX: s.character?.position?.x ?? null,
      charZ: s.character?.position?.z ?? null,
      player: s.player,
      enemyCount: s.enemies?.count ?? 0,
      enemyIds: (s.enemies?.enemies ?? []).map((e) => e.id),
      enemyArchetypes: (s.enemies?.enemies ?? []).map((e) => e.archetype),
      enemyYs: (s.enemies?.enemies ?? []).map((e) => e.position?.y),
      cameraFp: Boolean(s.camera?.onFootFirstPerson ?? s.camera?.firstPerson),
      vehicleCount: s.vehicles?.count ?? s.vehicles?.activeCount ?? 0,
      hordeGroups,
      hasLevelGroup: Boolean(levelGroup),
      gates,
    };
  });
}

const snap1 = await collectProbe();
console.log('snap1', {
  stage: snap1.stage,
  levelName: snap1.levelName,
  hordeGates: snap1.hordeGates,
  grounded: snap1.grounded,
  enemyCount: snap1.enemyCount,
  enemyArchetypes: snap1.enemyArchetypes,
  cameraFp: snap1.cameraFp,
  vehicleCount: snap1.vehicleCount,
  hordeGroups: snap1.hordeGroups,
});

assert.equal(snap1.stage, 'running');
assert.equal(snap1.levelName, 'Horde Arena');
assert.equal(snap1.grounded, true);
assert.ok(snap1.charX < -70 && Math.abs(snap1.charZ) < 2, `player should start in mall center (${snap1.charX}, ${snap1.charZ})`);
assert.ok(snap1.hordeGates >= 6 && snap1.hordeGates <= 8, `gates ${snap1.hordeGates}`);
assert.ok(snap1.enemyCount >= 12, `expected a test pack of bots, got ${snap1.enemyCount}`);
const uniqueArchetypes = [...new Set(snap1.enemyArchetypes)].sort();
assert.deepEqual(uniqueArchetypes, ['cyclop', 'faceless', 'tessy']);
for (const y of snap1.enemyYs) {
  assert.ok(Number.isFinite(y) && y > -0.2 && y < 0.5, `enemy y ${y}`);
}
assert.equal(snap1.cameraFp, false, 'horde must not force first-person');
assert.equal(snap1.vehicleCount, 0, 'horde skips vehicles');
assert.equal(snap1.hordeGroups, 1, 'exactly one Horde Arena group after boot');

// Reload remounts GameRuntime; must not leave a second arena group.
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(
  () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running',
  { timeout },
);
const snap2 = await collectProbe();
console.log('snap2', {
  stage: snap2.stage,
  grounded: snap2.grounded,
  enemyCount: snap2.enemyCount,
  hordeGroups: snap2.hordeGroups,
});
assert.equal(snap2.stage, 'running');
assert.equal(snap2.grounded, true);
assert.ok(snap2.enemyCount >= 12, `reload enemy count ${snap2.enemyCount}`);
assert.equal(snap2.hordeGroups, 1, 'no duplicate Horde Arena group after re-enter');

if (pageErrors.length) {
  console.warn('pageerrors', pageErrors.slice(0, 5));
}
// WebGPU headless can emit benign warnings; only fail on hard load errors.
const fatal = pageErrors.filter((e) => /failed to start|is not defined|Cannot read/i.test(e));
assert.equal(fatal.length, 0, `fatal page errors: ${fatal.join(' | ')}`);

console.log('PASS: M2 ?level=horde browser contract holds.');
await browser.close();
