import { rainWind } from '../systems/weatherUniforms.js';
import { syncTerrainViewDistance, syncTerrainAtmosphereFromSky } from '../systems/terrainAerialUniforms.js';
import { syncTerrainCloudShadow } from '../systems/terrainCloudShadowUniforms.js';
import { syncCloudReach } from '../render/cloud/cloudReachUniforms.js';
import { advanceTerrainParallaxWind, syncTerrainParallaxOffset } from '../systems/terrainParallaxUniforms.js';
import {
  getPhotorealismPresetId,
  mergePhotorealismEnvironment,
  setPhotorealismPresetId,
} from '../config/photorealismPresets.js';
import {
  applyShaderDebugSnapshot,
  clearAllUserOverrides,
  clearLutDirty,
} from '../debug/shaderDebugRegistry.js';
import { bindRuntimeHost } from './bindRuntimeHost.js';

/** Sky/weather/terrain environment sync. */
export class RuntimeEnvironment {
  constructor(host) {
    this._host = host;

    return bindRuntimeHost(this, host);
  }


  _applyPhotorealismRuntime() {
    // K9: photorealism look preset clears the entire shader override map.
    clearAllUserOverrides();
    const env = this.photorealismPresetId
      ? mergePhotorealismEnvironment(this.baseEnvironment, this.photorealismPresetId)
      : { ...this.baseEnvironment };
    this.qualityPreset.environment = env;
    this.sceneSystem.skySystem?.updateEnvironmentConfig?.(env);
    if (this.photorealismPresetId) {
      this.weatherSystem?.setWeather?.('clear');
      this.sceneSystem.setSceneFogEnabled?.(false);
    }
    this.rendererSystem.applyEnvironmentPreset(env);
    this.rendererSystem.installEnvironment(this.sceneSystem.scene, this.sceneSystem.skySystem);
  }

  _syncTerrainEnvironment(delta = 0) {
    const env = this.qualityPreset.environment ?? {};
    const viewDistance = this.levelSystem.level?.viewDistance
      ?? this.rendererSystem.viewDistance
      ?? this.cameraSystem?.camera?.far;
    if (this.rendererSystem.cloudSkyProvider) {
      syncCloudReach({
        viewDistance,
        fogMaxDistance: this.rendererSystem.fogMaxDistance,
        environmentPreset: env,
      });
    }
    if (!this.levelSystem.level?.terrainReach) return;
    syncTerrainAtmosphereFromSky(this.sceneSystem.skySystem, env);
    syncTerrainCloudShadow(this.rendererSystem.cloudSkyProvider?.cloudShadow ?? null);
    advanceTerrainParallaxWind(delta);
  }

}
