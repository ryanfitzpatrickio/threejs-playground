#!/usr/bin/env node
/**
 * Capture reference stills of sim outfits at **default body size** (all morphs 0).
 *
 * Output (git-friendly source refs for AI cloth gen + skinning):
 *   assets-source/simoutfits/reference/
 *     male-peasant-front.png
 *     male-peasant-threequarter.png
 *     ...
 *     README.md
 *
 * Requires: npm run dev
 * Run:      node scripts/screenshot-sim-outfits-reference.mjs
 *
 * Optional:
 *   DREAMFALL_URL=http://127.0.0.1:5173
 *   OUTFIT_REF_OUT=assets-source/simoutfits/reference
 *   OUTFIT_REF_OUTFIT_ONLY=1   # hide body mesh, clothing only
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = path.resolve(
  process.env.OUTFIT_REF_OUT ?? 'assets-source/simoutfits/reference',
);
const outfitOnly = process.env.OUTFIT_REF_OUTFIT_ONLY === '1'
  || process.argv.includes('--outfit-only');
const timeout = Number(process.env.SIMHUMAN_TIMEOUT_MS ?? 120_000);

const SHOTS = [
  { body: 'male', outfitId: 'fantasy-peasant', label: 'male-peasant' },
  { body: 'male', outfitId: 'fantasy-ranger', label: 'male-ranger' },
  { body: 'female', outfitId: 'fantasy-peasant', label: 'female-peasant' },
  { body: 'female', outfitId: 'fantasy-ranger', label: 'female-ranger' },
];

const ANGLES = [
  { id: 'front', label: 'front' },
  { id: 'threequarter', label: 'threequarter' },
  { id: 'side', label: 'side' },
  { id: 'back', label: 'back' },
  { id: 'threequarter-back', label: 'threequarter-back' },
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan'],
});

const page = await browser.newPage({
  viewport: { width: 1280, height: 1600 },
  deviceScaleFactor: 2,
});

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));

try {
  // Neutral floor-friendly background via simhuman viewer.
  const url = dreamfallAppUrl({
    view: 'simhuman',
    simBody: 'male',
    simMaterials: 'source',
    autostart: '1',
  });
  console.log('[outfit-ref] goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await page.waitForFunction(
    () => ['ready', 'failed'].includes(globalThis.__SIMHUMAN_DEBUG__?.status),
    { timeout },
  );

  const boot = await page.evaluate(() => ({
    status: globalThis.__SIMHUMAN_DEBUG__?.status,
    error: globalThis.__SIMHUMAN_DEBUG__?.error,
  }));
  if (boot.status !== 'ready') {
    throw new Error(`simhuman viewer failed: ${boot.status} ${boot.error ?? ''}`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    defaultBodySize: true,
    morphs: 'all zero (neutral)',
    outfitVariant: 'morph',
    outfitOnly,
    skeleton: 'UBC → DEF-* (65 joints)',
    angles: ANGLES.map((a) => a.label),
    shots: [],
  };

  for (const shot of SHOTS) {
    console.log(`\n[outfit-ref] === ${shot.label} ===`);
    await page.evaluate(async ({ body, outfitId, outfitOnly: hideBody }) => {
      const dbg = globalThis.__SIMHUMAN_DEBUG__;
      // Neutral default body — no mass/muscle/fat, identity outfit scale.
      await dbg.setBody(body);
      // Wait for ready after body swap.
      const start = performance.now();
      while (dbg.status !== 'ready' && performance.now() - start < 60000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (dbg.status !== 'ready') throw new Error(`body load ${body}: ${dbg.status} ${dbg.error}`);

      dbg.resetControls();
      dbg.setAppearance({
        body,
        morphs: {},
        facs: {},
        outfitId,
        outfitVariant: 'morph',
        outfitScale: { x: 1, y: 1, z: 1 },
        garmentIds: [],
      });
      await dbg.setOutfit(outfitId);
      await dbg.setOutfitVariant?.('morph');
      dbg.setAnimation('idle');
      dbg.setBodyVisible(!hideBody);
      dbg.setCameraAngle('front');
    }, { body: shot.body, outfitId: shot.outfitId, outfitOnly });

    // Settle a few frames after outfit attach / body hide.
    await page.waitForTimeout(800);

    const outfitSnap = await page.evaluate(() => globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.());
    if (!outfitSnap?.id) {
      console.warn(`[outfit-ref] WARNING: no outfit snapshot for ${shot.label}`, outfitSnap);
    }

    for (const angle of ANGLES) {
      await page.evaluate((angleId) => {
        globalThis.__SIMHUMAN_DEBUG__.setCameraAngle(angleId, {
          distance: 2.55,
          height: 1.08,
          lookAtY: 0.92,
        });
      }, angle.id);
      await page.waitForTimeout(200);

      const file = `${shot.label}-${angle.label}.png`;
      const filePath = path.join(outDir, file);
      // Full page can include UI chrome; clip to canvas if present.
      const canvas = page.locator('canvas').first();
      if (await canvas.count()) {
        await canvas.screenshot({ path: filePath, type: 'png' });
      } else {
        await page.screenshot({ path: filePath, type: 'png' });
      }
      console.log(`[outfit-ref] wrote ${file}`);
      manifest.shots.push({
        file,
        body: shot.body,
        outfitId: shot.outfitId,
        angle: angle.label,
        outfit: outfitSnap ?? null,
      });
    }
  }

  const readme = `# Sim outfit reference plates

Neutral **default body size** (all modeling morphs at 0) reference stills for:

- fantasy-peasant (male / female)
- fantasy-ranger (male / female)

Generated: ${manifest.generatedAt}
Outfit-only body hide: ${outfitOnly ? 'yes' : 'no (body + outfit)'}

## Angles

- \`front\` — camera +Z
- \`threequarter\` — ~50°
- \`side\` — profile
- \`back\`
- \`threequarter-back\`

## Intended use

1. Use these plates as **style / silhouette / proportion** reference for 3D gen AI clothes.
2. Target the **UBC skeleton** (65 joints, DEF-* after prepare — same as current outfits).
3. Author at the same bind height as prepared UBC (~3.49 raw → 1.75 m runtime).
4. After import, run:

\`\`\`sh
# normalize / keep materials (see prepare-sim-outfits.mjs)
# then bake selective bulk morphs + dual variants:
npm run bake:outfit-morphs
npm run verify:sim-outfits
\`\`\`

## Skeleton contract

Joints follow prepared UBC → Rigify DEF mapping (\`simOutfitBoneMap.js\`):

- pelvis → DEF-spine … head → DEF-spine.006
- arms: clavicle / upperarm / lowerarm / hand + fingers
- legs: thigh / calf / foot / ball

Keep mesh pieces skinned to those bones. Prefer one outfit root with separate
meshes per layer (body / arms / legs / boots / acc) matching the Quaternius layout.

## Files

${manifest.shots.map((s) => `- \`${s.file}\``).join('\n')}
`;

  await writeFile(path.join(outDir, 'README.md'), readme);
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n[outfit-ref] done → ${outDir}`);
  console.log(`[outfit-ref] ${manifest.shots.length} images + README.md + manifest.json`);
  if (pageErrors.length) {
    console.warn('[outfit-ref] page errors:', pageErrors.slice(0, 5));
  }
} finally {
  await browser.close();
}
