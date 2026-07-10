#!/usr/bin/env node
/**
 * M0: load each imported gun under node, assert mesh count, real-world bounds,
 * and that attributes are plain floats (no interleaved/unsupported formats).
 *
 * Usage: node scripts/verify-gun-import.mjs
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { GUN_CATALOG } from '../src/game/weapons/gunProfile.js';
import { GUN_ANCHOR_NAMES, createStubAnchors, validateRequiredAnchors } from '../src/game/weapons/gunAnchors.js';
import { flattenObjectForWebGPU } from '../src/game/geometry/prepareWebGPUGeometry.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const GUNS_DIR = path.join(ROOT, 'public/assets/guns');

const io = await new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

async function loadGun(filePath) {
  // Decode Draco → plain floats so bare GLTFLoader can parse without workers.
  const document = await io.read(filePath);
  await document.transform(dequantize());
  const ext = document
    .getRoot()
    .listExtensionsUsed()
    .find((e) => e.extensionName === 'KHR_draco_mesh_compression');
  if (ext) ext.dispose();
  const binary = await io.writeBinary(document);
  const ab = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  return new GLTFLoader().parseAsync(ab, '');
}

const files = (await readdir(GUNS_DIR)).filter((f) => f.endsWith('.glb')).sort();
assert.ok(files.length >= 10, `expected ≥10 guns, found ${files.length}`);

for (const file of files) {
  const filePath = path.join(GUNS_DIR, file);
  const gltf = await loadGun(filePath);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  // Same runtime contract as createGltfLoader consumers: flatten for WebGPU.
  flattenObjectForWebGPU(root);

  let meshCount = 0;
  const badAttrs = [];
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    meshCount += 1;
    const attrs = child.geometry.attributes;
    assert.ok(attrs.position, `${file}: mesh missing position`);
    if (!attrs.normal) badAttrs.push(`${child.name}: missing normal`);
    for (const [key, attr] of Object.entries(attrs)) {
      if (attr.isInterleavedBufferAttribute) {
        badAttrs.push(`${child.name}.${key}: interleaved`);
      }
      if (attr.normalized) {
        badAttrs.push(`${child.name}.${key}: normalized`);
      }
    }
  });

  assert.ok(meshCount >= 4, `${file}: expected several segmented meshes, got ${meshCount}`);
  assert.equal(badAttrs.length, 0, `${file}: ${badAttrs.join('; ')}`);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  assert.ok(longest >= 0.15 && longest <= 1.4, `${file}: longest axis ${longest.toFixed(3)} m outside 0.15–1.4 m`);
  console.log(`  ✓ ${file}: meshes=${meshCount} size=${size.x.toFixed(3)}×${size.y.toFixed(3)}×${size.z.toFixed(3)} longest=${longest.toFixed(3)}m`);
}

// Anchor schema smoke
assert.ok(GUN_ANCHOR_NAMES.includes('grip_mount'));
assert.ok(GUN_ANCHOR_NAMES.includes('muzzle'));
for (const kind of ['rifle', 'pistol', 'shotgun']) {
  const anchors = createStubAnchors(kind);
  const result = validateRequiredAnchors({ weaponKind: kind, anchors });
  assert.equal(result.ok, true, `${kind} stubs missing ${result.missing}`);
}

// Catalog URLs exist
for (const entry of GUN_CATALOG) {
  const name = path.basename(entry.glbUrl);
  assert.ok(files.includes(name), `catalog gun missing file: ${name}`);
}

// catalog.json present
const catalogRaw = await readFile(path.join(GUNS_DIR, 'catalog.json'), 'utf8');
const catalog = JSON.parse(catalogRaw);
assert.ok(catalog.guns?.length >= 10);

console.log(`\nverify-gun-import: ${files.length} guns OK`);
