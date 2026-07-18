// Allocation-free triangle BVH for cloth-vs-avatar collision.
//
// The avatar mesh is a fixed-topology, per-frame-deforming skinned mesh, so the
// tree is built once over the triangle set and *refit* each frame (node AABBs
// recomputed bottom-up from moved vertices) rather than rebuilt. Queries are
// stack-based with no per-call allocation, because the collision solver issues
// thousands of them per frame.
//
// The BVH replaces the uniform spatial-hash grid as the broad phase. The narrow
// phase (closest-point-on-triangle, signed push-out) is unchanged and lives in
// solveCollisionConstraints, so contact results are identical to before — the
// BVH only changes *which* triangles are offered to the narrow phase, and it
// offers a superset-then-pruned set that always includes the true closest.

const STACK_SIZE = 64

export type TriangleBVH = {
  // Per-node, in a flat binary-heap-free layout produced by the builder.
  // node layout (per node i): bounds[i*6..i*6+5], then either:
  //   leaf:     triStart[i] >= 0, triCount[i] > 0, leftChild[i] = -1
  //   internal: leftChild[i] >= 0 (right = leftChild+1 is NOT assumed; stored)
  nodeCount: number
  bounds: Float32Array // nodeCount * 6  (minX,minY,minZ,maxX,maxY,maxZ)
  leftChild: Int32Array // nodeCount; -1 for leaf
  rightChild: Int32Array // nodeCount; -1 for leaf
  triStart: Int32Array // nodeCount; -1 for internal
  triCount: Int32Array // nodeCount; 0 for internal
  // Triangle order (indices into the collider's triangle list), grouped per leaf.
  triOrder: Uint32Array
  // Cached references for refit.
  vertices: Float32Array
  indices: Uint32Array
  // Scratch traversal stack, reused across queries (single-threaded).
  stack: Int32Array
  // Postorder of node indices (children before parents) for bottom-up refit.
  refitOrder: Int32Array
  // Reusable output buffer for candidate triangle indices (one query at a time).
  candidates: Uint32Array
}

const LEAF_TRIANGLES = 4

export function buildTriangleBVH(vertices: Float32Array, indices: Uint32Array): TriangleBVH {
  const triangleCount = indices.length / 3
  // centroids for split selection
  const cx = new Float32Array(triangleCount)
  const cy = new Float32Array(triangleCount)
  const cz = new Float32Array(triangleCount)
  for (let t = 0; t < triangleCount; t += 1) {
    const ia = indices[t * 3] * 3
    const ib = indices[t * 3 + 1] * 3
    const ic = indices[t * 3 + 2] * 3
    cx[t] = (vertices[ia] + vertices[ib] + vertices[ic]) / 3
    cy[t] = (vertices[ia + 1] + vertices[ib + 1] + vertices[ic + 1]) / 3
    cz[t] = (vertices[ia + 2] + vertices[ib + 2] + vertices[ic + 2]) / 3
  }

  const triOrder = new Uint32Array(triangleCount)
  for (let i = 0; i < triangleCount; i += 1) triOrder[i] = i

  // Upper bound on nodes. Median split doesn't guarantee full leaves, so a leaf
  // can hold as few as 1 triangle, giving up to `triangleCount` leaves and
  // `2*triangleCount - 1` total nodes. Size for that worst case.
  const maxNodes = Math.max(1, 2 * triangleCount)
  const bounds = new Float32Array(maxNodes * 6)
  const leftChild = new Int32Array(maxNodes).fill(-1)
  const rightChild = new Int32Array(maxNodes).fill(-1)
  const triStart = new Int32Array(maxNodes).fill(-1)
  const triCount = new Int32Array(maxNodes).fill(0)

  let nodeCount = 0

  // Recursive median split over triOrder[start, end).
  function build(start: number, end: number): number {
    const node = nodeCount
    nodeCount += 1
    const count = end - start

    if (count <= LEAF_TRIANGLES) {
      triStart[node] = start
      triCount[node] = count
      return node
    }

    // choose split axis = largest centroid extent
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = start; i < end; i += 1) {
      const t = triOrder[i]
      if (cx[t] < minX) minX = cx[t]; if (cx[t] > maxX) maxX = cx[t]
      if (cy[t] < minY) minY = cy[t]; if (cy[t] > maxY) maxY = cy[t]
      if (cz[t] < minZ) minZ = cz[t]; if (cz[t] > maxZ) maxZ = cz[t]
    }
    const extX = maxX - minX, extY = maxY - minY, extZ = maxZ - minZ
    const axis = extX >= extY ? (extX >= extZ ? 0 : 2) : (extY >= extZ ? 1 : 2)
    const centroidAxis = axis === 0 ? cx : axis === 1 ? cy : cz

    const mid = start + (count >> 1)
    // nth_element-style partial sort around the median by the chosen axis.
    quickselect(triOrder, start, end - 1, mid, centroidAxis)

    // Degenerate guard: if all centroids equal on this axis, mid stays as-is.
    const left = build(start, mid)
    const right = build(mid, end)
    leftChild[node] = left
    rightChild[node] = right
    triStart[node] = -1
    triCount[node] = 0
    return node
  }

  build(0, triangleCount)

  // Build a postorder traversal (children before parent) for bottom-up refit.
  const refitOrder = new Int32Array(nodeCount)
  {
    let w = 0
    // iterative postorder using the existing child pointers
    const tmp = new Int32Array(nodeCount)
    let sp = 0
    tmp[sp++] = 0
    const out: number[] = []
    while (sp > 0) {
      const n = tmp[--sp]
      out.push(n)
      const l = leftChild[n], r = rightChild[n]
      if (l >= 0) tmp[sp++] = l
      if (r >= 0) tmp[sp++] = r
    }
    // out is a preorder-ish (root first); reverse gives children-before-parent
    for (let i = out.length - 1; i >= 0; i -= 1) refitOrder[w++] = out[i]
  }

  const bvh: TriangleBVH = {
    nodeCount,
    bounds,
    leftChild,
    rightChild,
    triStart,
    triCount,
    triOrder,
    vertices,
    indices,
    stack: new Int32Array(STACK_SIZE),
    refitOrder,
    candidates: new Uint32Array(triangleCount),
  }

  refitTriangleBVH(bvh, vertices)
  return bvh
}

