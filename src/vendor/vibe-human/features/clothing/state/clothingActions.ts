import { nanoid } from '../../../utils/nanoid'
import { DEMO_GARMENT_PLACEMENTS } from '../demo/createDemoGarment'
import { clothingStore } from './clothingStore'
import { pushHistory } from './historyActions'
import { setSelectedPatterns } from './transformActions'
import type {
  AvatarCollisionMode,
  ClothSimQuality,
  ClothingTool,
  ClothingTransformMode,
  GarmentDocument,
  PatternPiece,
  PatternPlacement,
  Seam,
  Tack,
} from './clothingTypes'
import type { CollisionRegion } from '../simulation/types'

const uid = () => nanoid(8)

// ---------------------------------------------------------------------------
// Re-export submodules so existing imports keep working
// ---------------------------------------------------------------------------

export * from './historyActions'
export * from './shapeActions'
export * from './pointActions'
export * from './transformActions'

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

export function setActiveClothingTool(tool: ClothingTool) {
  if (clothingStore.activeClothingTool === tool) return
  clothingStore.activeClothingTool = tool
  // Switching tools cancels any in-progress draft
  clothingStore.draft = null
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectPattern(id: string | undefined) {
  clothingStore.garment.selectedPatternId = id
  clothingStore.garment.selectedPointId = undefined
  clothingStore.garment.selectedEdgeId = undefined
  clothingStore.selectedPatternIds = id ? [id] : []
}

export function selectPoint(id: string | undefined) {
  clothingStore.garment.selectedPointId = id
}

export function selectEdge(id: string | undefined) {
  clothingStore.garment.selectedEdgeId = id
}

export function clearSelection() {
  clothingStore.garment.selectedPatternId = undefined
  clothingStore.garment.selectedPointId = undefined
  clothingStore.garment.selectedEdgeId = undefined
  clothingStore.garment.selectedSeamId = undefined
  clothingStore.selectedPatternIds = []
}

export { setSelectedPatterns }

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export function createSeam(
  patternIdA: string,
  edgeIdA: string,
  patternIdB: string,
  edgeIdB: string,
): string {
  if (patternIdA === patternIdB && edgeIdA === edgeIdB) return ''

  const patternA = clothingStore.garment.patterns[patternIdA]
  const patternB = clothingStore.garment.patterns[patternIdB]
  const edgeA = patternA?.edges.find((edge) => edge.id === edgeIdA)
  const edgeB = patternB?.edges.find((edge) => edge.id === edgeIdB)
  if (!patternA || !patternB || !edgeA || !edgeB) return ''

  const existing = findExistingSeam(patternIdA, edgeIdA, patternIdB, edgeIdB)
  if (existing) {
    clothingStore.garment.selectedSeamId = existing.id
    return existing.id
  }

  pushHistory()
  const id = uid()
  const seam: Seam = {
    id,
    name: `Seam ${Object.keys(clothingStore.garment.seams).length + 1}`,
    a: { patternId: patternIdA, edgeId: edgeIdA },
    b: { patternId: patternIdB, edgeId: edgeIdB, reversed: inferSeamReversal(patternA, edgeA, patternB, edgeB) || undefined },
    strength: 1,
  }
  clothingStore.garment.seams[id] = seam
  clothingStore.garment.selectedSeamId = id
  markPreviewDirty()
  return id
}

export function deleteSeam(seamId: string) {
  if (!clothingStore.garment.seams[seamId]) return
  pushHistory()
  delete clothingStore.garment.seams[seamId]
  if (clothingStore.garment.selectedSeamId === seamId) {
    clothingStore.garment.selectedSeamId = undefined
  }
  markPreviewDirty()
}

// ---------------------------------------------------------------------------
// Tacks (point-to-point constraints)
// ---------------------------------------------------------------------------

export function createTack(
  patternIdA: string,
  xA: number,
  yA: number,
  patternIdB: string,
  xB: number,
  yB: number,
): string {
  if (patternIdA === patternIdB && xA === xB && yA === yB) return ''
  const patternA = clothingStore.garment.patterns[patternIdA]
  const patternB = clothingStore.garment.patterns[patternIdB]
  if (!patternA || !patternB) return ''

  // Prevent near-duplicate tacks (within 5 pattern units of each anchor)
  const DUPE_TOL_SQ = 25
  const existing = Object.values(clothingStore.garment.tacks).find((t) => {
    const sameDir = t.a.patternId === patternIdA
      && (t.a.x - xA) ** 2 + (t.a.y - yA) ** 2 < DUPE_TOL_SQ
      && t.b.patternId === patternIdB
      && (t.b.x - xB) ** 2 + (t.b.y - yB) ** 2 < DUPE_TOL_SQ
    const revDir = t.a.patternId === patternIdB
      && (t.a.x - xB) ** 2 + (t.a.y - yB) ** 2 < DUPE_TOL_SQ
      && t.b.patternId === patternIdA
      && (t.b.x - xA) ** 2 + (t.b.y - yA) ** 2 < DUPE_TOL_SQ
    return sameDir || revDir
  })
  if (existing) {
    clothingStore.garment.selectedTackId = existing.id
    return existing.id
  }

  pushHistory()
  const id = uid()
  const tack: Tack = {
    id,
    a: { patternId: patternIdA, x: xA, y: yA },
    b: { patternId: patternIdB, x: xB, y: yB },
    strength: 1,
  }
  clothingStore.garment.tacks[id] = tack
  clothingStore.garment.selectedTackId = id
  markPreviewDirty()
  return id
}

export function deleteTack(tackId: string) {
  if (!clothingStore.garment.tacks[tackId]) return
  pushHistory()
  delete clothingStore.garment.tacks[tackId]
  if (clothingStore.garment.selectedTackId === tackId) {
    clothingStore.garment.selectedTackId = undefined
  }
  markPreviewDirty()
}

function findExistingSeam(
  patternIdA: string,
  edgeIdA: string,
  patternIdB: string,
  edgeIdB: string,
) {
  return Object.values(clothingStore.garment.seams).find((seam) => (
    (seam.a.patternId === patternIdA
      && seam.a.edgeId === edgeIdA
      && seam.b.patternId === patternIdB
      && seam.b.edgeId === edgeIdB)
    ||
    (seam.a.patternId === patternIdB
      && seam.a.edgeId === edgeIdB
      && seam.b.patternId === patternIdA
      && seam.b.edgeId === edgeIdA)
  ))
}

function inferSeamReversal(
  patternA: PatternPiece,
  edgeA: PatternPiece['edges'][number],
  patternB: PatternPiece,
  edgeB: PatternPiece['edges'][number],
) {
  const aFrom = patternA.points[edgeA.from]
  const aTo = patternA.points[edgeA.to]
  const bFrom = patternB.points[edgeB.from]
  const bTo = patternB.points[edgeB.to]
  if (!aFrom || !aTo || !bFrom || !bTo) return false

  const avx = aTo.x - aFrom.x
  const avy = aTo.y - aFrom.y
  const bvx = bTo.x - bFrom.x
  const bvy = bTo.y - bFrom.y
  const aLen = Math.hypot(avx, avy)
  const bLen = Math.hypot(bvx, bvy)

  if (aLen > 1e-6 && bLen > 1e-6) {
    return (avx * bvx + avy * bvy) / (aLen * bLen) < 0
  }

  const directCost = squaredDistance(aFrom.x, aFrom.y, bFrom.x, bFrom.y) + squaredDistance(aTo.x, aTo.y, bTo.x, bTo.y)
  const reversedCost = squaredDistance(aFrom.x, aFrom.y, bTo.x, bTo.y) + squaredDistance(aTo.x, aTo.y, bFrom.x, bFrom.y)
  return reversedCost < directCost
}

function squaredDistance(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

// ---------------------------------------------------------------------------
// Boolean: punch a hole in target using cutter outline.
// History is pushed so this is properly undoable / revertible.
// ---------------------------------------------------------------------------

/**
 * Subtract the topmost selected piece from the others. The last item in
 * `clothingStore.selectedPatternIds` is treated as the cutter; all earlier
 * ids become targets. This is the only "blessed" entry point for boolean
 * subtract — explicit, predictable, and undoable.
 */
export function subtractTopFromSelection(): boolean {
  const ids = [...clothingStore.selectedPatternIds]
  if (ids.length < 2) return false
  const cutterId = ids[ids.length - 1]
  const targetIds = ids.slice(0, -1)
  const cutter = clothingStore.garment.patterns[cutterId]
  if (!cutter || !cutter.closed || cutter.edges.length < 3) return false

  pushHistory()
  for (const targetId of targetIds) {
    const target = clothingStore.garment.patterns[targetId]
    if (!target) continue
    for (const point of Object.values(cutter.points)) {
      target.points[point.id] = { ...point }
    }
    target.holes = target.holes ?? []
    target.holes.push(cutter.edges.map((edge) => ({ ...edge })))
  }
  delete clothingStore.garment.patterns[cutterId]
  clothingStore.selectedPatternIds = targetIds
  clothingStore.garment.selectedPatternId = targetIds[0]
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
  return true
}

export function makeHoleFromPattern(targetPatternId: string, cutterPatternId: string) {
  if (targetPatternId === cutterPatternId) return
  const target = clothingStore.garment.patterns[targetPatternId]
  const cutter = clothingStore.garment.patterns[cutterPatternId]
  if (!target || !cutter || !cutter.closed || cutter.edges.length < 3) return

  pushHistory()
  for (const point of Object.values(cutter.points)) {
    target.points[point.id] = { ...point }
  }
  target.holes = target.holes ?? []
  target.holes.push(cutter.edges.map((edge) => ({ ...edge })))

  delete clothingStore.garment.patterns[cutterPatternId]
  clothingStore.garment.selectedPatternId = targetPatternId
  clothingStore.garment.selectedPointId = undefined
  clothingStore.garment.selectedEdgeId = undefined
  clothingStore.selectedPatternIds = [targetPatternId]
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

export function setHoveredEntity(
  id: string | null,
  type: 'point' | 'edge' | 'pattern' | 'seam' | null,
) {
  clothingStore.viewport2D.hoveredEntityId = id
  clothingStore.viewport2D.hoveredEntityType = type
}

// ---------------------------------------------------------------------------
// Pattern piece blank create
// ---------------------------------------------------------------------------

export function createPatternPiece(): string {
  pushHistory()
  const id = uid()
  const piece: PatternPiece = {
    id,
    name: `Pattern ${Object.keys(clothingStore.garment.patterns).length + 1}`,
    points: {},
    edges: [],
    closed: false,
    particleDistance: 20,
    friction: 1,
  }
  clothingStore.garment.patterns[id] = piece
  return id
}

// ---------------------------------------------------------------------------
// Preview dirty flags
// ---------------------------------------------------------------------------

export function markPreviewDirty() {
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export function toggleSimRunning() {
  clothingStore.simRunning = !clothingStore.simRunning
}

export function stopSim() {
  clothingStore.simRunning = false
}

export function resetSim() {
  clothingStore.simResetKey += 1
  clothingStore.simRunning = false
}

export function setSimQuality(quality: ClothSimQuality) {
  if (clothingStore.simQuality === quality) return
  clothingStore.simQuality = quality
  // Quality changes spacing (resolution) + solver iterations. The simulation
  // reprojects the current drape onto the new grid and absorbs the iteration
  // change live — no reset, no forced pause.
}

export function setTransformMode(mode: ClothingTransformMode) {
  clothingStore.transformMode = mode
}

export function setPatternPlacement(patternId: string, placement: PatternPlacement) {
  clothingStore.placements[patternId] = placement
}

export function requestCollisionAvatarBuild() {
  clothingStore.collisionAvatar.buildRequestId += 1
}

export function setCollisionGlobalInflate(value: number) {
  clothingStore.collisionAvatar.globalInflate = Math.max(0, Math.min(0.12, value))
}

export function setCollisionNormalOffset(value: number) {
  clothingStore.collisionAvatar.normalOffset = Math.max(-0.04, Math.min(0.08, value))
}

export function setCollisionRegionInflate(region: CollisionRegion, value: number) {
  clothingStore.collisionAvatar.perRegionInflate[region] = Math.max(0, Math.min(0.12, value))
}

export function setAvatarCollisionMode(mode: AvatarCollisionMode) {
  clothingStore.collisionAvatar.mode = mode
}

export function setAvatarSkinOffset(value: number) {
  clothingStore.collisionAvatar.skinOffset = Math.max(0, Math.min(0.12, value))
}

export function setGarmentCollisionThickness(value: number) {
  clothingStore.collisionAvatar.garmentThickness = Math.max(0, Math.min(0.06, value))
}

export function setAvatarBodyFriction(value: number) {
  clothingStore.collisionAvatar.bodyFriction = Math.max(0, Math.min(5, value))
}

export function setAvatarMeshCellSize(value: number) {
  clothingStore.collisionAvatar.meshCellSize = Math.max(0.025, Math.min(0.3, value))
}

export function setCollisionAvatarStats(stats: {
  generatedAt: number
  proxyCount: number
  meshPatchCount: number
  sourceVertexCount: number
}) {
  clothingStore.collisionAvatar.generatedAt = stats.generatedAt
  clothingStore.collisionAvatar.proxyCount = stats.proxyCount
  clothingStore.collisionAvatar.meshPatchCount = stats.meshPatchCount
  clothingStore.collisionAvatar.sourceVertexCount = stats.sourceVertexCount
}

export function setCollisionRuntimeStats(stats: {
  meshColliderVertexCount: number
  meshColliderTriangleCount: number
  spatialHashCellCount: number
}) {
  if (
    clothingStore.collisionAvatar.meshColliderVertexCount === stats.meshColliderVertexCount &&
    clothingStore.collisionAvatar.meshColliderTriangleCount === stats.meshColliderTriangleCount &&
    clothingStore.collisionAvatar.spatialHashCellCount === stats.spatialHashCellCount
  ) return
  clothingStore.collisionAvatar.meshColliderVertexCount = stats.meshColliderVertexCount
  clothingStore.collisionAvatar.meshColliderTriangleCount = stats.meshColliderTriangleCount
  clothingStore.collisionAvatar.spatialHashCellCount = stats.spatialHashCellCount
}

/** Wipe placements for the given pieces (or all selected if none passed)
 *  so they fall back to defaultPlacement. Bumps the sim reset key so the
 *  solver re-spawns at the new (default) frame. */
export function resetPatternTransforms(patternIds?: string[]) {
  const ids = patternIds ?? [...clothingStore.selectedPatternIds]
  if (ids.length === 0) {
    for (const k of Object.keys(clothingStore.placements)) delete clothingStore.placements[k]
  } else {
    for (const id of ids) delete clothingStore.placements[id]
  }
  clothingStore.simResetKey += 1
  clothingStore.simRunning = false
}

// ---------------------------------------------------------------------------
// Document loading
// ---------------------------------------------------------------------------

export function loadDemoGarment(doc: GarmentDocument) {
  clothingStore.garment = doc
  clothingStore.placements = {}
  const patternIds = Object.keys(doc.patterns)
  if (patternIds.length === 1) {
    clothingStore.placements[patternIds[0]] = {
      position: { x: 0, y: -0.74, z: 0.3 },
      rotation: { x: 0, y: 0, z: 0 },
    }
  } else if (patternIds.length >= 2) {
    const frontId = patternIds.includes('torso-front') ? 'torso-front' : patternIds[0]
    const backId = patternIds.includes('torso-back') ? 'torso-back' : patternIds[1]
    clothingStore.placements[frontId] = structuredClone(DEMO_GARMENT_PLACEMENTS['torso-front'])
    clothingStore.placements[backId] = structuredClone(DEMO_GARMENT_PLACEMENTS['torso-back'])
  }
  clothingStore.viewport2D.zoom = 1.35
  clothingStore.viewport2D.panX = 0
  clothingStore.viewport2D.panY = 0
  clothingStore.viewport2D.hoveredEntityId = null
  clothingStore.viewport2D.hoveredEntityType = null
  clothingStore.history.past.length = 0
  clothingStore.history.future.length = 0
  clothingStore.selectedPatternIds = doc.selectedPatternId ? [doc.selectedPatternId] : []
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
}

// ---------------------------------------------------------------------------
// Legacy compatibility — previous code paths still use these names.
// They forward to the raw (no-history) helpers in pointActions.
// Callers wanting history must push it themselves before dragging.
// ---------------------------------------------------------------------------

export { movePointRaw as movePoint, moveHandleRaw as moveHandle } from './pointActions'

export function setRectanglePatternBounds(patternId: string, a: { x: number; y: number }, b: { x: number; y: number }) {
  void patternId
  void a
  void b
  // Retained for any external caller — no-op since rectangle drafting is now
  // handled by the draft system. The original use-case (live rubber-band
  // rectangle while drawing) is now drawn as a preview, not a committed piece.
}

// ---------------------------------------------------------------------------
// Garment file export / import
// ---------------------------------------------------------------------------

type GarmentFile = {
  version: 1
  garment: GarmentDocument
  placements: Record<string, PatternPlacement>
}

export function exportGarment() {
  const { garment, placements } = clothingStore
  const file: GarmentFile = {
    version: 1,
    garment: JSON.parse(JSON.stringify(garment)) as GarmentDocument,
    placements: JSON.parse(JSON.stringify(placements)) as Record<string, PatternPlacement>,
  }
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${garment.name.replace(/\s+/g, '_') || 'garment'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export function importGarment(file: GarmentFile) {
  if (file.version !== 1) throw new Error(`Unknown garment file version: ${file.version}`)
  clothingStore.garment = file.garment
  clothingStore.placements = file.placements ?? {}
  clothingStore.viewport2D.zoom = 1.35
  clothingStore.viewport2D.panX = 0
  clothingStore.viewport2D.panY = 0
  clothingStore.viewport2D.hoveredEntityId = null
  clothingStore.viewport2D.hoveredEntityType = null
  clothingStore.history.past.length = 0
  clothingStore.history.future.length = 0
  clothingStore.selectedPatternIds = file.garment.selectedPatternId ? [file.garment.selectedPatternId] : []
  clothingStore.dirty.previewDirty = true
  clothingStore.dirty.triangulationDirty = true
  clothingStore.simResetKey += 1
  clothingStore.simRunning = false
}
