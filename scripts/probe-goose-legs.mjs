#!/usr/bin/env node
/**
 * probe-goose-legs — diagnose why the goose leg chain below UpperLeg is not
 * descending on the real (hierarchical) bird rig, when the flat synthetic
 * probe passed. Dumps each leg bone's parent name + local position + world
 * position so we can see the hierarchy and whether retarget set the locals.
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { dreamfallAppUrl } from './lib/dreamfallAppUrl.mjs';

const url = dreamfallAppUrl({ view: 'dog-sim', harness: '1', autostart: null });
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CHAIN = [
  'hips', 'UpperLeg_L', 'LowerLeg_L', 'AnkleLeg_L', 'Foot_L', 'Toes_L', 'Toes_tip_L',
];

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromePath) ? chromePath : undefined,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (err) => console.error('PAGEERROR:', err.message));
page.on('console', (msg) => { if (msg.type() === 'error') console.error('CONSOLE:', msg.text().slice(0, 300)); });

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => globalThis.__DOG_SIM_DEBUG__?.status === 'ready' || globalThis.__DOG_SIM_DEBUG__?.status === 'failed',
    { timeout: 60000 },
  );
  const status = await page.evaluate(() => globalThis.__DOG_SIM_DEBUG__?.status);
  if (status !== 'ready') throw new Error(`dog sim status=${status}`);

  await page.evaluate(async () => { await globalThis.__DOG_SIM_DEBUG__.setBreed('canada-goose'); });
  await page.waitForFunction(() => globalThis.__DOG_SIM_DEBUG__?.snapshot?.breedId === 'canada-goose', { timeout: 30000 });

  const rows = await page.evaluate((names) => {
    const api = globalThis.__DOG_SIM_DEBUG__;
    const rig = api.getDog().rig;
    const out = [];
    for (const n of names) {
      const b = rig.bonesByName.get(n);
      if (!b) { out.push({ name: n, missing: true }); continue; }
      out.push({
        name: n,
        parent: b.parent ? b.parent.name : '(none)',
        parentIsBone: !!(b.parent && b.parent.isBone),
        local: [Number(b.position.x).toFixed(4), Number(b.position.y).toFixed(4), Number(b.position.z).toFixed(4)],
        quat: [Number(b.quaternion.x).toFixed(4), Number(b.quaternion.y).toFixed(4), Number(b.quaternion.z).toFixed(4), Number(b.quaternion.w).toFixed(4)],
        world: api.getBoneWorldPosition(n),
      });
    }
    // Walk the ancestor chain from hips up to the scene root, dumping each
    // object's TRS — a -90° X rotation on some ancestor explains the y/z swap.
    const hips = rig.bonesByName.get('hips');
    const chain = [];
    let node = hips;
    while (node) {
      chain.push({
        name: node.name || node.type,
        type: node.type,
        pos: [Number(node.position.x).toFixed(4), Number(node.position.y).toFixed(4), Number(node.position.z).toFixed(4)],
        quat: [Number(node.quaternion.x).toFixed(4), Number(node.quaternion.y).toFixed(4), Number(node.quaternion.z).toFixed(4), Number(node.quaternion.w).toFixed(4)],
        scale: [Number(node.scale.x).toFixed(3), Number(node.scale.y).toFixed(3), Number(node.scale.z).toFixed(3)],
      });
      node = node.parent;
    }
    out.push({ ancestorChain: chain });
    // Also: does GOOSE_RETARGET_FULL exist on the gooseBirdRigMap module? We
    // can't import it here, but we can report whether the bone names match the
    // keys by checking the dog's retargeted state indirectly. Instead, dump the
    // FULL bonesByName key list so we see the real joint names.
    out.push({ allBoneNames: [...rig.bonesByName.keys()] });
    // Dump every clip's track names so we know which rotation tracks the
    // sanitize step must strip (root orientation + tucked-leg poses).
    const dog = api.getDog();
    const clipReport = [];
    if (dog.birdActions) {
      for (const [clipName, action] of dog.birdActions) {
        const tracks = action.getClip().tracks.map((t) => t.name);
        clipReport.push({ clip: clipName, tracks });
      }
    }
    out.push({ clips: clipReport });
    return out;
  }, CHAIN.slice(0, 7));

  console.log('\n=== leg chain (parent · local · world) ===');
  for (const r of rows) {
    if (r.missing) { console.log(`  ${r.name}: MISSING from bonesByName`); continue; }
    if (r.allBoneNames) {
      console.log(`\n=== all ${r.allBoneNames.length} bone names in rig ===`);
      console.log('  ' + r.allBoneNames.join(', '));
      continue;
    }
    if (r.clips) {
      console.log(`\n=== clip tracks ===`);
      for (const c of r.clips) {
        console.log(`  [${c.clip}]  (${c.tracks.length} tracks)`);
        for (const t of c.tracks) console.log(`      ${t}`);
      }
      continue;
    }
    if (r.ancestorChain) {
      console.log(`\n=== ancestor chain hips → scene root (pos · quat xyzw · scale) ===`);
      for (const c of r.ancestorChain) {
        console.log(`  ${String(c.name).padEnd(16)} [${c.type}]  pos=[${c.pos}]  quat=[${c.quat}]  scale=[${c.scale}]`);
      }
      continue;
    }
    console.log(`  ${r.name.padEnd(12)} parent=${String(r.parent).padEnd(10)}  local=[${r.local.join(', ')}]  quat=[${r.quat.join(', ')}]`);
  }
} finally {
  await browser.close();
}
