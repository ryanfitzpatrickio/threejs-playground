import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';

const appUrl = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const outputDir = path.resolve('.codex-tmp', 'visual-smoke');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
});

await mkdir(outputDir, { recursive: true });

const checks = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
  },
  {
    name: 'mobile',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
  },
];

try {
  for (const check of checks) {
    await verifyViewport(check);
  }
} finally {
  await browser.close();
}

async function verifyViewport({ name, viewport, deviceScaleFactor, isMobile }) {
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor,
    isMobile,
  });

  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas.game-canvas');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running');
  await page.waitForFunction(
    () => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.animation?.status === 'running',
  );
  await page.waitForFunction(() => {
    const character = globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.character;
    return (
      (character?.source === 'fbx' || character?.source === 'glb') &&
      character.animation?.availableStates?.includes('walk') &&
      character.animation?.availableStates?.includes('strafeLeft') &&
      character.animation?.availableStates?.includes('turnRight') &&
      character.animation?.availableStates?.includes('jumpMoving') &&
      character.animation?.availableStates?.includes('freeFall') &&
      character.animation?.availableStates?.includes('land') &&
      character.animation?.availableStates?.includes('freeHang') &&
      character.animation?.availableStates?.includes('bracedHang') &&
      character.animation?.availableStates?.includes('freeHangClimb')
    );
  });
  await page.waitForFunction(() => {
    const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();
    return Math.abs(snapshot.camera.aspect - snapshot.viewport.aspect) < 0.01;
  });
  await page.waitForFunction(() => {
    const snapshot = globalThis.__DREAMFALL_DEBUG__?.snapshot?.();

    return (
      snapshot?.physics?.status === 'ready' &&
      snapshot.physics.staticBodies >= 1 &&
      snapshot.level?.bvhMeshes >= 1
    );
  });

  const before = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().animation.elapsed);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().animation.elapsed);

  if (!(after > before)) {
    throw new Error(`${name}: animation clock did not advance`);
  }

  const startPosition = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.position);
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.animation.currentState === 'jog');
  await page.waitForTimeout(350);
  await page.keyboard.up('KeyW');
  const endPosition = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.position);

  if (distance2d(startPosition, endPosition) < 0.1) {
    throw new Error(`${name}: movement input did not move Mara`);
  }

  await page.keyboard.down('ShiftLeft');
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.animation.currentState === 'brace');
  await page.keyboard.up('ShiftLeft');

  const groundedBeforeJump = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.grounded);
  if (!groundedBeforeJump) {
    throw new Error(`${name}: Mara was not grounded before jump check`);
  }

  await page.keyboard.press('Space');
  await page.waitForFunction(() => {
    const state = globalThis.__DREAMFALL_DEBUG__.snapshot().character.animation.currentState;
    return state === 'jump' || state === 'jumpMoving';
  });
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.position.y > 0.2);
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.animation.currentState === 'freeFall');
  await page.waitForFunction(() => {
    const state = globalThis.__DREAMFALL_DEBUG__.snapshot().character.animation.currentState;
    return state === 'land' || state === 'landMoving';
  });
  await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.grounded === true);

  const canvasBox = await page.locator('canvas.game-canvas').boundingBox();
  if (!canvasBox || canvasBox.width < 100 || canvasBox.height < 100) {
    throw new Error(`${name}: canvas is missing or collapsed`);
  }

  const screenshot = await page.screenshot({ fullPage: true });
  const screenshotPath = path.join(outputDir, `${name}.png`);
  await writeFile(screenshotPath, screenshot);
  assertNonBlankPng(screenshot, name);

  await page.close();
}

function assertNonBlankPng(buffer, name) {
  const png = PNG.sync.read(buffer);
  const strideX = Math.max(1, Math.floor(png.width / 80));
  const strideY = Math.max(1, Math.floor(png.height / 80));
  const first = samplePixel(png, 0, 0);
  let variedSamples = 0;

  for (let y = 0; y < png.height; y += strideY) {
    for (let x = 0; x < png.width; x += strideX) {
      const pixel = samplePixel(png, x, y);
      const delta =
        Math.abs(pixel.r - first.r) +
        Math.abs(pixel.g - first.g) +
        Math.abs(pixel.b - first.b) +
        Math.abs(pixel.a - first.a);

      if (delta > 16) {
        variedSamples += 1;
      }
    }
  }

  if (variedSamples < 24) {
    throw new Error(`${name}: screenshot looks blank`);
  }
}

function samplePixel(png, x, y) {
  const index = (png.width * y + x) * 4;

  return {
    r: png.data[index],
    g: png.data[index + 1],
    b: png.data[index + 2],
    a: png.data[index + 3],
  };
}

function distance2d(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
