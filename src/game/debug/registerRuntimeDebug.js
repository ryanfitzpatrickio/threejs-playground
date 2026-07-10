/**
 * Discrete runtime debug controls migrated from the old Solid DebugPanel.
 * Wired through __DREAMFALL_DEBUG__ / GameRuntime — not TSL uniforms.
 */

import {
  registerShaderDebugFolder,
  registerShaderDebugParam,
} from './shaderDebugRegistry.js';
import {
  listCloudTypePresets,
  DEFAULT_CLOUD_TYPE,
  resolveCloudMode,
  CLOUD_MODES,
} from '../render/cloud/cloudConfig.js';
import { listPhotorealismPresets } from '../config/photorealismPresets.js';
import { getQualityPreset, getQualityLevel } from '../config/qualityPresets.js';
import { GAME_CONFIG } from '../config/gameConfig.js';

/** Local overlay state (not always in snapshot). */
const overlayState = {
  collision: false,
  blade: false,
  worldZones: false,
};

function bridge() {
  return globalThis.__DREAMFALL_DEBUG__ ?? null;
}

function snap(runtime) {
  try {
    return runtime?.snapshot?.({ full: false }) ?? bridge()?.snapshot?.() ?? null;
  } catch {
    return null;
  }
}

function readCloudMode() {
  try {
    const value = localStorage.getItem('dreamfall:clouds');
    if (value === 'volumetric' || value === 'dome' || value === 'off') return value;
  } catch {
    /* ignore */
  }
  return resolveCloudMode(getQualityPreset(getQualityLevel()));
}

function setCloudModeAndReload(mode) {
  if (!CLOUD_MODES.includes(mode)) return;
  try {
    localStorage.setItem('dreamfall:clouds', mode);
  } catch {
    /* ignore */
  }
  location.reload();
}

function readSpectatorCrowd() {
  try {
    return localStorage.getItem('dreamfall:spectator-crowd') === 'true';
  } catch {
    return false;
  }
}

function setSpectatorCrowdAndReload(on) {
  try {
    localStorage.setItem('dreamfall:spectator-crowd', on ? 'true' : 'false');
  } catch {
    /* ignore */
  }
  location.reload();
}

/**
 * @param {object} [runtime] GameRuntime
 */
