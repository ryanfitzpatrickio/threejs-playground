#!/usr/bin/env node
/**
 * Produce Standard + Morph-Enabled sim outfit variants from a source GLB.
 *
 *   node scripts/optimize-sim-outfit-variants.mjs \
 *     --input public/assets/simoutfits/_raw/male-peasant.glb \
 *     --id male-peasant
 *
 * Outputs (under public/assets/simoutfits/):
 *   standard/<id>.glb  — no morph targets, Draco + texture optimize (small)
 *   morph/<id>.glb     — only essential bulk morphs, sparse + quantize + Draco
 *
 * Essential morphs (only ones present on UBC vibe-human bodies that affect clothes):
 *   id.body.global.mass.neg/pos, muscle.neg/pos, fat.pos
 * Height is overall body scale (not a clothing morph). Breast/hip are not in this
 * modeling set — do not invent them.
 */

import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  prune,
  draco,
  sparse,
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTFIT_ROOT = path.join(ROOT, 'public/assets/simoutfits');

/** Keep only these morph target names on Morph-Enabled builds. */
export const ESSENTIAL_OUTFIT_MORPHS = Object.freeze([
  'id.body.global.mass.neg',
  'id.body.global.mass.pos',
  'id.body.global.muscle.neg',
  'id.body.global.muscle.pos',
  'id.body.global.fat.pos',
]);

const ESSENTIAL_SET = new Set(ESSENTIAL_OUTFIT_MORPHS);

function parseArgs(argv) {
  const out = { input: null, id: null, maxTexture: 2048 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') out.input = path.resolve(argv[++i] ?? '');
    else if (a === '--id') out.id = String(argv[++i] ?? '');
    else if (a === '--max-texture') out.maxTexture = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function createIo() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.encoder': await draco3d.createEncoderModule(),
      'draco3d.decoder': await draco3d.createDecoderModule(),
    });
}

function humanMiB(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MiB`;
}

/** Zero morph weights so clothes don't spawn fully morphed. */
function zeroMorphWeights(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    const n = mesh.listPrimitives()[0]?.listTargets().length ?? 0;
    if (n > 0) mesh.setWeights(new Array(n).fill(0));
  }
}

/**
 * Keep only essential morph targets on each primitive; drop the rest.
 * Updates mesh.extras.targetNames to match.
 */
function keepEssentialMorphs(doc) {
  let kept = 0;
  let removed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    const extras = { ...(mesh.getExtras() ?? {}) };
    const names = Array.isArray(extras.targetNames) ? [...extras.targetNames] : null;

    for (const prim of mesh.listPrimitives()) {
      const targets = prim.listTargets();
      if (!targets.length) continue;

      // If names missing, keep all (bake should always write targetNames).
      if (!names || names.length !== targets.length) {
        kept += targets.length;
        continue;
      }

      const keepIdx = [];
      const keepNames = [];
      for (let i = 0; i < names.length; i += 1) {
        if (ESSENTIAL_SET.has(names[i])) {
          keepIdx.push(i);
          keepNames.push(names[i]);
        } else {
          removed += 1;
        }
      }

      // Rebuild targets in essential order.
      const ordered = keepIdx.map((i) => targets[i]);
      for (const t of targets) prim.removeTarget(t);
      for (const t of ordered) prim.addTarget(t);
      kept += ordered.length;

      extras.targetNames = keepNames;
    }

    if (extras.targetNames) mesh.setExtras(extras);
    const n = mesh.listPrimitives()[0]?.listTargets().length ?? 0;
    mesh.setWeights(new Array(n).fill(0));
  }
  return { kept, removed };
}

/** Strip all morph targets (Standard variant). */
function stripAllMorphs(doc) {
  let stripped = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const t of prim.listTargets()) {
        prim.removeTarget(t);
        stripped += 1;
      }
    }
    mesh.setWeights([]);
    const extras = { ...(mesh.getExtras() ?? {}) };
    delete extras.targetNames;
    mesh.setExtras(extras);
  }
  return stripped;
}

async function resizeTextures(doc, maxEdge) {
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    try {
      const meta = await sharp(image).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      let pipeline = sharp(image);
      if (w > maxEdge || h > maxEdge) {
        pipeline = pipeline.resize({
          width: maxEdge,
          height: maxEdge,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
      const out = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
      texture.setImage(out);
      texture.setMimeType('image/png');
    } catch (err) {
      console.warn(`  texture optimize skip: ${err.message}`);
    }
  }
}

async function writeVariant(io, doc, outputPath, label) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(outputPath, glb);
  console.log(`  ${label}: ${humanMiB(glb.length)} → ${path.relative(ROOT, outputPath)}`);
  return glb.length;
}

async function optimizeOne(inputPath, id, maxTexture) {
  const io = await createIo();
  const before = (await readFile(inputPath)).length;
  console.log(`\n[optimize-outfits] ${id} source ${humanMiB(before)}`);

  // --- Morph-Enabled ---
  {
    const doc = await io.read(inputPath);
    const { kept, removed } = keepEssentialMorphs(doc);
    zeroMorphWeights(doc);
    console.log(`  morph keep ${kept} targets (removed ${removed} non-essential)`);

    await doc.transform(
      dedup(),
      prune(),
      // Sparse storage for shape-key accessors that are mostly zeros
      // (KHR-style sparse accessors — big win for local morph deltas).
      sparse({ ratio: 0.45 }),
    );
    await resizeTextures(doc, maxTexture);

    // Draco for base mesh attributes. Prefer Draco over KHR_mesh_quantization
    // for skinned outfits: three's DRACOLoader decodes to float32, so inverse
    // binds / WebGPU flatten stay correct. Morph targets remain as sparse
    // accessors alongside the Draco mesh.
    await doc.transform(
      draco({
        method: 'edgebreaker',
        encodeSpeed: 5,
        decodeSpeed: 5,
        quantizePosition: 14,
        quantizeNormal: 10,
        quantizeTexcoord: 12,
        quantizeColor: 8,
        quantizeGeneric: 12,
      }),
      prune(),
    );

    const morphOut = path.join(OUTFIT_ROOT, 'morph', `${id}.glb`);
    await writeVariant(io, doc, morphOut, 'morph');
  }

  // --- Standard (no morphs) ---
  {
    const doc = await io.read(inputPath);
    const stripped = stripAllMorphs(doc);
    console.log(`  standard strip ${stripped} morph targets`);
    await doc.transform(dedup(), prune());
    await resizeTextures(doc, maxTexture);
    await doc.transform(
      draco({
        method: 'edgebreaker',
        encodeSpeed: 5,
        decodeSpeed: 5,
        quantizePosition: 14,
        quantizeNormal: 10,
        quantizeTexcoord: 12,
        quantizeColor: 8,
        quantizeGeneric: 12,
      }),
      prune(),
    );
    const stdOut = path.join(OUTFIT_ROOT, 'standard', `${id}.glb`);
    await writeVariant(io, doc, stdOut, 'standard');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.id) {
    console.log(`Usage: node scripts/optimize-sim-outfit-variants.mjs --input <glb> --id <name> [--max-texture 2048]`);
    process.exit(args.help ? 0 : 2);
  }
  try {
    await access(args.input);
  } catch {
    console.error(`Missing input: ${args.input}`);
    process.exit(1);
  }
  await optimizeOne(args.input, args.id, args.maxTexture);
}

// Allow import of ESSENTIAL_OUTFIT_MORPHS without running CLI.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
