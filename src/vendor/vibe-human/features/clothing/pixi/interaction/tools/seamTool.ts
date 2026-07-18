import { clothingStore } from '../../../state/clothingStore'
import { createSeam, selectEdge, selectPattern } from '../../../state/clothingActions'
import { pickAt } from '../../PatternPicker'
import type { ToolHandler } from '../types'

let pending: { patternId: string; edgeId: string } | null = null

export const seamTool: ToolHandler = {
  onPointerDown(e) {
    if (e.button !== 0) return
    const pick = pickAt(clothingStore.garment, e.world, e.zoom)
    if (pick?.type !== 'edge') return
    if (!pending) {
      pending = { patternId: pick.patternId, edgeId: pick.edgeId }
      selectPattern(pick.patternId)
      selectEdge(pick.edgeId)
    } else {
      createSeam(pending.patternId, pending.edgeId, pick.patternId, pick.edgeId)
      pending = null
      selectPattern(pick.patternId)
      selectEdge(pick.edgeId)
    }
    return true
  },
  onCancel() { pending = null },
}
