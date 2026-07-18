import type {
  CapsuleProxy,
  ClothSimMesh,
  ColliderProxy,
  ColliderSnapshot,
  CollisionBounds,
  CollisionMeshPatchSnapshot,
  EllipsoidProxy,
  MeshSurfaceColliderSnapshot,
  SphereProxy,
} from '../types'
import { bvhQueryPointRadius, bvhQuerySegment } from './triangleBVH'

const CONTACT_RESULT = new Float32Array(6)
const TRIANGLE_RESULT = new Float32Array(6)
const SWEEP_RESULT = new Float32Array(7)
const ROTATED_LOCAL = new Float32Array(3)
const ROTATED_SURFACE = new Float32Array(3)
const ROTATED_NORMAL = new Float32Array(3)
const FRICTION_RESULT = new Float32Array(3)
const MAX_COLLIDER_SEARCH_RADIUS = 4

type TriangleColliderSurface = CollisionMeshPatchSnapshot | MeshSurfaceColliderSnapshot

export function solveCollisionConstraints(mesh: ClothSimMesh, snapshot: ColliderSnapshot | null) {
  if (
    !snapshot
    || (
      snapshot.proxies.length === 0
      && (snapshot.meshColliders?.length ?? 0) === 0
      && (snapshot.lowResMeshPatches?.length ?? 0) === 0
    )
  ) return
  const { positions, prevPositions, invMass, particleCount, particleFrictions } = mesh

  for (let particle = 0; particle < particleCount; particle += 1) {
    if (invMass[particle] === 0) continue
    const garmentFriction = particleFrictions?.[particle] ?? 1
    const offset = particle * 3
    const prevX = prevPositions[offset]
    const prevY = prevPositions[offset + 1]
    const prevZ = prevPositions[offset + 2]
    let px = positions[offset]
    let py = positions[offset + 1]
    let pz = positions[offset + 2]
    let hit = false

    for (const meshCollider of snapshot.meshColliders ?? []) {
      if (!pushOutOfMeshCollider(meshCollider, prevX, prevY, prevZ, px, py, pz, CONTACT_RESULT)) continue
      px = CONTACT_RESULT[0]
      py = CONTACT_RESULT[1]
      pz = CONTACT_RESULT[2]
      applyContactFriction(FRICTION_RESULT, prevX, prevY, prevZ, px, py, pz, CONTACT_RESULT[3], CONTACT_RESULT[4], CONTACT_RESULT[5], combineContactFriction(meshCollider.friction, garmentFriction), meshCollider.skin + meshCollider.thickness)
      px = FRICTION_RESULT[0]; py = FRICTION_RESULT[1]; pz = FRICTION_RESULT[2]
      hit = true
    }

    for (const patch of snapshot.lowResMeshPatches ?? []) {
      if (!pushOutOfLowResPatch(patch, px, py, pz, CONTACT_RESULT)) continue
      px = CONTACT_RESULT[0]
      py = CONTACT_RESULT[1]
      pz = CONTACT_RESULT[2]
      applyContactFriction(FRICTION_RESULT, prevX, prevY, prevZ, px, py, pz, CONTACT_RESULT[3], CONTACT_RESULT[4], CONTACT_RESULT[5], combineContactFriction(patch.friction, garmentFriction), patch.skin + patch.thickness)
      px = FRICTION_RESULT[0]; py = FRICTION_RESULT[1]; pz = FRICTION_RESULT[2]
      hit = true
    }

    for (const proxy of snapshot.proxies) {
      if (!pushOut(proxy, px, py, pz, CONTACT_RESULT)) continue
      px = CONTACT_RESULT[0]
      py = CONTACT_RESULT[1]
      pz = CONTACT_RESULT[2]
      const proxyNormalForce = proxy.kind === 'ellipsoid'
        ? Math.min(proxy.rx, proxy.ry, proxy.rz) + proxy.skin
        : proxy.r + proxy.skin
      applyContactFriction(FRICTION_RESULT, prevX, prevY, prevZ, px, py, pz, CONTACT_RESULT[3], CONTACT_RESULT[4], CONTACT_RESULT[5], combineContactFriction(proxy.friction, garmentFriction), proxyNormalForce)
      px = FRICTION_RESULT[0]; py = FRICTION_RESULT[1]; pz = FRICTION_RESULT[2]
      hit = true
    }

    if (hit) {
      positions[offset] = px
      positions[offset + 1] = py
      positions[offset + 2] = pz
    }
  }

  solveTriangleCollisionConstraints(mesh, snapshot)
}

function combineContactFriction(colliderFriction: number, garmentFriction: number) {
  return Math.max(0, colliderFriction * garmentFriction)
}

