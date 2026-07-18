#!/usr/bin/env node
/**
 * Prepare Meshy monochrome athleisure FBX as a male-only sim outfit.
 *
 *   node scripts/prepare-meshy-athleisure.mjs [path/to/Meshy_..._fbx.zip]
 *
 * Steps:
 *  1. Extract FBX + textures
 *  2. Blender: align to UBC male, transfer weights, export raw GLB
 *  3. Optimize standard + morph variants (bake bulk morphs from UBC male)
 *  4. Copy standard to root for legacy paths
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLENDER = process.env.BLENDER_BIN
  ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const DEFAULT_ZIP = '/Users/personal/Downloads/Meshy_AI_Monochrome_Athleisure_0714011739_texture_fbx.zip';
const EXTRACT = path.join(ROOT, '.codex-tmp/meshy-athleisure');
const RAW_OUT = path.join(ROOT, 'public/assets/simoutfits/_raw/male-athleisure.glb');
const ID = 'male-athleisure';

const zip = path.resolve(process.argv[2] ?? DEFAULT_ZIP);
if (!fs.existsSync(zip)) {
  console.error(`Missing zip: ${zip}`);
  process.exit(2);
}
if (!fs.existsSync(BLENDER)) {
  console.error(`Blender not found: ${BLENDER}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    throw new Error(`${cmd} failed with status ${res.status}`);
  }
  return res;
}

fs.mkdirSync(EXTRACT, { recursive: true });
fs.mkdirSync(path.dirname(RAW_OUT), { recursive: true });

// Extract
run('bsdtar', ['-xf', zip, '-C', EXTRACT]);

// Find FBX
function findFbx(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFbx(p);
      if (hit) return hit;
    } else if (e.name.toLowerCase().endsWith('.fbx')) {
      return p;
    }
  }
  return null;
}

const fbx = findFbx(EXTRACT);
if (!fbx) throw new Error('No FBX in archive');
console.log(`[meshy-athleisure] cloth ${fbx}`);

const body = path.join(ROOT, 'public/assets/simhuman/ubc-male.glb');
if (!fs.existsSync(body)) throw new Error(`Missing body ${body}`);

// 1) Align + weight transfer
run(BLENDER, [
  '--background',
  '--python', path.join(ROOT, 'scripts/prepare-unrigged-outfit.py'),
  '--',
  '--cloth', fbx,
  '--body', body,
  '--output', RAW_OUT,
  // Height ease 1.0 (hoodie top → crown). Width uses torso radial fit (not AABB).
  '--ease', '1.0',
  '--width-ease', '1.10',
  '--max-verts', '70000',
  '--max-texture', '2048',
]);

if (!fs.existsSync(RAW_OUT)) throw new Error('raw GLB not written');
console.log(`[meshy-athleisure] raw ${(fs.statSync(RAW_OUT).size / 1048576).toFixed(2)} MiB`);

// 2) Bake bulk morphs from male body onto raw (in-place intermediate)
const bakedRaw = path.join(ROOT, 'public/assets/simoutfits/_raw/male-athleisure.morph-src.glb');
run(BLENDER, [
  '--background',
  '--python', path.join(ROOT, 'scripts/bake-outfit-morphs.py'),
  '--',
  '--body', body,
  '--outfit', RAW_OUT,
  '--output', bakedRaw,
  '--max-dist', '0.16',
  '--ease', '1.08',
  '--report', path.join(ROOT, '.codex-tmp/outfit-morph-bake/male-athleisure.json'),
]);

// 3) Dual variants
run(process.execPath, [
  path.join(ROOT, 'scripts/optimize-sim-outfit-variants.mjs'),
  '--input', bakedRaw,
  '--id', ID,
]);

// 4) Root copy of standard for legacy path convenience
const std = path.join(ROOT, 'public/assets/simoutfits/standard', `${ID}.glb`);
const rootCopy = path.join(ROOT, 'public/assets/simoutfits', `${ID}.glb`);
fs.copyFileSync(std, rootCopy);

const morph = path.join(ROOT, 'public/assets/simoutfits/morph', `${ID}.glb`);
console.log('\n[meshy-athleisure] done');
console.log(`  standard ${(fs.statSync(std).size / 1048576).toFixed(2)} MiB → ${path.relative(ROOT, std)}`);
console.log(`  morph    ${(fs.statSync(morph).size / 1048576).toFixed(2)} MiB → ${path.relative(ROOT, morph)}`);
console.log(`  root     ${path.relative(ROOT, rootCopy)}`);
