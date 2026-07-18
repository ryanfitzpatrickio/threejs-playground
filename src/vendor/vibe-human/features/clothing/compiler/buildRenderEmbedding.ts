import earcut from 'earcut'
import { sampleEdgeLoop, samplePatternOutline } from '../geometry/patternSampling'
import type { PatternDocument, PatternPanel } from '../document/types'
import type { RenderEmbedding, RenderPanelRuntime } from '../simulation/types'
import type { GarmentTopology } from './types'

const SUBDIVISIONS = 30

export function buildRenderEmbedding(
  document: PatternDocument,
  topology: GarmentTopology,
) {
  const renderPanels: RenderPanelRuntime[] = []

  for (const panel of Object.values(document.panels)) {
    const info = topology.panelInfo[panel.id]
    if (!info || info.triangleIndices.length === 0) continue
    const panelMesh = buildPanelVisualMesh(panel)
    const embedding = embedPanelVertices(panelMesh.panelUvs, info.triangleIndices, topology.simMesh.panelUvs)
    renderPanels.push({
      panelId: panel.id,
      indices: panelMesh.indices,
      panelUvs: panelMesh.panelUvs,
      embedding,
    })
  }

  return { renderPanels }
}

function buildPanelVisualMesh(panel: PatternPanel) {
  const outline = samplePatternOutline(panel, 12)
  const flat: number[] = []
  const vertices: Array<{ x: number; y: number }> = []
  const bounds = panelBounds(panel)
  for (const point of outline) {
    flat.push(point.x, point.y)
    vertices.push(point)
  }
  const holes: number[] = []
  for (const holeEdges of panel.holes ?? []) {
    const hole = sampleEdgeLoop(panel, holeEdges, 12)
    if (hole.length < 3) continue
    holes.push(vertices.length)
    for (const point of hole) {
      flat.push(point.x, point.y)
      vertices.push(point)
    }
  }

  const triIndices = earcut(flat, holes.length ? holes : undefined, 2)
  const uvBuf: number[] = []
  const indexBuf: number[] = []

  for (let triangle = 0; triangle < triIndices.length; triangle += 3) {
    const a = toUv(vertices[triIndices[triangle]], bounds)
    const b = toUv(vertices[triIndices[triangle + 1]], bounds)
    const c = toUv(vertices[triIndices[triangle + 2]], bounds)
    const grid: number[][] = []

    for (let i = 0; i <= SUBDIVISIONS; i += 1) {
      grid[i] = []
      for (let j = 0; j <= SUBDIVISIONS - i; j += 1) {
        const wa = 1 - (i + j) / SUBDIVISIONS
        const wb = i / SUBDIVISIONS
        const wc = j / SUBDIVISIONS
        const index = uvBuf.length / 2
        uvBuf.push(a.u * wa + b.u * wb + c.u * wc, a.v * wa + b.v * wb + c.v * wc)
        grid[i][j] = index
      }
    }

    for (let i = 0; i < SUBDIVISIONS; i += 1) {
      for (let j = 0; j < SUBDIVISIONS - i; j += 1) {
        const v0 = grid[i][j]
        const v1 = grid[i + 1][j]
        const v2 = grid[i][j + 1]
        indexBuf.push(v0, v1, v2)
        if (j < SUBDIVISIONS - i - 1) indexBuf.push(v1, grid[i + 1][j + 1], v2)
      }
    }
  }

  return weldUvVertices(new Float32Array(uvBuf), new Uint32Array(indexBuf))
}

type WeldBuffers = {
  panelUvs: Float32Array
  indices: Uint32Array
}

function weldUvVertices(panelUvs: Float32Array, indices: Uint32Array): WeldBuffers {
  const weldedUvs: number[] = []
  const weldedIndices = new Uint32Array(indices.length)
  const map = new Map<string, number>()
  const scale = 1e6

  for (let i = 0; i < indices.length; i += 1) {
    const src = indices[i]
    const u = panelUvs[src * 2]
    const v = panelUvs[src * 2 + 1]
    const key = `${Math.round(u * scale)}:${Math.round(v * scale)}`
    let dst = map.get(key)
    if (dst === undefined) {
      dst = weldedUvs.length / 2
      weldedUvs.push(u, v)
      map.set(key, dst)
    }
    weldedIndices[i] = dst
  }

  return {
    panelUvs: new Float32Array(weldedUvs),
    indices: weldedIndices,
  }
}

function embedPanelVertices(panelUvs: Float32Array, triangles: Uint32Array, simUvs: Float32Array): RenderEmbedding {
  const simTriangles = new Uint32Array((panelUvs.length / 2) * 3)
  const barycentrics = new Float32Array((panelUvs.length / 2) * 3)

  for (let vertex = 0; vertex < panelUvs.length / 2; vertex += 1) {
    const targetU = panelUvs[vertex * 2]
    const targetV = panelUvs[vertex * 2 + 1]
    let bestTri = 0
    let bestScore = Infinity
    let bestBary = [1, 0, 0]

    for (let offset = 0; offset < triangles.length; offset += 3) {
      const ia = triangles[offset]
      const ib = triangles[offset + 1]
      const ic = triangles[offset + 2]
      const bary = barycentric2d(
        targetU,
        targetV,
        simUvs[ia * 2], simUvs[ia * 2 + 1],
        simUvs[ib * 2], simUvs[ib * 2 + 1],
        simUvs[ic * 2], simUvs[ic * 2 + 1],
      )
      const inside = bary[0] >= -1e-4 && bary[1] >= -1e-4 && bary[2] >= -1e-4
      const centroidU = (simUvs[ia * 2] + simUvs[ib * 2] + simUvs[ic * 2]) / 3
      const centroidV = (simUvs[ia * 2 + 1] + simUvs[ib * 2 + 1] + simUvs[ic * 2 + 1]) / 3
      const score = inside ? 0 : (targetU - centroidU) ** 2 + (targetV - centroidV) ** 2
      if (score < bestScore) {
        bestScore = score
        bestTri = offset
        bestBary = bary
        if (inside) break
      }
    }

    simTriangles[vertex * 3] = triangles[bestTri]
    simTriangles[vertex * 3 + 1] = triangles[bestTri + 1]
    simTriangles[vertex * 3 + 2] = triangles[bestTri + 2]
    barycentrics[vertex * 3] = bestBary[0]
    barycentrics[vertex * 3 + 1] = bestBary[1]
    barycentrics[vertex * 3 + 2] = bestBary[2]
  }

  return { simTriangles, barycentrics }
}

function barycentric2d(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): [number, number, number] {
  const v0x = bx - ax
  const v0y = by - ay
  const v1x = cx - ax
  const v1y = cy - ay
  const v2x = px - ax
  const v2y = py - ay
  const denom = v0x * v1y - v1x * v0y
  if (Math.abs(denom) < 1e-9) return [1, 0, 0]
  const inv = 1 / denom
  const v = (v2x * v1y - v1x * v2y) * inv
  const w = (v0x * v2y - v2x * v0y) * inv
  const u = 1 - v - w
  return [u, v, w]
}

function panelBounds(panel: PatternPanel) {
  const points = Object.values(panel.points)
  if (!points.length) return { minX: -140, minY: -140, width: 280, height: 280 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return { minX, minY, width: maxX - minX || 1, height: maxY - minY || 1 }
}

function toUv(point: { x: number; y: number }, bounds: { minX: number; minY: number; width: number; height: number }) {
  return {
    u: (point.x - bounds.minX) / bounds.width,
    v: (point.y - bounds.minY) / bounds.height,
  }
}
