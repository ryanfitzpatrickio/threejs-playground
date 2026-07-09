import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyCylinderCut } from '../game/geometry/bodyshopCutTool.js';

const _worldMatrix = new THREE.Matrix4();
const _inverseParent = new THREE.Matrix4();

export function finalizeBodyshopGeometry(geometry) {
  if (!geometry?.getAttribute?.('position')) return null;
  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  } else {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function bakeGeometryToSceneRoot(geometry, sourceMesh, sceneRoot) {
  sourceMesh.updateMatrixWorld(true);
  sceneRoot.updateMatrixWorld(true);
  _worldMatrix.copy(sourceMesh.matrixWorld);
  _inverseParent.copy(sceneRoot.matrixWorld).invert();
  geometry.applyMatrix4(_worldMatrix);
  geometry.applyMatrix4(_inverseParent);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function cloneBodyshopMaterial(material) {
  if (!material) {
    return new THREE.MeshStandardMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
  }
  const cloned = Array.isArray(material)
    ? material.map((entry) => entry?.clone?.() ?? entry)
    : material.clone();
  const materials = Array.isArray(cloned) ? cloned : [cloned];
  for (const mat of materials) {
    if (!mat) continue;
    mat.side = THREE.DoubleSide;
  }
  return cloned;
}

export function disposeMeshResource(mesh) {
  if (!mesh) return;
  mesh.parent?.remove(mesh);
  mesh.geometry?.dispose?.();
}

export function createResolvedMesh({
  geometry,
  sourceMesh,
  sceneRoot,
  name = 'mesh',
  material = null,
}) {
  finalizeBodyshopGeometry(geometry);
  bakeGeometryToSceneRoot(geometry, sourceMesh, sceneRoot);

  const mesh = new THREE.Mesh(
    geometry,
    material ?? cloneBodyshopMaterial(sourceMesh?.material),
  );
  mesh.name = name;
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();
  return mesh;
}

export function replaceMeshWithSplit({
  sourceMesh,
  sceneRoot,
  bodyGeometry,
  cutoutGeometry,
  cutoutName = 'cutout',
}) {
  const bodyMesh = createResolvedMesh({
    geometry: bodyGeometry,
    sourceMesh,
    sceneRoot,
    name: sourceMesh.name || 'body',
    material: cloneBodyshopMaterial(sourceMesh.material),
  });
  const cutoutMesh = createResolvedMesh({
    geometry: cutoutGeometry,
    sourceMesh,
    sceneRoot,
    name: cutoutName,
    material: cloneBodyshopMaterial(sourceMesh.material),
  });
  disposeMeshResource(sourceMesh);
  sceneRoot.add(bodyMesh, cutoutMesh);
  return { bodyMesh, cutoutMesh };
}

export function replaceMeshWithGeometry({
  sourceMesh,
  sceneRoot,
  geometry,
  name = null,
}) {
  const mesh = createResolvedMesh({
    geometry,
    sourceMesh,
    sceneRoot,
    name: name ?? sourceMesh.name ?? 'mesh',
    material: cloneBodyshopMaterial(sourceMesh.material),
  });
  disposeMeshResource(sourceMesh);
  sceneRoot.add(mesh);
  return mesh;
}

function ensureMergeAttributes(geometry) {
  if (!geometry?.getAttribute?.('position')) return null;
  let geo = geometry;
  if (geo.index) {
    const nonIndexed = geo.toNonIndexed();
    if (nonIndexed !== geo) geo.dispose();
    geo = nonIndexed;
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  if (!geo.getAttribute('uv')) {
    const count = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geo;
}

function materialBucketKey(material) {
  if (Array.isArray(material)) {
    return material.map((entry) => entry?.uuid ?? 'none').join('|');
  }
  return material?.uuid ?? 'none';
}

export function joinBodyshopMeshes(meshes, sceneRoot) {
  const uniqueMeshes = [...new Set(meshes.filter(Boolean))];
  if (uniqueMeshes.length === 0) return [];
  if (uniqueMeshes.length === 1) return uniqueMeshes;

  sceneRoot.updateMatrixWorld(true);
  _inverseParent.copy(sceneRoot.matrixWorld).invert();

  const buckets = new Map();
  for (const mesh of uniqueMeshes) {
    mesh.updateMatrixWorld(true);
    const key = materialBucketKey(mesh.material);
    if (!buckets.has(key)) {
      buckets.set(key, { material: mesh.material, geometries: [] });
    }
    const baked = ensureMergeAttributes(mesh.geometry?.clone?.());
    if (!baked) continue;
    baked.applyMatrix4(mesh.matrixWorld);
    baked.applyMatrix4(_inverseParent);
    buckets.get(key).geometries.push(baked);
  }

  for (const mesh of uniqueMeshes) {
    disposeMeshResource(mesh);
  }

  const results = [];
  let bucketIndex = 0;
  for (const bucket of buckets.values()) {
    if (!bucket.geometries.length) continue;

    let merged = null;
    if (bucket.geometries.length === 1) {
      merged = bucket.geometries[0];
    } else {
      merged = mergeGeometries(bucket.geometries, false);
      for (const geo of bucket.geometries) {
        if (geo !== merged) geo.dispose();
      }
    }
    if (!merged) {
      throw new Error('Could not merge selected meshes — attribute layouts may be incompatible.');
    }

    finalizeBodyshopGeometry(merged);
    const joinedMesh = new THREE.Mesh(merged, cloneBodyshopMaterial(bucket.material));
    joinedMesh.name = buckets.size > 1 ? `joined-${bucketIndex + 1}` : 'joined';
    bucketIndex += 1;
    sceneRoot.add(joinedMesh);
    results.push(joinedMesh);
  }

  if (!results.length) {
    throw new Error('No geometry remained after joining the selected meshes.');
  }

  return results;
}

export function applySequentialCylinderCuts(cylinders, targetMesh) {
  if (!targetMesh?.geometry) {
    throw new Error('No mesh geometry to cut.');
  }

  targetMesh.updateMatrixWorld(true);
  const referenceWorld = new THREE.Matrix4().copy(targetMesh.matrixWorld);
  const proxy = {
    geometry: targetMesh.geometry,
    matrixWorld: referenceWorld,
    updateMatrixWorld() {},
  };

  let bodyGeometry = targetMesh.geometry;
  const cutoutGeometries = [];

  for (const cylinder of cylinders) {
    if (!cylinder) {
      throw new Error('Missing wheel cylinder.');
    }
    proxy.geometry = bodyGeometry;
    const result = applyCylinderCut(cylinder, proxy);
    if (bodyGeometry !== targetMesh.geometry) {
      bodyGeometry.dispose();
    }
    bodyGeometry = result.body;
    cutoutGeometries.push(result.cutout);
  }

  return {
    bodyGeometry,
    cutoutGeometries,
    referenceWorld,
    material: targetMesh.material,
    sourceName: targetMesh.name || 'body',
  };
}

export function createResolvedMeshesFromCut({
  sceneRoot,
  bodyGeometry,
  cutoutGeometries,
  referenceWorld,
  material,
  sourceName = 'body',
  cutoutNames = [],
}) {
  const stub = new THREE.Object3D();
  stub.matrixAutoUpdate = false;
  stub.matrixWorld.copy(referenceWorld);
  stub.material = material;

  const bodyMesh = createResolvedMesh({
    geometry: bodyGeometry,
    sourceMesh: stub,
    sceneRoot,
    name: sourceName,
    material: cloneBodyshopMaterial(material),
  });

  const cutoutMeshes = cutoutGeometries.map((geometry, index) => createResolvedMesh({
    geometry,
    sourceMesh: stub,
    sceneRoot,
    name: cutoutNames[index] ?? `cutout-${index + 1}`,
    material: cloneBodyshopMaterial(material),
  }));

  return { bodyMesh, cutoutMeshes };
}
