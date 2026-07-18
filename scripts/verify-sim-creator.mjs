import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const name = `Creator Verify ${Date.now()}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});

let savedId = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  await page.goto(dreamfallAppUrl({ view: 'sim-creator' }), {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => ['ready', 'failed'].includes(globalThis.__SIMHUMAN_DEBUG__?.status),
    { timeout: 90_000 },
  );
  assert.equal(await page.locator('canvas[aria-label="Character Maker preview"]').count(), 1);
  assert.ok(await page.locator('input[type="range"]').count() >= 4, 'modeling sliders should render');
  assert.equal(await page.getByRole('group', { name: 'Sim body' }).getByRole('button').count(), 3);

  await page.getByRole('button', { name: 'Male body', exact: true }).click();
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.status === 'ready'
      && globalThis.__SIMHUMAN_DEBUG__.owner?.snapshot?.().body === 'male',
    { timeout: 90_000 },
  );

  // Recessed collar/torso skin must exist as a companion on both UBC bodies
  // as soon as an outfit attaches (no tuck configuration — the continuous
  // recess fills whatever the garment leaves open). Exercise male first, then
  // carry the same outfit onto female.
  await page.getByRole('button', { name: 'Garments', exact: true }).click();
  await page.getByRole('tab', { name: 'Outfits', exact: true }).click();
  await page.getByRole('button', { name: 'Ranger outfit', exact: true }).click();
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.id === 'fantasy-ranger',
    { timeout: 90_000 },
  );
  assert.ok(
    (await page.evaluate(() => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot().recessedSkinMeshes)) > 0,
    'male outfit attach should create recessed skin companions',
  );
  const coveredSnapshot = await page.evaluate(() => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot());
  assert.equal(
    coveredSnapshot.outfitVisibleTriangles,
    coveredSnapshot.outfitSourceTriangles,
    'zero limb reveal leaves authored garment geometry complete',
  );
  for (const [label, value] of [['Torso tuck depth', '0.37'], ['Limb seam depth', '0.82']]) {
    await page.locator(`input[aria-label="${label}"]`).evaluate((input, nextValue) => {
      input.value = nextValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }
  await page.waitForFunction(
    () => {
      const tuck = globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.fit?.outfitSkinTuck;
      return tuck?.torso === 0.37 && tuck?.seams === 0.82;
    },
    { timeout: 30_000 },
  );
  for (const label of ['Arm reveal', 'Leg reveal', 'Foot reveal']) {
    await page.locator(`input[aria-label="${label}"]`).evaluate((input) => {
      input.value = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await page.waitForFunction(
    () => {
      const snapshot = globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.();
      const reveal = snapshot?.fit?.outfitLimbReveal;
      return reveal?.arms === 1 && reveal?.legs === 1 && reveal?.feet === 1;
    },
    { timeout: 30_000 },
  );
  const revealedSnapshot = await page.evaluate(() => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot());
  assert.ok(
    revealedSnapshot.outfitVisibleTriangles < coveredSnapshot.outfitVisibleTriangles,
    'full limb reveal removes garment arm/leg/foot triangles',
  );
  assert.ok(
    revealedSnapshot.bodyVisibleTriangles > coveredSnapshot.bodyVisibleTriangles,
    'full limb reveal restores matching body triangles',
  );
  const armRevealInput = page.locator('input[aria-label="Arm reveal"]');
  assert.equal(await armRevealInput.getAttribute('max'), '2', 'arm reveal slider extends past the base limb');
  await armRevealInput.evaluate((input) => {
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.fit?.outfitLimbReveal?.arms === 2,
    { timeout: 30_000 },
  );
  const extendedArmSnapshot = await page.evaluate(
    () => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot(),
  );
  assert.ok(
    extendedArmSnapshot.outfitVisibleTriangles < revealedSnapshot.outfitVisibleTriangles,
    'arm reveal 2 cuts the outfit beyond the shoulder into collar/chest',
  );
  assert.ok(
    extendedArmSnapshot.bodyVisibleTriangles > revealedSnapshot.bodyVisibleTriangles,
    'arm reveal 2 restores the matching body collar/chest triangles',
  );
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Female body', exact: true }).click();
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.status === 'ready'
      && globalThis.__SIMHUMAN_DEBUG__.owner?.snapshot?.().body === 'female'
      && globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.id === 'fantasy-ranger'
      && globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.recessedSkinMeshes > 0,
    { timeout: 90_000 },
  );
  assert.ok(
    (await page.evaluate(() => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot().recessedSkinMeshes)) > 0,
    'female outfit attach should create recessed skin companions',
  );

  await page.getByRole('button', { name: 'Garments', exact: true }).click();
  await page.getByRole('tab', { name: 'Outfits', exact: true }).click();
  for (const [label, value] of [
    ['Outfit Offset X', '0.12'],
    ['Outfit Offset Y', '-0.08'],
    ['Outfit Offset Z', '0.04'],
  ]) {
    await page.locator(`input[aria-label="${label}"]`).evaluate((input, nextValue) => {
      input.value = nextValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }
  await page.waitForFunction(
    () => {
      const position = globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.fit?.outfitPosition;
      return position?.x === 0.12 && position?.y === -0.08 && position?.z === 0.04;
    },
    { timeout: 30_000 },
  );
  assert.equal(await page.getByRole('button', { name: 'Draw loop on mesh' }).count(), 1);
  await page.getByRole('button', { name: 'Draw loop on mesh' }).click();
  const creatorCanvas = page.locator('canvas[aria-label="Character Maker preview"]');
  const canvasBox = await creatorCanvas.boundingBox();
  assert.ok(canvasBox, 'creator canvas has bounds for loop picking');
  const pickCandidates = [
    [0.5, 0.42], [0.45, 0.36], [0.55, 0.36], [0.5, 0.5],
  ];
  for (const [x, y] of pickCandidates) {
    await page.keyboard.down('Shift');
    await page.mouse.click(canvasBox.x + canvasBox.width * x, canvasBox.y + canvasBox.height * y);
    await page.keyboard.up('Shift');
    const points = await page.evaluate(
      () => globalThis.__SIMHUMAN_DEBUG__?.owner?.outfitLoopEditor?.points?.length ?? 0,
    );
    if (points > 0) break;
  }
  assert.ok(
    await page.evaluate(() => globalThis.__SIMHUMAN_DEBUG__?.owner?.outfitLoopEditor?.points?.length > 0),
    'Shift-click raycasts a loop point onto the outfit surface',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const beforeLoopSnapshot = await page.evaluate(
    () => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot(),
  );
  await page.evaluate(() => {
    globalThis.__SIMHUMAN_DEBUG__.owner.onOutfitLoopCutsChange?.([{
      id: 'verify-v-neck',
      target: 'torso',
      interpolation: 'sharp',
      hideSide: 'positive',
      frame: {
        origin: [0, 0, 0],
        axis: [0, 1, 0],
        u: [1, 0, 0],
        v: [0, 0, -1],
      },
      points: [
        [0.45, 2.48, 0],
        [0, 2.05, -0.3],
        [-0.45, 2.48, 0],
        [0, 2.48, 0.3],
      ],
    }]);
  });
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.outfitLoopCuts?.length === 1,
    { timeout: 30_000 },
  );
  const loopSnapshot = await page.evaluate(() => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot());
  assert.ok(
    loopSnapshot.outfitLoopVisibleTriangles < beforeLoopSnapshot.outfitLoopVisibleTriangles,
    'saved torso loop removes the selected outfit side',
  );
  assert.ok(
    loopSnapshot.bodyVisibleTriangles > beforeLoopSnapshot.bodyVisibleTriangles,
    'saved torso loop restores the matching body side',
  );
  assert.ok(await page.getByText('Saved loop cuts', { exact: true }).isVisible());
  await page.locator('input[aria-label="Loop cut 1 edge adjustment"]').evaluate((input) => {
    input.value = '0.3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.getOutfitSnapshot?.()?.outfitLoopCuts?.[0]?.edgeInset === 0.3,
    { timeout: 30_000 },
  );
  const insetLoopSnapshot = await page.evaluate(
    () => globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot(),
  );
  assert.ok(
    insetLoopSnapshot.outfitLoopVisibleTriangles > loopSnapshot.outfitLoopVisibleTriangles,
    'keep-more edge adjustment restores garment triangles',
  );
  assert.ok(
    insetLoopSnapshot.bodyVisibleTriangles < loopSnapshot.bodyVisibleTriangles,
    'keep-more edge adjustment retreats the body handoff',
  );
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();

  await page.locator('input[aria-label="Sim name"]').fill(name);
  await page.locator('input[aria-label="id.head.width"]').evaluate((input) => {
    input.value = '0.63';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Save preset' }).click();

  const stored = await page.evaluate(async (expectedName) => {
    const response = await fetch('/api/store/snapshot');
    const snapshot = await response.json();
    return Object.values(snapshot.sims ?? {}).find((entry) => entry.name === expectedName) ?? null;
  }, name);
  assert.ok(stored?.id, 'saved preset should reach SQLite');
  assert.equal(stored.body, 'female');
  assert.equal(stored.morphs['id.head.width'], 0.63);
  assert.equal(stored.outfitId, 'fantasy-ranger');
  assert.deepEqual(stored.outfitPosition, { x: 0.12, y: -0.08, z: 0.04 });
  assert.deepEqual(stored.outfitSkinTuck, { torso: 0.37, seams: 0.82 });
  assert.deepEqual(stored.outfitLimbReveal, { arms: 2, legs: 1, feet: 1 });
  assert.equal(stored.outfitLoopCuts?.length, 1, 'loop cut persists with the Sim preset');
  assert.equal(stored.outfitLoopCuts[0].interpolation, 'sharp');
  assert.equal(stored.outfitLoopCuts[0].edgeInset, 0.3);
  assert.deepEqual(stored.garmentIds, [], 'authored outfit should replace Dynamic Cloth wardrobe');
  savedId = stored.id;

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (expectedName) => [...document.querySelectorAll('.garage-saved-card strong')]
      .some((node) => node.textContent === expectedName),
    name,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.status === 'ready',
    { timeout: 90_000 },
  );
  await page.locator('.garage-saved-card').filter({ hasText: name }).locator('button').first().click();
  await page.waitForFunction(
    () => globalThis.__SIMHUMAN_DEBUG__?.status === 'ready'
      && globalThis.__SIMHUMAN_DEBUG__.owner?.snapshot?.().body === 'female'
      && globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot?.()?.id === 'fantasy-ranger'
      && globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot?.()?.fit?.outfitLimbReveal?.arms === 2
      && globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot?.()?.outfitLoopCuts?.length === 1
      && globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot?.()?.outfitLoopCuts?.[0]?.edgeInset === 0.3
      && globalThis.__SIMHUMAN_DEBUG__.getOutfitSnapshot?.()?.fit?.outfitLimbReveal?.feet === 1,
    { timeout: 90_000 },
  );
  assert.equal(
    await page.getByRole('button', { name: 'Female body', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  console.log('verify-sim-creator: recessed skin + limb replacement, outfit save, and reload persistence OK');
} finally {
  if (savedId) {
    await fetch(new URL(`/api/store/sims/${savedId}`, dreamfallAppUrl()), { method: 'DELETE' }).catch(() => {});
  }
  await browser.close();
}
