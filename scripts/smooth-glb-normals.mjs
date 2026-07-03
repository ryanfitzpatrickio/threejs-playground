#!/usr/bin/env node

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? inputPath;
const angleDegrees = Number(process.argv[4] ?? 55);

if (!inputPath || !outputPath || !Number.isFinite(angleDegrees)) {
  console.error('Usage: node scripts/smooth-glb-normals.mjs input.glb [output.glb] [crease-angle-degrees]');
  process.exit(1);
}

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
const document = await io.read(inputPath);
const creaseDot = Math.cos(angleDegrees * Math.PI / 180);
let adjustedVertices = 0;
let tangentSetsRemoved = 0;

for (const mesh of document.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    const positions = primitive.getAttribute('POSITION');
    const normals = primitive.getAttribute('NORMAL');
    if (!positions || !normals) continue;

    const groups = new Map();
    const position = [0, 0, 0];
    const normal = [0, 0, 0];
    for (let index = 0; index < positions.getCount(); index += 1) {
      positions.getElement(index, position);
      normals.getElement(index, normal);
      const key = position.map((value) => Math.round(value * 1e6)).join(',');
      const entries = groups.get(key) ?? [];
      entries.push({ index, normal: [...normal] });
      groups.set(key, entries);
    }

    for (const entries of groups.values()) {
      if (entries.length < 2) continue;
      const clusters = [];
      for (const entry of entries) {
        let best = null;
        let bestDot = creaseDot;
        for (const cluster of clusters) {
          const length = Math.hypot(...cluster.sum) || 1;
          const dot = entry.normal[0] * cluster.sum[0] / length
            + entry.normal[1] * cluster.sum[1] / length
            + entry.normal[2] * cluster.sum[2] / length;
          if (dot >= bestDot) {
            best = cluster;
            bestDot = dot;
          }
        }
        if (!best) {
          best = { sum: [0, 0, 0], entries: [] };
          clusters.push(best);
        }
        best.entries.push(entry);
        best.sum[0] += entry.normal[0];
        best.sum[1] += entry.normal[1];
        best.sum[2] += entry.normal[2];
      }

      for (const cluster of clusters) {
        if (cluster.entries.length < 2) continue;
        const length = Math.hypot(...cluster.sum) || 1;
        const averaged = cluster.sum.map((value) => value / length);
        for (const entry of cluster.entries) {
          normals.setElement(entry.index, averaged);
          adjustedVertices += 1;
        }
      }
    }

    // Existing tangents were generated against the split normals. Removing them
    // makes three.js derive its TBN frame from the corrected normals and UVs.
    if (primitive.getAttribute('TANGENT')) {
      primitive.setAttribute('TANGENT', null);
      tangentSetsRemoved += 1;
    }
  }
}

await io.write(outputPath, document);
console.log(`Smoothed ${adjustedVertices} vertices at ${angleDegrees}°; removed ${tangentSetsRemoved} stale tangent set(s).`);
