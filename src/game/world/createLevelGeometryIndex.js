import * as THREE from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

let bvhInstalled = false;
const ORIGINAL_RAYCAST_KEY = '__dreamfallOriginalRaycast';
const raycaster = new THREE.Raycaster();
const BVH_WARMUP_BUDGET_MS = 2;

// Meshes enqueued for BVH construction at addRoot time. Drained by warmup.
// This ensures raycasts (hook, ledge, avoidance) never trigger synchronous
// computeBoundsTree on the hot path.
const pendingBvhQueue = [];

export function createLevelGeometryIndex(root) {
  installMeshBvh();

  const entries = [];

  addRoot(root);

  function addRoot(objectRoot) {
    objectRoot.updateMatrixWorld(true);
    objectRoot.traverse((object) => {
      if (!object.isMesh || !object.geometry?.isBufferGeometry) {
        return;
      }
      if (object.userData?.skipLevelRaycast === true) {
        return;
      }

      // Bounding box only at attach time (or pre-provided for streamed chunks).
      // BVHs are warmed incrementally from an addRoot queue + every-frame budget.
      // Raycast NEVER builds synchronously (prevents hot-path stalls on movement queries).
      // For streamed chunks we restore serialized local boundingBox during
      // createGeneratorCityChunkFromPayload, so skip the vertex walk here.
      if (!object.geometry.boundingBox) {
        object.geometry.computeBoundingBox();
      }
      object.updateMatrixWorld(true);

      // Geometry registered here belongs to the static level. Preserve skinned
      // and morphed meshes, but avoid recomposing transforms for baked world
      // meshes on every camera and shadow pass.
      if (!object.isSkinnedMesh && !object.morphTargetInfluences) {
        object.matrixAutoUpdate = false;
        // Opt-in: also stop recomposing the *world* matrix every frame. In three
        // r185 Object3D.updateMatrixWorld the scene (matrixAutoUpdate=true by
        // default) recomposes each frame and cascades force=true to all children,
        // so matrixAutoUpdate=false alone still runs multiplyMatrices on every
        // mesh for every color/shadow/prepass pass. matrixWorldAutoUpdate=false
        // makes the mesh skip that multiply — the baked matrixWorld (above) is
        // final. Safe only when the whole parent chain above this root is static
        // post-attach; callers opt in per-root via userData so shared infrastructure
        // (terrain/blueprint/wilds levels) is unaffected until each is audited.
        if (objectRoot.userData?.freezeStaticWorldMatrices === true) {
          object.matrixWorldAutoUpdate = false;
        }
      }

      const bounds = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
      entries.push({
        name: object.name,
        mesh: object,
        root: objectRoot,
        bounds,
      });

      // Enqueue for incremental BVH warmup (never build in raycast).
      if (object.geometry && !object.geometry.boundsTree) {
        // Avoid duplicates
        if (!pendingBvhQueue.includes(object)) {
          pendingBvhQueue.push(object);
        }
      }
    });
  }

  function removeRoot(objectRoot) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];

      if (entry.root !== objectRoot && !isAncestorOf(objectRoot, entry.mesh)) {
        continue;
      }

      entry.mesh.geometry.disposeBoundsTree?.();
      entries.splice(index, 1);
    }
  }

  // maxCount is a backstop; the maxMs guard is what actually bounds a frame.
  // Small meshes (terrain chunks, props) build in microseconds, so allowing
  // several per frame drains a fresh ultra-radius ring in ~a second instead of
  // ~10 s of one-per-frame. Raycasts skip tree-less meshes, so drain speed is
  // how fast the world becomes hook-visible.
  function warmupBoundsTrees({ maxMs = BVH_WARMUP_BUDGET_MS, maxCount = 8 } = {}) {
    const start = performance.now();
    let built = 0;

    // Cheapest-first (by vertex count) so a small prop isn't stuck behind a large
    // building trimesh, and a single expensive build can't spike a frame before
    // the time guard trips. Mirrors the collider cost-sort strategy.
    if (pendingBvhQueue.length > 1) {
      pendingBvhQueue.sort((a, b) => meshVertexCount(a) - meshVertexCount(b));
    }

    // Drain newly-attached meshes first (enqueued in addRoot). These are the ones
    // most likely to be raced by a raycast.
    while (pendingBvhQueue.length > 0 && built < maxCount) {
      const mesh = pendingBvhQueue.shift();
      const geometry = mesh?.geometry;
      if (geometry && !geometry.boundsTree) {
        geometry.computeBoundsTree();
        built += 1;
      }
      if (performance.now() - start >= maxMs) {
        break;
      }
    }

    // Then continue with any remaining unscanned entries (older or fallback).
    for (const entry of entries) {
      if (built >= maxCount) break;
      const geometry = entry.mesh?.geometry;
      if (!geometry || geometry.boundsTree) {
        continue;
      }

      geometry.computeBoundsTree();
      built += 1;

      if (performance.now() - start >= maxMs) {
        break;
      }
    }

    return built;
  }

  return {
    entries,
    addRoot,
    removeRoot,
    warmupBoundsTrees,
    // Dev-only: confirm every frozen mesh's baked matrixWorld still matches the
    // recomposed parent*local product (i.e. nothing moved it or a parent since
    // addRoot). Returns the number of mismatched meshes; a verify harness can
    // assert zero. Skips skinned/morphed meshes (their matrixWorld is driven
    // elsewhere) and meshes whose root never opted into freezing.
    validateFrozenMatrices() {
      let mismatches = 0;
      const recomposed = new THREE.Matrix4();
      for (const entry of entries) {
        const mesh = entry.mesh;
        if (mesh.isSkinnedMesh || mesh.morphTargetInfluences) continue;
        if (mesh.matrixWorldAutoUpdate !== false) continue;
        if (!mesh.parent) continue;
        recomposed.multiplyMatrices(mesh.parent.matrixWorld, mesh.matrix);
        if (!matricesEqual(recomposed, mesh.matrixWorld)) mismatches += 1;
      }
      return mismatches;
    },
    raycast: ({ origin, direction, near = 0, far = Infinity, firstHitOnly = true }) => {
      raycaster.firstHitOnly = firstHitOnly;
      raycaster.near = near;
      raycaster.far = far;
      raycaster.set(origin, direction);

      const meshes = [];
      for (const entry of entries) {
        if (!raycaster.ray.intersectsBox(entry.bounds)) {
          continue;
        }

        const mesh = entry.mesh;
        // Never build BVH synchronously on the query path (hook/ledge/avoidance),
        // and never raycast a mesh whose tree hasn't been built yet: without the
        // tree acceleratedRaycast falls back to brute-force triangle iteration,
        // and on a merged city-chunk mesh that measured ~900 ms PER QUERY (the
        // ultra city 3 fps trace). Skipping means the mesh is simply not
        // grapple-visible for the few frames until warmup (or the worker-built
        // serialized BVH that streamed chunks arrive with) covers it.
        if (!mesh.geometry?.boundsTree) {
          continue;
        }
        meshes.push(mesh);
      }

      return raycaster.intersectObjects(meshes, false);
    },
    snapshot: () => ({
      meshes: entries.length,
      bounds: entries.map((entry) => ({
        name: entry.name,
        min: vectorSnapshot(entry.bounds.min),
        max: vectorSnapshot(entry.bounds.max),
      })),
    }),
    dispose: () => {
      for (const entry of entries) {
        entry.mesh.geometry.disposeBoundsTree?.();
      }
    },
  };
}

