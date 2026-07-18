import { proxy } from 'valtio/vanilla'
import type {
  AvatarCollisionMode,
  ClothSimQuality,
  ClothingTransformMode,
  GarmentDocument,
  ClothingTool,
  PatternPlacement,
  Vec2,
} from './clothingTypes'
import type { CollisionRegion } from '../simulation/types'

// ---------------------------------------------------------------------------
// Clothing feature state
// ---------------------------------------------------------------------------

type Viewport2DState = {
  zoom: number
  panX: number
  panY: number
  hoveredEntityId: string | null
  hoveredEntityType: 'point' | 'edge' | 'pattern' | 'seam' | null
}

type PreviewOptions3D = {
  orbitControlsEnabled: boolean
  showWireframe: boolean
  showSeams: boolean
  showTriangulation: boolean
  showCollisionProxies: boolean
  showCollisionCapsules: boolean
  showCollisionEllipsoids: boolean
  showCollisionLowResMesh: boolean
}

type DirtyFlags = {
  triangulationDirty: boolean
  previewDirty: boolean
}

/** A draft shape currently being drawn (rect/ellipse rubber-band, polygon/pen vertices). */
export type DrawDraft =
  | { kind: 'rect'; start: Vec2; current: Vec2 }
  | { kind: 'ellipse'; start: Vec2; current: Vec2 }
  | { kind: 'circle'; center: Vec2; current: Vec2 }
  | { kind: 'polygon'; points: Vec2[]; current: Vec2 }
  | { kind: 'pen'; points: Vec2[]; current: Vec2 }

/** History entry: a serialized garment document snapshot. */
type HistoryEntry = {
  garment: GarmentDocument
}

type HistoryState = {
  past: HistoryEntry[]
  future: HistoryEntry[]
}

type ClothingState = {
  activeClothingTool: ClothingTool
  garment: GarmentDocument
  viewport2D: Viewport2DState
  previewOptions: PreviewOptions3D
  dirty: DirtyFlags
  simRunning: boolean
  simResetKey: number
  simQuality: ClothSimQuality
  transformMode: ClothingTransformMode
  collisionAvatar: {
    buildRequestId: number
    generatedAt: number | null
    proxyCount: number
    meshPatchCount: number
    sourceVertexCount: number
    meshColliderVertexCount: number
    meshColliderTriangleCount: number
    spatialHashCellCount: number
    globalInflate: number
    normalOffset: number
    perRegionInflate: Partial<Record<CollisionRegion, number>>
    mode: AvatarCollisionMode
    skinOffset: number
    garmentThickness: number
    bodyFriction: number
    meshCellSize: number
    meshSampleStride: number
    enableVertexTriangle: boolean
    enableEdgeEdge: boolean
    debugPerf: boolean
  }
  placements: Record<string, PatternPlacement>
  draft: DrawDraft | null
  history: HistoryState
  // Multi-selection of pattern ids (for transform gizmo & deletion).
  selectedPatternIds: string[]
}

const EMPTY_GARMENT: GarmentDocument = {
  id: 'empty',
  name: 'Untitled',
  patterns: {},
  seams: {},
  tacks: {},
}

export const clothingStore = proxy<ClothingState>({
  activeClothingTool: 'select',
  garment: EMPTY_GARMENT,
  viewport2D: {
    zoom: 1,
    panX: 0,
    panY: 0,
    hoveredEntityId: null,
    hoveredEntityType: null,
  },
  previewOptions: {
    orbitControlsEnabled: true,
    showWireframe: false,
    showSeams: true,
    showTriangulation: false,
    showCollisionProxies: false,
    showCollisionCapsules: true,
    showCollisionEllipsoids: true,
    showCollisionLowResMesh: false,
  },
  dirty: {
    triangulationDirty: false,
    previewDirty: false,
  },
  simRunning: false,
  simResetKey: 0,
  simQuality: 'high',
  transformMode: 'translate',
  collisionAvatar: {
    buildRequestId: 0,
    generatedAt: null,
    proxyCount: 0,
    meshPatchCount: 0,
    sourceVertexCount: 0,
    meshColliderVertexCount: 0,
    meshColliderTriangleCount: 0,
    spatialHashCellCount: 0,
    globalInflate: 0.018,
    normalOffset: 0,
    perRegionInflate: {},
    mode: 'authoring',
    skinOffset: 0.022,
    garmentThickness: 0.008,
    bodyFriction: 0.74,
    meshCellSize: 0.09,
    meshSampleStride: 1,
    enableVertexTriangle: true,
    enableEdgeEdge: false,
    debugPerf: false,
  },
  placements: {},
  draft: null,
  history: { past: [], future: [] },
  selectedPatternIds: [],
})
