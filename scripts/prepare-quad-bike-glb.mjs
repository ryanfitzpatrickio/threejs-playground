#!/usr/bin/env node
/**
 * Strip embedded Tripo textures from the quad shell and compress mesh data.
 * Runtime materials are assigned from the quad-bike part profile.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, dequantize, draco, flatten, prune } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const ROOT = path.resolve(import.meta.dirname, '..');
const [input, output = path.join(ROOT, 'public/assets/models/quad-bike.glb')] = process.argv.slice(2);
if (!input) {
  console.error('Usage: prepare-quad-bike-glb.mjs <input.glb> [output.glb]');
  process.exit(1);
}

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

const beforeSize = (await readFile(input)).length;
const document = await io.read(input);
await document.transform(dequantize());

const root = document.getRoot();
for (const material of root.listMaterials()) {
  material.setBaseColorTexture(null);
  material.setNormalTexture(null);
  material.setMetallicRoughnessTexture(null);
  material.setOcclusionTexture(null);
  material.setEmissiveTexture(null);
  material.setBaseColorFactor([0.72, 0.74, 0.78, 1]);
  material.setMetallicFactor(0);
  material.setRoughnessFactor(0.5);
  material.setEmissiveFactor([0, 0, 0]);
}

root.listTextures().forEach((texture) => texture.dispose());

await document.transform(
  dedup(),
  flatten(),
  prune(),
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
);

const outDir = path.dirname(output);
if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
const glb = await io.writeBinary(document);
await writeFile(output, glb);

const sourceDir = path.join(ROOT, 'assets-source/models');
if (!existsSync(sourceDir)) await mkdir(sourceDir, { recursive: true });
const sourceCopy = path.join(sourceDir, 'quad-bike-source.glb');
if (path.resolve(input) !== path.resolve(sourceCopy) && !existsSync(sourceCopy)) {
  await copyFile(input, sourceCopy);
}

console.log(`Prepared ${path.relative(ROOT, output)}`);
console.log(`  ${(beforeSize / 1024 / 1024).toFixed(2)} MB → ${(glb.byteLength / 1024).toFixed(0)} KB (textures stripped)`);