// Recompute every node AABB from current vertex positions. O(nodes). Call once
// per frame after the avatar re-skins. `vertices` may be a new array (same
// topology/length) — we rebind it.
export function refitTriangleBVH(bvh: TriangleBVH, vertices: Float32Array) {
  bvh.vertices = vertices
  const { bounds, leftChild, rightChild, triStart, triCount, triOrder, indices, refitOrder } = bvh
  for (let oi = 0; oi < refitOrder.length; oi += 1) {
    const node = refitOrder[oi]
    const b = node * 6
    if (leftChild[node] < 0) {
      // leaf: union of triangle vertex AABBs
      let minX = Infinity, minY = Infinity, minZ = Infinity
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      const start = triStart[node]
      const end = start + triCount[node]
      for (let i = start; i < end; i += 1) {
        const t = triOrder[i]
        for (let k = 0; k < 3; k += 1) {
          const v = indices[t * 3 + k] * 3
          const x = vertices[v], y = vertices[v + 1], z = vertices[v + 2]
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
        }
      }
      bounds[b] = minX; bounds[b + 1] = minY; bounds[b + 2] = minZ
      bounds[b + 3] = maxX; bounds[b + 4] = maxY; bounds[b + 5] = maxZ
    } else {
      const l = leftChild[node] * 6
      const r = rightChild[node] * 6
      bounds[b] = Math.min(bounds[l], bounds[r])
      bounds[b + 1] = Math.min(bounds[l + 1], bounds[r + 1])
      bounds[b + 2] = Math.min(bounds[l + 2], bounds[r + 2])
      bounds[b + 3] = Math.max(bounds[l + 3], bounds[r + 3])
      bounds[b + 4] = Math.max(bounds[l + 4], bounds[r + 4])
      bounds[b + 5] = Math.max(bounds[l + 5], bounds[r + 5])
    }
  }
}

// Squared distance from a point to an AABB (0 if inside).
function pointAabbDistSq(
  bounds: Float32Array, b: number,
  px: number, py: number, pz: number,
): number {
  let dx = 0, dy = 0, dz = 0
  if (px < bounds[b]) dx = bounds[b] - px
  else if (px > bounds[b + 3]) dx = px - bounds[b + 3]
  if (py < bounds[b + 1]) dy = bounds[b + 1] - py
  else if (py > bounds[b + 4]) dy = py - bounds[b + 4]
  if (pz < bounds[b + 2]) dz = bounds[b + 2] - pz
  else if (pz > bounds[b + 5]) dz = pz - bounds[b + 5]
  return dx * dx + dy * dy + dz * dz
}

