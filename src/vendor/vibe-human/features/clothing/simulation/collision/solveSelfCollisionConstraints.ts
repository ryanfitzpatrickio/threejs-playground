import type { ClothSimMesh, DistanceConstraint } from '../types'

type SelfCollisionOptions = {
  radius: number
  stiffness: number
  groundY?: number
  surfaceContacts?: boolean
}

const TRIANGLE_CONTACT = new Float32Array(6)

/**
 * Particle self-contact for cloth/cloth separation. The expensive topology and
 * storage are prepared once; each tick only refills typed arrays.
 */
export class ClothSelfCollisionSolver {
  private readonly bucketHeads: Int32Array
  private readonly bucketNext: Int32Array
  private readonly cellX: Int32Array
  private readonly cellY: Int32Array
  private readonly cellZ: Int32Array
  private readonly bucketMask: number
  private readonly triangleBucketHeads: Int32Array
  private readonly triangleRefNext: Int32Array
  private readonly triangleRefTriangle: Uint32Array
  private readonly triangleRefKey: Int32Array
  private readonly triangleBucketMask: number
  private readonly adjacencyOffsets: Uint32Array
  private readonly adjacency: Uint32Array
  private readonly topologyMarks: Uint32Array
  private readonly topologyQueue: Uint32Array
  private topologyStamp = 0

  constructor(mesh: ClothSimMesh) {
    const bucketCount = nextPowerOfTwo(Math.max(32, mesh.particleCount * 2))
    const triangleCount = mesh.triangles.length / 3
    const triangleBucketCount = nextPowerOfTwo(Math.max(32, triangleCount * 8))
    this.bucketHeads = new Int32Array(bucketCount)
    this.bucketNext = new Int32Array(mesh.particleCount)
    this.cellX = new Int32Array(mesh.particleCount)
    this.cellY = new Int32Array(mesh.particleCount)
    this.cellZ = new Int32Array(mesh.particleCount)
    this.bucketMask = bucketCount - 1
    this.triangleBucketHeads = new Int32Array(triangleBucketCount)
    this.triangleRefNext = new Int32Array(Math.max(1, triangleCount * 512))
    this.triangleRefTriangle = new Uint32Array(this.triangleRefNext.length)
    this.triangleRefKey = new Int32Array(this.triangleRefNext.length)
    this.triangleBucketMask = triangleBucketCount - 1
    const adjacency = buildAdjacency(mesh)
    this.adjacencyOffsets = adjacency.offsets
    this.adjacency = adjacency.neighbors
    this.topologyMarks = new Uint32Array(mesh.particleCount)
    this.topologyQueue = new Uint32Array(mesh.particleCount)
  }

  solve(mesh: ClothSimMesh, options: SelfCollisionOptions) {
    const radius = options.radius
    const stiffness = options.stiffness
    if (mesh.particleCount < 2 || radius <= 0 || stiffness <= 0) return

    const { positions, invMass, particleCount } = mesh
    const radiusSq = radius * radius
    const invCellSize = 1 / radius
    const heads = this.bucketHeads
    const next = this.bucketNext
    const cellX = this.cellX
    const cellY = this.cellY
    const cellZ = this.cellZ
    const mask = this.bucketMask

    heads.fill(-1)
    for (let particle = 0; particle < particleCount; particle += 1) {
      const offset = particle * 3
      const cx = Math.floor(positions[offset] * invCellSize)
      const cy = Math.floor(positions[offset + 1] * invCellSize)
      const cz = Math.floor(positions[offset + 2] * invCellSize)
      const bucket = hashCell(cx, cy, cz) & mask
      cellX[particle] = cx
      cellY[particle] = cy
      cellZ[particle] = cz
      next[particle] = heads[bucket]
      heads[bucket] = particle
    }

    for (let a = 0; a < particleCount; a += 1) {
      const wa = invMass[a]
      if (wa <= 0) continue
      const acx = cellX[a]
      const acy = cellY[a]
      const acz = cellZ[a]

      for (let dx = -1; dx <= 1; dx += 1) {
        const qx = acx + dx
        for (let dy = -1; dy <= 1; dy += 1) {
          const qy = acy + dy
          for (let dz = -1; dz <= 1; dz += 1) {
            const qz = acz + dz
            let b = heads[hashCell(qx, qy, qz) & mask]
            while (b >= 0) {
              const nextB = next[b]
              if (
                b > a
                && cellX[b] === qx
                && cellY[b] === qy
                && cellZ[b] === qz
                && !this.areTopologicallyLinked(a, b)
              ) {
                this.solvePair(mesh, a, b, wa, radius, radiusSq, stiffness, options.groundY)
              }
              b = nextB
            }
          }
        }
      }
    }

    if (options.surfaceContacts !== false) {
      this.solveParticleTriangleContacts(mesh, radius, radiusSq, stiffness, options.groundY)
    }
  }

