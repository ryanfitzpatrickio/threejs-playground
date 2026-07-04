// Layered engine sound sets for EngineAudio (https://github.com/markeasting/engine-audio style).
//
// Each profile supplies looping on/off-load layers (low + high RPM ranges) plus optional
// limiter and transmission layers. The BAC profile is taken directly from the reference's
// bac_mono configuration (same filenames, bufferRpm anchors, and volume balance).

export const ENGINE_PROFILE_IDS = Object.freeze({
  bac: 'bac',
  boxer: 'boxer',
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

export const ENGINE_PROFILES = Object.freeze({
  [ENGINE_PROFILE_IDS.bac]: BAC_ENGINE_SOUNDS,
  [ENGINE_PROFILE_IDS.boxer]: BOXER_ENGINE_SOUNDS,
});

/** @deprecated Use resolveEngineSounds() or ENGINE_PROFILES.bac */
export const DEFAULT_ENGINE_SOUNDS = BAC_ENGINE_SOUNDS;

export function resolveEngineProfile(profileId) {
  const id = String(profileId || DEFAULT_ENGINE_PROFILE).toLowerCase();
  return ENGINE_PROFILES[id] ? id : DEFAULT_ENGINE_PROFILE;
}

export function resolveEngineSounds(profileId) {
  return ENGINE_PROFILES[resolveEngineProfile(profileId)];
}
