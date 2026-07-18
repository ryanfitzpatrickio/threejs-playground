#!/usr/bin/env node
/**
 * Bake essential body bulk morphs onto outfits, then emit dual variants:
 *
 *   standard/<id>.glb  — no morphs, small (Draco)
 *   morph/<id>.glb     — 5 essential morphs, sparse + Draco
 *
 * Essential set (only UBC clothing-relevant morphs that exist):
 *   mass ±, muscle ±, fat +
 * (No body height / breast / hip morphs on this character pack.)
 *
 *   node scripts/bake-outfit-morphs.mjs
 *   node scripts/bake-outfit-morphs.mjs --only male-peasant
 *   node scripts/bake-outfit-morphs.mjs --skip-optimize   # raw bake only
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLENDER = process.env.BLENDER_BIN
  ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const PY = path.join(ROOT, 'scripts/bake-outfit-morphs.py');
const OPTIMIZE = path.join(ROOT, 'scripts/optimize-sim-outfit-variants.mjs');
const RAW_DIR = path.join(ROOT, 'public/assets/simoutfits/_raw');
const REPORT_DIR = path.join(ROOT, '.codex-tmp/outfit-morph-bake');

const JOBS = Object.freeze([
  {
    id: 'male-peasant',
    body: 'public/assets/simhuman/ubc-male.glb',
    // Prefer existing morph bake / standard as source mesh; fall back to root.
    sources: [
      'public/assets/simoutfits/standard/male-peasant.glb',
      'public/assets/simoutfits/male-peasant.glb',
      'public/assets/simoutfits/morph/male-peasant.glb',
    ],
  },
  {
    id: 'male-ranger',
    body: 'public/assets/simhuman/ubc-male.glb',
    sources: [
      'public/assets/simoutfits/standard/male-ranger.glb',
      'public/assets/simoutfits/male-ranger.glb',
      'public/assets/simoutfits/morph/male-ranger.glb',
    ],
  },
  {
    id: 'female-peasant',
    body: 'public/assets/simhuman/ubc-female.glb',
    sources: [
      'public/assets/simoutfits/standard/female-peasant.glb',
      'public/assets/simoutfits/female-peasant.glb',
      'public/assets/simoutfits/morph/female-peasant.glb',
    ],
  },
  {
    id: 'female-ranger',
    body: 'public/assets/simhuman/ubc-female.glb',
    sources: [
      'public/assets/simoutfits/standard/female-ranger.glb',
      'public/assets/simoutfits/female-ranger.glb',
      'public/assets/simoutfits/morph/female-ranger.glb',
    ],
  },
]);

function parseArgs(argv) {
  const out = { only: null, maxDist: 0.14, ease: 1.08, skipOptimize: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--only') out.only = String(argv[++i] ?? '');
    else if (a === '--max-dist') out.maxDist = Number(argv[++i]);
    else if (a === '--ease') out.ease = Number(argv[++i]);
    else if (a === '--skip-optimize') out.skipOptimize = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function resolveSource(job) {
  for (const rel of job.sources) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node scripts/bake-outfit-morphs.mjs [--only id,id] [--max-dist 0.14] [--ease 1.08] [--skip-optimize]`);
  process.exit(0);
}
if (!fs.existsSync(BLENDER)) {
  console.error(`Blender not found: ${BLENDER}`);
  process.exit(1);
}

const only = args.only
  ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const jobs = JOBS.filter((j) => !only || only.has(j.id));
if (!jobs.length) {
  console.error('No jobs matched --only filter');
  process.exit(2);
}

fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

let failed = 0;
for (const job of jobs) {
  const body = path.join(ROOT, job.body);
  const source = resolveSource(job);
  const rawOut = path.join(RAW_DIR, `${job.id}.glb`);
  const report = path.join(REPORT_DIR, `${job.id}.json`);

  if (!fs.existsSync(body)) {
    console.error(`[bake-outfit-morphs] missing body ${body}`);
    failed += 1;
    continue;
  }
  if (!source) {
    console.error(`[bake-outfit-morphs] missing outfit source for ${job.id}`);
    failed += 1;
    continue;
  }

  console.log(`\n[bake-outfit-morphs] === ${job.id} ===`);
  console.log(`[bake-outfit-morphs] source ${path.relative(ROOT, source)}`);

  // If source already has morphs (re-bake), Blender will replace them.
  const bake = spawnSync(BLENDER, [
    '--background',
    '--python', PY,
    '--',
    '--body', body,
    '--outfit', source,
    '--output', rawOut,
    '--max-dist', String(args.maxDist),
    '--ease', String(args.ease),
    '--report', report,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (bake.stdout) process.stdout.write(bake.stdout);
  if (bake.stderr) process.stderr.write(bake.stderr);
  if (bake.status !== 0 || !fs.existsSync(rawOut)) {
    console.error(`[bake-outfit-morphs] FAILED bake ${job.id}`);
    failed += 1;
    continue;
  }

  if (args.skipOptimize) {
    console.log(`[bake-outfit-morphs] raw only: ${path.relative(ROOT, rawOut)}`);
    continue;
  }

  const opt = spawnSync(process.execPath, [
    OPTIMIZE,
    '--input', rawOut,
    '--id', job.id,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (opt.stdout) process.stdout.write(opt.stdout);
  if (opt.stderr) process.stderr.write(opt.stderr);
  if (opt.status !== 0) {
    console.error(`[bake-outfit-morphs] FAILED optimize ${job.id}`);
    failed += 1;
    continue;
  }

  // Compatibility copies at package root → standard (small default for deploy).
  const std = path.join(ROOT, 'public/assets/simoutfits/standard', `${job.id}.glb`);
  const rootCopy = path.join(ROOT, 'public/assets/simoutfits', `${job.id}.glb`);
  fs.copyFileSync(std, rootCopy);
  console.log(`[bake-outfit-morphs] root copy → ${path.basename(rootCopy)} (standard)`);
}

console.log(`\n[bake-outfit-morphs] done — ${jobs.length - failed}/${jobs.length} ok`);
console.log(`[bake-outfit-morphs] variants in public/assets/simoutfits/{standard,morph}/`);
process.exit(failed ? 1 : 0);