function solveTriangleCollisionConstraints(mesh: ClothSimMesh, snapshot: ColliderSnapshot) {
  const { positions, prevPositions, invMass, triangles } = mesh
  if (triangles.length === 0) return

  for (let triangle = 0; triangle < triangles.length; triangle += 3) {
    const a = triangles[triangle]
    const b = triangles[triangle + 1]
    const c = triangles[triangle + 2]
    const wa = invMass[a]
    const wb = invMass[b]
    const wc = invMass[c]
    const wsum = wa + wb + wc
    if (wsum <= 1e-9) continue

    const ia = a * 3
    const ib = b * 3
    const ic = c * 3
    const prevX = (prevPositions[ia] + prevPositions[ib] + prevPositions[ic]) / 3
    const prevY = (prevPositions[ia + 1] + prevPositions[ib + 1] + prevPositions[ic + 1]) / 3
    const prevZ = (prevPositions[ia + 2] + prevPositions[ib + 2] + prevPositions[ic + 2]) / 3
    let px = (positions[ia] + positions[ib] + positions[ic]) / 3
    let py = (positions[ia + 1] + positions[ib + 1] + positions[ic + 1]) / 3
    let pz = (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3
    let hit = false

    for (const meshCollider of snapshot.meshColliders ?? []) {
      if (!pushOutOfMeshCollider(meshCollider, prevX, prevY, prevZ, px, py, pz, CONTACT_RESULT)) continue
      px = CONTACT_RESULT[0]
      py = CONTACT_RESULT[1]
      pz = CONTACT_RESULT[2]
      hit = true
    }

    for (const patch of snapshot.lowResMeshPatches ?? []) {
      if (!pushOutOfLowResPatch(patch, px, py, pz, CONTACT_RESULT)) continue
      px = CONTACT_RESULT[0]
      py = CONTACT_RESULT[1]
      pz = CONTACT_RESULT[2]
      hit = true
    }

    for (const proxy of snapshot.proxies) {
      if (!pushOut(proxy, px, py, pz, CONTACT_RESULT)) continue
      px = CONTACT_RESULT[0]
      py = CONTACT_RESULT[1]
      pz = CONTACT_RESULT[2]
      hit = true
    }

    if (!hit) continue
    const correctionX = px - (positions[ia] + positions[ib] + positions[ic]) / 3
    const correctionY = py - (positions[ia + 1] + positions[ib + 1] + positions[ic + 1]) / 3
    const correctionZ = pz - (positions[ia + 2] + positions[ib + 2] + positions[ic + 2]) / 3
    applyTriangleCorrection(positions, ia, correctionX, correctionY, correctionZ, (wa / wsum) * 3)
    applyTriangleCorrection(positions, ib, correctionX, correctionY, correctionZ, (wb / wsum) * 3)
    applyTriangleCorrection(positions, ic, correctionX, correctionY, correctionZ, (wc / wsum) * 3)
  }
}

function applyTriangleCorrection(
  positions: Float32Array,
  offset: number,
  correctionX: number,
  correctionY: number,
  correctionZ: number,
  weight: number,
) {
  positions[offset] += correctionX * weight
  positions[offset + 1] += correctionY * weight
  positions[offset + 2] += correctionZ * weight
}

// Applies Coulomb friction as a position correction: pulls the post-collision
// position back toward the pre-substep position in the tangential plane.
// Writes the friction-corrected position into `out`.
function applyContactFriction(
  out: Float32Array,
  prevX: number,
  prevY: number,
  prevZ: number,
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  friction: number,
  penDepth: number,
) {
  if (penDepth <= 1e-6) {
    out[0] = px; out[1] = py; out[2] = pz
    return
  }
  const dx = px - prevX
  const dy = py - prevY
  const dz = pz - prevZ
  const normalDot = dx * nx + dy * ny + dz * nz
  // Tangential displacement (the component parallel to the contact surface).
  const tx = dx - nx * normalDot
  const ty = dy - ny * normalDot
  const tz = dz - nz * normalDot
  const tangMagSq = tx * tx + ty * ty + tz * tz
  const coulombLimit = friction * penDepth
  if (tangMagSq <= coulombLimit * coulombLimit) {
    // Static friction: pull position fully back to where it was tangentially.
    out[0] = px - tx
    out[1] = py - ty
    out[2] = pz - tz
  } else {
    // Kinetic friction: allow slip up to μ × penDepth.
    const tangMag = Math.sqrt(tangMagSq)
    const allowed = coulombLimit / tangMag
    out[0] = px - tx * (1 - allowed)
    out[1] = py - ty * (1 - allowed)
    out[2] = pz - tz * (1 - allowed)
  }
}

function pushOutOfLowResPatch(
  patch: CollisionMeshPatchSnapshot,
  px: number,
  py: number,
  pz: number,
  out: Float32Array,
) {
  const target = patch.skin + patch.thickness
  if (target <= 0 || patch.indices.length < 3 || isOutsideBounds(patch.bounds, target, px, py, pz)) return false

  const searchRadius = colliderSearchRadius(target, patch.cellSize)
  const cx = Math.floor(px / patch.cellSize)
  const cy = Math.floor(py / patch.cellSize)
  const cz = Math.floor(pz / patch.cellSize)
  const visitStamp = nextVisitStamp(patch)
  let bestDistSq = Infinity
  let bestX = 0
  let bestY = 0
  let bestZ = 0
  let bestNx = 0
  let bestNy = 1
  let bestNz = 0

  for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
    for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
      for (let dz = -searchRadius; dz <= searchRadius; dz += 1) {
        const cellIndex = patch.cellIndexLookup.get(hashCell(cx + dx, cy + dy, cz + dz))
        if (cellIndex === undefined) continue
        const start = patch.cellStarts[cellIndex]
        const count = patch.cellCounts[cellIndex]
        for (let item = 0; item < count; item += 1) {
          const triangle = patch.cellTriangleIndices[start + item]
          if (patch.triangleVisitMarks[triangle] === visitStamp) continue
          patch.triangleVisitMarks[triangle] = visitStamp
          if (!closestPointOnTriangle(patch, triangle, px, py, pz, TRIANGLE_RESULT, target)) continue
          const deltaX = px - TRIANGLE_RESULT[0]
          const deltaY = py - TRIANGLE_RESULT[1]
          const deltaZ = pz - TRIANGLE_RESULT[2]
          const distSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ
          if (distSq < bestDistSq) {
            bestDistSq = distSq
            bestX = TRIANGLE_RESULT[0]
            bestY = TRIANGLE_RESULT[1]
            bestZ = TRIANGLE_RESULT[2]
            bestNx = TRIANGLE_RESULT[3]
            bestNy = TRIANGLE_RESULT[4]
            bestNz = TRIANGLE_RESULT[5]
          }
        }
      }
    }
  }

  if (bestDistSq >= target * target) return false
  const dist = Math.sqrt(bestDistSq)
  let nx = px - bestX
  let ny = py - bestY
  let nz = pz - bestZ
  if (dist > 1e-6) {
    const inv = 1 / dist
    nx *= inv
    ny *= inv
    nz *= inv
  } else {
    nx = bestNx
    ny = bestNy
    nz = bestNz
  }
  const correction = target - dist
  out[0] = px + nx * correction
  out[1] = py + ny * correction
  out[2] = pz + nz * correction
  out[3] = nx
  out[4] = ny
  out[5] = nz
  return true
}

