#!/usr/bin/env node
/**
 * Prepare runtime hair-cap GLBs from Meshy (or similar) part-segmentation packs.
 *
 * Chestnut Cascade source keeps **mesh 7 only** (0-based index 6) — the other
 * part meshes are segmentation LODs / alternate shells.
 *
 * Usage:
 *   node scripts/prepare-sim-hair.mjs
 *   node scripts/prepare-sim-hair.mjs --input path/to/pack.glb --id chestnut-cascade --keep-mesh 6
 */
import { mkdirSync, copyFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, prune, dedup, draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const id = arg('--id', 'chestnut-cascade');
const keepMesh = Number(arg('--keep-mesh', '6'));
const defaultInput = path.join(
  process.env.HOME ?? '',
  'Downloads',
  'Meshy_AI_Chestnut Cascade_1784167305_part-segmentation.glb',
);
const input = path.resolve(arg('--input', defaultInput));
const sourceDir = path.join(root, 'assets-source/simhair');
const outDir = path.join(root, 'public/assets/simhair');
const outPath = path.join(outDir, `${id}.glb`);

if (!existsSync(input)) {
  console.error(`Input not found: ${input}`);
  process.exit(1);
}
if (!Number.isInteger(keepMesh) || keepMesh < 0) {
  console.error(`--keep-mesh must be a non-negative integer (got ${keepMesh})`);
  process.exit(1);
}

mkdirSync(sourceDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(input, path.join(sourceDir, `${id}.raw.glb`));

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

const doc = await io.read(input);
await doc.transform(dequantize());
const meshes = doc.getRoot().listMeshes();
if (keepMesh >= meshes.length) {
  console.error(`keep-mesh ${keepMesh} out of range (pack has ${meshes.length} meshes)`);
  process.exit(1);
}
const keep = meshes[keepMesh];
const verts = keep.listPrimitives()[0]?.getAttribute('POSITION')?.getCount() ?? 0;
console.log(`Keeping mesh[${keepMesh}] (1-based mesh ${keepMesh + 1}) verts=${verts}`);

for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (mesh && mesh !== keep) node.setMesh(null);
}
for (const mesh of meshes) {
  if (mesh !== keep) mesh.dispose();
}
await doc.transform(prune(), dedup());
await doc.transform(
  draco({ method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5, quantizePosition: 14 }),
);
await io.write(outPath, doc);
const mb = (statSync(outPath).size / (1024 * 1024)).toFixed(2);
console.log(`Wrote ${outPath} (${mb} MiB)`);
