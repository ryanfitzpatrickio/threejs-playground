import type { PatternDocument, PatternPanel } from '../document/types'
import type { DistanceConstraint } from '../simulation/types'
import type { CompiledPanelSimMesh } from './buildPanelSimMesh'
import { resolveSeamSamples, placePt } from '../geometry/seamUtils'
import type { Vec2 } from '../state/clothingTypes'

export function buildSeamConstraints(
  document: PatternDocument,
  panels: Record<string, CompiledPanelSimMesh>,
  seamSamples: number,
): DistanceConstraint[] {
  const constraints: DistanceConstraint[] = []

  for (const seam of Object.values(document.seams)) {
    const panelA = document.panels[seam.a.panelId]
    const panelB = document.panels[seam.b.panelId]
    const meshA = panels[seam.a.panelId]
    const meshB = panels[seam.b.panelId]
    if (!panelA || !panelB || !meshA || !meshB) continue

    const resolved = resolveSeamSamples(document, seam, seamSamples)
    if (!resolved) continue
    const pointsA = resolved.pointsA
    const pointsB = resolved.pointsB
    const edgeParticlesA = orderedEdgeParticles(panelA, meshA, pointsA)
    const edgeParticlesB = orderedEdgeParticles(panelB, meshB, pointsB)
    const count = Math.max(edgeParticlesA.length, edgeParticlesB.length)
    const seen = new Set<string>()

    if (edgeParticlesA.length >= 2 && edgeParticlesB.length >= 2 && count >= 2) {
      for (let index = 0; index < count; index += 1) {
        const aIsLonger = edgeParticlesA.length >= edgeParticlesB.length
        const particleA = aIsLonger
          ? sampleOrderedParticle(edgeParticlesA, index, count)
          : sampleOrderedParticle(edgeParticlesA, index, Math.max(2, edgeParticlesA.length))
        const particleB = aIsLonger
          ? sampleOrderedParticle(edgeParticlesB, index, Math.max(2, edgeParticlesB.length))
          : sampleOrderedParticle(edgeParticlesB, index, count)
        if (particleA < 0 || particleB < 0 || particleA === particleB) continue
        const key = particleA < particleB ? `${particleA}:${particleB}` : `${particleB}:${particleA}`
        if (seen.has(key)) continue
        const rest = particleDistance(meshA, particleA, meshB, particleB)
        // Conforming meshes place real particles on the outline, so two paired
        // edge particles can already be coincident (shared corner). They need no
        // seam constraint — skip degenerate near-zero pairs.
        if (rest <= 1e-6) continue
        seen.add(key)
        constraints.push({
          a: particleA,
          b: particleB,
          rest,
          targetRest: 0,
          compliance: 0.00002 + (1 - seam.strength) * 0.0003,
          kind: 'seam',
        })
      }
      continue
    }

    const fallbackCount = Math.max(pointsA.length, pointsB.length)
    for (let index = 0; index < fallbackCount; index += 1) {
      const sampleA = pointsA[Math.round((index / Math.max(1, fallbackCount - 1)) * Math.max(0, pointsA.length - 1))]
      const sampleB = pointsB[Math.round((index / Math.max(1, fallbackCount - 1)) * Math.max(0, pointsB.length - 1))]
      const particleA = nearestParticle(meshA, sampleA.x, sampleA.y)
      const particleB = nearestParticle(meshB, sampleB.x, sampleB.y)
      if (particleA < 0 || particleB < 0 || particleA === particleB) continue
      const key = particleA < particleB ? `${particleA}:${particleB}` : `${particleB}:${particleA}`
      if (seen.has(key)) continue
      const rest = particleDistance(meshA, particleA, meshB, particleB)
      if (rest <= 1e-6) continue
      seen.add(key)
      constraints.push({
        a: particleA,
        b: particleB,
        rest,
        targetRest: 0,
        compliance: 0.00002 + (1 - seam.strength) * 0.0003,
        kind: 'seam',
      })
    }
  }

  return constraints
}

function orderedEdgeParticles(
  panel: PatternDocument['panels'][string],
  mesh: CompiledPanelSimMesh,
  edgePoints: Array<{ x: number; y: number }>,
) {
  if (edgePoints.length < 2 || mesh.panelInfo.particleIndices.length === 0) return []
  const toleranceSq = Math.max(36, (panel.particleDistance * 0.75) ** 2)
  const matches: Array<{ particle: number; t: number; distSq: number }> = []

  for (let localIndex = 0; localIndex < mesh.panelInfo.particleIndices.length; localIndex += 1) {
    const projection = projectPointToPolyline(
      edgePoints,
      mesh.panelLocalPositions[localIndex * 2],
      mesh.panelLocalPositions[localIndex * 2 + 1],
    )
    if (!projection || projection.distSq > toleranceSq) continue
    matches.push({
      particle: mesh.panelInfo.particleIndices[localIndex],
      t: projection.t,
      distSq: projection.distSq,
    })
  }

  matches.sort((a, b) => a.t - b.t || a.distSq - b.distSq)
  return matches.map((match) => match.particle)
}

