import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyCylinderCut } from '../game/geometry/bodyshopCutTool.js';

const _worldMatrix = new THREE.Matrix4();
const _inverseParent = new THREE.Matrix4();

// GLTF export/import + autosave restore wrap content in these; re-export nests
// them again (rally2.glb reached depth 43). Collapse on load and before publish.
const BODYSHOP_WRAPPER_NAME = /^(?:__builder_root__|AuxScene|Scene)(?:[_.].*)?$/i;
const BODYSHOP_LOCATOR_NAME = /^Locator_/i;

// Light in-browser weld after face cuts. Blender planar dissolve
// (scripts/clean-bodyshop-glb.py) still does the heavy CSG cleanup.
const DEFAULT_WELD_TOLERANCE = 1e-5;

/**
 * Weld near-duplicate verts (cut edges) and rebuild normals/bounds.
 * Returns a possibly-new geometry; callers must use the return value.
 */
export function finalizeBodyshopGeometry(geometry, {
  weldTolerance = DEFAULT_WELD_TOLERANCE,
} = {}) {
  if (!geometry?.getAttribute?.('position')) return null;

  let geo = geometry;
  if (weldTolerance > 0) {
    const welded = mergeVertices(geo, weldTolerance);
    if (welded !== geo) {
      geo = welded;
    }
  }

  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function isBodyshopWrapperObject(object) {
  if (!object || object.isMesh || object.isSkinnedMesh || object.isLine || object.isPoints) {
    return false;
  }
  if (object.userData?._builderHelper || object.userData?.bodyshopHelper) {
    return false;
  }
  if (BODYSHOP_LOCATOR_NAME.test(object.name || '')) return false;
  return BODYSHOP_WRAPPER_NAME.test(object.name || '');
}

/**
 * Promote content out of nested GLTF/bodyshop wrapper groups under `root`.
 * Returns how many wrappers were removed.
 */
export function collapseNestedBodyshopWrappers(root, { maxPasses = 64 } = {}) {
  if (!root) return 0;
  let collapsed = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const wrappers = root.children.filter((child) => (
      isBodyshopWrapperObject(child) && (child.children.length > 0 || !BODYSHOP_LOCATOR_NAME.test(child.name || ''))
    ));
    if (!wrappers.length) break;

    for (const wrapper of wrappers) {
      const kids = [...wrapper.children];
      for (const kid of kids) {
        root.attach(kid);
      }
      wrapper.parent?.remove(wrapper);
      // Drop empty geometry-less leftovers only; do not dispose live meshes.
      if (!wrapper.isMesh) {
        wrapper.geometry?.dispose?.();
        if (Array.isArray(wrapper.material)) {
          for (const mat of wrapper.material) mat?.dispose?.();
        } else {
          wrapper.material?.dispose?.();
        }
      }
      collapsed += 1;
    }
  }

  // Strip empty non-locator Object3Ds left after cuts/export (e.g. wheel-cutout with no mesh).
  const empties = root.children.filter((child) => (
    !child.isMesh
    && !child.isSkinnedMesh
    && !child.isLight
    && !child.userData?._builderHelper
    && !child.userData?.bodyshopHelper
    && !BODYSHOP_LOCATOR_NAME.test(child.name || '')
    && child.children.length === 0
  ));
  for (const empty of empties) {
    empty.parent?.remove(empty);
    collapsed += 1;
  }

  return collapsed;
}

/**
 * Reparent imported GLTF content into `sceneRoot`, collapsing wrapper layers.
 */
export function adoptBodyshopImport(sceneRoot, importedRoot) {
  if (!sceneRoot || !importedRoot) return;
  sceneRoot.attach(importedRoot);
  collapseNestedBodyshopWrappers(sceneRoot);
}

/**
 * Temporarily reparent scene content under a clean export group so publish/GLB
 * does not nest another `__builder_root__` layer.
 */
export function withBodyshopExportRoot(sceneRoot, run) {
  collapseNestedBodyshopWrappers(sceneRoot);
  const exportRoot = new THREE.Group();
  exportRoot.name = 'chassis';
  const moved = [...sceneRoot.children];
  for (const child of moved) {
    exportRoot.attach(child);
  }

  const restore = () => {
    for (const child of [...exportRoot.children]) {
      sceneRoot.attach(child);
    }
  };

  try {
    return run(exportRoot, restore);
  } catch (error) {
    restore();
    throw error;
  }
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
  const resolvedGeometry = finalizeBodyshopGeometry(geometry) ?? geometry;
  bakeGeometryToSceneRoot(resolvedGeometry, sourceMesh, sceneRoot);

  const mesh = new THREE.Mesh(
    resolvedGeometry,
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

    const finalized = finalizeBodyshopGeometry(merged) ?? merged;
    const joinedMesh = new THREE.Mesh(finalized, cloneBodyshopMaterial(bucket.material));
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
  // bakeGeometryToSceneRoot force-updates matrixWorld from matrix when parent is
  // null, so both must hold the source world transform — matrixWorld alone is wiped.
  const stub = new THREE.Object3D();
  stub.matrixAutoUpdate = false;
  stub.matrix.copy(referenceWorld);
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