  private solvePair(
    mesh: ClothSimMesh,
    a: number,
    b: number,
    wa: number,
    radius: number,
    radiusSq: number,
    stiffness: number,
    groundY: number | undefined,
  ) {
    const { positions, invMass } = mesh
    const wb = invMass[b]
    const wsum = wa + wb
    if (wsum <= 1e-9) return

    const ia = a * 3
    const ib = b * 3
    let nx = positions[ib] - positions[ia]
    let ny = positions[ib + 1] - positions[ia + 1]
    let nz = positions[ib + 2] - positions[ia + 2]
    const distSq = nx * nx + ny * ny + nz * nz
    if (distSq >= radiusSq) return

    const worldDist = Math.sqrt(distSq)
    const groundStack = groundY !== undefined
      && positions[ia + 1] - groundY < radius * 0.55
      && positions[ib + 1] - groundY < radius * 0.55
      && Math.abs(ny) < radius * 0.25
    if (groundStack) {
      nx = 0
      ny = 1
      nz = 0
    } else if (worldDist > 1e-7) {
      const invDist = 1 / worldDist
      nx *= invDist
      ny *= invDist
      nz *= invDist
    } else {
      const la = a * 2
      const lb = b * 2
      nx = mesh.panelLocalPositions[lb] - mesh.panelLocalPositions[la]
      ny = 0
      nz = mesh.panelLocalPositions[lb + 1] - mesh.panelLocalPositions[la + 1]
      const localDist = Math.hypot(nx, nz)
      if (localDist > 1e-7) {
        const invDist = 1 / localDist
        nx *= invDist
        nz *= invDist
      } else {
        nx = a & 1 ? 1 : -1
        nz = 0
      }
    }

    const correction = (radius - worldDist) * stiffness
    const scaleA = correction * (wa / wsum)
    const scaleB = correction * (wb / wsum)
    positions[ia] -= nx * scaleA
    positions[ia + 1] -= ny * scaleA
    positions[ia + 2] -= nz * scaleA
    positions[ib] += nx * scaleB
    positions[ib + 1] += ny * scaleB
    positions[ib + 2] += nz * scaleB
  }

  private areTopologicallyLinked(a: number, b: number) {
    const start = this.adjacencyOffsets[a]
    const end = this.adjacencyOffsets[a + 1]
    for (let i = start; i < end; i += 1) {
      if (this.adjacency[i] === b) return true
    }
    return false
  }

  private solveParticleTriangleContacts(
    mesh: ClothSimMesh,
    radius: number,
    radiusSq: number,
    stiffness: number,
    groundY: number | undefined,
  ) {
    const { positions, invMass, particleCount, triangles } = mesh
    const triangleCount = triangles.length / 3
    if (triangleCount === 0) return

    const invCellSize = 1 / (radius * 2)
    const heads = this.triangleBucketHeads
    const refNext = this.triangleRefNext
    const refTriangle = this.triangleRefTriangle
    const refKey = this.triangleRefKey
    const mask = this.triangleBucketMask
    heads.fill(-1)
    let refCount = 0

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const ia = triangles[triangle * 3] * 3
      const ib = triangles[triangle * 3 + 1] * 3
      const ic = triangles[triangle * 3 + 2] * 3
      const minX = Math.floor((Math.min(positions[ia], positions[ib], positions[ic]) - radius) * invCellSize)
      const minY = Math.floor((Math.min(positions[ia + 1], positions[ib + 1], positions[ic + 1]) - radius) * invCellSize)
      const minZ = Math.floor((Math.min(positions[ia + 2], positions[ib + 2], positions[ic + 2]) - radius) * invCellSize)
      const maxX = Math.floor((Math.max(positions[ia], positions[ib], positions[ic]) + radius) * invCellSize)
      const maxY = Math.floor((Math.max(positions[ia + 1], positions[ib + 1], positions[ic + 1]) + radius) * invCellSize)
      const maxZ = Math.floor((Math.max(positions[ia + 2], positions[ib + 2], positions[ic + 2]) + radius) * invCellSize)

      for (let cx = minX; cx <= maxX; cx += 1) {
        for (let cy = minY; cy <= maxY; cy += 1) {
          for (let cz = minZ; cz <= maxZ; cz += 1) {
            if (refCount >= refNext.length) return
            const key = hashCell(cx, cy, cz)
            const bucket = key & mask
            refTriangle[refCount] = triangle
            refKey[refCount] = key
            refNext[refCount] = heads[bucket]
            heads[bucket] = refCount
            refCount += 1
          }
        }
      }
    }

