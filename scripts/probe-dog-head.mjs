#!/usr/bin/env node
/**
 * probe-dog-head — deterministic screenshots of the procedural dog for look iteration.
 *
 * Usage:
 *   node scripts/probe-dog-head.mjs [presetId ...] [--out name]
 *
 * Defaults to the head-close preset. Requires the dev server
 * (DREAMFALL_URL, default http://127.0.0.1:5173/) and writes PNGs to
 * .codex-tmp/dog-head/.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import { AUTHORED_DOG_BREED_IDS, normalizeDogVariantId } from '../src/game/characters/dog/dogCatalog.js';

const args = process.argv.slice(2);
const allBreeds = args.includes('--all-breeds');
const mobile = args.includes('--mobile');
const withUi = args.includes('--with-ui');
const requestedBreed = args.find((arg) => arg.startsWith('--breed='))?.slice('--breed='.length);
const requestedBreeds = args.find((arg) => arg.startsWith('--breeds='))
  ?.slice('--breeds='.length)
  .split(',')
  .filter((id) => AUTHORED_DOG_BREED_IDS.includes(id));
// Unknown/omitted variant falls back to the breed's authored default (no throw).
const requestedVariant = args.find((arg) => arg.startsWith('--variant='))?.slice('--variant='.length);
const presets = args.filter((a) => !a.startsWith('--'));
if (presets.length === 0) presets.push('head-close');
if (allBreeds && presets.length === 1 && presets[0] === 'head-close') {
  presets.splice(0, 1, 'three-quarter', 'profile', 'front-sit', 'head-close');
}
const breedIds = requestedBreeds?.length
  ? requestedBreeds
  : allBreeds
    ? AUTHORED_DOG_BREED_IDS
    : [requestedBreed && AUTHORED_DOG_BREED_IDS.includes(requestedBreed) ? requestedBreed : 'golden-retriever'];

const url = dreamfallAppUrl({ view: 'dog-sim', harness: '1', autostart: null });
const outDir = path.resolve('.codex-tmp', 'dog-head');
await mkdir(outDir, { recursive: true });

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});

const page = await browser.newPage({
  viewport: mobile ? { width: 390, height: 844 } : { width: 900, height: 900 },
  deviceScaleFactor: 2,
});
page.on('pageerror', (err) => console.error('PAGEERROR:', err.message));

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
  if (!withUi) {
    await page.addStyleTag({ content: `
      .dog-sim-panel,
      .dog-sim-compare,
      .top-bar-switchers,
      .settings-floating,
      .help-floating { display: none !important; }
    ` });
  }

  for (const breedId of breedIds) {
    await page.evaluate((id) => globalThis.__DOG_SIM_DEBUG__.setBreed(id), breedId);
    await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__.setSeed(1));
    const variantId = requestedVariant ? normalizeDogVariantId(breedId, requestedVariant) : null;
    if (variantId) await page.evaluate((id) => globalThis.__DOG_SIM_DEBUG__.setVariant(id), variantId);
    for (const preset of presets) {
      await page.evaluate((id) => {
        const api = globalThis.__DOG_SIM_DEBUG__;
        if (id === 'rear-head') {
          api.setBehavior('look');
          api.settle(1.0);
          const head = api.getBoneWorldPosition('Head');
          const traits = api.getResolvedTraits();
          const extent = 0.24 * traits.skeleton.headSize * traits.skeleton.scale;
          const distance = extent * 3.25;
          api.setCamera(
            [head[0] + distance * 0.24, head[1] + distance * 0.12, head[2] - distance],
            head,
          );
        } else {
          api.applyPreset(id);
          api.settle(1.0);
        }
        return api.renderOnce();
      }, preset);
      await page.waitForTimeout(250);
      const snapshot = await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__.snapshot);
      if (snapshot.breedId !== breedId || snapshot.seed !== 1) {
        throw new Error(`debug selection mismatch: ${snapshot.breedId} seed=${snapshot.seed}`);
      }
      const canvas = await page.$('canvas');
      const suffix = mobile ? '-mobile' : '';
      // Filename reflects what actually rendered, not the raw --variant= arg
      // (an unknown id silently resolves to the breed's default, no throw).
      const variantSuffix = snapshot.variantId && snapshot.variantId !== 'default' ? `-${snapshot.variantId}` : '';
      const file = path.join(outDir, `${breedId}${variantSuffix}-${preset}${suffix}.png`);
      if (canvas) await canvas.screenshot({ path: file });
      else await page.screenshot({ path: file });
      console.log('wrote', file);
    }
  }

  // Optional free cameras: --cam px,py,pz,tx,ty,tz,name (repeatable)
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
    const file = path.join(outDir, `${name}.png`);
    if (canvas) await canvas.screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log('wrote', file);
  }
} finally {
  await browser.close();
}
