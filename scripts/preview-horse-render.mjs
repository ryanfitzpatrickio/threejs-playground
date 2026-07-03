// Sweep IK pole directions and measure the live front-knee bend direction
// (via the real HorseSystem) to find which pole gives a forward, human-knee fold.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const appUrl = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const outDir = path.resolve('.codex-tmp', 'horse-preview');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
});

// Horizontal pole directions to sweep (app group-local space).
const poles = [];
for (const x of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
  if (x === 0 && z === 0) continue;
  poles.push({ x, y: 0, z, label: `pole(${x},0,${z})` });
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
  await page.goto(`${appUrl}/horse-preview.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
  await page.waitForTimeout(600);

  const calib = await page.evaluate(() => window.__measure());
  console.log('original (ik off):', JSON.stringify(calib), '(cross>0 = backward)');

  const results = [];
  for (const pole of poles) {
    const m = await page.evaluate((p) => {
      window.__setVariant({ ik: { enabled: true, weight: 1, pole: p } });
      return null;
    }, pole);
    await page.waitForTimeout(250);
    const meas = await page.evaluate(() => window.__measure());
    results.push({ ...pole, cross: meas.cross });
    console.log(`${pole.label.padEnd(16)} cross=${meas.cross}`);
  }

  results.sort((a, b) => a.cross - b.cross);
  console.log('\nMost FORWARD (most negative cross):', results[0]);
  console.log('Most BACKWARD (most positive cross):', results[results.length - 1]);

  // Screenshot original + the most-forward pole for visual reference.
  await page.evaluate(() => window.__setVariant({}));
  await page.waitForTimeout(300);
  await writeFile(path.join(outDir, 'sweep_original.png'), await page.screenshot());
  await page.evaluate((p) => window.__setVariant({ ik: { enabled: true, weight: 1, pole: p } }), results[0]);
  await page.waitForTimeout(400);
  await writeFile(path.join(outDir, 'sweep_forward.png'), await page.screenshot());
  console.log('wrote sweep_original.png and sweep_forward.png');

  await page.close();
} finally {
  await browser.close();
}
