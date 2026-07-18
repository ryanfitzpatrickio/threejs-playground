import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTriangleBVH, refitTriangleBVH, bvhQueryPointRadius, bvhQuerySegment } from './triangleBVH'

// The BVH is the collision broad phase. Correctness requirement: for any query
// point and radius, the candidate set it returns must contain EVERY triangle
// whose actual closest-point distance is <= radius. (It may contain more — those
// get rejected by the narrow phase — but it must never miss one.) These tests
// pin that against brute force over randomized meshes.

function lcg(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff)
}

function randomMesh(seed: number, triCount: number) {
  const rand = lcg(seed)
  const vertices = new Float32Array(triCount * 9)
  const indices = new Uint32Array(triCount * 3)
  for (let t = 0; t < triCount; t += 1) {
    // small triangles scattered in a unit cube
    const ox = rand() * 2 - 1, oy = rand() * 2 - 1, oz = rand() * 2 - 1
    for (let k = 0; k < 3; k += 1) {
      const v = (t * 3 + k) * 3
      vertices[v] = ox + (rand() - 0.5) * 0.15
      vertices[v + 1] = oy + (rand() - 0.5) * 0.15
      vertices[v + 2] = oz + (rand() - 0.5) * 0.15
      indices[t * 3 + k] = t * 3 + k
    }
  }
  return { vertices, indices }
}

// Closest point on triangle to p (returns squared distance). Mirrors the
// production narrow phase well enough for a distance ground truth.
function closestDistSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  let qx, qy, qz
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz
    const d3 = abx * bpx + aby * bpy + abz * bpz
    const d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz }
    else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3)
        qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz
        const d5 = abx * cpx + aby * cpy + abz * cpz
        const d6 = acx * cpx + acy * cpy + acz * cpz
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz }
        else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6)
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w
          } else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w
            } else {
              const denom = 1 / (va + vb + vc)
              const v = vb * denom, w = vc * denom
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz
  return dx * dx + dy * dy + dz * dz
}

function bruteForceWithin(vertices: Float32Array, indices: Uint32Array, px: number, py: number, pz: number, radius: number): Set<number> {
  const set = new Set<number>()
  const rsq = radius * radius
  for (let t = 0; t < indices.length / 3; t += 1) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3
    const d = closestDistSq(px, py, pz,
      vertices[ia], vertices[ia + 1], vertices[ia + 2],
      vertices[ib], vertices[ib + 1], vertices[ib + 2],
      vertices[ic], vertices[ic + 1], vertices[ic + 2])
    if (d <= rsq) set.add(t)
  }
  return set
}

describe('TriangleBVH point-radius query is a conservative superset of brute force', () => {
  for (const seed of [1, 2, 7, 42, 100]) {
    test(`seed=${seed}: never misses a triangle within radius`, () => {
      const { vertices, indices } = randomMesh(seed, 400)
      const bvh = buildTriangleBVH(vertices, indices)
      const rand = lcg(seed * 31 + 5)
      for (let q = 0; q < 200; q += 1) {
        const px = rand() * 2 - 1, py = rand() * 2 - 1, pz = rand() * 2 - 1
        const radius = 0.02 + rand() * 0.1
        const truth = bruteForceWithin(vertices, indices, px, py, pz, radius)
        const count = bvhQueryPointRadius(bvh, px, py, pz, radius)
        const got = new Set<number>()
        for (let i = 0; i < count; i += 1) got.add(bvh.candidates[i])
        for (const t of truth) {
          assert.ok(got.has(t), `seed=${seed} q=${q}: BVH missed triangle ${t} within radius ${radius}`)
        }
      }
    })
  }
})

describe('TriangleBVH segment query covers the segment AABB', () => {
  test('includes every triangle whose AABB overlaps the padded segment box', () => {
    const { vertices, indices } = randomMesh(9, 300)
    const bvh = buildTriangleBVH(vertices, indices)
    const rand = lcg(123)
    for (let q = 0; q < 100; q += 1) {
      const sx = rand() * 2 - 1, sy = rand() * 2 - 1, sz = rand() * 2 - 1
      const ex = sx + (rand() - 0.5) * 0.3, ey = sy + (rand() - 0.5) * 0.3, ez = sz + (rand() - 0.5) * 0.3
      const margin = 0.03
      const minX = Math.min(sx, ex) - margin, maxX = Math.max(sx, ex) + margin
      const minY = Math.min(sy, ey) - margin, maxY = Math.max(sy, ey) + margin
      const minZ = Math.min(sz, ez) - margin, maxZ = Math.max(sz, ez) + margin
      // brute: triangles whose AABB overlaps the box
      const truth = new Set<number>()
      for (let t = 0; t < indices.length / 3; t += 1) {
        const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3
        const tMinX = Math.min(vertices[ia], vertices[ib], vertices[ic])
        const tMaxX = Math.max(vertices[ia], vertices[ib], vertices[ic])
        const tMinY = Math.min(vertices[ia + 1], vertices[ib + 1], vertices[ic + 1])
        const tMaxY = Math.max(vertices[ia + 1], vertices[ib + 1], vertices[ic + 1])
        const tMinZ = Math.min(vertices[ia + 2], vertices[ib + 2], vertices[ic + 2])
        const tMaxZ = Math.max(vertices[ia + 2], vertices[ib + 2], vertices[ic + 2])
        if (tMaxX < minX || tMinX > maxX || tMaxY < minY || tMinY > maxY || tMaxZ < minZ || tMinZ > maxZ) continue
        truth.add(t)
      }
      const count = bvhQuerySegment(bvh, sx, sy, sz, ex, ey, ez, margin)
      const got = new Set<number>()
      for (let i = 0; i < count; i += 1) got.add(bvh.candidates[i])
      for (const t of truth) assert.ok(got.has(t), `q=${q}: segment query missed triangle ${t}`)
    }
  })
})

describe('TriangleBVH refit tracks moved vertices', () => {
  test('after refit, query reflects new positions', () => {
    const { vertices, indices } = randomMesh(5, 200)
    const bvh = buildTriangleBVH(vertices, indices)
    // move all vertices by a fixed offset
    const moved = new Float32Array(vertices.length)
    for (let i = 0; i < vertices.length; i += 3) {
      moved[i] = vertices[i] + 0.5
      moved[i + 1] = vertices[i + 1] - 0.3
      moved[i + 2] = vertices[i + 2] + 0.2
    }
    refitTriangleBVH(bvh, moved)
    const rand = lcg(77)
    for (let q = 0; q < 100; q += 1) {
      const px = rand() * 3 - 1, py = rand() * 3 - 1.5, pz = rand() * 3 - 1
      const radius = 0.03 + rand() * 0.08
      const truth = bruteForceWithin(moved, indices, px, py, pz, radius)
      const count = bvhQueryPointRadius(bvh, px, py, pz, radius)
      const got = new Set<number>()
      for (let i = 0; i < count; i += 1) got.add(bvh.candidates[i])
      for (const t of truth) assert.ok(got.has(t), `q=${q}: missed ${t} after refit`)
    }
  })
})

describe('TriangleBVH handles tiny meshes', () => {
  test('single triangle', () => {
    const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    const bvh = buildTriangleBVH(vertices, indices)
    const count = bvhQueryPointRadius(bvh, 0.2, 0.2, 0.05, 0.1)
    assert.equal(count, 1)
    assert.equal(bvh.candidates[0], 0)
    const far = bvhQueryPointRadius(bvh, 5, 5, 5, 0.1)
    assert.equal(far, 0)
  })
})
