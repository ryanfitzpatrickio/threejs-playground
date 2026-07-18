// Iteration harness: apply a candidate outfitLoopCuts JSON to an outfit GLB
// and dump kept-triangle soup for external rendering.
// Usage: node scripts/probe-loop-cut-candidate.mjs <outfit.glb> <cuts.json> <out.json>
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import * as THREE from 'three';
import { installOutfitLoopCuts, sanitizeOutfitLoopCuts } from '../src/game/characters/simhuman/outfitLoopCuts.js';

const [file, cutsPath, outPath] = process.argv.slice(2);
if (!file || !cutsPath || !outPath) throw new Error('usage: glb cuts.json out.json');
const cuts = sanitizeOutfitLoopCuts(JSON.parse(fs.readFileSync(cutsPath, 'utf8')));
console.log('sanitized cuts:', JSON.stringify(cuts.map((c) => ({ ...c, points: c.points.length, frame: undefined }))));

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});
const document = await io.read(path.resolve(file));
const meshes = [];
for (const node of document.getRoot().listNodes()) {
  const sourceMesh = node.getMesh();
  if (!sourceMesh || !node.getSkin()) continue;
  for (const primitive of sourceMesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    if (!position) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position.getArray(), 3));
    const idx = primitive.getIndices();
    if (idx) geometry.setIndex(new THREE.BufferAttribute(idx.getArray(), 1));
    else geometry.setIndex([...Array(position.getCount()).keys()]);
    meshes.push(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
  }
}
const handle = installOutfitLoopCuts(meshes, cuts);
console.log(`triangles: source=${handle.sourceTriangles} visible=${handle.visibleTriangles} removed=${handle.sourceTriangles - handle.visibleTriangles}`);
const kept = [];
for (const mesh of meshes) {
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getIndex().array;
  for (let o = 0; o + 2 < idx.length; o += 3) {
    kept.push([
      pos.getX(idx[o]), pos.getY(idx[o]), pos.getZ(idx[o]),
      pos.getX(idx[o + 1]), pos.getY(idx[o + 1]), pos.getZ(idx[o + 1]),
      pos.getX(idx[o + 2]), pos.getY(idx[o + 2]), pos.getZ(idx[o + 2]),
    ]);
  }
}
fs.writeFileSync(outPath, JSON.stringify(kept));
console.log(`wrote ${kept.length} kept triangles to ${outPath}`);
