import type { PatternDocument, PatternPanel, PatternPlacement, PatternTack, PanelPin } from './types'
import { DEMO_GARMENT_PLACEMENTS } from '../demo/createDemoGarment'
import type { GarmentDocument } from '../state/clothingTypes'

export function toPatternDocument(
  garment: GarmentDocument,
  placements: Record<string, PatternPlacement>,
): PatternDocument {
  const panels: Record<string, PatternPanel> = {}
  const pieces = Object.values(garment.patterns)

  const demoPlacements = buildDemoPlacementMap(pieces.map((piece) => piece.id))

  for (const piece of pieces) {
    panels[piece.id] = {
      ...JSON.parse(JSON.stringify(piece)),
      placement: clonePlacement(placements[piece.id] ?? demoPlacements[piece.id] ?? defaultPlacement()),
      pins: buildGluedEdgePins(piece),
      metadata: undefined,
    }
  }

  const seams = Object.fromEntries(
    Object.values(garment.seams).map((seam) => [
      seam.id,
      {
        ...JSON.parse(JSON.stringify(seam)),
        a: { panelId: seam.a.patternId, edgeId: seam.a.edgeId, reversed: seam.a.reversed },
        b: { panelId: seam.b.patternId, edgeId: seam.b.edgeId, reversed: seam.b.reversed },
      },
    ]),
  )

  const tacks: Record<string, PatternTack> = Object.fromEntries(
    Object.values(garment.tacks ?? {}).map((tack) => [
      tack.id,
      {
        id: tack.id,
        a: { panelId: tack.a.patternId, x: tack.a.x, y: tack.a.y },
        b: { panelId: tack.b.patternId, x: tack.b.x, y: tack.b.y },
        strength: tack.strength,
      },
    ]),
  )

  return {
    id: garment.id,
    name: garment.name,
    panels,
    seams,
    tacks,
  }
}

function clonePlacement(placement: PatternPlacement): PatternPlacement {
  return {
    position: { ...placement.position },
    rotation: { ...placement.rotation },
  }
}

function defaultPlacement(): PatternPlacement {
  return {
    position: { x: 0, y: 0.38, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  }
}

function buildDemoPlacementMap(panelIds: string[]): Record<string, PatternPlacement> {
  const result: Record<string, PatternPlacement> = {}
  if (panelIds.includes('torso-front')) result['torso-front'] = structuredClone(DEMO_GARMENT_PLACEMENTS['torso-front'])
  if (panelIds.includes('torso-back')) result['torso-back'] = structuredClone(DEMO_GARMENT_PLACEMENTS['torso-back'])
  if (panelIds.includes('left-panel')) result['left-panel'] = { position: { x: -0.16, y: 0.38, z: 0 }, rotation: { x: 0, y: -Math.PI / 2, z: 0 } }
  if (panelIds.includes('right-panel')) result['right-panel'] = { position: { x: 0.16, y: 0.38, z: 0 }, rotation: { x: 0, y: Math.PI / 2, z: 0 } }
  return result
}

function buildGluedEdgePins(piece: GarmentDocument['patterns'][string]): PanelPin[] | undefined {
  const glued = piece.gluedEdgeIds ?? []
  if (glued.length === 0) return undefined
  const bounds = boundsOf(piece)
  if (bounds.width <= 0 || bounds.height <= 0) return undefined
  const pins: PanelPin[] = []
  for (const edgeId of glued) {
    const edge = piece.edges.find((candidate) => candidate.id === edgeId)
    if (!edge) continue
    const a = piece.points[edge.from]
    const b = piece.points[edge.to]
    if (!a || !b) continue
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      pins.push({
        id: `${piece.id}-${edgeId}-${Math.round(t * 10)}`,
        u: (x - bounds.minX) / bounds.width,
        v: (y - bounds.minY) / bounds.height,
        weight: 1,
      })
    }
  }
  return pins.length ? pins : undefined
}

function boundsOf(piece: GarmentDocument['patterns'][string]) {
  const pts = Object.values(piece.points)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, width: Math.max(1e-6, maxX - minX), height: Math.max(1e-6, maxY - minY) }
}
