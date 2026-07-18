/**
 * Horde mall irradiance GI via LightProbeGrid (same stack as garage).
 *
 * Mall-first volume only (see docs/horde-gi-plan.md). Bake needs a live
 * WebGPURenderer — call after level attach + renderer.init(). Fail soft.
 *
 * Debug (console after play starts):
 *   __DREAMFALL_DEBUG__.getHordeGi()
 *   __DREAMFALL_DEBUG__.setHordeGiHelper(true)   // colored probe spheres
 *   __DREAMFALL_DEBUG__.setHordeGiIntensity(2)
 *   __DREAMFALL_DEBUG__.setHordeGiEnabled(false) // A/B vs hemi-only
 *   __DREAMFALL_DEBUG__.rebakeHordeGi()
 * URL: ?giHelper=1 shows probe spheres after bake.
 */

import * as THREE from 'three';
import { LightProbeGrid } from '../../three-addons/lighting/LightProbeGrid.js';
import { LightProbeGridHelper } from '../../three-addons/helpers/LightProbeGridHelper.js';

/** Default mall volume when level omits hordeGi.mall. */
export const DEFAULT_MALL_GI_VOLUME = {
  center: [-82, 3.6, 0],
  size: [70, 8, 70],
};

function wantGiHelperFromUrl() {
  try {
    if (typeof window === 'undefined') return false;
    const v = new URLSearchParams(window.location.search).get('giHelper');
    return v === '1' || v === 'true' || v === 'yes';
  } catch {
    return false;
  }
}

/**
 * Resolve quality → bake settings. Low/off disables.
 * @param {object} [qualityPreset]
 * @param {object} [levelGi]  level.hordeGi
 */
export function resolveHordeGiSettings(qualityPreset = {}, levelGi = null) {
  const env = qualityPreset.environment ?? {};
  const cfg = env.hordeGi ?? qualityPreset.hordeGi ?? {};

  // Explicit off
  if (cfg.enabled === false) {
    return { enabled: false, reason: 'quality-off' };
  }

  // Low quality: SSAO off and low DPR — skip GI unless forced on.
  const looksLow = qualityPreset.ssao?.enabled !== true
    && (qualityPreset.maxPixelRatio ?? 2) <= 1;
  if (cfg.enabled !== true && looksLow) {
    return { enabled: false, reason: 'low-quality' };
  }

  const probes = cfg.probes ?? { x: 8, y: 3, z: 8 };
  // Slightly assertive so mall bounce is readable vs hemi+sun (tune down later).
  const intensity = Number.isFinite(cfg.intensity) ? cfg.intensity : 0.95;
  const bake = {
    cubemapSize: cfg.cubemapSize ?? 8,
    near: cfg.near ?? 0.15,
    far: cfg.far ?? 48,
    bounces: cfg.bounces ?? 1,
    sampleCount: cfg.sampleCount ?? 128,
  };

  const mall = levelGi?.mall ?? DEFAULT_MALL_GI_VOLUME;

  return {
    enabled: true,
    mall,
    probes: {
      x: Math.max(2, Math.round(probes.x ?? 8)),
      y: Math.max(2, Math.round(probes.y ?? 3)),
      z: Math.max(2, Math.round(probes.z ?? 8)),
    },
    intensity,
    bake,
    // Instant enable after bake (avoids a per-frame hook on RuntimeFramePipeline).
    fadeInSeconds: Number.isFinite(cfg.fadeInSeconds) ? cfg.fadeInSeconds : 0,
  };
}

/**
 * @param {{
 *   scene: THREE.Scene,
 *   renderer: import('three/webgpu').WebGPURenderer,
 *   qualityPreset?: object,
 *   levelGi?: object|null,
 *   enabled?: boolean,
 * }} opts
 */
