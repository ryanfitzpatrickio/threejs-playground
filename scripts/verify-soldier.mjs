import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const appUrl = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const outputDir = path.resolve('.codex-tmp', 'verify-soldier');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
});

const failures = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [browser console error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`));

  console.log('Loading', appUrl);
  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 60000 });

  // Enemy system ready
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.enemies?.status === 'ready',
    { timeout: 60000 },
  ).catch(() => failures.push('enemy status never became ready'));

  const snap = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  const enemies = snap.enemies ?? {};
  console.log('\n=== ENEMY SYSTEM ===');
  console.log('  status:', enemies.status, '| count:', enemies.count);
  console.log('  clips:', JSON.stringify(enemies.clips));

  const expected = [
    'Idle', 'Walk', 'Run', 'Idle Alert', 'Bite',
    'Head Missing', 'Head Missing 2',
    'Left Arm Missing Walk', 'Right Arm Missing Walk',
    'Left Leg Missing', 'Right Leg Missing',
    'Crawl Forward', 'Crawl Back',
  ];
  const haveAllClips = expected.every((n) => (enemies.clips ?? []).includes(n));
  console.log('  all 5 soldier clips present:', haveAllClips);
  if (!haveAllClips) failures.push('missing soldier clips');

  if (enemies.count !== 15) failures.push(`expected 15 enemies, got ${enemies.count}`);

  // Let it run a few seconds so enemies patrol/chase and animate.
  await page.waitForTimeout(4000);

  const snap2 = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  const liveEnemies = snap2.enemies?.enemies ?? [];
  const animStates = liveEnemies.map((e) => `${e.state}:${e.animation}`).filter(Boolean);
  const stateCounts = {};
  for (const s of animStates) stateCounts[s] = (stateCounts[s] ?? 0) + 1;
  console.log('\n=== LIVE ENEMY STATES (after 4s) ===');
  console.log(' ', JSON.stringify(stateCounts));

  // Screenshot the scene.
  const shot = await page.screenshot({ fullPage: false });
  const shotPath = path.join(outputDir, 'soldier-scene.png');
  await writeFile(shotPath, shot);
  console.log('\n  screenshot:', shotPath);

  await page.close();
} finally {
  await browser.close();
}

console.log('\n=== RESULT ===');
if (failures.length) {
  console.log('FAIL:', failures.join('; '));
  process.exit(1);
} else {
  console.log('PASS: soldier enemies load + animate. Inspect screenshot to confirm rendering.');
}