    for (let particle = 0; particle < particleCount; particle += 1) {
      if (invMass[particle] <= 0) continue
      this.markParticleTopologyNeighborhood(particle)
      const offset = particle * 3
      const key = hashCell(
        Math.floor(positions[offset] * invCellSize),
        Math.floor(positions[offset + 1] * invCellSize),
        Math.floor(positions[offset + 2] * invCellSize),
      )
      let ref = heads[key & mask]
      while (ref >= 0) {
        const nextRef = refNext[ref]
        if (refKey[ref] === key) {
          this.solveParticleTrianglePair(mesh, particle, refTriangle[ref], radius, radiusSq, stiffness, groundY)
        }
        ref = nextRef
      }
    }
  }

  private solveParticleTrianglePair(
    mesh: ClothSimMesh,
    particle: number,
    triangle: number,
    radius: number,
    radiusSq: number,
    stiffness: number,
    groundY: number | undefined,
  ) {
    const { positions, invMass, triangles } = mesh
    const a = triangles[triangle * 3]
    const b = triangles[triangle * 3 + 1]
    const c = triangles[triangle * 3 + 2]
    if (
      particle === a
      || particle === b
      || particle === c
      || this.topologyMarks[a] === this.topologyStamp
      || this.topologyMarks[b] === this.topologyStamp
      || this.topologyMarks[c] === this.topologyStamp
    ) return

    const wp = invMass[particle]
    const wa = invMass[a]
    const wb = invMass[b]
    const wc = invMass[c]
    if (wp + wa + wb + wc <= 1e-9) return

    const ip = particle * 3
    const ia = a * 3
    const ib = b * 3
    const ic = c * 3
    const px = positions[ip]
    const py = positions[ip + 1]
    const pz = positions[ip + 2]
    closestPointTriangleBary(
      px, py, pz,
      positions[ia], positions[ia + 1], positions[ia + 2],
      positions[ib], positions[ib + 1], positions[ib + 2],
      positions[ic], positions[ic + 1], positions[ic + 2],
      TRIANGLE_CONTACT,
    )
    let nx = px - TRIANGLE_CONTACT[0]
    let ny = py - TRIANGLE_CONTACT[1]
    let nz = pz - TRIANGLE_CONTACT[2]
    const distSq = nx * nx + ny * ny + nz * nz
    if (distSq >= radiusSq) return

    const dist = Math.sqrt(distSq)
    const nearGround = groundY !== undefined
      && py - groundY < radius * 0.55
      && TRIANGLE_CONTACT[1] - groundY < radius * 0.55
      && Math.abs(ny) < radius * 0.25
    if (nearGround) {
      nx = 0
      ny = 1
      nz = 0
    } else if (dist > 1e-7) {
      const invDist = 1 / dist
      nx *= invDist
      ny *= invDist
      nz *= invDist
    } else {
      const abx = positions[ib] - positions[ia]
      const aby = positions[ib + 1] - positions[ia + 1]
      const abz = positions[ib + 2] - positions[ia + 2]
      const acx = positions[ic] - positions[ia]
      const acy = positions[ic + 1] - positions[ia + 1]
      const acz = positions[ic + 2] - positions[ia + 2]
      nx = aby * acz - abz * acy
      ny = abz * acx - abx * acz
      nz = abx * acy - aby * acx
      const len = Math.hypot(nx, ny, nz) || 1
      nx /= len
      ny /= len
      nz /= len
    }

    const ba = TRIANGLE_CONTACT[3]
    const bb = TRIANGLE_CONTACT[4]
    const bc = TRIANGLE_CONTACT[5]
    const wsum = wp + wa * ba * ba + wb * bb * bb + wc * bc * bc
    if (wsum <= 1e-9) return
    const correction = (radius - dist) * stiffness
    const sp = correction * (wp / wsum)
    const sa = correction * (wa * ba / wsum)
    const sb = correction * (wb * bb / wsum)
    const sc = correction * (wc * bc / wsum)

    positions[ip] += nx * sp
    positions[ip + 1] += ny * sp
    positions[ip + 2] += nz * sp
    positions[ia] -= nx * sa
    positions[ia + 1] -= ny * sa
    positions[ia + 2] -= nz * sa
    positions[ib] -= nx * sb
    positions[ib + 1] -= ny * sb
    positions[ib + 2] -= nz * sb
    positions[ic] -= nx * sc
    positions[ic + 1] -= ny * sc
    positions[ic + 2] -= nz * sc
  }

  private markParticleTopologyNeighborhood(particle: number) {
    let stamp = this.topologyStamp + 1
    if (stamp >= 0xffffffff) {
      this.topologyMarks.fill(0)
      stamp = 1
    }
    this.topologyStamp = stamp
    const queue = this.topologyQueue
    let read = 0
    let write = 0
    this.topologyMarks[particle] = stamp
    queue[write] = particle
    write += 1

    for (let depth = 0; depth < 4 && read < write; depth += 1) {
      const levelEnd = write
      while (read < levelEnd) {
        const current = queue[read]
        read += 1
        const start = this.adjacencyOffsets[current]
        const end = this.adjacencyOffsets[current + 1]
        for (let i = start; i < end; i += 1) {
          const neighbor = this.adjacency[i]
          if (this.topologyMarks[neighbor] === stamp) continue
          this.topologyMarks[neighbor] = stamp
          if (write < queue.length) {
            queue[write] = neighbor
            write += 1
          }
        }
      }
    }
  }
}