function pushOutOfMeshCollider(
  collider: MeshSurfaceColliderSnapshot,
  prevX: number,
  prevY: number,
  prevZ: number,
  px: number,
  py: number,
  pz: number,
  out: Float32Array,
) {
  const target = collider.skin + collider.thickness
  if (target <= 0) return false

  if (collider.bvh) {
    return pushOutOfMeshColliderBVH(collider, target, prevX, prevY, prevZ, px, py, pz, out)
  }

  const cellSize = collider.cellSize
  const invCellSize = 1 / cellSize
  const visitStamp = nextVisitStamp(collider)
  const hashKeys = collider.cellHashKeys
  const hashValues = collider.cellHashValues
  const hashMask = collider.cellHashMask ?? -1
  const useOA = hashKeys !== undefined && hashValues !== undefined && hashMask >= 0
  const triangleVisitMarks = collider.triangleVisitMarks
  const cellStarts = collider.cellStarts
  const cellCounts = collider.cellCounts
  const cellTriangleIndices = collider.cellTriangleIndices
  const triangleCentroids = collider.triangleCentroids
  const triangleRadii = collider.triangleRadii
  const triangleNormals = collider.triangleNormals
  const vertices = collider.vertices
  const indices = collider.indices

  if (!isOutsideBounds(collider.bounds, target, px, py, pz)) {
    const searchRadius = colliderSearchRadius(target, cellSize)
    const cx = Math.floor(px * invCellSize)
    const cy = Math.floor(py * invCellSize)
    const cz = Math.floor(pz * invCellSize)
    let bestDistSq = Infinity
    let bestX = 0
    let bestY = 0
    let bestZ = 0
    let bestNx = 0
    let bestNy = 1
    let bestNz = 0
    let currentTargetDist = target

    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
        for (let dz = -searchRadius; dz <= searchRadius; dz += 1) {
          const key = hashCell(cx + dx, cy + dy, cz + dz)
          let cellIndex: number
          if (useOA) {
            cellIndex = lookupOA(hashKeys!, hashValues!, hashMask, key)
            if (cellIndex < 0) continue
          } else {
            const found = collider.cellIndexLookup.get(key)
            if (found === undefined) continue
            cellIndex = found
          }
          const start = cellStarts[cellIndex]
          const count = cellCounts[cellIndex]
          for (let item = 0; item < count; item += 1) {
            const triangle = cellTriangleIndices[start + item]
            if (triangleVisitMarks[triangle] === visitStamp) continue
            triangleVisitMarks[triangle] = visitStamp
            if (triangleCentroids && triangleRadii) {
              const normalOffset = triangle * 3
              const cdx = px - triangleCentroids[normalOffset]
              const cdy = py - triangleCentroids[normalOffset + 1]
              const cdz = pz - triangleCentroids[normalOffset + 2]
              const centerDistSq = cdx * cdx + cdy * cdy + cdz * cdz
              const reachable = currentTargetDist + triangleRadii[triangle]
              if (centerDistSq > reachable * reachable) continue
            }
            const nx = triangleNormals[triangle * 3]
            const ny = triangleNormals[triangle * 3 + 1]
            const nz = triangleNormals[triangle * 3 + 2]
            if (nx === 0 && ny === 0 && nz === 0) continue
            const ia = indices[triangle * 3] * 3
            const ib = indices[triangle * 3 + 1] * 3
            const ic = indices[triangle * 3 + 2] * 3
            closestPointTriangleRaw(
              px, py, pz,
              vertices[ia], vertices[ia + 1], vertices[ia + 2],
              vertices[ib], vertices[ib + 1], vertices[ib + 2],
              vertices[ic], vertices[ic + 1], vertices[ic + 2],
              TRIANGLE_RESULT,
            )
            TRIANGLE_RESULT[3] = nx
            TRIANGLE_RESULT[4] = ny
            TRIANGLE_RESULT[5] = nz
            const deltaX = px - TRIANGLE_RESULT[0]
            const deltaY = py - TRIANGLE_RESULT[1]
            const deltaZ = pz - TRIANGLE_RESULT[2]
            const distSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ
            if (distSq < bestDistSq) {
              bestDistSq = distSq
              bestX = TRIANGLE_RESULT[0]
              bestY = TRIANGLE_RESULT[1]
              bestZ = TRIANGLE_RESULT[2]
              bestNx = nx
              bestNy = ny
              bestNz = nz
              currentTargetDist = Math.sqrt(distSq)
            }
          }
        }
      }
    }

    if (bestDistSq !== Infinity) {
      const dx = px - bestX
      const dy = py - bestY
      const dz = pz - bestZ
      const signed = dx * bestNx + dy * bestNy + dz * bestNz
      const dist = Math.sqrt(bestDistSq)
      if (signed < 0 || dist < target) {
        let nx: number
        let ny: number
        let nz: number
        let correction: number
        if (signed >= 0) {
          if (dist > 1e-6) {
            const inv = 1 / dist
            nx = dx * inv
            ny = dy * inv
            nz = dz * inv
          } else {
            nx = bestNx
            ny = bestNy
            nz = bestNz
          }
          correction = target - dist
        } else {
          nx = bestNx
          ny = bestNy
          nz = bestNz
          correction = target + dist
        }
        out[0] = px + nx * correction
        out[1] = py + ny * correction
        out[2] = pz + nz * correction
        out[3] = nx
        out[4] = ny
        out[5] = nz
        return true
      }
    }
  }
  return pushOutOfSweptMeshCollider(collider, target, prevX, prevY, prevZ, px, py, pz, out)
}

