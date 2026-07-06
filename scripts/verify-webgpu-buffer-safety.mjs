import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sanitizeWebGPUVertexBuffers } from '../src/game/geometry/prepareWebGPUGeometry.js';

const root = new THREE.Group();

const zeroCapacity = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial(),
  0,
);
zeroCapacity.name = 'zero-capacity';
root.add(zeroCapacity);

const reservedButEmpty = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial(),
  1,
);
reservedButEmpty.name = 'reserved-but-empty';
reservedButEmpty.count = 0;
root.add(reservedButEmpty);

const emptySkin = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1));
emptySkin.name = 'empty-skin';
root.add(emptySkin);

const bone = new THREE.Bone();
const repairableSkin = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1));
repairableSkin.name = 'repairable-skin';
repairableSkin.bind(new THREE.Skeleton([bone]));
repairableSkin.skeleton.boneMatrices = new Float32Array(0);
root.add(repairableSkin);

const missingUvGeometry = new THREE.BufferGeometry();
missingUvGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
], 3));
const missingUv = new THREE.Mesh(missingUvGeometry, new THREE.MeshStandardMaterial());
missingUv.name = 'missing-uv';
root.add(missingUv);

const result = sanitizeWebGPUVertexBuffers(root, { warn: () => {} });

assert.deepEqual(result.removed.sort(), ['empty-skin', 'zero-capacity']);
assert.deepEqual(result.repaired, ['repairable-skin']);
assert.deepEqual(result.uvRepaired, ['missing-uv']);
assert.equal(zeroCapacity.parent, null);
assert.equal(emptySkin.parent, null);
assert.equal(reservedButEmpty.parent, root, 'positive-capacity dynamic mesh must remain');
assert.equal(repairableSkin.parent, root);
assert.equal(repairableSkin.skeleton.boneMatrices.byteLength, 64);
assert.equal(missingUv.geometry.getAttribute('uv').count, 3);

console.log('WebGPU vertex-buffer safety verification passed.');
