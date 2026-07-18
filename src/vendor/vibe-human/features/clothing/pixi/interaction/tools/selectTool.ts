import { clothingStore } from '../../../state/clothingStore'
import {
  pushHistory,
  rotatePieces,
  scalePieces,
  setSelectedPatterns,
  translatePieces,
} from '../../../state/clothingActions'
import { bboxOfPieces } from '../../../state/transformActions'
import { pickAt, pickAllPatterns } from '../../PatternPicker'
import type { Vec2, GizmoHandle } from '../../../state/clothingTypes'
import type { PointerEvt, ToolCtx, ToolHandler } from '../types'
import { bboxCenter, hitTestGizmo } from '../Gizmo'

// ---------------------------------------------------------------------------
// Cycle state — tracks repeated clicks on the same overlapping area so the
// user can drill through stacked pieces (like MD's repeated-click behaviour).
// ---------------------------------------------------------------------------

const CYCLE_RADIUS_WORLD = 12 // world units — clicks within this radius continue the cycle
let cycleState: { candidates: string[]; index: number; lastPt: Vec2 } | null = null

type DragState =
  | { kind: 'translate'; last: Vec2 }
  | { kind: 'rotate'; pivot: Vec2; startAngle: number; ids: string[] }
  | {
      kind: 'scale'
      handle: GizmoHandle
      pivot: Vec2
      startBox: { w: number; h: number }
      startWorld: Vec2
      ids: string[]
    }
  | { kind: 'marquee'; start: Vec2 }

let drag: DragState | null = null

function pieceContainingPoint(pt: Vec2, zoom: number): string | null {
  const pick = pickAt(clothingStore.garment, pt, zoom)
  if (pick?.type === 'pattern') return pick.patternId
  if (pick?.type === 'edge' || pick?.type === 'point') return pick.patternId
  return null
}

