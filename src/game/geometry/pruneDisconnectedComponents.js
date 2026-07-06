import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Remove disconnected triangle islands from an indexed mesh.
 * `rejectComponent` receives axis-aligned bounds for each island.
 */
export function pruneDisconnectedComponents(geometry, rejectComponent) {
  if (!geometry?.getAttribute('position') || !rejectComponent) return geometry;

  const welded = mergeVertices(geometry, 1e-4);
  const source = welded.getAttribute('position');
  const index = welded.getIndex();
  if (!index || source.count < 3) {
    if (welded !== geometry) geometry.dispose();
    return welded;
  }

  const vertCount = source.count;
  const parent = new Int32Array(vertCount);
  for (let i = 0; i < vertCount; i += 1) parent[i] = i;

  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let current = x;
    while (parent[current] !== current) {
      const next = parent[current];
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const unite = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    unite(a, b);
    unite(b, c);
  }

  const components = new Map();
  for (let vi = 0; vi < vertCount; vi += 1) {
    const root = find(vi);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(vi);
  }

  const removedVerts = new Uint8Array(vertCount);
  for (const verts of components.values()) {
    const bounds = boundsForVertices(source, verts);
    if (rejectComponent(bounds)) {
      for (const vi of verts) removedVerts[vi] = 1;
    }
  }

  const keptTriangles = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (removedVerts[a] || removedVerts[b] || removedVerts[c]) continue;
    keptTriangles.push(a, b, c);
  }

  if (keptTriangles.length === index.count) {
    if (welded !== geometry) geometry.dispose();
    return welded;
  }
  if (keptTriangles.length === 0) {
    if (welded !== geometry) geometry.dispose();
    return welded;
  }

  const used = new Uint8Array(vertCount);
  for (const vi of keptTriangles) used[vi] = 1;
  const remap = new Int32Array(vertCount).fill(-1);
  let next = 0;
  for (let vi = 0; vi < vertCount; vi += 1) {
    if (used[vi]) remap[vi] = next++;
  }

  const nextPositions = new Float32Array(next * 3);
  const nextNormals = welded.getAttribute('normal');
  const nextNormalsOut = nextNormals ? new Float32Array(next * 3) : null;
  const nextUvs = welded.getAttribute('uv');
  const nextUvsOut = nextUvs ? new Float32Array(next * 2) : null;
  const scratch = new THREE.Vector3();

  for (let vi = 0; vi < vertCount; vi += 1) {
    const target = remap[vi];
    if (target < 0) continue;
    scratch.fromBufferAttribute(source, vi);
    nextPositions[target * 3] = scratch.x;
    nextPositions[target * 3 + 1] = scratch.y;
    nextPositions[target * 3 + 2] = scratch.z;
    if (nextNormalsOut) {
      scratch.fromBufferAttribute(nextNormals, vi);
      nextNormalsOut[target * 3] = scratch.x;
      nextNormalsOut[target * 3 + 1] = scratch.y;
      nextNormalsOut[target * 3 + 2] = scratch.z;
    }
    if (nextUvsOut) {
      nextUvsOut[target * 2] = nextUvs.getX(vi);
      nextUvsOut[target * 2 + 1] = nextUvs.getY(vi);
    }
  }

  const nextIndex = new Uint32Array(keptTriangles.length);
  for (let i = 0; i < keptTriangles.length; i += 1) {
    nextIndex[i] = remap[keptTriangles[i]];
  }

  const pruned = new THREE.BufferGeometry();
  pruned.setAttribute('position', new THREE.BufferAttribute(nextPositions, 3));
  if (nextNormalsOut) pruned.setAttribute('normal', new THREE.BufferAttribute(nextNormalsOut, 3));
  if (nextUvsOut) pruned.setAttribute('uv', new THREE.BufferAttribute(nextUvsOut, 2));
  pruned.setIndex(new THREE.BufferAttribute(nextIndex, 1));

  if (welded !== geometry) welded.dispose();
  geometry.dispose();
  return pruned;
}

function boundsForVertices(position, vertexIndices) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const point = new THREE.Vector3();
  for (const vi of vertexIndices) {
    point.fromBufferAttribute(position, vi);
    min.min(point);
    max.max(point);
  }
  const center = min.clone().add(max).multiplyScalar(0.5);
  const size = max.clone().sub(min);
  return { min, max, center, size, vertexCount: vertexIndices.length };
}

/** Rear stray shard baked into the quad handle-bar mesh (separate island at z ≈ -0.6). */
export function pruneQuadHandlebarStray(mesh) {
  if (!mesh?.isMesh || !mesh.geometry) return false;
  const before = mesh.geometry.getAttribute('position')?.count ?? 0;
  mesh.geometry = pruneDisconnectedComponents(
    mesh.geometry,
    (bounds) => bounds.max.z < -0.25,
  );
  const after = mesh.geometry.getAttribute('position')?.count ?? 0;
  return after < before;
}
