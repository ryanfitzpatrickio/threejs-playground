/**
 * Guards bodyshop cut/join mesh resolution: geometry must be baked into sceneRoot
 * space with identity mesh transforms, not left in source-local space with a
 * decomposed world matrix applied on top.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applySequentialCylinderCuts,
  bakeGeometryToSceneRoot,
  createResolvedMesh,
  createResolvedMeshesFromCut,
  disposeMeshResource,
  finalizeBodyshopGeometry,
  joinBodyshopMeshes,
  replaceMeshWithSplit,
} from '../src/dev/bodyshopMeshOps.js';

function worldBBox(mesh) {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.getAttribute('position');
  const box = new THREE.Box3();
  const vertex = new THREE.Vector3();
  for (let index = 0; index < pos.count; index += 1) {
    vertex.fromBufferAttribute(pos, index).applyMatrix4(mesh.matrixWorld);
    box.expandByPoint(vertex);
  }
  return box;
}

const sceneRoot = new THREE.Group();
sceneRoot.position.set(1, 0, -2);
sceneRoot.rotation.y = THREE.MathUtils.degToRad(15);
sceneRoot.updateMatrixWorld(true);

const source = new THREE.Mesh(
  new THREE.BoxGeometry(2, 1, 3),
  new THREE.MeshStandardMaterial({ color: 0xff0000 }),
);
source.position.set(0.4, 0.2, -0.3);
source.rotation.y = THREE.MathUtils.degToRad(25);
source.scale.set(1.2, 0.9, 1.1);
sceneRoot.add(source);
source.updateMatrixWorld(true);
const worldBox = worldBBox(source);
const worldSize = worldBox.getSize(new THREE.Vector3());

const baked = source.geometry.clone();
bakeGeometryToSceneRoot(baked, source, sceneRoot);
finalizeBodyshopGeometry(baked);
const probe = new THREE.Mesh(baked, new THREE.MeshBasicMaterial());
sceneRoot.add(probe);
const bakedBox = worldBBox(probe);
const bakedSize = bakedBox.getSize(new THREE.Vector3());
assert.ok(Math.abs(bakedSize.x - worldSize.x) < 0.02);
assert.ok(Math.abs(bakedSize.y - worldSize.y) < 0.02);
assert.ok(Math.abs(bakedSize.z - worldSize.z) < 0.02);
sceneRoot.remove(probe);
probe.geometry.dispose();
probe.material.dispose();

const resolved = createResolvedMesh({
  geometry: source.geometry.clone(),
  sourceMesh: source,
  sceneRoot,
  name: 'resolved',
});
sceneRoot.add(resolved);
const resolvedBox = worldBBox(resolved);
const resolvedSize = resolvedBox.getSize(new THREE.Vector3());
assert.equal(resolved.position.x, 0);
assert.equal(resolved.position.y, 0);
assert.equal(resolved.position.z, 0);
assert.equal(resolved.rotation.x, 0);
assert.equal(resolved.scale.x, 1);
assert.ok(Math.abs(resolvedSize.x - worldSize.x) < 0.02);
assert.ok(Math.abs(resolvedSize.y - worldSize.y) < 0.02);
assert.ok(Math.abs(resolvedSize.z - worldSize.z) < 0.02);
sceneRoot.remove(resolved);
disposeMeshResource(resolved);

const { bodyMesh, cutoutMesh } = replaceMeshWithSplit({
  sourceMesh: source,
  sceneRoot,
  bodyGeometry: source.geometry.clone(),
  cutoutGeometry: new THREE.BoxGeometry(0.4, 0.4, 0.4),
  cutoutName: 'cutout',
});
assert.equal(bodyMesh.parent, sceneRoot);
assert.equal(cutoutMesh.parent, sceneRoot);
assert.equal(source.parent, null);

const material = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
const left = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  material,
);
left.position.set(-1, 0, 0);
const right = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  material,
);
right.position.set(1, 0, 0);
sceneRoot.add(left, right);
sceneRoot.updateMatrixWorld(true);

const joined = joinBodyshopMeshes([left, right], sceneRoot);
assert.equal(joined.length, 1);
assert.equal(joined[0].name, 'joined');
assert.equal(left.parent, null);
assert.equal(right.parent, null);
const joinedBox = worldBBox(joined[0]);
assert.ok(joinedBox.getSize(new THREE.Vector3()).x > 1.9);

const shell = new THREE.Mesh(
  new THREE.BoxGeometry(4, 1.2, 2),
  new THREE.MeshStandardMaterial({ color: 0x3366aa }),
);
sceneRoot.add(shell);
shell.updateMatrixWorld(true);

const split = replaceMeshWithSplit({
  sourceMesh: shell,
  sceneRoot,
  bodyGeometry: new THREE.BoxGeometry(3, 1.2, 2),
  cutoutGeometry: new THREE.BoxGeometry(0.5, 0.5, 0.5),
  cutoutName: 'wheel-cutout',
});
assert.ok(split.bodyMesh.geometry.getAttribute('position').count > 0);
assert.ok(split.cutoutMesh.geometry.getAttribute('position').count > 0);
assert.equal(split.bodyMesh.position.x, 0);
assert.equal(split.cutoutMesh.position.x, 0);
assert.equal(shell.parent, null);

const wheelCylinders = [];
for (const x of [-1.6, 1.6]) {
  const cutter = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.6, 16, 1, true));
  cutter.rotation.z = Math.PI / 2;
  cutter.position.set(x, 0, 0);
  sceneRoot.add(cutter);
  cutter.updateMatrixWorld(true);
  wheelCylinders.push(cutter);
}

const shellForWheels = new THREE.Mesh(
  new THREE.BoxGeometry(4, 1.2, 2),
  new THREE.MeshStandardMaterial({ color: 0x3366aa }),
);
sceneRoot.add(shellForWheels);
shellForWheels.updateMatrixWorld(true);

const cutResult = applySequentialCylinderCuts(wheelCylinders, shellForWheels);
const wheelCutMeshes = createResolvedMeshesFromCut({
  sceneRoot,
  bodyGeometry: cutResult.bodyGeometry,
  cutoutGeometries: cutResult.cutoutGeometries,
  referenceWorld: cutResult.referenceWorld,
  material: cutResult.material,
  sourceName: 'shell',
  cutoutNames: ['wheel-left', 'wheel-right'],
});
sceneRoot.add(wheelCutMeshes.bodyMesh, ...wheelCutMeshes.cutoutMeshes);
assert.equal(wheelCutMeshes.cutoutMeshes.length, 2);
assert.ok(wheelCutMeshes.bodyMesh.geometry.getAttribute('position').count > 0);
disposeMeshResource(shellForWheels);
for (const cutter of wheelCylinders) {
  sceneRoot.remove(cutter);
  cutter.geometry.dispose();
  cutter.material.dispose();
}

console.log('Bodyshop mesh resolution checks passed.');
