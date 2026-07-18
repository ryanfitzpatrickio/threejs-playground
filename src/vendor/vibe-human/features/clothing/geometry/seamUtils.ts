import type { PatternDocument, PatternPanel, PatternSeam } from '../document/types'
import type { GarmentDocument, PatternPiece, Seam, Vec2 } from '../state/clothingTypes'
import { evaluateEdgeAt } from './patternSampling'

// ---------------------------------------------------------------------------
// Sample both endpoints of a seam for visualisation
// ---------------------------------------------------------------------------

export type SeamSampleResult = {
  seam: Seam
  pointsA: Vec2[]
  pointsB: Vec2[]
}

export type ResolvedSeamSamples = {
  pointsA: Vec2[]
  pointsB: Vec2[]
  reversedB: boolean
  forwardCost: number
  reversedCost: number
}

export function sampleSeam(doc: GarmentDocument, seam: Seam, samples = 8): SeamSampleResult | null {
  const resolved = resolveSeamSamples(doc, seam, samples)
  if (!resolved) return null
  return { seam, pointsA: resolved.pointsA, pointsB: resolved.pointsB }
}

export function resolveSeamSamples(
  doc: GarmentDocument | PatternDocument,
  seam: Seam | PatternSeam,
  samples: number,
): ResolvedSeamSamples | null {
  const isGarment = 'patterns' in doc
  const aId = 'patternId' in seam.a ? seam.a.patternId : seam.a.panelId
  const bId = 'patternId' in seam.b ? seam.b.patternId : seam.b.panelId
  const pieceA = isGarment ? doc.patterns[aId] : doc.panels[aId]
  const pieceB = isGarment ? doc.patterns[bId] : doc.panels[bId]
  if (!pieceA || !pieceB) return null

  const pointsA = sampleEdgeById(pieceA, seam.a.edgeId, samples)
  const authoredB = sampleEdgeById(pieceB, seam.b.edgeId, samples)
  if (pointsA.length < 2 || authoredB.length < 2) {
    return { pointsA, pointsB: authoredB, reversedB: false, forwardCost: 0, reversedCost: 0 }
  }

  const explicitA = seam.a.reversed ? [...pointsA].reverse() : pointsA
  const explicitB = seam.b.reversed ? [...authoredB].reverse() : authoredB

  // Use 3D world-space endpoint cost when placement info is available.
  // 2D pattern-space cost fails when panels share identical coordinates
  // but differ in 3D orientation (e.g. T-shirt front/back).
  const hasPlacement = !isGarment && 'placement' in pieceA && 'placement' in pieceB
  let forwardCost: number
  let reversedCost: number
  if (hasPlacement) {
    const panelA = pieceA as PatternPanel
    const panelB = pieceB as PatternPanel
    forwardCost = endpointCost3D(explicitA, explicitB, panelA, panelB, false)
    reversedCost = endpointCost3D(explicitA, explicitB, panelA, panelB, true)
  } else {
    forwardCost = endpointCost(explicitA, explicitB, false)
    reversedCost = endpointCost(explicitA, explicitB, true)
  }
  const reverseByCost = reversedCost + 1e-8 < forwardCost
  return {
    pointsA: explicitA,
    pointsB: reverseByCost ? [...explicitB].reverse() : explicitB,
    reversedB: reverseByCost,
    forwardCost,
    reversedCost,
  }
}

function sampleEdgeById(piece: PatternPiece | PatternPanel, edgeId: string, samples: number): Vec2[] {
  const edge = piece.edges.find((e) => e.id === edgeId)
  if (!edge) return []

  const pts: Vec2[] = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    pts.push(evaluateEdgeAt(piece, edge, t))
  }

  return pts
}

function endpointCost(pointsA: Vec2[], pointsB: Vec2[], reverseB: boolean) {
  const bStart = reverseB ? pointsB[pointsB.length - 1] : pointsB[0]
  const bEnd = reverseB ? pointsB[0] : pointsB[pointsB.length - 1]
  const aStart = pointsA[0]
  const aEnd = pointsA[pointsA.length - 1]
  return Math.hypot(aStart.x - bStart.x, aStart.y - bStart.y)
    + Math.hypot(aEnd.x - bEnd.x, aEnd.y - bEnd.y)
}

/** Pattern units → meters conversion factor (1 pattern unit = 4mm) */
export const PATTERN_UNIT_SCALE = 0.004

function endpointCost3D(pointsA: Vec2[], pointsB: Vec2[], panelA: PatternPanel, panelB: PatternPanel, reverseB: boolean) {
  // Use sum of all corresponding pair distances in 3D for robust orientation
  // detection. Endpoint-only cost fails when edges are at an angle to the
  // rotation axis (e.g., sleeve-top edges that span a wide X range).
  const n = Math.min(pointsA.length, pointsB.length)
  if (n < 2) return 0
  let sum = 0
  for (let i = 0; i < n; i += 1) {
    const bi = reverseB ? n - 1 - i : i
    const a3 = placePt(panelA, pointsA[i])
    const b3 = placePt(panelB, pointsB[bi])
    sum += (a3.x - b3.x) ** 2 + (a3.y - b3.y) ** 2 + (a3.z - b3.z) ** 2
  }
  return sum
}

/** Transform a 2D pattern point into 3D world space using panel placement. */
export function placePt(panel: PatternPanel, point: Vec2) {
  const yaw = panel.placement.rotation.y
  const px = point.x * PATTERN_UNIT_SCALE
  const py = -point.y * PATTERN_UNIT_SCALE
  return {
    x: panel.placement.position.x + px * Math.cos(yaw),
    y: panel.placement.position.y + py,
    z: panel.placement.position.z - px * Math.sin(yaw),
  }
}

// ---------------------------------------------------------------------------
// Get the midpoint of a seam edge (useful for label placement)
// ---------------------------------------------------------------------------

export function seamEdgeMidpoint(piece: PatternPiece, edgeId: string): Vec2 | null {
  const edge = piece.edges.find((e) => e.id === edgeId)
  if (!edge) return null
  return evaluateEdgeAt(piece, edge, 0.5)
}
