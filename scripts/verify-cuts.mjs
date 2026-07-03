// Verifies milestone 3 end-to-end: a sword swing contacts an enemy and (on a
// heavy swing or once health hits zero) bisects it into cut props, removing it.
// Teleports the player next to an enemy via the debug bridge, arms, and attacks.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const appUrl = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
});

const failures = [];
const diagnostics = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', () => {}); // cut pipeline logs verbosely; ignore here

  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');

  const snap = () => page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  const place = (position) =>
    page.evaluate((pos) => globalThis.__DREAMFALL_DEBUG__.placeCharacter({ position: pos }), position);
  const center = async () => {
    const box = await page.locator('canvas.game-canvas').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  let s = await snap();
  const before = s.enemies.count;
  assert('enemies present', before > 0, String(before), failures);

  // Pick an enemy and teleport the player right next to it.
  const enemy = s.enemies.enemies[0];
  await place({ x: enemy.position.x + 1.0, y: enemy.position.y, z: enemy.position.z + 1.0 });
  await page.waitForTimeout(300);

  // Arm.
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed',
    { timeout: 4000 },
  );
  await page.waitForTimeout(400); // let enemies close in / surround

  const { x: cx, y: cy } = await center();
  const swingHeavy = async () => {
    await page.mouse.click(cx, cy, { button: 'right' });
    await page.waitForTimeout(2200); // heavy clip ~1.9s + margin
  };
  const swingLight = async () => {
    await page.mouse.click(cx, cy, { button: 'left' });
    await page.waitForTimeout(1400);
  };

  // Record nearestDist/tipY observed during swings (diagnoses sword placement).
  const sampleAttack = async () => {
    await page.waitForTimeout(50);
    const cur = await snap();
    if (cur.combat.attack) {
      diagnostics.push({
        name: cur.combat.attack.name,
        nearestDist: cur.combat.attack.nearestDist,
        tipY: cur.combat.attack.tipY,
      });
    }
  };

  // Heavy swings cut on contact — try a few and watch the enemy count drop.
  for (let i = 0; i < 3 && (await snap()).enemies.count === before; i += 1) {
    await swingHeavy();
    await sampleAttack();
  }
  for (let i = 0; i < 6 && (await snap()).enemies.count === before; i += 1) {
    await swingLight();
    await sampleAttack();
  }

  const after = (await snap()).enemies.count;
  assert('an enemy was cut/removed', after < before, `${before} -> ${after}`, failures);

  if (diagnostics.length) {
    console.log('--- swing diagnostics (nearestDist / tipY) ---');
    for (const d of diagnostics.slice(0, 6)) {
      console.log(`  ${d.name}: nearest=${d.nearestDist} tipY=${d.tipY}`);
    }
  }
} finally {
  await browser.close();
}

function assert(label, ok, got, failList) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label} (got: ${got})`);
    failList.push(label);
  }
}

console.log(failures.length === 0 ? '\nCUT VERIFY: PASS' : `\nCUT VERIFY: FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
