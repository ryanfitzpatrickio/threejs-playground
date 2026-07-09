// Arcade drift assist: countersteer, slip-target yaw, recovery catch.
// Pure math — no Three/Rapier. ON by default for sim-cade (V-Rally) feel.

export const DEFAULT_DRIFT_ASSIST = Object.freeze({
  enabled: true,
  strength: 1.0,
  countersteerMax: 0.35, // rad added to player steer
  slipTriggerDeg: 12, // rear |α| activates assist
  yawTargetGain: 1.2,
  recoveryEnvelopeDeg: 45,
  // Extra lateral grip scale when past recovery envelope (blends in).
  recoveryGripBoost: 0.55,
  // Throttle bias toward target rear slip (RWD wheelspin demand), −1..1.
  throttleBiasGain: 0.15,
  targetSlipDeg: 22,
  minSpeed: 4, // m/s — no assist when crawling
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function resolveDriftAssistConfig(config = {}) {
  return { ...DEFAULT_DRIFT_ASSIST, ...(config ?? {}) };
}

/**
 * @param {object} input
 * @param {number} input.rearAlpha - average rear slip angle (rad), signed
 * @param {number} input.yawRate - body yaw rate about up (rad/s), signed
 * @param {number} input.steer - player steer −1..1
 * @param {number} input.speed - |forward speed| m/s
 * @param {number} input.throttle - −1..1
 * @param {number} [input.frontAlpha]
 * @param {object} [input.config]
 * @returns {{
 *   steerAdd: number,          // rad to add to front wheel steer angle
 *   recoveryGripScale: number, // multiplies rear lateral grip (≥1 when recovering)
 *   throttleBias: number,      // added to effective throttle for powertrain (−0.3..0.3)
 *   active: boolean,
 *   countersteerActive: boolean,
 *   recoveryActive: boolean,
 *   slipDeg: number,
 * }}
 */
export function computeDriftAssist({
  rearAlpha = 0,
  yawRate = 0,
  steer = 0,
  speed = 0,
  throttle = 0,
  frontAlpha = 0,
  config = null,
} = {}) {
  const cfg = resolveDriftAssistConfig(config ?? {});
  const slipDeg = Math.abs(rearAlpha) * (180 / Math.PI);
  const yawMag = Math.abs(yawRate);
  const empty = {
    steerAdd: 0,
    recoveryGripScale: 1,
    throttleBias: 0,
    yawTargetRate: 0,
    active: false,
    countersteerActive: false,
    recoveryActive: false,
    slipDeg,
  };
  if (cfg.enabled === false || cfg.strength <= 0 || speed < (cfg.minSpeed ?? 4)) {
    return empty;
  }

  const strength = clamp(cfg.strength, 0, 2);
  const trigger = cfg.slipTriggerDeg ?? 12;

  // Recovery can arm from large yaw even before rear α has built (seeded spin /
  // snap oversteer). Do this before the α-only early-out.
  const envelope = cfg.recoveryEnvelopeDeg ?? 45;
  let recoveryGripScale = 1;
  let recoveryActive = false;
  let recoveryT = 0;
  if (slipDeg > envelope * 0.7) {
    recoveryT = clamp((slipDeg - envelope * 0.7) / Math.max(1e-3, envelope * 0.3), 0, 1);
    recoveryGripScale = 1 + (cfg.recoveryGripBoost ?? 0.55) * recoveryT * strength;
    recoveryActive = recoveryT > 0.1;
  }
  // Yaw-based recovery only above true spin rates — must stay clear of normal
  // mid-speed cornering peaks (~0.6 rad/s) so we don't kill steer yaw response.
  // Hysteresis: once α-recovery is active, hold a soft floor down to 0.55.
  if (yawMag > 1.05 || (recoveryActive && yawMag > 0.55)) {
    const floor = recoveryActive ? 0.55 : 1.05;
    const yt = clamp((yawMag - floor) / 1.1, 0, 1);
    if (yt > recoveryT) recoveryT = yt;
    recoveryGripScale = Math.max(recoveryGripScale, 1 + 0.5 * recoveryT * strength);
    recoveryActive = recoveryActive || yt > 0.1;
  }

  // Activation: rear slip OR recovery-from-yaw.
  const slipActivate = clamp((slipDeg - trigger * 0.5) / Math.max(1e-3, trigger * 0.5), 0, 1);
  const activate = Math.max(slipActivate, recoveryActive ? recoveryT : 0);
  if (activate < 0.05) {
    return empty;
  }
  const s = strength * Math.max(activate, 0.05);

  // Countersteer in wheel-angle space (matches setWheelSteering): opposes rear α
  // so the front end turns into the slide. Stronger during recovery.
  const yawAway = Math.sign(yawRate) !== 0
    && Math.sign(rearAlpha) !== 0
    && Math.sign(yawRate) === Math.sign(rearAlpha);
  const csScale = (yawAway || recoveryActive ? 1 : 0.55) * (recoveryActive ? 1.5 : 1);
  const csMag = (cfg.countersteerMax ?? 0.35) * Math.max(s, recoveryActive ? 0.6 : 0) * csScale
    * clamp(Math.max(slipDeg, yawMag * 14) / Math.max(1, cfg.targetSlipDeg ?? 22), 0, 1.6);
  const steerAdd = -Math.sign(rearAlpha || yawRate) * csMag;

  // Yaw-target: controlled drift holds a sideslip yaw rate; recovery drives to 0.
  const targetSlip = (cfg.targetSlipDeg ?? 22) * (Math.PI / 180) * Math.sign(rearAlpha || 1);
  const yawTargetRate = recoveryActive
    ? 0
    : targetSlip * (cfg.yawTargetGain ?? 1.2) * 0.15;

  // Throttle balance: below target slip, nudge throttle up; above / recovering, feather.
  let throttleBias = 0;
  if (Math.abs(throttle) > 0.05) {
    if (recoveryActive) {
      // Cut power during spin recovery so the tail can grip.
      throttleBias = -0.25 * recoveryT * strength * Math.sign(throttle || 1);
    } else {
      const err = (cfg.targetSlipDeg ?? 22) - slipDeg;
      throttleBias = clamp(
        err / 40 * (cfg.throttleBiasGain ?? 0.15) * s * Math.sign(throttle || 1),
        -0.3,
        0.3,
      );
    }
  }

  return {
    steerAdd,
    recoveryGripScale,
    throttleBias,
    yawTargetRate,
    active: s > 0.05,
    countersteerActive: Math.abs(steerAdd) > 0.01,
    recoveryActive,
    slipDeg,
    activate,
    frontAlpha,
    steer,
  };
}
