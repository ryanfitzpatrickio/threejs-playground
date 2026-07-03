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
 * Two different ramp speeds, deliberately: the rain streaks fade in fast
 * (~0.6s, see createRainEffect.js) so weather changes read immediately, while
 * `rainWetness` ramps much slower (up over ~15s, down over ~45s) since
 * puddles/wet paint should visibly lag behind rain starting/stopping rather
 * than pop — real wetness takes time to build up and dry out.
 */

import * as THREE from 'three';
import { createRainEffect } from '../render/createRainEffect.js';
import { createLightningBolt } from '../render/createLightningBolt.js';
import { rainWetness, lightningFlash } from './weatherUniforms.js';

const WETNESS_RISE_TAU = 15; // seconds to approach full wetness while raining
const WETNESS_FALL_TAU = 45; // seconds to dry back out once rain stops
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
    else this.rainAudio?.mute(true);

    return normalized;
  }

  update(delta, focusPosition = null) {
    this.rainEffect?.update(delta);

    const raining = this.weather === 'rain';
    const target = raining ? 1 : 0;
    const tau = target > rainWetness.value ? WETNESS_RISE_TAU : WETNESS_FALL_TAU;
    const rate = Math.min(1, Math.max(0, delta) / tau);
    rainWetness.value += (target - rainWetness.value) * rate;
    if (Math.abs(rainWetness.value - target) < 0.002) rainWetness.value = target;

    this._updateLightning(delta, focusPosition, raining);
  }

  snapshot() {
    return { weather: this.weather };
  }

  _rainAudio() {
    this.rainAudio ??= new RainAmbienceAudio();
    return this.rainAudio;
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
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(0.1, this.ctx.currentTime, 0.6);
  }

  mute(state) {
    this.muted = Boolean(state);
    if (state && this.gain && this.ctx) this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
  }

  dispose() {
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.ctx?.close().catch(() => {});
    this.ctx = null;
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
