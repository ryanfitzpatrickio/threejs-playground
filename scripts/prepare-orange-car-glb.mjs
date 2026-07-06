#!/usr/bin/env node
/**
 * Bake Meshy segmentation exports to ~1 m so garage chassis scale stays in range.
 */
import { NodeIO } from '@gltf-transform/core';
import { dequantize } from '@gltf-transform/functions';

const [input, output, targetLength = '1'] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: prepare-orange-car-glb.mjs <input.glb> <output.glb> [targetLengthMetres]');
  process.exit(1);
}

const target = Number(targetLength);
const io = new NodeIO();
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

await io.write(output, document);
console.log(`Prepared ${output} (${extent.toFixed(4)} → ${target} m, scale ${scale.toExponential(3)})`);