// BVH-accelerated equivalent of pushOutOfMeshCollider. Same narrow phase and
// signed push-out as the grid path; only the broad phase differs. The BVH prunes
// to a tight candidate set, so we test every candidate (no visit-order-dependent
// centroid cull) and pick the true-closest triangle — at least as accurate as
// the grid, and with far fewer tests.
function pushOutOfMeshColliderBVH(
  collider: MeshSurfaceColliderSnapshot,
  target: number,
  prevX: number,
  prevY: number,
  prevZ: number,
  px: number,
  py: number,
  pz: number,
  out: Float32Array,
) {
  const bvh = collider.bvh!
  const triangleNormals = collider.triangleNormals
  const vertices = collider.vertices
  const indices = collider.indices

  if (!isOutsideBounds(collider.bounds, target, px, py, pz)) {
    const count = bvhQueryPointRadius(bvh, px, py, pz, target)
    let bestDistSq = Infinity
    let bestX = 0
    let bestY = 0
    let bestZ = 0
    let bestNx = 0
    let bestNy = 1
    let bestNz = 0

    const candidates = bvh.candidates
    for (let c = 0; c < count; c += 1) {
      const triangle = candidates[c]
      const nx = triangleNormals[triangle * 3]
      const ny = triangleNormals[triangle * 3 + 1]
      const nz = triangleNormals[triangle * 3 + 2]
      if (nx === 0 && ny === 0 && nz === 0) continue
      const ia = indices[triangle * 3] * 3
      const ib = indices[triangle * 3 + 1] * 3
      const ic = indices[triangle * 3 + 2] * 3
      closestPointTriangleRaw(
        px, py, pz,
        vertices[ia], vertices[ia + 1], vertices[ia + 2],
        vertices[ib], vertices[ib + 1], vertices[ib + 2],
        vertices[ic], vertices[ic + 1], vertices[ic + 2],
        TRIANGLE_RESULT,
      )
      const deltaX = px - TRIANGLE_RESULT[0]
      const deltaY = py - TRIANGLE_RESULT[1]
      const deltaZ = pz - TRIANGLE_RESULT[2]
      const distSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        bestX = TRIANGLE_RESULT[0]
        bestY = TRIANGLE_RESULT[1]
        bestZ = TRIANGLE_RESULT[2]
        bestNx = nx
        bestNy = ny
        bestNz = nz
      }
    }

    if (bestDistSq !== Infinity) {
      const dx = px - bestX
      const dy = py - bestY
      const dz = pz - bestZ
      const signed = dx * bestNx + dy * bestNy + dz * bestNz
      const dist = Math.sqrt(bestDistSq)
      if (signed < 0 || dist < target) {
        let nx: number
        let ny: number
        let nz: number
        let correction: number
        if (signed >= 0) {
          if (dist > 1e-6) {
            const inv = 1 / dist
            nx = dx * inv
            ny = dy * inv
            nz = dz * inv
          } else {
            nx = bestNx
            ny = bestNy
            nz = bestNz
          }
          correction = target - dist
        } else {
          nx = bestNx
          ny = bestNy
          nz = bestNz
          correction = target + dist
        }
        out[0] = px + nx * correction
        out[1] = py + ny * correction
        out[2] = pz + nz * correction
        out[3] = nx
        out[4] = ny
        out[5] = nz
        return true
      }
    }
  }

  return pushOutOfSweptMeshColliderBVH(collider, target, prevX, prevY, prevZ, px, py, pz, out)
}

