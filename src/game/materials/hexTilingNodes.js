/**
 * TSL math for Mikkelsen's "Practical Real-Time Hex-Tiling".
 *
 * The RWS entry point deliberately takes a small, camera-relative coordinate
 * and a separate absolute-world offset. Passing a large absolute coordinate as
 * `relativeSt` defeats the precision-preserving variant; callers without a
 * floating origin should pass their current world coordinate and vec2(0).
 *
 * Reference implementation:
 * https://github.com/mmikk/hextile-demo/blob/master/hextile-demo/hextiling_rws.h
 */

import {
  abs,
  cos,
  float,
  floor,
  fract,
  mat2,
  max,
  mix,
  mod,
  sin,
  step,
  vec2,
  vec3,
} from 'three/tsl';

const TWO_SQRT_THREE = 3.4641016151377544;
const INV_SQRT_THREE = 0.5773502691896258;
const TWO_INV_SQRT_THREE = 1.1547005383792517;
const HASH_SCALE = 43758.5453;

function skew(st) {
  return vec2(
    st.x.sub(st.y.mul(INV_SQRT_THREE)),
    st.y.mul(TWO_INV_SQRT_THREE),
  );
}

/** IQ-style deterministic lattice hash, returning values in [0, 1). */
export function hexHash2(vertex) {
  const p = vec2(
    vertex.x.mul(127.1).add(vertex.y.mul(311.7)),
    vertex.x.mul(269.5).add(vertex.y.mul(183.3)),
  );
  return fract(sin(p).mul(HASH_SCALE));
}

/** Per-lattice-vertex rotation from the reference implementation. */
export function hexRot2x2(vertex, rotStrength = float(0)) {
  const angle = hexRotationAngle(vertex, rotStrength);
  const cs = cos(angle);
  const sn = sin(angle);
  return mat2(cs, sn.negate(), sn, cs);
}

/** Rotation angle used by both coordinate and tangent-normal transforms. */
export function hexRotationAngle(vertex, rotStrength = float(0)) {
  let angle = abs(vertex.x.mul(vertex.y))
    .add(abs(vertex.x.add(vertex.y)))
    .add(Math.PI);
  angle = mod(angle, Math.PI * 2);
  // mod() is non-negative for the integer lattice inputs used here. Remap the
  // upper half of the circle into [-PI, PI], matching LoadRot2x2.
  return angle.sub(step(Math.PI, angle).mul(Math.PI * 2)).mul(rotStrength);
}

/** Convert an integer simplex-lattice vertex back to source texture space. */
export function hexVertexCenter(vertex) {
  return vec2(
    vertex.x.add(vertex.y.mul(0.5)),
    vertex.y.div(TWO_INV_SQRT_THREE),
  ).div(TWO_SQRT_THREE);
}

/** Rotate a source coordinate around its lattice center, then apply tile jitter. */
export function hexTileUv(st, vertex, rotStrength = float(0)) {
  const center = hexVertexCenter(vertex);
  const delta = st.sub(center);
  const angle = hexRotationAngle(vertex, rotStrength);
  const cs = cos(angle);
  const sn = sin(angle);
  // HLSL reference uses mul(float2, rot): row-vector convention.
  const rotated = vec2(
    delta.x.mul(cs).add(delta.y.mul(sn)),
    delta.y.mul(cs).sub(delta.x.mul(sn)),
  );
  return rotated.add(center).add(hexHash2(vertex));
}

/**
 * Precision-preserving simplex grid lookup.
 *
 * Both inputs are in texture-space units (world XZ multiplied by tile rate):
 * `relativeSt` remains small, while `absoluteOffsetSt` carries the large,
 * per-frame-constant floating-origin offset.
 */
export function hexTriangleGridRws(relativeSt, absoluteOffsetSt = vec2(0)) {
  const skewed = skew(relativeSt.mul(TWO_SQRT_THREE));
  const skewedOffset = skew(absoluteOffsetSt.mul(TWO_SQRT_THREE));
  const offsetBase = floor(skewedOffset);
  const combinedSkew = skewed.add(fract(skewedOffset));
  const base = floor(combinedSkew).add(offsetBase);
  const f = fract(combinedSkew);
  const z = float(1).sub(f.x).sub(f.y);
  const s = step(float(0), z.negate());
  const s2 = s.mul(2).sub(1);

  const weights = vec3(
    z.negate().mul(s2),
    s.sub(f.y.mul(s2)),
    s.sub(f.x.mul(s2)),
  );
  const oneMinusS = float(1).sub(s);

  return {
    weights,
    vertex1: base.add(vec2(s, s)),
    vertex2: base.add(vec2(s, oneMinusS)),
    vertex3: base.add(vec2(oneMinusS, s)),
  };
}

/** Convenience wrapper that keeps tile-rate scaling consistent for callers. */
export function createHexTileGrid(relativeWorldXZ, absoluteWorldOffsetXZ, tilesPerMetre) {
  const rate = float(tilesPerMetre);
  return hexTriangleGridRws(
    relativeWorldXZ.mul(rate),
    absoluteWorldOffsetXZ.mul(rate),
  );
}

/** Normalize sharpened barycentric weights using a per-sample detail metric. */
export function hexBlendWeights(barycentric, detailMetric, falloffContrast = 0.6, exponent = 7) {
  const detail = mix(vec3(1), detailMetric, float(falloffContrast));
  const weighted = detail.mul(barycentric.pow(float(exponent)));
  return weighted.div(max(weighted.x.add(weighted.y).add(weighted.z), float(1e-6)));
}
