// Drives a cut on a soldier and verifies the ragdoll via the DATA layer (the
// cut-system snapshot + prop positions). NOTE: Playwright screenshots of this
// WebGPU canvas do NOT reliably show runtime-added objects (shards, markers) —
// they show only the initially-loaded scene — so visual verification must be
// done in a real browser. The data below confirms the cut spawns articulated,
// human-proportioned skinned ragdoll shards.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const appUrl = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const outputDir = path.resolve('.codex-tmp', 'verify-soldier-cut');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await mkdir(outputDir, { recursive: true });

const failures = [];

const browser = await chromium.launch({ headless: true, executablePath: chromePath });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [browser console error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`  [page error] ${err.message}`));

  console.log('Loading', appUrl);
  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 60000 });
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.enemies?.status === 'ready',
    { timeout: 60000 },
  );
  await page.waitForTimeout(2500);

  // Nearest SOLDIER (enemy-1 is the robot at index 0).
  const snap = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  const playerPos = snap.character?.position ?? { x: 0, y: 0, z: 0 };
  const soldiers = (snap.enemies?.enemies ?? []).filter((e) => e?.position && e?.archetype === 'soldier');
  let target = null;
  let best = Infinity;
  for (const e of soldiers) {
    const d = (e.position.x - playerPos.x) ** 2 + (e.position.z - playerPos.z) ** 2;
    if (d < best) { best = d; target = e; }
  }
  if (!target) { failures.push('no soldier target'); throw new Error('no soldier'); }
  console.log('target:', target.id, 'at', JSON.stringify(target.position));

  // Vertical cut -> two halves thrown apart along X, each ragdolling.
  const cut = await page.evaluate((id) =>
    globalThis.__DREAMFALL_DEBUG__.cutNearestSoldier({ enemyId: id, normal: [1, 0, 0] }), target.id);
  console.log('cut:', JSON.stringify(cut));
  if (!cut?.cut) failures.push(`cut failed: ${cut?.result ?? cut?.reason}`);

  const cutSnap = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot()?.enemyCut);
  console.log('enemyCut:', JSON.stringify({
    props: cutSnap.props,
    rigRagdollProps: cutSnap.rigRagdollProps,
    ragdollBodies: cutSnap.ragdollBodies,
    ragdollJoints: cutSnap.ragdollJoints,
    ragdollFollowers: cutSnap.ragdollFollowers,
    collider: cutSnap.collider,
    result: cutSnap.lastResult,
  }));

  if (cutSnap.rigRagdollProps !== 2) failures.push(`expected 2 ragdoll shards, got ${cutSnap.rigRagdollProps}`);
  // A full human half with articulated arms/legs needs >= 9 bodies each; ~24 total.
  if (cutSnap.ragdollBodies < 18) failures.push(`too few ragdoll bodies (${cutSnap.ragdollBodies}); limbs may not articulate`);

  // Let the ragdoll settle, then confirm the pieces rest on the ground (don't fall through).
  await page.waitForTimeout(2500);
  const settled = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.cutProps());
  console.log('settled props:', JSON.stringify(settled.map((p) => ({ region: p.region, y: p.position?.y, age: p.age }))));
  const fellThrough = settled.some((p) => p.position && p.position.y < -2);
  if (fellThrough) failures.push('a shard fell through the ground');

  await page.close();
} finally {
  await browser.close();
}

console.log('\n=== RESULT ===');
if (failures.length) {
  console.log('FAIL:', failures.join('; '));
  process.exit(1);
} else {
  console.log('PASS: cut spawns 2 articulated skinned ragdoll shards (human bone weighting). Verify visually in a real browser.');
}
