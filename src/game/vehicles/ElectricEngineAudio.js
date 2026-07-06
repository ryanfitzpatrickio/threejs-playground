// Layered electric drivetrain audio — sample loops + one-shot punch (see engineProfiles.js).

import * as THREE from 'three';

const RPM_CROSSFADE_LOW = 2800;
const RPM_CROSSFADE_HIGH = 6200;
const RPM_PITCH_FACTOR = 0.16;
const MASTER_VOLUME = 0.42;

export class ElectricEngineAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.samples = {};
    this._initialized = false;
    this._isMuted = false;
    this._lastThrottle = 0;
    this._lastRpm = 0;
    this._lastAccentTime = 0;
  }

  async init(soundConfig) {
    if (this._initialized || typeof window === 'undefined') return;

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_VOLUME;
    this.masterGain.connect(this.ctx.destination);

    await Promise.all(
      Object.entries(soundConfig).map(([key, cfg]) => this._loadLayer(key, cfg)),
    );

    for (const key of Object.keys(this.samples)) {
      const sample = this.samples[key];
      if (sample.isOneShot) continue;
      const source = this.ctx.createBufferSource();
      source.buffer = sample.buffer;
      source.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.masterGain);
      source.start();
      sample.source = source;
      sample.gain = gain;
    }

    this._initialized = true;
  }

  async _loadLayer(key, cfg) {
    const res = await fetch(cfg.source);
    if (!res.ok) throw new Error(`[ElectricEngineAudio] failed to load ${cfg.source}`);
    const audioBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.samples[key] = {
      buffer: audioBuffer,
      bufferRpm: cfg.bufferRpm ?? 0,
      volume: cfg.volume ?? 1,
      pitch: cfg.pitch !== false,
      isOneShot: !!(cfg.oneShot || key === 'throttle_punch'),
      source: null,
      gain: null,
    };
  }

  resume() {
    if (this.ctx?.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setMasterVolume(v) {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(2, v));
    }
  }

  playOneShot(key, { volumeScale = 1, rpm = null } = {}) {
    const sample = this.samples[key];
    if (!sample?.buffer || !this.ctx || this._isMuted) return;
    try {
      const source = this.ctx.createBufferSource();
      source.buffer = sample.buffer;
      source.loop = false;
      if (rpm != null && sample.bufferRpm > 0) {
        source.detune.value = (rpm - sample.bufferRpm) * RPM_PITCH_FACTOR;
      }
      const gain = this.ctx.createGain();
      gain.gain.value = Math.max(0.0001, Math.min(2, (sample.volume ?? 1) * volumeScale));
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

  update(rpm, throttle, _gear = 1, dt = 0.016) {
    const r = Math.max(0, rpm || 0);
    const t = THREE.MathUtils.clamp(throttle ?? 0, 0, 1);

    if (this._lastThrottle === 0 && t < 0.5) {
      this._lastThrottle = t;
    }

    if (!this._initialized || !this.ctx || this._isMuted) {
      this._lastThrottle = t;
      this._lastRpm = r;
      return;
    }

    const speedFactor = THREE.MathUtils.clamp((r - 350) / 5200, 0, 1);
    const loadFactor = THREE.MathUtils.clamp(t * 0.92 + speedFactor * 0.35, 0, 1);
    const rpmX = THREE.MathUtils.clamp(
      (r - RPM_CROSSFADE_LOW) / (RPM_CROSSFADE_HIGH - RPM_CROSSFADE_LOW),
      0,
      1,
    );
    const motorLow = Math.cos(rpmX * 0.5 * Math.PI);
    const motorHigh = Math.cos((1 - rpmX) * 0.5 * Math.PI);
    const onGain = THREE.MathUtils.clamp(t / 0.85, 0, 1);
    const coastGain = THREE.MathUtils.clamp(1 - onGain * 0.65, 0.12, 1);

    const now = this.ctx.currentTime;
    const throttleRise = t - this._lastThrottle;
    const rpmFall = (this._lastRpm - r) / Math.max(dt, 0.001);
    const regen = THREE.MathUtils.clamp(
      (rpmFall > 700 ? (rpmFall - 700) / 4000 : 0) * (1 - t * 0.85),
      0,
      1,
    );

    if (throttleRise > 0.1 && (now - this._lastAccentTime) > 0.28 && this.samples.throttle_punch) {
      this._lastAccentTime = now;
      const punch = THREE.MathUtils.clamp(throttleRise, 0.1, 1);
      this.playOneShot('throttle_punch', { volumeScale: punch * (0.55 + 0.45 * onGain), rpm: r });
    }

    const setLoop = (key, gainVal, { pitchRpm = r } = {}) => {
      const sample = this.samples[key];
      if (!sample?.gain) return;
      const g = Math.max(0, gainVal * (sample.volume ?? 1));
      sample.gain.gain.setTargetAtTime(g, now, 0.04);
      if (sample.pitch && sample.source && sample.bufferRpm > 0) {
        sample.source.detune.setTargetAtTime(
          (pitchRpm - sample.bufferRpm) * RPM_PITCH_FACTOR,
          now,
          0.04,
        );
      }
    };

    setLoop('on_low', onGain * motorLow + coastGain * motorLow * 0.35);
    setLoop('on_high', onGain * motorHigh + coastGain * motorHigh * 0.28);

    const inverterLoad = THREE.MathUtils.clamp(loadFactor * 0.85 + (throttleRise > 0.08 ? 0.08 : 0), 0, 1);
    setLoop('inverter_low', inverterLoad * motorLow);
    setLoop('inverter_high', inverterLoad * motorHigh);

    setLoop('road_hiss', speedFactor * (0.22 + t * 0.55), { pitchRpm: 0 });
    setLoop('regen', regen * 0.9, { pitchRpm: 0 });

    this._lastThrottle = t;
    this._lastRpm = r;
  }

  mute(state = true) {
    this._isMuted = !!state;
    if (this.masterGain) {
      this.masterGain.gain.value = state ? 0 : MASTER_VOLUME;
    }
  }

  dispose() {
    if (!this.ctx) return;
    try {
      for (const key of Object.keys(this.samples)) {
        const sample = this.samples[key];
        if (sample.source) {
          try { sample.source.stop(); } catch {}
        }
      }
      this.ctx.close();
    } catch {}
    this.samples = {};
    this.ctx = null;
    this.masterGain = null;
    this._initialized = false;
  }
}