// Collect every triangle whose leaf AABB is within `radius` of the point into
// bvh.candidates, returning the count. Allocation-free; the caller then runs the
// narrow phase over candidates[0..count). The point-to-AABB pruning guarantees
// the true closest triangle (whose closest point is within `radius`) is always
// included, so narrow-phase results match a brute-force scan within `radius`.
export function bvhQueryPointRadius(
  bvh: TriangleBVH,
  px: number, py: number, pz: number,
  radius: number,
): number {
  const { bounds, leftChild, rightChild, triStart, triCount, triOrder, stack, candidates } = bvh
  const radiusSq = radius * radius
  let count = 0
  let sp = 0
  stack[sp++] = 0
  while (sp > 0) {
    const node = stack[--sp]
    const b = node * 6
    if (pointAabbDistSq(bounds, b, px, py, pz) > radiusSq) continue
    const l = leftChild[node]
    if (l < 0) {
      const start = triStart[node]
      const end = start + triCount[node]
      for (let i = start; i < end; i += 1) candidates[count++] = triOrder[i]
    } else if (sp + 2 <= stack.length) {
      stack[sp++] = l
      stack[sp++] = rightChild[node]
    } else {
      count = collectSubtree(bvh, node, candidates, count)
    }
  }
  return count
}

// Collect every triangle whose leaf AABB overlaps the segment's padded AABB into
// bvh.candidates, returning the count. Used by the swept anti-tunneling path.
export function bvhQuerySegment(
  bvh: TriangleBVH,
  sx: number, sy: number, sz: number,
  ex: number, ey: number, ez: number,
  margin: number,
): number {
  const { bounds, leftChild, rightChild, triStart, triCount, triOrder, stack, candidates } = bvh
  const segMinX = Math.min(sx, ex) - margin, segMaxX = Math.max(sx, ex) + margin
  const segMinY = Math.min(sy, ey) - margin, segMaxY = Math.max(sy, ey) + margin
  const segMinZ = Math.min(sz, ez) - margin, segMaxZ = Math.max(sz, ez) + margin
  let count = 0
  let sp = 0
  stack[sp++] = 0
  while (sp > 0) {
    const node = stack[--sp]
    const b = node * 6
    if (
      bounds[b + 3] < segMinX || bounds[b] > segMaxX ||
      bounds[b + 4] < segMinY || bounds[b + 1] > segMaxY ||
      bounds[b + 5] < segMinZ || bounds[b + 2] > segMaxZ
    ) continue
    const l = leftChild[node]
    if (l < 0) {
      const start = triStart[node]
      const end = start + triCount[node]
      for (let i = start; i < end; i += 1) candidates[count++] = triOrder[i]
    } else if (sp + 2 <= stack.length) {
      stack[sp++] = l
      stack[sp++] = rightChild[node]
    } else {
      count = collectSubtree(bvh, node, candidates, count)
    }
  }
  return count
}

function collectSubtree(bvh: TriangleBVH, node: number, out: Uint32Array, count: number): number {
  const { leftChild, rightChild, triStart, triCount, triOrder } = bvh
  const l = leftChild[node]
  if (l < 0) {
    const start = triStart[node]
    const end = start + triCount[node]
    for (let i = start; i < end; i += 1) out[count++] = triOrder[i]
    return count
  }
  count = collectSubtree(bvh, l, out, count)
  count = collectSubtree(bvh, rightChild[node], out, count)
  return count
}

// In-place quickselect (Hoare partition) so triOrder[k] is the k-th smallest by
// `key`, with all smaller before it. Used to median-split during build.
function quickselect(order: Uint32Array, lo: number, hi: number, k: number, key: Float32Array) {
  while (lo < hi) {
    const pivot = key[order[(lo + hi) >> 1]]
    let i = lo
    let j = hi
    while (i <= j) {
      while (key[order[i]] < pivot) i += 1
      while (key[order[j]] > pivot) j -= 1
      if (i <= j) {
        const tmp = order[i]; order[i] = order[j]; order[j] = tmp
        i += 1; j -= 1
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
}
