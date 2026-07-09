// Geometric load transfer + anti-roll bar balance for Tier-A handling.
// Pure math — no Three/Rapier.

export const DEFAULT_LOAD_TRANSFER = Object.freeze({
  useGeometric: true,
  hCG: 0.55,
  blendSusp: 0.5,
  g: 9.81,
});

export const DEFAULT_ANTI_ROLL = Object.freeze({
  front: 0.6,
  rear: 0.45,
  // Body roll-resist torque (N·m per rad/s of roll rate), mass-scaled by caller.
  rollDamp: 2.5,
  rollStiffness: 18,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function resolveLoadTransferConfig(config = {}) {
  return { ...DEFAULT_LOAD_TRANSFER, ...config };
}

export function resolveAntiRollConfig(config = {}) {
  return { ...DEFAULT_ANTI_ROLL, ...config };
}

/**
 * Derive wheelbase / track geometry from wheel anchors (chassis-local).
 * Front axle = negative Z. Returns lengths in metres.
 */
export function computeAxleGeometry(wheelAnchors = []) {
  let frontZ = 0;
  let rearZ = 0;
  let frontN = 0;
  let rearN = 0;
  let frontTrack = 0;
  let rearTrack = 0;
  const fronts = [];
  const rears = [];
  for (const a of wheelAnchors) {
    if (!a) continue;
    if (a.z < 0) {
      fronts.push(a);
      frontZ += a.z;
      frontN += 1;
    } else {
      rears.push(a);
      rearZ += a.z;
      rearN += 1;
    }
  }
  if (frontN) frontZ /= frontN;
  if (rearN) rearZ /= rearN;
  if (fronts.length >= 2) {
    frontTrack = Math.abs(fronts[0].x - fronts[1].x);
  } else if (fronts.length === 1) {
    frontTrack = Math.abs(fronts[0].x) * 2;
  }
  if (rears.length >= 2) {
    rearTrack = Math.abs(rears[0].x - rears[1].x);
  } else if (rears.length === 1) {
    rearTrack = Math.abs(rears[0].x) * 2;
  }
  // a = CG→front axle (positive distance), b = CG→rear. CG at local origin ≈ 0.
  // Front is at -z so distance a = -frontZ; rear distance b = rearZ.
  const a = Math.max(0.05, -frontZ);
  const b = Math.max(0.05, rearZ);
  const L = a + b;
  return {
    a,
    b,
    L,
    trackFront: Math.max(0.3, frontTrack),
    trackRear: Math.max(0.3, rearTrack),
    frontZ,
    rearZ,
  };
}

/**
 * Body-frame longitudinal / lateral accel from successive world linvel samples.
 * ax > 0 = accelerating forward (−Z travel means world −Z is forward).
 * ay > 0 = accelerating to the right (+X).
 */
export function computeBodyAccel(prevVel, vel, dt, forward, right) {
  if (!(dt > 1e-6) || !prevVel || !vel) {
    return { ax: 0, ay: 0, az: 0 };
  }
  const dvx = (vel.x - prevVel.x) / dt;
  const dvy = (vel.y - prevVel.y) / dt;
  const dvz = (vel.z - prevVel.z) / dt;
  // forward is chassis −Z in world; accel along forward = drive accel.
  const ax = dvx * forward.x + dvy * forward.y + dvz * forward.z;
  const ay = dvx * right.x + dvy * right.y + dvz * right.z;
  const az = dvy; // rough vertical
  return { ax, ay, az };
}

/**
 * Per-wheel vertical loads (N) from static weight + geometric transfer + ARB +
 * optional blend with measured suspension forces.
 *
 * @param {object} opts
 * @param {number} opts.mass
 * @param {number} opts.ax - body forward accel (m/s²)
 * @param {number} opts.ay - body rightward accel (m/s²)
 * @param {object} opts.geometry - from computeAxleGeometry
 * @param {object} [opts.loadTransfer]
 * @param {object} [opts.antiRoll]
 * @param {Array<{isFront:boolean, isLeft:boolean, suspForce?:number, inContact?:boolean}>} opts.wheels
 * @returns {{ loads: number[], staticFront: number, staticRear: number, dLong: number, dLatFront: number, dLatRear: number }}
 */
export function computeWheelLoads({
  mass = 1000,
  ax = 0,
  ay = 0,
  geometry,
  loadTransfer = null,
  antiRoll = null,
  wheels = [],
} = {}) {
  const lt = resolveLoadTransferConfig(loadTransfer ?? {});
  const arb = resolveAntiRollConfig(antiRoll ?? {});
  const g = lt.g ?? 9.81;
  const weight = mass * g;
  const { a, b, L, trackFront, trackRear } = geometry ?? {
    a: 1.4, b: 1.4, L: 2.8, trackFront: 1.6, trackRear: 1.6,
  };
  const h = lt.hCG ?? 0.55;

  // Static axle loads (front gets b/L of weight).
  const staticFront = weight * (b / L);
  const staticRear = weight * (a / L);

  // Longitudinal transfer: braking (ax < 0 when accel along forward is negative
  // for a car traveling −Z under throttle... ax from computeBodyAccel is along
  // forward, so +ax = accelerating in travel direction → unload front.
  // ΔF = m·ax·h/L moves load rearward under accel.
  const dLong = lt.useGeometric === false ? 0 : mass * ax * h / L;

  // Lateral transfer per axle: outer + under +ay (rightward).
  // massFrac front = staticFront/weight.
  const frontFrac = staticFront / Math.max(1e-4, weight);
  const rearFrac = 1 - frontFrac;
  const dLatFrontRaw = lt.useGeometric === false
    ? 0
    : mass * ay * h * frontFrac / Math.max(0.2, trackFront);
  const dLatRearRaw = lt.useGeometric === false
    ? 0
    : mass * ay * h * rearFrac / Math.max(0.2, trackRear);

  // ARB split: stiffer front ARB pushes more of the lateral transfer onto the
  // front axle (understeer). front+rear relative → split factor.
  const arbSum = Math.max(1e-4, (arb.front ?? 0.5) + (arb.rear ?? 0.5));
  const frontArbShare = (arb.front ?? 0.5) / arbSum; // 0.5 = neutral
  // Bias total lateral transfer: scale front/rear deltas by ARB share vs 0.5.
  const frontLatScale = 1 + (frontArbShare - 0.5) * 1.2;
  const rearLatScale = 1 + ((1 - frontArbShare) - 0.5) * 1.2;
  const dLatFront = dLatFrontRaw * frontLatScale;
  const dLatRear = dLatRearRaw * rearLatScale;

  const loads = new Array(wheels.length).fill(0);
  let geoFrontLeft = 0;
  let geoFrontRight = 0;
  let geoRearLeft = 0;
  let geoRearRight = 0;

  // Build per-axle raw L/R loads, then clamp with axle-sum conservation so a
  // lifted inner wheel redistributes its share onto the outer (no free load).
  const frontIdx = [];
  const rearIdx = [];
  for (let i = 0; i < wheels.length; i += 1) {
    if (wheels[i]?.isFront) frontIdx.push(i);
    else rearIdx.push(i);
  }

  /** @returns {[number, number]} left, right after clamp+redistribute */
  const clampAxlePair = (axleTotal, dLat) => {
    let leftF = axleTotal * 0.5 - dLat;
    let rightF = axleTotal * 0.5 + dLat;
    if (leftF < 0) {
      rightF = Math.max(0, axleTotal);
      leftF = 0;
    } else if (rightF < 0) {
      leftF = Math.max(0, axleTotal);
      rightF = 0;
    }
    return [leftF, rightF];
  };

  const applyAxle = (indices, leftF, rightF) => {
    for (const i of indices) {
      const w = wheels[i] ?? {};
      let F = w.isLeft ? leftF : rightF;
      const sideIdx = indices.filter((j) => Boolean(wheels[j]?.isLeft) === Boolean(w.isLeft));
      if (sideIdx.length > 1) F /= sideIdx.length;
      const susp = Number(w.suspForce);
      if (Number.isFinite(susp) && lt.blendSusp > 0) {
        const bld = clamp(lt.blendSusp, 0, 1);
        F = F * (1 - bld) + susp * bld;
      }
      if (w.inContact === false) F = 0;
      loads[i] = Math.max(0, F);
    }
  };

  // Left is −X: under +ay (right accel), right loads up → dLat positive to right.
  [geoFrontLeft, geoFrontRight] = clampAxlePair(staticFront - dLong, dLatFront);
  applyAxle(frontIdx, geoFrontLeft, geoFrontRight);
  [geoRearLeft, geoRearRight] = clampAxlePair(staticRear + dLong, dLatRear);
  applyAxle(rearIdx, geoRearLeft, geoRearRight);

  // If wheel flags were incomplete, fall back to equal static.
  if (wheels.length === 0) {
    return {
      loads: [],
      staticFront,
      staticRear,
      dLong,
      dLatFront,
      dLatRear,
      weight,
    };
  }

  return {
    loads,
    staticFront,
    staticRear,
    dLong,
    dLatFront,
    dLatRear,
    weight,
    geoFrontLeft,
    geoFrontRight,
    geoRearLeft,
    geoRearRight,
  };
}

/**
 * Optional roll-resist torque magnitude (about body forward axis).
 * Positive torque resists positive roll rate (right-side down).
 * Caller multiplies by mass and applies as torque along body forward.
 */
export function computeRollResistTorque({
  rollRate = 0,
  rollAngle = 0,
  antiRoll = null,
  groundedFraction = 1,
} = {}) {
  const arb = resolveAntiRollConfig(antiRoll ?? {});
  const gf = clamp(groundedFraction, 0, 1);
  return -(
    (arb.rollStiffness ?? 0) * rollAngle
    + (arb.rollDamp ?? 0) * rollRate
  ) * gf;
}
