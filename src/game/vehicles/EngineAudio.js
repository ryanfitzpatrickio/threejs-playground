// EngineAudio.js
// Simple engine sound player modeled after markeasting/engine-audio.
// Loads looping layers and crossfades them based on RPM + throttle.
// Drives realistic pitch shifting and volume blending for on/off load.

import * as THREE from 'three';

const RPM_CROSSFADE_LOW = 3000;
const RPM_CROSSFADE_HIGH = 6500;
const THROTTLE_CROSSFADE = 1.0; // match original library exactly
const RPM_PITCH_FACTOR = 0.2;   // match original

const MASTER_VOLUME = 0.4; // reduced by another 33% (now ~44% of original 0.9)

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.samples = {}; // { on_low: { source, gain, bufferRpm, volume } , ... }
    this._initialized = false;
    this._isMuted = false;
  }

  async init(soundConfig) {
    if (this._initialized) return;

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_VOLUME;

    // Note: we intentionally skip the high-pass here to match the raw demo sound
    // (original repo demo has no high-pass filter on the layers)
    this.masterGain.connect(this.ctx.destination);

    const promises = [];
    for (const [key, cfg] of Object.entries(soundConfig)) {
      promises.push(this._loadLayer(key, cfg));
    }
    await Promise.all(promises);

    // Start all sources at gain 0 (they will be modulated every frame)
    for (const key in this.samples) {
      const s = this.samples[key];
      const source = this.ctx.createBufferSource();
      source.buffer = s.buffer;
      source.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;

      source.connect(gain).connect(this.masterGain);
      source.start();

      s.source = source;
      s.gain = gain;
    }

    this._initialized = true;

    if (this.ctx.state === 'suspended') {
      // Will be resumed on first user interaction (entering vehicle)
    }
  }

  async _loadLayer(key, cfg) {
    const res = await fetch(cfg.source);
    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

    this.samples[key] = {
      buffer: audioBuffer,
      bufferRpm: cfg.bufferRpm ?? 3000,
      volume: cfg.volume ?? 1.0,
      source: null,
      gain: null,
    };
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setMasterVolume(v) {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(2, v));
    }
  }

  update(rpm, throttle, gear = 1, dt = 0.016) {
    if (!this._initialized || !this.ctx || this._isMuted) return;

    const r = Math.max(600, rpm || 800);
    const t = THREE.MathUtils.clamp(throttle ?? 0, 0, 1);
    const g = Math.max(1, Math.min(5, gear || 1));

    // RPM crossfade (low <-> high)
    const rpmX = THREE.MathUtils.clamp(
      (r - RPM_CROSSFADE_LOW) / (RPM_CROSSFADE_HIGH - RPM_CROSSFADE_LOW),
      0,
      1
    );
    const lowGain = Math.cos(rpmX * 0.5 * Math.PI);
    const highGain = Math.cos((1 - rpmX) * 0.5 * Math.PI);

    // Throttle crossfade (off <-> on)
    const onX = THREE.MathUtils.clamp(t / THROTTLE_CROSSFADE, 0, 1);
    const onGain = Math.cos((1 - onX) * 0.5 * Math.PI);
    const offGain = Math.cos(onX * 0.5 * Math.PI);

    // Limiter amount (simple ramp near redline, original uses soft_limiter ratio)
    const limiterGain = THREE.MathUtils.clamp((r - 6800) / (900 - 0), 0, 1.0);

    // Minimal idle baseline to keep engine audible at low RPM (original has no extra)
    const idlePresence = THREE.MathUtils.clamp((1400 - r) / 800, 0, 0.15);

    const setLayer = (key, gainVal, applyPitch = true) => {
      const s = this.samples[key];
      if (!s || !s.gain) return;

      let g = gainVal * (s.volume ?? 1);
      if (g < 0.0001) g = 0;

      s.gain.gain.value = g;

      if (applyPitch && s.source && s.bufferRpm != null) {
        const detune = (r - s.bufferRpm) * RPM_PITCH_FACTOR;
        s.source.detune.value = detune;
      }
    };

    // Core layers — exact same as original library applySounds for BAC samples
    setLayer('on_low', onGain * lowGain);
    setLayer('off_low', offGain * lowGain + idlePresence);
    setLayer('on_high', onGain * highGain);
    setLayer('off_high', offGain * highGain);
    setLayer('limiter', limiterGain, false);

    // Transmission / gear whine layers from the repo (modeled after original engine-audio)
    const trannyGear = g > 0 ? 1 : 0;
    if (this.samples['tranny_on'] && this.samples['tranny_on'].gain) {
      const t = this.samples['tranny_on'];
      t.source.detune.value = r * trannyGear * 0.05 - 100;
      t.gain.gain.value = onGain * (t.volume || 0.4) * trannyGear;
    }
    if (this.samples['tranny_off'] && this.samples['tranny_off'].gain) {
      const t = this.samples['tranny_off'];
      t.source.detune.value = r * trannyGear * 0.035 - 800;
      t.gain.gain.value = offGain * (t.volume || 0.2) * trannyGear;
    }
  }

  mute(state = true) {
    this._isMuted = !!state;
    if (this.masterGain) {
      this.masterGain.gain.value = state ? 0.0 : MASTER_VOLUME;
    }
  }

  dispose() {
    if (this.ctx) {
      try {
        for (const k in this.samples) {
          const s = this.samples[k];
          if (s.source) {
            try { s.source.stop(); } catch {}
          }
        }
        this.ctx.close();
      } catch {}
    }
    this.samples = {};
    this.ctx = null;
    this.masterGain = null;
    this._initialized = false;
  }
}

// Default sound config for the muscle car
export const DEFAULT_ENGINE_SOUNDS = {
  // Real recordings from https://github.com/markeasting/engine-audio (BAC Mono config)
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
  // Transmission layers (gear whine)
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
