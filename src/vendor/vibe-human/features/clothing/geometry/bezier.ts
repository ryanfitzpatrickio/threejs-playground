import type { Vec2 } from '../state/clothingTypes'

// ---------------------------------------------------------------------------
// Cubic Bezier evaluation  P0, P1, P2, P3  at t ∈ [0,1]
// ---------------------------------------------------------------------------

export function cubicBezierPoint(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  t: number,
): Vec2 {
  const mt = 1 - t
  const mt2 = mt * mt
  const mt3 = mt2 * mt
  const t2 = t * t
  const t3 = t2 * t
  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  }
}

/** First derivative of a cubic bezier (tangent direction, not normalised). */
export function cubicBezierTangent(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  t: number,
): Vec2 {
  const mt = 1 - t
  return {
    x: 3 * (mt * mt * (p1.x - p0.x) + 2 * mt * t * (p2.x - p1.x) + t * t * (p3.x - p2.x)),
    y: 3 * (mt * mt * (p1.y - p0.y) + 2 * mt * t * (p2.y - p1.y) + t * t * (p3.y - p2.y)),
  }
}

/** Sample a cubic bezier into `count` evenly-spaced points (in t-space). */
export function sampleCubicBezier(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  count: number,
): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i <= count; i++) {
    pts.push(cubicBezierPoint(p0, p1, p2, p3, i / count))
  }
  return pts
}

/** Approximate arc-length of a cubic bezier by sampling. */
export function cubicBezierLength(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, steps = 20): number {
  let len = 0
  let prev = p0
  for (let i = 1; i <= steps; i++) {
    const cur = cubicBezierPoint(p0, p1, p2, p3, i / steps)
    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    len += Math.sqrt(dx * dx + dy * dy)
    prev = cur
  }
  return len
}

// ---------------------------------------------------------------------------
// Distance helpers
// ---------------------------------------------------------------------------

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt(dist2(a, b))
}

/** Point-to-line-segment squared distance. */
export function pointToSegmentDist2(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return dist2(p, a)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return dist2(p, { x: a.x + t * dx, y: a.y + t * dy })
}
