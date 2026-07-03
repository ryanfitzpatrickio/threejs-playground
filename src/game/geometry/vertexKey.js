// Fast quantized numeric key for vertex dedup. Replaces the slow
// `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}` string keys used in cut-piece
// connected-components splitting and convex-hull vertex dedupe. Map<number> /
// Set<number> skip both the toFixed formatting cost and string hashing — a big
// constant-factor win on the ~15k-vertex cut spike.
//
// Quantization matches toFixed(4) (4-decimal bucketing), so dedup results — and
// therefore the cut output pieces — are unchanged. Coordinates are assumed to be
// within ±5 (baked-piece local space); any out-of-range coordinate falls back to
// a string key so dedup correctness is never compromised.

const Q = 10000; // 4-decimal quantization
const OFF = 50000; // shift coords (±5 → ±50000 after *Q) into [0, 100000]
const SY = 131072; // 2^17, exceeds the 2*OFF range so packing never collides
const SZ = SY * SY;

export function vertexKeyNum(x, y, z) {
  const qx = Math.round(x * Q) + OFF;
  const qy = Math.round(y * Q) + OFF;
  const qz = Math.round(z * Q) + OFF;
  if (qx >= 0 && qy >= 0 && qz >= 0 && qx < SY && qy < SY && qz < SY) {
    return qx + qy * SY + qz * SZ;
  }
  return `${qx - OFF}|${qy - OFF}|${qz - OFF}`;
}
