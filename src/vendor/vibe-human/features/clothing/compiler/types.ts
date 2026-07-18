import type { PatternDocument, PatternPanel, Vec2 } from '../document/types'
import type { GarmentRuntime, PanelRuntimeInfo, RenderPanelRuntime } from '../simulation/types'

export type CompileQuality = 'low' | 'medium' | 'high' | 'ultra'

export type CompilerIssue = {
  code: string
  message: string
  severity: 'error' | 'warning'
}

export type CompilerResult<T> = {
  value: T
  issues: CompilerIssue[]
}

export type CompilerOptions = {
  quality: CompileQuality
  seamSamples?: number
}

export type PanelDiscretization = {
  panel: PatternPanel
  outline: Vec2[]
  holes: Vec2[][]
  bounds: { minX: number; minY: number; width: number; height: number }
}

export type GarmentTopology = {
  document: PatternDocument
  panelInfo: Record<string, PanelRuntimeInfo>
  simMesh: GarmentRuntime['simMesh']
}

export type RenderEmbeddingBuild = {
  renderPanels: RenderPanelRuntime[]
}