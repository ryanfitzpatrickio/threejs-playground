#!/usr/bin/env node
/**
 * Bake Meshy ATV tire exports to ~0.7 m diameter and compress embedded textures.
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, dequantize, draco, prune, textureResize } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const [input, output = path.join(ROOT, 'public/assets/models/quad-tire.glb'), targetLength = '0.7'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: prepare-quad-tire-glb.mjs <input.glb> [output.glb] [targetDiameterMetres]');
  process.exit(1);
}

const target = Number(targetLength);
if (!Number.isFinite(target) || target <= 0) {
  console.error('targetDiameterMetres must be a positive number');
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
const scene = root.getDefaultScene() ?? root.listScenes()[0];
let min = [Infinity, Infinity, Infinity];
let max = [-Infinity, -Infinity, -Infinity];

scene.traverse((node) => {
  const mesh = node.getMesh();
  if (!mesh) return;
  for (const prim of mesh.listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    if (!position) continue;
    const scratch = [0, 0, 0];
    for (let i = 0; i < position.getCount(); i += 1) {
      position.getElement(i, scratch);
      min[0] = Math.min(min[0], scratch[0]);
      min[1] = Math.min(min[1], scratch[1]);
      min[2] = Math.min(min[2], scratch[2]);
      max[0] = Math.max(max[0], scratch[0]);
      max[1] = Math.max(max[1], scratch[1]);
      max[2] = Math.max(max[2], scratch[2]);
    }
  }
});

const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
const scale = target / extent;
const center = min.map((value, index) => (value + max[index]) * 0.5);

scene.traverse((node) => {
  const mesh = node.getMesh();
  if (!mesh) return;
  for (const prim of mesh.listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    if (!position) continue;
    const scratch = [0, 0, 0];
    for (let i = 0; i < position.getCount(); i += 1) {
      position.getElement(i, scratch);
      scratch[0] = (scratch[0] - center[0]) * scale;
      scratch[1] = (scratch[1] - center[1]) * scale;
      scratch[2] = (scratch[2] - center[2]) * scale;
      position.setElement(i, scratch);
    }
  }
});

await document.transform(
  dedup(),
  prune(),
  textureResize({ size: [512, 512] }),
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

for (const texture of root.listTextures()) {
  const image = texture.getImage();
  if (!image) continue;
  const name = String(texture.getName() ?? '').toLowerCase();
  const isNormal = name.includes('normal');
  try {
    const pipeline = sharp(image).resize(512, 512, { fit: 'inside', withoutEnlargement: true });
    const optimized = isNormal
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    texture.setImage(optimized);
    texture.setMimeType(isNormal ? 'image/png' : 'image/jpeg');
  } catch (error) {
    console.warn(`  texture re-encode skipped (${texture.getName()}):`, error.message);
  }
}

const outDir = path.dirname(output);
if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
const glb = await io.writeBinary(document);
await writeFile(output, glb);

const sourceDir = path.join(ROOT, 'assets-source/models');
if (!existsSync(sourceDir)) await mkdir(sourceDir, { recursive: true });
const sourceCopy = path.join(sourceDir, 'quad-tire-source.glb');
if (path.resolve(input) !== path.resolve(sourceCopy) && !existsSync(sourceCopy)) {
  await copyFile(input, sourceCopy);
}

const afterSize = glb.byteLength;
console.log(`Prepared ${path.relative(ROOT, output)}`);
console.log(`  geometry ${extent.toFixed(3)} m → ${target} m diameter`);
console.log(`  file ${(beforeSize / 1024 / 1024).toFixed(2)} MB → ${(afterSize / 1024).toFixed(0)} KB`);
