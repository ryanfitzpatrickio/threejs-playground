import * as PIXI from 'pixi.js'
import type { GarmentDocument, PatternEdge, PatternPiece } from '../state/clothingTypes'
import { samplePatternOutline, sampleEdge, sampleEdgeLoop } from '../geometry/patternSampling'
import { sampleSeam } from '../geometry/seamUtils'
import { COLORS, drawPolyline, drawCircle } from './pixiUtils'

// ---------------------------------------------------------------------------
// PatternRenderer
// Stateless imperative renderer — reads from GarmentDocument, writes to PIXI.
// Call render() whenever the document or selection changes.
// ---------------------------------------------------------------------------

export class PatternRenderer {
  private fillGfx   = new PIXI.Graphics()
  private strokeGfx = new PIXI.Graphics()
  private pointGfx  = new PIXI.Graphics()
  private seamGfx   = new PIXI.Graphics()

  constructor(container: PIXI.Container) {
    container.addChild(this.fillGfx)
    container.addChild(this.strokeGfx)
    container.addChild(this.seamGfx)
    container.addChild(this.pointGfx)
  }

  // ---------------------------------------------------------------------------
  // Main render entry point
  // ---------------------------------------------------------------------------

  render(
    doc: GarmentDocument,
    hoveredEntityId: string | null,
    showSeams: boolean,
    showPoints: boolean,
    selectedPatternIds: ReadonlyArray<string> = [],
  ) {
    const selSet = new Set(selectedPatternIds.length ? selectedPatternIds : (doc.selectedPatternId ? [doc.selectedPatternId] : []))
    this.fillGfx.clear()
    this.strokeGfx.clear()
    this.pointGfx.clear()
    this.seamGfx.clear()

    const patterns = Object.values(doc.patterns)

    for (const piece of patterns) {
      const isSelected = selSet.has(piece.id)
      const isHovered  = piece.id === hoveredEntityId
      this.renderPieceFill(piece, isSelected, isHovered)
      this.renderPieceOutline(piece, isSelected, isHovered, doc.selectedEdgeId, showPoints)
      if (showPoints) {
        this.renderPoints(piece, doc.selectedPointId, hoveredEntityId)
      }
    }

    if (showSeams) {
      for (const seam of Object.values(doc.seams)) {
        const result = sampleSeam(doc, seam, 8)
        if (!result) continue
        this.renderSeam(result.pointsA, result.pointsB, seam.id === doc.selectedSeamId)
      }
      for (const tack of Object.values(doc.tacks ?? {})) {
        const ptA = { x: tack.a.x, y: tack.a.y }
        const ptB = { x: tack.b.x, y: tack.b.y }
        // Only render if both panels exist (one or both might be off-canvas)
        if (doc.patterns[tack.a.patternId] && doc.patterns[tack.b.patternId]) {
          this.renderTack(ptA, ptB, tack.id === doc.selectedTackId)
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private renderPieceFill(piece: PatternPiece, selected: boolean, hovered: boolean) {
    if (!piece.closed || piece.edges.length < 2) return

    const outline = samplePatternOutline(piece, 12)
    if (outline.length < 3) return

    const alpha = selected ? 0.28 : hovered ? 0.22 : COLORS.patternFillAlpha
    const fillColor = piece.color ? hexStringToInt(piece.color, COLORS.patternFill) : COLORS.patternFill
    this.fillGfx.setFillStyle({ color: fillColor, alpha })
    this.fillGfx.moveTo(outline[0].x, outline[0].y)
    for (let i = 1; i < outline.length; i++) {
      this.fillGfx.lineTo(outline[i].x, outline[i].y)
    }
    this.fillGfx.closePath()
    this.fillGfx.fill()

    for (const holeEdges of piece.holes ?? []) {
      const hole = sampleEdgeLoop(piece, holeEdges, 12)
      if (hole.length < 3) continue
      this.fillGfx.setFillStyle({ color: COLORS.background, alpha: 0.96 })
      this.fillGfx.moveTo(hole[0].x, hole[0].y)
      for (let i = 1; i < hole.length; i++) {
        this.fillGfx.lineTo(hole[i].x, hole[i].y)
      }
      this.fillGfx.closePath()
      this.fillGfx.fill()
    }
  }

  private renderPieceOutline(
    piece: PatternPiece,
    selected: boolean,
    _hovered: boolean,
    selectedEdgeId: string | undefined,
    showHandles: boolean,
  ) {
    for (const edge of piece.edges) {
      this.renderEdge(piece, edge, selected, edge.id === selectedEdgeId, showHandles)
    }

    for (const holeEdges of piece.holes ?? []) {
      for (const edge of holeEdges) {
        this.renderEdge(piece, edge, selected, edge.id === selectedEdgeId, showHandles, 0xff6688)
      }
    }
  }

  private renderEdge(
    piece: PatternPiece,
    edge: PatternEdge,
    selected: boolean,
    isEdgeSelected: boolean,
    showHandles: boolean,
    fallbackColor = 0x4466cc,
  ) {
      const color = isEdgeSelected
        ? COLORS.patternStrokeSelected
        : selected
          ? COLORS.patternStroke
          : fallbackColor
      const width = isEdgeSelected ? 2.5 : selected ? 1.8 : 1.2

      const pts = sampleEdge(piece, edge, 12)
      if (pts.length === 0) return

      // Add the endpoint
      const toPt = piece.points[edge.to]
      const allPts = toPt ? [...pts, { x: toPt.x, y: toPt.y }] : pts

      this.strokeGfx.setStrokeStyle({ width, color, alpha: 1 })
      drawPolyline(this.strokeGfx, allPts)
      this.strokeGfx.stroke()

      // Bezier handles
      if (showHandles && edge.curve === 'cubic') {
        const from = piece.points[edge.from]
        const to   = piece.points[edge.to]
        if (from?.out) {
          this.strokeGfx.setStrokeStyle({ width: 0.8, color: COLORS.handleLine, alpha: 0.6 })
          this.strokeGfx.moveTo(from.x, from.y)
          this.strokeGfx.lineTo(from.x + from.out.x, from.y + from.out.y)
          this.strokeGfx.stroke()
          this.pointGfx.setFillStyle({ color: COLORS.handle })
          drawCircle(this.pointGfx, from.x + from.out.x, from.y + from.out.y, 3)
          this.pointGfx.fill()
        }
        if (to?.in) {
          this.strokeGfx.setStrokeStyle({ width: 0.8, color: COLORS.handleLine, alpha: 0.6 })
          this.strokeGfx.moveTo(to.x, to.y)
          this.strokeGfx.lineTo(to.x + to.in.x, to.y + to.in.y)
          this.strokeGfx.stroke()
          this.pointGfx.setFillStyle({ color: COLORS.handle })
          drawCircle(this.pointGfx, to.x + to.in.x, to.y + to.in.y, 3)
          this.pointGfx.fill()
        }
      }
  }

  private renderPoints(
    piece: PatternPiece,
    selectedPointId: string | undefined,
    hoveredEntityId: string | null,
  ) {
    for (const pt of Object.values(piece.points)) {
      const isSelected = pt.id === selectedPointId
      const isHovered  = pt.id === hoveredEntityId

      const color = isSelected
        ? COLORS.pointSelected
        : isHovered
          ? COLORS.pointHover
          : COLORS.point
      const r = isSelected ? 5.5 : isHovered ? 4.5 : 3.5

      this.pointGfx.setFillStyle({ color })
      this.pointGfx.setStrokeStyle({ width: 1, color: 0x000000, alpha: 0.4 })
      drawCircle(this.pointGfx, pt.x, pt.y, r)
      this.pointGfx.fill()
      this.pointGfx.stroke()
    }
  }

  private renderSeam(
    ptsA: { x: number; y: number }[],
    ptsB: { x: number; y: number }[],
    isSelected: boolean,
  ) {
    const color = isSelected ? 0xff8800 : COLORS.seam
    const alpha = COLORS.seamAlpha

    // Draw connector lines between paired samples
    const count = Math.min(ptsA.length, ptsB.length)
    for (let i = 0; i < count; i++) {
      this.seamGfx.setStrokeStyle({ width: 0.8, color, alpha: alpha * 0.4 })
      this.seamGfx.moveTo(ptsA[i].x, ptsA[i].y)
      this.seamGfx.lineTo(ptsB[i].x, ptsB[i].y)
      this.seamGfx.stroke()
    }

    // Draw bold lines along each edge
    this.seamGfx.setStrokeStyle({ width: 2, color, alpha })
    drawPolyline(this.seamGfx, ptsA)
    this.seamGfx.stroke()

    this.seamGfx.setStrokeStyle({ width: 2, color, alpha })
    drawPolyline(this.seamGfx, ptsB)
    this.seamGfx.stroke()
  }

  private renderTack(ptA: { x: number; y: number }, ptB: { x: number; y: number }, selected: boolean) {
    const color = selected ? 0xffdd44 : 0x44ddff
    const alpha = selected ? 1 : 0.8

    // Dashed connector line (3 segments)
    const DASH = 4
    const dx = ptB.x - ptA.x
    const dy = ptB.y - ptA.y
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len
    const uy = dy / len
    const steps = Math.max(1, Math.round(len / (DASH * 2)))
    this.seamGfx.setStrokeStyle({ width: 1, color, alpha: alpha * 0.5 })
    for (let i = 0; i < steps; i++) {
      const t0 = (i * 2 * DASH) / len
      const t1 = Math.min(((i * 2 + 1) * DASH) / len, 1)
      this.seamGfx.moveTo(ptA.x + ux * t0 * len, ptA.y + uy * t0 * len)
      this.seamGfx.lineTo(ptA.x + ux * t1 * len, ptA.y + uy * t1 * len)
      this.seamGfx.stroke()
    }

    // Filled circle at each anchor — indicates "anywhere on surface" rather than an explicit vertex
    const R = 4
    for (const pt of [ptA, ptB]) {
      this.seamGfx.setFillStyle({ color, alpha })
      this.seamGfx.circle(pt.x, pt.y, R)
      this.seamGfx.fill()
      this.seamGfx.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.4 })
      this.seamGfx.circle(pt.x, pt.y, R)
      this.seamGfx.stroke()
    }
  }
}

function hexStringToInt(hex: string, fallback: number) {
  const trimmed = hex.startsWith('#') ? hex.slice(1) : hex
  if (trimmed.length !== 6 && trimmed.length !== 3) return fallback
  const expanded = trimmed.length === 3
    ? trimmed.split('').map((c) => c + c).join('')
    : trimmed
  const value = Number.parseInt(expanded, 16)
  return Number.isFinite(value) ? value : fallback
}
