import { clothingStore } from '../../../state/clothingStore'
import {
  beginCircleDraft,
  beginEllipseDraft,
  beginRectDraft,
  beginOrExtendPolygonDraft,
  beginOrExtendPenDraft,
  cancelDraft,
  commitDraft,
  updateDraftCurrent,
} from '../../../state/clothingActions'
import type { PointerEvt, ToolHandler, ToolCtx } from '../types'

// Distance in screen px within which clicking the first/last anchor finishes.
const CLOSE_TOL_PX = 12

export const rectTool: ToolHandler = {
  onPointerDown(e, ctx) {
    if (e.button !== 0) return
    beginRectDraft(e.world)
    ctx.setPointerCapture(ctx.pointerId)
    return true
  },
  onPointerMove(e) {
    if (!clothingStore.draft) return
    updateDraftCurrent(e.world)
    return true
  },
  onPointerUp(_e, ctx) {
    commitDraft()
    ctx.releasePointerCapture(ctx.pointerId)
  },
  onCancel() { cancelDraft() },
}

export const circleTool: ToolHandler = {
  onPointerDown(e, ctx) {
    if (e.button !== 0) return
    beginCircleDraft(e.world)
    ctx.setPointerCapture(ctx.pointerId)
    return true
  },
  onPointerMove(e) {
    if (!clothingStore.draft) return
    updateDraftCurrent(e.world)
    return true
  },
  onPointerUp(_e, ctx) {
    commitDraft()
    ctx.releasePointerCapture(ctx.pointerId)
  },
  onCancel() { cancelDraft() },
}

export const ellipseTool: ToolHandler = {
  onPointerDown(e, ctx) {
    if (e.button !== 0) return
    beginEllipseDraft(e.world)
    ctx.setPointerCapture(ctx.pointerId)
    return true
  },
  onPointerMove(e) {
    if (!clothingStore.draft) return
    updateDraftCurrent(e.world)
    return true
  },
  onPointerUp(_e, ctx) {
    commitDraft()
    ctx.releasePointerCapture(ctx.pointerId)
  },
  onCancel() { cancelDraft() },
}

function buildPolyTool(
  expectedKind: 'polygon' | 'pen',
  extend: (p: { x: number; y: number }) => void,
): ToolHandler {
  // Track click timing for manual double-click detection (pointerdown's
  // `detail` is not always reliable across browsers when previous events
  // were captured by other handlers).
  let lastClickAt = 0
  let lastClickPt = { x: 0, y: 0 }

  return {
    onPointerDown(e: PointerEvt, _ctx: ToolCtx) {
      if (e.button !== 0) return

      const now = performance.now()
      const dt = now - lastClickAt
      const dpx = Math.hypot(e.screen.x - lastClickPt.x, e.screen.y - lastClickPt.y)
      const isDouble = dt < 320 && dpx < 6
      lastClickAt = now
      lastClickPt = e.screen

      const draft = clothingStore.draft
      if (draft && draft.kind === expectedKind) {
        // Click on first anchor closes
        const first = draft.points[0]
        if (first) {
          const firstPx = Math.hypot(
            (e.world.x - first.x) * e.zoom,
            (e.world.y - first.y) * e.zoom,
          )
          if (firstPx < CLOSE_TOL_PX && draft.points.length >= 2) {
            commitDraft()
            return true
          }
        }
        // Double-click commits whatever we have
        if (isDouble && draft.points.length >= 1) {
          commitDraft()
          return true
        }
      }

      extend(e.world)
      return true
    },
    onPointerMove(e) {
      if (!clothingStore.draft) return
      updateDraftCurrent(e.world)
      return true
    },
    onPointerUp() {
      // Click-to-add, no drag. Don't release capture (none taken).
    },
    onCancel() { cancelDraft() },
  }
}

export const polygonTool = buildPolyTool('polygon', beginOrExtendPolygonDraft)
export const penTool = buildPolyTool('pen', beginOrExtendPenDraft)
