// Progressive spring + slow/fast damper split for Tier-A controller modulation.
// Pure math — no Three/Rapier. Outputs per-wheel controller setter values.

export const DEFAULT_SUSPENSION_DYNAMICS = Object.freeze({
  enabled: true,
  spring: Object.freeze({
    k: 24, // base stiffness (matches rayCast.suspensionStiffness default)
    progressiveStart: 0.7, // fraction of travel where progressive ramp begins
    progressiveRate: 1.6,
    bumpStopStart: 0.85,
    bumpStopK: 6,
    bumpStopDamp: 0.4,
  }),
  damper: Object.freeze({
    vKnee: 0.5, // m/s shaft-speed knee between slow and fast
    cLowBump: 5,
    cHighBump: 14,
    cLowRebound: 7,
    cHighRebound: 10,
  }),
  // Soft limits — never exceed the robustness launch cap from rayCast.
  // Hard upper bound on maxForce (launch cap). Never exceeds rayCast.maxSuspensionForce.
  maxForceCap: 4000,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mergeSection(base, override) {
  return { ...base, ...(override ?? {}) };
}

export function resolveSuspensionDynamics(config = {}) {
  const c = config ?? {};
  return {
    ...DEFAULT_SUSPENSION_DYNAMICS,
    ...c,
    spring: mergeSection(DEFAULT_SUSPENSION_DYNAMICS.spring, c.spring),
    damper: mergeSection(DEFAULT_SUSPENSION_DYNAMICS.damper, c.damper),
  };
}

/**
 * Shaft speed → dual-rate damper coefficient (bump or rebound).
 * Slow shaft speeds use low c (body control); fast use high c (bump absorption).
 */
export function damperCoefficient(shaftSpeed, damperCfg, isBump) {
  const cfg = damperCfg ?? DEFAULT_SUSPENSION_DYNAMICS.damper;
  const v = Math.abs(shaftSpeed);
  const knee = Math.max(1e-4, cfg.vKnee ?? 0.5);
  const cLow = isBump ? (cfg.cLowBump ?? 5) : (cfg.cLowRebound ?? 7);
  const cHigh = isBump ? (cfg.cHighBump ?? 14) : (cfg.cHighRebound ?? 10);
  if (v <= knee) return cLow;
  // Piecewise: cLow up to knee, then blend toward cHigh.
  const t = clamp((v - knee) / knee, 0, 3);
  return cLow + (cHigh - cLow) * Math.min(1, t);
}

/**
 * Progressive spring multiplier from compression fraction (0 = rest, 1 = full).
 */
export function progressiveSpringScale(compressionFrac, springCfg) {
  const cfg = springCfg ?? DEFAULT_SUSPENSION_DYNAMICS.spring;
  const start = cfg.progressiveStart ?? 0.7;
  const rate = cfg.progressiveRate ?? 1.6;
  const x = clamp(compressionFrac, 0, 1.2);
  if (x <= start) return 1;
  const t = (x - start) / Math.max(1e-4, 1 - start);
  return 1 + (rate - 1) * t * t;
}

/**
 * Bump-stop additive stiffness / damping once past bumpStopStart.
 */
export function bumpStopContribution(compressionFrac, springCfg) {
  const cfg = springCfg ?? DEFAULT_SUSPENSION_DYNAMICS.spring;
  const start = cfg.bumpStopStart ?? 0.85;
  const x = clamp(compressionFrac, 0, 1.25);
  if (x <= start) return { kAdd: 0, cAdd: 0 };
  const t = (x - start) / Math.max(1e-4, 1 - start);
  const w = t * t;
  return {
    kAdd: (cfg.bumpStopK ?? 6) * w,
    cAdd: (cfg.bumpStopDamp ?? 0.4) * w,
  };
}

/**
 * Resolve per-wheel controller suspension parameters for this step.
 *
 * @param {object} input
 * @param {number} input.suspensionLength - current controller length
 * @param {number} input.prevSuspensionLength - previous step
 * @param {number} input.dt
 * @param {number} input.restLength
 * @param {number} input.maxTravel
 * @param {number} [input.baseStiffness]
 * @param {number} [input.baseCompression]
 * @param {number} [input.baseRelaxation]
 * @param {number} [input.baseMaxForce]
 * @param {object} [input.dynamics] - suspension dynamics config
 * @returns {{ stiffness, compression, relaxation, maxTravel, maxForce, compressionFrac, shaftSpeed }}
 */
export function resolveWheelSuspension({
  suspensionLength = 0.3,
  prevSuspensionLength = null,
  dt = 1 / 60,
  restLength = 0.4,
  maxTravel = 0.42,
  baseStiffness = 24,
  baseCompression = 12,
  baseRelaxation = 12,
  baseMaxForce = 4000,
  dynamics = null,
} = {}) {
  const dyn = resolveSuspensionDynamics(dynamics ?? {});
  if (dyn.enabled === false) {
    return {
      stiffness: baseStiffness,
      compression: baseCompression,
      relaxation: baseRelaxation,
      maxTravel,
      maxForce: baseMaxForce,
      compressionFrac: 0,
      shaftSpeed: 0,
    };
  }

  // Compression: positive when shorter than rest (wheel pushed into body).
  const compression = Math.max(0, restLength - suspensionLength);
  const compressionFrac = compression / Math.max(1e-4, maxTravel);
  const prevLen = Number.isFinite(prevSuspensionLength)
    ? prevSuspensionLength
    : suspensionLength;
  // Shaft speed: d(compression)/dt. Positive = compressing.
  const shaftSpeed = dt > 1e-8
    ? (prevLen - suspensionLength) / dt
    : 0;
  const isBump = shaftSpeed >= 0;

  const springScale = progressiveSpringScale(compressionFrac, dyn.spring);
  const bump = bumpStopContribution(compressionFrac, dyn.spring);
  // Map our dual-rate damper into Rapier's compression (bump) / relaxation (rebound).
  const cBump = damperCoefficient(shaftSpeed, dyn.damper, true) + bump.cAdd;
  const cReb = damperCoefficient(shaftSpeed, dyn.damper, false);

  // Scale base controller rates by our relative coefficients.
  // Base compression/relaxation ~12 maps roughly to c~12; keep ratio.
  const stiff = (dyn.spring.k ?? baseStiffness) * springScale + bump.kAdd;
  // Launch invariant: never exceed rayCast.maxSuspensionForce / maxForceCap.
  const cap = dyn.maxForceCap ?? baseMaxForce;
  const maxForce = Math.min(baseMaxForce, cap);

  // Rapier maxSuspensionTravel is the allowed stroke about rest (compression
  // and droop). Clamp so travel never exceeds restLength (would invert rest).
  const travel = Math.min(maxTravel, Math.max(0.05, restLength - 0.02));

  return {
    stiffness: clamp(stiff, 4, 120),
    // Rapier compression/relaxation are damping-rate style scalars.
    compression: clamp(
      baseCompression * (cBump / Math.max(1e-4, dyn.damper.cLowBump ?? 5)),
      1,
      40,
    ),
    relaxation: clamp(
      baseRelaxation * (cReb / Math.max(1e-4, dyn.damper.cLowRebound ?? 7)),
      1,
      40,
    ),
    maxTravel: travel,
    maxForce,
    compressionFrac,
    shaftSpeed,
    springScale,
    isBump,
  };
}
