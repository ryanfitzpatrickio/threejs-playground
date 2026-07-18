import { clothingStore } from '../../../state/clothingStore'
import { createTack, selectPattern } from '../../../state/clothingActions'
import { pickAt } from '../../PatternPicker'
import type { ToolHandler, PointerEvt } from '../types'
import type { Vec2 } from '../../../state/clothingTypes'

// ---------------------------------------------------------------------------
// Tack tool
// MD-style surface-to-surface tacking: click anywhere on a panel (not just
// at an explicit vertex) to set an anchor.  The compiler resolves the anchor
// to the nearest simulation particle at compile time.
//
// Two-click workflow:
//   1st click on any panel → stores pending anchor (patternId + 2D position)
//   2nd click on a different panel → creates a tack constraint
// Escape / tool-switch cancels.
// ---------------------------------------------------------------------------

type PendingTack = { patternId: string; world: Vec2 }
let pending: PendingTack | null = null

function patternIdAt(e: PointerEvt): string | null {
  const pick = pickAt(clothingStore.garment, e.world, e.zoom)
  if (!pick) return null
  // Accept any hit on a panel — fill, edge, or vertex all count as surface
  return pick.patternId ?? null
}

export const tackTool: ToolHandler = {
  onPointerDown(e: PointerEvt) {
    if (e.button !== 0) return
    const patternId = patternIdAt(e)
    if (!patternId) return

    if (!pending) {
      pending = { patternId, world: { x: e.world.x, y: e.world.y } }
      selectPattern(patternId)
    } else {
      // Clicking the same panel twice → cancel
      if (pending.patternId === patternId
        && Math.hypot(pending.world.x - e.world.x, pending.world.y - e.world.y) < 5) {
        pending = null
        return true
      }
      createTack(
        pending.patternId, pending.world.x, pending.world.y,
        patternId, e.world.x, e.world.y,
      )
      pending = null
      selectPattern(patternId)
    }
    return true
  },

  onCancel() {
    pending = null
  },
}

/** Expose pending state so the renderer can highlight the pending anchor. */
export function getTackPending() { return pending }
