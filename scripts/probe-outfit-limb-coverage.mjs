import path from 'node:path';
import process from 'node:process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import * as THREE from 'three';
import {
  computeLimbVertexData,
  installOutfitLimbCuts,
} from '../src/game/characters/simhuman/outfitLimbVisibility.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error('Usage: node scripts/probe-outfit-limb-coverage.mjs outfit.glb [...]');
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

for (const file of files) {
  const document = await io.read(path.resolve(file));
  const meshes = [];
  const positionBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const armBindJoints = [];
  for (const node of document.getRoot().listNodes()) {
    const sourceMesh = node.getMesh();
    const skin = node.getSkin();
    if (!sourceMesh || !skin) continue;
    const joints = skin.listJoints();
    const inverseBind = skin.getInverseBindMatrices();
    const inverse = new Array(16).fill(0);
    const bones = joints.map((joint) => Object.assign(new THREE.Bone(), { name: joint.getName() }));
    const inverses = joints.map((_, index) => {
      inverseBind.getElement(index, inverse);
      return new THREE.Matrix4().fromArray(inverse);
    });
    for (let index = 0; index < joints.length; index += 1) {
      if (!/upper.?arm|forearm|lower.?arm/i.test(joints[index].getName())) continue;
      const bind = inverses[index].clone().invert().elements;
      armBindJoints.push({ name: joints[index].getName(), position: [bind[12], bind[13], bind[14]] });
    }
    const skeleton = new THREE.Skeleton(bones, inverses);
    for (const primitive of sourceMesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      const joints0 = primitive.getAttribute('JOINTS_0');
      const weights0 = primitive.getAttribute('WEIGHTS_0');
      if (!position || !joints0 || !weights0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(position.getArray(), 3));
      const positionElement = [0, 0, 0];
      for (let vertex = 0; vertex < position.getCount(); vertex += 1) {
        position.getElement(vertex, positionElement);
        for (let axis = 0; axis < 3; axis += 1) {
          const value = positionElement[axis];
          positionBounds.min[axis] = Math.min(positionBounds.min[axis], value);
          positionBounds.max[axis] = Math.max(positionBounds.max[axis], value);
        }
      }
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(joints0.getArray(), 4));
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights0.getArray(), 4));
      const sourceIndex = primitive.getIndices();
      if (sourceIndex) geometry.setIndex(new THREE.BufferAttribute(sourceIndex.getArray(), 1));
      else geometry.setIndex([...Array(position.getCount()).keys()]);
      const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
      // Supplying no bind matrix makes three recalculate and overwrite the
      // imported inverse binds from identity test bones. Preserve authored
      // bind coordinates so this probe matches GLTFLoader/runtime behavior.
      mesh.bind(skeleton, new THREE.Matrix4());
      meshes.push(mesh);
    }
  }

  let rawExtendedArmVertices = 0;
  for (const mesh of meshes) {
    const limbData = computeLimbVertexData(mesh.geometry, mesh.skeleton);
    for (let vertex = 0; vertex < (limbData?.arms.progress.length ?? 0); vertex += 1) {
      if (limbData.arms.affinity[vertex] >= 0.35 && limbData.arms.progress[vertex] > 1) {
        rawExtendedArmVertices += 1;
      }
    }
  }
  const cuts = installOutfitLimbCuts(meshes, {});
  const source = cuts.sourceTriangles;
  const removed = {};
  for (const key of ['arms', 'legs', 'feet']) {
    cuts.setReveal({ arms: 0, legs: 0, feet: 0, [key]: 1 });
    removed[key] = source - cuts.visibleTriangles;
  }
  cuts.setReveal({ arms: 2, legs: 0, feet: 0 });
  removed.armsExtended = source - cuts.visibleTriangles;
  let extendedArmVertices = 0;
  let minExtendedArmCoordinate = Infinity;
  let maxExtendedArmCoordinate = -Infinity;
  for (const mesh of meshes) {
    const attribute = mesh.geometry.getAttribute('outfitLimbCut');
    if (!attribute) continue;
    for (let vertex = 0; vertex < attribute.count; vertex += 1) {
      const coordinate = attribute.getX(vertex);
      if (coordinate <= 1 || coordinate > 2) continue;
      extendedArmVertices += 1;
      minExtendedArmCoordinate = Math.min(minExtendedArmCoordinate, coordinate);
      maxExtendedArmCoordinate = Math.max(maxExtendedArmCoordinate, coordinate);
    }
  }
  console.log(JSON.stringify({
    file,
    meshes: meshes.length,
    sourceTriangles: source,
    positionBounds,
    armBindJoints,
    rawExtendedArmVertices,
    removed,
    extendedArmVertices,
    extendedArmCoordinateRange: extendedArmVertices > 0
      ? [minExtendedArmCoordinate, maxExtendedArmCoordinate]
      : null,
    ratios: Object.fromEntries(Object.entries(removed).map(([key, count]) => [key, count / source])),
    suggestedReveal: cuts.suggestedReveal,
  }, null, 2));
  cuts.dispose();
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh.skeleton.dispose();
  }
}
