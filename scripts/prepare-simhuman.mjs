#!/usr/bin/env node
/**
 * Node wrapper for scripts/prepare-simhuman-glb.py (Blender headless).
 *
 * Usage:
 *   node scripts/prepare-simhuman.mjs <input.glb> -o public/assets/simhuman/custom.glb
 *   node scripts/prepare-simhuman.mjs <input.glb> --inspect
 *   node scripts/prepare-simhuman.mjs <input.glb> -o out.glb --mode normalize
 *   node scripts/prepare-simhuman.mjs <input.glb> -o out.glb --morph-limit 20
 *   node scripts/prepare-simhuman.mjs <input.glb> -o out.glb --no-transfer-morphs
 *
 * Env:
 *   BLENDER_BIN  — path to Blender executable
 *                  (default: /Applications/Blender.app/Contents/MacOS/Blender)
 *
 * After a successful prepare, runs verify-simhuman-asset in --relaxed mode
 * unless --no-verify is passed.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BLENDER_DEFAULT = '/Applications/Blender.app/Contents/MacOS/Blender';
const PY_SCRIPT = path.join(REPO_ROOT, 'scripts/prepare-simhuman-glb.py');

function printHelp() {
  console.log(`prepare-simhuman — Blender pipeline for simhuman/vibe-human GLBs

Usage:
  node scripts/prepare-simhuman.mjs <input.glb> -o <output.glb> [options]
  node scripts/prepare-simhuman.mjs <input.glb> --inspect

Options:
  -o, --output <path>     Output GLB (required unless --inspect)
  --mode <inspect|normalize|full>   Default: full
  --reference <path>      Morph donor GLB (default: public/assets/simhuman/human5.glb)
  --target-height <n>     Raw mesh Y-span after normalize (default 3.49)
  --morph-limit <n>       Transfer only first N morphs (0 = all)
  --no-rigify             Do not generate Rigify if DEF rig missing
  --no-rename-mixamo      Do not rename Mixamo bones
  --no-transfer-morphs    Skip shape-key projection from reference
  --keep-materials        Do not strip materials/images
  --report-json <path>    Write step report JSON
  --no-verify             Skip verify-simhuman-asset after export
  --strict-verify         Use strict (human5) thresholds instead of --relaxed
  -h, --help              This help

What "full" does:
  1. Import body GLB
  2. Normalize height (~3.49 units, feet at y=0, Y-up)
  3. Rename Mixamo body bones → DEF-* when present
  4. Generate Rigify human + auto-weights if no usable DEF rig
  5. Name eye meshes Eye_L / Eye_R when detectible
  6. Project morphs from human5 onto the body (nearest-surface)
  7. Strip materials/images and export GLB

Limits:
  Morph transfer is a geometric projection from human5, not a new sculpt.
  Face quality depends on how similar the body is to human5.
  Mixamo rename only covers body/fingers — no full Rigify face set.
`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    mode: 'full',
    reference: path.join(REPO_ROOT, 'public/assets/simhuman/human5.glb'),
    targetHeight: null,
    morphLimit: null,
    noRigify: false,
    noRenameMixamo: false,
    noTransferMorphs: false,
    keepMaterials: false,
    reportJson: null,
    noVerify: false,
    strictVerify: false,
    inspect: false,
  };

  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };
    switch (a) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '-o':
      case '--output':
        args.output = next();
        break;
      case '--mode':
        args.mode = next();
        break;
      case '--inspect':
        args.inspect = true;
        args.mode = 'inspect';
        break;
      case '--reference':
        args.reference = path.resolve(next());
        break;
      case '--target-height':
        args.targetHeight = next();
        break;
      case '--morph-limit':
        args.morphLimit = next();
        break;
      case '--no-rigify':
        args.noRigify = true;
        break;
      case '--no-rename-mixamo':
        args.noRenameMixamo = true;
        break;
      case '--no-transfer-morphs':
        args.noTransferMorphs = true;
        break;
      case '--keep-materials':
        args.keepMaterials = true;
        break;
      case '--report-json':
        args.reportJson = path.resolve(next());
        break;
      case '--no-verify':
        args.noVerify = true;
        break;
      case '--strict-verify':
        args.strictVerify = true;
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`Unknown option: ${a}`);
          process.exit(2);
        }
        pos.push(a);
        break;
    }
  }
  if (pos[0]) args.input = path.resolve(pos[0]);
  if (args.output) args.output = path.resolve(args.output);
  return args;
}

function findBlender() {
  const candidates = [
    process.env.BLENDER_BIN,
    BLENDER_DEFAULT,
    'blender',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'blender') return c;
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    printHelp();
    process.exit(2);
  }
  if (!fs.existsSync(args.input)) {
    console.error(`Input not found: ${args.input}`);
    process.exit(1);
  }
  if (!args.inspect && !args.output) {
    console.error('Missing -o/--output (or pass --inspect)');
    process.exit(2);
  }
  if (!fs.existsSync(PY_SCRIPT)) {
    console.error(`Missing Blender script: ${PY_SCRIPT}`);
    process.exit(1);
  }

  const blender = findBlender();
  if (!blender) {
    console.error(
      'Blender not found. Install Blender or set BLENDER_BIN to the executable.\n'
      + `Tried default: ${BLENDER_DEFAULT}`,
    );
    process.exit(1);
  }

  const pyArgs = [
    '--input', args.input,
    '--mode', args.mode,
    '--reference', args.reference,
  ];
  if (args.output) pyArgs.push('--output', args.output);
  if (args.targetHeight != null) pyArgs.push('--target-height', String(args.targetHeight));
  if (args.morphLimit != null) pyArgs.push('--morph-limit', String(args.morphLimit));
  if (args.noRigify) pyArgs.push('--no-rigify');
  if (args.noRenameMixamo) pyArgs.push('--no-rename-mixamo');
  if (args.noTransferMorphs) pyArgs.push('--no-transfer-morphs');
  if (args.keepMaterials) pyArgs.push('--keep-materials');
  if (args.reportJson) pyArgs.push('--report-json', args.reportJson);
  else if (args.output) {
    const report = path.join(
      path.dirname(args.output),
      `${path.basename(args.output, path.extname(args.output))}.prepare-report.json`,
    );
    pyArgs.push('--report-json', report);
  }

  console.log(`[prepare-simhuman] blender=${blender}`);
  console.log(`[prepare-simhuman] ${args.mode}: ${args.input}${args.output ? ` → ${args.output}` : ''}`);

  const result = spawnSync(
    blender,
    ['--background', '--python', PY_SCRIPT, '--', ...pyArgs],
    { stdio: 'inherit', cwd: REPO_ROOT },
  );
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (args.inspect || args.noVerify || !args.output) return;

  const verifyArgs = [path.join(REPO_ROOT, 'scripts/verify-simhuman-asset.mjs'), '--path', args.output];
  if (!args.strictVerify) verifyArgs.push('--relaxed');
  console.log(`[prepare-simhuman] verifying${args.strictVerify ? '' : ' (relaxed)'}…`);
  const verify = spawnSync(process.execPath, verifyArgs, { stdio: 'inherit', cwd: REPO_ROOT });
  if (verify.status !== 0) {
    console.error(
      '[prepare-simhuman] verify reported gaps (expected for WIP bodies).\n'
      + '  Inspect the report JSON next to the output, tweak flags, or sculpt missing morphs.\n'
      + '  Strict human5 parity is optional until you replace the production asset.',
    );
    // Non-zero only if user asked for strict
    if (args.strictVerify) process.exit(verify.status ?? 1);
  }
}

main();
