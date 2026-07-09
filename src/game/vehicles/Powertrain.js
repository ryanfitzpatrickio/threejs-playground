// Engine torque curve + gears + clutch for Tier-A controller-slip handling.
// Pure math — no Three/Rapier. Outputs total drive force demand for the diff.

export const DEFAULT_POWERTRAIN = Object.freeze({
  enabled: true,
  driveLayout: 'rwd', // muscle default; rally builds override to 'awd'
  engine: Object.freeze({
    idleRPM: 900,
    peakRPM: 6000,
    redline: 7200,
    peakTorque: 220, // N·m
    // Torque shape: rises to peak then falls toward redline.
    idleTorqueFrac: 0.55,
    redlineTorqueFrac: 0.72,
  }),
  gears: Object.freeze([3.5, 2.1, 1.45, 1.05, 0.82]),
  finalDrive: 3.9,
  shiftTime: 0.18,
  autoShift: true,
  upshiftRPM: 6400,
  downshiftRPM: 2200,
  clutch: Object.freeze({
    slipGain: 4.0,
    maxLock: 1.0,
  }),
  // When powertrain is enabled, scale peak force so flat enginePower feel is close.
  // totalForce ≈ (T_wheel / wheelRadius) but we output a body-comparable Newton force.
  forceScale: 1.0,
  wheelRadius: 0.38,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mergeSection(base, override) {
  return { ...base, ...(override ?? {}) };
}

export function resolvePowertrainConfig(config = {}) {
  const c = config ?? {};
  return {
    ...DEFAULT_POWERTRAIN,
    ...c,
    engine: mergeSection(DEFAULT_POWERTRAIN.engine, c.engine),
    clutch: mergeSection(DEFAULT_POWERTRAIN.clutch, c.clutch),
    gears: c.gears ?? DEFAULT_POWERTRAIN.gears,
  };
}

/**
 * Engine torque curve T_e(ω) in N·m. Piecewise: idle → peak → redline.
 */
export function engineTorque(rpm, engineCfg = DEFAULT_POWERTRAIN.engine) {
  const idle = engineCfg.idleRPM ?? 900;
  const peak = engineCfg.peakRPM ?? 6000;
  const red = engineCfg.redline ?? 7200;
  const Tpeak = engineCfg.peakTorque ?? 220;
  const idleFrac = engineCfg.idleTorqueFrac ?? 0.55;
  const redFrac = engineCfg.redlineTorqueFrac ?? 0.72;
  const r = clamp(rpm, 0, red * 1.05);
  if (r <= idle) {
    return Tpeak * idleFrac * (r / Math.max(1, idle));
  }
  if (r <= peak) {
    const t = (r - idle) / Math.max(1, peak - idle);
    // Smoothstep toward peak.
    const s = t * t * (3 - 2 * t);
    return Tpeak * (idleFrac + (1 - idleFrac) * s);
  }
  // Falloff past peak toward redline.
  const t = clamp((r - peak) / Math.max(1, red - peak), 0, 1);
  return Tpeak * (1 + (redFrac - 1) * t);
}

/**
 * Gear ratio including final drive. gearIndex is 1-based (1 = first).
 */
export function gearRatio(gearIndex, gears, finalDrive) {
  const list = gears ?? DEFAULT_POWERTRAIN.gears;
  const idx = clamp(Math.floor(gearIndex), 1, list.length) - 1;
  return (list[idx] ?? 1) * (finalDrive ?? DEFAULT_POWERTRAIN.finalDrive);
}

/**
 * Wheel torque (N·m) from engine through clutch and gear.
 */
export function wheelTorqueFromEngine({
  rpm,
  throttle = 0,
  gearIndex = 1,
  clutchLock = 1,
  config = null,
} = {}) {
  const cfg = resolvePowertrainConfig(config ?? {});
  const Te = engineTorque(rpm, cfg.engine) * clamp(throttle, -1, 1);
  const gr = gearRatio(gearIndex, cfg.gears, cfg.finalDrive);
  const lock = clamp(clutchLock, 0, cfg.clutch.maxLock ?? 1);
  return Te * gr * lock;
}

/**
 * Convert wheel torque to longitudinal force (N) at the contact patch.
 */
export function wheelForceFromTorque(torqueNm, wheelRadius = 0.38) {
  const r = Math.max(0.05, wheelRadius);
  return torqueNm / r;
}

/**
 * Advance powertrain state one fixed step.
 *
 * @returns {{
 *   totalDriveForce: number,  // Newtons, sign = throttle sign (positive = forward demand)
 *   rpm: number,
 *   gear: number,
 *   clutchLock: number,
 *   shifting: boolean,
 *   wheelTorque: number,
 * }}
 */
export function stepPowertrain({
  rpm = 900,
  gear = 1,
  throttle = 0,
  // Average drive-wheel linear speed along forward (m/s), positive = forward travel.
  driveWheelSpeed = 0,
  brake = 0,
  dt = 1 / 60,
  shiftTimer = 0,
  config = null,
  // Optional flat-power fallback scale when comparing to enginePower*mass.
  mass = 1000,
  enginePower = 7.5,
} = {}) {
  const cfg = resolvePowertrainConfig(config ?? {});
  if (cfg.enabled === false) {
    // Flat model: same shape as BaseVehicle enginePower path (accel * mass).
    const force = throttle * enginePower * mass;
    return {
      totalDriveForce: force,
      rpm,
      gear,
      clutchLock: 1,
      shifting: false,
      shiftTimer: 0,
      wheelTorque: force * (cfg.wheelRadius ?? 0.38),
      peakTorque: cfg.engine.peakTorque,
    };
  }

  const eng = cfg.engine;
  let nextGear = clamp(Math.floor(gear) || 1, 1, cfg.gears.length);
  let timer = Math.max(0, shiftTimer - dt);
  let shifting = timer > 0;

  // Auto shift: upshift only under forward throttle; downshift on low RPM
  // while coasting or light throttle (not in reverse).
  if (cfg.autoShift && !shifting) {
    if (throttle > 0.05
      && rpm > (cfg.upshiftRPM ?? 6400)
      && nextGear < cfg.gears.length) {
      nextGear += 1;
      timer = cfg.shiftTime ?? 0.18;
      shifting = true;
    } else if (throttle >= 0
      && rpm < (cfg.downshiftRPM ?? 2200)
      && nextGear > 1
      && throttle < 0.35) {
      nextGear -= 1;
      timer = cfg.shiftTime ?? 0.18;
      shifting = true;
    }
  }

  const gr = gearRatio(nextGear, cfg.gears, cfg.finalDrive);
  // Wheel angular speed (rad/s) from linear speed.
  const wheelOmega = driveWheelSpeed / Math.max(0.05, cfg.wheelRadius ?? 0.38);
  // Locked engine RPM from driveline.
  const lockedRPM = Math.abs(wheelOmega * gr) * (60 / (2 * Math.PI));
  // Clutch: throttle opens slip; low wheel speed + throttle → launch slip / rev flare.
  const throttleAbs = clamp(Math.abs(throttle), 0, 1);
  const launchSlip = throttleAbs * clamp(1 - Math.abs(driveWheelSpeed) / 5, 0, 1);
  const slipOpen = 1 - clamp(
    throttleAbs * (cfg.clutch.slipGain ?? 4) * 0.12 + launchSlip * 0.55,
    0,
    0.92,
  );
  // During shift, fully open clutch.
  const clutchLock = shifting
    ? 0.05
    : clamp(slipOpen * (0.35 + 0.65 * (1 - launchSlip)) + (1 - throttleAbs) * 0.45, 0.05, cfg.clutch.maxLock ?? 1);

  // Blend RPM toward locked, with flare under open clutch + throttle.
  let nextRPM = rpm;
  if (shifting) {
    // Free-rev toward throttle-demanded RPM.
    const target = eng.idleRPM + throttleAbs * (eng.redline - eng.idleRPM) * 0.85;
    nextRPM = rpm + (target - rpm) * Math.min(1, (cfg.clutch.slipGain ?? 4) * dt);
  } else {
    const target = Math.max(lockedRPM, eng.idleRPM * (1 - throttleAbs * 0.15));
    // Low clutch lock → engine can flare above locked (wheelspin / launch).
    const flare = throttleAbs * (1 - clutchLock) * (eng.peakRPM - eng.idleRPM) * (0.45 + launchSlip * 0.4);
    const freeRev = eng.idleRPM + throttleAbs * (eng.peakRPM - eng.idleRPM) * 0.9;
    const blended = clutchLock > 0.85
      ? target
      : target * clutchLock + freeRev * (1 - clutchLock) * 0.65 + (target + flare) * (1 - clutchLock) * 0.35;
    const follow = 1 - Math.exp(-(4 + clutchLock * 10) * dt);
    nextRPM = rpm + (blended - rpm) * follow;
  }
  nextRPM = clamp(nextRPM, eng.idleRPM * 0.5, eng.redline + 200);
  if (brake > 0.5 && throttleAbs < 0.05) {
    nextRPM = Math.max(eng.idleRPM, nextRPM - 800 * dt);
  }

  const Tw = wheelTorqueFromEngine({
    rpm: nextRPM,
    throttle,
    gearIndex: nextGear,
    clutchLock,
    config: cfg,
  });
  let force = wheelForceFromTorque(Tw, cfg.wheelRadius) * (cfg.forceScale ?? 1);

  // Soft-cap scales gently with gear so 1st out-launches 5th without a rocket
  // squat (full ratio scale blew past the suspension pitch verify ceiling).
  const gearList = cfg.gears ?? DEFAULT_POWERTRAIN.gears;
  const topRatio = gearList[gearList.length - 1] ?? 1;
  const thisRatio = gearList[clamp(nextGear, 1, gearList.length) - 1] ?? 1;
  const rel = thisRatio / Math.max(1e-4, topRatio);
  const gearScale = Math.min(1.4, Math.sqrt(Math.max(1, rel)));
  const flatPeak = Math.abs(enginePower) * mass * 1.28 * gearScale;
  let softCapActive = false;
  if (Math.abs(force) > flatPeak && flatPeak > 0) {
    force *= flatPeak / Math.abs(force);
    softCapActive = true;
  }

  return {
    totalDriveForce: force,
    rpm: nextRPM,
    gear: nextGear,
    clutchLock,
    shifting,
    shiftTimer: timer,
    wheelTorque: Tw,
    peakTorque: eng.peakTorque,
    lockedRPM,
    softCapActive,
    flatPeak,
  };
}
