import type { PatternDocument } from '../document/types'
import type { CompilerOptions } from './types'
import { buildRenderEmbedding } from './buildRenderEmbedding'
import { compileGarmentTopology } from './compileGarmentTopology'
import { validatePatternDocument } from './validatePatternDocument'

export function compileGarmentRuntime(document: PatternDocument, options: CompilerOptions) {
  const issues = validatePatternDocument(document)
  const topology = compileGarmentTopology(document, options)
  const embedding = buildRenderEmbedding(document, topology)
  return {
    value: {
      document,
      simMesh: topology.simMesh,
      renderPanels: embedding.renderPanels,
      panelInfo: topology.panelInfo,
    },
    issues,
  }
}