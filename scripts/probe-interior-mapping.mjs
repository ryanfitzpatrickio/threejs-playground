// probe-interior-mapping.mjs — regression: force a real WebGPU COMPILE of the
// interior-mapping material in isolation (interior-probe.html). The node verify
// (verify-office-entry) only checks the TSL graph CONSTRUCTS (colorNode != null);
// it can't catch nodes that build fine but fail type resolution under the
// renderer ("Cannot read properties of undefined (reading 'getNodeType')"). That
// exact class of bug shipped once (Fn return-type + objectPosition swizzle), so
// this probe guards it. It builds the window quad (plane + tangents + aRoomSeed),
// renders one frame, and FAILS on any THREE.TSL console error.
//
// Requires the dev server (npm run dev). Run: node scripts/probe-interior-mapping.mjs
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.env.DREAMFALL_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 720, height: 540 } });

const tslErrors = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && /THREE\.TSL/.test(t)) tslErrors.push(t);
});
page.on('pageerror', (e) => tslErrors.push(String(e)));

await page.goto(`${url}/interior-probe.html`, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForFunction(() => window.__probeResult !== null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const res = await page.evaluate(() => window.__probeResult);
if (process.env.OFFICE_PROBE_SCREENSHOT) {
  await page.screenshot({ path: process.env.OFFICE_PROBE_SCREENSHOT });
}
await browser.close();

const stats = res?.stats;
const structureOk = stats
  && stats.coveLights > 0 && stats.coveLights <= stats.coveCap
  && stats.glass > 0 && stats.glassFrames >= 4
  && stats.featureWalls > 0
  && stats.environment === 'Office Interior PMREM'
  && stats.ceilingTiles > 0
  && stats.trofferFrames > 0
  && stats.trofferFrames === stats.trofferDiffusers
  && stats.doors > 0
  && stats.frontages > 0 && stats.frontages === stats.frontagePillars
  && stats.doorClosedCollision && stats.doorOpened && stats.doorClosedAgain;
const ok = !!res?.ok && structureOk && tslErrors.length === 0;
console.log(ok ? 'PASS: office interior TSL/POM/glass materials compile + render under WebGPU'
  : `FAIL: ${tslErrors.length} TSL error(s)${res?.ok ? '' : ' (render did not complete)'}`);
if (res && !res.ok) console.log('  ', (res.error || '').slice(0, 300));
if (stats) console.log('  structure:', JSON.stringify(stats));
for (const e of tslErrors) console.log('  ', e.slice(0, 300));
if (!ok) process.exit(1);
