import { clothingStore } from '../../state/clothingStore'
import {
  cancelDraft,
  commitDraft,
  deletePieces,
  deletePoint,
  duplicatePieces,
  redo,
  setActiveClothingTool,
  subtractTopFromSelection,
  undo,
} from '../../state/clothingActions'
import type { ClothingTool, Vec2 } from '../../state/clothingTypes'
import { applyZoomAt, screenToWorld } from './Camera'
import type { ToolCtx, ToolHandler, PointerEvt } from './types'
import { selectTool } from './tools/selectTool'
import { editPointsTool } from './tools/editPointsTool'
import { rectTool, ellipseTool, circleTool, polygonTool, penTool } from './tools/shapeTools'
import { seamTool } from './tools/seamTool'
import { tackTool } from './tools/tackTool'
import { panTool } from './tools/panTool'
import { pickAt } from '../PatternPicker'

const TOOLS: Record<ClothingTool, ToolHandler> = {
  select: selectTool,
  'edit-points': editPointsTool,
  rect: rectTool,
  ellipse: ellipseTool,
  circle: circleTool,
  polygon: polygonTool,
  pen: penTool,
  seam: seamTool,
  tack: tackTool,
  pan: panTool,
}

/**
 * CanvasController wires DOM events to the active tool and global behaviors
 * (zoom, right-click boolean, keyboard shortcuts, panning override).
 *
 * It is stateless w.r.t. document data — all state lives in clothingStore.
 */
