/// <reference types="node" />

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ClothSelfCollisionSolver } from './solveSelfCollisionConstraints'
import type { ClothSimMesh } from '../types'

describe('ClothSelfCollisionSolver', () => {
  test('separates non-adjacent cloth particles without allocating per contact', () => {
    const mesh = makeMesh({
      positions: [
        0, 0, 0,
        0.006, 0, 0,
      ],
      local: [
        0, 0,
        10, 0,
      ],
    })
    const solver = new ClothSelfCollisionSolver(mesh)

    solver.solve(mesh, { radius: 0.02, stiffness: 1 })

    const distance = Math.hypot(
      mesh.positions[3] - mesh.positions[0],
      mesh.positions[4] - mesh.positions[1],
      mesh.positions[5] - mesh.positions[2],
    )
    assert.equal(Math.abs(distance - 0.02) < 1e-5, true)
    assert.equal(Math.abs(mesh.positions[0] + 0.007) < 1e-5, true)
    assert.equal(Math.abs(mesh.positions[3] - 0.013) < 1e-5, true)
  })

  test('does not repel directly connected fabric edges', () => {
    const mesh = makeMesh({
      positions: [
        0, 0, 0,
        0.006, 0, 0,
      ],
      local: [
        0, 0,
        10, 0,
      ],
      triangles: [0, 1, 1],
    })
    const solver = new ClothSelfCollisionSolver(mesh)

    solver.solve(mesh, { radius: 0.02, stiffness: 1 })

    assert.equal(Math.abs(mesh.positions[0]) < 1e-8, true)
    assert.equal(Math.abs(mesh.positions[3] - 0.006) < 1e-8, true)
  })

  test('repels particles from non-adjacent cloth triangle faces', () => {
    const mesh = makeMesh({
      positions: [
        -0.1, 0, -0.1,
        0.1, 0, -0.1,
        0, 0, 0.18,
        0, 0.005, 0,
      ],
      local: [
        -10, -10,
        10, -10,
        0, 18,
        0, 0,
      ],
      triangles: [0, 1, 2],
    })
    const solver = new ClothSelfCollisionSolver(mesh)

    solver.solve(mesh, { radius: 0.02, stiffness: 1 })

    assert.equal(mesh.positions[10] > 0.01, true)
    assert.equal(mesh.positions[1] < 0, true)
    assert.equal(mesh.positions[4] < 0, true)
    assert.equal(mesh.positions[7] < 0, true)
  })
})

function makeMesh(input: { positions: number[]; local: number[]; triangles?: number[] }): ClothSimMesh {
  const positions = new Float32Array(input.positions)
  return {
    particleCount: positions.length / 3,
    positions,
    prevPositions: new Float32Array(positions),
    velocities: new Float32Array(positions.length),
    invMass: new Float32Array(positions.length / 3).fill(1),
    panelIds: new Array<string>(positions.length / 3).fill('panel'),
    particleFrictions: new Float32Array(positions.length / 3).fill(1),
    panelUvs: new Float32Array((positions.length / 3) * 2),
    panelLocalPositions: new Float32Array(input.local),
    triangles: new Uint32Array(input.triangles ?? []),
    stretchConstraints: [],
    shearConstraints: [],
    bendDistanceConstraints: [],
    bendConstraints: [],
    seamConstraints: [],
    pinConstraints: [],
  }
}
