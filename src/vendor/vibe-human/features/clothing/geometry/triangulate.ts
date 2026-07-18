import type { Vec2 } from '../state/clothingTypes'

/**
 * Dependency-free Delaunay triangulation (Bowyer–Watson) with polygon + hole
 * filtering, used to build a *conforming* cloth mesh whose boundary follows the
 * real pattern outline instead of a clipped grid staircase.
 *
 * The caller supplies the boundary samples (which become real mesh vertices on
 * the edges) plus interior Steiner points; we Delaunay-triangulate the whole
 * set, then keep only triangles whose centroid lies inside the panel and
 * outside its holes. The result has smooth diagonal/curved edges and real
 * vertices on every seam, exactly like Marvelous Designer.
 */

export type TriangleMesh = {
  /** Point list (mirrors the input order: boundary points first, then interior). */
  points: Vec2[]
  /** Flat triangle index triples into `points`, CCW. */
  triangles: number[]
}

type Triangle = { a: number; b: number; c: number }

/**
 * @param boundary  Closed outer outline samples (no duplicated closing point).
 * @param interior  Interior Steiner points (already filtered to be inside).
 * @param holes     Hole loops (each a closed loop, no duplicated closing point).
 *                  Hole vertices are added to the point set so triangle edges
 *                  conform to them; triangles inside holes are discarded.
 */
export function triangulatePanel(
  boundary: Vec2[],
  interior: Vec2[],
  holes: Vec2[][] = [],
): TriangleMesh {
  // Point set order matters for downstream code that assumes boundary-first:
  // [outer boundary, hole boundaries, interior].
  const points: Vec2[] = [...boundary]
  for (const hole of holes) points.push(...hole)
  points.push(...interior)

  if (points.length < 3) return { points, triangles: [] }

  const triangles = bowyerWatson(points)

  // Keep triangles whose centroid is inside the outer polygon and not inside a
  // hole — this clips the convex Delaunay hull back to the true panel shape.
  const kept: number[] = []
  for (const t of triangles) {
    const cx = (points[t.a].x + points[t.b].x + points[t.c].x) / 3
    const cy = (points[t.a].y + points[t.b].y + points[t.c].y) / 3
    if (!pointInPolygon(cx, cy, boundary)) continue
    let inHole = false
    for (const hole of holes) {
      if (pointInPolygon(cx, cy, hole)) { inHole = true; break }
    }
    if (inHole) continue
    // Emit CCW for consistent winding.
    if (signedArea(points[t.a], points[t.b], points[t.c]) < 0) {
      kept.push(t.a, t.c, t.b)
    } else {
      kept.push(t.a, t.b, t.c)
    }
  }

  return { points, triangles: kept }
}

// ---------------------------------------------------------------------------
// Bowyer–Watson incremental Delaunay over a point set.
// Returns triangles indexing into `points` (super-triangle vertices removed).
// ---------------------------------------------------------------------------

function bowyerWatson(points: Vec2[]): Triangle[] {
  const n = points.length

  // Super-triangle large enough to contain all points.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const dx = maxX - minX || 1
  const dy = maxY - minY || 1
  const dmax = Math.max(dx, dy) * 20
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2

  // Append super-triangle vertices to a working copy of the point list.
  const work = points.slice()
  const s0 = work.length
  work.push({ x: midX - dmax, y: midY - dmax })
  work.push({ x: midX + dmax, y: midY - dmax })
  work.push({ x: midX, y: midY + dmax })
  const s1 = s0 + 1
  const s2 = s0 + 2

  let triangles: Triangle[] = [{ a: s0, b: s1, c: s2 }]

  for (let i = 0; i < n; i += 1) {
    const p = work[i]
    const bad: Triangle[] = []
    for (const t of triangles) {
      if (inCircumcircle(p, work[t.a], work[t.b], work[t.c])) bad.push(t)
    }

    // Find the boundary of the polygonal hole (edges not shared by two bad tris).
    const edges: Array<[number, number]> = []
    for (const t of bad) {
      addEdge(edges, t.a, t.b)
      addEdge(edges, t.b, t.c)
      addEdge(edges, t.c, t.a)
    }
    const boundary = boundaryEdges(edges)

    triangles = triangles.filter((t) => !bad.includes(t))
    for (const [a, b] of boundary) {
      triangles.push({ a, b, c: i })
    }
  }

  // Drop any triangle touching a super-triangle vertex.
  return triangles.filter((t) => t.a < s0 && t.b < s0 && t.c < s0)
}

function addEdge(edges: Array<[number, number]>, a: number, b: number) {
  edges.push(a < b ? [a, b] : [b, a])
}

/** Return edges that appear exactly once (the cavity boundary). */
function boundaryEdges(edges: Array<[number, number]>): Array<[number, number]> {
  const count = new Map<string, { edge: [number, number]; n: number }>()
  for (const e of edges) {
    const key = `${e[0]}:${e[1]}`
    const entry = count.get(key)
    if (entry) entry.n += 1
    else count.set(key, { edge: e, n: 1 })
  }
  const result: Array<[number, number]> = []
  for (const { edge, n } of count.values()) {
    if (n === 1) result.push(edge)
  }
  return result
}

function inCircumcircle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const ax = a.x - p.x, ay = a.y - p.y
  const bx = b.x - p.x, by = b.y - p.y
  const cx = c.x - p.x, cy = c.y - p.y
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const det =
    ax * (by * c2 - b2 * cy) -
    ay * (bx * c2 - b2 * cx) +
    a2 * (bx * cy - by * cx)
  // For CCW (a,b,c), det > 0 means p is strictly inside the circumcircle.
  // Normalise by triangle orientation so winding of (a,b,c) doesn't matter.
  const orient = signedArea(a, b, c)
  return orient > 0 ? det > 0 : det < 0
}

function signedArea(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
}

export function pointInPolygon(x: number, y: number, polygon: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const intersect = (a.y > y) !== (b.y > y) &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    if (intersect) inside = !inside
  }
  return inside
}