export class CanvasController {
  private cleanup: Array<() => void> = []
  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.bind()
  }

  destroy() {
    this.resetTouchState()
    for (const fn of this.cleanup) fn()
    this.cleanup = []
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private bind() {
    const c = this.canvas
    const off = (target: EventTarget, ev: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) => {
      target.addEventListener(ev, fn, opts)
      this.cleanup.push(() => target.removeEventListener(ev, fn, opts))
    }

    off(c, 'contextmenu', (e) => e.preventDefault())

    off(c, 'wheel', (e: Event) => {
      const we = e as WheelEvent
      we.preventDefault()
      const view = this.viewSize()
      applyZoomAt(this.screenOf(we), we.deltaY, view.w, view.h)
    }, { passive: false })

    off(c, 'pointerdown', (e: Event) => this.handlePointer(e as PointerEvent, 'down'))
    off(c, 'pointermove', (e: Event) => this.handlePointer(e as PointerEvent, 'move'))
    off(c, 'pointerup',   (e: Event) => this.handlePointer(e as PointerEvent, 'up'))
    off(c, 'pointercancel', (e: Event) => {
      const pe = e as PointerEvent
      console.debug('[CanvasController] pointercancel', {
        pointerId: pe.pointerId,
        activeTouchesSize: this.activeTouches.size,
        touchDragPointerId: this.touchDragPointerId,
      })
      this.resetTouchState()
      this.tool().onCancel?.(this.ctxOf(e as PointerEvent))
    })

    off(window, 'keydown', (e: Event) => this.handleKey(e as KeyboardEvent))
    off(window, 'keyup', (e: Event) => this.handleKey(e as KeyboardEvent))
  }

  // -------------------------------------------------------------------------
  // Pointer routing
  // -------------------------------------------------------------------------

  private handlePointer(e: PointerEvent, kind: 'down' | 'move' | 'up') {
    if (this.handleTouchGesture(e, kind)) return
    const isTouch = e.pointerType === 'touch'
    if (isTouch && !this.shouldHandleSingleTouch(e, kind)) return
    if (!isTouch || this.touchDragPointerId === e.pointerId) e.preventDefault()
    const view = this.viewSize()
    const screen = this.screenOf(e)
    const world = screenToWorld(screen, view.w, view.h)
    const evt: PointerEvt = {
      kind,
      screen,
      world,
      button: e.button,
      zoom: clothingStore.viewport2D.zoom,
      native: e,
      detail: e.detail,
    }

    // Right-click is reserved (context menu suppressed elsewhere). Boolean is
    // now an explicit toolbar action — see Subtract button — to avoid the
    // "which one is the cutter?" ambiguity that bit us before.
    if (kind === 'down' && e.button === 2) return

    // Middle-mouse or Space-held: pan override regardless of tool
    if (kind === 'down' && (e.button === 1 || this.isSpaceDown())) {
      panTool.onPointerDown?.(evt, this.ctxOf(e))
      this.panOverride = true
      return
    }
    if (this.panOverride) {
      if (kind === 'move') panTool.onPointerMove?.(evt, this.ctxOf(e))
      if (kind === 'up') {
        panTool.onPointerUp?.(evt, this.ctxOf(e))
        this.panOverride = false
      }
      return
    }

    const handler = this.tool()
    if (kind === 'down') handler.onPointerDown?.(evt, this.ctxOf(e))
    if (kind === 'move') handler.onPointerMove?.(evt, this.ctxOf(e))
    if (kind === 'up')   handler.onPointerUp?.(evt, this.ctxOf(e))
  }

  private activeTouches = new Map<number, Vec2>()
  private touchGestureState: { distance: number; centerWorld: Vec2 } | null = null
  private touchDragPointerId: number | null = null

  private resetTouchState() {
    this.activeTouches.clear()
    this.touchGestureState = null
    this.touchDragPointerId = null
    this.panOverride = false
    console.debug('[CanvasController] touch state reset', {
      activeTouchesSize: this.activeTouches.size,
      touchDragPointerId: this.touchDragPointerId,
    })
  }

  private handleTouchGesture(e: PointerEvent, kind: 'down' | 'move' | 'up') {
    if (e.pointerType !== 'touch') return false

    if (kind === 'down' || kind === 'up') {
      console.debug(`[CanvasController] pointer${kind}`, {
        pointerId: e.pointerId,
        activeTouchesSize: this.activeTouches.size,
        touchDragPointerId: this.touchDragPointerId,
      })
    }

    if (kind === 'down') this.activeTouches.set(e.pointerId, this.screenOf(e))
    if (kind === 'move' && this.activeTouches.has(e.pointerId)) this.activeTouches.set(e.pointerId, this.screenOf(e))
    if (kind === 'up') {
      this.activeTouches.delete(e.pointerId)
      if (this.activeTouches.size === 0) {
        this.touchGestureState = null
        // Do NOT clear touchDragPointerId here — shouldHandleSingleTouch checks
        // it on 'up' and clears it after routing the event to the active tool.
        // Clearing it here would prevent onPointerUp from reaching shape tools,
        // so rect/circle/etc never get to commitDraft().
        console.debug('[CanvasController] gesture end', {
          activeTouchesSize: this.activeTouches.size,
          touchDragPointerId: this.touchDragPointerId,
        })
      }
    }

    const touches = [...this.activeTouches.values()]
    if (touches.length === 0) {
      // Don't reset touchDragPointerId here — the pointer-up event still needs
      // to reach the active tool via shouldHandleSingleTouch before we clear it.
      this.touchGestureState = null
      return false
    }
    if (touches.length < 2) {
      // On touch devices, reserve one-finger gestures for native page scroll.
      // Two-finger gestures are used for canvas pan/zoom.
      this.touchGestureState = null
      return false
    }

    this.touchDragPointerId = null

    e.preventDefault()
    const [a, b] = touches
    const center = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 }
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
    const view = this.viewSize()

    if (!this.touchGestureState) {
      console.debug('[CanvasController] gesture start', {
        activeTouchesSize: this.activeTouches.size,
        touchDragPointerId: this.touchDragPointerId,
      })
      this.touchGestureState = {
        distance,
        centerWorld: screenToWorld(center, view.w, view.h),
      }
      return true
    }

    const scale = distance / this.touchGestureState.distance
    const current = clothingStore.viewport2D.zoom
    clothingStore.viewport2D.zoom = Math.max(0.05, Math.min(20, current * scale))
    this.touchGestureState.distance = distance

    const after = screenToWorld(center, view.w, view.h)
    clothingStore.viewport2D.panX += this.touchGestureState.centerWorld.x - after.x
    clothingStore.viewport2D.panY += this.touchGestureState.centerWorld.y - after.y
    this.touchGestureState.centerWorld = screenToWorld(center, view.w, view.h)
    return true
  }

  private shouldHandleSingleTouch(e: PointerEvent, kind: 'down' | 'move' | 'up') {
    if (kind === 'up' && this.touchDragPointerId === e.pointerId) {
      this.touchDragPointerId = null
      return true
    }
    if (kind === 'move') return this.touchDragPointerId === e.pointerId
    if (kind !== 'down') return false
    if (this.activeTouches.size > 1) return false

    const activeTool = clothingStore.activeClothingTool
    const alwaysHandleTouchTools: ClothingTool[] = ['rect', 'ellipse', 'circle', 'polygon', 'pen', 'seam', 'tack', 'pan']
    if (alwaysHandleTouchTools.includes(activeTool)) {
      this.touchDragPointerId = e.pointerId
      return true
    }

    const view = this.viewSize()
    const world = screenToWorld(this.screenOf(e), view.w, view.h)
    const pick = pickAt(clothingStore.garment, world, clothingStore.viewport2D.zoom)
    const shouldDrag = pick?.type === 'point' || pick?.type === 'edge' || pick?.type === 'pattern'
    if (shouldDrag) this.touchDragPointerId = e.pointerId
    return shouldDrag
  }

  // -------------------------------------------------------------------------
  // Keyboard shortcuts (global to canvas focus)
  // -------------------------------------------------------------------------

  private spaceDown = false
  private panOverride = false

  private isSpaceDown() { return this.spaceDown }

  private handleKey(e: KeyboardEvent) {
    // Ignore when typing in inputs
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return

    if (e.code === 'Space') {
      this.spaceDown = e.type === 'keydown'
      if (e.type === 'keydown') return
    }

    if (e.type !== 'keydown') return

    const meta = e.metaKey || e.ctrlKey

    // Undo / Redo
    if (meta && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (meta && e.key.toLowerCase() === 'y') {
      e.preventDefault(); redo(); return
    }
    if (meta && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      duplicatePieces([...clothingStore.selectedPatternIds])
      return
    }
    if (meta && (e.key === '-' || e.key === '_')) {
      e.preventDefault()
      subtractTopFromSelection()
      return
    }

    // Tool shortcuts
    const tools: Record<string, ClothingTool> = {
      v: 'select',
      a: 'edit-points',
      r: 'rect',
      c: 'circle',
      o: 'ellipse',
      p: 'polygon',
      n: 'pen',
      m: 'seam',
      t: 'tack',
    }
    const t = tools[e.key.toLowerCase()]
    if (t && !meta) {
      e.preventDefault()
      setActiveClothingTool(t)
      return
    }

    // Enter / Escape — commit / cancel draft
    if (e.key === 'Enter') {
      if (clothingStore.draft) commitDraft()
      return
    }
    if (e.key === 'Escape') {
      cancelDraft()
      this.tool().onCancel?.(this.ctxOf(null))
      return
    }

    // Delete
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      const { selectedPatternId, selectedPointId } = clothingStore.garment
      if (selectedPointId && selectedPatternId) {
        deletePoint(selectedPatternId, selectedPointId)
      } else {
        deletePieces([...clothingStore.selectedPatternIds])
      }
      return
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private tool(): ToolHandler {
    return TOOLS[clothingStore.activeClothingTool] ?? selectTool
  }

  private viewSize() {
    return {
      w: this.canvas.clientWidth || this.canvas.width / window.devicePixelRatio,
      h: this.canvas.clientHeight || this.canvas.height / window.devicePixelRatio,
    }
  }

  private screenOf(e: { clientX: number; clientY: number }): Vec2 {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private ctxOf(e: PointerEvent | null): ToolCtx {
    const pid = e?.pointerId ?? -1
    return {
      pointerId: pid,
      setPointerCapture: (id) => { try { this.canvas.setPointerCapture(id) } catch {} },
      releasePointerCapture: (id) => { try { this.canvas.releasePointerCapture(id) } catch {} },
    }
  }

}