// BVH-accelerated swept (anti-tunneling) path. Mirrors pushOutOfSweptMeshCollider
// but pulls candidates from the BVH segment query instead of the cell box.
function pushOutOfSweptMeshColliderBVH(
  collider: MeshSurfaceColliderSnapshot,
  target: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  out: Float32Array,
) {
  if (segmentOutsideBounds(collider.bounds, target, startX, startY, startZ, endX, endY, endZ)) return false
  const bvh = collider.bvh!
  const count = bvhQuerySegment(bvh, startX, startY, startZ, endX, endY, endZ, target)
  const candidates = bvh.candidates
  let bestT = Infinity
  let bestX = 0
  let bestY = 0
  let bestZ = 0
  let bestNx = 0
  let bestNy = 1
  let bestNz = 0

  for (let c = 0; c < count; c += 1) {
    const triangle = candidates[c]
    if (!segmentIntersectsTriangle(collider, triangle, startX, startY, startZ, endX, endY, endZ, target, SWEEP_RESULT)) continue
    const t = SWEEP_RESULT[0]
    if (t >= bestT) continue
    bestT = t
    bestX = SWEEP_RESULT[1]
    bestY = SWEEP_RESULT[2]
    bestZ = SWEEP_RESULT[3]
    bestNx = SWEEP_RESULT[4]
    bestNy = SWEEP_RESULT[5]
    bestNz = SWEEP_RESULT[6]
  }

  if (bestT === Infinity) return false
  out[0] = bestX + bestNx * target
  out[1] = bestY + bestNy * target
  out[2] = bestZ + bestNz * target
  out[3] = bestNx
  out[4] = bestNy
  out[5] = bestNz
  return true
}

function pushOutOfSweptMeshCollider(
  collider: MeshSurfaceColliderSnapshot,
  target: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  out: Float32Array,
) {
  if (segmentOutsideBounds(collider.bounds, target, startX, startY, startZ, endX, endY, endZ)) return false
  const cellSize = collider.cellSize
  const invCellSize = 1 / cellSize
  const minCellX = Math.floor((Math.min(startX, endX) - target) * invCellSize)
  const maxCellX = Math.floor((Math.max(startX, endX) + target) * invCellSize)
  const minCellY = Math.floor((Math.min(startY, endY) - target) * invCellSize)
  const maxCellY = Math.floor((Math.max(startY, endY) + target) * invCellSize)
  const minCellZ = Math.floor((Math.min(startZ, endZ) - target) * invCellSize)
  const maxCellZ = Math.floor((Math.max(startZ, endZ) + target) * invCellSize)
  const hashKeys = collider.cellHashKeys
  const hashValues = collider.cellHashValues
  const hashMask = collider.cellHashMask ?? -1
  const useOA = hashKeys !== undefined && hashValues !== undefined && hashMask >= 0
  const visitStamp = nextVisitStamp(collider)
  let bestT = Infinity
  let bestX = 0
  let bestY = 0
  let bestZ = 0
  let bestNx = 0
  let bestNy = 1
  let bestNz = 0

  for (let cx = minCellX; cx <= maxCellX; cx += 1) {
    for (let cy = minCellY; cy <= maxCellY; cy += 1) {
      for (let cz = minCellZ; cz <= maxCellZ; cz += 1) {
        const key = hashCell(cx, cy, cz)
        let cellIndex: number
        if (useOA) {
          cellIndex = lookupOA(hashKeys!, hashValues!, hashMask, key)
          if (cellIndex < 0) continue
        } else {
          const found = collider.cellIndexLookup.get(key)
          if (found === undefined) continue
          cellIndex = found
        }
        const start = collider.cellStarts[cellIndex]
        const count = collider.cellCounts[cellIndex]
        for (let item = 0; item < count; item += 1) {
          const triangle = collider.cellTriangleIndices[start + item]
          if (collider.triangleVisitMarks[triangle] === visitStamp) continue
          collider.triangleVisitMarks[triangle] = visitStamp
          if (!segmentIntersectsTriangle(collider, triangle, startX, startY, startZ, endX, endY, endZ, target, SWEEP_RESULT)) continue
          const t = SWEEP_RESULT[0]
          if (t >= bestT) continue
          bestT = t
          bestX = SWEEP_RESULT[1]
          bestY = SWEEP_RESULT[2]
          bestZ = SWEEP_RESULT[3]
          bestNx = SWEEP_RESULT[4]
          bestNy = SWEEP_RESULT[5]
          bestNz = SWEEP_RESULT[6]
        }
      }
    }
  }

  if (bestT === Infinity) return false
  out[0] = bestX + bestNx * target
  out[1] = bestY + bestNy * target
  out[2] = bestZ + bestNz * target
  out[3] = bestNx
  out[4] = bestNy
  out[5] = bestNz
  return true
}

