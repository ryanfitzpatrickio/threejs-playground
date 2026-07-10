#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import path from 'node:path';
import { chromium } from 'playwright';

const appUrl = dreamfallAppUrl() /* was 5174 default */;
const outDir = path.resolve('.codex-tmp', 'probe-browser');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, executablePath: existsSync(chromePath) ? chromePath : undefined, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas.game-canvas');
await page.waitForFunction(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.stage === 'running', { timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 7000));

function categoryOf(obj) {
  if (obj.isSkinnedMesh) return 'skinned';
  // walk up
  let p = obj, s = '';
  while (p) { s += p.name + '/'; p = p.parent; }
  if (/Generator City|Base Level/.test(s)) return 'city';
  if (/Sword|Neon/.test(s)) return 'sword';
  if (/Saddle/.test(s)) return 'saddle';
  return 'other';
}

async function showOnly(group) {
  await page.evaluate((g) => {
    const scene = globalThis.__DREAMFALL_DEBUG__?.getScene?.();
    scene?.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.visible = (categoryOf(o) === g); });
    function categoryOf(obj){ if(obj.isSkinnedMesh) return 'skinned'; let p=obj,s=''; while(p){s+=p.name+'/';p=p.parent;} if(/Generator City|Base Level/.test(s)) return 'city'; if(/Sword|Neon/.test(s)) return 'sword'; if(/Saddle/.test(s)) return 'saddle'; return 'other'; }
  }, group);
  await new Promise((r) => setTimeout(r, 1500));
  const file = path.join(outDir, `only-${group}.png`);
  await page.screenshot({ path: file });
  console.log(`shot only-${group} -> ${file}`);
}

for (const g of ['skinned', 'city', 'sword', 'saddle', 'other']) {
  await showOnly(g);
}

// restore
await page.evaluate(() => { globalThis.__DREAMFALL_DEBUG__?.getScene?.()?.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.visible = true; }); });
await browser.close();
