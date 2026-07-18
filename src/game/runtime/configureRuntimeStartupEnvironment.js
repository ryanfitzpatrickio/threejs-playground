import * as THREE from 'three';

/** Level-mode sky, weather, shadow, and environment policy applied at startup. */
export function configureRuntimeStartupEnvironment(host) {
  // Pipeline invalidation can capture stale animated crowd instance counts.
  host.rendererSystem.onPipelineInvalidated = () => {
    host.levelSystem.level?.spectatorCrowd?.markPipelinesDirty?.();
    host.hordeProxySystem?.markPipelinesDirty?.();
  };

  if (host.levelMode === 'rally' && !host.photorealismPresetId) {
    host.sceneSystem.skySystem?.setTimeOfDay?.(0.5);
    setEnvironmentWeather(host, 'rain', true);
  } else if (host.levelMode === 'range') {
    host.sceneSystem.skySystem?.setTimeOfDay?.(0.42);
    setEnvironmentWeather(host, 'clear', false);
    configureRangeShadows(host);
    host.rendererSystem.setGodRaysLight?.(host.sceneSystem.sun ?? null);
  } else if (host.levelMode === 'horde') {
    host.sceneSystem.skySystem?.setTimeOfDay?.(0.38);
    setEnvironmentWeather(host, 'clear', false);
    host.sceneSystem.configureRangeShadows?.({
      center: new THREE.Vector3(0, 2, 0),
      halfExtent: host.qualityPreset.shadowFrustumHalf ?? 28,
      far: host.qualityPreset.shadowFar ?? 64,
      sunDistance: 80,
      mapSize: host.qualityPreset.shadowMapSize ?? 1024,
    });
  } else if (host.levelMode === 'highway') {
    host.sceneSystem.skySystem?.setTimeOfDay?.(0.46);
    setEnvironmentWeather(host, 'clear', true);
  } else if (host.levelMode === 'sims') {
    host.sceneSystem.skySystem?.setTimeOfDay?.(0.44);
    setEnvironmentWeather(host, 'clear', false);
  } else if (host.levelMode === 'dog-park') {
    host.sceneSystem.skySystem?.setTimeOfDay?.(0.43);
    setEnvironmentWeather(host, 'clear', false);
    host.sceneSystem.configureRangeShadows?.({
      center: new THREE.Vector3(0, 1.5, 0),
      halfExtent: 42,
      far: 110,
      sunDistance: 75,
      mapSize: host.qualityPreset.shadowMapSize ?? 1536,
    });
  } else if (host.photorealismPresetId) {
    setEnvironmentWeather(host, 'clear', false);
  }

  host.rendererSystem.installEnvironment(host.sceneSystem.scene, host.sceneSystem.skySystem);
  if (host.levelMode === 'range' && host.sceneSystem.scene) {
    host.sceneSystem.scene.environmentIntensity = 0.95;
  }
  host.rendererSystem.cloudSkyProvider = host.sceneSystem.skySystem?.provider ?? null;
  host.weatherSystem.initialize({
    rendererSystem: host.rendererSystem,
    sceneSystem: host.sceneSystem,
    levelSystem: host.levelSystem,
    qualityPreset: host.qualityPreset,
  });

  if (
    host.photorealismPresetId
    || ['range', 'horde', 'highway', 'sims', 'dog-park'].includes(host.levelMode)
  ) {
    host.weatherSystem.setWeather('clear');
  } else if (host.levelMode === 'rally') {
    host.weatherSystem.setWeather('rain');
  }

  // setWeather resets environment intensity and may touch the sun.
  if (host.levelMode === 'range' && host.sceneSystem.scene) {
    host.sceneSystem.scene.environmentIntensity = 0.95;
    configureRangeShadows(host);
    host.rendererSystem.setGodRaysLight?.(host.sceneSystem.sun ?? null);
  }
}

function setEnvironmentWeather(host, weather, fogEnabled) {
  host.sceneSystem.skySystem?.setWeather?.(weather);
  host.sceneSystem.setWeather?.(weather);
  host.sceneSystem.setSceneFogEnabled?.(fogEnabled);
  host.rendererSystem.setWeather?.(weather);
}

function configureRangeShadows(host) {
  host.sceneSystem.configureRangeShadows?.({
    center: new THREE.Vector3(0, 1.5, 50),
    halfExtent: 72,
    far: 220,
    sunDistance: 100,
    mapSize: host.qualityPreset.shadowMapSize ?? 2048,
  });
}
