// Layered engine sound sets for EngineAudio (https://github.com/markeasting/engine-audio style).
//
// Each profile supplies looping on/off-load layers (low + high RPM ranges) plus optional
// limiter, transmission, and idle layers. The BAC profile is taken directly from the reference's
// bac_mono configuration (same filenames, bufferRpm anchors, and volume balance).
// 'quad' adds a dedicated idle loop for ATV/quad bike engines.

export const ENGINE_PROFILE_IDS = Object.freeze({
  bac: 'bac',
  boxer: 'boxer',
  quad: 'quad',
  electric: 'electric',
});

export const DEFAULT_ENGINE_PROFILE = ENGINE_PROFILE_IDS.bac;

const BAC_ENGINE_SOUNDS = {
  // https://github.com/markeasting/engine-audio (BAC Mono config)
  on_low: {
    source: '/audio/engine/BAC_Mono_onlow.wav',
    bufferRpm: 1000,
    volume: 0.5,
  },
  on_high: {
    source: '/audio/engine/BAC_Mono_onhigh.wav',
    bufferRpm: 1000,
    volume: 0.5,
  },
  off_low: {
    source: '/audio/engine/BAC_Mono_offlow.wav',
    bufferRpm: 1000,
    volume: 0.5,
  },
  off_high: {
    source: '/audio/engine/BAC_Mono_offveryhigh.wav',
    bufferRpm: 1000,
    volume: 0.5,
  },
  limiter: {
    source: '/audio/engine/limiter.wav',
    bufferRpm: 8000,
    volume: 0.4,
  },
  tranny_on: {
    source: '/audio/engine/trany_power_high.wav',
    bufferRpm: 0,
    volume: 0.4,
  },
  tranny_off: {
    source: '/audio/engine/tw_offlow.wav',
    bufferRpm: 0,
    volume: 0.2,
  },
};

const BOXER_ENGINE_SOUNDS = {
  // Looping on/off load layers (the "loop to play afterwards")
  // on_low / on_high updated with new custom loop samples (newlowloadon / newhighloadon)
  on_low: {
    source: '/audio/engine/boxer/on-low.mp3',
    bufferRpm: 1000,
    volume: 0.5,
  },
  on_high: {
    source: '/audio/engine/boxer/on-high.mp3',
    bufferRpm: 1000,
    volume: 0.5,
  },
  off_low: {
    source: '/audio/engine/boxer/off-low.mp3',
    bufferRpm: 1000,
    volume: 0.5,
  },
  off_high: {
    source: '/audio/engine/boxer/off-high.mp3',
    bufferRpm: 1000,
    volume: 0.5,
  },
  // One-shot accents for on-load events (the initial transients/punch).
  // These are triggered once when throttle/load is applied, then the on-* loops sustain.
  // Two provided per on-load range (low/high) because one is the one-shot and one the loop.
  on_accent_low: {
    source: '/audio/engine/boxer/low-one-shot.mp3',
    oneShot: true,
    volume: 0.85,
  },
  on_accent_high: {
    source: '/audio/engine/boxer/high-one-shot.mp3',
    oneShot: true,
    volume: 0.85,
  },
};

const QUAD_ENGINE_SOUNDS = {
  // Quad bike / ATV engine: dedicated idle + on-load / off-load layers.
  // Provided by user as quadidle / quadonlow etc; mapped to standard layered keys.
  idle: {
    source: '/audio/engine/quad/idle.mp3',
    bufferRpm: 900,
    volume: 0.85,
  },
  on_low: {
    source: '/audio/engine/quad/on-low.mp3',
    bufferRpm: 1100,
    volume: 0.58,
  },
  on_high: {
    source: '/audio/engine/quad/on-high.mp3',
    bufferRpm: 1100,
    volume: 0.58,
  },
  off_low: {
    source: '/audio/engine/quad/off-low.mp3',
    bufferRpm: 950,
    volume: 0.45,
  },
  off_high: {
    source: '/audio/engine/quad/off-high.mp3',
    bufferRpm: 950,
    volume: 0.45,
  },
};

const ELECTRIC_ENGINE_SOUNDS = {
  on_low: {
    source: '/audio/engine/electric/on-low.mp3',
    bufferRpm: 2400,
    volume: 0.54,
  },
  on_high: {
    source: '/audio/engine/electric/on-high.mp3',
    bufferRpm: 5600,
    volume: 0.54,
  },
  inverter_low: {
    source: '/audio/engine/electric/inverter-low.mp3',
    bufferRpm: 2800,
    volume: 0.4,
  },
  inverter_high: {
    source: '/audio/engine/electric/inverter-high.mp3',
    bufferRpm: 6000,
    volume: 0.4,
  },
  road_hiss: {
    source: '/audio/engine/electric/road-hiss.mp3',
    bufferRpm: 0,
    volume: 0.46,
    pitch: false,
  },
  regen: {
    source: '/audio/engine/electric/regen.mp3',
    bufferRpm: 0,
    volume: 0.5,
    pitch: false,
  },
  throttle_punch: {
    source: '/audio/engine/electric/throttle-punch.mp3',
    oneShot: true,
    volume: 0.78,
  },
};

const ELECTRIC_EXTERIOR_IDLE_URL = '/audio/engine/electric/exterior-idle.mp3';

export const ENGINE_PROFILES = Object.freeze({
  [ENGINE_PROFILE_IDS.bac]: BAC_ENGINE_SOUNDS,
  [ENGINE_PROFILE_IDS.boxer]: BOXER_ENGINE_SOUNDS,
  [ENGINE_PROFILE_IDS.quad]: QUAD_ENGINE_SOUNDS,
  [ENGINE_PROFILE_IDS.electric]: ELECTRIC_ENGINE_SOUNDS,
});

/** @deprecated Use resolveEngineSounds() or ENGINE_PROFILES.bac */
export const DEFAULT_ENGINE_SOUNDS = BAC_ENGINE_SOUNDS;

export function resolveEngineProfile(profileId) {
  const id = String(profileId || DEFAULT_ENGINE_PROFILE).toLowerCase();
  return ENGINE_PROFILES[id] ? id : DEFAULT_ENGINE_PROFILE;
}

export function resolveEngineSounds(profileId) {
  const profile = ENGINE_PROFILES[resolveEngineProfile(profileId)];
  return profile ?? null;
}

export function isElectricEngineProfile(profileId) {
  return resolveEngineProfile(profileId) === ENGINE_PROFILE_IDS.electric;
}

export function resolveExteriorIdleUrl(profileId) {
  return isElectricEngineProfile(profileId)
    ? ELECTRIC_EXTERIOR_IDLE_URL
    : '/audio/vehicles/car-idle-exterior.mp3';
}

/** @deprecated Use isElectricEngineProfile() — electric is sample-based now. */
export function isProceduralEngineProfile(profileId) {
  return false;
}

export function getEngineAudioTuning(profileId) {
  const id = resolveEngineProfile(profileId);
  if (id === 'quad') {
    // Quad/ATV: lower revving, torquey, distinct from high-rev muscle car profiles.
    // Crossfades tuned to typical quad RPM range so layers blend at realistic points.
    return Object.freeze({
      crossfadeLow: 1600,
      crossfadeHigh: 4800,
      throttleCrossfade: 0.9,
      pitchFactor: 0.14,
      limiterStartRpm: 5200,
      masterVolume: 0.36,
    });
  }
  return Object.freeze({
    crossfadeLow: 3000,
    crossfadeHigh: 6500,
    throttleCrossfade: 1.0,
    pitchFactor: 0.2,
    limiterStartRpm: 6800,
    masterVolume: 0.4,
  });
}