export function createHordeGiController(opts = {}) {
  const {
    scene,
    renderer,
    qualityPreset = {},
    levelGi = null,
  } = opts;

  const settings = resolveHordeGiSettings(qualityPreset, levelGi);
  /** @type {'idle'|'scheduled'|'baking'|'ready'|'failed'|'disabled'|'disposed'} */
  let status = settings.enabled ? 'idle' : 'disabled';
  let bakeMs = 0;
  let error = null;
  /** @type {LightProbeGrid|null} */
  let probes = null;
  /** @type {LightProbeGridHelper|null} */
  let helper = null;
  let helperVisible = wantGiHelperFromUrl();
  let contribEnabled = true;
  let targetIntensity = settings.intensity ?? 0.95;
  let fadeElapsed = 0;
  let fadeInSeconds = settings.fadeInSeconds ?? 0;
  let disposed = false;
  let bakeGen = 0;
  let scheduleHandle = 0;

  const probeCount = settings.enabled
    ? settings.probes.x * settings.probes.y * settings.probes.z
    : 0;

  if (!settings.enabled) {
    console.info('[HordeGi] disabled', resolveHordeGiSettings(qualityPreset, levelGi));
  }

  function snapshot() {
    return {
      enabled: settings.enabled && status !== 'disabled',
      contribEnabled,
      status,
      bakeMs: Number(bakeMs.toFixed(2)),
      probeCount,
      probes: settings.enabled ? { ...settings.probes } : null,
      intensity: probes?.intensity ?? 0,
      targetIntensity,
      helperVisible: Boolean(helper?.visible),
      error,
      volume: settings.mall ?? null,
      howToCheck: [
        '__DREAMFALL_DEBUG__.getHordeGi()',
        '__DREAMFALL_DEBUG__.setHordeGiHelper(true)',
        '__DREAMFALL_DEBUG__.setHordeGiEnabled(false) // A/B off',
        '__DREAMFALL_DEBUG__.setHordeGiIntensity(2) // boost',
      ],
    };
  }

  function disposeHelper() {
    if (!helper) return;
    helper.removeFromParent();
    helper.geometry?.dispose?.();
    helper.material?.dispose?.();
    helper = null;
  }

  function syncHelper() {
    disposeHelper();
    if (!helperVisible || !probes || status !== 'ready' || disposed) return;
    try {
      helper = new LightProbeGridHelper(probes, 0.55);
      helper.name = 'Horde Mall GI Helper';
      helper.renderOrder = 10;
      scene.add(helper);
      console.info('[HordeGi] probe helper on — colored spheres = baked irradiance samples');
    } catch (err) {
      console.warn('[HordeGi] helper failed', err);
      helper = null;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    bakeGen += 1;
    if (scheduleHandle && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(scheduleHandle);
    }
    scheduleHandle = 0;
    disposeHelper();
    if (probes) {
      probes.removeFromParent();
      probes.dispose?.();
      probes = null;
    }
    status = 'disposed';
  }

  /**
   * Schedule bake after the next paint so load/combat start is not blocked.
   */
  function scheduleBake() {
    if (disposed || !settings.enabled) return;
    if (status === 'baking' || status === 'ready' || status === 'scheduled') return;
    if (!scene || !renderer) {
      status = 'failed';
      error = 'missing scene/renderer';
      return;
    }
    status = 'scheduled';
    const gen = bakeGen;
    // Double-rAF: wait until after first interactive frames.
    const run = () => {
      if (disposed || gen !== bakeGen) return;
      scheduleHandle = requestAnimationFrame(() => {
        if (disposed || gen !== bakeGen) return;
        bakeNow();
      });
    };
    scheduleHandle = requestAnimationFrame(run);
  }

  function bakeNow() {
    if (disposed || !settings.enabled) return;
    if (!renderer?.isWebGPURenderer) {
      status = 'failed';
      error = 'WebGPURenderer required';
      return;
    }
    status = 'baking';
    error = null;
    const t0 = performance.now();
    try {
      const mall = settings.mall;
      const center = mall.center ?? DEFAULT_MALL_GI_VOLUME.center;
      const size = mall.size ?? DEFAULT_MALL_GI_VOLUME.size;
      const { probes: res } = settings;

      // Dispose previous if rebaking.
      if (probes) {
        probes.removeFromParent();
        probes.dispose?.();
        probes = null;
      }

      probes = new LightProbeGrid(
        size[0],
        size[1],
        size[2],
        res.x,
        res.y,
        res.z,
      );
      probes.name = 'Horde Mall GI';
      probes.position.set(center[0], center[1], center[2]);
      probes.intensity = 0;
      probes.visible = true;
      scene.add(probes);

      probes.bake(renderer, scene, { ...settings.bake });

      targetIntensity = settings.intensity;
      fadeElapsed = 0;
      probes.intensity = contribEnabled
        ? (fadeInSeconds <= 0 ? targetIntensity : 0)
        : 0;

      bakeMs = performance.now() - t0;
      status = 'ready';
      console.info(
        `[HordeGi] ready — ${probeCount} probes in ${bakeMs.toFixed(0)}ms, intensity=${probes.intensity}`,
        snapshot(),
      );
      if (helperVisible) syncHelper();
    } catch (err) {
      bakeMs = performance.now() - t0;
      status = 'failed';
      error = err?.message ?? String(err);
      console.warn('[HordeGi] bake failed; continuing without probes', err);
      if (probes) {
        probes.removeFromParent();
        probes.dispose?.();
        probes = null;
      }
    }
  }

  /**
   * Intensity fade-in after bake (call from frame loop when present).
   * @param {number} dt
   */
  function update(dt) {
    if (disposed || status !== 'ready' || !probes) return;
    if (probes.intensity >= targetIntensity - 1e-4) {
      probes.intensity = targetIntensity;
      return;
    }
    if (fadeInSeconds <= 0) {
      probes.intensity = targetIntensity;
      return;
    }
    fadeElapsed += Math.max(0, dt);
    const t = Math.min(1, fadeElapsed / fadeInSeconds);
    // Smoothstep
    const s = t * t * (3 - 2 * t);
    probes.intensity = targetIntensity * s;
  }

  function rebake() {
    if (disposed || !settings.enabled) return;
    bakeGen += 1;
    status = 'idle';
    scheduleBake();
  }

  /**
   * @param {boolean} on
   */
  function setHelperVisible(on) {
    helperVisible = Boolean(on);
    if (helperVisible) syncHelper();
    else disposeHelper();
    return snapshot();
  }

  /**
   * A/B: zero intensity without disposing the bake.
   * @param {boolean} on
   */
  function setContribEnabled(on) {
    contribEnabled = Boolean(on);
    if (probes && status === 'ready') {
      probes.intensity = contribEnabled ? targetIntensity : 0;
    }
    console.info(`[HordeGi] contribution ${contribEnabled ? 'ON' : 'OFF'} (intensity=${probes?.intensity ?? 0})`);
    return snapshot();
  }

  /**
   * @param {number} value
   */
  function setIntensity(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return snapshot();
    targetIntensity = Math.max(0, v);
    if (probes && status === 'ready' && contribEnabled) {
      probes.intensity = targetIntensity;
    }
    console.info(`[HordeGi] intensity=${targetIntensity}`);
    return snapshot();
  }

  return {
    settings,
    scheduleBake,
    bakeNow,
    update,
    rebake,
    dispose,
    getSnapshot: snapshot,
    setHelperVisible,
    setContribEnabled,
    setIntensity,
    get status() { return status; },
    get probes() { return probes; },
  };
}
