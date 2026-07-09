/**
 * WeatherSystem.js
 *
 * Single source of truth for the current weather state ('clear' | 'overcast' |
 * 'fog' | 'rain'), coordinating the three systems that each already own one
 * slice of "weather" (RendererSystem's fog pipeline, SceneSystem's scene fog
 * object, SkySystem's cloud coverage/density) plus the rain/lightning VFX and
 * audio and the surfaces that react to it (wet road/terrain/vehicle paint) —
 * so GameRuntime and the debug bridge call ONE method instead of duplicating
 * this orchestration in multiple places.
 *
 * 'clear' is the baseline and behaves exactly as it did before this system
 * existed (same renderer/scene/sky calls the old debugBridge.setWeather made).
 * 'rain' additionally shows the rain particle effect (createRainEffect.js),
 * schedules lightning strikes (createLightningBolt.js), starts a
 * procedurally-synthesized rain ambience (same filtered-white-noise
 * technique TireEffects.js's TireScreechAudio already uses — no audio asset
 * needed), and ramps the shared `rainWetness` uniform (weatherUniforms.js)
 * that terrain, road, and vehicle-paint materials all read directly — those
 * materials are a direct TSL port of github.com/achrefelouafi/RainSystemThreeJS's
 * wet-surface shader (see wetSurfaceNodes.js), including its own
 * "rain hitting standing water" answer: an animated ripple-ring pattern baked
 * into the puddle normal, gated by the puddle mask — not a separate splash
 * particle system (an earlier pass here built one; removed once the actual
 * reference technique was found, since the reference doesn't have one and
 * the two were redundant).
 *
 * Lightning is likewise a direct port of that repo's main.js orchestration
 * (Poisson-process strike scheduling, multi-flicker flash decay, scene
 * background/fog flash-lerp, a dedicated flash-only directional light) plus
 * createLightningBolt.js's procedural bolt geometry — see that file's header
 * and this file's `_updateLightning`/`_triggerStrike` for the exact mapping.
 * Strikes are gated to `weather === 'rain'` (this game's only storm state;
 * the reference exposes lightning as an independent GUI toggle, which this
 * project's weather model doesn't have an equivalent slot for). Thunder is
 * procedurally synthesized (no `/sounds/lightning.mp3` asset exists or is
 * appropriate to add) — same "no asset" idiom as the rain ambience below.
 *
 * Rain streaks fade in fast (~0.6s, see createRainEffect.js), while
 * `rainWetness` builds over ~15s. Selecting a non-rain weather clears pooled
 * surface water immediately so the debug weather state and road appearance do
 * not disagree; per-vehicle paint still has its own short drying transition.
 */

import * as THREE from 'three';
import { createRainEffect } from '../render/createRainEffect.js';
import { createLightningBolt } from '../render/createLightningBolt.js';
import { rainWetness, lightningFlash } from './weatherUniforms.js';
import { systemWrite } from '../debug/shaderDebugRegistry.js';

const WETNESS_RISE_TAU = 15; // seconds to approach full wetness while raining
const WETNESS_FALL_TAU = 8; // fallback decay if wetness is changed externally
const FLASH_DECAY_PER_SECOND = 6.0; // reference: `flash = max(0, flash - dt*6.0)`
const FLASH_COLOR = new THREE.Color(0xdfe8ff); // matches the reference's lightningLight color

export class WeatherSystem {
  constructor() {
    this.weather = 'clear';
    this.rendererSystem = null;
    this.sceneSystem = null;
    this.levelSystem = null;
    this.qualityPreset = {};
    this.rainEffect = null;
    this.rainAudio = null;
    this.cabinRainAudio = null;

    // Lightning — see file header. `lightning` mirrors the reference's exact
    // param defaults (frequency in strikes/min, intensity, thunder volume).
    this.lightning = { frequency: 8, intensity: 6.0, volume: 0.7 };
    this.lightningBolt = null;
    this.lightningLight = null;
    this.thunderAudio = null;
    this.nextStrikeIn = 0;
    this.pendingFlickers = [];
    this.flash = 0;
    this._baseBackground = null;
    this._baseFogColor = null;
  }

