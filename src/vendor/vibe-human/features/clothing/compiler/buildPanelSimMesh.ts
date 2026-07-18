import { evaluateEdgeAt, sampleEdgeLoop, samplePatternOutline } from '../geometry/patternSampling'
import { triangulatePanel, pointInPolygon } from '../geometry/triangulate'
import type { PatternPanel, Vec2 } from '../document/types'
import type { CompilerOptions } from './types'
import type {
  BendConstraint,
  DistanceConstraint,
  PanelRuntimeInfo,
  PinConstraint,
} from '../simulation/types'

const PATTERN_UNIT_SCALE = 0.004

export const QUALITY_PRESETS: Record<CompilerOptions['quality'], {
  spacing: number
  bendCompliance: number
  stretchCompliance: number
  shearCompliance: number
  minDim: number
  maxDim: number
}> = {
  low: { spacing: 0.060, bendCompliance: 0.4, stretchCompliance: 0.0002, shearCompliance: 0.00028, minDim: 8, maxDim: 16 },
  medium: { spacing: 0.040, bendCompliance: 0.25, stretchCompliance: 0.0002, shearCompliance: 0.00028, minDim: 12, maxDim: 24 },
  high: { spacing: 0.028, bendCompliance: 0.15, stretchCompliance: 0.00014, shearCompliance: 0.0002, minDim: 16, maxDim: 32 },
  ultra: { spacing: 0.020, bendCompliance: 0.08, stretchCompliance: 0.00008, shearCompliance: 0.00014, minDim: 20, maxDim: 40 },
}

export type CompiledPanelSimMesh = {
  panelInfo: PanelRuntimeInfo
  positions: number[]
  invMass: number[]
  panelIds: string[]
  particleFrictions: number[]
  panelUvs: number[]
  panelLocalPositions: number[]
  stretchConstraints: DistanceConstraint[]
  shearConstraints: DistanceConstraint[]
  bendDistanceConstraints: DistanceConstraint[]
  bendConstraints: BendConstraint[]
  pinConstraints: PinConstraint[]
  seamSamplePoints: Array<{ particle: number; x: number; y: number }>
}

