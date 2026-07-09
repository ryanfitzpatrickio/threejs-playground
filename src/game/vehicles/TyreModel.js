// Slip-angle / slip-ratio tyre model for Tier-A controller-slip handling.
// Pure math — no Three/Rapier. Maps α/κ/Fz to friction scalars the Rapier
// DynamicRayCastVehicleController can consume via setWheelFrictionSlip /
// setWheelSideFrictionStiffness.
//
// Tier-A available-grip mapping (not instantaneous force):
//   - Full controller friction through α ≤ alphaPeakDeg (linear region)
//   - Gentle falloff past the peak (F6 recoverable slides)
//   - Surface mu0 scales grip vs asphalt reference (muRef)
//   - K scales post-peak falloff sharpness
//   - alphaPeakDeg is intentionally ~14° on asphalt (vs plan ~8°) so mid-speed
//     closed-loop steer keeps geometric yaw; dirt/mud use later peaks.
// Config spelling is British `tyre` (vehicleConfig.ground.tyre) to match the
// plan doc; TireEffects keeps US `tire` for particle systems.

export const DEFAULT_TYRE = Object.freeze({
  vFloor: 2.0,
  blendBelow: 1.5,
  mu0Long: 1.6,
  mu0Lat: 1.7,
  // Absolute μ reference for controller scaling (asphalt peak). Surfaces with
  // lower mu0 produce lower frictionSlip / sideFriction relative to this.
  muRefLong: 1.6,
  muRefLat: 1.7,
  kLoad: 0.15,
  Fz0: 0.25, // fraction of vehicle weight (mg) used as ref load per wheel ≈ mg/4
  long: Object.freeze({ K: 9.0, scale: 8.0, kappaPeak: 0.18 }),
  // 14°: Tier-A tradeoff vs plan ~8° — preserves mid-speed steer yaw on asphalt.
  lat: Object.freeze({ K: 10.0, alphaPeakDeg: 14 }),
  combinedEllipse: true,
  // Residual grip past the peak so slides stay recoverable (F6).
  residualMin: 0.38,
  // Maps unit envelope (0..1) onto controller base frictionSlip / sideFriction.
  controllerLongGain: 1.0,
  controllerLatGain: 1.0,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mergeSection(base, override) {
  return { ...base, ...(override ?? {}) };
}

/** Deep-resolve tyre config with defaults. Null-safe. */
export function resolveTyreConfig(config = {}) {
  const c = config ?? {};
  return {
    ...DEFAULT_TYRE,
    ...c,
    long: mergeSection(DEFAULT_TYRE.long, c.long),
    lat: mergeSection(DEFAULT_TYRE.lat, c.lat),
  };
}

/**
 * Slip angle α (rad). Positive = sliding toward wheel +lateral.
 * Blends to 0 below blendBelow so parked tyres don't scream.
 */
export function computeSlipAngle(vLong, vLat, {
  vFloor = DEFAULT_TYRE.vFloor,
  blendBelow = DEFAULT_TYRE.blendBelow,
} = {}) {
  const floor = Math.max(Math.abs(vLong), vFloor);
  let alpha = Math.atan2(vLat, floor);
  const speed = Math.hypot(vLong, vLat);
  if (speed < blendBelow) {
    alpha *= speed / Math.max(1e-4, blendBelow);
  }
  return alpha;
}

/**
 * Slip ratio κ. Positive = driven (wheel spinning faster than ground).
 * Crawl noise is damped only when BOTH ground speed and wheel surface speed are
 * low. Standstill wheelspin (|ωr| high, |vLong|≈0) keeps finite κ so launch TC /
 * combined-slip / longAvail still fire.
 */
export function computeSlipRatio(wheelSurfaceSpeedSigned, vLong, {
  vFloor = DEFAULT_TYRE.vFloor,
  blendBelow = DEFAULT_TYRE.blendBelow,
} = {}) {
  const denom = Math.max(Math.abs(vLong), vFloor);
  let kappa = (wheelSurfaceSpeedSigned - vLong) / denom;
  const v = Math.abs(vLong);
  const wheel = Math.abs(wheelSurfaceSpeedSigned);
  if (v < blendBelow && wheel < blendBelow) {
    const t = Math.max(v, wheel) / Math.max(1e-4, blendBelow);
    kappa *= t;
  }
  return kappa;
}

/** Load-sensitive peak μ: heavier-loaded tyre → lower peak friction. */
export function loadSensitiveMu(mu0, Fz, Fz0, kLoad = DEFAULT_TYRE.kLoad) {
  const ref = Math.max(1e-4, Fz0);
  const mu = mu0 * (1 - kLoad * (Math.max(0, Fz) / ref - 1));
  return clamp(mu, mu0 * 0.4, mu0 * 1.35);
}

/**
 * Sine envelope: rises to a peak then falls gently toward residualMin.
 * `x` is the slip measure (α rad or shaped κ); K scales peak location.
 */
export function sineEnvelope(x, K, residualMin = DEFAULT_TYRE.residualMin) {
  const k = Math.max(1e-4, K);
  const t = Math.min(Math.abs(x) * k, Math.PI - 0.12);
  const raw = Math.sin(t);
  const peakT = Math.PI * 0.5;
  if (t <= peakT) return raw;
  const fall = (t - peakT) / (Math.PI - 0.12 - peakT);
  return clamp(raw * (1 - fall) + residualMin * fall, residualMin, 1);
}

/**
 * Pure longitudinal envelope from slip ratio (telemetry / capability shape).
 */
export function longitudinalEnvelope(kappa, longCfg = DEFAULT_TYRE.long, residualMin = DEFAULT_TYRE.residualMin) {
  const peak = Math.max(1e-4, longCfg.kappaPeak ?? 0.18);
  const scale = longCfg.scale ?? 8;
  const soft = Math.atan(Math.abs(kappa) * scale) / Math.atan(peak * scale);
  const K = longCfg.K ?? 9;
  const x = soft * (Math.PI / (2 * K));
  return sineEnvelope(x, K, residualMin);
}

/**
 * Pure lateral envelope from slip angle (rad) — telemetry / capability shape.
 */
export function lateralEnvelope(alpha, latCfg = DEFAULT_TYRE.lat, residualMin = DEFAULT_TYRE.residualMin) {
  const K = latCfg.K ?? 10;
  if (Number.isFinite(latCfg.alphaPeakDeg) && latCfg.alphaPeakDeg > 0) {
    const peak = latCfg.alphaPeakDeg * (Math.PI / 180);
    const soft = Math.abs(alpha) / peak;
    const x = soft * (Math.PI / (2 * K));
    return sineEnvelope(x, K, residualMin);
  }
  return sineEnvelope(alpha, K, residualMin);
}

/**
 * Friction ellipse: if (fx)² + (fy)² > 1, scale both down.
 * Used by available-grip combined-slip path (demand-normalised).
 */
export function combineFrictionEllipse(fxN, fyN, enabled = true) {
  const fx = Math.abs(fxN);
  const fy = Math.abs(fyN);
  const r2 = fx * fx + fy * fy;
  const usage = Math.sqrt(r2);
  if (!enabled || r2 <= 1 || r2 < 1e-12) {
    return { fxN: fx, fyN: fy, ellipseUsage: usage };
  }
  const s = 1 / Math.sqrt(r2);
  return { fxN: fx * s, fyN: fy * s, ellipseUsage: 1 };
}

/**
 * Post-peak available-grip scale. K sharpens falloff (higher K = steeper).
 * Returns 1 through the linear region, residual..1 past peak.
 */
export function availableGripScale(slipAbs, peak, K, residualMin) {
  if (!(peak > 0) || slipAbs <= peak) return 1;
  const t = (slipAbs - peak) / peak;
  // K scales falloff: map K≈10 → base rate 0.85; lower K (dirt) → softer.
  const rate = 0.55 + 0.04 * clamp(K, 4, 14);
  return residualMin + (1 - residualMin) / (1 + t * t * rate);
}

/**
 * Resolve per-wheel tyre grip for controller-slip path.
 */
export function resolveTyreGrip({
  alpha = 0,
  kappa = 0,
  Fz = 0,
  weight = 1000 * 9.81,
  tyre = null,
  mu0Long = null,
  mu0Lat = null,
  Klat = null,
  Klong = null,
  baseFrictionSlip = 2.0,
  baseSideFriction = 0.9,
  handbrakeScale = 1,
  // Lateral-only multiplier (drift recovery). Does not affect longitudinal.
  latScale = 1,
} = {}) {
  const cfg = resolveTyreConfig(tyre);
  const FzSafe = Math.max(0, Fz);
  const Fz0 = Math.max(1, weight * (cfg.Fz0 ?? 0.25));
  const muL0 = mu0Long ?? cfg.mu0Long;
  const muY0 = mu0Lat ?? cfg.mu0Lat;
  // Surface K overrides peak sharpness — no double-scale by DEFAULT ratio.
  const latK = Klat ?? cfg.lat.K ?? DEFAULT_TYRE.lat.K;
  const longK = Klong ?? cfg.long.K ?? DEFAULT_TYRE.long.K;

  const muLong = loadSensitiveMu(muL0, FzSafe, Fz0, cfg.kLoad);
  const muLat = loadSensitiveMu(muY0, FzSafe, Fz0, cfg.kLoad);

  // Capability envelopes (telemetry).
  const pureLong = longitudinalEnvelope(kappa, { ...cfg.long, K: longK }, cfg.residualMin);
  const pureLat = lateralEnvelope(alpha, { ...cfg.lat, K: latK, alphaPeakDeg: cfg.lat.alphaPeakDeg }, cfg.residualMin);

  const kappaPeak = cfg.long.kappaPeak ?? 0.18;
  const alphaPeak = (cfg.lat.alphaPeakDeg ?? DEFAULT_TYRE.lat.alphaPeakDeg) * (Math.PI / 180);
  const residual = cfg.residualMin ?? DEFAULT_TYRE.residualMin;
  const absAlpha = Math.abs(alpha);
  const absKappa = Math.abs(kappa);

  // Available grip: full through peak, K-shaped falloff after.
  let latAvail = availableGripScale(absAlpha, alphaPeak, latK, residual);
  let longAvail = availableGripScale(absKappa, kappaPeak, longK, residual);

  // Combined-slip via demand ellipse (normalised by peak).
  const longDemand = absKappa / Math.max(1e-4, kappaPeak);
  const latDemand = absAlpha / Math.max(1e-4, alphaPeak);
  let ellipseUsage = Math.min(1, Math.hypot(Math.min(1, longDemand), Math.min(1, latDemand)));
  let latCut = 1;
  let longCut = 1;
  if (cfg.combinedEllipse !== false) {
    // Feed capability-weighted demand into the ellipse so wheelspin steals lat.
    const { fxN: demFx, fyN: demFy, ellipseUsage: eu } = combineFrictionEllipse(
      longDemand * longAvail,
      latDemand * latAvail,
      true,
    );
    ellipseUsage = eu;
    if (longDemand * longAvail > 1e-6) {
      longCut = clamp(demFx / (longDemand * longAvail), 0.15, 1);
    }
    if (latDemand * latAvail > 1e-6) {
      latCut = clamp(demFy / (latDemand * latAvail), 0.15, 1);
    }
  }

  // Absolute μ vs asphalt reference so dirt/mud mu0 actually lowers grip.
  const muRefLong = cfg.muRefLong ?? DEFAULT_TYRE.muRefLong;
  const muRefLat = cfg.muRefLat ?? DEFAULT_TYRE.muRefLat;
  const muLongScale = muLong / Math.max(1e-4, muRefLong);
  const muLatScale = muLat / Math.max(1e-4, muRefLat);

  const fxN = longAvail * muLongScale * longCut;
  const fyN = latAvail * muLatScale * latCut;

  const hb = clamp(handbrakeScale, 0.02, 1.5);
  const latMult = clamp(latScale, 0.05, 2.5);
  const longFactor = clamp(fxN, 0.12, 1.6);
  const latFactor = clamp(fyN, 0.12, 1.6);

  const frictionSlip = baseFrictionSlip * longFactor * cfg.controllerLongGain * hb;
  const sideFrictionStiffness = baseSideFriction * latFactor * cfg.controllerLatGain * hb * latMult;

  return {
    frictionSlip,
    sideFrictionStiffness,
    alpha,
    kappa,
    Fz: FzSafe,
    muLong,
    muLat,
    pureLong,
    pureLat,
    fxN,
    fyN,
    ellipseUsage,
    longFactor,
    latFactor,
    latAvail,
    longAvail,
    latCut,
    longCut,
  };
}

/**
 * Contact-frame slip state from chassis kinematics.
 */
export function computeContactSlip({
  contactVel,
  wheelForward,
  wheelLateral,
  angularVelocity = 0,
  wheelRadius = 0.38,
  vFloor = DEFAULT_TYRE.vFloor,
  blendBelow = DEFAULT_TYRE.blendBelow,
} = {}) {
  const cv = contactVel ?? { x: 0, y: 0, z: 0 };
  const wf = wheelForward ?? { x: 0, y: 0, z: -1 };
  const wl = wheelLateral ?? { x: 1, y: 0, z: 0 };
  const vLong = cv.x * wf.x + cv.y * wf.y + cv.z * wf.z;
  const vLat = cv.x * wl.x + cv.y * wl.y + cv.z * wl.z;
  const wheelSurface = angularVelocity * wheelRadius;
  const alpha = computeSlipAngle(vLong, vLat, { vFloor, blendBelow });
  const kappa = computeSlipRatio(wheelSurface, vLong, { vFloor, blendBelow });
  return { vLong, vLat, alpha, kappa, wheelSurface };
}
