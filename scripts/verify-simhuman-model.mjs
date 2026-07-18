// Browser M1 gate: ?view=simhuman loads the vendored vibe-human character
// under the real WebGPU renderer — TSL skin/eye materials compile, the
// Rigify skeleton and morph meshes are present, MODELING_CONTROLS sliders
// drive morphTargetInfluences, and no page/WebGPU errors surface.
//
// (BBox checks can't see morph deformation — morphs displace on the GPU;
// geometry.boundingBox stays at rest. Influence sums + error-free rendering
// are the headless proxies; visual confirmation is the viewer itself.)
//
// Requires dev server: npm run dev
// Run: node scripts/verify-simhuman-model.mjs
// Alias: npm run verify:simhuman-model

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout = Number(process.env.SIMHUMAN_TIMEOUT_MS ?? 90_000);

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const url = dreamfallAppUrl({ view: 'simhuman' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await page.waitForFunction(
    () => ['ready', 'failed'].includes(globalThis.__SIMHUMAN_DEBUG__?.status),
    { timeout },
  );

  const probe = await page.evaluate(() => {
    const dbg = globalThis.__SIMHUMAN_DEBUG__;
    const baselineSum = dbg.getMorphInfluenceSum();
    dbg.setControl('id.body.global.mass', 1);
    dbg.setControl('id.skull.browRidge.depth', -0.8);
    const activeSum = dbg.getMorphInfluenceSum();
    dbg.resetControls();
    const resetSum = dbg.getMorphInfluenceSum();
    dbg.setAnimation('walk');
    return {
      status: dbg.status,
      error: dbg.error,
      morphMeshes: dbg.morphMeshes,
      morphCount: dbg.morphCount,
      bones: dbg.bones,
      verts: dbg.verts,
      controls: dbg.controls,
      bboxHeight: dbg.getBBoxHeight(),
      baselineSum,
      activeSum,
      resetSum,
      animationState: dbg.getAnimationState(),
      animationTime: dbg.getAnimationTime(),
    };
  });

  assert.equal(probe.status, 'ready', `viewer status: ${probe.status} (${probe.error ?? 'no error'})`);
  assert.ok(probe.morphMeshes >= 3, `expected >=3 morph meshes, got ${probe.morphMeshes}`);
  assert.ok(probe.morphCount >= 400, `expected >=400 total dictionary entries, got ${probe.morphCount}`);
  assert.ok(probe.bones >= 163, `expected >=163 bones, got ${probe.bones}`);
  assert.ok(probe.controls >= 80, `expected >=80 modeling controls, got ${probe.controls}`);
  assert.ok(
    Math.abs(probe.bboxHeight - 1.75) < 0.15,
    `expected ~1.75m tall, got ${probe.bboxHeight.toFixed(3)}`,
  );
  assert.equal(probe.baselineSum, 0, `baseline morph influence should be 0, got ${probe.baselineSum}`);
  assert.ok(probe.activeSum > 0.5, `sliders should raise influences, got ${probe.activeSum}`);
  assert.equal(probe.resetSum, 0, `reset should zero influences, got ${probe.resetSum}`);
  assert.equal(probe.animationState, 'walk', 'Rigify walk clip should be selectable');

  // Give the renderer a couple frames post-morph to surface pipeline errors.
  await page.waitForTimeout(1_500);
  const animationAfter = await page.evaluate(() => ({
    state: globalThis.__SIMHUMAN_DEBUG__.getAnimationState(),
    time: globalThis.__SIMHUMAN_DEBUG__.getAnimationTime(),
  }));
  assert.equal(animationAfter.state, 'walk', 'Rigify walk state should remain active');
  assert.ok(
    animationAfter.time > probe.animationTime,
    `Rigify walk animation should advance (${probe.animationTime} -> ${animationAfter.time})`,
  );

  const webgpuErrors = consoleErrors.filter((t) => /webgpu|wgsl|validation|pipeline/i.test(t));
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  assert.deepEqual(webgpuErrors, [], `WebGPU errors: ${webgpuErrors.join(' | ')}`);

  await mkdir('.codex-tmp', { recursive: true });
  await page.screenshot({ path: '.codex-tmp/simhuman-viewer.png' }).catch(() => {});

  console.log(
    `verify-simhuman-model: OK (bones=${probe.bones}, morphMeshes=${probe.morphMeshes}, `
    + `morphEntries=${probe.morphCount}, verts=${probe.verts}, height=${probe.bboxHeight.toFixed(2)}m)`,
  );
} finally {
  await browser.close();
}
