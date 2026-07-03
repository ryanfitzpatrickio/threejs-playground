#!/usr/bin/env node
/**
 * Load each skinned GLB through the REAL three.js GLTFLoader (same path the app uses)
 * and report what three.js actually produces — to localize the "spike" cause:
 *   (a) rest-pose POSITION already exploded (asset/decode problem), or
 *   (b) rest fine but skinning scatters vertices (skeleton/bone problem).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

// minimal Node shims three's loaders need
globalThis.window ??= {};
globalThis.self ??= globalThis;

const FILES = {
  climber: 'public/assets/models/climber.glb',
  enemy1: 'public/assets/models/enemy1.glb',
  horse: 'public/assets/models/horse-rigged.glb',
};

function makeLoader() {
  const l = new GLTFLoader();
  const d = new DRACOLoader();
  d.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
  l.setDRACOLoader(d);
  return l;
}

const _q = new THREE.Quaternion(); const _s = new THREE.Vector3(); const _v = new THREE.Vector3();

async function loadGlb(url) {
  const buf = await readFile(url);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return makeLoader().parseAsync(ab, '');
}

function attrStats(attr) {
  if (!attr) return null;
  // Use getX/getY/... so we read the *attribute's* values even when it is an
  // InterleavedBufferAttribute (iterating .array directly would cross strides).
  const itemSize = attr.itemSize;
  const count = attr.count;
  const getters = [attr.getX.bind(attr), attr.getY.bind(attr), attr.getZ.bind(attr), attr.getW.bind(attr)];
  let min = Infinity, max = -Infinity, nan = 0;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < itemSize; c++) {
      const v = Number(getters[c](i));
      if (Number.isNaN(v)) nan++;
      else { if (v < min) min = v; if (v > max) max = v; }
    }
  }
  return {
    ctor: attr.array?.constructor?.name,
    interleaved: !!attr.isInterleavedBufferAttribute,
    itemSize, normalized: attr.normalized, count, min, max, nan,
  };
}

// Replicate SkinnedMesh.applyBoneTransform to sample a skinned vertex.
function skinnedVertex(mesh, index, target = new THREE.Vector3()) {
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  target.fromBufferAttribute(position, index);
  const skeleton = mesh.skeleton;
  if (!skeleton) return target;
  const skinIndex = geometry.attributes.skinIndex;
  const skinWeight = geometry.attributes.skinWeight;
  const boneIndices = [skinIndex.getX(index), skinIndex.getY(index), skinIndex.getZ(index), skinIndex.getW(index)];
  const weights = [skinWeight.getX(index), skinWeight.getY(index), skinWeight.getZ(index), skinWeight.getW(index)];
  const _vector = new THREE.Vector3();
  for (let i = 0; i < 4; i++) {
    const w = weights[i];
    if (w === 0) continue;
    const bone = skeleton.bones[boneIndices[i]];
    if (!bone) { console.log(`    !! bone[${boneIndices[i]}] missing (bones=${skeleton.bones.length})`); continue; }
    bone.updateMatrixWorld();
    bone.matrixWorld.decompose(_vector, _q, _s);
    _vector.copy(target).applyMatrix4(bone.matrixWorld);
    target.addScaledVector(_vector, w);
  }
  return target;
}

for (const [key, file] of Object.entries(FILES)) {
  console.log('\n========================================');
  console.log(key, ':', file);
  try {
    const gltf = await loadGlb(path.resolve(file));
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    let inspected = 0;
    root.traverse((child) => {
      if (!child.isSkinnedMesh || inspected) return;
      inspected++;
      const g = child.geometry;
      child.updateMatrixWorld(true);
      if (child.skeleton) child.skeleton.update();

      const pos = attrStats(g.getAttribute('position'));
      const si = g.getAttribute('skinIndex');
      const sw = g.getAttribute('skinWeight');
      console.log(`  SkinnedMesh "${child.name}" bones=${child.skeleton?.bones?.length}`);
      console.log('  POSITION  ', JSON.stringify(pos));
      // REST box from raw positions
      const rb = new THREE.Box3();
      const pa = g.getAttribute('position');
      for (let i = 0; i < pa.count; i++) rb.expandByPoint(_v.fromBufferAttribute(pa, i));
      console.log(`  REST box (raw pos): min=[${rb.min.x.toFixed(2)},${rb.min.y.toFixed(2)},${rb.min.z.toFixed(2)}] size=${rb.getSize(new THREE.Vector3()).length().toFixed(2)}`);
      if (si) {
        const sis = attrStats(si);
        const inRange = sis.max < (child.skeleton?.bones?.length ?? 0);
        console.log('  skinIndex ', JSON.stringify(sis), inRange ? '✅ in range' : '❌ OUT OF RANGE');
      }
      if (sw) console.log('  skinWeight', JSON.stringify(attrStats(sw)));

      // sample a few skinned vertices (bind pose) to see if skinning explodes them
      console.log('  skinned-vertex samples (bind):');
      const samples = [0, (pa.count / 2) | 0, pa.count - 1];
      for (const idx of samples) {
        const p = new THREE.Vector3().fromBufferAttribute(pa, idx);
        const sk = skinnedVertex(child, idx);
        const drift = sk.length() - p.length();
        console.log(`    v${idx}: rest=[${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}] skinned=[${sk.x.toFixed(2)},${sk.y.toFixed(2)},${sk.z.toFixed(2)}] |drift|=${drift.toFixed(2)}`);
      }
    });
    if (!inspected) console.log('  (no SkinnedMesh found)');
  } catch (e) {
    console.log('  LOAD ERROR:', e.message);
  }
}
