import type { Vec2 } from '../../state/clothingTypes'

export type PointerEvtKind = 'down' | 'move' | 'up' | 'dblclick'

export type PointerEvt = {
  kind: PointerEvtKind
  /** screen-space (canvas client) coords */
  screen: Vec2
  /** world-space coords (pan/zoom applied) */
  world: Vec2
  button: number
  /** zoom factor */
  zoom: number
  /** native event, in case modifier keys are needed */
  native: PointerEvent
  /** double-click detail flag */
  detail?: number
}

/** A tool returns true if it handled the event and the default behavior should be skipped. */
export type ToolHandler = {
  onPointerDown?: (e: PointerEvt, ctx: ToolCtx) => boolean | void
  onPointerMove?: (e: PointerEvt, ctx: ToolCtx) => boolean | void
  onPointerUp?:   (e: PointerEvt, ctx: ToolCtx) => boolean | void
  onCancel?:      (ctx: ToolCtx) => void
}

export type ToolCtx = {
  setPointerCapture: (id: number) => void
  releasePointerCapture: (id: number) => void
  pointerId: number
}
