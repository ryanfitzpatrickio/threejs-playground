import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const browser = await chromium.launch({ headless: true, executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 });
await page.waitForTimeout(1500);
const before = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.position);
console.log('start pos:', JSON.stringify(before));
// walk forward so several chunks stream in (verifies merge + streaming coexist)
await page.keyboard.down('KeyW');
await page.waitForTimeout(4500);
await page.keyboard.up('KeyW');
await page.waitForTimeout(800);
const after = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.snapshot().character.position);
console.log('end pos:  ', JSON.stringify(after));
console.log('moved dz:  ', (after.z - before.z).toFixed(2));
const stats = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.sceneStats());
console.log('totalMeshes:', stats.totalMeshes);
console.log('totalTriangles:', stats.totalTriangles);
console.log('tally:');
for (const [key, v] of Object.entries(stats.tally).sort((a, b) => b[1].meshes - a[1].meshes)) {
  console.log(`  ${key.padEnd(28)} meshes=${String(v.meshes).padStart(4)}  triangles=${v.triangles}`);
}
// Dump chunk groups + their child mesh names to see what streamed chunks actually contain.
const chunkDump = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__.sceneChunks());
console.log('loaded chunks:', chunkDump.length);
for (const c of chunkDump) {
  console.log(`  ${c.name}:`);
  for (const m of c.meshes) console.log(`      ${m.name}  (tris=${Math.round(m.tris)})`);
}
await browser.close();
