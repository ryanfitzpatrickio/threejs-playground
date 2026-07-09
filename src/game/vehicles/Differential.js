// Open / locked / LSD torque distribution across drive wheels.
// Pure math — no Three/Rapier.

export const DEFAULT_DIFFERENTIALS = Object.freeze({
  centre: Object.freeze({ type: 'lsd', bias: 0.55 }), // AWD front/rear split; bias = rear share
  front: Object.freeze({ type: 'lsd', bias: 0.4 }),
  rear: Object.freeze({ type: 'lsd', bias: 0.5 }),
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function resolveDifferentials(config = {}) {
  const c = config ?? {};
  return {
    centre: { ...DEFAULT_DIFFERENTIALS.centre, ...(c.centre ?? {}) },
    front: { ...DEFAULT_DIFFERENTIALS.front, ...(c.front ?? {}) },
    rear: { ...DEFAULT_DIFFERENTIALS.rear, ...(c.rear ?? {}) },
  };
}

/**
 * Split a scalar torque/force pool across two sides.
 * type: 'open' | 'locked' | 'lsd'
 * - open: more torque to the lower-load / higher-slip wheel (least resistance)
 * - locked: equal split
 * - lsd: bias toward higher-load / lower-slip wheel (clutch-type)
 *
 * @returns {[number, number]} fractions summing to 1
 */
export function splitPair(type, bias, loadA, loadB, slipA = 0, slipB = 0) {
  const t = (type ?? 'lsd').toLowerCase();
  if (t === 'locked') {
    return [0.5, 0.5];
  }
  const la = Math.max(0, loadA);
  const lb = Math.max(0, loadB);
  const sa = Math.abs(slipA);
  const sb = Math.abs(slipB);
  if (t === 'open') {
    // Inverse load + proportional slip → free wheel gets the torque.
    const wa = 1 / Math.max(0.05, la) + sa * 2;
    const wb = 1 / Math.max(0.05, lb) + sb * 2;
    const sum = wa + wb;
    return [wa / sum, wb / sum];
  }
  // LSD: prefer higher load and lower slip. `bias` mixes equal vs load-weighted.
  const b = clamp(bias ?? 0.5, 0, 1);
  const loadSum = la + lb;
  let loadFA = loadSum > 1e-4 ? la / loadSum : 0.5;
  let loadFB = 1 - loadFA;
  // Slip penalty: reduce share when this side is spinning more.
  const slipPenA = 1 / (1 + sa * 3);
  const slipPenB = 1 / (1 + sb * 3);
  let fa = loadFA * slipPenA;
  let fb = loadFB * slipPenB;
  const s = fa + fb;
  if (s > 1e-8) {
    fa /= s;
    fb /= s;
  } else {
    fa = 0.5;
    fb = 0.5;
  }
  // Blend toward equal with (1-bias); higher bias = stronger LSD lock feel.
  fa = 0.5 * (1 - b) + fa * b;
  fb = 1 - fa;
  return [fa, fb];
}

/**
 * Distribute total drive force (N) across wheels.
 *
 * @param {object} opts
 * @param {number} opts.totalForce - signed Newtons (positive = forward)
 * @param {'rwd'|'fwd'|'awd'} opts.driveLayout
 * @param {Array<{ isFront: boolean, isLeft: boolean, load: number, slip: number, inContact?: boolean }>} opts.wheels
 * @param {object} [opts.differentials]
 * @returns {number[]} per-wheel force (same length as wheels), signed
 */
export function distributeDriveForce({
  totalForce = 0,
  driveLayout = 'rwd',
  wheels = [],
  differentials = null,
} = {}) {
  const n = wheels.length;
  const out = new Array(n).fill(0);
  if (!(Math.abs(totalForce) > 1e-8) || n === 0) return out;

  const diffs = resolveDifferentials(differentials ?? {});
  const layout = (driveLayout ?? 'rwd').toLowerCase();

  const frontIdx = [];
  const rearIdx = [];
  for (let i = 0; i < n; i += 1) {
    if (wheels[i]?.isFront) frontIdx.push(i);
    else rearIdx.push(i);
  }

  let frontPool = 0;
  let rearPool = 0;
  if (layout === 'fwd') {
    frontPool = totalForce;
  } else if (layout === 'rwd') {
    rearPool = totalForce;
  } else {
    // AWD centre split: bias = rear share (0.55 → 55% rear).
    const centre = diffs.centre;
    if ((centre.type ?? 'lsd').toLowerCase() === 'locked') {
      rearPool = totalForce * 0.5;
      frontPool = totalForce * 0.5;
    } else if ((centre.type ?? 'lsd').toLowerCase() === 'open') {
      // Open centre: more to the freer axle (higher average slip / lower load).
      const fLoad = frontIdx.reduce((s, i) => s + (wheels[i].load ?? 0), 0);
      const rLoad = rearIdx.reduce((s, i) => s + (wheels[i].load ?? 0), 0);
      const fSlip = frontIdx.reduce((s, i) => s + Math.abs(wheels[i].slip ?? 0), 0) / Math.max(1, frontIdx.length);
      const rSlip = rearIdx.reduce((s, i) => s + Math.abs(wheels[i].slip ?? 0), 0) / Math.max(1, rearIdx.length);
      const [ff, rf] = splitPair('open', 0.5, fLoad, rLoad, fSlip, rSlip);
      frontPool = totalForce * ff;
      rearPool = totalForce * rf;
    } else {
      // LSD centre with static bias, modulated by load.
      const rearShare = clamp(centre.bias ?? 0.55, 0.2, 0.8);
      const fLoad = frontIdx.reduce((s, i) => s + (wheels[i].load ?? 0), 0);
      const rLoad = rearIdx.reduce((s, i) => s + (wheels[i].load ?? 0), 0);
      const fSlip = frontIdx.reduce((s, i) => s + Math.abs(wheels[i].slip ?? 0), 0) / Math.max(1, frontIdx.length);
      const rSlip = rearIdx.reduce((s, i) => s + Math.abs(wheels[i].slip ?? 0), 0) / Math.max(1, rearIdx.length);
      const [ff, rf] = splitPair('lsd', 0.65, fLoad, rLoad, fSlip, rSlip);
      // Blend static rear bias with dynamic LSD split.
      const dynRear = rf;
      rearPool = totalForce * (rearShare * 0.55 + dynRear * 0.45);
      frontPool = totalForce - rearPool;
    }
  }

  const fillAxle = (indices, pool, axleDiff) => {
    if (!indices.length || !(Math.abs(pool) > 1e-8)) return;
    if (indices.length === 1) {
      out[indices[0]] = pool;
      return;
    }
    // Pair left/right if possible.
    const left = indices.filter((i) => wheels[i]?.isLeft);
    const right = indices.filter((i) => !wheels[i]?.isLeft);
    if (left.length && right.length) {
      const lLoad = left.reduce((s, i) => s + (wheels[i].load ?? 0), 0);
      const rLoad = right.reduce((s, i) => s + (wheels[i].load ?? 0), 0);
      const lSlip = left.reduce((s, i) => s + Math.abs(wheels[i].slip ?? 0), 0) / left.length;
      const rSlip = right.reduce((s, i) => s + Math.abs(wheels[i].slip ?? 0), 0) / right.length;
      const [fl, fr] = splitPair(axleDiff.type, axleDiff.bias, lLoad, rLoad, lSlip, rSlip);
      const lPool = pool * fl;
      const rPool = pool * fr;
      for (const i of left) out[i] = lPool / left.length;
      for (const i of right) out[i] = rPool / right.length;
    } else {
      for (const i of indices) out[i] = pool / indices.length;
    }
  };

  fillAxle(frontIdx, frontPool, diffs.front);
  fillAxle(rearIdx, rearPool, diffs.rear);

  // Zero force on airborne wheels and renormalize onto grounded drive wheels.
  let groundedSum = 0;
  let airborne = 0;
  for (let i = 0; i < n; i += 1) {
    if (wheels[i]?.inContact === false) {
      airborne += out[i];
      out[i] = 0;
    } else {
      groundedSum += out[i];
    }
  }
  if (Math.abs(airborne) > 1e-8 && Math.abs(groundedSum) > 1e-8) {
    const scale = (groundedSum + airborne) / groundedSum;
    for (let i = 0; i < n; i += 1) out[i] *= scale;
  }

  return out;
}
