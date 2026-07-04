// EngineAudio.js
//
// Layered engine sound player modeled after https://github.com/markeasting/engine-audio
// (MIT © 2025 Mark Oosting).
//
// The core approach (multiple RPM-recorded loops for on-load / off-load at low+high ranges,
// crossfading between them by RPM + throttle/load, pitch detuning proportional to RPM delta,
// plus optional limiter and transmission whine layers) is taken from the reference.
//
// This file implements the playback + blending engine (Web Audio). Sample sets live in
// engineProfiles.js (BAC Mono profile matches the reference's bac_mono configuration exactly;
// boxer is a local variant that adds one-shot on-load accents).

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
    this.samples = {}; // { on_low: { source, gain, bufferRpm, volume, isOneShot? } , ... }
    this._initialized = false;
    this._isMuted = false;
    this._lastThrottle = 0;
    this._lastAccentTime = 0;
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

    // Start all *looping* sources at gain 0 (they will be modulated every frame).
    // One-shot samples (e.g. boxer on-load accents) are kept as buffers only and played on demand.
    for (const key in this.samples) {
      const s = this.samples[key];
      if (s.isOneShot) continue;
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
      isOneShot: !!(cfg.oneShot || /one-?shot/i.test(key)),
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

  /**
   * Play a one-shot / transient sample (e.g. boxer on-load accent).
   * Does not affect the looping layer gains. Safe to call from update.
   */
  playOneShot(key, { volumeScale = 1, rpm = null } = {}) {
    const s = this.samples[key];
    if (!s || !s.buffer || !this.ctx || this._isMuted) return;
    try {
      const source = this.ctx.createBufferSource();
      source.buffer = s.buffer;
      source.loop = false;
      if (rpm != null && s.bufferRpm != null) {
        const detune = (rpm - s.bufferRpm) * RPM_PITCH_FACTOR;
        source.detune.value = detune;
      }
      const gain = this.ctx.createGain();
      const vol = (s.volume ?? 1.0) * volumeScale;
      gain.gain.value = Math.max(0.0001, Math.min(2, vol));
      source.connect(gain).connect(this.masterGain);
      source.start(0);
      source.onended = () => {
        try {
          source.disconnect();
          gain.disconnect();
        } catch {}
      };
    } catch {}
  }

  update(rpm, throttle, gear = 1, dt = 0.016) {
    const r = Math.max(600, rpm || 800);
    const t = THREE.MathUtils.clamp(throttle ?? 0, 0, 1);
    const g = Math.max(1, Math.min(5, gear || 1));

    // Always track throttle for delta detection (even if audio not active yet).
    // Seed on first call so the first real activation does not see a giant delta.
    if (this._lastThrottle === 0 && t < 0.5) {
      this._lastThrottle = t;
    }

    if (!this._initialized || !this.ctx || this._isMuted) {
      this._lastThrottle = t;
      return;
    }

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

    // Trigger boxer on-load one-shot accents (one-shot punch) when throttle rises.
    // The on_* loop layers then provide the sustained sound "afterwards".
    const now = this.ctx ? this.ctx.currentTime : 0;
    const throttleRise = t - this._lastThrottle;
    const ACCENT_COOLDOWN = 0.32;
    const RISE_THRESHOLD = 0.12;
    if (throttleRise > RISE_THRESHOLD && (now - this._lastAccentTime) > ACCENT_COOLDOWN) {
      this._lastAccentTime = now;
      const useHigh = r > RPM_CROSSFADE_LOW + 400;
      const accentKey = useHigh ? 'on_accent_high' : 'on_accent_low';
      const accent = this.samples[accentKey];
      if (accent && accent.isOneShot) {
        const punch = THREE.MathUtils.clamp(throttleRise, 0.12, 1);
        const scale = punch * (0.65 + 0.35 * onGain);
        this.playOneShot(accentKey, { volumeScale: scale, rpm: r });
      }
    }

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

    this._lastThrottle = t;
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

// Default sound config for the muscle car — see engineProfiles.js for all profiles.
export { DEFAULT_ENGINE_SOUNDS } from './engineProfiles.js';
