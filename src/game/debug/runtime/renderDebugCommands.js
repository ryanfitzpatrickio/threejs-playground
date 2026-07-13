import * as THREE from 'three';
import {
  getShaderDebugSnapshot,
  applyShaderDebugSnapshot,
  clearOverridesForFolders,
  clearAllUserOverrides,
  clearLutDirty,
} from '../shaderDebugRegistry.js';
import { setPhotorealismPresetId } from '../../config/photorealismPresets.js';
import {
  findChassisDebugVehicle,
  normalizeHorseBoneCommandOptions,
  normalizeSaddleCommandOptions,
  normalizeGripCommandOptions,
  vectorFromObject,
  riderTransformEuler,
  riderBoneDump,
} from '../../runtime/runtimeHelpers.js';
import { buildLimbSeverPlane } from '../../systems/soldierPartialCut.js';

/** Domain debug commands for __DREAMFALL_DEBUG__. @param {object} rt */
export function createRenderDebugCommands(rt) {
  return createCommands.call(rt);
}

function createCommands() {
  return {
    setLightMode: (mode = 'hemisphere') => {
      const normalizedMode = mode === 'clustered' ? 'clustered' : 'hemisphere';
      this.rendererSystem.setLightingMode(normalizedMode);
      this.sceneSystem.setLightingMode(normalizedMode);
      this.sceneSystem.updateStreetLights(this.characterSystem.character?.group.position);
      return this.snapshot();
    },
    toggleLightMode: () => {
      const currentMode = this.rendererSystem.snapshot()?.lightingMode ?? 'hemisphere';
      const nextMode = currentMode === 'clustered' ? 'hemisphere' : 'clustered';
      this.rendererSystem.setLightingMode(nextMode);
      this.sceneSystem.setLightingMode(nextMode);
      this.sceneSystem.updateStreetLights(this.characterSystem.character?.group.position);
      return this.snapshot();
    },
    getLightMode: () => this.rendererSystem.snapshot()?.lightingMode ?? 'hemisphere',
    setExposure: (exposure) => {
      this.rendererSystem.setExposure(exposure);
      return this.snapshot();
    },
    setWeather: (weather = 'clear') => {
      this.weatherSystem.setWeather(weather);
      return this.snapshot();
    },
    setPhotorealismPreset: (presetId = null) => {
      const normalized = presetId && presetId !== 'default' ? presetId : null;
      this.photorealismPresetId = setPhotorealismPresetId(normalized);
      this._applyPhotorealismRuntime();
      this.emitSnapshot();
      return this.snapshot();
    },
    setFog: (enabled) => {
      this.weatherSystem.setWeather(enabled ? 'fog' : 'clear');
      return this.snapshot();
    },
    setSceneFog: (enabled) => {
      const result = this.sceneSystem.setSceneFogEnabled(Boolean(enabled));
      // Toggling scene.fog recompiles the crowd's basic material and rebuilds
      // its instanced pipelines outside invalidatePipeline, so re-prime here.
      this.levelSystem.level?.spectatorCrowd?.markPipelinesDirty?.();
      this.hordeProxySystem?.markPipelinesDirty?.();
      return result;
    },
    setStreetLights: (enabled) => this.sceneSystem.setStreetLightsVisible(Boolean(enabled)),
    setHeadlights: (enabled) => this.vehicleSystem.setHeadlightsEnabled(Boolean(enabled)),
    dumpShaderParams: () => getShaderDebugSnapshot(),
    applyShaderParams: (obj, opts) => applyShaderDebugSnapshot(obj, opts),
    rebakeAtmosphereLut: () => {
      const provider = this.rendererSystem.cloudSkyProvider
        ?? this.sceneSystem.skySystem?.provider
        ?? null;
      const renderer = this.rendererSystem.renderer;
      if (!provider?.atmosphereLUT || !renderer) {
        return { ok: false, reason: 'no provider/renderer' };
      }
      try {
        provider.atmosphereLUT.markDirty();
        provider.prepareEnvironment(renderer);
        clearLutDirty();
        return { ok: true };
      } catch (err) {
        console.warn('[shader-debug] rebakeAtmosphereLut failed', err);
        return { ok: false, reason: err?.message ?? 'bake failed' };
      }
    },
    setCloudPreset: (name) => {
      clearOverridesForFolders(['Clouds Shape', 'Clouds Lighting', 'Clouds Wind']);
      this.sceneSystem.skySystem?.setCloudPreset?.(name);
      return this.snapshot();
    },
  };
}
