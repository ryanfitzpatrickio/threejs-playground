import * as THREE from 'three';

export const DEFAULT_MUD_WHEEL_DYNAMICS = Object.freeze({
  slipBands: Object.freeze([
    Object.freeze({ slip: 0.05, intensity: 0 }),
    Object.freeze({ slip: 0.15, intensity: 0.08 }),
    Object.freeze({ slip: 0.30, intensity: 0.28 }),
    Object.freeze({ slip: 0.50, intensity: 0.52 }),
    Object.freeze({ slip: 0.80, intensity: 0.82 }),
    Object.freeze({ slip: 1.00, intensity: 1 }),
  ]),
  loadForce: 300,
  baseSoftness: 0.62,
  rutSoftness: 0.38,
  rutAmplification: 0.45,
  brakingScale: 0.38,
  brakingRearScale: 0.18,
  speedTaper: Object.freeze({ start: 12, end: 38, minimum: 0.08, extremeSlipRetention: 0.78 }),
  landing: Object.freeze({ minAirTime: 0.08, minDuration: 0.2, maxDuration: 0.5, intensity: 0.85 }),
  grip: Object.freeze({ maxRutLoss: 0.35, longitudinalRutLoss: 0.28, lateralRutLoss: 0.35 }),
  emission: Object.freeze({ clodPerIntensity: 150, liquidPerIntensity: 620 }),
});

function mergedSection(base, override) {
  return { ...base, ...(override ?? {}) };
}

export function resolveMudWheelDynamics(config = {}) {
  return {
    ...DEFAULT_MUD_WHEEL_DYNAMICS,
    ...config,
    slipBands: config.slipBands ?? DEFAULT_MUD_WHEEL_DYNAMICS.slipBands,
    speedTaper: mergedSection(DEFAULT_MUD_WHEEL_DYNAMICS.speedTaper, config.speedTaper),
    landing: mergedSection(DEFAULT_MUD_WHEEL_DYNAMICS.landing, config.landing),
    grip: mergedSection(DEFAULT_MUD_WHEEL_DYNAMICS.grip, config.grip),
    emission: mergedSection(DEFAULT_MUD_WHEEL_DYNAMICS.emission, config.emission),
  };
}

export function mudSlipBandIntensity(slip, bands = DEFAULT_MUD_WHEEL_DYNAMICS.slipBands) {
  const value = Math.max(0, Number(slip) || 0);
  if (value < (bands[0]?.slip ?? 0.05)) return 0;
  for (let i = 1; i < bands.length; i += 1) {
    const lower = bands[i - 1];
    const upper = bands[i];
    if (value < upper.slip) {
      const alpha = (value - lower.slip) / Math.max(1e-6, upper.slip - lower.slip);
      return THREE.MathUtils.lerp(lower.intensity, upper.intensity, alpha);
    }
  }
  return bands.at(-1)?.intensity ?? 1;
}

export function computeMudWheelIntensity({
  slip = 0,
  torque = 0,
  braking = false,
  isFront = false,
  load = 0,
  softness = 0,
  rutDepth = 0,
  speed = 0,
  landing = 0,
}, config = DEFAULT_MUD_WHEEL_DYNAMICS) {
  const cfg = resolveMudWheelDynamics(config);
  const slipIntensity = mudSlipBandIntensity(slip, cfg.slipBands);
  const rut = THREE.MathUtils.clamp(rutDepth, 0, 1);
  const soft = THREE.MathUtils.clamp(softness + rut * cfg.rutAmplification, 0, 1.5);
  const normalizedLoad = THREE.MathUtils.clamp(load, 0, 1.5);
  let torqueSignal = THREE.MathUtils.clamp(Math.abs(torque), 0, 1);
  if (braking) {
    torqueSignal *= cfg.brakingScale * (isFront ? 1 : cfg.brakingRearScale);
  }
  const digEnergy = slipIntensity * torqueSignal * normalizedLoad * soft;
  const taperCfg = cfg.speedTaper;
  const speedTaper = THREE.MathUtils.lerp(
    1,
    taperCfg.minimum,
    THREE.MathUtils.smoothstep(Math.abs(speed), taperCfg.start, taperCfg.end),
  );
  const extreme = THREE.MathUtils.smoothstep(
    slip,
    Math.max(0.5, cfg.slipBands.at(-2)?.slip ?? 0.8),
    1,
  );
  const retainedTaper = Math.max(speedTaper, extreme * taperCfg.extremeSlipRetention);
  return THREE.MathUtils.clamp(Math.max(digEnergy * retainedTaper, landing), 0, 1);
}

export function computeMudGripScales(rutDepth, slip, config = DEFAULT_MUD_WHEEL_DYNAMICS) {
  const cfg = resolveMudWheelDynamics(config).grip;
  const rut = THREE.MathUtils.clamp(rutDepth, 0, 1);
  const slip01 = THREE.MathUtils.clamp(slip, 0, 1);
  return {
    longitudinal: 1 - Math.min(cfg.maxRutLoss, rut * cfg.longitudinalRutLoss * (0.65 + 0.35 * slip01)),
    lateral: 1 - Math.min(cfg.maxRutLoss, rut * cfg.lateralRutLoss * (0.75 + 0.25 * slip01)),
  };
}
