#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';
import { mkdir } from 'node:fs/promises';
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
await new Promise((r) => setTimeout(r, 6000));

const report = await page.evaluate(() => {
  const scene = globalThis.__DREAMFALL_DEBUG__?.getScene?.();
  if (!scene) return { error: 'no scene' };
  scene.updateMatrixWorld(true);
  const badMat = (m) => { if (!m || !m.elements) return false; for (const e of m.elements) if (!isFinite(e) || Math.abs(e) > 1e6) return true; return false; };
  const out = [];
  scene.traverse((obj) => {
    if (!obj.isMesh) return;
    let chain = []; let p = obj; while (p) { if (p.name) chain.unshift(p.name); p = p.parent; }
    const rec = { name: obj.name || '<mesh>', type: obj.isSkinnedMesh ? 'skinned' : 'mesh', chain: chain.join('>').slice(0, 90), matrixBad: badMat(obj.matrixWorld) };
    if (obj.isSkinnedMesh && obj.skeleton) {
      const bones = obj.skeleton.bones || [];
      let badBones = 0; const badNames = [];
      for (const b of bones) { if (badMat(b.matrixWorld)) { badBones++; if (badNames.length < 4) badNames.push(b.name); } }
      rec.bones = bones.length; rec.badBones = badBones; rec.badBoneNames = badNames;
      // sample a few skinned vertices via the mesh's own applyBoneTransform
      const pos = obj.geometry?.attributes?.position;
      if (pos && typeof obj.applyBoneTransform === 'function' && typeof obj.boneTransform === 'undefined') {
        let maxDist = 0, anyBad = false;
        const v = { x:0,y:0,z:0 };
        const N = Math.min(pos.count, 4000);
        for (let i = 0; i < N; i++) {
          // fromBufferAttribute manually
          v.x = pos.getX(i); v.y = pos.getY(i); v.z = pos.getZ(i);
          try { obj.applyBoneTransform(i, v); } catch(e){ anyBad = true; }
          const d = v.x*v.x+v.y*v.y+v.z*v.z;
          if (!isFinite(d)) anyBad = true; else if (d > maxDist) maxDist = d;
        }
        rec.skinnedMaxR = Math.sqrt(maxDist); rec.skinnedAnyBad = anyBad;
      }
    }
    out.push(rec);
  });
  // sort: bad bones / bad skinned first
  out.sort((a, b) => ((b.badBones||0) + (b.skinnedAnyBad?5:0) + (b.matrixBad?5:0)) - ((a.badBones||0) + (a.skinnedAnyBad?5:0) + (a.matrixBad?5:0)));
  return { count: out.length, meshes: out };
});

console.log('total meshes:', report.count, '\n');
for (const m of report.meshes.slice(0, 24)) {
  const flag = (m.badBones || m.matrixBad || m.skinnedAnyBad) ? '❗' : '  ';
  let extra = '';
  if (m.badBones) extra += ` badBones=${m.badBones}/${m.bones}(${(m.badBoneNames||[]).join(';')})`;
  if (m.matrixBad) extra += ' MATRIX_BAD';
  if (m.skinnedAnyBad) extra += ' SKIN_BAD';
  if (m.skinnedMaxR !== undefined) extra += ` skinMaxR=${m.skinnedMaxR.toFixed(1)}`;
  console.log(`${flag} ${m.type.padEnd(7)} ${m.name}${extra || ' ok'}`);
  console.log(`        ${m.chain}`);
}

const cam = await page.evaluate(() => globalThis.__DREAMFALL_DEBUG__?.snapshot?.()?.camera || null);
console.log('\ncamera:', JSON.stringify(cam));
await page.screenshot({ path: path.join(outDir, 'load.png') });
await browser.close();
