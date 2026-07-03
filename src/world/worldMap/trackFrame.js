/**
 * trackFrame.js
 *
 * Pure math (no THREE) shared by the road ribbon builder (createRoadworks) and the
 * trackside layer stack (createTracksideLayers). Lifts one sampled road centerline
 * — a `built` entry from buildRoadProfile (roadProfile.js) — into a per-sample
 * frame:
 *   - arc      cumulative arc length along the centerline (metres),
 *   - tanX/tanZ unit tangent in the xz plane (centerline travel direction),
 *   - norX/norZ road-perpendicular unit normal in the xz plane (left side is +),
 *   - posX/posZ world position of the centerline sample,
 *   - roadY     the graded road surface height at the sample (no ribbon lift).
 *
 * Every trackside layer (road, curb, shoulder, wall, fence, sponsor board, hero
 * prop) is a function of a signed lateral offset `u` (metres from the centerline)
 * and the arc length `s` — so they all derive from this single frame. Keeping the
 * frame math in one pure module means the visible ribbon, the collider boxes, and
 * the outboard layers cannot drift from each other.
 *
 * The tangent/normal/arc conventions match what createRoadworks computed inline:
 *   tan = normalize(next - prev) over the neighbouring samples (clamped ends);
 *   nor = perpendicular (-tan.z, tan.x) so offsetPoint(frame, i, +half) is the
 *   LEFT edge and -half is the RIGHT edge, exactly as the ribbon was laid before.
 */

/**
 * @param {Object} built one entry of buildRoadProfile().roads:
 *   { samples:[{x,z}], n, roadY:Float64Array, half, ... }
 * @returns {Object} frame { n, half, arc, tanX, tanZ, norX, norZ, posX, posZ, roadY }
 *   (all per-sample Float64Array, length n).
 */
export function buildRibbonFrame(built) {
  const { samples, n, roadY, half } = built;

  const arc = new Float64Array(n);
  const tanX = new Float64Array(n);
  const tanZ = new Float64Array(n);
  const norX = new Float64Array(n);
  const norZ = new Float64Array(n);
  const posX = new Float64Array(n);
  const posZ = new Float64Array(n);
  const roadYOut = new Float64Array(n);

  arc[0] = 0;
  for (let i = 1; i < n; i += 1) {
    arc[i] = arc[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
  }

  for (let i = 0; i < n; i += 1) {
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(n - 1, i + 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    // Degenerate tangent (coincident neighbours) → fall back to +x, matching the
    // old `tan.lengthSq() < 1e-8` guard before normalize.
    // Normalize the same way THREE.Vector2.normalize did inline (sqrt, not hypot)
    // so the derived edges stay bit-for-bit identical to the pre-refactor ribbon.
    if (dx * dx + dz * dz < 1e-8) { dx = 1; dz = 0; }
    else { const inv = 1 / Math.sqrt(dx * dx + dz * dz); dx *= inv; dz *= inv; }
    tanX[i] = dx;
    tanZ[i] = dz;
    norX[i] = -dz; // perpendicular: left side is +half
    norZ[i] = dx;
    posX[i] = samples[i].x;
    posZ[i] = samples[i].z;
    roadYOut[i] = roadY[i];
  }

  return { n, half, arc, tanX, tanZ, norX, norZ, posX, posZ, roadY: roadYOut };
}

/**
 * World xz position at lateral offset `u` (signed metres) on sample `i`.
 * u = +half → left road edge, u = -half → right road edge, u = 0 → centerline.
 */
export function offsetPoint(frame, i, u) {
  return {
    x: frame.posX[i] + frame.norX[i] * u,
    z: frame.posZ[i] + frame.norZ[i] * u,
  };
}

/**
 * Evenly arc-spaced anchors along the centerline, for placing repeated trackside
 * features (fence panels, sponsor boards, hero props). Anchors fall BETWEEN samples,
 * so position / normal / tangent / roadY are linearly interpolated (dirs renormalized).
 *
 * @param {Object} frame  from buildRibbonFrame
 * @param {number} spacing metres between anchors (> 0)
 * @param {Object} [opts]
 * @param {number} [opts.phase=0]   arc offset of the first anchor (m)
 * @param {number} [opts.lateral=0] signed lateral offset applied to x/z (m)
 * @returns {Array<{ s, x, z, nx, nz, tx, tz, roadY }>}
 *   s = arc length; (x,z) = world position at the lateral offset; (nx,nz) = unit
 *   road-perpendicular normal; (tx,tz) = unit tangent; roadY = road surface height.
 */
export function placementsAlong(frame, spacing, { phase = 0, lateral = 0 } = {}) {
  const { n, arc, posX, posZ, norX, norZ, tanX, tanZ, roadY } = frame;
  const out = [];
  const total = n > 0 ? arc[n - 1] : 0;
  if (!(spacing > 0) || total <= 0) return out;

  let seg = 0;
  for (let s = phase; s <= total + 1e-6; s += spacing) {
    const sc = s > total ? total : s;
    while (seg < n - 2 && arc[seg + 1] < sc) seg += 1;
    const a0 = arc[seg], a1 = arc[seg + 1];
    let t = a1 > a0 ? (sc - a0) / (a1 - a0) : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const lerp = (A) => A[seg] + (A[seg + 1] - A[seg]) * t;

    let nx = lerp(norX), nz = lerp(norZ);
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    let tx = lerp(tanX), tz = lerp(tanZ);
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;

    out.push({
      s: sc,
      x: lerp(posX) + nx * lateral,
      z: lerp(posZ) + nz * lateral,
      nx, nz, tx, tz,
      roadY: lerp(roadY),
    });
  }
  return out;
}