export function registerRuntimeDebug(runtime = null) {
  registerShaderDebugFolder('Runtime', { expanded: true });
  registerShaderDebugFolder('Third Person', { expanded: true });
  registerShaderDebugFolder('Look', { expanded: false });
  registerShaderDebugFolder('Weather Control', { expanded: true });
  registerShaderDebugFolder('Cloud Mode', { expanded: false });
  registerShaderDebugFolder('Rally', { expanded: false });
  registerShaderDebugFolder('Overlays', { expanded: false });

  // --- Runtime lighting / fog / shadows ---
  registerShaderDebugParam({
    id: 'runtime.clusteredLighting',
    label: 'Clustered lighting',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.renderer?.lightingMode === 'clustered',
    set: (v) => {
      bridge()?.setLightMode?.(v ? 'clustered' : 'hemisphere');
    },
  });

  registerShaderDebugParam({
    id: 'runtime.heightFog',
    label: 'Height fog (volumetric)',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.renderer?.fogEnabled),
    set: (v) => {
      bridge()?.setFog?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.distanceFog',
    label: 'Distance fog (scene)',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.scene?.sceneFogEnabled ?? true,
    set: (v) => {
      bridge()?.setSceneFog?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.shadows',
    label: 'Shadows',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.renderer?.shadows),
    set: (v) => {
      bridge()?.setShadows?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.streetLights',
    label: 'Street lights',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.scene?.streetLightsVisible),
    set: (v) => {
      bridge()?.setStreetLights?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.sun',
    label: 'Sun (directional)',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.scene?.sunUserEnabled ?? true,
    set: (v) => {
      bridge()?.setSun?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.hemisphere',
    label: 'Hemisphere light',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => snap(runtime)?.scene?.hemisphereVisible ?? true,
    set: (v) => {
      bridge()?.setHemisphere?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.headlights',
    label: 'Xenon headlights',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.vehicles?.headlightsEnabled),
    set: (v) => {
      bridge()?.setHeadlights?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.renderCap60',
    label: 'Cap render to 60 fps',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.timing?.renderCap60),
    set: (v) => {
      bridge()?.setRenderCap60?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.timingHud',
    label: 'Timing HUD',
    folder: 'Runtime',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => Boolean(snap(runtime)?.timing?.showHud),
    set: (v) => {
      bridge()?.setTimingHud?.(Boolean(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.sampleAllocation',
    label: 'Sample allocation (3s → console)',
    folder: 'Runtime',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      const b = bridge();
      if (!b?.startAllocationSample) return;
      b.startAllocationSample(3000);
      globalThis.setTimeout(() => {
        console.info('[dreamfall] allocation sample', b.allocationSampleReport?.());
      }, 3200);
    },
  });

  // --- Third person (on-foot mesh + capsule vertical offsets) ---
  registerShaderDebugParam({
    id: 'runtime.playerMeshOffset',
    label: 'Mesh offset height',
    folder: 'Third Person',
    type: 'float',
    min: -0.5,
    max: 0.5,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Visual model Y vs physics feet. Negative lowers the mesh (stops floating feet). Applies every frame.',
    get: () => {
      const n = Number(GAME_CONFIG.character.playerGroundOffset);
      return Number.isFinite(n) ? n : 0;
    },
    set: (v) => {
      const n = Number(v);
      GAME_CONFIG.character.playerGroundOffset = Number.isFinite(n) ? n : 0;
      applyPlayerMeshOffsetNow();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.playerColliderOffset',
    label: 'Collider offset height',
    folder: 'Third Person',
    type: 'float',
    min: -0.5,
    max: 0.5,
    step: 0.005,
    pinPolicy: 'allow',
    help: 'Physics capsule Y vs mesh feet. Positive raises the capsule (feet sink); negative lowers it. Turn on Collision overlays to see the capsule.',
    get: () => {
      const n = Number(GAME_CONFIG.character.playerColliderOffset);
      return Number.isFinite(n) ? n : 0;
    },
    set: (v) => {
      const n = Number(v);
      GAME_CONFIG.character.playerColliderOffset = Number.isFinite(n) ? n : 0;
      applyPlayerColliderOffsetNow();
    },
  });

  // --- Look preset ---
  const lookOptions = {
    'Quality default': '',
    ...Object.fromEntries(listPhotorealismPresets().map((p) => [p.label, p.id])),
  };
  registerShaderDebugParam({
    id: 'runtime.photorealismPreset',
    label: 'Look preset',
    folder: 'Look',
    type: 'enum',
    options: lookOptions,
    pinPolicy: 'allow',
    get: () => snap(runtime)?.photorealismPreset ?? '',
    set: (v) => {
      bridge()?.setPhotorealismPreset?.(v || null);
    },
  });

  // --- Weather ---
  registerShaderDebugParam({
    id: 'runtime.weather',
    label: 'Weather',
    folder: 'Weather Control',
    type: 'enum',
    options: {
      Clear: 'clear',
      Overcast: 'overcast',
      Fog: 'fog',
      Rain: 'rain',
    },
    pinPolicy: 'allow',
    get: () => snap(runtime)?.renderer?.weather ?? 'clear',
    set: (v) => {
      bridge()?.setWeather?.(v);
    },
  });

  // --- Cloud mode (reload) + type + TOD ---
  registerShaderDebugParam({
    id: 'runtime.cloudMode',
    label: 'Cloud mode (reload)',
    folder: 'Cloud Mode',
    type: 'enum',
    options: {
      Volumetric: 'volumetric',
      Dome: 'dome',
      Off: 'off',
    },
    pinPolicy: 'allow',
    help: 'Writes localStorage and reloads the page.',
    get: () => readCloudMode(),
    set: (v) => {
      setCloudModeAndReload(v);
    },
  });

  const cloudTypeOptions = Object.fromEntries(
    listCloudTypePresets().map((p) => [p.label, p.id]),
  );
  registerShaderDebugParam({
    id: 'runtime.cloudType',
    label: 'Cloud type',
    folder: 'Cloud Mode',
    type: 'enum',
    options: cloudTypeOptions,
    pinPolicy: 'allow',
    help: 'Volumetric only. Clears shape/lighting/wind pins then applies preset.',
    get: () => {
      const rt = runtime ?? globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__;
      return rt?.sceneSystem?.skySystem?.provider?.cloudType
        ?? snap(runtime)?.scene?.sky?.cloudType
        ?? DEFAULT_CLOUD_TYPE;
    },
    set: (v) => {
      bridge()?.setCloudPreset?.(v);
    },
  });

  registerShaderDebugParam({
    id: 'runtime.timeOfDay',
    label: 'Time of day',
    folder: 'Cloud Mode',
    type: 'float',
    min: 0,
    max: 1,
    step: 0.001,
    pinPolicy: 'allow',
    help: '0–1 day cycle (disables dynamic day while scrubbing).',
    get: () => snap(runtime)?.scene?.sky?.timeOfDay ?? 0.72,
    set: (v) => {
      bridge()?.setTimeOfDay?.(Number(v));
    },
  });

  registerShaderDebugParam({
    id: 'runtime.timeOfDayClock',
    label: 'Clock',
    folder: 'Cloud Mode',
    type: 'monitor',
    pinPolicy: 'monitor',
    get: () => formatTimeOfDay(snap(runtime)?.scene?.sky?.timeOfDay ?? 0.72),
  });

  // --- Rally ---
  registerShaderDebugParam({
    id: 'runtime.rallyCinematic',
    label: 'Toggle rally cinematic demo',
    folder: 'Rally',
    type: 'action',
    pinPolicy: 'allow',
    get: () => null,
    action: () => {
      bridge()?.toggleRallyCinematicDemo?.();
    },
  });

  registerShaderDebugParam({
    id: 'runtime.rallyCinematicState',
    label: 'Rally cinematic',
    folder: 'Rally',
    type: 'monitor',
    pinPolicy: 'monitor',
    get: () => (snap(runtime)?.rallyCinematic?.active ? 'active' : 'idle'),
  });

  registerShaderDebugParam({
    id: 'runtime.spectatorCrowd',
    label: 'Spectator crowd GLB (reload)',
    folder: 'Rally',
    type: 'bool',
    pinPolicy: 'allow',
    help: 'Writes localStorage and reloads.',
    get: () => readSpectatorCrowd(),
    set: (v) => {
      setSpectatorCrowdAndReload(Boolean(v));
    },
  });

  // --- Overlays ---
  registerShaderDebugParam({
    id: 'runtime.collisionDebug',
    label: 'Collision overlays',
    folder: 'Overlays',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => overlayState.collision,
    set: (v) => {
      overlayState.collision = Boolean(v);
      bridge()?.setCollisionDebugVisible?.(overlayState.collision);
    },
  });

  registerShaderDebugParam({
    id: 'runtime.bladeDebug',
    label: 'Blade trace',
    folder: 'Overlays',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => overlayState.blade,
    set: (v) => {
      overlayState.blade = Boolean(v);
      bridge()?.setBladeDebug?.(overlayState.blade);
    },
  });

  registerShaderDebugParam({
    id: 'runtime.worldZones',
    label: 'World zone overlay',
    folder: 'Overlays',
    type: 'bool',
    pinPolicy: 'allow',
    get: () => overlayState.worldZones,
    set: (v) => {
      overlayState.worldZones = Boolean(v);
      bridge()?.setWorldZoneOverlay?.(overlayState.worldZones);
    },
  });
}

function formatTimeOfDay(timeOfDay) {
  const wrapped = ((Number(timeOfDay) % 1) + 1) % 1;
  const totalMinutes = Math.round(wrapped * 24 * 60) % (24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function gameRuntime() {
  return globalThis.__DREAMFALL_SHADER_DEBUG_RUNTIME__ ?? null;
}

/** Push mesh Y immediately so the slider is visible without waiting a frame. */
function applyPlayerMeshOffsetNow() {
  const controller = gameRuntime()?.characterSystem?.character?.animationController;
  controller?.applyModelVisualOffset?.();
}

/** Reposition the kinematic capsule immediately when collider offset changes. */
function applyPlayerColliderOffsetNow() {
  const rt = gameRuntime();
  const character = rt?.characterSystem?.character;
  if (!character || !rt?.physicsSystem?.syncCharacterBody) {
    return;
  }
  rt.physicsSystem.syncCharacterBody(character);
}
