#!/usr/bin/env node
/**
 * Prepare Quaternius Modular Character Outfits - Fantasy for the Sim runtime.
 *
 * The source glTFs use the same UE skeleton as Universal Base Characters but
 * are authored at ~1.8 units tall. We downscale the 4K outfit maps to 2K, then
 * use the existing Blender normalizer with the exact matching UBC source-body
 * scale factor. This produces self-contained GLBs in the prepared UBC bind space
 * even when an outfit stops below the head and is not itself 3.49 units tall.
 *
 * Usage:
 *   node scripts/prepare-sim-outfits.mjs /path/to/Modular\ Character\ Outfits\ -\ Fantasy[Standard].zip
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLENDER = process.env.BLENDER_BIN
  ?? '/Applications/Blender.app/Contents/MacOS/Blender';
const PREPARE_SCRIPT = path.join(ROOT, 'scripts/prepare-simhuman-glb.py');
const OUTPUT_DIR = path.join(ROOT, 'public/assets/simoutfits');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const OUTFITS = Object.freeze([
  ['Female_Peasant', 'female-peasant.glb'],
  ['Female_Ranger', 'female-ranger.glb'],
  ['Male_Peasant', 'male-peasant.glb'],
  ['Male_Ranger', 'male-ranger.glb'],
]);
const BODY_SOURCES = Object.freeze({
  Female: path.join(
    ROOT,
    'assets-source/universal-base-characters/gltf/Superhero_Female_FullBody.gltf',
  ),
  Male: path.join(
    ROOT,
    'assets-source/universal-base-characters/gltf/Superhero_Male_FullBody.gltf',
  ),
});

const archive = path.resolve(process.argv[2] ?? '');
if (!archive || !fs.existsSync(archive)) {
  console.error('Usage: node scripts/prepare-sim-outfits.mjs <Fantasy[Standard].zip>');
  process.exit(2);
}
if (!fs.existsSync(BLENDER)) {
  console.error(`Blender not found: ${BLENDER}`);
  process.exit(1);
}

const listing = run('unzip', ['-Z1', archive]).stdout.split(/\r?\n/).filter(Boolean);
const outfitPrefix = listing.find((entry) => entry.endsWith('/Outfits/Female_Peasant.gltf'))
  ?.replace(/Female_Peasant\.gltf$/, '');
if (!outfitPrefix) throw new Error('Archive does not contain the expected complete glTF outfits');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamfall-sim-outfits-'));
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

try {
  const referenced = new Set();
  for (const [sourceName] of OUTFITS) {
    for (const extension of ['gltf', 'bin']) {
      const filename = `${sourceName}.${extension}`;
      extract(`${outfitPrefix}${filename}`, path.join(tempDir, filename));
    }
    const document = JSON.parse(fs.readFileSync(path.join(tempDir, `${sourceName}.gltf`), 'utf8'));
    for (const image of document.images ?? []) {
      if (image.uri && !image.uri.startsWith('data:')) referenced.add(image.uri);
    }
  }

  for (const filename of referenced) {
    const source = extractBuffer(`${outfitPrefix}${filename}`);
    const output = path.join(tempDir, filename);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const metadata = await sharp(source).metadata();
    if ((metadata.width ?? 0) > 2048 || (metadata.height ?? 0) > 2048) {
      await sharp(source)
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(output);
    } else {
      fs.writeFileSync(output, source);
    }
  }

  for (const [sourceName, outputName] of OUTFITS) {
    const gender = sourceName.startsWith('Female_') ? 'Female' : 'Male';
    const bodyDocument = JSON.parse(fs.readFileSync(BODY_SOURCES[gender], 'utf8'));
    const outfitDocument = JSON.parse(
      fs.readFileSync(path.join(tempDir, `${sourceName}.gltf`), 'utf8'),
    );
    const bodyScale = 3.49 / positionYSpan(bodyDocument);
    const targetOutfitHeight = positionYSpan(outfitDocument) * bodyScale;
    const output = path.join(OUTPUT_DIR, outputName);
    run(BLENDER, [
      '--background',
      '--python', PREPARE_SCRIPT,
      '--',
      '--input', path.join(tempDir, `${sourceName}.gltf`),
      '--output', output,
      '--mode', 'normalize',
      '--target-height', String(targetOutfitHeight),
      '--keep-materials',
    ], { inherit: true });
    const bytes = fs.statSync(output).size;
    if (bytes >= MAX_FILE_BYTES) {
      throw new Error(`${outputName} is ${(bytes / 1048576).toFixed(1)} MiB (must stay below 25 MiB)`);
    }
    console.log(`[prepare-sim-outfits] ${outputName}: ${(bytes / 1048576).toFixed(1)} MiB`);
  }

  const licenseEntry = listing.find((entry) => entry.endsWith('/License_Standard.txt'));
  const readmeEntry = listing.find((entry) => entry.endsWith('/Readme.txt'));
  if (licenseEntry) fs.writeFileSync(path.join(OUTPUT_DIR, 'LICENSE.txt'), extractBuffer(licenseEntry));
  if (readmeEntry) fs.writeFileSync(path.join(OUTPUT_DIR, 'UPSTREAM-README.txt'), extractBuffer(readmeEntry));
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'SOURCE.md'),
    '# Modular Character Outfits - Fantasy [Standard]\n\n'
    + '- Author: Quaternius (@Quaternius)\n'
    + '- Source: https://quaternius.com/packs/modularcharacteroutfitsfantasy.html\n'
    + '- License: CC0 1.0 Universal (see LICENSE.txt)\n'
    + '- Local preparation: complete glTF outfits scaled by the matching prepared UBC body factor; 4K outfit maps resized to 2K; textures embedded in each GLB.\n',
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function extract(entry, output) {
  fs.writeFileSync(output, extractBuffer(entry));
}

function extractBuffer(entry) {
  // unzip treats member arguments as patterns; escape literal opening brackets
  // such as the archive's `Fantasy[Standard]` directory.
  const memberPattern = entry.replaceAll('[', '[[]');
  return run('unzip', ['-p', archive, memberPattern], { encoding: null }).stdout;
}

function positionYSpan(document) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessor = document.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      minY = Math.min(minY, accessor.min[1]);
      maxY = Math.max(maxY, accessor.max[1]);
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) {
    throw new Error('Could not determine glTF position Y span');
  }
  return maxY - minY;
}

function run(command, args, { inherit = false, encoding = 'utf8' } = {}) {
  const result = spawnSync(command, args, inherit
    ? { stdio: 'inherit' }
    : { encoding, maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr?.toString?.() ?? ''}`);
  }
  return result;
}
