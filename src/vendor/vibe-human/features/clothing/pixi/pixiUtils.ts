import * as PIXI from 'pixi.js'
import type { Vec2 } from '../state/clothingTypes'

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

export const COLORS = {
  grid:          0x343448,
  gridMajor:     0x54546f,
  patternFill:   0x2f6dff,
  patternFillAlpha: 0.28,
  patternStroke: 0x5588ff,
  patternStrokeSelected: 0xffc044,
  point:         0xffffff,
  pointSelected: 0xff8800,
  pointHover:    0xffff00,
  handleLine:    0x888899,
  handle:        0x88aaff,
  seam:          0xff4466,
  seamAlpha:     0.8,
  background:    0x141421,
}

// ---------------------------------------------------------------------------
// Grid drawing
// ---------------------------------------------------------------------------

export function drawGrid(
  g: PIXI.Graphics,
  worldLeft: number,
  worldTop: number,
  worldRight: number,
  worldBottom: number,
  step = 50,
) {
  g.clear()

  const startX = Math.floor(worldLeft / step) * step
  const startY = Math.floor(worldTop  / step) * step

  for (let x = startX; x <= worldRight; x += step) {
    const isMajor = x % (step * 5) === 0
    g.setStrokeStyle({ width: isMajor ? 1.2 : 0.5, color: isMajor ? COLORS.gridMajor : COLORS.grid, alpha: 1 })
    g.moveTo(x, worldTop)
    g.lineTo(x, worldBottom)
    g.stroke()
  }

  for (let y = startY; y <= worldBottom; y += step) {
    const isMajor = y % (step * 5) === 0
    g.setStrokeStyle({ width: isMajor ? 1.2 : 0.5, color: isMajor ? COLORS.gridMajor : COLORS.grid, alpha: 1 })
    g.moveTo(worldLeft,  y)
    g.lineTo(worldRight, y)
    g.stroke()
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

export function drawPolyline(g: PIXI.Graphics, pts: Vec2[], closed = false) {
  if (pts.length < 2) return
  g.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) {
    g.lineTo(pts[i].x, pts[i].y)
  }
  if (closed && pts.length > 2) g.lineTo(pts[0].x, pts[0].y)
}

export function drawCircle(g: PIXI.Graphics, cx: number, cy: number, r: number) {
  g.circle(cx, cy, r)
}

/** Convert screen pixel size to world units given zoom. */
export function screenToWorld(screenPx: number, zoom: number): number {
  return screenPx / zoom
}

/** Convert Vec2 to PIXI.Point */
export function toPixiPoint(v: Vec2): PIXI.Point {
  return new PIXI.Point(v.x, v.y)
}
