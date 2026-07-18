import { nanoid } from '../../../utils/nanoid'
import { clothingStore } from './clothingStore'
import { pushHistory } from './historyActions'
import type { PatternEdge, PatternPiece, PatternPoint, Vec2 } from './clothingTypes'

const uid = () => nanoid(8)

function makePoint(x: number, y: number): PatternPoint {
  return { id: uid(), x, y, kind: 'corner' }
}

function makeEdge(from: string, to: string, curve: 'line' | 'cubic' = 'line'): PatternEdge {
  return { id: uid(), from, to, curve }
}

function nextPatternName(): string {
  return `Pattern ${Object.keys(clothingStore.garment.patterns).length + 1}`
}

function commit(piece: PatternPiece) {
  clothingStore.garment.patterns[piece.id] = piece
  clothingStore.garment.selectedPatternId = piece.id
  clothingStore.garment.selectedPointId = undefined
  clothingStore.garment.selectedEdgeId = undefined
  clothingStore.selectedPatternIds = [piece.id]
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Rectangle
// ---------------------------------------------------------------------------

export function createRectangleFromBounds(a: Vec2, b: Vec2): string | null {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  if (maxX - minX < 4 || maxY - minY < 4) return null

  pushHistory()
  const tl = makePoint(minX, minY)
  const tr = makePoint(maxX, minY)
  const br = makePoint(maxX, maxY)
  const bl = makePoint(minX, maxY)
  const piece: PatternPiece = {
    id: uid(),
    name: nextPatternName(),
    points: { [tl.id]: tl, [tr.id]: tr, [br.id]: br, [bl.id]: bl },
    edges: [makeEdge(tl.id, tr.id), makeEdge(tr.id, br.id), makeEdge(br.id, bl.id), makeEdge(bl.id, tl.id)],
    closed: true,
    particleDistance: 22,
  }
  commit(piece)
  return piece.id
}

// Convenience used by demos.
export function createRectanglePattern(center: Vec2, width = 180, height = 140): string | null {
  return createRectangleFromBounds(
    { x: center.x - width / 2, y: center.y - height / 2 },
    { x: center.x + width / 2, y: center.y + height / 2 },
  )
}

// ---------------------------------------------------------------------------
// Ellipse — 4 cubic-bezier segments approximate a circle (kappa ≈ 0.5522847).
// ---------------------------------------------------------------------------

const KAPPA = 0.5522847498307936

export function createEllipseFromBounds(a: Vec2, b: Vec2): string | null {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  const w = maxX - minX
  const h = maxY - minY
  if (w < 4 || h < 4) return null

  pushHistory()
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const rx = w / 2
  const ry = h / 2

  // 4 cardinal anchor points
  const right  = makePoint(cx + rx, cy)
  const bottom = makePoint(cx, cy + ry)
  const left   = makePoint(cx - rx, cy)
  const top    = makePoint(cx, cy - ry)

  // Symmetric handles tangent to the ellipse
  right.in  = { x: 0, y: -ry * KAPPA }
  right.out = { x: 0, y:  ry * KAPPA }
  bottom.in  = { x:  rx * KAPPA, y: 0 }
  bottom.out = { x: -rx * KAPPA, y: 0 }
  left.in  = { x: 0, y:  ry * KAPPA }
  left.out = { x: 0, y: -ry * KAPPA }
  top.in  = { x: -rx * KAPPA, y: 0 }
  top.out = { x:  rx * KAPPA, y: 0 }

  right.kind = bottom.kind = left.kind = top.kind = 'symmetric'

  const piece: PatternPiece = {
    id: uid(),
    name: nextPatternName(),
    points: { [right.id]: right, [bottom.id]: bottom, [left.id]: left, [top.id]: top },
    edges: [
      makeEdge(right.id, bottom.id, 'cubic'),
      makeEdge(bottom.id, left.id, 'cubic'),
      makeEdge(left.id, top.id, 'cubic'),
      makeEdge(top.id, right.id, 'cubic'),
    ],
    closed: true,
    particleDistance: 22,
  }
  commit(piece)
  return piece.id
}

// ---------------------------------------------------------------------------
// Polygon / Pen — from a list of click points
// ---------------------------------------------------------------------------

export function createPolygonFromPoints(points: Vec2[], closed = true): string | null {
  if (points.length < 2) return null
  pushHistory()

  const pts: PatternPoint[] = points.map((p) => makePoint(p.x, p.y))
  const points_: Record<string, PatternPoint> = {}
  for (const p of pts) points_[p.id] = p

  const edges: PatternEdge[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    edges.push(makeEdge(pts[i].id, pts[i + 1].id))
  }
  if (closed && pts.length >= 3) {
    edges.push(makeEdge(pts[pts.length - 1].id, pts[0].id))
  }

  const piece: PatternPiece = {
    id: uid(),
    name: nextPatternName(),
    points: points_,
    edges,
    closed: closed && pts.length >= 3,
    particleDistance: 22,
  }
  commit(piece)
  return piece.id
}

// ---------------------------------------------------------------------------
// Drafts (the in-progress shape being drawn) — DO NOT push history; only the
// final commit does.
// ---------------------------------------------------------------------------

export function beginRectDraft(p: Vec2) {
  clothingStore.draft = { kind: 'rect', start: p, current: p }
}

export function beginEllipseDraft(p: Vec2) {
  clothingStore.draft = { kind: 'ellipse', start: p, current: p }
}

export function beginCircleDraft(p: Vec2) {
  clothingStore.draft = { kind: 'circle', center: p, current: p }
}

export function createCircleFromCenter(center: Vec2, radius: number): string | null {
  if (radius < 4) return null
  return createEllipseFromBounds(
    { x: center.x - radius, y: center.y - radius },
    { x: center.x + radius, y: center.y + radius },
  )
}

export function updateDraftCurrent(p: Vec2) {
  if (!clothingStore.draft) return
  clothingStore.draft.current = p
}

export function beginOrExtendPolygonDraft(p: Vec2) {
  if (clothingStore.draft?.kind === 'polygon') {
    clothingStore.draft.points.push(p)
    clothingStore.draft.current = p
  } else {
    clothingStore.draft = { kind: 'polygon', points: [p], current: p }
  }
}

export function beginOrExtendPenDraft(p: Vec2) {
  if (clothingStore.draft?.kind === 'pen') {
    clothingStore.draft.points.push(p)
    clothingStore.draft.current = p
  } else {
    clothingStore.draft = { kind: 'pen', points: [p], current: p }
  }
}

export function cancelDraft() {
  clothingStore.draft = null
}

/** Commit the current draft. For rect/ellipse, also commits if `final` is provided. */
export function commitDraft() {
  const draft = clothingStore.draft
  if (!draft) return null
  let id: string | null = null
  if (draft.kind === 'rect') {
    id = createRectangleFromBounds(draft.start, draft.current)
  } else if (draft.kind === 'ellipse') {
    id = createEllipseFromBounds(draft.start, draft.current)
  } else if (draft.kind === 'circle') {
    const r = Math.hypot(draft.current.x - draft.center.x, draft.current.y - draft.center.y)
    id = createCircleFromCenter(draft.center, r)
  } else if (draft.kind === 'polygon') {
    id = createPolygonFromPoints(draft.points, true)
  } else if (draft.kind === 'pen') {
    id = createPolygonFromPoints(draft.points, false)
  }
  clothingStore.draft = null
  return id
}