function segmentIntersectsTriangle(
  collider: MeshSurfaceColliderSnapshot,
  triangle: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  target: number,
  out: Float32Array,
) {
  const normalOffset = triangle * 3
  let nx = collider.triangleNormals[normalOffset]
  let ny = collider.triangleNormals[normalOffset + 1]
  let nz = collider.triangleNormals[normalOffset + 2]
  if (nx === 0 && ny === 0 && nz === 0) return false

  const ia = collider.indices[triangle * 3] * 3
  const ib = collider.indices[triangle * 3 + 1] * 3
  const ic = collider.indices[triangle * 3 + 2] * 3
  const ax = collider.vertices[ia]
  const ay = collider.vertices[ia + 1]
  const az = collider.vertices[ia + 2]
  const bx = collider.vertices[ib]
  const by = collider.vertices[ib + 1]
  const bz = collider.vertices[ib + 2]
  const cx = collider.vertices[ic]
  const cy = collider.vertices[ic + 1]
  const cz = collider.vertices[ic + 2]
  const startSigned = (startX - ax) * nx + (startY - ay) * ny + (startZ - az) * nz
  const endSigned = (endX - ax) * nx + (endY - ay) * ny + (endZ - az) * nz
  if ((startSigned > target && endSigned > target) || (startSigned < -target && endSigned < -target)) return false
  const denom = startSigned - endSigned
  if (Math.abs(denom) <= 1e-8) return false
  const t = startSigned / denom
  if (t < 0 || t > 1) return false

  const hitX = startX + (endX - startX) * t
  const hitY = startY + (endY - startY) * t
  const hitZ = startZ + (endZ - startZ) * t
  closestPointTriangleRaw(hitX, hitY, hitZ, ax, ay, az, bx, by, bz, cx, cy, cz, CONTACT_RESULT)
  const errX = hitX - CONTACT_RESULT[0]
  const errY = hitY - CONTACT_RESULT[1]
  const errZ = hitZ - CONTACT_RESULT[2]
  if (errX * errX + errY * errY + errZ * errZ > 1e-8) return false

  if (startSigned < 0) {
    nx = -nx
    ny = -ny
    nz = -nz
  }
  out[0] = t
  out[1] = hitX
  out[2] = hitY
  out[3] = hitZ
  out[4] = nx
  out[5] = ny
  out[6] = nz
  return true
}

function closestPointOnTriangle(
  collider: TriangleColliderSurface,
  triangle: number,
  px: number,
  py: number,
  pz: number,
  out: Float32Array,
  target?: number,
) {
  const normalOffset = triangle * 3
  const nx = collider.triangleNormals[normalOffset]
  const ny = collider.triangleNormals[normalOffset + 1]
  const nz = collider.triangleNormals[normalOffset + 2]
  if (nx === 0 && ny === 0 && nz === 0) return false
  const centroids = collider.triangleCentroids
  const radii = collider.triangleRadii
  if (centroids && radii && target !== undefined) {
    const cdx = px - centroids[normalOffset]
    const cdy = py - centroids[normalOffset + 1]
    const cdz = pz - centroids[normalOffset + 2]
    const centerDistSq = cdx * cdx + cdy * cdy + cdz * cdz
    const reachable = target + radii[triangle]
    if (centerDistSq > reachable * reachable) return false
  }
  const ia = collider.indices[triangle * 3] * 3
  const ib = collider.indices[triangle * 3 + 1] * 3
  const ic = collider.indices[triangle * 3 + 2] * 3
  closestPointTriangleRaw(
    px,
    py,
    pz,
    collider.vertices[ia],
    collider.vertices[ia + 1],
    collider.vertices[ia + 2],
    collider.vertices[ib],
    collider.vertices[ib + 1],
    collider.vertices[ib + 2],
    collider.vertices[ic],
    collider.vertices[ic + 1],
    collider.vertices[ic + 2],
    out,
  )
  out[3] = nx
  out[4] = ny
  out[5] = nz
  return true
}

