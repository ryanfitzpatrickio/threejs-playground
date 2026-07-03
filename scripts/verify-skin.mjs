#!/usr/bin/env node
/**
 * Regression check for the Mara/climber GLB skinning pipeline.
 *
 * Replicates createMaraFbxModel's GLB handling (flatten → stand upright →
 * normalize to TARGET height) and reports the skinned bind-pose WORLD bounding
 * box. A correctly-built character normalizes to ~1.72 m tall with a humanlike
 * silhouette; a broken one (e.g. if someone re-adds skeleton.calculateInverses(),
 * which fights the frozen bindMatrix) collapses or explodes.
 *
 * Usage: node scripts/verify-skin.mjs [file.glb ...]
 *
 * Draco/quantized inputs are decoded to plain float via gltf-transform first so
 * the bare GLTFLoader can parse them without browser DRACOLoader workers; three's
 * in-browser DRACOLoader produces the same float geometry.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { flattenObjectForWebGPU } from '../src/game/geometry/prepareWebGPUGeometry.js';

globalThis.window ??= {};
globalThis.self ??= globalThis;

const TARGET_CHARACTER_HEIGHT = 1.72;
const _normalizeVec = new THREE.Vector3();

const _io = await new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

async function toPlainGlb(file) {
  const doc = await _io.read(file);
  await doc.transform(dequantize());
  const ext = doc
    .getRoot()
    .listExtensionsUsed()
    .find((e) => e.extensionName === 'KHR_draco_mesh_compression');
  if (ext) ext.dispose();
  return _io.writeBinary(doc);
}

function normalizeCharacterObject(object) {
  const box = new THREE.Box3();
  object.updateMatrixWorld(true);
  const bones = new Set();
  object.traverse((child) => {
    if (child.isSkinnedMesh && child.skeleton) {
      for (const bone of child.skeleton.bones) bones.add(bone);
    }
  });
  let usedBones = false;
  for (const bone of bones) {
    bone.updateMatrixWorld();
    box.expandByPoint(_normalizeVec.setFromMatrixPosition(bone.matrixWorld));
    usedBones = true;
  }
  if (!usedBones) box.setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = TARGET_CHARACTER_HEIGHT / size.y;
  object.scale.setScalar(scale);
  object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  return scale;
}

async function loadGlb(file) {
  const glb = await toPlainGlb(file);
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  return new GLTFLoader().parseAsync(ab, '');
}

async function run(file) {
  console.log('\n==============================');
  console.log(file);
  let gltf;
  try {
    gltf = await loadGlb(file);
  } catch (e) {
    console.log('LOAD ERROR:', e.message);
    return;
  }

  const group = new THREE.Group();
  const object = gltf.scene || gltf;
  object.updateMatrixWorld(true);
  object.traverse((c) => {
    if (c.isSkinnedMesh && c.skeleton) c.skeleton.update();
  });

  // Mirror createMaraFbxModel: flatten for WebGPU, stand upright, normalize.
  // Crucially we do NOT call skeleton.calculateInverses() — the authored
  // inverse-binds are correct and recomputing them deforms the mesh.
  flattenObjectForWebGPU(object);
  object.rotation.x = -Math.PI / 2;
  object.updateMatrixWorld(true);
  const modelScale = normalizeCharacterObject(object);
  object.updateMatrixWorld(true);
  object.traverse((c) => {
    if (c.isSkinnedMesh && c.skeleton) c.skeleton.update();
  });
  group.add(object);
  group.updateMatrixWorld(true);

  const worldBox = new THREE.Box3();
  const tmp = new THREE.Vector3();
  let verts = 0;
  object.traverse((c) => {
    if (!c.isSkinnedMesh) return;
    c.updateMatrixWorld(true);
    c.skeleton.update();
    const pos = c.geometry.getAttribute('position');
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      tmp.fromBufferAttribute(pos, i);
      c.applyBoneTransform(i, tmp);
      c.localToWorld(tmp);
      worldBox.expandByPoint(tmp);
      verts++;
    }
  });
  const size = worldBox.getSize(new THREE.Vector3());
  console.log('modelScale', modelScale.toExponential(3));
  console.log(
    'skinned bind-pose WORLD size  H x W x D =',
    size.y.toFixed(3), 'x', size.x.toFixed(3), 'x', size.z.toFixed(3),
    `(${verts} samples)`,
  );
  const ok = size.y > 1.4 && size.y < 2.2 && size.x < 1.6 && size.z < 1.6;
  console.log(ok ? '  => LOOKS CORRECT (humanlike ~1.72m)' : '  => DEFORMED / WRONG SCALE');
}

const files = process.argv.slice(2);
if (!files.length) files.push('public/assets/models/climber.glb');
for (const f of files) await run(f);
