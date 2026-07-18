// Browser regression for OutfitImportSession's GLB handoff.
// Uploads a real textured glTF outfit, intercepts the payload immediately
// before Blender, and verifies that UV orientation and material slots survive.
// Requires a running Vite dev server (`npm run dev`).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import { validateBindSpaceConversion } from '../src/game/characters/simhuman/outfitImportSession.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'public/assets/simoutfits/standard/male-peasant.glb');
const PROMOTED_MANIFEST = path.join(ROOT, 'public/assets/simoutfits/manifest.json');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

// A partial garment is allowed to be much shorter than the full 3.49-unit UBC
// body. Validation must check the runtime→bind ratio, not absolute cloth height.
const partial = validateBindSpaceConversion({
  previewHeight: 0.87,
  bindHeight: 1.74,
  bodyWorldScaleY: 0.5,
});
assert.equal(partial.observedScale, 2, 'partial garment accepts correct bind-space expansion');
assert.throws(
  () => validateBindSpaceConversion({
    previewHeight: 0.87,
    bindHeight: 0.87,
    bodyWorldScaleY: 0.5,
  }),
  /expected 2\.00x/,
  'unconverted half-scale garment is rejected',
);

function collectUvKeys(doc) {
  const keys = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uv = prim.getAttribute('TEXCOORD_0');
      if (!uv) continue;
      const value = [0, 0];
      for (let i = 0; i < uv.getCount(); i += 1) {
        uv.getElement(i, value);
        keys.push(`${value[0].toFixed(5)},${value[1].toFixed(5)}`);
      }
    }
  }
  return keys.sort();
}

const sourceDoc = await io.read(SOURCE);
const sourceUvs = collectUvKeys(sourceDoc);
const sourceMaterials = sourceDoc.getRoot().listMaterials().length;
assert.ok(sourceUvs.length > 100, 'source fixture has UVs');
const promotedEntries = JSON.parse(readFileSync(PROMOTED_MANIFEST, 'utf8')).entries ?? [];

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  let resolvePayload;
  const payloadPromise = new Promise((resolve) => { resolvePayload = resolve; });
  await page.route('**/__editor/outfit/prepare', async (route) => {
    resolvePayload(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        id: 'texture-verify',
        urls: { standard: '/assets/simoutfits/standard/male-peasant.glb' },
        bytes: { standard: 1 },
        manifestEntry: { id: 'texture-verify', name: 'Texture Verify' },
      }),
    });
  });

  await page.goto(dreamfallAppUrl({ view: 'sim-creator' }), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.status === 'ready',
    { timeout: 90_000 },
  );
  await page.getByRole('button', { name: 'Male body', exact: true }).click();
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.owner?.snapshot?.().body === 'male',
    { timeout: 90_000 },
  );
  await page.getByRole('button', { name: 'Garments', exact: true }).click();
  for (const entry of promotedEntries) {
    const promotedCard = page.getByRole('button', { name: `${entry.name} outfit`, exact: true });
    await promotedCard.waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await promotedCard.count(), 1, `promoted outfit appears in catalog: ${entry.name}`);
  }
  const promotedMale = promotedEntries.find((entry) => entry.bodies?.male);
  if (promotedMale) {
    await page.getByRole('button', { name: `${promotedMale.name} outfit`, exact: true }).click();
    await page.waitForFunction(
      (id) => globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.id === id,
      promotedMale.id,
      { timeout: 90_000 },
    );
  }
  // The original human5 mesh is a first-class third outfit donor, not a
  // disabled fallback that silently routes to the male UBC bake.
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Base body', exact: true }).click();
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.owner?.snapshot?.().body === 'human5',
    { timeout: 90_000 },
  );
  await page.getByRole('button', { name: 'Garments', exact: true }).click();
  await page.getByRole('tab', { name: 'Import', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(SOURCE);
  await page.getByText('male-peasant.glb', { exact: false }).first().waitFor({ timeout: 90_000 });
  await page.getByText('Bake at rest pose', { exact: false }).locator('..').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Apply weights', exact: true }).click();

  const payload = await Promise.race([
    payloadPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for bake payload')), 90_000)),
  ]);
  assert.ok(payload?.clothGlbBase64, 'browser emitted cloth GLB payload');
  assert.equal(payload?.body, 'human5', 'base import explicitly selects the human5 donor pipeline');
  assert.ok(payload?.options?.expectedBindHeight > 0, 'request includes garment-specific bind height');
  assert.ok(payload?.options?.expectedBindScale > 1.25, 'request includes runtime-to-bind scale');
  assert.ok(
    payload?.options?.bodyWorldScaleY > 0.25 && payload.options.bodyWorldScaleY < 0.75,
    'request includes normalized base-body scale',
  );
  const exportedDoc = await io.readBinary(new Uint8Array(Buffer.from(payload.clothGlbBase64, 'base64')));
  const exportedUvs = collectUvKeys(exportedDoc);

  assert.deepEqual(exportedUvs, sourceUvs, 'browser handoff preserves GLB UV coordinates and orientation');
  assert.equal(
    exportedDoc.getRoot().listMaterials().length,
    sourceMaterials,
    'browser handoff preserves material slot count',
  );
  assert.ok(
    exportedDoc.getRoot().listMaterials().every((material) => material.getBaseColorTexture()),
    'every textured source material remains textured',
  );
  console.log(
    `verify-outfit-import-texture: ${exportedUvs.length} UVs, `
    + `${sourceMaterials} material(s), ${promotedEntries.length} promoted outfit(s), `
    + 'orientation/catalog preserved OK',
  );
} finally {
  await browser.close();
}
