import { clothingStore } from '../../../state/clothingStore'
import {
  ensurePointSmoothForDrag,
  insertPointOnEdge,
  moveHandleRaw,
  movePointRaw,
  pushHistory,
  selectEdge,
  selectPattern,
  selectPoint,
  toggleEdgeCurve,
  togglePointSmooth,
} from '../../../state/clothingActions'
import { pickAt } from '../../PatternPicker'
import type { PointerEvt, ToolCtx, ToolHandler } from '../types'

type DragState =
  | { kind: 'point'; patternId: string; pointId: string }
  | { kind: 'handle'; patternId: string; pointId: string; handle: 'in' | 'out' }

let drag: DragState | null = null

export const editPointsTool: ToolHandler = {
  onPointerDown(e: PointerEvt, ctx: ToolCtx) {
    if (e.button !== 0) return
    const pick = pickAt(clothingStore.garment, e.world, e.zoom)
    if (!pick) {
      selectPoint(undefined)
      selectEdge(undefined)
      return true
    }
    if (pick.type === 'point') {
      selectPattern(pick.patternId)
      selectPoint(pick.pointId)
      if ((e.detail ?? 1) >= 2) {
        // double-click: cycle corner → smooth → symmetric → corner
        togglePointSmooth(pick.patternId, pick.pointId)
        return true
      }
      if (e.native.ctrlKey) {
        // ctrl+drag: pull out bezier handles (convert corner to smooth if needed,
        // then drag the 'out' handle so the user sculpts the curve directly)
        pushHistory()
        ensurePointSmoothForDrag(pick.patternId, pick.pointId)
        drag = { kind: 'handle', patternId: pick.patternId, pointId: pick.pointId, handle: 'out' }
        ctx.setPointerCapture(ctx.pointerId)
        return true
      }
      pushHistory()
      drag = { kind: 'point', patternId: pick.patternId, pointId: pick.pointId }
      ctx.setPointerCapture(ctx.pointerId)
      return true
    }
    if (pick.type === 'handle') {
      selectPattern(pick.patternId)
      selectPoint(pick.pointId)
      pushHistory()
      drag = { kind: 'handle', patternId: pick.patternId, pointId: pick.pointId, handle: pick.handleKind }
      ctx.setPointerCapture(ctx.pointerId)
      return true
    }
    if (pick.type === 'edge') {
      selectPattern(pick.patternId)
      selectEdge(pick.edgeId)
      if ((e.detail ?? 1) >= 2) {
        // double click: toggle line/curve
        toggleEdgeCurve(pick.patternId, pick.edgeId)
      } else if (e.native.altKey) {
        // alt-click: insert a point on the edge
        const newId = insertPointOnEdge(pick.patternId, pick.edgeId, 0.5)
        if (newId) {
          selectPoint(newId)
          drag = { kind: 'point', patternId: pick.patternId, pointId: newId }
          ctx.setPointerCapture(ctx.pointerId)
        }
      }
      return true
    }
    if (pick.type === 'pattern') {
      selectPattern(pick.patternId)
      return true
    }
  },

  onPointerMove(e: PointerEvt) {
    if (!drag) return
    if (drag.kind === 'point') {
      movePointRaw(drag.patternId, drag.pointId, e.world.x, e.world.y)
    } else {
      moveHandleRaw(drag.patternId, drag.pointId, drag.handle, e.world.x, e.world.y)
    }
    return true
  },

  onPointerUp(_e, ctx) {
    drag = null
    ctx.releasePointerCapture(ctx.pointerId)
  },

  onCancel() { drag = null },
}
