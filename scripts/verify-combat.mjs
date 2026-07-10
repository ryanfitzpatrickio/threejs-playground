// Drives the running game via Playwright to verify the combat state machine
// end-to-end through the debug bridge. Covers draw/sheathe + armed locomotion
// (M1), attacks + combo (M2). Hit-casting/cuts (M3) are verified separately.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const appUrl = dreamfallAppUrl();
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
});

const failures = [];

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.status === 'running',
  );

  // Known-benign noise under headless Playwright:
  //  - /favicon.ico 404 (index.html has no icon link)
  //  - pointer-lock DOMException from left-click requestPointerLock (needs a real
  //    user gesture; harmless in real gameplay)
  const isBenign = (text) =>
    /favicon\.ico/i.test(text) ||
    /^Failed to load resource.*404/i.test(text) ||
    /pointer lock/i.test(text);

  const snap = () => page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  const state = () =>
    page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot()?.animation?.state);
  const waitForState = (target, timeout = 4000) =>
    page.waitForFunction(
      (t) => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.state === t,
      target,
      { timeout },
    );
  const canvasCenter = async () => {
    const box = await page.locator('canvas.game-canvas').boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const leftClick = async () => {
    const { x, y } = await canvasCenter();
    await page.mouse.click(x, y, { button: 'left' });
  };
  const rightClick = async () => {
    const { x, y } = await canvasCenter();
    await page.mouse.click(x, y, { button: 'right' });
  };
  const waitForRecovery = async (timeout = 6000) => {
    await page.waitForFunction(
      () => {
        const s = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
        return s?.combat?.attack == null && s?.animation?.state !== 'drawSword';
      },
      { timeout },
    ).catch(() => {});
  };

  // --- M1: draw / sheathe / armed locomotion ---
  let s = await snap();
  assert('starts sheathed', s.combat.weapon === 'sheathed', s.combat.weapon, failures);

  await page.keyboard.press('KeyQ');
  await waitForState('drawSword', 4000).catch(() => {});
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed',
    { timeout: 4000 },
  );
  await waitForState('armedIdle', 4000).catch(() => {});
  s = await snap();
  assert('drawn -> armed idle', s.animation.state === 'armedIdle', s.animation.state, failures);

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(250);
  s = await snap();
  await page.keyboard.up('KeyW');
  assert(
    'armed jog while moving',
    s.animation.state === 'armedJog' || s.animation.state === 'armedSprint',
    s.animation.state,
    failures,
  );
  assert(
    'legs run locomotion base while armed+moving',
    ['jog', 'sprint', 'strafeLeft', 'strafeRight'].includes(s.character.animation.currentState),
    s.character.animation.currentState,
    failures,
  );
  assert(
    'torso runs armed upper layer while armed+moving',
    ['armedJog', 'armedSprint', 'armedStrafeLeft', 'armedStrafeRight'].includes(s.character.animation.upperBodyState),
    String(s.character.animation.upperBodyState),
    failures,
  );

  // --- M2: attacks ---
  await waitForRecovery();
  // Ensure the character is truly still (base == idle) before a standing attack,
  // so the legs follow the attack clip rather than residual locomotion.
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.character?.animation?.currentState === 'idle',
    { timeout: 3000 },
  ).catch(() => {});
  await page.waitForTimeout(150);

  await leftClick();
  await waitForState('lightSlash1', 2000).catch(() => {});
  s = await snap();
  assert('light attack starts lightSlash1', s.animation.state === 'lightSlash1', s.animation.state, failures);
  assert('attack kind light', s.combat.attack?.kind === 'light', s.combat.attack?.kind, failures);
  assert('attack plays on upper-body layer', s.character.animation.upperBodyState === 'lightSlash1', String(s.character.animation.upperBodyState), failures);
  assert('standing-still attack: legs follow attack (base)', s.character.animation.currentState === 'lightSlash1', s.character.animation.currentState, failures);
  assert('movement allowed during attack', s.combat.lockMovement === false, String(s.combat.lockMovement), failures);
  await waitForRecovery();

  await rightClick();
  await waitForState('heavyAttack', 2000).catch(() => {});
  s = await snap();
  assert('heavy attack starts heavyAttack', s.animation.state === 'heavyAttack', s.animation.state, failures);
  assert('attack kind heavy', s.combat.attack?.kind === 'heavy', s.combat.attack?.kind, failures);
  await waitForRecovery();

  // Combo: click during slash1 to buffer, expect the chain to reach slash2.
  await leftClick();
  await page.waitForTimeout(700); // mid-slash1 buffer window
  await leftClick(); // buffered follow-up
  const sawSlash2 = await page
    .waitForFunction(
      () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.state === 'lightSlash2',
      { timeout: 6000 },
    )
    .then(() => true)
    .catch(() => false);
  assert('combo chains lightSlash1 -> lightSlash2', sawSlash2, String(sawSlash2), failures);
  await waitForRecovery(8000);

  // --- M1: sheathe ---
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'sheathed',
    { timeout: 4000 },
  );
  s = await snap();
  assert('sheathed after Q', s.combat.weapon === 'sheathed', s.combat.weapon, failures);

  // --- Draw / sheathe while moving: legs should keep locomotion, torso draws. ---
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(250);
  await page.keyboard.press('KeyQ'); // draw while running
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.character?.animation?.upperBodyState === 'drawSword',
    { timeout: 2000 },
  ).catch(() => {});
  s = await snap();
  assert('draw-while-moving: torso draws', s.character.animation.upperBodyState === 'drawSword', String(s.character.animation.upperBodyState), failures);
  assert('draw-while-moving: legs run locomotion', ['jog', 'sprint'].includes(s.character.animation.currentState), s.character.animation.currentState, failures);
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'armed',
    { timeout: 4000 },
  );
  // sheathe while still moving
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.character?.animation?.upperBodyState === 'sheatheSword',
    { timeout: 2000 },
  ).catch(() => {});
  s = await snap();
  assert('sheathe-while-moving: torso sheathes', s.character.animation.upperBodyState === 'sheatheSword', String(s.character.animation.upperBodyState), failures);
  assert('sheathe-while-moving: legs run locomotion', ['jog', 'sprint'].includes(s.character.animation.currentState), s.character.animation.currentState, failures);
  await page.keyboard.up('KeyW');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.combat?.weapon === 'sheathed',
    { timeout: 4000 },
  );

  const realErrors = consoleErrors.filter((text) => !isBenign(text));
  if (realErrors.length > 0) {
    console.log('--- console errors captured ---');
    for (const err of realErrors.slice(0, 10)) {
      console.log(`  ! ${err}`);
    }
    failures.push(`console errors: ${realErrors.length}`);
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

console.log(failures.length === 0 ? '\nCOMBAT VERIFY: PASS' : `\nCOMBAT VERIFY: FAIL (${failures.length})`);
process.exit(failures.length === 0 ? 0 : 1);
