import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { colliderSearchRadius, solveCollisionConstraints } from './solveCollisionConstraints'
import type { ClothSimMesh, ColliderSnapshot, MeshSurfaceColliderSnapshot } from '../types'

// The collision broad-phase scans a cube of grid cells around each particle.
// We tightened the scan radius from ceil(target/cell)+1 to ceil(target/cell).
//
// Why this is lossless: each triangle is hashed into EVERY cell its AABB
// overlaps. If a triangle's closest point to a particle P is within `target`,
// that point lies within `target` of P and therefore in a cell at most
// ceil(target/cell) cells away from P's own cell — and the triangle's AABB
// covers that point, so the triangle is registered there. Scanning
// ceil(target/cell) cells in each direction is thus guaranteed to find every
// triangle within `target`; the old +1 only widened the scan, it never changed
// which contacts were found.

function hashCell(x: number, y: number, z: number) {
  return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0
}

describe('colliderSearchRadius', () => {
  test('covers the contact band exactly (no redundant +1 pad)', () => {
    // target smaller than a cell: only the particle's own cell ring is needed.
    assert.equal(colliderSearchRadius(0.03, 0.09), 1)
    // target equal to a cell.
    assert.equal(colliderSearchRadius(0.09, 0.09), 1)
    // target just over one cell -> need the next ring.
    assert.equal(colliderSearchRadius(0.10, 0.09), 2)
    // target two cells wide.
    assert.equal(colliderSearchRadius(0.18, 0.09), 2)
  })

  test('never returns below 1 even for a zero/tiny target', () => {
    assert.equal(colliderSearchRadius(0, 0.09), 1)
    assert.equal(colliderSearchRadius(1e-9, 0.09), 1)
  })

  test('clamps to the safety cap for pathological cell sizes', () => {
    // ceil(1 / 0.04) = 25, clamped to 4.
    assert.equal(colliderSearchRadius(1, 0.04), 4)
  })

  test('the scanned half-width always reaches at least `target`', () => {
    // The physical reach of the scan is searchRadius * cellSize. For the change
    // to be lossless this must be >= target for every reasonable input.
    for (const cell of [0.04, 0.06, 0.09, 0.12, 0.2]) {
      for (const target of [0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.15]) {
        const r = colliderSearchRadius(target, cell)
        // capped cases can't reach, but those are pathological (target >> cell);
        // for the realistic regime target <= 4*cell the reach must cover target.
        if (target <= 4 * cell) {
          assert.ok(r * cell >= target - 1e-9, `reach ${r * cell} < target ${target} (cell ${cell})`)
        }
      }
    }
  })
})

// Behavioral regression: the solver still fully resolves a penetration with the
// tightened radius (a particle inside the skin band gets pushed to the surface).
describe('solveCollisionConstraints still resolves penetrations after radius tighten', () => {
  test('pushes a penetrating particle out to the skin+thickness offset', () => {
    const vertices = new Float32Array([
      -1, 0, -1,
      1, 0, -1,
      0, 0, 1,
    ])
    const indices = new Uint32Array([0, 1, 2])
    const skin = 0.022
    const thickness = 0.008
    const cellSize = 0.09
    const target = skin + thickness

    // particle slightly above the triangle plane (y=0), within the target band.
    const py = 0.01
    const cx = Math.floor(0 / cellSize)
    const cy = Math.floor(py / cellSize)
    const cz = Math.floor(0 / cellSize)
    // register the triangle into the cells around the particle so the (now
    // tighter) scan can still find it.
    const cellMap = new Map<number, number>()
    const cellKeysArr: number[] = []
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const key = hashCell(cx + dx, cy + dy, cz + dz)
      if (!cellMap.has(key)) { cellMap.set(key, cellKeysArr.length); cellKeysArr.push(key) }
    }

    const collider: MeshSurfaceColliderSnapshot = {
      kind: 'mesh',
      id: 'plane.mesh',
      vertices,
      indices,
      triangleNormals: new Float32Array([0, 1, 0]),
      triangleCentroids: new Float32Array([0, 0, -1 / 3]),
      triangleRadii: new Float32Array([1.2]),
      cellSize,
      cellKeys: new Int32Array(cellKeysArr),
      cellStarts: new Uint32Array(cellKeysArr.map(() => 0)),
      cellCounts: new Uint32Array(cellKeysArr.map(() => 1)),
      cellTriangleIndices: new Uint32Array(cellKeysArr.map(() => 0)),
      cellIndexLookup: cellMap,
      triangleVisitMarks: new Uint32Array(1),
      triangleVisitStamp: 0,
      bounds: { minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 0, maxZ: 1 },
      skin,
      thickness,
      friction: 0.5,
    } as MeshSurfaceColliderSnapshot

    const mesh: ClothSimMesh = {
      particleCount: 1,
      positions: new Float32Array([0, py, 0]),
      prevPositions: new Float32Array([0, py, 0]),
      velocities: new Float32Array(3),
      invMass: new Float32Array([1]),
      panelIds: ['p'],
      panelUvs: new Float32Array([0, 0]),
      panelLocalPositions: new Float32Array([0, 0, 0]),
      triangles: new Uint32Array(),
      stretchConstraints: [],
      shearConstraints: [],
      bendDistanceConstraints: [],
      bendConstraints: [],
      seamConstraints: [],
      pinConstraints: [],
    } as unknown as ClothSimMesh

    const snapshot: ColliderSnapshot = { version: 1, proxies: [], meshColliders: [collider] }
    solveCollisionConstraints(mesh, snapshot)

    // particle should be pushed up to y = target (skin + thickness above plane).
    assert.ok(Math.abs(mesh.positions[1] - target) < 1e-4, `expected y≈${target}, got ${mesh.positions[1]}`)
  })
})