  initialize({ rendererSystem, sceneSystem, levelSystem = null, qualityPreset = {} }) {
    this.rendererSystem = rendererSystem;
    this.sceneSystem = sceneSystem;
    this.levelSystem = levelSystem;
    this.qualityPreset = qualityPreset;
    this.weather = rendererSystem?.weather ?? 'clear';
    this._scheduleNextStrike();
    return this;
  }

  setWeather(weather = 'clear') {
    const normalized = this.rendererSystem?.setWeather(weather) ?? 'clear';
    this.weather = normalized;
    this.sceneSystem?.setWeather(normalized);
    this.sceneSystem?.setSceneFogEnabled(normalized === 'fog' || normalized === 'rain');
    this.sceneSystem?.skySystem?.setWeather(normalized);
    this.rendererSystem?.installEnvironment(this.sceneSystem?.scene, this.sceneSystem?.skySystem);

    const raining = normalized === 'rain';
    if (raining && !this.rainEffect) {
      this.rainEffect = createRainEffect({ maxDrops: this.qualityPreset.rainMaxDrops ?? 12000 });
      this.sceneSystem?.scene?.add(this.rainEffect.group);
    }
    if (raining && !this.lightningBolt) {
      this.lightningBolt = createLightningBolt({ scene: this.sceneSystem?.scene });
    }
    if (raining && !this.lightningLight) {
      // Dedicated flash-only light, separate from createLightningBolt.js's own
      // local impact point-light — matches the reference's `lightningLight`.
      this.lightningLight = new THREE.DirectionalLight(0xdfe8ff, 0);
      this.lightningLight.position.set(-4, 16, 8);
      this.sceneSystem?.scene?.add(this.lightningLight);
    }
    this.rainEffect?.setIntensity(raining ? 1 : 0);

    if (raining) this._rainAudio().resume();
    else {
      systemWrite('weather.wetness', () => { rainWetness.value = 0; });
      this.rainAudio?.mute(true);
      this.cabinRainAudio?.update(0);
    }

    return normalized;
  }

  update(delta, focusPosition = null, { inVehicle = false } = {}) {
    this.rainEffect?.update(delta);

    const raining = this.weather === 'rain';
    const target = raining ? 1 : 0;
    const tau = target > rainWetness.value ? WETNESS_RISE_TAU : WETNESS_FALL_TAU;
    const rate = Math.min(1, Math.max(0, delta) / tau);
    // systemWrite: pin weather.wetness to freeze surface wet look while authoring.
    systemWrite('weather.wetness', () => {
      rainWetness.value += (target - rainWetness.value) * rate;
      if (Math.abs(rainWetness.value - target) < 0.002) rainWetness.value = target;
    });

    if (raining) {
      this._rainAudio().setExteriorMix(inVehicle ? 0.14 : 1);
      this._cabinRainAudio().update(inVehicle ? 1 : 0);
    } else {
      this._cabinRainAudio().update(0);
    }

    this._updateLightning(delta, focusPosition, raining);
  }

  snapshot() {
    return { weather: this.weather };
  }

  _rainAudio() {
    this.rainAudio ??= new RainAmbienceAudio();
    return this.rainAudio;
  }

  _cabinRainAudio() {
    this.cabinRainAudio ??= new CabinRainAudio();
    return this.cabinRainAudio;
  }

  _scheduleNextStrike() {
    // Poisson-process interval — verbatim port of the reference's
    // `scheduleNextStrike()`.
    const perSecond = Math.max(this.lightning.frequency, 0.001) / 60;
    this.nextStrikeIn = -Math.log(1 - Math.random()) / perSecond;
  }

