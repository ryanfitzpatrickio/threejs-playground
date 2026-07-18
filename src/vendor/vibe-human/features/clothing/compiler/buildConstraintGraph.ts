import type { PatternDocument } from '../document/types'
import type { ClothSimMesh } from '../simulation/types'
import type { CompilerOptions } from './types'
import { buildSeamConstraints } from './buildSeamConstraints'
import { buildTackConstraints } from './buildTackConstraints'
import type { CompiledPanelSimMesh } from './buildPanelSimMesh'

export function buildConstraintGraph(
  document: PatternDocument,
  simMesh: ClothSimMesh,
  panels: Record<string, CompiledPanelSimMesh>,
  options: CompilerOptions,
) {
  simMesh.seamConstraints = [
    ...buildSeamConstraints(document, panels, options.seamSamples ?? 12),
    ...buildTackConstraints(document, panels),
  ]
  return simMesh
}