#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, dequantize, draco, prune, simplify, textureResize } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const input = path.resolve(process.argv[2] ?? path.join(ROOT, 'assets-source/models/player-sunglasses-source.glb'));
const output = path.resolve(process.argv[3] ?? path.join(ROOT, 'public/assets/models/player-sunglasses.glb'));
const TARGET_WIDTH = 0.15;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const before = await readFile(input).catch((error) => {
  throw new Error(`Missing sunglasses source asset: ${input}`, { cause: error });
});
const preservedSource = path.join(ROOT, 'assets-source/models/player-sunglasses-source.glb');
if (input !== preservedSource) {
  await mkdir(path.dirname(preservedSource), { recursive: true });
  await writeFile(preservedSource, before, { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
}
const document = await io.readBinary(before);
await document.transform(dequantize());

const root = document.getRoot();
const scene = root.getDefaultScene() ?? root.listScenes()[0];
if (!scene) throw new Error('Sunglasses GLB contains no scene.');

const bounds = getBounds(scene);
const width = bounds.max[0] - bounds.min[0];
if (!Number.isFinite(width) || width <= 0) throw new Error('Sunglasses GLB has invalid X-axis bounds.');
const center = bounds.min.map((value, axis) => (value + bounds.max[axis]) * 0.5);
const scale = TARGET_WIDTH / width;

scene.traverse((node) => {
  const mesh = node.getMesh();
  if (!mesh) return;
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    if (!position) continue;
    const value = [0, 0, 0];
    for (let i = 0; i < position.getCount(); i += 1) {
      position.getElement(i, value);
      position.setElement(i, value.map((component, axis) => (component - center[axis]) * scale));
    }
  }
});

const originalVertices = countVertices(root);
// Meshoptimizer welds shared vertices before applying this ratio, so aiming a
// little below the final budget reliably lands this asset in the 25–35k band.
const ratio = Math.min(1, Math.max(0.05, 27000 / originalVertices));
await document.transform(
  dedup(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.001, lockBorder: true }),
  prune(),
  textureResize({ size: [1024, 1024] }),
);

for (const texture of root.listTextures()) {
  const image = texture.getImage();
  if (!image) continue;
  const hasAlpha = texture.getMimeType() === 'image/png';
  const pipeline = sharp(image).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true });
  texture.setImage(hasAlpha
    ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer());
  texture.setMimeType(hasAlpha ? 'image/png' : 'image/jpeg');
}

await document.transform(draco({
  method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5,
  quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12,
  quantizeColor: 8, quantizeGeneric: 12,
}));

const binary = await io.writeBinary(document);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, binary);
console.log(`Prepared ${path.relative(ROOT, output)}: ${countVertices(root).toLocaleString()} vertices, ${(binary.byteLength / 1048576).toFixed(2)} MB, width ${TARGET_WIDTH} m`);
if (binary.byteLength >= 5 * 1048576) throw new Error('Runtime sunglasses asset exceeds the 5 MB budget.');

function getBounds(targetScene) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  targetScene.traverse((node) => {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const position = primitive.getAttribute('POSITION');
      const value = [0, 0, 0];
      for (let i = 0; position && i < position.getCount(); i += 1) {
        position.getElement(i, value);
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], value[axis]);
          max[axis] = Math.max(max[axis], value[axis]);
        }
      }
    }
  });
  return { min, max };
}

function countVertices(targetRoot) {
  return targetRoot.listMeshes().reduce((total, mesh) => total + mesh.listPrimitives().reduce(
    (meshTotal, primitive) => meshTotal + (primitive.getAttribute('POSITION')?.getCount() ?? 0), 0,
  ), 0);
}
