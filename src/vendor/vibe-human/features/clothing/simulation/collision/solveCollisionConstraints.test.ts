/// <reference types="node" />

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { solveCollisionConstraints } from './solveCollisionConstraints'
import type { ClothSimMesh, ColliderSnapshot } from '../types'

function hashCell(x: number, y: number, z: number) {
  return ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0
}

describe('solveCollisionConstraints', () => {
  test('pushes particles out of low-res mesh patches', () => {
    const mesh: ClothSimMesh = {
      particleCount: 1,
      positions: new Float32Array([0, 0.02, 0]),
      prevPositions: new Float32Array([0, 0.02, 0]),
      velocities: new Float32Array(3),
      invMass: new Float32Array([1]),
      panelIds: ['panel'],
      particleFrictions: new Float32Array([1]),
      panelUvs: new Float32Array([0, 0]),
      panelLocalPositions: new Float32Array([0, 0, 0]),
      triangles: new Uint32Array(),
      stretchConstraints: [],
      shearConstraints: [],
      bendDistanceConstraints: [],
      bendConstraints: [],
      seamConstraints: [],
      pinConstraints: [],
    }
    const snapshot: ColliderSnapshot = {
      version: 1,
      proxies: [],
      lowResMeshPatches: [
        {
          id: 'torso.lowRes',
          region: 'chest',
          vertices: new Float32Array([
            -1, 0, -1,
            1, 0, -1,
            0, 0, 1,
          ]),
          indices: new Uint32Array([0, 1, 2]),
          triangleNormals: new Float32Array([0, -1, 0]),
          cellSize: 4,
          cellKeys: new Int32Array([hashCell(0, 0, 0)]),
          cellStarts: new Uint32Array([0]),
          cellCounts: new Uint32Array([1]),
          cellTriangleIndices: new Uint32Array([0]),
          cellIndexLookup: new Map([[hashCell(0, 0, 0), 0]]),
          triangleVisitMarks: new Uint32Array([0]),
          triangleVisitStamp: 0,
          bounds: {
            minX: -1,
            minY: 0,
            minZ: -1,
            maxX: 1,
            maxY: 0,
            maxZ: 1,
          },
          skin: 0.04,
          thickness: 0.01,
          friction: 0.5,
        },
      ],
    }

    solveCollisionConstraints(mesh, snapshot)

    assert.equal(Math.abs(mesh.positions[1] - 0.05) < 1e-4, true)
  })

  test('prevents swept mesh-collider tunneling through small regions like the head', () => {
    const mesh: ClothSimMesh = {
      particleCount: 1,
      positions: new Float32Array([0, -0.08, 0]),
      prevPositions: new Float32Array([0, 0.08, 0]),
      velocities: new Float32Array(3),
      invMass: new Float32Array([1]),
      panelIds: ['panel'],
      particleFrictions: new Float32Array([1]),
      panelUvs: new Float32Array([0, 0]),
      panelLocalPositions: new Float32Array([0, 0, 0]),
      triangles: new Uint32Array(),
      stretchConstraints: [],
      shearConstraints: [],
      bendDistanceConstraints: [],
      bendConstraints: [],
      seamConstraints: [],
      pinConstraints: [],
    }
    const snapshot: ColliderSnapshot = {
      version: 1,
      proxies: [],
      meshColliders: [
        {
          kind: 'mesh',
          id: 'head.mesh',
          vertices: new Float32Array([
            -0.2, 0, -0.2,
            0.2, 0, -0.2,
            0, 0, 0.2,
          ]),
          indices: new Uint32Array([0, 1, 2]),
          triangleNormals: new Float32Array([0, 1, 0]),
          triangleCentroids: new Float32Array([0, 0, -0.06666667]),
          triangleRadii: new Float32Array([0.2981424]),
          cellSize: 1,
          cellKeys: new Int32Array([hashCell(0, 0, 0)]),
          cellStarts: new Uint32Array([0]),
          cellCounts: new Uint32Array([1]),
          cellTriangleIndices: new Uint32Array([0]),
          cellIndexLookup: new Map([[hashCell(0, 0, 0), 0]]),
          triangleVisitMarks: new Uint32Array([0]),
          triangleVisitStamp: 0,
          bounds: {
            minX: -0.2,
            minY: 0,
            minZ: -0.2,
            maxX: 0.2,
            maxY: 0,
            maxZ: 0.2,
          },
          skin: 0.02,
          thickness: 0.01,
          friction: 0.5,
        },
      ],
    }

    solveCollisionConstraints(mesh, snapshot)

    assert.equal(Math.abs(mesh.positions[1] - 0.03) < 1e-4, true)
  })

  test('uses triangle centroid contacts so coarse cloth faces do not pass through small colliders', () => {
    const mesh: ClothSimMesh = {
      particleCount: 3,
      positions: new Float32Array([
        -0.4, 0.02, -0.2,
        0.4, 0.02, -0.2,
        0, 0.02, 0.7,
      ]),
      prevPositions: new Float32Array([
        -0.4, 0.02, -0.2,
        0.4, 0.02, -0.2,
        0, 0.02, 0.7,
      ]),
      velocities: new Float32Array(9),
      invMass: new Float32Array([1, 1, 1]),
      panelIds: ['panel', 'panel', 'panel'],
      particleFrictions: new Float32Array([1, 1, 1]),
      panelUvs: new Float32Array(6),
      panelLocalPositions: new Float32Array(6),
      triangles: new Uint32Array([0, 1, 2]),
      stretchConstraints: [],
      shearConstraints: [],
      bendDistanceConstraints: [],
      bendConstraints: [],
      seamConstraints: [],
      pinConstraints: [],
    }
    const snapshot: ColliderSnapshot = {
      version: 1,
      proxies: [],
      meshColliders: [
        {
          kind: 'mesh',
          id: 'small-head-region.mesh',
          vertices: new Float32Array([
            -0.12, 0, -0.02,
            0.12, 0, -0.02,
            0, 0, 0.34,
          ]),
          indices: new Uint32Array([0, 1, 2]),
          triangleNormals: new Float32Array([0, 1, 0]),
          triangleCentroids: new Float32Array([0, 0, 0.1]),
          triangleRadii: new Float32Array([0.24]),
          cellSize: 1,
          cellKeys: new Int32Array([hashCell(0, 0, 0)]),
          cellStarts: new Uint32Array([0]),
          cellCounts: new Uint32Array([1]),
          cellTriangleIndices: new Uint32Array([0]),
          cellIndexLookup: new Map([[hashCell(0, 0, 0), 0]]),
          triangleVisitMarks: new Uint32Array([0]),
          triangleVisitStamp: 0,
          bounds: {
            minX: -0.12,
            minY: 0,
            minZ: -0.02,
            maxX: 0.12,
            maxY: 0,
            maxZ: 0.34,
          },
          skin: 0.04,
          thickness: 0.01,
          friction: 0.5,
        },
      ],
    }

    solveCollisionConstraints(mesh, snapshot)

    const centroidY = (mesh.positions[1] + mesh.positions[4] + mesh.positions[7]) / 3
    assert.equal(Math.abs(centroidY - 0.05) < 1e-4, true)
  })
})
