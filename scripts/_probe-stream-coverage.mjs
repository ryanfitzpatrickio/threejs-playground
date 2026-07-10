import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
const url = dreamfallAppUrl();
const exe = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;
const browser = await chromium.launch({ headless: true, executablePath: exe, args: ['--enable-unsafe-webgpu','--enable-features=Vulkan'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 45_000 });

// Coverage: count terrain chunks within R meters of a world point, and report their world positions.
const coverage = (x, z, R = 80) => page.evaluate(([x, z, R]) => {
  const scene = globalThis.__DREAMFALL_DEBUG__.getScene();
  const THREE = globalThis.__DREAMFALL_DEBUG__.getThree();
  let near = 0, total = 0; const sample = [];
  scene.traverse((o) => {
    if (o.isMesh && /TerrainChunk/.test(o.name || '')) {
      total++;
      const p = new THREE.Vector3(); o.getWorldPosition(p);
      if (Math.hypot(p.x - x, p.z - z) <= R) { near++; if (sample.length < 3) sample.push([+p.x.toFixed(1), +p.z.toFixed(1)]); }
    }
  });
  return { near, total, sample };
}, [x, z, R]);

const player = () => page.evaluate(() => { const s = globalThis.__DREAMFALL_DEBUG__.snapshot(); return s.player; });

const spawn = await player();
console.log('spawn:', JSON.stringify(spawn));
console.log('coverage near spawn (R=80):', JSON.stringify(await coverage(spawn.x, spawn.z)));

// Enter vehicle, drive forward hard, re-check coverage AT the new player position.
await page.evaluate(async () => { await globalThis.__DREAMFALL_DEBUG__.enterVehicleByName?.('Spawn Car'); });
await page.waitForTimeout(400);
await page.keyboard.down('KeyW');
const trace = [];
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(700);
  const p = await player();
  const c = await coverage(p.x, p.z);
  trace.push({ t: (i+1)*0.7, p: [+p.x.toFixed(0), +p.z.toFixed(0)], near: c.near, total: c.total });
}
await page.keyboard.up('KeyW');
console.log('drive trace (coverage at player, R=80):');
for (const t of trace) console.log(`  t=${t.t}s player=${t.p} chunksNearPlayer=${t.near} total=${t.total}`);
await browser.close();
