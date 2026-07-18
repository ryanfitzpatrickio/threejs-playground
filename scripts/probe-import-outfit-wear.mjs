#!/usr/bin/env node
/**
 * Probe the LIVE skinned shape of a worn imported outfit in the simhuman viewer.
 *
 * Static Box3 bounds only see bind-space geometry, so this samples true
 * skinned vertex positions (SkinnedMesh.applyBoneTransform) and reports, per
 * dominant joint, how far verts moved from their bind positions. Run when a
 * worn import renders distorted (kite/shredding) to find the culprit bones.
 *
 * Requires: npm run dev
 * Run: node scripts/probe-import-outfit-wear.mjs [outfitId]
 */

import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const outfitId = process.argv[2] ?? 'meshy-ai-charcoal-business-sui-071409275';
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e?.message ?? e}`));

try {
  const url = dreamfallAppUrl({ view: 'simhuman', simBody: 'male' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => ['ready', 'failed'].includes(globalThis.__SIMHUMAN_DEBUG__?.status),
    { timeout: 120_000 },
  );

  const result = await page.evaluate(async (id) => {
    const dbg = globalThis.__SIMHUMAN_DEBUG__;
    if (dbg.status !== 'ready') throw new Error(`viewer ${dbg.status}: ${dbg.error}`);
    await dbg.setBody('male');
    const start = performance.now();
    while (dbg.status !== 'ready' && performance.now() - start < 60_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    dbg.setAppearance({
      body: 'male',
      morphs: {},
      facs: {},
      outfitId: id,
      outfitVariant: 'standard',
      outfitScale: { x: 1, y: 1, z: 1 },
      garmentIds: [],
    });
    await dbg.setOutfit(id);
    dbg.setAnimation('idle');
    await new Promise((r) => setTimeout(r, 900));

    const scene = dbg.owner;
    const runtime = scene.outfitRuntime;
    if (!runtime) throw new Error('no outfitRuntime after setOutfit');
    const Vector3 = scene.camera.position.constructor;

    const measure = (mesh, label) => {
      mesh.updateWorldMatrix(true, false);
      const pos = mesh.geometry.attributes.position;
      const ji = mesh.geometry.attributes.skinIndex;
      const jw = mesh.geometry.attributes.skinWeight;
      const step = Math.max(1, Math.floor(pos.count / 6000));
      const v = new Vector3();
      const bind = new Vector3();
      const world = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };
      const byJoint = new Map();
      for (let i = 0; i < pos.count; i += step) {
        bind.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        v.fromBufferAttribute(pos, i);
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        for (let a = 0; a < 3; a += 1) {
          const c = a === 0 ? v.x : a === 1 ? v.y : v.z;
          world.min[a] = Math.min(world.min[a], c);
          world.max[a] = Math.max(world.max[a], c);
        }
        let best = 0;
        let bw = jw.getX(i);
        const ws = [jw.getX(i), jw.getY(i), jw.getZ(i), jw.getW(i)];
        const js = [ji.getX(i), ji.getY(i), ji.getZ(i), ji.getW(i)];
        for (let k = 1; k < 4; k += 1) if (ws[k] > bw) { bw = ws[k]; best = k; }
        const bone = mesh.skeleton.bones[js[best]];
        const name = bone?.name ?? `#${js[best]}`;
        const d = v.distanceTo(bind);
        const e = byJoint.get(name) ?? { n: 0, sum: 0, max: 0 };
        e.n += 1;
        e.sum += d;
        e.max = Math.max(e.max, d);
        byJoint.set(name, e);
      }
      const worst = [...byJoint.entries()]
        .map(([name, e]) => [name, +(e.sum / e.n).toFixed(3), +e.max.toFixed(3), e.n])
        .sort((a, b) => b[2] - a[2])
        .slice(0, 14);
      return {
        label,
        verts: pos.count,
        worldAabb: {
          min: world.min.map((x) => +x.toFixed(3)),
          max: world.max.map((x) => +x.toFixed(3)),
        },
        worstJoints: worst, // [name, meanDisp, maxDisp, samples]
      };
    };

    const out = { outfit: [], body: [], snapshot: runtime.snapshot() };
    for (const mesh of runtime.meshes) out.outfit.push(measure(mesh, mesh.name));
    const bodyMesh = scene.model.skinnedMeshes?.find((m) => m.geometry.attributes.position.count > 2000);
    if (bodyMesh) out.body.push(measure(bodyMesh, `body:${bodyMesh.name}`));
    out.animationState = dbg.getAnimationState();
    return out;
  }, outfitId);

  console.log(JSON.stringify(result, null, 2));
  const warn = logs.filter((l) => /missing|warn|error|attachSimOutfit/i.test(l));
  if (warn.length) console.log('\n--- notable console ---\n' + warn.slice(0, 20).join('\n'));
} finally {
  await browser.close();
}
