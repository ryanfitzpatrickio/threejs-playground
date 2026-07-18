import { clothingStore } from '../../state/clothingStore'
import type { Vec2 } from '../../state/clothingTypes'

/** Convert screen (canvas) coords to world coords, given the canvas dimensions. */
export function screenToWorld(screen: Vec2, viewW: number, viewH: number): Vec2 {
  const { viewport2D } = clothingStore
  const cx = viewW / 2
  const cy = viewH / 2
  return {
    x: (screen.x - cx) / viewport2D.zoom + viewport2D.panX,
    y: (screen.y - cy) / viewport2D.zoom + viewport2D.panY,
  }
}

export function applyZoomAt(screen: Vec2, deltaY: number, viewW: number, viewH: number) {
  const factor = deltaY < 0 ? 1.12 : 1 / 1.12
  const newZoom = Math.max(0.05, Math.min(20, clothingStore.viewport2D.zoom * factor))

  const before = screenToWorld(screen, viewW, viewH)
  clothingStore.viewport2D.zoom = newZoom
  const after = screenToWorld(screen, viewW, viewH)
  clothingStore.viewport2D.panX += before.x - after.x
  clothingStore.viewport2D.panY += before.y - after.y
}

export class PanController {
  private active = false
  private startScreen: Vec2 = { x: 0, y: 0 }
  private startPan: Vec2 = { x: 0, y: 0 }

  begin(screen: Vec2) {
    this.active = true
    this.startScreen = screen
    this.startPan = { x: clothingStore.viewport2D.panX, y: clothingStore.viewport2D.panY }
  }

  update(screen: Vec2) {
    if (!this.active) return
    const dx = screen.x - this.startScreen.x
    const dy = screen.y - this.startScreen.y
    const z = clothingStore.viewport2D.zoom
    clothingStore.viewport2D.panX = this.startPan.x - dx / z
    clothingStore.viewport2D.panY = this.startPan.y - dy / z
  }

  end() { this.active = false }
  isActive() { return this.active }
}
