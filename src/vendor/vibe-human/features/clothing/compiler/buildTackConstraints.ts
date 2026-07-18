import type { PatternDocument } from '../document/types'
import type { DistanceConstraint } from '../simulation/types'
import type { CompiledPanelSimMesh } from './buildPanelSimMesh'

// ---------------------------------------------------------------------------
// buildTackConstraints
// Converts Tack anchors (2D pattern-space coordinates) into weld-style
// distance constraints by snapping each anchor to the nearest simulation
// particle on its panel.  The resulting constraints are appended to
// seamConstraints so the existing XPBD solver handles them without changes.
// ---------------------------------------------------------------------------

export function buildTackConstraints(
  document: PatternDocument,
  panels: Record<string, CompiledPanelSimMesh>,
): DistanceConstraint[] {
  const constraints: DistanceConstraint[] = []
  const seen = new Set<string>()

  for (const tack of Object.values(document.tacks ?? {})) {
    const meshA = panels[tack.a.panelId]
    const meshB = panels[tack.b.panelId]
    if (!meshA || !meshB) continue

    const particleA = nearestParticle(meshA, tack.a.x, tack.a.y)
    const particleB = nearestParticle(meshB, tack.b.x, tack.b.y)
    if (particleA < 0 || particleB < 0 || particleA === particleB) continue

    const key = particleA < particleB
      ? `${particleA}:${particleB}`
      : `${particleB}:${particleA}`
    if (seen.has(key)) continue
    seen.add(key)

    const rest = particleDistance(meshA, particleA, meshB, particleB)
    // Skip if particles are already coincident (degenerate constraint)
    if (rest <= 1e-6) continue

    constraints.push({
      a: particleA,
      b: particleB,
      rest,
      targetRest: 0,
      compliance: 0.00002 + (1 - tack.strength) * 0.0003,
      kind: 'seam',
    })
  }

  return constraints
}

// ---------------------------------------------------------------------------
// Helpers (mirrors of the private helpers in buildSeamConstraints.ts)
// ---------------------------------------------------------------------------

function nearestParticle(mesh: CompiledPanelSimMesh, x: number, y: number): number {
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < mesh.panelInfo.particleIndices.length; i++) {
    const dx = mesh.panelLocalPositions[i * 2] - x
    const dy = mesh.panelLocalPositions[i * 2 + 1] - y
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      bestDist = dist
      best = mesh.panelInfo.particleIndices[i]
    }
  }
  return best
}

function localParticleOffset(mesh: CompiledPanelSimMesh, particle: number): number {
  const first = mesh.panelInfo.particleIndices[0]
  if (first === undefined) return -1
  const local = particle - first
  const offset = local * 3
  return offset >= 0 && offset + 2 < mesh.positions.length ? offset : -1
}

function particleDistance(
  meshA: CompiledPanelSimMesh,
  particleA: number,
  meshB: CompiledPanelSimMesh,
  particleB: number,
): number {
  const ia = localParticleOffset(meshA, particleA)
  const ib = localParticleOffset(meshB, particleB)
  if (ia < 0 || ib < 0) return 0
  return Math.hypot(
    meshB.positions[ib]     - meshA.positions[ia],
    meshB.positions[ib + 1] - meshA.positions[ia + 1],
    meshB.positions[ib + 2] - meshA.positions[ia + 2],
  )
}
