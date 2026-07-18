import { nanoid } from '../../../utils/nanoid'
import { clothingStore } from './clothingStore'
import { pushHistory } from './historyActions'
import { evaluateEdgeAt } from '../geometry/patternSampling'
import type { PatternEdge, PatternPoint, Vec2 } from './clothingTypes'

const uid = () => nanoid(8)

// ---------------------------------------------------------------------------
// Point mutation — these are called *during drag*, so do NOT push history on
// every frame; the caller should push BEFORE starting the drag.
// ---------------------------------------------------------------------------

export function movePointRaw(patternId: string, pointId: string, x: number, y: number) {
  const pattern = clothingStore.garment.patterns[patternId]
  const pt = pattern?.points[pointId]
  if (!pattern || !pt) return
  pt.x = x
  pt.y = y
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

/** Move handle. If the point is 'symmetric', mirror to the opposite handle. */
export function moveHandleRaw(
  patternId: string,
  pointId: string,
  handleKind: 'in' | 'out',
  x: number,
  y: number,
) {
  const pattern = clothingStore.garment.patterns[patternId]
  const pt = pattern?.points[pointId]
  if (!pattern || !pt) return

  const offset: Vec2 = { x: x - pt.x, y: y - pt.y }
  pt[handleKind] = offset

  if (pt.kind === 'symmetric') {
    const other = handleKind === 'in' ? 'out' : 'in'
    pt[other] = { x: -offset.x, y: -offset.y }
  } else if (pt.kind === 'smooth' && pt.in && pt.out) {
    // Smooth = colinear but lengths independent. Keep the OTHER handle's
    // length, just realign its direction to be opposite of the moved one.
    const other = handleKind === 'in' ? 'out' : 'in'
    const existing = pt[other]!
    const otherLen = Math.hypot(existing.x, existing.y)
    const moveLen = Math.hypot(offset.x, offset.y)
    if (moveLen > 1e-6) {
      pt[other] = { x: (-offset.x / moveLen) * otherLen, y: (-offset.y / moveLen) * otherLen }
    }
  } else {
    pt.kind = 'smooth'
  }

  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

export function setPointKind(patternId: string, pointId: string, kind: PatternPoint['kind']) {
  const pattern = clothingStore.garment.patterns[patternId]
  const pt = pattern?.points[pointId]
  if (!pattern || !pt) return
  pushHistory()
  pt.kind = kind
  if (kind === 'corner') {
    delete pt.in
    delete pt.out
  }
  clothingStore.dirty.previewDirty = true
}

export function deletePoint(patternId: string, pointId: string) {
  const pattern = clothingStore.garment.patterns[patternId]
  if (!pattern) return
  if (Object.keys(pattern.points).length <= 2) return
  pushHistory()

  // Stitch: find the incoming and outgoing edges and replace with one direct edge.
  const incoming = pattern.edges.find((e) => e.to === pointId)
  const outgoing = pattern.edges.find((e) => e.from === pointId)
  pattern.edges = pattern.edges.filter((e) => e.from !== pointId && e.to !== pointId)
  if (incoming && outgoing && incoming.from !== outgoing.to) {
    pattern.edges.push({ id: uid(), from: incoming.from, to: outgoing.to, curve: 'line' })
  }
  delete pattern.points[pointId]
  if (clothingStore.garment.selectedPointId === pointId) {
    clothingStore.garment.selectedPointId = undefined
  }
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

export function deleteEdge(patternId: string, edgeId: string) {
  const pattern = clothingStore.garment.patterns[patternId]
  if (!pattern) return
  pushHistory()
  pattern.edges = pattern.edges.filter((e) => e.id !== edgeId)
  pattern.closed = false
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

/** Insert a new point at the midpoint of an edge, splitting it in two. */
export function insertPointOnEdge(patternId: string, edgeId: string, t = 0.5) {
  const pattern = clothingStore.garment.patterns[patternId]
  if (!pattern) return null
  const edgeIdx = pattern.edges.findIndex((e) => e.id === edgeId)
  if (edgeIdx < 0) return null
  const edge = pattern.edges[edgeIdx]
  const pos = evaluateEdgeAt(pattern, edge, t)

  pushHistory()
  const newPt: PatternPoint = { id: uid(), x: pos.x, y: pos.y, kind: 'corner' }
  pattern.points[newPt.id] = newPt

  const a: PatternEdge = { id: uid(), from: edge.from, to: newPt.id, curve: 'line' }
  const b: PatternEdge = { id: uid(), from: newPt.id, to: edge.to, curve: 'line' }
  pattern.edges.splice(edgeIdx, 1, a, b)

  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
  return newPt.id
}

/** Toggle the curve type of an edge between 'line' and 'cubic'. */
export function toggleEdgeCurve(patternId: string, edgeId: string) {
  const pattern = clothingStore.garment.patterns[patternId]
  const edge = pattern?.edges.find((e) => e.id === edgeId)
  if (!pattern || !edge) return
  pushHistory()
  if (edge.curve === 'line') {
    const from = pattern.points[edge.from]
    const to = pattern.points[edge.to]
    if (!from || !to) return
    edge.curve = 'cubic'
    from.out = from.out ?? { x: (to.x - from.x) / 3, y: (to.y - from.y) / 3 }
    to.in = to.in ?? { x: (from.x - to.x) / 3, y: (from.y - to.y) / 3 }
    from.kind = from.kind === 'corner' ? 'smooth' : from.kind
    to.kind = to.kind === 'corner' ? 'smooth' : to.kind
  } else {
    edge.curve = 'line'
  }
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

export function convertEdgeToCurve(patternId: string, edgeId: string) {
  const pattern = clothingStore.garment.patterns[patternId]
  const edge = pattern?.edges.find((e) => e.id === edgeId)
  if (!pattern || !edge || edge.curve === 'cubic') return
  toggleEdgeCurve(patternId, edgeId)
}

/**
 * Convert a corner point to smooth by auto-computing handles from the tangents
 * of adjacent edges.  Double-clicking a corner point in edit-points mode calls
 * this.  If the point is already smooth/symmetric, convert it back to corner.
 */
/**
 * Make a point smooth and ensure adjacent edges are cubic, WITHOUT pushing
 * history.  Used by Ctrl+drag in the edit-points tool so the handle pull-out
 * and the conversion share a single undo step.
 * Safe to call on an already-smooth/symmetric point (no-op in that case).
 */
export function ensurePointSmoothForDrag(patternId: string, pointId: string) {
  const pattern = clothingStore.garment.patterns[patternId]
  const pt = pattern?.points[pointId]
  if (!pattern || !pt) return
  if (pt.kind !== 'corner') return // already has handles

  const incoming = pattern.edges.find((e) => e.to === pointId)
  const outgoing = pattern.edges.find((e) => e.from === pointId)
  const prev = incoming ? pattern.points[incoming.from] : null
  const next = outgoing ? pattern.points[outgoing.to] : null

  const len = (dx: number, dy: number) => Math.hypot(dx, dy)

  if (prev && next) {
    const tx = next.x - prev.x
    const ty = next.y - prev.y
    const tLen = len(tx, ty)
    if (tLen > 1e-6) {
      const outDist = len(next.x - pt.x, next.y - pt.y) / 3
      const inDist  = len(prev.x - pt.x, prev.y - pt.y) / 3
      const ux = tx / tLen
      const uy = ty / tLen
      pt.out = { x:  ux * outDist, y:  uy * outDist }
      pt.in  = { x: -ux * inDist,  y: -uy * inDist  }
    }
  } else if (next) {
    const outDist = len(next.x - pt.x, next.y - pt.y) / 3
    const tx = next.x - pt.x, ty = next.y - pt.y
    const tLen = len(tx, ty)
    if (tLen > 1e-6) pt.out = { x: tx / tLen * outDist, y: ty / tLen * outDist }
  } else if (prev) {
    const inDist = len(prev.x - pt.x, prev.y - pt.y) / 3
    const tx = pt.x - prev.x, ty = pt.y - prev.y
    const tLen = len(tx, ty)
    if (tLen > 1e-6) pt.in = { x: tx / tLen * inDist, y: ty / tLen * inDist }
  }

  // Fallback: zero handles so the drag creates them from scratch
  pt.out = pt.out ?? { x: 0, y: 0 }
  pt.in  = pt.in  ?? { x: 0, y: 0 }
  pt.kind = 'smooth'
  if (incoming) incoming.curve = 'cubic'
  if (outgoing) outgoing.curve = 'cubic'
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

export function togglePointSmooth(patternId: string, pointId: string) {
  const pattern = clothingStore.garment.patterns[patternId]
  const pt = pattern?.points[pointId]
  if (!pattern || !pt) return
  pushHistory()

  if (pt.kind !== 'corner') {
    // Cycle corner → smooth → symmetric → corner
    if (pt.kind === 'smooth') pt.kind = 'symmetric'
    else if (pt.kind === 'symmetric') {
      pt.kind = 'corner'
      delete pt.in
      delete pt.out
    }
    clothingStore.dirty.previewDirty = true
    return
  }

  // Corner → smooth: compute handles from adjacent edge midpoints
  const incoming = pattern.edges.find((e) => e.to === pointId)
  const outgoing = pattern.edges.find((e) => e.from === pointId)
  const prev = incoming ? pattern.points[incoming.from] : null
  const next = outgoing ? pattern.points[outgoing.to] : null

  const len = (dx: number, dy: number) => Math.hypot(dx, dy)

  if (prev && next) {
    // Catmull-Rom-style tangent: direction prev→next, scaled to 1/3 of edge lengths
    const tx = next.x - prev.x
    const ty = next.y - prev.y
    const tLen = len(tx, ty)
    if (tLen > 1e-6) {
      const outDist = len(next.x - pt.x, next.y - pt.y) / 3
      const inDist  = len(prev.x - pt.x, prev.y - pt.y) / 3
      const ux = tx / tLen
      const uy = ty / tLen
      pt.out = { x:  ux * outDist, y:  uy * outDist }
      pt.in  = { x: -ux * inDist,  y: -uy * inDist  }
    }
  } else if (next) {
    const outDist = len(next.x - pt.x, next.y - pt.y) / 3
    const tx = next.x - pt.x, ty = next.y - pt.y
    const tLen = len(tx, ty)
    if (tLen > 1e-6) pt.out = { x: tx / tLen * outDist, y: ty / tLen * outDist }
  } else if (prev) {
    const inDist = len(prev.x - pt.x, prev.y - pt.y) / 3
    const tx = pt.x - prev.x, ty = pt.y - prev.y
    const tLen = len(tx, ty)
    if (tLen > 1e-6) pt.in = { x: tx / tLen * inDist, y: ty / tLen * inDist }
  }

  pt.kind = 'smooth'
  // Make both adjacent edges cubic so the handles are visible
  if (incoming) incoming.curve = 'cubic'
  if (outgoing) outgoing.curve = 'cubic'
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}