function buildAdjacency(mesh: ClothSimMesh) {
  const particleCount = mesh.particleCount
  const pairs: number[] = []
  addDistancePairs(pairs, particleCount, mesh.stretchConstraints)
  addDistancePairs(pairs, particleCount, mesh.shearConstraints)
  addDistancePairs(pairs, particleCount, mesh.bendDistanceConstraints)
  addDistancePairs(pairs, particleCount, mesh.seamConstraints)

  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = mesh.triangles[i]
    const b = mesh.triangles[i + 1]
    const c = mesh.triangles[i + 2]
    addPair(pairs, particleCount, a, b)
    addPair(pairs, particleCount, b, c)
    addPair(pairs, particleCount, c, a)
  }

  pairs.sort((a, b) => a - b)
  let uniqueCount = 0
  let previous = -1
  for (let i = 0; i < pairs.length; i += 1) {
    const key = pairs[i]
    if (key === previous) continue
    pairs[uniqueCount] = key
    uniqueCount += 1
    previous = key
  }

  const offsets = new Uint32Array(particleCount + 1)
  for (let i = 0; i < uniqueCount; i += 1) {
    const key = pairs[i]
    const a = Math.floor(key / particleCount)
    const b = key - a * particleCount
    offsets[a + 1] += 1
    offsets[b + 1] += 1
  }
  for (let i = 1; i < offsets.length; i += 1) offsets[i] += offsets[i - 1]

  const cursor = new Uint32Array(offsets)
  const neighbors = new Uint32Array(offsets[particleCount])
  for (let i = 0; i < uniqueCount; i += 1) {
    const key = pairs[i]
    const a = Math.floor(key / particleCount)
    const b = key - a * particleCount
    neighbors[cursor[a]] = b
    cursor[a] += 1
    neighbors[cursor[b]] = a
    cursor[b] += 1
  }

  return { offsets, neighbors }
}

function addDistancePairs(pairs: number[], particleCount: number, constraints: DistanceConstraint[]) {
  for (let i = 0; i < constraints.length; i += 1) addPair(pairs, particleCount, constraints[i].a, constraints[i].b)
}

function addPair(pairs: number[], particleCount: number, a: number, b: number) {
  if (a === b || a < 0 || b < 0 || a >= particleCount || b >= particleCount) return
  pairs.push(a < b ? a * particleCount + b : b * particleCount + a)
}

function closestPointTriangleBary(
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
    out[0] = ax; out[1] = ay; out[2] = az
    out[3] = 1; out[4] = 0; out[5] = 0
    return
  }

  const bpx = px - bx
  const bpy = py - by
  const bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx; out[1] = by; out[2] = bz
    out[3] = 0; out[4] = 1; out[5] = 0
    return
  }

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    out[0] = ax + abx * v
    out[1] = ay + aby * v
    out[2] = az + abz * v
    out[3] = 1 - v; out[4] = v; out[5] = 0
    return
  }

  const cpx = px - cx
  const cpy = py - cy
  const cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx; out[1] = cy; out[2] = cz
    out[3] = 0; out[4] = 0; out[5] = 1
    return
  }

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    out[0] = ax + acx * w
    out[1] = ay + acy * w
    out[2] = az + acz * w
    out[3] = 1 - w; out[4] = 0; out[5] = w
    return
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    out[0] = bx + (cx - bx) * w
    out[1] = by + (cy - by) * w
    out[2] = bz + (cz - bz) * w
    out[3] = 0; out[4] = 1 - w; out[5] = w
    return
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  out[0] = ax + abx * v + acx * w
  out[1] = ay + aby * v + acy * w
  out[2] = az + abz * v + acz * w
  out[3] = 1 - v - w; out[4] = v; out[5] = w
}

function nextPowerOfTwo(value: number) {
  let power = 1
  while (power < value) power <<= 1
  return power
}

function hashCell(x: number, y: number, z: number) {
  return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0
}