export function buildPanelSimMesh(
  panel: PatternPanel,
  options: CompilerOptions,
  particleOffset: number,
): CompiledPanelSimMesh {
  const preset = QUALITY_PRESETS[options.quality]
  const stretchCompliance = panel.stretchCompliance ?? preset.stretchCompliance
  const bounds = boundsOf(panel)

  // Target particle spacing in pattern (mm) space, derived from the quality
  // preset's world-space spacing.
  const spacingPattern = preset.spacing / PATTERN_UNIT_SCALE
  // Clamp how many particles span the panel so tiny/huge panels stay sane.
  const spanForDim = (length: number, minDim: number, maxDim: number) => {
    const cells = clampInt(Math.round(length / spacingPattern), Math.max(1, minDim - 1), maxDim - 1)
    return Math.max(1e-3, length / cells)
  }
  const stepX = spanForDim(bounds.width, preset.minDim, preset.maxDim)
  const stepY = spanForDim(bounds.height, preset.minDim, preset.maxDim)
  const step = Math.min(stepX, stepY)

  // --- Build the conforming point set -------------------------------------
  // Boundary samples become real mesh vertices ON the outline, so diagonal and
  // curved edges are followed exactly (no staircase) and seams can bind to true
  // edge particles. Interior Steiner points fill the panel on a regular lattice.
  const outline = resamplePolyline(samplePatternOutline(panel, 12), step)
  const holeLoops = (panel.holes ?? [])
    .map((hole) => resamplePolyline(sampleEdgeLoop(panel, hole, 12), step))
    .filter((hole) => hole.length >= 3)
  const interior = buildInteriorPoints(bounds, step, outline, holeLoops)

  const mesh = triangulatePanel(outline, interior, holeLoops)

  // --- Emit particles -----------------------------------------------------
  const positions: number[] = []
  const invMass: number[] = []
  const panelIds: string[] = []
  const particleFrictions: number[] = []
  const panelUvs: number[] = []
  const panelLocalPositions: number[] = []
  const seamSamplePoints: Array<{ particle: number; x: number; y: number }> = []
  const particleIndices: number[] = []

  for (let i = 0; i < mesh.points.length; i += 1) {
    const p = mesh.points[i]
    const u = (p.x - bounds.minX) / bounds.width
    const v = (p.y - bounds.minY) / bounds.height
    const localX = (u - 0.5) * bounds.width * PATTERN_UNIT_SCALE
    const localY = (0.5 - v) * bounds.height * PATTERN_UNIT_SCALE
    const world = applyPlacement(localX, localY, 0, panel.placement)
    const particle = particleOffset + particleIndices.length
    particleIndices.push(particle)
    positions.push(world.x, world.y, world.z)
    invMass.push(1 / 0.018)
    panelIds.push(panel.id)
    particleFrictions.push(panel.friction ?? 1)
    panelUvs.push(u, v)
    panelLocalPositions.push(p.x, p.y)
    seamSamplePoints.push({ particle, x: p.x, y: p.y })
  }

  // --- Derive constraints from triangulation edges ------------------------
  // Distance constraints over unique triangle edges resist in-plane stretch.
  // Keep irregular topology conservative: diagonal/apex bend-distance solves can
  // easily invert skinny triangles and create seam spikes on arbitrary Delaunay
  // meshes.
  const stretchConstraints: DistanceConstraint[] = []
  const shearConstraints: DistanceConstraint[] = []
  const bendDistanceConstraints: DistanceConstraint[] = []
  const bendConstraints: BendConstraint[] = []
  const triangleIndices: number[] = []

  const localToGlobal = (local: number) => particleIndices[local]
  const restOfLocal = (la: number, lb: number) =>
    Math.hypot(
      positions[lb * 3] - positions[la * 3],
      positions[lb * 3 + 1] - positions[la * 3 + 1],
      positions[lb * 3 + 2] - positions[la * 3 + 2],
    )

  const edgeSeen = new Set<string>()
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`)

  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const a = mesh.triangles[t]
    const b = mesh.triangles[t + 1]
    const c = mesh.triangles[t + 2]
    triangleIndices.push(localToGlobal(a), localToGlobal(b), localToGlobal(c))

    const edges: Array<[number, number, number]> = [
      [a, b, c], // edge (a,b), apex c
      [b, c, a], // edge (b,c), apex a
      [c, a, b], // edge (c,a), apex b
    ]
    for (const [e0, e1] of edges) {
      const key = edgeKey(e0, e1)
      if (edgeSeen.has(key)) continue
      edgeSeen.add(key)
      stretchConstraints.push({
        a: localToGlobal(e0),
        b: localToGlobal(e1),
        rest: restOfLocal(e0, e1),
        compliance: stretchCompliance,
        kind: 'stretch',
      })
    }
  }

  const pinConstraints = buildPinConstraints(panel, seamSamplePoints)

  return {
    panelInfo: {
      panelId: panel.id,
      placement: panel.placement,
      particleIndices,
      triangleIndices: new Uint32Array(triangleIndices),
    },
    positions,
    invMass,
    panelIds,
    particleFrictions,
    panelUvs,
    panelLocalPositions,
    stretchConstraints,
    shearConstraints,
    bendDistanceConstraints,
    bendConstraints,
    pinConstraints,
    seamSamplePoints,
  }
}

function buildPinConstraints(
  panel: PatternPanel,
  particles: Array<{ particle: number; x: number; y: number }>,
) {
  const pins: PinConstraint[] = []
  for (const pin of panel.pins ?? []) {
    let best = particles[0]
    let bestDist = Infinity
    for (const particle of particles) {
      const dx = particle.x - uvToPattern(pin.u, boundsOf(panel).minX, boundsOf(panel).width)
      const dy = particle.y - uvToPattern(pin.v, boundsOf(panel).minY, boundsOf(panel).height)
      const dist = dx * dx + dy * dy
      if (dist < bestDist) {
        bestDist = dist
        best = particle
      }
    }
    const world = applyPlacementFromPattern(best.x, best.y, panel)
    pins.push({ particle: best.particle, x: world.x, y: world.y, z: world.z, stiffness: pin.weight ?? 1, kind: 'pin' })
  }
  return pins
}

/**
 * Resample a closed polyline to a roughly uniform vertex spacing (in pattern
 * mm). Keeps corners reasonably and guarantees no two boundary vertices are far
 * apart, so the triangulated edge stays smooth without exploding vertex count.
 */
function resamplePolyline(loop: Vec2[], step: number): Vec2[] {
  if (loop.length < 2) return loop
  // Build the closed perimeter as segments.
  const pts = [...loop, loop[0]]
  let total = 0
  const segLen: number[] = []
  for (let i = 0; i < pts.length - 1; i += 1) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
    segLen.push(len)
    total += len
  }
  if (total <= 1e-6) return loop
  const count = Math.max(3, Math.round(total / step))
  const spacing = total / count
  const out: Vec2[] = []
  let seg = 0
  let segStart = 0
  for (let i = 0; i < count; i += 1) {
    const target = i * spacing
    while (seg < segLen.length - 1 && segStart + segLen[seg] < target) {
      segStart += segLen[seg]
      seg += 1
    }
    const t = segLen[seg] > 1e-9 ? (target - segStart) / segLen[seg] : 0
    out.push({
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t,
      y: pts[seg].y + (pts[seg + 1].y - pts[seg].y) * t,
    })
  }
  return out
}

/**
 * Regular lattice of interior Steiner points, kept a half-step away from the
 * boundary (and holes) so the triangulation doesn't produce slivers hugging the
 * edge. Boundary smoothness comes from the resampled outline; these just fill
 * the inside so the cloth has body.
 */
function buildInteriorPoints(
  bounds: { minX: number; minY: number; width: number; height: number },
  step: number,
  outline: Vec2[],
  holes: Vec2[][],
): Vec2[] {
  const margin = step * 0.5
  const out: Vec2[] = []
  for (let y = bounds.minY + margin; y < bounds.minY + bounds.height - margin * 0.5; y += step) {
    for (let x = bounds.minX + margin; x < bounds.minX + bounds.width - margin * 0.5; x += step) {
      if (!pointInPolygon(x, y, outline)) continue
      if (distanceToPolyline(x, y, outline) < margin) continue
      let nearHole = false
      for (const hole of holes) {
        if (pointInPolygon(x, y, hole) || distanceToPolyline(x, y, hole) < margin) { nearHole = true; break }
      }
      if (nearHole) continue
      out.push({ x, y })
    }
  }
  return out
}

function distanceToPolyline(x: number, y: number, loop: Vec2[]): number {
  let best = Infinity
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const lenSq = abx * abx + aby * aby
    const t = lenSq <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / lenSq))
    const dx = x - (a.x + abx * t)
    const dy = y - (a.y + aby * t)
    const dist = Math.hypot(dx, dy)
    if (dist < best) best = dist
  }
  return best
}

function boundsOf(panel: PatternPanel) {
  const points = Object.values(panel.points)
  if (!points.length) return { minX: -140, minY: -140, width: 280, height: 280 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return { minX, minY, width: maxX - minX || 1, height: maxY - minY || 1 }
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function applyPlacement(x: number, y: number, z: number, placement: PatternPanel['placement']) {
  const q = quatFromEuler(placement.rotation.x, placement.rotation.y, placement.rotation.z)
  const rotated = rotateVec(x, y, z, q.x, q.y, q.z, q.w)
  return {
    x: rotated.x + placement.position.x,
    y: rotated.y + placement.position.y,
    z: rotated.z + placement.position.z,
  }
}

function applyPlacementFromPattern(x: number, y: number, panel: PatternPanel) {
  const bounds = boundsOf(panel)
  const worldX = ((x - bounds.minX) / bounds.width - 0.5) * bounds.width * PATTERN_UNIT_SCALE
  const worldY = (0.5 - (y - bounds.minY) / bounds.height) * bounds.height * PATTERN_UNIT_SCALE
  return applyPlacement(worldX, worldY, 0, panel.placement)
}

function uvToPattern(value: number, min: number, span: number) {
  return min + value * span
}

function quatFromEuler(x: number, y: number, z: number) {
  const c1 = Math.cos(x / 2)
  const s1 = Math.sin(x / 2)
  const c2 = Math.cos(y / 2)
  const s2 = Math.sin(y / 2)
  const c3 = Math.cos(z / 2)
  const s3 = Math.sin(z / 2)
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  }
}

function rotateVec(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number) {
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  return {
    x: x + qw * tx + (qy * tz - qz * ty),
    y: y + qw * ty + (qz * tx - qx * tz),
    z: z + qw * tz + (qx * ty - qy * tx),
  }
}

export function samplePanelEdge(panel: PatternPanel, edgeId: string, samples: number, reversed = false) {
  const edge = panel.edges.find((item) => item.id === edgeId)
  if (!edge) return []
  const points: Vec2[] = []
  for (let index = 0; index <= samples; index += 1) {
    points.push(evaluateEdgeAt(panel, edge, index / samples))
  }
  return reversed ? points.reverse() : points
}
