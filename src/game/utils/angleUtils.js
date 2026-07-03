// Shortest signed angular difference from b to a, in radians, in (-π, π].
export function shortestAngleDelta(a, b) {
  let delta = (a - b + Math.PI) % (Math.PI * 2) - Math.PI;
  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }

  return delta;
}
