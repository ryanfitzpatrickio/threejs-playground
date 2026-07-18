import type { GarmentDocument, PatternPiece, Vec2 } from '../state/clothingTypes'
import { dist2, pointToSegmentDist2 } from '../geometry/bezier'
import { sampleEdge } from '../geometry/patternSampling'

// Tolerance in screen pixels (will be converted to world units)
const POINT_TOLERANCE_PX  = 10
const HANDLE_TOLERANCE_PX = 8
const EDGE_TOLERANCE_PX   = 8

// ---------------------------------------------------------------------------
// Picking result
// ---------------------------------------------------------------------------

export type PickResult =
  | { type: 'point';   patternId: string; pointId: string }
  | { type: 'handle';  patternId: string; pointId: string; handleKind: 'in' | 'out' }
  | { type: 'edge';    patternId: string; edgeId: string }
  | { type: 'pattern'; patternId: string }
  | null

// ---------------------------------------------------------------------------
// PatternPicker — stateless pick function
// ---------------------------------------------------------------------------

/**
 * Pick at a world-space coordinate.
 * Priority: points > handles > edges > fill.
 * @param worldPt  click position in world (pattern) space
 * @param zoom     current canvas zoom (screen px / world unit)
 */
export function pickAt(doc: GarmentDocument, worldPt: Vec2, zoom: number): PickResult {
  const pointTolSq  = (POINT_TOLERANCE_PX  / zoom) ** 2
  const handleTolSq = (HANDLE_TOLERANCE_PX / zoom) ** 2
  const edgeTolSq   = (EDGE_TOLERANCE_PX   / zoom) ** 2

  // Iterate in REVERSE insertion order so the topmost (most recently created)
  // piece wins when shapes overlap. Without this, dropping a circle inside a
  // rectangle would make the rectangle steal the hit and the circle becomes
  // unselectable.
  const orderedPieces = Object.values(doc.patterns).slice().reverse()

  // -------------------------------------------------------------------------
  // 1. Points
  // -------------------------------------------------------------------------
  for (const piece of orderedPieces) {
    for (const pt of Object.values(piece.points)) {
      if (dist2(worldPt, pt) <= pointTolSq) {
        return { type: 'point', patternId: piece.id, pointId: pt.id }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Bezier handles
  // -------------------------------------------------------------------------
  for (const piece of orderedPieces) {
    for (const pt of Object.values(piece.points)) {
      if (pt.in) {
        const hPos: Vec2 = { x: pt.x + pt.in.x, y: pt.y + pt.in.y }
        if (dist2(worldPt, hPos) <= handleTolSq) {
          return { type: 'handle', patternId: piece.id, pointId: pt.id, handleKind: 'in' }
        }
      }
      if (pt.out) {
        const hPos: Vec2 = { x: pt.x + pt.out.x, y: pt.y + pt.out.y }
        if (dist2(worldPt, hPos) <= handleTolSq) {
          return { type: 'handle', patternId: piece.id, pointId: pt.id, handleKind: 'out' }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Edges (sampled polyline hit-test)
  // -------------------------------------------------------------------------
  for (const piece of orderedPieces) {
    for (const edge of piece.edges) {
      const pts = sampleEdge(piece, edge, 12)
      const toPt = piece.points[edge.to]
      if (toPt) pts.push({ x: toPt.x, y: toPt.y })

      for (let i = 0; i < pts.length - 1; i++) {
        if (pointToSegmentDist2(worldPt, pts[i], pts[i + 1]) <= edgeTolSq) {
          return { type: 'edge', patternId: piece.id, edgeId: edge.id }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Pattern fill (point-in-polygon)
  // -------------------------------------------------------------------------
  for (const piece of orderedPieces) {
    if (!piece.closed) continue
    if (pointInPattern(worldPt, piece)) {
      return { type: 'pattern', patternId: piece.id }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Simple ray-casting point-in-polygon
// ---------------------------------------------------------------------------

function pointInPattern(pt: Vec2, piece: PatternPiece): boolean {
  // Build a flat vertex list from the first point of each edge
  const verts: Vec2[] = []
  for (const edge of piece.edges) {
    const from = piece.points[edge.from]
    if (from) verts.push({ x: from.x, y: from.y })
  }
  if (verts.length < 3) return false

  let inside = pointInVerts(pt, verts)
  if (!inside) return false

  for (const holeEdges of piece.holes ?? []) {
    const holeVerts: Vec2[] = []
    for (const edge of holeEdges) {
      const from = piece.points[edge.from]
      if (from) holeVerts.push({ x: from.x, y: from.y })
    }
    if (holeVerts.length >= 3 && pointInVerts(pt, holeVerts)) {
      inside = false
      break
    }
  }

  return inside
}

function pointInVerts(pt: Vec2, verts: Vec2[]) {
  let inside = false
  const n = verts.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = verts[i].x, yi = verts[i].y
    const xj = verts[j].x, yj = verts[j].y
    const intersect = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// ---------------------------------------------------------------------------
// pickAllPatterns — returns all pattern ids whose fill contains worldPt,
// in reverse insertion order (topmost first).  Used for selection cycling.
// ---------------------------------------------------------------------------

export function pickAllPatterns(doc: GarmentDocument, worldPt: Vec2): string[] {
  const orderedPieces = Object.values(doc.patterns).slice().reverse()
  const hits: string[] = []
  for (const piece of orderedPieces) {
    if (!piece.closed) continue
    if (pointInPattern(worldPt, piece)) hits.push(piece.id)
  }
  return hits
}
