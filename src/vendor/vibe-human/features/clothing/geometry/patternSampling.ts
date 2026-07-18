import type { PatternPiece, PatternEdge, Vec2 } from '../state/clothingTypes'
import { cubicBezierPoint, sampleCubicBezier } from './bezier'

// Default samples per edge for outline sampling
const SAMPLES_PER_EDGE = 16

// ---------------------------------------------------------------------------
// Resolve the control points for an edge from a PatternPiece
// ---------------------------------------------------------------------------

function edgeControlPoints(
  piece: PatternPiece,
  edge: PatternEdge,
): { p0: Vec2; p1: Vec2; p2: Vec2; p3: Vec2 } | null {
  const from = piece.points[edge.from]
  const to   = piece.points[edge.to]
  if (!from || !to) return null

  const p0: Vec2 = { x: from.x, y: from.y }
  const p3: Vec2 = { x: to.x,   y: to.y   }

  // Control handles: if the point has an `out` handle it's relative to the point
  const p1: Vec2 = from.out
    ? { x: from.x + from.out.x, y: from.y + from.out.y }
    : { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 }

  const p2: Vec2 = to.in
    ? { x: to.x + to.in.x, y: to.y + to.in.y }
    : { x: to.x - (to.x - from.x) / 3, y: to.y - (to.y - from.y) / 3 }

  return { p0, p1, p2, p3 }
}

// ---------------------------------------------------------------------------
// Sample a single edge into Vec2[] points (not including the final endpoint,
// so consecutive edges can be concatenated without duplicate vertices).
// ---------------------------------------------------------------------------

export function sampleEdge(piece: PatternPiece, edge: PatternEdge, samples = SAMPLES_PER_EDGE): Vec2[] {
  const from = piece.points[edge.from]
  const to   = piece.points[edge.to]
  if (!from || !to) return []

  if (edge.curve === 'line') {
    return [{ x: from.x, y: from.y }]
  }

  const cp = edgeControlPoints(piece, edge)
  if (!cp) return [{ x: from.x, y: from.y }]

  // sampleCubicBezier returns count+1 points; drop the last one to avoid
  // duplicate with the start of the next edge.
  const pts = sampleCubicBezier(cp.p0, cp.p1, cp.p2, cp.p3, samples)
  pts.pop()
  return pts
}

// ---------------------------------------------------------------------------
// Sample the full closed outline of a PatternPiece into a flat Vec2 array
// ---------------------------------------------------------------------------

export function samplePatternOutline(piece: PatternPiece, samplesPerEdge = SAMPLES_PER_EDGE): Vec2[] {
  const result: Vec2[] = []
  for (const edge of piece.edges) {
    result.push(...sampleEdge(piece, edge, samplesPerEdge))
  }
  return result
}

export function sampleEdgeLoop(piece: PatternPiece, edges: PatternEdge[], samplesPerEdge = SAMPLES_PER_EDGE): Vec2[] {
  const result: Vec2[] = []
  for (const edge of edges) {
    result.push(...sampleEdge(piece, edge, samplesPerEdge))
  }
  return result
}

// ---------------------------------------------------------------------------
// Evaluate a single point on an edge at t ∈ [0,1]
// ---------------------------------------------------------------------------

export function evaluateEdgeAt(piece: PatternPiece, edge: PatternEdge, t: number): Vec2 {
  const from = piece.points[edge.from]
  const to   = piece.points[edge.to]
  if (!from || !to) return { x: 0, y: 0 }

  if (edge.curve === 'line') {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  }

  const cp = edgeControlPoints(piece, edge)
  if (!cp) return { x: from.x, y: from.y }
  return cubicBezierPoint(cp.p0, cp.p1, cp.p2, cp.p3, t)
}
