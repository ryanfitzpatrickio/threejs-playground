#!/usr/bin/env node
/**
 * Browser integration regression for the shared gun locomotion path. Verifies
 * that a drawn rifle keeps the body/head visible in third person and selects
 * hip run, sprint, and ADS 8-way states from actual input.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(dreamfallAppUrl(), { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');

  await page.evaluate(() => {
    const runtime = globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__;
    runtime.setOnFootFirstPersonEnabled(false);
    runtime.equipWeapon('modern-ar15', { draw: true });
  });
  await page.waitForFunction(() => {
    const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
    return snapshot?.weapon?.equippedId === 'modern-ar15'
      && snapshot?.firstPersonWeapon?.equippedGunId === 'modern-ar15'
      && snapshot?.firstPersonWeapon?.weaponVisible === true
      && snapshot?.camera?.onFootFirstPerson === false;
  });

  await page.keyboard.down('KeyW');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.state === 'rifle_run_fwd',
  );
  await page.keyboard.up('KeyW');

  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.state === 'rifle_sprint_fwd',
  );
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');

  await page.mouse.down({ button: 'right' });
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.state === 'rifle_walk_fwd_right',
  );
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyW');
  await page.mouse.up({ button: 'right' });

  const snapshot = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot());
  assert.equal(snapshot.firstPersonWeapon.headHidden, false, 'third-person head must stay visible');
  assert.equal(snapshot.firstPersonWeapon.active, true, 'gun hold must stay active in third person');
  console.log('verify-third-person-weapon-locomotion: rifle hip, sprint, and ADS states passed');
} finally {
  await browser.close();
}
