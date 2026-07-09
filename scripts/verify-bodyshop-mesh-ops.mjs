/**
 * Guards bodyshop cut/join mesh resolution: geometry must be baked into sceneRoot
 * space with identity mesh transforms, not left in source-local space with a
 * decomposed world matrix applied on top.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  adoptBodyshopImport,
  applySequentialCylinderCuts,
  bakeGeometryToSceneRoot,
  collapseNestedBodyshopWrappers,
  createResolvedMesh,
  createResolvedMeshesFromCut,
  disposeMeshResource,
  finalizeBodyshopGeometry,
  joinBodyshopMeshes,
  replaceMeshWithSplit,
  withBodyshopExportRoot,
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

const shellForWheels = new THREE.Mesh(
  new THREE.BoxGeometry(4, 1.2, 2),
  new THREE.MeshStandardMaterial({ color: 0x3366aa }),
);
// Non-identity local transform: the 4-wheel resolve path used to wipe this
// when baking via an orphan stub (matrixWorld only, matrix left identity).
shellForWheels.position.set(0.5, 0.15, -0.25);
shellForWheels.rotation.y = THREE.MathUtils.degToRad(30);
shellForWheels.scale.set(1.15, 0.95, 1.05);
sceneRoot.add(shellForWheels);
shellForWheels.updateMatrixWorld(true);
const shellWorldBox = worldBBox(shellForWheels);
const shellWorldCenter = shellWorldBox.getCenter(new THREE.Vector3());
const shellWorldSize = shellWorldBox.getSize(new THREE.Vector3());

// Parent cutters under the shell so they track its transform (same as cutting
// wheel wells on a moved/rotated car mesh).
const wheelCylinders = [];
for (const x of [-1.6, 1.6]) {
  const cutter = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.6, 16, 1, true));
  cutter.rotation.z = Math.PI / 2;
  cutter.position.set(x, 0, 0);
  shellForWheels.add(cutter);
  cutter.updateMatrixWorld(true);
  wheelCylinders.push(cutter);
}

const cutResult = applySequentialCylinderCuts(wheelCylinders, shellForWheels);
// Detach cutters before dispose so they don't leave the scene graph dirty.
for (const cutter of wheelCylinders) {
  shellForWheels.remove(cutter);
  cutter.geometry.dispose();
  cutter.material.dispose();
}
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
assert.equal(wheelCutMeshes.bodyMesh.position.x, 0);
assert.equal(wheelCutMeshes.bodyMesh.scale.x, 1);
// Body + cutouts should still occupy the same world footprint as the source shell.
const combinedBox = worldBBox(wheelCutMeshes.bodyMesh);
for (const mesh of wheelCutMeshes.cutoutMeshes) {
  combinedBox.union(worldBBox(mesh));
}
const combinedCenter = combinedBox.getCenter(new THREE.Vector3());
const combinedSize = combinedBox.getSize(new THREE.Vector3());
assert.ok(combinedCenter.distanceTo(shellWorldCenter) < 0.05, '4-wheel cut must preserve world center');
assert.ok(Math.abs(combinedSize.x - shellWorldSize.x) < 0.08, '4-wheel cut must preserve world size X');
assert.ok(Math.abs(combinedSize.y - shellWorldSize.y) < 0.08, '4-wheel cut must preserve world size Y');
assert.ok(Math.abs(combinedSize.z - shellWorldSize.z) < 0.08, '4-wheel cut must preserve world size Z');
disposeMeshResource(shellForWheels);

// Nested GLTF/bodyshop wrapper collapse (export → reimport nesting).
{
  const nestedRoot = new THREE.Group();
  nestedRoot.name = '__builder_root__';
  let cursor = nestedRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const wrapper = new THREE.Group();
    wrapper.name = depth % 2 === 0 ? `AuxScene_${depth}` : `__builder_root___${depth}`;
    cursor.add(wrapper);
    cursor = wrapper;
  }
  const shell = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  shell.name = 'chasis';
  cursor.add(shell);
  const emptyCutout = new THREE.Object3D();
  emptyCutout.name = 'wheel-cutout';
  cursor.add(emptyCutout);

  const target = new THREE.Group();
  target.name = '__builder_root__';
  adoptBodyshopImport(target, nestedRoot);
  assert.equal(target.children.length, 1, 'wrappers collapse to mesh content');
  assert.equal(target.children[0].name, 'chasis');
  assert.equal(collapseNestedBodyshopWrappers(target), 0);

  const exportNames = [];
  withBodyshopExportRoot(target, (exportRoot, restore) => {
    exportNames.push(exportRoot.name, ...exportRoot.children.map((c) => c.name));
    restore();
  });
  assert.deepEqual(exportNames, ['chassis', 'chasis']);
  assert.equal(target.children[0].parent, target);
}

console.log('Bodyshop mesh resolution checks passed.');
