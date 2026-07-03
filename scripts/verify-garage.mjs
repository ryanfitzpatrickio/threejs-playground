import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

console.log('Launching garage browser check...');
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  console.log('Opening app...');
  await page.goto(process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5174', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Garage' }).click();
  console.log('Garage selected...');
  await page.waitForSelector('.garage-shell .garage-canvas', { timeout: 15000 });
  await page.waitForSelector('.garage-canvas[data-preview-ready="true"]', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /Muscle Mk II/ }).click();
  await page.waitForSelector('.garage-canvas[data-chassis="muscle-2"]');

  const turntableCanvas = page.locator('.garage-canvas');
  const turntableBox = await turntableCanvas.boundingBox();
  const rotationBeforeDrag = Number(await turntableCanvas.getAttribute('data-preview-rotation'));
  await page.mouse.move(turntableBox.x + turntableBox.width * 0.45, turntableBox.y + turntableBox.height * 0.55);
  await page.mouse.down();
  await page.mouse.move(turntableBox.x + turntableBox.width * 0.58, turntableBox.y + turntableBox.height * 0.55, { steps: 8 });
  await page.mouse.up();
  const rotationAfterDrag = Number(await turntableCanvas.getAttribute('data-preview-rotation'));

  await page.getByLabel('Build name').fill('Verifier Street Build');
  const wheelbase = page.locator('.garage-slider').filter({ hasText: 'Wheelbase' }).locator('input');
  await wheelbase.evaluate((input) => {
    input.value = '3.44';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const wheelTrack = page.getByRole('slider', { name: 'Wheel track', exact: true });
  await wheelTrack.evaluate((input) => {
    input.value = '2.10';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const rideHeight = page.getByRole('slider', { name: 'Ride height', exact: true });
  await rideHeight.evaluate((input) => {
    input.value = '1.21';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const tireRadius = page.getByRole('slider', { name: 'Tire radius', exact: true });
  await tireRadius.evaluate((input) => {
    input.value = '0.50';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const bodyY = page.getByRole('slider', { name: 'Body Y', exact: true });
  await bodyY.evaluate((input) => {
    input.value = '-0.22';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Save configuration' }).click();

  const stored = await page.evaluate(async () => {
    const index = await fetch('/api/store/index').then((r) => r.json());
    const buildId = index.garage?.[0]?.id;
    const build = buildId
      ? await fetch(`/api/store/garage/${encodeURIComponent(buildId)}`).then((r) => r.json())
      : null;
    return {
      builds: build ? [build] : [],
      active: index.state?.activeGarageBuildId ?? null,
    };
  });
  assert.equal(stored.builds.length, 1);
  assert.equal(stored.builds[0].name, 'Verifier Street Build');
  assert.equal(stored.builds[0].frame.wheelbase, 3.44);
  assert.equal(stored.builds[0].frame.wheelTrack, 2.1);
  assert.equal(stored.builds[0].frame.rideHeight, 1.21);
  assert.equal(stored.builds[0].wheels.radius, 0.5);
  assert.equal(stored.builds[0].chassisTransform.position[1], -0.22);
  assert.equal(stored.builds[0].chassisId, 'muscle-2');
  assert.equal(stored.active, stored.builds[0].id);
  const previewObjects = await page.locator('.garage-canvas').getAttribute('data-preview-objects');
  const triangles = await page.locator('.garage-canvas').getAttribute('data-triangles');
  const curtainNodes = await page.locator('.garage-canvas').getAttribute('data-curtain-nodes');
  const cameraAspect = Number(await page.locator('.garage-canvas').getAttribute('data-camera-aspect'));
  const previewWheelTrack = Number(await page.locator('.garage-canvas').getAttribute('data-preview-wheel-track'));
  const previewWheelbase = Number(await page.locator('.garage-canvas').getAttribute('data-preview-wheelbase'));
  const previewRideDelta = Number(await page.locator('.garage-canvas').getAttribute('data-preview-ride-delta'));
  const giState = await page.locator('.garage-canvas').getAttribute('data-gi');
  const canvasBox = await page.locator('.garage-canvas').boundingBox();
  assert.ok(Number(previewObjects) > 5, 'garage preview did not create vehicle scene objects');
  assert.ok(Number(triangles) > 100, `garage preview rendered only ${triangles} triangles`);
  assert.equal(Number(curtainNodes), 96, 'Rapier curtain node grid was not initialized');
  assert.equal(giState, 'baked', 'garage global-illumination probe grid was not baked');
  assert.ok(Math.abs(rotationAfterDrag - rotationBeforeDrag) > 0.2, 'dragging did not rotate the garage vehicle');
  assert.equal(previewWheelTrack, 2.1, 'wheel-track control did not move preview wheel anchors');
  assert.equal(previewWheelbase, 3.44, 'wheelbase control did not move preview wheel anchors');
  assert.ok(previewRideDelta > 0.15, 'ride-height control did not lower preview wheels');
  assert.ok(
    Math.abs(cameraAspect - canvasBox.width / canvasBox.height) < 0.001,
    `camera aspect ${cameraAspect} does not match canvas ${canvasBox.width / canvasBox.height}`,
  );
  assert.equal(errors.length, 0, `garage browser errors:\n${errors.join('\n')}`);

  await mkdir('.codex-tmp', { recursive: true });
  await page.screenshot({ path: '.codex-tmp/garage.png', timeout: 5000 }).catch(() => {
    console.log('Screenshot skipped: headless WebGPU surface did not settle in time.');
  });
  console.log('Garage browser check passed.');
} finally {
  await browser.close();
}