  _updateLightning(delta, focusPosition, raining) {
    if (raining && focusPosition && this.levelSystem && this.lightningBolt) {
      this.nextStrikeIn -= delta;
      if (this.nextStrikeIn <= 0) {
        this._triggerStrike(focusPosition);
        this._scheduleNextStrike();
      }
    }

    // Consume pending flickers — verbatim port of the reference's loop.
    for (let i = this.pendingFlickers.length - 1; i >= 0; i--) {
      this.pendingFlickers[i].delay -= delta;
      if (this.pendingFlickers[i].delay <= 0) {
        this.flash = Math.max(this.flash, this.pendingFlickers[i].power);
        this.pendingFlickers.splice(i, 1);
      }
    }
    this.flash = Math.max(0, this.flash - delta * FLASH_DECAY_PER_SECOND);
    lightningFlash.value = this.flash;

    this.lightningBolt?.update(delta);
    if (this.lightningLight) this.lightningLight.intensity = this.flash * this.lightning.intensity;

    // Background/fog flash-lerp. The reference snapshots baseBackground/baseFog
    // ONCE since its scene never changes; this game's background/fog DO change
    // (day/night, lighting mode), so the base is re-snapshotted continuously
    // whenever the flash is idle, keeping it in sync with whatever the scene's
    // actual current look should be.
    const scene = this.sceneSystem?.scene;
    if (scene?.background?.isColor) {
      if (this.flash < 0.002) this._baseBackground = scene.background.clone();
      if (this._baseBackground) scene.background.copy(this._baseBackground).lerp(FLASH_COLOR, this.flash * 0.85);
    }
    if (scene?.fog?.color) {
      if (this.flash < 0.002) this._baseFogColor = scene.fog.color.clone();
      if (this._baseFogColor) scene.fog.color.copy(this._baseFogColor).lerp(FLASH_COLOR, this.flash * 0.6);
    }
  }

  _triggerStrike(focusPosition) {
    // Adaptation from the reference's fixed cloud-bounds + raycast: this is an
    // open streamed world with no single ground plane, so pick a random point
    // near the player and use the existing analytic ground query (same one
    // character/horse/vehicle spawn code already uses) for the impact height.
    const angle = Math.random() * Math.PI * 2;
    const dist = 15 + Math.random() * 55;
    const x = focusPosition.x + Math.cos(angle) * dist;
    const z = focusPosition.z + Math.sin(angle) * dist;
    const groundY = this.levelSystem.getGroundHeightAt(new THREE.Vector3(x, focusPosition.y, z), 0);
    const impact = new THREE.Vector3(x, Number.isFinite(groundY) ? groundY : focusPosition.y, z);
    const origin = new THREE.Vector3(
      x + (Math.random() - 0.5) * 20,
      focusPosition.y + 100 + Math.random() * 20,
      z + (Math.random() - 0.5) * 20,
    );

    this.lightningBolt.strike(origin, impact);

    // Multi-flicker flash — verbatim port of the reference's queueing.
    const flickers = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < flickers; i++) {
      this.pendingFlickers.push({
        delay: i * (0.04 + Math.random() * 0.07),
        power: i === 0 ? 1.0 : 0.4 + Math.random() * 0.5,
      });
    }

    this._thunder().strike(this.lightning.volume);
  }

  _thunder() {
    this.thunderAudio ??= new ThunderAudio();
    return this.thunderAudio;
  }

  dispose() {
    if (this.rainEffect) {
      this.sceneSystem?.scene?.remove(this.rainEffect.group);
      this.rainEffect.dispose();
      this.rainEffect = null;
    }
    if (this.lightningBolt) {
      this.lightningBolt.dispose();
      this.lightningBolt = null;
    }
    if (this.lightningLight) {
      this.sceneSystem?.scene?.remove(this.lightningLight);
      this.lightningLight = null;
    }
    this.rainAudio?.dispose();
    this.rainAudio = null;
    this.cabinRainAudio?.dispose();
    this.cabinRainAudio = null;
    this.thunderAudio?.dispose();
    this.thunderAudio = null;
  }
}

