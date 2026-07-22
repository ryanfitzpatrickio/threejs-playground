#!/usr/bin/env node
/**
 * probe-cat — deterministic screenshots of the bespoke procedural cat ("3cat")
 * in the dog studio harness, for look-dev + to surface WebGPU/TSL shader
 * compile errors that only appear on a real GPU (not headless node).
 *
 * Usage:
 *   node scripts/probe-cat.mjs [presetId ...] [--naked] [--behavior=walk]
 *       [--breed=tortoiseshell-procedural]
 *
 * Only cat-rig catalog entries (default: tortoiseshell-procedural) build the
 * bespoke procedural cat in the harness; other feline ids render the
 * dog-derived stubs.
 *
 * Requires the dev server (default http://127.0.0.1:5173/). PNGs → .codex-tmp/cat/.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const args = process.argv.slice(2);
const naked = args.includes('--naked');
const compare = args.includes('--compare');   // side-by-side render-vs-photo
const live = args.includes('--live');         // live-motion pass across clips
const behavior = args.find((a) => a.startsWith('--behavior='))?.slice('--behavior='.length);
const breed = args.find((a) => a.startsWith('--breed='))?.slice('--breed='.length) ?? 'tortoiseshell-procedural';
const presets = args.filter((a) => !a.startsWith('--'));
if (presets.length === 0) presets.push('profile', 'front-sit', 'head-close', 'three-quarter');

const url = dreamfallAppUrl({ view: 'dog-sim', harness: '1', autostart: null });
const outDir = path.resolve('.codex-tmp', 'cat');
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
let errorCount = 0;
page.on('pageerror', (err) => { errorCount += 1; console.error('PAGEERROR:', err.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') { errorCount += 1; console.error('CONSOLE:', msg.text().slice(0, 400)); }
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

  await page.evaluate(async (b) => {
    await globalThis.__DOG_SIM_DEBUG__.setBreed(b);
  }, breed);
  await page.waitForFunction(
    (b) => globalThis.__DOG_SIM_DEBUG__?.snapshot?.breedId === b,
    breed, { timeout: 30000 },
  );
  const snap = await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__?.snapshot);
  console.log('cat snapshot:', JSON.stringify({
    breedId: snap.breedId, speciesId: snap.speciesId, bones: snap.bones,
    verts: snap.verts, shells: snap.shells, behavior: snap.behavior,
  }));

  if (naked) await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__.setNakedBody(true));
  if (behavior) await page.evaluate((b) => globalThis.__DOG_SIM_DEBUG__.setBehavior(b), behavior);

  // Harness: render-vs-photo compare pane wires to the cat-ref boards.
  if (compare) {
    const refInfo = await page.evaluate(() => {
      const api = globalThis.__DOG_SIM_DEBUG__;
      api.setCompareEnabled(true);
      const s = api.snapshot;
      return { compareEnabled: s.compareEnabled, refChain: s.referenceImageChain, refImage: s.referenceImage };
    });
    console.log('compare pane:', JSON.stringify(refInfo));
  }

  // Harness: live-motion pass — run through the procedural clip catalog.
  if (live) {
    const clips = await page.evaluate(() => {
      const api = globalThis.__DOG_SIM_DEBUG__;
      api.setLiveMotion(true);
      return (api.snapshot.animationClips?.available) ?? [];
    });
    console.log('live-motion clips:', JSON.stringify(clips));
    for (const clip of ['Walk', 'Stalk', 'Pounce', 'Play', 'Knead', 'Groom']) {
      if (!clips.includes(clip)) continue;
      await page.evaluate(async (c) => {
        const api = globalThis.__DOG_SIM_DEBUG__;
        api.setClip(c);
        api.settle(0.6);
        return api.renderOnce();
      }, clip);
      await page.waitForTimeout(150);
      const canvas = await page.$('canvas');
      const file = path.join(outDir, `cat-${breed}-live-${clip.toLowerCase()}.png`);
      if (canvas) await canvas.screenshot({ path: file });
      console.log('wrote', file);
    }
  }

  for (const preset of presets) {
    await page.evaluate(async (id) => {
      const api = globalThis.__DOG_SIM_DEBUG__;
      api.applyPreset(id);
      api.settle(1.0);
      return api.renderOnce();
    }, preset);
    await page.waitForTimeout(300);
    const canvas = await page.$('canvas');
    const file = path.join(outDir, `cat-${breed}-${preset}${naked ? '-naked' : ''}${behavior ? `-${behavior}` : ''}.png`);
    if (canvas) await canvas.screenshot({ path: file });
    else await page.screenshot({ path: file });
    console.log('wrote', file);
  }

  console.log(errorCount === 0 ? 'NO PAGE ERRORS ✓' : `PAGE ERRORS: ${errorCount} ✗`);
} finally {
  await browser.close();
}
