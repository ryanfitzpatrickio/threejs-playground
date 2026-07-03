import * as THREE from 'three';

/**
 * Fix three.js WebGPURenderer choking on the interleaved + normalized +
 * quantized vertex attributes that Tripo / gltf-transform produce.
 *
 * Symptom: WebGPURenderer derives an INVALID vertex format like `unorm32x4`
 * from these attributes (it confuses the interleaved buffer's stride/component
 * size), `GPUDevice.createRenderPipeline` throws, and the mesh renders broken
 * (invisible in a clean scene, or "spiky"/exploded when other code perturbs the
 * attributes at runtime). WebGLRenderer handles the identical data fine.
 *
 * Fix: rebuild every attribute as a standalone (non-interleaved), non-normalized
 * BufferAttribute — Float32 for position/normal/uv/color/tangent/skinWeight,
 * Uint16 for skinIndex. This gives WebGPU only well-formed vertex formats.
 * Values are read via getComponent() so interleaving + normalization are undone
 * correctly. Mutates the geometry in place (preserves skeleton binding).
 *
 * Cheap and idempotent: only rebuilds attributes that are actually problematic.
 */
export function flattenGeometryForWebGPU(geometry) {
  if (!geometry || !geometry.attributes) return geometry;

  for (const name of Object.keys(geometry.attributes)) {
    const src = geometry.attributes[name];
    if (!src || src.count === undefined) continue;

    const wantsInt = name === 'skinIndex';
    const isInterleaved = !!src.isInterleavedBufferAttribute;
    // Already the exact safe form? skip.
    const alreadyOk = !isInterleaved && !src.normalized && (
      (wantsInt && src.array instanceof Uint16Array) ||
      (!wantsInt && src.array instanceof Float32Array)
    );
    if (alreadyOk) continue;

    const itemSize = src.itemSize;
    const count = src.count;
    const dst = wantsInt ? new Uint16Array(count * itemSize) : new Float32Array(count * itemSize);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < itemSize; c++) {
        dst[i * itemSize + c] = src.getComponent(i, c);
      }
    }
    geometry.setAttribute(
      name,
      wantsInt
        ? new THREE.Uint16BufferAttribute(dst, itemSize)
        : new THREE.Float32BufferAttribute(dst, itemSize),
    );
  }

  // De-interleave the index too if needed (rare, but cheap to guard).
  const index = geometry.index;
  if (index && index.isInterleavedBufferAttribute) {
    const dst = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i++) dst[i] = index.getComponent(i, 0);
    geometry.setIndex(new THREE.BufferAttribute(dst, 1));
  }

  // The attributes changed, so any cached bounding sphere/box is stale.
  geometry.boundingBox = null;
  geometry.boundingSphere = null;

  return geometry;
}

/** Traverse an object and flatten every mesh geometry it contains. */
export function flattenObjectForWebGPU(root) {
  if (!root) return;
  root.traverse((child) => {
    if ((child.isMesh || child.isSkinnedMesh) && child.geometry) {
      flattenGeometryForWebGPU(child.geometry);
    }
  });
}
