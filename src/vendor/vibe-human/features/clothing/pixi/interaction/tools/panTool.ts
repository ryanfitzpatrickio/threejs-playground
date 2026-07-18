import { clothingStore } from '../../../state/clothingStore'
import type { ToolHandler } from '../types'

let panStart: { x: number; y: number } | null = null
let originPan: { x: number; y: number } | null = null

export const panTool: ToolHandler = {
  onPointerDown(e, ctx) {
    panStart = e.screen
    originPan = { x: clothingStore.viewport2D.panX, y: clothingStore.viewport2D.panY }
    ctx.setPointerCapture(ctx.pointerId)
    return true
  },
  onPointerMove(e) {
    if (!panStart || !originPan) return
    const dx = e.screen.x - panStart.x
    const dy = e.screen.y - panStart.y
    const z = clothingStore.viewport2D.zoom
    clothingStore.viewport2D.panX = originPan.x - dx / z
    clothingStore.viewport2D.panY = originPan.y - dy / z
    return true
  },
  onPointerUp(_e, ctx) {
    panStart = null
    originPan = null
    ctx.releasePointerCapture(ctx.pointerId)
  },
  onCancel() { panStart = null; originPan = null },
}