export const selectTool: ToolHandler = {
  onPointerDown(e: PointerEvt, ctx: ToolCtx) {
    if (e.button !== 0) return
    const ids = [...clothingStore.selectedPatternIds]
    const box = ids.length ? bboxOfPieces(ids) : null

    // 1. Hit gizmo handle on current selection?
    if (box) {
      const hit = hitTestGizmo(e.world, box, e.zoom)
      if (hit) {
        pushHistory()
        ctx.setPointerCapture(ctx.pointerId)
        if (hit.handle === 'move') {
          drag = { kind: 'translate', last: e.world }
        } else if (hit.handle === 'rotate') {
          const pivot = bboxCenter(box)
          drag = {
            kind: 'rotate',
            pivot,
            startAngle: Math.atan2(e.world.y - pivot.y, e.world.x - pivot.x),
            ids,
          }
        } else {
          // Scale — pivot is the opposite corner/edge midpoint
          const pivot = pivotForHandle(hit.handle, box)
          drag = {
            kind: 'scale',
            handle: hit.handle,
            pivot,
            startBox: { w: box.maxX - box.minX, h: box.maxY - box.minY },
            startWorld: e.world,
            ids,
          }
        }
        return true
      }
    }

    // 2. Click a piece -> select it
    const hitId = pieceContainingPoint(e.world, e.zoom)
    if (hitId) {
      if (e.native.shiftKey) {
        const cur = new Set(clothingStore.selectedPatternIds)
        if (cur.has(hitId)) cur.delete(hitId)
        else cur.add(hitId)
        setSelectedPatterns([...cur])
        cycleState = null
      } else {
        // Check if we should cycle through overlapping pieces
        const nearLastCycle = cycleState && Math.hypot(
          e.world.x - cycleState.lastPt.x,
          e.world.y - cycleState.lastPt.y,
        ) * e.zoom < CYCLE_RADIUS_WORLD

        if (nearLastCycle && cycleState) {
          // Advance to next candidate
          cycleState.index = (cycleState.index + 1) % cycleState.candidates.length
          const nextId = cycleState.candidates[cycleState.index]
          setSelectedPatterns([nextId])
          cycleState.lastPt = e.world
        } else {
          // Fresh click — build candidate list
          const candidates = pickAllPatterns(clothingStore.garment, e.world)
          if (candidates.length > 1) {
            cycleState = { candidates, index: 0, lastPt: e.world }
          } else {
            cycleState = null
          }
          if (!clothingStore.selectedPatternIds.includes(hitId)) {
            setSelectedPatterns([hitId])
          }
        }
      }
      // Begin drag of the (possibly multi) selection
      pushHistory()
      ctx.setPointerCapture(ctx.pointerId)
      drag = { kind: 'translate', last: e.world }
      return true
    }

    // 3. Empty click -> marquee
    cycleState = null
    if (!e.native.shiftKey) setSelectedPatterns([])
    drag = { kind: 'marquee', start: e.world }
    ctx.setPointerCapture(ctx.pointerId)
    return true
  },

  onPointerMove(e: PointerEvt) {
    if (!drag) return
    if (drag.kind === 'translate') {
      const dx = e.world.x - drag.last.x
      const dy = e.world.y - drag.last.y
      translatePieces([...clothingStore.selectedPatternIds], dx, dy)
      drag.last = e.world
      return true
    }
    if (drag.kind === 'rotate') {
      const ang = Math.atan2(e.world.y - drag.pivot.y, e.world.x - drag.pivot.x)
      const delta = ang - drag.startAngle
      rotatePieces(drag.ids, drag.pivot, delta)
      drag.startAngle = ang
      return true
    }
    if (drag.kind === 'scale') {
      const { pivot, startWorld, handle, ids } = drag
      const horiz = handle.includes('e') || handle.includes('w')
      const vert = handle.includes('n') || handle.includes('s')
      // Incremental scale: ratio between current and previous offset from pivot.
      const prevDx = startWorld.x - pivot.x
      const prevDy = startWorld.y - pivot.y
      const curDx = e.world.x - pivot.x
      const curDy = e.world.y - pivot.y
      let sx = horiz && Math.abs(prevDx) > 1e-3 ? curDx / prevDx : 1
      let sy = vert && Math.abs(prevDy) > 1e-3 ? curDy / prevDy : 1
      if (!isFinite(sx) || sx === 0) sx = 1
      if (!isFinite(sy) || sy === 0) sy = 1
      scalePieces(ids, pivot, sx, sy)
      drag.startWorld = e.world
      return true
    }
    if (drag.kind === 'marquee') {
      // Marquee is purely visual — we update on up.
      return true
    }
  },

  onPointerUp(e: PointerEvt, ctx: ToolCtx) {
    if (drag?.kind === 'marquee') {
      const minX = Math.min(drag.start.x, e.world.x)
      const maxX = Math.max(drag.start.x, e.world.x)
      const minY = Math.min(drag.start.y, e.world.y)
      const maxY = Math.max(drag.start.y, e.world.y)
      const inside: string[] = []
      for (const piece of Object.values(clothingStore.garment.patterns)) {
        const pts = Object.values(piece.points)
        if (pts.length === 0) continue
        // Treat a piece as selected if its center is inside the marquee.
        let cx = 0, cy = 0
        for (const p of pts) { cx += p.x; cy += p.y }
        cx /= pts.length; cy /= pts.length
        if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) inside.push(piece.id)
      }
      if (inside.length) setSelectedPatterns(inside)
    }
    drag = null
    ctx.releasePointerCapture(ctx.pointerId)
  },

  onCancel() { drag = null },
}

function pivotForHandle(h: GizmoHandle, b: { minX: number; minY: number; maxX: number; maxY: number }): Vec2 {
  switch (h) {
    case 'nw': return { x: b.maxX, y: b.maxY }
    case 'n':  return { x: (b.minX + b.maxX) / 2, y: b.maxY }
    case 'ne': return { x: b.minX, y: b.maxY }
    case 'e':  return { x: b.minX, y: (b.minY + b.maxY) / 2 }
    case 'se': return { x: b.minX, y: b.minY }
    case 's':  return { x: (b.minX + b.maxX) / 2, y: b.minY }
    case 'sw': return { x: b.maxX, y: b.minY }
    case 'w':  return { x: b.maxX, y: (b.minY + b.maxY) / 2 }
    default:   return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  }
}