function closestPointTriangleRaw(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float32Array,
) {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const acx = cx - ax
  const acy = cy - ay
  const acz = cz - az
  const apx = px - ax
  const apy = py - ay
  const apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax
    out[1] = ay
    out[2] = az
    return
  }

  const bpx = px - bx
  const bpy = py - by
  const bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx
    out[1] = by
    out[2] = bz
    return
  }

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    out[0] = ax + abx * v
    out[1] = ay + aby * v
    out[2] = az + abz * v
    return
  }

  const cpx = px - cx
  const cpy = py - cy
  const cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx
    out[1] = cy
    out[2] = cz
    return
  }

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    out[0] = ax + acx * w
    out[1] = ay + acy * w
    out[2] = az + acz * w
    return
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    out[0] = bx + (cx - bx) * w
    out[1] = by + (cy - by) * w
    out[2] = bz + (cz - bz) * w
    return
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  out[0] = ax + abx * v + acx * w
  out[1] = ay + aby * v + acy * w
  out[2] = az + abz * v + acz * w
}

function pushOut(proxy: ColliderProxy, px: number, py: number, pz: number, out: Float32Array) {
  switch (proxy.kind) {
    case 'sphere':
      return pushOutOfSphere(proxy, px, py, pz, out)
    case 'capsule':
      return pushOutOfCapsule(proxy, px, py, pz, out)
    case 'ellipsoid':
      return pushOutOfEllipsoid(proxy, px, py, pz, out)
  }
}

function pushOutOfSphere(proxy: SphereProxy, px: number, py: number, pz: number, out: Float32Array) {
  const target = proxy.r + proxy.skin
  const dx = px - proxy.cx
  if (dx <= -target || dx >= target) return false
  const dy = py - proxy.cy
  if (dy <= -target || dy >= target) return false
  const dz = pz - proxy.cz
  if (dz <= -target || dz >= target) return false
  const distanceSq = dx * dx + dy * dy + dz * dz
  if (distanceSq >= target * target) return false
  const distance = Math.sqrt(distanceSq) || 1e-6
  const inv = 1 / distance
  out[0] = proxy.cx + dx * inv * target
  out[1] = proxy.cy + dy * inv * target
  out[2] = proxy.cz + dz * inv * target
  out[3] = dx * inv
  out[4] = dy * inv
  out[5] = dz * inv
  return true
}

function pushOutOfCapsule(proxy: CapsuleProxy, px: number, py: number, pz: number, out: Float32Array) {
  const abx = proxy.bx - proxy.ax
  const aby = proxy.by - proxy.ay
  const abz = proxy.bz - proxy.az
  const target = proxy.r + proxy.skin
  const minX = Math.min(proxy.ax, proxy.bx) - target
  const maxX = Math.max(proxy.ax, proxy.bx) + target
  const minY = Math.min(proxy.ay, proxy.by) - target
  const maxY = Math.max(proxy.ay, proxy.by) + target
  const minZ = Math.min(proxy.az, proxy.bz) - target
  const maxZ = Math.max(proxy.az, proxy.bz) + target
  if (px < minX || px > maxX || py < minY || py > maxY || pz < minZ || pz > maxZ) return false
  const apx = px - proxy.ax
  const apy = py - proxy.ay
  const apz = pz - proxy.az
  const segLenSq = abx * abx + aby * aby + abz * abz
  const t = segLenSq < 1e-9 ? 0 : clamp01((apx * abx + apy * aby + apz * abz) / segLenSq)
  const qx = proxy.ax + abx * t
  const qy = proxy.ay + aby * t
  const qz = proxy.az + abz * t
  const dx = px - qx
  const dy = py - qy
  const dz = pz - qz
  const distanceSq = dx * dx + dy * dy + dz * dz
  if (distanceSq >= target * target) return false
  const distance = Math.sqrt(distanceSq) || 1e-6
  const inv = 1 / distance
  out[0] = qx + dx * inv * target
  out[1] = qy + dy * inv * target
  out[2] = qz + dz * inv * target
  out[3] = dx * inv
  out[4] = dy * inv
  out[5] = dz * inv
  return true
}

