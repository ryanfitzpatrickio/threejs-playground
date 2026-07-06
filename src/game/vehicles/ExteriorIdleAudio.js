import * as THREE from 'three';

const DEFAULT_IDLE_URL = '/audio/vehicles/car-idle-exterior.mp3';

/** Looping exterior idle — volume driven by proximity (0..1). */
export class ExteriorIdleAudio {
  constructor(idleUrl = DEFAULT_IDLE_URL) {
    this.idleUrl = idleUrl || DEFAULT_IDLE_URL;
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.gain = null;
    this.loadPromise = null;
    this.lastProximity = 0;
    this.externalMuted = false;
  }

  _ensure() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this._load();
    return this.loadPromise;
  }

  async _load() {
    if (typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.ctx = new AudioContext();
    const response = await fetch(this.idleUrl);
    if (!response.ok) throw new Error(`Failed to load exterior idle: ${this.idleUrl}`);
    this.buffer = await this.ctx.decodeAudioData(await response.arrayBuffer());
  }

  setMuted(state) {
    this.externalMuted = Boolean(state);
    if (state) this.update(0);
  }

  mute(state) {
    this.setMuted(state);
  }

  update(proximity) {
    const amount = this.externalMuted ? 0 : THREE.MathUtils.clamp(proximity, 0, 1);
    const startThreshold = 0.08;
    const stopThreshold = 0.04;

    if (amount >= startThreshold && this.lastProximity < startThreshold) {
      this._ensure().then(() => {
        this.ctx?.resume().catch(() => {});
        this._startLoop();
      }).catch(() => {});
    }

    if (this.gain && this.ctx) {
      if (amount >= stopThreshold) {
        this.gain.gain.setTargetAtTime(
          amount * 0.55,
          this.ctx.currentTime,
          amount > this.lastProximity ? 0.35 : 0.5,
        );
      } else {
        this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.45);
      }
    } else if (amount >= startThreshold) {
      this._ensure().then(() => {
        this.ctx?.resume().catch(() => {});
        this._startLoop();
        this.update(amount);
      }).catch(() => {});
    }

    if (amount < stopThreshold && this.source) this._stop();
    this.lastProximity = amount;
  }

  _startLoop() {
    if (!this.ctx || !this.buffer || this.source) return;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.loop = true;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.gain).connect(this.ctx.destination);
    this.source.start(0);
  }

  _stop() {
    if (!this.source) return;
    try { this.source.stop(); } catch {}
    this.source.disconnect();
    this.gain?.disconnect();
    this.source = null;
    this.gain = null;
  }

  dispose() {
    this._stop();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.buffer = null;
    this.loadPromise = null;
  }
}
