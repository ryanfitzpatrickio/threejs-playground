import { clothingStore } from './clothingStore'
import type { GarmentDocument } from './clothingTypes'

const MAX_HISTORY = 80

function clone(doc: GarmentDocument): GarmentDocument {
  // Valtio proxies can't be passed to structuredClone — JSON round-trip
  // unwraps the proxy and gives us a plain object we can safely keep.
  return JSON.parse(JSON.stringify(doc))
}

/** Push the current garment state onto the undo stack. Call BEFORE a mutation. */
export function pushHistory() {
  clothingStore.history.past.push({ garment: clone(clothingStore.garment) })
  if (clothingStore.history.past.length > MAX_HISTORY) {
    clothingStore.history.past.shift()
  }
  clothingStore.history.future.length = 0
}

export function undo() {
  const entry = clothingStore.history.past.pop()
  if (!entry) return
  clothingStore.history.future.push({ garment: clone(clothingStore.garment) })
  clothingStore.garment = entry.garment
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

export function redo() {
  const entry = clothingStore.history.future.pop()
  if (!entry) return
  clothingStore.history.past.push({ garment: clone(clothingStore.garment) })
  clothingStore.garment = entry.garment
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

export function canUndo() {
  return clothingStore.history.past.length > 0
}

export function canRedo() {
  return clothingStore.history.future.length > 0
}