function pushOutOfEllipsoid(proxy: EllipsoidProxy, px: number, py: number, pz: number, out: Float32Array) {
  const dx = px - proxy.cx
  const dy = py - proxy.cy
  const dz = pz - proxy.cz
  const outerRadius = Math.max(proxy.rx, proxy.ry, proxy.rz) + proxy.skin
  if (dx < -outerRadius || dx > outerRadius || dy < -outerRadius || dy > outerRadius || dz < -outerRadius || dz > outerRadius) return false
  rotateVecInto(dx, dy, dz, -proxy.qx, -proxy.qy, -proxy.qz, proxy.qw, ROTATED_LOCAL)
  const sx = ROTATED_LOCAL[0] / proxy.rx
  const sy = ROTATED_LOCAL[1] / proxy.ry
  const sz = ROTATED_LOCAL[2] / proxy.rz
  const scaledLength = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1e-6
  if (scaledLength >= 1 + proxy.skin / Math.min(proxy.rx, proxy.ry, proxy.rz)) return false

  const surfScale = 1 / scaledLength
  const surfaceLocalX = ROTATED_LOCAL[0] * surfScale
  const surfaceLocalY = ROTATED_LOCAL[1] * surfScale
  const surfaceLocalZ = ROTATED_LOCAL[2] * surfScale
  normalizeInto(
    surfaceLocalX / (proxy.rx * proxy.rx),
    surfaceLocalY / (proxy.ry * proxy.ry),
    surfaceLocalZ / (proxy.rz * proxy.rz),
    ROTATED_NORMAL,
  )
  rotateVecInto(surfaceLocalX, surfaceLocalY, surfaceLocalZ, proxy.qx, proxy.qy, proxy.qz, proxy.qw, ROTATED_SURFACE)
  rotateVecInto(ROTATED_NORMAL[0], ROTATED_NORMAL[1], ROTATED_NORMAL[2], proxy.qx, proxy.qy, proxy.qz, proxy.qw, ROTATED_NORMAL)
  normalizeInto(ROTATED_NORMAL[0], ROTATED_NORMAL[1], ROTATED_NORMAL[2], ROTATED_NORMAL)
  out[0] = proxy.cx + ROTATED_SURFACE[0] + ROTATED_NORMAL[0] * proxy.skin
  out[1] = proxy.cy + ROTATED_SURFACE[1] + ROTATED_NORMAL[1] * proxy.skin
  out[2] = proxy.cz + ROTATED_SURFACE[2] + ROTATED_NORMAL[2] * proxy.skin
  out[3] = ROTATED_NORMAL[0]
  out[4] = ROTATED_NORMAL[1]
  out[5] = ROTATED_NORMAL[2]
  return true
}

function rotateVecInto(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, out: Float32Array) {
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + (qy * tz - qz * ty)
  out[1] = y + qw * ty + (qz * tx - qx * tz)
  out[2] = z + qw * tz + (qx * ty - qy * tx)
}

function normalizeInto(x: number, y: number, z: number, out: Float32Array) {
  const length = Math.sqrt(x * x + y * y + z * z) || 1e-6
  out[0] = x / length
  out[1] = y / length
  out[2] = z / length
}

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export function colliderSearchRadius(target: number, cellSize: number) {
  // Triangles are hashed into every cell their AABB overlaps, so a particle only
  // needs to scan cells within ceil(target/cellSize) of its own cell to see any
  // triangle within `target`. The previous +1 pad doubled the scanned volume for
  // no coverage benefit.
  return Math.min(MAX_COLLIDER_SEARCH_RADIUS, Math.max(1, Math.ceil(target / cellSize)))
}

function nextVisitStamp(collider: TriangleColliderSurface) {
  let stamp = collider.triangleVisitStamp + 1
  if (stamp >= 0xffffffff) {
    collider.triangleVisitMarks.fill(0)
    stamp = 1
  }
  collider.triangleVisitStamp = stamp
  return stamp
}

function isOutsideBounds(bounds: CollisionBounds, margin: number, x: number, y: number, z: number) {
  return (
    x < bounds.minX - margin
    || x > bounds.maxX + margin
    || y < bounds.minY - margin
    || y > bounds.maxY + margin
    || z < bounds.minZ - margin
    || z > bounds.maxZ + margin
  )
}

function segmentOutsideBounds(
  bounds: CollisionBounds,
  margin: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
) {
  return (
    Math.max(startX, endX) < bounds.minX - margin
    || Math.min(startX, endX) > bounds.maxX + margin
    || Math.max(startY, endY) < bounds.minY - margin
    || Math.min(startY, endY) > bounds.maxY + margin
    || Math.max(startZ, endZ) < bounds.minZ - margin
    || Math.min(startZ, endZ) > bounds.maxZ + margin
  )
}

function hashCell(x: number, y: number, z: number) {
  return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0
}

function lookupOA(keys: Int32Array, values: Int32Array, mask: number, key: number) {
  let x = key | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  let slot = x & mask
  while (true) {
    const value = values[slot]
    if (value < 0) return -1
    if (keys[slot] === key) return value
    slot = (slot + 1) & mask
  }
}