function sampleOrderedParticle(sequence: number[], index: number, count: number) {
  if (!sequence.length) return -1
  if (count <= 1 || sequence.length === 1) return sequence[0]
  return sequence[Math.round((index / (count - 1)) * (sequence.length - 1))]
}

function projectPointToPolyline(points: Array<{ x: number; y: number }>, x: number, y: number) {
  if (points.length < 2) return null
  let bestDistSq = Infinity
  let bestT = 0
  let total = 0
  let traversed = 0
  const lengths = new Array<number>(points.length - 1).fill(0)

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    lengths[index] = length
    total += length
  }
  if (total <= 1e-6) return null

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    const segX = end.x - start.x
    const segY = end.y - start.y
    const segLenSq = segX * segX + segY * segY
    const u = segLenSq <= 1e-9
      ? 0
      : clamp01(((x - start.x) * segX + (y - start.y) * segY) / segLenSq)
    const closestX = start.x + segX * u
    const closestY = start.y + segY * u
    const dx = x - closestX
    const dy = y - closestY
    const distSq = dx * dx + dy * dy
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestT = (traversed + lengths[index] * u) / total
    }
    traversed += lengths[index]
  }

  return { t: bestT, distSq: bestDistSq }
}

function particleDistance(
  meshA: CompiledPanelSimMesh,
  particleA: number,
  meshB: CompiledPanelSimMesh,
  particleB: number,
) {
  const ia = localParticleOffset(meshA, particleA)
  const ib = localParticleOffset(meshB, particleB)
  if (ia < 0 || ib < 0) return 0
  const ax = meshA.positions[ia]
  const ay = meshA.positions[ia + 1]
  const az = meshA.positions[ia + 2]
  const bx = meshB.positions[ib]
  const by = meshB.positions[ib + 1]
  const bz = meshB.positions[ib + 2]
  return Math.hypot(bx - ax, by - ay, bz - az)
}

function localParticleOffset(mesh: CompiledPanelSimMesh, particle: number) {
  const first = mesh.panelInfo.particleIndices[0]
  if (first === undefined) return -1
  const localParticle = particle - first
  const offset = localParticle * 3
  return offset >= 0 && offset + 2 < mesh.positions.length ? offset : -1
}

function nearestParticle(
  mesh: CompiledPanelSimMesh,
  x: number,
  y: number,
) {
  let best = -1
  let bestDist = Infinity
  for (let localIndex = 0; localIndex < mesh.panelInfo.particleIndices.length; localIndex += 1) {
    const dx = mesh.panelLocalPositions[localIndex * 2] - x
    const dy = mesh.panelLocalPositions[localIndex * 2 + 1] - y
    const dist = dx * dx + dy * dy
    if (dist < bestDist) {
      bestDist = dist
      best = mesh.panelInfo.particleIndices[localIndex]
    }
  }
  return best
}


function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

// ---------------------------------------------------------------------------
// Orient seam samples using 3D world-space endpoint cost.
// This correctly handles cases where both panels share identical 2D pattern
// coordinates but have different 3D placements (e.g., front/back of a T-shirt).
// ---------------------------------------------------------------------------

export function orientSeamSamples(
  panelA: PatternPanel,
  pointsA: Vec2[],
  panelB: PatternPanel,
  pointsB: Vec2[],
): Vec2[] {
  if (pointsA.length < 2 || pointsB.length < 2) return pointsB
  const n = Math.min(pointsA.length, pointsB.length)
  let forwardCost = 0
  let reversedCost = 0
  for (let i = 0; i < n; i += 1) {
    const a3 = placePt(panelA, pointsA[i])
    const bfwd = placePt(panelB, pointsB[i])
    const brev = placePt(panelB, pointsB[n - 1 - i])
    forwardCost += (a3.x - bfwd.x) ** 2 + (a3.y - bfwd.y) ** 2 + (a3.z - bfwd.z) ** 2
    reversedCost += (a3.x - brev.x) ** 2 + (a3.y - brev.y) ** 2 + (a3.z - brev.z) ** 2
  }
  return reversedCost + 1e-8 < forwardCost ? [...pointsB].reverse() : pointsB
}
