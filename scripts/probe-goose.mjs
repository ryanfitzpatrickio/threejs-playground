#!/usr/bin/env node
/**
 * probe-goose — deterministic screenshots of the bespoke procedural Canada
 * goose (dog studio harness) for photo-match iteration.
 *
 * Usage:
 *   node scripts/probe-goose.mjs [presetId ...] [--naked] [--behavior=walk]
 *       [--cam=px,py,pz,tx,ty,tz,name]
 *
 * Defaults to profile + front-sit + head-close + three-quarter. Requires the
 * dev server (default http://127.0.0.1:5173/). PNGs → .codex-tmp/goose/.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const args = process.argv.slice(2);
const naked = args.includes('--naked');
const behavior = args.find((a) => a.startsWith('--behavior='))?.slice('--behavior='.length);
const presets = args.filter((a) => !a.startsWith('--'));
if (presets.length === 0) presets.push('profile', 'front-sit', 'head-close', 'three-quarter');

const url = dreamfallAppUrl({ view: 'dog-sim', harness: '1', autostart: null });
const outDir = path.resolve('.codex-tmp', 'goose');
await mkdir(outDir, { recursive: true });

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});

const page = await browser.newPage({
  viewport: { width: 900, height: 900 },
  deviceScaleFactor: 2,
});
page.on('pageerror', (err) => console.error('PAGEERROR:', err.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('CONSOLE:', msg.text().slice(0, 400));
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => globalThis.__DOG_SIM_DEBUG__?.status === 'ready'
      || globalThis.__DOG_SIM_DEBUG__?.status === 'failed',
    { timeout: 60000 },
  );
  const status = await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__?.status);
  if (status !== 'ready') {
    const err = await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__?.snapshot?.error);
    throw new Error(`dog sim status=${status} error=${err}`);
  }
  await page.addStyleTag({ content: `
    .dog-sim-panel, .dog-sim-compare, .top-bar-switchers,
    .settings-floating, .help-floating { display: none !important; }
  ` });

  await page.evaluate(async () => {
    await globalThis.__DOG_SIM_DEBUG__.setBreed('canada-goose');
  });
  // Rebuild is async — wait until the snapshot reflects the goose.
  await page.waitForFunction(
    () => globalThis.__DOG_SIM_DEBUG__?.snapshot?.breedId === 'canada-goose',
    { timeout: 30000 },
  );
  if (naked) await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__.setNakedBody(true));
  if (behavior) await page.evaluate((b) => globalThis.__DOG_SIM_DEBUG__.setBehavior(b), behavior);

  for (const preset of presets) {
    await page.evaluate(async (id) => {
      const api = globalThis.__DOG_SIM_DEBUG__;
      api.applyPreset(id);
      api.settle(1.0);
      return api.renderOnce();
    }, preset);
    await page.waitForTimeout(300);
    const canvas = await page.$('canvas');
    const file = path.join(outDir, `goose-${preset}${naked ? '-naked' : ''}${behavior ? `-${behavior}` : ''}.png`);
    if (canvas) await canvas.screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log('wrote', file);
  }

  const cams = args.filter((a) => a.startsWith('--cam=')).map((a) => a.slice(6).split(','));
  for (const cam of cams) {
    const [px, py, pz, tx, ty, tz] = cam.slice(0, 6).map(Number);
    const name = cam[6] ?? `cam-${px}-${py}-${pz}`;
    await page.evaluate(([pos, tgt]) => {
      const api = globalThis.__DOG_SIM_DEBUG__;
      api.setCamera(pos, tgt);
      api.settle(0.2);
      return api.renderOnce();
    }, [[px, py, pz], [tx, ty, tz]]);
    await page.waitForTimeout(250);
    const canvas = await page.$('canvas');
    const file = path.join(outDir, `goose-${name}${naked ? '-naked' : ''}.png`);
    if (canvas) await canvas.screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log('wrote', file);
  }
} finally {
  await browser.close();
}
