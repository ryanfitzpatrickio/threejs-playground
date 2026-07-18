import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { triangulatePanel, pointInPolygon } from './triangulate'
import type { Vec2 } from '../state/clothingTypes'

describe('triangulatePanel', () => {
  test('triangulates a square with no interior points', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]
    const mesh = triangulatePanel(square, [])
    assert.equal(mesh.triangles.length, 6) // 2 triangles
    assertConforms(mesh, square)
    assertAllCCW(mesh)
  })

  test('includes interior Steiner points as vertices', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ]
    const interior: Vec2[] = [{ x: 5, y: 5 }]
    const mesh = triangulatePanel(square, interior)
    // The center point must be referenced by at least one triangle.
    const centerIndex = mesh.points.findIndex((p) => p.x === 5 && p.y === 5)
    assert.equal(centerIndex >= 0, true)
    assert.equal(mesh.triangles.includes(centerIndex), true)
    assertConforms(mesh, square)
    assertAllCCW(mesh)
  })

  test('keeps every boundary vertex on the mesh (smooth edges)', () => {
    // A diagonal-edged triangle: every boundary sample must be a mesh vertex so
    // the edge is followed exactly, not staircased.
    const tri: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 7.5, y: 7.5 }, { x: 5, y: 5 }, { x: 2.5, y: 2.5 }, // samples along hypotenuse
    ]
    const mesh = triangulatePanel(tri, [])
    const used = new Set(mesh.triangles)
    for (let i = 0; i < tri.length; i += 1) {
      assert.equal(used.has(i), true, `boundary vertex ${i} unused`)
    }
  })

  test('discards triangles inside a hole', () => {
    const outer: Vec2[] = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
    ]
    const hole: Vec2[] = [
      { x: 8, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 12 }, { x: 8, y: 12 },
    ]
    const mesh = triangulatePanel(outer, [], [hole])
    // No triangle centroid may fall inside the hole.
    for (let i = 0; i < mesh.triangles.length; i += 3) {
      const a = mesh.points[mesh.triangles[i]]
      const b = mesh.points[mesh.triangles[i + 1]]
      const c = mesh.points[mesh.triangles[i + 2]]
      const cx = (a.x + b.x + c.x) / 3
      const cy = (a.y + b.y + c.y) / 3
      assert.equal(pointInPolygon(cx, cy, hole), false)
    }
    assertConforms(mesh, outer)
  })
})

function assertConforms(mesh: { points: Vec2[]; triangles: number[] }, outer: Vec2[]) {
  // Every emitted triangle's centroid must be inside the outer polygon.
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = mesh.points[mesh.triangles[i]]
    const b = mesh.points[mesh.triangles[i + 1]]
    const c = mesh.points[mesh.triangles[i + 2]]
    const cx = (a.x + b.x + c.x) / 3
    const cy = (a.y + b.y + c.y) / 3
    assert.equal(pointInPolygon(cx, cy, outer), true, `triangle ${i / 3} centroid outside polygon`)
  }
}

function assertAllCCW(mesh: { points: Vec2[]; triangles: number[] }) {
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = mesh.points[mesh.triangles[i]]
    const b = mesh.points[mesh.triangles[i + 1]]
    const c = mesh.points[mesh.triangles[i + 2]]
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
    assert.equal(area > 0, true, `triangle ${i / 3} not CCW`)
  }
}
