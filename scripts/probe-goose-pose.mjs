#!/usr/bin/env node
/**
 * probe-goose-pose — verify the goose body is UPRIGHT after the delta-retarget
 * fix. Dumps world positions of the silhouette landmarks: head/bill high, tail
 * mid-low, feet at ground. If head.y >> tail.y >> feet.y≈0, the goose stands.
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const url = dreamfallAppUrl({ view: 'dog-sim', harness: '1', autostart: null });
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const LANDMARKS = [
  'head', 'mouth_upper_tip', 'mouth_lower_tip',      // bill (highest, +Z front)
  'spine_3', 'spine_0', 'hips',                       // body axis
  'tail_1', 'tail_tip',                               // tail (rear, low)
  'Foot_L', 'Toes_tip_L', 'Foot_R', 'Toes_tip_R',    // feet (ground)
  'wing_1_L', 'wing_tip_L',
];

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (err) => console.error('PAGEERROR:', err.message));
page.on('console', (msg) => { if (msg.type() === 'error') console.error('CONSOLE:', msg.text().slice(0, 300)); });

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => globalThis.__DOG_SIM_DEBUG__?.status === 'ready' || globalThis.__DOG_SIM_DEBUG__?.status === 'failed',
    { timeout: 60000 },
  );
  if ((await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__?.status)) !== 'ready') throw new Error('not ready');

  await page.evaluate(async () => { await globalThis.__DOG_SIM_DEBUG__.setBreed('canada-goose'); });
  await page.waitForFunction(() => globalThis.__DOG_SIM_DEBUG__?.snapshot?.breedId === 'canada-goose', { timeout: 30000 });
  await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__.setNakedBody(true));

  const dump = async (label) => {
    const rows = await page.evaluate((names) => {
      const api = globalThis.__DOG_SIM_DEBUG__;
      const out = {};
      for (const n of names) out[n] = api.getBoneWorldPosition(n);
      return out;
    }, LANDMARKS);
    console.log(`\n=== ${label} (world x, y, z) ===`);
    for (const n of LANDMARKS) {
      const p = rows[n];
      console.log(`  ${n.padEnd(18)} ${p ? `[${p[0].toFixed(4)}, ${p[1].toFixed(4)}, ${p[2].toFixed(4)}]` : '(missing)'}`);
    }
  };

  await dump('at build (idle sampled)');
  await page.evaluate(() => {
    globalThis.__DOG_SIM_DEBUG__.setBehavior('walk');
    globalThis.__DOG_SIM_DEBUG__.settle(1.0);
    return globalThis.__DOG_SIM_DEBUG__.renderOnce();
  });
  await dump('after walk + settle(1.0)');
} finally {
  await browser.close();
}
