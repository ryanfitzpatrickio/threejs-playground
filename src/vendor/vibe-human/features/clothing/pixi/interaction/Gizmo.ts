import type { BBox, GizmoHandle, Vec2 } from '../../state/clothingTypes'

const HANDLE_PX = 8
const ROTATE_OFFSET_PX = 22

export type GizmoHit = { handle: GizmoHandle } | null

/**
 * Hit-test the transform gizmo around a world-space bounding box.
 * `worldPt` and the bbox are in world space; `zoom` lets us reason in screen px.
 */
export function hitTestGizmo(worldPt: Vec2, bbox: BBox, zoom: number): GizmoHit {
  const sizeWorld = HANDLE_PX / zoom
  const offsetWorld = ROTATE_OFFSET_PX / zoom
  const cx = (bbox.minX + bbox.maxX) / 2
  const cy = (bbox.minY + bbox.maxY) / 2

  type H = { handle: GizmoHandle; x: number; y: number }
  const handles: H[] = [
    { handle: 'nw', x: bbox.minX, y: bbox.minY },
    { handle: 'n',  x: cx,        y: bbox.minY },
    { handle: 'ne', x: bbox.maxX, y: bbox.minY },
    { handle: 'e',  x: bbox.maxX, y: cy        },
    { handle: 'se', x: bbox.maxX, y: bbox.maxY },
    { handle: 's',  x: cx,        y: bbox.maxY },
    { handle: 'sw', x: bbox.minX, y: bbox.maxY },
    { handle: 'w',  x: bbox.minX, y: cy        },
  ]

  for (const h of handles) {
    if (Math.abs(worldPt.x - h.x) <= sizeWorld && Math.abs(worldPt.y - h.y) <= sizeWorld) {
      return { handle: h.handle }
    }
  }

  // Rotate handle sits above the top-center
  const rx = cx
  const ry = bbox.minY - offsetWorld
  if (Math.hypot(worldPt.x - rx, worldPt.y - ry) <= sizeWorld) {
    return { handle: 'rotate' }
  }

  // Move = anywhere inside the bbox (the body handles this)
  if (
    worldPt.x >= bbox.minX && worldPt.x <= bbox.maxX &&
    worldPt.y >= bbox.minY && worldPt.y <= bbox.maxY
  ) {
    return { handle: 'move' }
  }

  return null
}

export function bboxCenter(b: BBox): Vec2 {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

export const GIZMO_VISUAL = {
  handlePx: HANDLE_PX,
  rotateOffsetPx: ROTATE_OFFSET_PX,
}