// Procedural rain "hiss" — filtered white noise, same synthesis technique as
// TireEffects.js's TireScreechAudio (no audio asset needed). Lowpass (not
// bandpass) so it reads as a steady wash rather than a screech.
class RainAmbienceAudio {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.filter = null;
    this.muted = true;
    this.exteriorMix = 1;
    this.baseVolume = 0.1;
  }

  _ensure() {
    if (this.ctx || typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.ctx = new AudioContext();
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2600;
    this.filter.Q.value = 0.5;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.filter).connect(this.gain).connect(this.ctx.destination);
    this.source.start();
  }

  resume() {
    this._ensure();
    this.muted = false;
    this.ctx?.resume().catch(() => {});
    this._applyVolume(0.6);
  }

  setExteriorMix(mix) {
    this.exteriorMix = THREE.MathUtils.clamp(mix, 0, 1);
    if (!this.muted) this._applyVolume(0.4);
  }

  _applyVolume(timeConstant) {
    if (!this.gain || !this.ctx) return;
    const target = this.muted ? 0 : this.baseVolume * this.exteriorMix;
    this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, timeConstant);
  }

  mute(state) {
    this.muted = Boolean(state);
    this._applyVolume(0.6);
  }

  dispose() {
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

const CABIN_RAIN_URLS = [
  '/audio/weather/rain-cabin-01.mp3',
  '/audio/weather/rain-cabin-02.mp3',
];

// Recorded gentle rain on glass/metal — interior cabin patter while driving in rain.
class CabinRainAudio {
  constructor() {
    this.ctx = null;
    this.output = null;
    this.buffers = [];
    this.source = null;
    this.gain = null;
    this.lastIndex = -1;
    this.lastIntensity = 0;
    this.loadPromise = null;
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
    this.output = this.ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(this.ctx.destination);
    this.buffers = await Promise.all(CABIN_RAIN_URLS.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load cabin rain audio: ${url}`);
      return this.ctx.decodeAudioData(await response.arrayBuffer());
    }));
  }

  update(intensity) {
    const amount = THREE.MathUtils.clamp(intensity, 0, 1);
    const startThreshold = 0.5;
    const stopThreshold = 0.2;

    if (amount >= startThreshold && this.lastIntensity < startThreshold) {
      this._ensure().then(() => {
        this.ctx?.resume().catch(() => {});
        this._startRandomLoop();
      }).catch(() => {});
    }

    if (this.gain && this.ctx) {
      if (amount >= stopThreshold) {
        this.gain.gain.setTargetAtTime(
          amount * 0.42,
          this.ctx.currentTime,
          amount > this.lastIntensity ? 0.5 : 0.7,
        );
      } else {
        this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
      }
    }

    if (amount < 0.05 && this.source) this._stop();
    this.lastIntensity = amount;
  }

  _startRandomLoop() {
    if (!this.ctx || !this.buffers.length) return;
    this._stop();
    let index = Math.floor(Math.random() * this.buffers.length);
    if (this.buffers.length > 1 && index === this.lastIndex) {
      index = (index + 1) % this.buffers.length;
    }
    this.lastIndex = index;
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffers[index];
    this.source.loop = true;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.gain).connect(this.output);
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
    this.output = null;
    this.buffers = [];
    this.loadPromise = null;
  }
}

// Procedural thunder — no `/sounds/lightning.mp3` asset exists or is
// appropriate to add (the reference plays a real audio file per strike), so
// this substitutes a synthesized burst: filtered white noise through a
// lowpass filter, swept downward for a "rumble" tail, with a fast-attack/
// slow-decay gain envelope. Same "no asset" idiom as RainAmbienceAudio above
// and TireEffects.js's TireScreechAudio.
class ThunderAudio {
  constructor() {
    this.ctx = null;
    this.buffer = null;
  }

  _ensure() {
    if (this.ctx || typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.ctx = new AudioContext();
    const duration = 2.2;
    this.buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * duration, this.ctx.sampleRate);
    const data = this.buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }

  strike(volume = 0.7) {
    this._ensure();
    if (!this.ctx || !this.buffer) return;
    this.ctx.resume().catch(() => {});

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const now = this.ctx.currentTime;
    // Sweeps from a sharp crack down to a low rumble.
    filter.frequency.setValueAtTime(3200, now);
    filter.frequency.exponentialRampToValueAtTime(120, now + 1.8);

    const gain = this.ctx.createGain();
    const peak = THREE.MathUtils.clamp(volume, 0, 1) * 0.9;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.02); // fast attack (the crack)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 2.0); // slow decay (the rumble)

    source.connect(filter).connect(gain).connect(this.ctx.destination);
    source.start(now);
    source.stop(now + 2.2);
  }

  dispose() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
