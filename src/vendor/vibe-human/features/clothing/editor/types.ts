import type { PatternDocument, Vec2 } from '../document/types'

export type ClothingTool =
  | 'select'
  | 'edit-points'
  | 'rect'
  | 'ellipse'
  | 'circle'
  | 'polygon'
  | 'pen'
  | 'seam'
  | 'pan'

export type EditorViewportState = {
  zoom: number
  panX: number
  panY: number
  hoveredEntityId: string | null
  hoveredEntityType: 'point' | 'edge' | 'pattern' | 'seam' | null
}

export type DrawDraft =
  | { kind: 'rect'; start: Vec2; current: Vec2 }
  | { kind: 'ellipse'; start: Vec2; current: Vec2 }
  | { kind: 'circle'; center: Vec2; current: Vec2 }
  | { kind: 'polygon'; points: Vec2[]; current: Vec2 }
  | { kind: 'pen'; points: Vec2[]; current: Vec2 }

export type EditorSelectionState = {
  selectedPatternId?: string
  selectedPointId?: string
  selectedEdgeId?: string
  selectedSeamId?: string
  selectedPatternIds: string[]
}

export type HistoryEntry = {
  garment: PatternDocument
}

export type EditorHistoryState = {
  past: HistoryEntry[]
  future: HistoryEntry[]
}

export type EditorState = {
  activeTool: ClothingTool
  viewport2D: EditorViewportState
  selection: EditorSelectionState
  history: EditorHistoryState
  draft: DrawDraft | null
}