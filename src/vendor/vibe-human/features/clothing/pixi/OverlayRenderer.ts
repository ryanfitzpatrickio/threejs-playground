import * as PIXI from 'pixi.js'
import { clothingStore } from '../state/clothingStore'
import type { DrawDraft } from '../state/clothingStore'
import { bboxOfPieces } from '../state/transformActions'
import { COLORS, drawCircle } from './pixiUtils'
import { GIZMO_VISUAL } from './interaction/Gizmo'

/**
 * OverlayRenderer paints non-document UI: the in-progress draft shape and
 * the selection transform gizmo. Lives in its own Pixi container so it can
 * be cleared independently each frame.
 */
export class OverlayRenderer {
  private gfx = new PIXI.Graphics()

  constructor(container: PIXI.Container) {
    container.addChild(this.gfx)
  }

  render(zoom: number) {
    const g = this.gfx
    g.clear()

    this.drawDraft(clothingStore.draft, zoom)
    this.drawGizmo(zoom)
  }

  private drawDraft(draft: DrawDraft | null, zoom: number) {
    if (!draft) return
    const g = this.gfx
    const stroke = { width: 1.5 / zoom, color: 0x88bbff, alpha: 0.9 }
    const dashed = { width: 1 / zoom, color: 0x88bbff, alpha: 0.55 }

    if (draft.kind === 'rect') {
      const minX = Math.min(draft.start.x, draft.current.x)
      const minY = Math.min(draft.start.y, draft.current.y)
      const w = Math.abs(draft.current.x - draft.start.x)
      const h = Math.abs(draft.current.y - draft.start.y)
      g.setFillStyle({ color: COLORS.patternFill, alpha: 0.12 })
      g.rect(minX, minY, w, h)
      g.fill()
      g.setStrokeStyle(stroke)
      g.rect(minX, minY, w, h)
      g.stroke()
      return
    }

    if (draft.kind === 'circle') {
      const r = Math.hypot(draft.current.x - draft.center.x, draft.current.y - draft.center.y)
      g.setFillStyle({ color: COLORS.patternFill, alpha: 0.12 })
      g.circle(draft.center.x, draft.center.y, r)
      g.fill()
      g.setStrokeStyle(stroke)
      g.circle(draft.center.x, draft.center.y, r)
      g.stroke()
      // center crosshair
      g.setStrokeStyle({ width: 0.8 / zoom, color: 0xffffff, alpha: 0.6 })
      g.moveTo(draft.center.x - 5 / zoom, draft.center.y); g.lineTo(draft.center.x + 5 / zoom, draft.center.y); g.stroke()
      g.moveTo(draft.center.x, draft.center.y - 5 / zoom); g.lineTo(draft.center.x, draft.center.y + 5 / zoom); g.stroke()
      return
    }

    if (draft.kind === 'ellipse') {
      const cx = (draft.start.x + draft.current.x) / 2
      const cy = (draft.start.y + draft.current.y) / 2
      const rx = Math.abs(draft.current.x - draft.start.x) / 2
      const ry = Math.abs(draft.current.y - draft.start.y) / 2
      g.setFillStyle({ color: COLORS.patternFill, alpha: 0.12 })
      g.ellipse(cx, cy, rx, ry)
      g.fill()
      g.setStrokeStyle(stroke)
      g.ellipse(cx, cy, rx, ry)
      g.stroke()
      return
    }

    if (draft.kind === 'polygon' || draft.kind === 'pen') {
      const pts = draft.points
      if (pts.length === 0) return
      g.setStrokeStyle(stroke)
      g.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y)
      g.lineTo(draft.current.x, draft.current.y)
      g.stroke()

      // hint closing edge for polygon
      if (draft.kind === 'polygon' && pts.length >= 2) {
        g.setStrokeStyle(dashed)
        g.moveTo(draft.current.x, draft.current.y)
        g.lineTo(pts[0].x, pts[0].y)
        g.stroke()
      }

      // anchor dots
      g.setFillStyle({ color: 0xffffff, alpha: 0.9 })
      for (const p of pts) drawCircle(g, p.x, p.y, 3 / zoom)
      g.fill()
      return
    }
  }

  private drawGizmo(zoom: number) {
    const ids = clothingStore.selectedPatternIds
    if (ids.length === 0) return
    const box = bboxOfPieces(ids)
    if (!box) return
    // Only show the gizmo for the select tool; edit-points has its own UI.
    if (clothingStore.activeClothingTool !== 'select') return

    const g = this.gfx
    const sizeWorld = GIZMO_VISUAL.handlePx / zoom
    const halfPx = sizeWorld
    const cx = (box.minX + box.maxX) / 2
    const cy = (box.minY + box.maxY) / 2

    g.setStrokeStyle({ width: 1 / zoom, color: 0xffc044, alpha: 0.95 })
    g.rect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY)
    g.stroke()

    const handlePts: Array<{ x: number; y: number }> = [
      { x: box.minX, y: box.minY },
      { x: cx,       y: box.minY },
      { x: box.maxX, y: box.minY },
      { x: box.maxX, y: cy },
      { x: box.maxX, y: box.maxY },
      { x: cx,       y: box.maxY },
      { x: box.minX, y: box.maxY },
      { x: box.minX, y: cy },
    ]
    g.setFillStyle({ color: 0xffffff, alpha: 1 })
    g.setStrokeStyle({ width: 1 / zoom, color: 0xffc044, alpha: 1 })
    for (const p of handlePts) {
      g.rect(p.x - halfPx, p.y - halfPx, halfPx * 2, halfPx * 2)
      g.fill()
      g.rect(p.x - halfPx, p.y - halfPx, halfPx * 2, halfPx * 2)
      g.stroke()
    }

    // Rotate handle: dot above top-center with a line connecting it.
    const ry = box.minY - GIZMO_VISUAL.rotateOffsetPx / zoom
    g.setStrokeStyle({ width: 1 / zoom, color: 0xffc044, alpha: 0.7 })
    g.moveTo(cx, box.minY); g.lineTo(cx, ry); g.stroke()
    g.setFillStyle({ color: 0x60dd80, alpha: 1 })
    drawCircle(g, cx, ry, halfPx)
    g.fill()
  }
}

