import type { PatternDocument } from '../document/types'
import type { ClothSimMesh } from '../simulation/types'
import type { CompilerOptions } from './types'
import { buildConstraintGraph } from './buildConstraintGraph'
import { buildPanelSimMesh } from './buildPanelSimMesh'

export function compileGarmentTopology(document: PatternDocument, options: CompilerOptions) {
  let particleOffset = 0
  const panels = Object.fromEntries(
    Object.values(document.panels).map((panel) => {
      const compiled = buildPanelSimMesh(panel, options, particleOffset)
      particleOffset += compiled.panelInfo.particleIndices.length
      return [panel.id, compiled]
    }),
  )

  const positions = new Float32Array(flatten(Object.values(panels).flatMap((panel) => panel.positions)))
  const prevPositions = new Float32Array(positions)
  const velocities = new Float32Array(positions.length)
  const invMass = new Float32Array(flatten(Object.values(panels).flatMap((panel) => panel.invMass)))
  const particleFrictions = new Float32Array(flatten(Object.values(panels).flatMap((panel) => panel.particleFrictions)))
  const panelUvs = new Float32Array(flatten(Object.values(panels).flatMap((panel) => panel.panelUvs)))
  const panelLocalPositions = new Float32Array(flatten(Object.values(panels).flatMap((panel) => panel.panelLocalPositions)))
  const triangles = new Uint32Array(flatten(Object.values(panels).flatMap((panel) => Array.from(panel.panelInfo.triangleIndices))))

  const simMesh: ClothSimMesh = {
    particleCount: positions.length / 3,
    positions,
    prevPositions,
    velocities,
    invMass,
    panelIds: Object.values(panels).flatMap((panel) => panel.panelIds),
    particleFrictions,
    panelUvs,
    panelLocalPositions,
    triangles,
    stretchConstraints: Object.values(panels).flatMap((panel) => panel.stretchConstraints),
    shearConstraints: Object.values(panels).flatMap((panel) => panel.shearConstraints),
    bendDistanceConstraints: Object.values(panels).flatMap((panel) => panel.bendDistanceConstraints),
    bendConstraints: Object.values(panels).flatMap((panel) => panel.bendConstraints),
    seamConstraints: [],
    pinConstraints: Object.values(panels).flatMap((panel) => panel.pinConstraints),
  }

  buildConstraintGraph(document, simMesh, panels, options)

  return {
    document,
    simMesh,
    panelInfo: Object.fromEntries(Object.values(panels).map((panel) => [panel.panelInfo.panelId, panel.panelInfo])),
  }
}

function flatten(values: number[]) {
  return values
}
