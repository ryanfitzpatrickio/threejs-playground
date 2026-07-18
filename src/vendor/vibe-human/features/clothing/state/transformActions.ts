import { clothingStore } from './clothingStore'
import { pushHistory } from './historyActions'
import type { BBox, PatternPiece, Vec2 } from './clothingTypes'

// ---------------------------------------------------------------------------
// Bounding box helpers (anchors only — handle offsets are recomputed on move)
// ---------------------------------------------------------------------------

export function bboxOfPiece(piece: PatternPiece): BBox | null {
  const pts = Object.values(piece.points)
  if (pts.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export function bboxOfPieces(ids: string[]): BBox | null {
  let agg: BBox | null = null
  for (const id of ids) {
    const piece = clothingStore.garment.patterns[id]
    if (!piece) continue
    const box = bboxOfPiece(piece)
    if (!box) continue
    if (!agg) {
      agg = { ...box }
    } else {
      if (box.minX < agg.minX) agg.minX = box.minX
      if (box.minY < agg.minY) agg.minY = box.minY
      if (box.maxX > agg.maxX) agg.maxX = box.maxX
      if (box.maxY > agg.maxY) agg.maxY = box.maxY
    }
  }
  return agg
}

// ---------------------------------------------------------------------------
// Selection (multi)
// ---------------------------------------------------------------------------

export function setSelectedPatterns(ids: string[]) {
  clothingStore.selectedPatternIds = ids
  clothingStore.garment.selectedPatternId = ids[0]
  clothingStore.garment.selectedPointId = undefined
  clothingStore.garment.selectedEdgeId = undefined
}

// ---------------------------------------------------------------------------
// Translate
// ---------------------------------------------------------------------------

export function translatePieces(ids: string[], dx: number, dy: number) {
  for (const id of ids) {
    const piece = clothingStore.garment.patterns[id]
    if (!piece) continue
    for (const p of Object.values(piece.points)) {
      p.x += dx
      p.y += dy
    }
  }
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Rotate around pivot
// ---------------------------------------------------------------------------

export function rotatePieces(ids: string[], pivot: Vec2, radians: number) {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  for (const id of ids) {
    const piece = clothingStore.garment.patterns[id]
    if (!piece) continue
    for (const p of Object.values(piece.points)) {
      const dx = p.x - pivot.x
      const dy = p.y - pivot.y
      p.x = pivot.x + dx * cos - dy * sin
      p.y = pivot.y + dx * sin + dy * cos
      if (p.in) {
        const ix = p.in.x * cos - p.in.y * sin
        const iy = p.in.x * sin + p.in.y * cos
        p.in.x = ix
        p.in.y = iy
      }
      if (p.out) {
        const ox = p.out.x * cos - p.out.y * sin
        const oy = p.out.x * sin + p.out.y * cos
        p.out.x = ox
        p.out.y = oy
      }
    }
  }
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Scale around pivot
// ---------------------------------------------------------------------------

export function scalePieces(ids: string[], pivot: Vec2, sx: number, sy: number) {
  for (const id of ids) {
    const piece = clothingStore.garment.patterns[id]
    if (!piece) continue
    for (const p of Object.values(piece.points)) {
      p.x = pivot.x + (p.x - pivot.x) * sx
      p.y = pivot.y + (p.y - pivot.y) * sy
      if (p.in) {
        p.in.x *= sx
        p.in.y *= sy
      }
      if (p.out) {
        p.out.x *= sx
        p.out.y *= sy
      }
    }
  }
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Mirror around bounding-box centre
// ---------------------------------------------------------------------------

export function mirrorPieces(ids: string[], axis: 'horizontal' | 'vertical') {
  if (ids.length === 0) return
  const bbox = bboxOfPieces(ids)
  if (!bbox) return
  pushHistory()
  const cx = (bbox.minX + bbox.maxX) / 2
  const cy = (bbox.minY + bbox.maxY) / 2
  for (const id of ids) {
    const piece = clothingStore.garment.patterns[id]
    if (!piece) continue
    for (const p of Object.values(piece.points)) {
      if (axis === 'horizontal') {
        p.x = 2 * cx - p.x
        if (p.in)  { p.in.x  = -p.in.x  }
        if (p.out) { p.out.x = -p.out.x }
      } else {
        p.y = 2 * cy - p.y
        if (p.in)  { p.in.y  = -p.in.y  }
        if (p.out) { p.out.y = -p.out.y }
      }
    }
  }
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Wrappers that push history *before* mutating — for one-shot ops
// (keyboard nudges, programmatic transforms). Drag operations should call
// pushHistory() once at drag-start and the raw helpers above.
// ---------------------------------------------------------------------------

export function translatePiecesWithHistory(ids: string[], dx: number, dy: number) {
  pushHistory()
  translatePieces(ids, dx, dy)
}

export function deletePieces(ids: string[]) {
  if (ids.length === 0) return
  pushHistory()
  for (const id of ids) {
    delete clothingStore.garment.patterns[id]
    // Remove seams that reference this pattern
    for (const sid of Object.keys(clothingStore.garment.seams)) {
      const s = clothingStore.garment.seams[sid]
      if (s.a.patternId === id || s.b.patternId === id) {
        delete clothingStore.garment.seams[sid]
      }
    }
  }
  clothingStore.selectedPatternIds = []
  clothingStore.garment.selectedPatternId = undefined
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

export function duplicatePieces(ids: string[]): string[] {
  if (ids.length === 0) return []
  pushHistory()
  const newIds: string[] = []
  for (const id of ids) {
    const piece = clothingStore.garment.patterns[id]
    if (!piece) continue
    const cloned: PatternPiece = JSON.parse(JSON.stringify(piece))
    // Re-id everything to avoid collisions
    const newPieceId = `${piece.id}_${Math.random().toString(36).slice(2, 7)}`
    cloned.id = newPieceId
    cloned.name = `${piece.name} copy`
    const oldToNew: Record<string, string> = {}
    const remappedPoints: typeof cloned.points = {}
    for (const oldPid of Object.keys(cloned.points)) {
      const newPid = `${oldPid}_${Math.random().toString(36).slice(2, 5)}`
      oldToNew[oldPid] = newPid
      const pt = cloned.points[oldPid]
      pt.id = newPid
      pt.x += 20
      pt.y += 20
      remappedPoints[newPid] = pt
    }
    cloned.points = remappedPoints
    cloned.edges = cloned.edges.map((e) => ({
      ...e,
      id: `${e.id}_${Math.random().toString(36).slice(2, 5)}`,
      from: oldToNew[e.from] ?? e.from,
      to: oldToNew[e.to] ?? e.to,
    }))
    clothingStore.garment.patterns[newPieceId] = cloned
    newIds.push(newPieceId)
  }
  if (newIds.length) setSelectedPatterns(newIds)
  return newIds
}