function meshVertexCount(mesh) {
  const position = mesh?.geometry?.attributes?.position;
  return position?.count ?? 0;
}

function matricesEqual(a, b) {
  const ea = a.elements;
  const eb = b.elements;
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(ea[i] - eb[i]) > 1e-5) return false;
  }
  return true;
}

function isAncestorOf(root, object) {
  let current = object;

  while (current) {
    if (current === root) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function installMeshBvh() {
  if (bvhInstalled) {
    return;
  }

  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

  if (!THREE.Mesh.prototype[ORIGINAL_RAYCAST_KEY]) {
    THREE.Mesh.prototype[ORIGINAL_RAYCAST_KEY] = THREE.Mesh.prototype.raycast;
  }

  THREE.Mesh.prototype.raycast = safeAcceleratedRaycast;
  bvhInstalled = true;
}

function safeAcceleratedRaycast(raycasterInstance, intersects) {
  const originalRaycast = THREE.Mesh.prototype[ORIGINAL_RAYCAST_KEY];

  try {
    return acceleratedRaycast.call(this, raycasterInstance, intersects);
  } catch (error) {
    const message = String(error?.message ?? '');

    if (
      message.includes('Fallback raycast function not found')
      && typeof originalRaycast === 'function'
    ) {
      return originalRaycast.call(this, raycasterInstance, intersects);
    }

    throw error;
  }
}

function vectorSnapshot(vector) {
  return {
    x: Number(vector.x.toFixed(3)),
    y: Number(vector.y.toFixed(3)),
    z: Number(vector.z.toFixed(3)),
  };
}
